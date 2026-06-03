/**
 * Rebuild vb_vote_outcomes from the Steem blockchain
 * =====================================================
 * This table is a cache/index. The chain is the truth.
 * This job can be run at any time to rebuild from get_account_history.
 *
 * Steps:
 *   1. Load all vote_broadcast_success from audit_events (VoteBroker votes)
 *   2. Scan get_account_history for curation_reward ops
 *   3. Match rewards to votes by author/permlink
 *   4. Upsert into vb_vote_outcomes with chain provenance fields
 *   5. Return report: matched, pending, not_found, rebuilt_at
 */

import { createSteemClient } from "./steemBroadcaster.js";
import { getDb } from "../db/index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RebuildReport {
  username:      string;
  votesFound:    number;   // VoteBroker votes in audit_events
  rewardsFound:  number;   // curation_reward ops scanned from chain
  matched:       number;   // votes with a matched on-chain reward
  pending:       number;   // votes not yet paid out (cashout_time in future)
  notFound:      number;   // votes with no matching reward found
  rebuiltAt:     string;
  durationMs:    number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseAmount(v: unknown): number {
  return parseFloat(String(v).split(" ")[0]) || 0;
}

type HistoryEntry = [
  number,
  {
    trx_id:    string;
    block:     number;
    timestamp: string;
    op:        [string, Record<string, unknown>];
  }
];

// ── Main rebuild ──────────────────────────────────────────────────────────────

export async function rebuildVoteOutcomes(
  username: string,
  log: typeof console = console,
): Promise<RebuildReport> {
  const t0  = Date.now();
  const db  = getDb();

  log.info(`[Rebuild] Starting vb_vote_outcomes rebuild for @${username}`);

  // ── 1. Load VoteBroker votes from audit_events ────────────────────────────
  const voteRows = db.prepare(`
    SELECT author, permlink, weight_bps, transaction_id, created_at
    FROM audit_events
    WHERE username = ? AND type = 'vote_broadcast_success' AND author IS NOT NULL
    ORDER BY created_at ASC
  `).all(username) as Array<{
    author: string; permlink: string; weight_bps: number;
    transaction_id: string | null; created_at: string;
  }>;

  // Fallback: use attempts if no successes
  const useAttempts = voteRows.length === 0;
  const votes = useAttempts
    ? (db.prepare(`
        SELECT author, permlink, weight_bps, transaction_id, created_at
        FROM audit_events
        WHERE username = ? AND type = 'vote_broadcast_attempt' AND author IS NOT NULL
        ORDER BY created_at ASC
      `).all(username) as typeof voteRows)
    : voteRows;

  log.info(`[Rebuild] Found ${votes.length} VoteBroker votes${useAttempts ? " (fallback: attempts)" : " (confirmed)"}`);

  if (votes.length === 0) {
    return {
      username, votesFound: 0, rewardsFound: 0,
      matched: 0, pending: 0, notFound: 0,
      rebuiltAt: new Date().toISOString(), durationMs: Date.now() - t0,
    };
  }

  // Build lookup set: "author/permlink" → vote metadata
  const voteMap = new Map<string, typeof votes[0]>();
  for (const v of votes) voteMap.set(`${v.author}/${v.permlink}`, v);

  // ── 2. Get VESTS → SP conversion ──────────────────────────────────────────
  const client       = createSteemClient();
  const globalProps  = await client.database.getDynamicGlobalProperties();
  const totalFund    = parseAmount(globalProps.total_vesting_fund_steem);
  const totalVests   = parseAmount(globalProps.total_vesting_shares);
  const vestsPerSp   = totalVests > 0 ? totalVests / totalFund : 20_000;

  // ── 3. Scan get_account_history for curation_reward ops ──────────────────
  const rewardsByPost = new Map<string, {
    sp: number; realizedAt: string; trxId: string; blockNum: number;
  }>();

  // Parse timestamp — audit_events.created_at may or may not have trailing Z
  const parseTs = (s: string) => new Date(s.endsWith("Z") ? s : s + "Z").getTime();

  // Earliest VoteBroker vote — no need to scan older history
  const oldestVote = parseTs(votes[0].created_at);
  let from           = -1;
  let reachedEnd     = false;
  const PAGE_SIZE    = 100;
  const MAX_PAGES    = 50;
  let   rewardsFound = 0;

  for (let page = 0; page < MAX_PAGES && !reachedEnd; page++) {
    const batch = await client.database.call(
      "get_account_history", [username, from, PAGE_SIZE]
    ) as HistoryEntry[];

    if (!batch || batch.length === 0) break;

    for (const entry of [...batch].reverse()) {
      const ts = new Date(entry[1].timestamp + "Z").getTime();
      if (ts < oldestVote - 24 * 3600 * 1000) { reachedEnd = true; break; }

      const [opType, opData] = entry[1].op;
      if (opType === "curation_reward" && opData["curator"] === username) {
        rewardsFound++;
        const postKey = `${opData["comment_author"]}/${opData["comment_permlink"]}`;
        if (!rewardsByPost.has(postKey)) {
          const sp = Math.round((parseAmount(opData["reward"]) / vestsPerSp) * 10_000) / 10_000;
          rewardsByPost.set(postKey, {
            sp,
            realizedAt: entry[1].timestamp,
            trxId:      entry[1].trx_id,
            blockNum:   entry[1].block,
          });
        }
      }
    }

    const oldest = batch[0][0];
    if (oldest <= 0) break;
    from = oldest - 1;
  }

  log.info(`[Rebuild] Scanned ${rewardsFound} curation_reward ops from chain`);

  // ── 4. Upsert matched outcomes ────────────────────────────────────────────
  const upsert = db.prepare(`
    INSERT INTO vb_vote_outcomes
      (vote_key, username, author, permlink, voted_at, weight_bps,
       realized_sp, realized_at, vote_trx_id, reward_trx_id, reward_block_num)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vote_key) DO UPDATE SET
      realized_sp      = excluded.realized_sp,
      realized_at      = excluded.realized_at,
      vote_trx_id      = excluded.vote_trx_id,
      reward_trx_id    = excluded.reward_trx_id,
      reward_block_num = excluded.reward_block_num,
      recorded_at      = datetime('now')
  `);

  let matched = 0, pending = 0, notFound = 0;

  const nowMs = Date.now();
  const doUpsert = db.transaction(() => {
    for (const [postKey, vote] of voteMap) {
      const reward = rewardsByPost.get(postKey);
      const voteKey = `${username}/${postKey}`;

      if (reward) {
        upsert.run(
          voteKey, username, vote.author, vote.permlink,
          vote.created_at, vote.weight_bps,
          reward.sp, reward.realizedAt,
          vote.transaction_id ?? null,
          reward.trxId, reward.blockNum,
        );
        matched++;
      } else {
        // Insert vote without reward (pending or not found)
        // Only insert if not already in DB to avoid overwriting existing reward data
        db.prepare(`
          INSERT OR IGNORE INTO vb_vote_outcomes
            (vote_key, username, author, permlink, voted_at, weight_bps, vote_trx_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(voteKey, username, vote.author, vote.permlink,
               vote.created_at, vote.weight_bps, vote.transaction_id ?? null);

        // Classify: pending (vote recent enough that post hasn't paid out)
        const voteAge = nowMs - parseTs(vote.created_at);
        const sevenDays = 7 * 24 * 3600 * 1000;
        if (voteAge < sevenDays) pending++;
        else notFound++;
      }
    }
  });

  doUpsert();

  const report: RebuildReport = {
    username,
    votesFound:   votes.length,
    rewardsFound,
    matched,
    pending,
    notFound,
    rebuiltAt:   new Date().toISOString(),
    durationMs:  Date.now() - t0,
  };

  log.info(`[Rebuild] Done in ${report.durationMs}ms — matched:${matched} pending:${pending} notFound:${notFound}`);
  return report;
}
