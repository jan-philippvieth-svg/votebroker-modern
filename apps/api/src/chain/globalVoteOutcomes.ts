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

// ── Constants ─────────────────────────────────────────────────────────────────

// Votes before this date were imported from get_account_history retroactively.
// They have artificially large vote_delay_minutes (days, not minutes) and are
// not representative of VoteBroker's real-time auto-vote behavior.
// recordVoteAtBroadcast was activated on this date — everything from here on is live.
export const LIVE_VOTES_SINCE = "2026-06-03";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GlobalVoteOutcomeSummary {
  username:       string;
  totalVotes:     number;
  withOutcome:    number;   // have realized_curation_sp
  withDelay:      number;   // have vote_delay_minutes
  avgDelaySelf:   number | null;
  avgDelayOthers: number | null;
  avgCurationSp:  number | null;
  bestDelayBucket: string | null;
  // Data quality annotation — present when pre-LIVE_VOTES_SINCE rows exist.
  // bestDelayBucket is unreliable when dataNote is "includes_historical_imports".
  dataNote: "live_only" | "includes_historical_imports";
  historicalImportCount: number;  // votes before LIVE_VOTES_SINCE
  rebuiltAt:      string;
}

export interface LiveVoteReportBucket {
  label:        string;
  votes:        number;
  avgCurationSp: number | null;
  minDelay:     number | null;
  maxDelay:     number | null;
}

export interface PayoutBucketAnalysis {
  label:         string;
  votes:         number;
  avgCurationSp: number | null;
  avgVpBps:      number | null;   // VP before vote (vp_before_vote_bps)
  avgWeightPct:  number | null;
}

// One cell of the delay × pending-payout cross-analysis.
// Flat list — up to 35 cells (7 delay × 5 payout buckets).
export interface DelayPayoutCell {
  delayLabel:    string;
  payoutLabel:   string;
  votes:         number;
  avgCurationSp: number | null;
  avgVpBps:      number | null;
  avgWeightPct:  number | null;
}

export interface LiveVoteReport {
  username:         string;
  since:            string;          // LIVE_VOTES_SINCE
  totalLive:        number;          // voted_at >= LIVE_VOTES_SINCE
  realized:         number;          // with realized_curation_sp
  pending:          number;          // without realized_curation_sp
  avgCurationSp:    number | null;   // realized only
  // 7 analysis dimensions (realized votes only)
  byDelay:             LiveVoteReportBucket[];
  byWeight:            LiveVoteReportBucket[];
  byCategory:          Array<{ category: string; votes: number; avgCurationSp: number | null; avgWeightPct: number | null }>;
  byCommunity:         Array<{ community: string; votes: number; avgCurationSp: number | null }>;
  byAuthor:            Array<{ author: string; votes: number; avgDelay: number | null; avgWeightPct: number | null; avgCurationSp: number | null }>;
  byPendingPayout:     PayoutBucketAnalysis[];
  byDelayAndPayout:    DelayPayoutCell[];
  generatedAt:         string;
}

// ── Real-time capture at vote broadcast ──────────────────────────────────────
//
// Called fire-and-forget immediately after a successful vote broadcast.
// Captures everything knowable at vote time: VP, post state, competition.
// This is the primary source of training data for the future vote copilot.

export async function recordVoteAtBroadcast(params: {
  voter:            string;
  author:           string;
  permlink:         string;
  weightBps:        number;
  transactionId:    string | null;
  strategyCategory?: string | null;
  // VP before the vote — pass from routes.ts where the snapshot was already fetched.
  // When omitted (Keychain votes), estimated by reversing the vote cost formula.
  vpBeforeBps?:     number | null;
}): Promise<void> {
  const db      = getDb();
  const client  = createSteemClient();
  const votedAt = new Date().toISOString();

  // Fetch post state, voter account, and reward fund in parallel
  const [post, accounts, rewardFund] = await Promise.all([
    client.database.call("get_content", [params.author, params.permlink]) as Promise<{
      author?:               string;
      created?:              string;
      category?:             string;        // first tag / community
      parent_permlink?:      string;        // community id for community posts
      json_metadata?:        string;
      pending_payout_value?: string;
      active_votes?:         unknown[];
      net_votes?:            number;
    }>,
    client.database.getAccounts([params.voter, params.author]) as Promise<Array<{
      name:                      string;
      reputation?:               number | string;
      voting_manabar?:           { current_mana: string | number; last_update_time: number };
      vesting_shares?:           string;
      delegated_vesting_shares?: string;
      received_vesting_shares?:  string;
    }>>,
    client.database.call("get_reward_fund", ["post"]) as Promise<{
      reward_balance: string;
      recent_claims:  string;
    }>,
  ]);

  const voterAccount  = accounts.find(a => a.name === params.voter);
  const authorAccount = accounts.find(a => a.name === params.author);

  // ── VP after vote (from account state read immediately post-broadcast) ────────
  let vpAfterVoteBps: number | null = null;
  let effectiveVestsMicro = 0;
  if (voterAccount?.voting_manabar) {
    const mb         = voterAccount.voting_manabar;
    const vests      = parseFloat(String(voterAccount.vesting_shares             ?? "0").split(" ")[0]);
    const delegated  = parseFloat(String(voterAccount.delegated_vesting_shares   ?? "0").split(" ")[0]);
    const received   = parseFloat(String(voterAccount.received_vesting_shares    ?? "0").split(" ")[0]);
    effectiveVestsMicro = (vests - delegated + received) * 1_000_000;
    const storedMana = Number(mb.current_mana);
    const nowSec     = Math.floor(Date.now() / 1000);
    const regenMana  = ((nowSec - mb.last_update_time) / (5 * 86_400)) * effectiveVestsMicro;
    const curMana    = Math.min(effectiveVestsMicro, storedMana + regenMana);
    vpAfterVoteBps   = effectiveVestsMicro > 0 ? Math.round((curMana / effectiveVestsMicro) * 10_000) : null;
  }

  // ── VP before vote ────────────────────────────────────────────────────────────
  // Prefer the value passed in from routes.ts (captured before broadcast).
  // Fallback: reverse the vote cost — cost ≈ vp_before * weight / 10000 / 50
  // → vp_before ≈ vp_after / (1 − weight/500000)
  let vpBeforeVoteBps: number | null = params.vpBeforeBps ?? null;
  if (vpBeforeVoteBps === null && vpAfterVoteBps !== null) {
    const factor = 1 - params.weightBps / 500_000;
    vpBeforeVoteBps = factor > 0 ? Math.round(vpAfterVoteBps / factor) : null;
  }

  // ── Estimated vote value (SBD) at cast time ───────────────────────────────────
  // rshares = effective_mana_before / VOTE_DENOM  where VOTE_DENOM = 50
  // vote_value_sbd = (rshares / recent_claims) * reward_balance
  let voteValueSbd: number | null = null;
  if (vpBeforeVoteBps !== null && effectiveVestsMicro > 0 && rewardFund) {
    const manaBefore  = (vpBeforeVoteBps / 10_000) * effectiveVestsMicro;
    const rshares     = Math.floor(manaBefore * (params.weightBps / 10_000) / 50);
    const rwBalance   = parseFloat(String(rewardFund.reward_balance).split(" ")[0]);
    const recentClaims = parseFloat(rewardFund.recent_claims);
    if (recentClaims > 0 && rshares > 0) {
      voteValueSbd = Math.round((rshares / recentClaims) * rwBalance * 10_000) / 10_000;
    }
  }

  // ── Post timing ───────────────────────────────────────────────────────────────
  let postCreatedAt:    string | null = null;
  let voteDelayMinutes: number | null = null;
  if (post?.author && post.created) {
    postCreatedAt    = post.created;
    const postMs     = new Date(post.created + "Z").getTime();
    const voteMs     = new Date(votedAt).getTime();
    voteDelayMinutes = !isNaN(postMs) ? Math.round((voteMs - postMs) / 60_000 * 10) / 10 : null;
  }

  // ── Community ─────────────────────────────────────────────────────────────────
  // Prefer json_metadata.community, fall back to parent_permlink / category.
  let postCommunity: string | null = null;
  if (post?.json_metadata) {
    try {
      const meta = JSON.parse(post.json_metadata) as { community?: string; tags?: string[] };
      postCommunity = meta.community ?? null;
    } catch { /* malformed JSON */ }
  }
  if (!postCommunity && post?.parent_permlink) postCommunity = post.parent_permlink;
  if (!postCommunity && post?.category)        postCommunity = post.category;

  // ── Post competition snapshot ─────────────────────────────────────────────────
  const pendingPayoutSbd = post?.pending_payout_value
    ? parseFloat(String(post.pending_payout_value).split(" ")[0]) : null;
  const activeVotesCount = Array.isArray(post?.active_votes) ? post.active_votes.length : null;
  const netVotes         = typeof post?.net_votes === "number" ? post.net_votes : null;
  const authorReputation = authorAccount?.reputation !== undefined
    ? Number(authorAccount.reputation) : null;

  // ── Upsert ────────────────────────────────────────────────────────────────────
  db.prepare(`
    INSERT INTO vb_global_vote_outcomes
      (voter, author, permlink, post_created_at, voted_at, vote_delay_minutes,
       weight_bps, vp_at_vote_bps, vp_before_vote_bps, vp_after_vote_bps,
       vote_value_sbd, estimated_vote_value_sbd,
       post_community, strategy_category, is_self_post, source_vote_trx_id,
       post_pending_payout_sbd, post_active_votes_count,
       post_net_votes, post_author_reputation)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(voter, author, permlink) DO UPDATE SET
      vp_at_vote_bps          = COALESCE(excluded.vp_at_vote_bps,          vp_at_vote_bps),
      vp_before_vote_bps      = COALESCE(excluded.vp_before_vote_bps,      vp_before_vote_bps),
      vp_after_vote_bps       = COALESCE(excluded.vp_after_vote_bps,       vp_after_vote_bps),
      vote_value_sbd          = COALESCE(excluded.vote_value_sbd,           vote_value_sbd),
      estimated_vote_value_sbd = COALESCE(excluded.estimated_vote_value_sbd, estimated_vote_value_sbd),
      post_community          = COALESCE(excluded.post_community,           post_community),
      post_created_at         = COALESCE(excluded.post_created_at,          post_created_at),
      vote_delay_minutes      = COALESCE(excluded.vote_delay_minutes,       vote_delay_minutes),
      post_pending_payout_sbd = COALESCE(excluded.post_pending_payout_sbd,  post_pending_payout_sbd),
      post_active_votes_count = COALESCE(excluded.post_active_votes_count,  post_active_votes_count),
      post_net_votes          = COALESCE(excluded.post_net_votes,           post_net_votes),
      post_author_reputation  = COALESCE(excluded.post_author_reputation,   post_author_reputation),
      recorded_at             = datetime('now')
  `).run(
    params.voter, params.author, params.permlink,
    postCreatedAt, votedAt, voteDelayMinutes,
    params.weightBps,
    vpAfterVoteBps,       // vp_at_vote_bps (legacy alias, kept for compat)
    vpBeforeVoteBps,
    vpAfterVoteBps,
    voteValueSbd,
    voteValueSbd,         // estimated_vote_value_sbd (same source, dual-stored for compat)
    postCommunity,
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
      SUM(CASE WHEN voted_at < ? THEN 1 ELSE 0 END) as historical_count,
      AVG(CASE WHEN is_self_post=1 THEN vote_delay_minutes END) as avg_delay_self,
      AVG(CASE WHEN is_self_post=0 THEN vote_delay_minutes END) as avg_delay_others,
      AVG(realized_curation_sp) as avg_sp
    FROM vb_global_vote_outcomes
    WHERE voter = ?
  `).get(LIVE_VOTES_SINCE, username) as {
    total: number; with_outcome: number; with_delay: number; historical_count: number;
    avg_delay_self: number | null; avg_delay_others: number | null; avg_sp: number | null;
  } | undefined;

  const historicalCount = totals?.historical_count ?? 0;

  // Best performing delay bucket — only meaningful from live votes
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
    WHERE voter = ? AND voted_at >= ? AND realized_curation_sp IS NOT NULL AND vote_delay_minutes IS NOT NULL
    GROUP BY bucket
    ORDER BY avg_sp DESC
    LIMIT 1
  `).get(username, LIVE_VOTES_SINCE) as { bucket: string; avg_sp: number; n: number } | undefined;

  return {
    username,
    totalVotes:            totals?.total ?? 0,
    withOutcome:           totals?.with_outcome ?? 0,
    withDelay:             totals?.with_delay ?? 0,
    avgDelaySelf:          totals?.avg_delay_self ?? null,
    avgDelayOthers:        totals?.avg_delay_others ?? null,
    avgCurationSp:         totals?.avg_sp ?? null,
    bestDelayBucket:       buckets?.bucket ?? null,
    dataNote:              historicalCount > 0 ? "includes_historical_imports" : "live_only",
    historicalImportCount: historicalCount,
    rebuiltAt:             new Date().toISOString(),
  };
}

// ── Live vote report — first real analytics baseline ─────────────────────────
// Only votes from LIVE_VOTES_SINCE onwards; only realized entries.
// This is the foundation for the future vote copilot.

export function getLiveVoteReport(username: string): LiveVoteReport {
  const db = getDb();

  const overview = db.prepare(`
    SELECT
      COUNT(*) as total_live,
      COUNT(realized_curation_sp) as realized,
      AVG(realized_curation_sp) as avg_sp
    FROM vb_global_vote_outcomes
    WHERE voter = ? AND voted_at >= ?
  `).get(username, LIVE_VOTES_SINCE) as {
    total_live: number; realized: number; avg_sp: number | null;
  };

  const REALIZED_FILTER = "voter = ? AND voted_at >= ? AND realized_curation_sp IS NOT NULL";

  const delayRows = db.prepare(`
    SELECT
      CASE
        WHEN vote_delay_minutes < 30   THEN '< 30 min'
        WHEN vote_delay_minutes < 60   THEN '30–60 min'
        WHEN vote_delay_minutes < 120  THEN '1–2 h'
        WHEN vote_delay_minutes < 360  THEN '2–6 h'
        WHEN vote_delay_minutes < 1440 THEN '6–24 h'
        WHEN vote_delay_minutes < 4320 THEN '1–3 Tage'
        ELSE '> 3 Tage'
      END as label,
      COUNT(*) as votes,
      AVG(realized_curation_sp) as avg_sp,
      MIN(vote_delay_minutes) as min_delay,
      MAX(vote_delay_minutes) as max_delay
    FROM vb_global_vote_outcomes
    WHERE ${REALIZED_FILTER}
    GROUP BY label
    ORDER BY MIN(vote_delay_minutes)
  `).all(username, LIVE_VOTES_SINCE) as Array<{
    label: string; votes: number; avg_sp: number | null; min_delay: number | null; max_delay: number | null;
  }>;

  const weightRows = db.prepare(`
    SELECT
      CASE
        WHEN weight_bps < 1000  THEN '< 10%'
        WHEN weight_bps < 3000  THEN '10–30%'
        WHEN weight_bps < 5000  THEN '30–50%'
        WHEN weight_bps < 8000  THEN '50–80%'
        ELSE '80–100%'
      END as label,
      COUNT(*) as votes,
      AVG(realized_curation_sp) as avg_sp,
      MIN(vote_delay_minutes) as min_delay,
      MAX(vote_delay_minutes) as max_delay
    FROM vb_global_vote_outcomes
    WHERE ${REALIZED_FILTER}
    GROUP BY label
    ORDER BY MIN(weight_bps)
  `).all(username, LIVE_VOTES_SINCE) as Array<{
    label: string; votes: number; avg_sp: number | null; min_delay: number | null; max_delay: number | null;
  }>;

  const categoryRows = db.prepare(`
    SELECT
      COALESCE(strategy_category, 'unbekannt') as category,
      COUNT(*) as votes,
      AVG(realized_curation_sp) as avg_sp,
      AVG(weight_bps) / 100.0 as avg_weight_pct
    FROM vb_global_vote_outcomes
    WHERE ${REALIZED_FILTER}
    GROUP BY strategy_category
    ORDER BY avg_sp DESC
  `).all(username, LIVE_VOTES_SINCE) as Array<{
    category: string; votes: number; avg_sp: number | null; avg_weight_pct: number | null;
  }>;

  const communityRows = db.prepare(`
    SELECT
      COALESCE(post_community, '(kein Tag)') as community,
      COUNT(*) as votes,
      AVG(realized_curation_sp) as avg_sp
    FROM vb_global_vote_outcomes
    WHERE ${REALIZED_FILTER}
    GROUP BY post_community
    ORDER BY votes DESC
    LIMIT 20
  `).all(username, LIVE_VOTES_SINCE) as Array<{
    community: string; votes: number; avg_sp: number | null;
  }>;

  const authorRows = db.prepare(`
    SELECT
      author,
      COUNT(*) as votes,
      AVG(vote_delay_minutes) as avg_delay,
      AVG(weight_bps) / 100.0 as avg_weight_pct,
      AVG(realized_curation_sp) as avg_sp
    FROM vb_global_vote_outcomes
    WHERE ${REALIZED_FILTER}
    GROUP BY author
    ORDER BY avg_sp DESC
    LIMIT 30
  `).all(username, LIVE_VOTES_SINCE) as Array<{
    author: string; votes: number; avg_delay: number | null; avg_weight_pct: number | null; avg_sp: number | null;
  }>;

  const payoutBucketRows = db.prepare(`
    SELECT
      CASE
        WHEN post_pending_payout_sbd < 10  THEN '< 10 SBD'
        WHEN post_pending_payout_sbd < 50  THEN '10–50 SBD'
        WHEN post_pending_payout_sbd < 100 THEN '50–100 SBD'
        WHEN post_pending_payout_sbd < 250 THEN '100–250 SBD'
        ELSE '> 250 SBD'
      END as label,
      COUNT(*) as votes,
      AVG(realized_curation_sp) as avg_sp,
      AVG(vp_before_vote_bps) as avg_vp_bps,
      AVG(weight_bps) / 100.0 as avg_weight_pct
    FROM vb_global_vote_outcomes
    WHERE ${REALIZED_FILTER} AND post_pending_payout_sbd IS NOT NULL
    GROUP BY label
    ORDER BY MIN(post_pending_payout_sbd)
  `).all(username, LIVE_VOTES_SINCE) as Array<{
    label: string; votes: number; avg_sp: number | null; avg_vp_bps: number | null; avg_weight_pct: number | null;
  }>;

  const delayPayoutRows = db.prepare(`
    SELECT
      CASE
        WHEN vote_delay_minutes < 30   THEN '< 30 min'
        WHEN vote_delay_minutes < 60   THEN '30–60 min'
        WHEN vote_delay_minutes < 120  THEN '1–2 h'
        WHEN vote_delay_minutes < 360  THEN '2–6 h'
        WHEN vote_delay_minutes < 1440 THEN '6–24 h'
        WHEN vote_delay_minutes < 4320 THEN '1–3 Tage'
        ELSE '> 3 Tage'
      END as delay_label,
      CASE
        WHEN post_pending_payout_sbd < 10  THEN '< 10 SBD'
        WHEN post_pending_payout_sbd < 50  THEN '10–50 SBD'
        WHEN post_pending_payout_sbd < 100 THEN '50–100 SBD'
        WHEN post_pending_payout_sbd < 250 THEN '100–250 SBD'
        ELSE '> 250 SBD'
      END as payout_label,
      COUNT(*) as votes,
      AVG(realized_curation_sp) as avg_sp,
      AVG(vp_before_vote_bps) as avg_vp_bps,
      AVG(weight_bps) / 100.0 as avg_weight_pct
    FROM vb_global_vote_outcomes
    WHERE ${REALIZED_FILTER}
      AND vote_delay_minutes IS NOT NULL
      AND post_pending_payout_sbd IS NOT NULL
    GROUP BY delay_label, payout_label
    ORDER BY MIN(vote_delay_minutes), MIN(post_pending_payout_sbd)
  `).all(username, LIVE_VOTES_SINCE) as Array<{
    delay_label: string; payout_label: string; votes: number;
    avg_sp: number | null; avg_vp_bps: number | null; avg_weight_pct: number | null;
  }>;

  return {
    username,
    since:         LIVE_VOTES_SINCE,
    totalLive:     overview.total_live,
    realized:      overview.realized,
    pending:       overview.total_live - overview.realized,
    avgCurationSp: overview.avg_sp,
    byDelay:    delayRows.map(r => ({ label: r.label, votes: r.votes, avgCurationSp: r.avg_sp, minDelay: r.min_delay, maxDelay: r.max_delay })),
    byWeight:   weightRows.map(r => ({ label: r.label, votes: r.votes, avgCurationSp: r.avg_sp, minDelay: r.min_delay, maxDelay: r.max_delay })),
    byCategory: categoryRows.map(r => ({ category: r.category, votes: r.votes, avgCurationSp: r.avg_sp, avgWeightPct: r.avg_weight_pct })),
    byCommunity: communityRows.map(r => ({ community: r.community, votes: r.votes, avgCurationSp: r.avg_sp })),
    byAuthor:   authorRows.map(r => ({ author: r.author, votes: r.votes, avgDelay: r.avg_delay, avgWeightPct: r.avg_weight_pct, avgCurationSp: r.avg_sp })),
    byPendingPayout:  payoutBucketRows.map(r => ({ label: r.label, votes: r.votes, avgCurationSp: r.avg_sp, avgVpBps: r.avg_vp_bps, avgWeightPct: r.avg_weight_pct })),
    byDelayAndPayout: delayPayoutRows.map(r => ({ delayLabel: r.delay_label, payoutLabel: r.payout_label, votes: r.votes, avgCurationSp: r.avg_sp, avgVpBps: r.avg_vp_bps, avgWeightPct: r.avg_weight_pct })),
    generatedAt: new Date().toISOString(),
  };
}
