/**
 * Global Vote Outcome Analytics
 * ================================
 * Populates vb_global_vote_outcomes from audit_events + vb_vote_outcomes.
 * The Steem blockchain is the source of truth — this table is a cache
 * designed for timing analytics queries.
 *
 * Key question this data will answer:
 *   "At what delay (minutes after post creation) do VoteBroker votes
 *    achieve the highest curation rewards?"
 */

import { createSteemClient } from "./steemBroadcaster.js";
import { getDb } from "../db/index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GlobalVoteOutcomeSummary {
  username:       string;
  totalVotes:     number;
  withOutcome:    number;   // have realized_curation_sp
  withDelay:      number;   // have vote_delay_minutes
  avgDelaySelf:   number | null;
  avgDelayOthers: number | null;
  avgCurationSp:  number | null;
  bestDelayBucket: string | null;   // e.g. "5-30 min" or "30-60 min"
  rebuiltAt:      string;
}

// ── Real-time capture at vote broadcast ──────────────────────────────────────
//
// Called fire-and-forget immediately after a successful vote broadcast.
// Captures everything knowable at vote time: VP, post state, competition.
// This is the primary source of training data for the future vote copilot.

export async function recordVoteAtBroadcast(params: {
  voter:         string;
  author:        string;
  permlink:      string;
  weightBps:     number;
  transactionId: string | null;
  strategyCategory?: string | null;
}): Promise<void> {
  const db     = getDb();
  const client = createSteemClient();
  const votedAt = new Date().toISOString();

  // Fetch post state + voter account in parallel
  const [post, accounts] = await Promise.all([
    client.database.call("get_content", [params.author, params.permlink]) as Promise<{
      created?: string;
      pending_payout_value?: string;
      active_votes?: unknown[];
      net_votes?: number;
      author?: string;
    }>,
    client.database.getAccounts([params.voter, params.author]) as Promise<Array<{
      name: string;
      reputation?: number | string;
      voting_manabar?: { current_mana: string | number; last_update_time: number };
      vesting_shares?: string;
      delegated_vesting_shares?: string;
      received_vesting_shares?: string;
      vote_count?: number;
    }>>,
  ]);

  const voterAccount  = accounts.find(a => a.name === params.voter);
  const authorAccount = accounts.find(a => a.name === params.author);

  // ── VP at vote time ──────────────────────────────────────────────────────────
  let vpAtVoteBps: number | null = null;
  if (voterAccount?.voting_manabar) {
    const manabar     = voterAccount.voting_manabar;
    const vestShares  = parseFloat(String(voterAccount.vesting_shares ?? "0").split(" ")[0]);
    const delegated   = parseFloat(String(voterAccount.delegated_vesting_shares ?? "0").split(" ")[0]);
    const received    = parseFloat(String(voterAccount.received_vesting_shares ?? "0").split(" ")[0]);
    const effectiveV  = (vestShares - delegated + received) * 1_000_000;
    const storedMana  = Number(manabar.current_mana);
    const lastUpdate  = manabar.last_update_time;
    const nowSec      = Math.floor(Date.now() / 1000);
    const regenMana   = ((nowSec - lastUpdate) / (5 * 86400)) * effectiveV;
    const currentMana = Math.min(effectiveV, storedMana + regenMana);
    vpAtVoteBps       = effectiveV > 0 ? Math.round((currentMana / effectiveV) * 10_000) : null;
  }

  // ── Post timing ─────────────────────────────────────────────────────────────
  let postCreatedAt: string | null = null;
  let voteDelayMinutes: number | null = null;
  if (post?.author && post.created) {
    postCreatedAt = post.created;
    const postMs  = new Date(post.created + "Z").getTime();
    const voteMs  = new Date(votedAt).getTime();
    voteDelayMinutes = !isNaN(postMs) ? Math.round((voteMs - postMs) / 60_000 * 10) / 10 : null;
  }

  // ── Post competition snapshot ────────────────────────────────────────────────
  const pendingPayoutSbd    = post?.pending_payout_value
    ? parseFloat(String(post.pending_payout_value).split(" ")[0]) : null;
  const activeVotesCount    = Array.isArray(post?.active_votes) ? post.active_votes.length : null;
  const netVotes            = typeof post?.net_votes === "number" ? post.net_votes : null;
  const authorReputation    = authorAccount?.reputation !== undefined
    ? Number(authorAccount.reputation) : null;

  // ── Estimated vote value (SBD) ───────────────────────────────────────────────
  // Approximation: we don't have reward fund data here, store null for now.
  // The rebuild job fills estimated_vote_value_sbd from the snapshot.
  const estimatedVoteValueSbd: number | null = null;

  // ── Upsert ───────────────────────────────────────────────────────────────────
  db.prepare(`
    INSERT INTO vb_global_vote_outcomes
      (voter, author, permlink, post_created_at, voted_at, vote_delay_minutes,
       weight_bps, vp_at_vote_bps, estimated_vote_value_sbd,
       strategy_category, is_self_post, source_vote_trx_id,
       post_pending_payout_sbd, post_active_votes_count,
       post_net_votes, post_author_reputation)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(voter, author, permlink) DO UPDATE SET
      vp_at_vote_bps           = COALESCE(excluded.vp_at_vote_bps, vp_at_vote_bps),
      post_created_at          = COALESCE(excluded.post_created_at, post_created_at),
      vote_delay_minutes       = COALESCE(excluded.vote_delay_minutes, vote_delay_minutes),
      post_pending_payout_sbd  = COALESCE(excluded.post_pending_payout_sbd, post_pending_payout_sbd),
      post_active_votes_count  = COALESCE(excluded.post_active_votes_count, post_active_votes_count),
      post_net_votes           = COALESCE(excluded.post_net_votes, post_net_votes),
      post_author_reputation   = COALESCE(excluded.post_author_reputation, post_author_reputation),
      recorded_at              = datetime('now')
  `).run(
    params.voter, params.author, params.permlink,
    postCreatedAt, votedAt, voteDelayMinutes,
    params.weightBps, vpAtVoteBps, estimatedVoteValueSbd,
    params.strategyCategory ?? null,
    params.voter === params.author ? 1 : 0,
    params.transactionId ?? null,
    pendingPayoutSbd, activeVotesCount, netVotes, authorReputation,
  );
}

// ── Populate from existing data ───────────────────────────────────────────────

export async function populateGlobalVoteOutcomes(
  username: string,
  log: typeof console = console,
): Promise<{ inserted: number; updated: number; skipped: number }> {
  const db     = getDb();
  const client = createSteemClient();
  let inserted = 0, updated = 0, skipped = 0;

  // 1. Load existing vote rows from audit_events (VoteBroker broadcasts)
  const voteRows = db.prepare(`
    SELECT author, permlink, weight_bps, transaction_id, created_at
    FROM audit_events
    WHERE username = ? AND type = 'vote_broadcast_success' AND author IS NOT NULL
  `).all(username) as Array<{
    author: string; permlink: string; weight_bps: number;
    transaction_id: string | null; created_at: string;
  }>;

  log.info(`[GlobalOutcomes] ${voteRows.length} vote_broadcast_success events for @${username}`);

  // 2. Load realized rewards from vb_vote_outcomes (matched curation_reward ops)
  const rewardRows = db.prepare(`
    SELECT author, permlink, realized_sp, realized_at, reward_trx_id
    FROM vb_vote_outcomes
    WHERE username = ?
  `).all(username) as Array<{
    author: string; permlink: string;
    realized_sp: number | null; realized_at: string | null; reward_trx_id: string | null;
  }>;
  const rewardMap = new Map(rewardRows.map(r => [`${r.author}/${r.permlink}`, r]));

  // 3. Load strategy category from strategy_rules
  const rulesJson = (db.prepare("SELECT rules_json FROM strategy_rules WHERE username = ?")
    .get(username) as { rules_json: string } | undefined)?.rules_json;
  const categoryMap = new Map<string, string>();
  if (rulesJson) {
    for (const r of JSON.parse(rulesJson) as Array<{ username: string; category: string }>) {
      categoryMap.set(r.username, r.category);
    }
  }

  // 4. VESTS → SP ratio (needed for future SP estimates)
  const globalProps = await client.database.getDynamicGlobalProperties();
  const totalFund   = parseFloat(String(globalProps.total_vesting_fund_steem).split(" ")[0]);
  const totalVests  = parseFloat(String(globalProps.total_vesting_shares).split(" ")[0]);

  // 5. Upsert each vote into vb_global_vote_outcomes
  // better-sqlite3 transactions are synchronous — run upserts individually
  // so that the async get_content calls can be awaited between each write.
  const upsert = db.prepare(`
    INSERT INTO vb_global_vote_outcomes
      (voter, author, permlink, post_created_at, voted_at, vote_delay_minutes,
       weight_bps, strategy_category, is_self_post,
       realized_curation_sp, realized_at, post_final_payout_sbd,
       source_vote_trx_id, source_reward_trx_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(voter, author, permlink) DO UPDATE SET
      post_created_at      = COALESCE(excluded.post_created_at, post_created_at),
      vote_delay_minutes   = COALESCE(excluded.vote_delay_minutes, vote_delay_minutes),
      realized_curation_sp = COALESCE(excluded.realized_curation_sp, realized_curation_sp),
      realized_at          = COALESCE(excluded.realized_at, realized_at),
      post_final_payout_sbd = COALESCE(excluded.post_final_payout_sbd, post_final_payout_sbd),
      source_reward_trx_id = COALESCE(excluded.source_reward_trx_id, source_reward_trx_id),
      recorded_at          = datetime('now')
  `);

  for (const vote of voteRows) {
    const key      = `${vote.author}/${vote.permlink}`;
    const reward   = rewardMap.get(key);
    const category = categoryMap.get(vote.author) ?? null;
    const isSelf   = vote.author === username ? 1 : 0;

    let postCreatedAt: string | null    = null;
    let delayMinutes: number | null     = null;
    let finalPayoutSbd: number | null   = null;
    try {
      const post = await client.database.call("get_content", [vote.author, vote.permlink]) as {
        created?: string; author?: string;
        total_payout_value?: string;
        curator_payout_value?: string;
      };
      if (post?.author && post.created) {
        postCreatedAt = post.created;
        const postMs  = new Date(post.created + "Z").getTime();
        const voteMs  = new Date(vote.created_at.endsWith("Z") ? vote.created_at : vote.created_at + "Z").getTime();
        delayMinutes  = isNaN(postMs) || isNaN(voteMs) ? null : Math.round((voteMs - postMs) / 60_000 * 10) / 10;
      }
      // Final payout = author payout + curator payout (only meaningful after post paid out)
      if (reward?.realized_at && post?.total_payout_value && post?.curator_payout_value) {
        const authorPayout   = parseFloat(String(post.total_payout_value).split(" ")[0]) || 0;
        const curatorPayout  = parseFloat(String(post.curator_payout_value).split(" ")[0]) || 0;
        const total = authorPayout + curatorPayout;
        if (total > 0) finalPayoutSbd = Math.round(total * 1000) / 1000;
      }
    } catch { /* best effort */ }

    const existing = db.prepare(
      "SELECT voter FROM vb_global_vote_outcomes WHERE voter=? AND author=? AND permlink=?"
    ).get(username, vote.author, vote.permlink);

    upsert.run(
      username, vote.author, vote.permlink,
      postCreatedAt,
      vote.created_at.endsWith("Z") ? vote.created_at : vote.created_at + "Z",
      delayMinutes,
      vote.weight_bps, category, isSelf,
      reward?.realized_sp ?? null,
      reward?.realized_at ?? null,
      finalPayoutSbd,
      vote.transaction_id ?? null,
      reward?.reward_trx_id ?? null,
    );

    if (existing) updated++; else inserted++;
  }

  log.info(`[GlobalOutcomes] inserted:${inserted} updated:${updated} skipped:${skipped}`);
  return { inserted, updated, skipped };
}

// ── Summary query ─────────────────────────────────────────────────────────────

export function getVoteOutcomeSummary(username: string): GlobalVoteOutcomeSummary {
  const db = getDb();

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total,
      COUNT(realized_curation_sp) as with_outcome,
      COUNT(vote_delay_minutes) as with_delay,
      AVG(CASE WHEN is_self_post=1 THEN vote_delay_minutes END) as avg_delay_self,
      AVG(CASE WHEN is_self_post=0 THEN vote_delay_minutes END) as avg_delay_others,
      AVG(realized_curation_sp) as avg_sp
    FROM vb_global_vote_outcomes
    WHERE voter = ?
  `).get(username) as {
    total: number; with_outcome: number; with_delay: number;
    avg_delay_self: number | null; avg_delay_others: number | null; avg_sp: number | null;
  } | undefined;

  // Best performing delay bucket (5 buckets: <5, 5-30, 30-60, 60-1440, >1440 min)
  const buckets = db.prepare(`
    SELECT
      CASE
        WHEN vote_delay_minutes < 5   THEN '0-5 min'
        WHEN vote_delay_minutes < 30  THEN '5-30 min'
        WHEN vote_delay_minutes < 60  THEN '30-60 min'
        WHEN vote_delay_minutes < 1440 THEN '1-24h'
        ELSE '>24h'
      END as bucket,
      AVG(realized_curation_sp) as avg_sp,
      COUNT(*) as n
    FROM vb_global_vote_outcomes
    WHERE voter = ? AND realized_curation_sp IS NOT NULL AND vote_delay_minutes IS NOT NULL
    GROUP BY bucket
    ORDER BY avg_sp DESC
    LIMIT 1
  `).get(username) as { bucket: string; avg_sp: number; n: number } | undefined;

  return {
    username,
    totalVotes:      totals?.total ?? 0,
    withOutcome:     totals?.with_outcome ?? 0,
    withDelay:       totals?.with_delay ?? 0,
    avgDelaySelf:    totals?.avg_delay_self ?? null,
    avgDelayOthers:  totals?.avg_delay_others ?? null,
    avgCurationSp:   totals?.avg_sp ?? null,
    bestDelayBucket: buckets?.bucket ?? null,
    rebuiltAt:       new Date().toISOString(),
  };
}
