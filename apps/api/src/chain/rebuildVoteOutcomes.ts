/**
 * Rebuild vb_vote_outcomes from the Steem blockchain.
 * The chain is the truth; this table is a cache.
 *
 * Resilience features:
 *  - Per-call timeout via Promise.race (10 s)
 *  - Retry with exponential backoff (2 s / 5 s / 10 s / 20 s)
 *  - Node fallback: rotates through FALLBACK_NODES after 2 consecutive failures
 *  - Checkpoint/Resume: saves cursor after every page so a crashed scan
 *    resumes from where it stopped rather than restarting from the end
 *  - Immediate upsert after each page so partial results are durable
 */

import { Client } from "dsteem";
import { steemNetworkConfig } from "../config.js";
import { getDb } from "../db/index.js";

// ── Node list ─────────────────────────────────────────────────────────────────

// Start from the centrally-configured failover list, then append this job's
// extra historical-scan nodes. De-duplicated so config changes propagate here.
const FALLBACK_NODES = [...new Set([
  ...steemNetworkConfig.nodeUrls,
  "https://api.steem.fans",
  "https://steemit.simpleassets.io",
  "https://rpc.steemviz.com",
])];

function makeClient(nodeUrl: string): Client {
  return new Client(nodeUrl, {
    addressPrefix: steemNetworkConfig.addressPrefix,
    chainId:       steemNetworkConfig.chainId,
  });
}

// ── Primitives ────────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`steem node timeout after ${ms}ms`)), ms)
    ),
  ]);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

const BACKOFF_MS = [2_000, 5_000, 10_000, 20_000];
const MAX_RETRIES = 4;
const CALL_TIMEOUT_MS = 10_000;

interface CallContext {
  method:   string;
  account?: string;
  page?:    number;
  from?:    number;
}

async function callWithRetry<T>(
  fn: (client: Client) => Promise<T>,
  ctx: CallContext,
  log: typeof console,
): Promise<T> {
  let nodeIdx  = 0;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const nodeUrl = FALLBACK_NODES[nodeIdx % FALLBACK_NODES.length];
    const client  = makeClient(nodeUrl);
    try {
      return await withTimeout(fn(client), CALL_TIMEOUT_MS);
    } catch (err) {
      lastErr = err;
      const waitMs = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      log.warn({
        err,
        method:     ctx.method,
        account:    ctx.account,
        page:       ctx.page,
        from:       ctx.from,
        attempt:    attempt + 1,
        maxAttempts: MAX_RETRIES + 1,
        node:       nodeUrl,
        nextWaitMs: attempt < MAX_RETRIES ? waitMs : 0,
      }, `[Rebuild] API call failed (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);

      if (attempt >= MAX_RETRIES) break;

      if ((attempt + 1) % 2 === 0) nodeIdx++;
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RebuildReport {
  username:      string;
  votesFound:    number;
  rewardsFound:  number;
  matched:       number;
  pending:       number;
  notFound:      number;
  pagesScanned:  number;
  resumed:       boolean;
  rebuiltAt:     string;
  durationMs:    number;
}

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

// ── Checkpoint helpers ────────────────────────────────────────────────────────

function loadCheckpoint(username: string): number | null {
  const row = getDb().prepare(
    "SELECT from_index FROM vb_rebuild_checkpoint WHERE voter = ? AND status = 'in_progress'"
  ).get(username) as { from_index: number } | undefined;
  return row?.from_index ?? null;
}

function saveCheckpoint(username: string, fromIndex: number): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO vb_rebuild_checkpoint (voter, from_index, last_updated, status)
    VALUES (?, ?, datetime('now'), 'in_progress')
  `).run(username, fromIndex);
}

function clearCheckpoint(username: string): void {
  getDb().prepare(
    "DELETE FROM vb_rebuild_checkpoint WHERE voter = ?"
  ).run(username);
}

// ── Main rebuild ──────────────────────────────────────────────────────────────

export async function rebuildVoteOutcomes(
  username: string,
  log: typeof console = console,
): Promise<RebuildReport> {
  const t0 = Date.now();
  const db  = getDb();

  log.info(`[Rebuild] Starting vb_vote_outcomes rebuild for @${username}`);

  // ── 1. Load VoteBroker votes ───────────────────────────────────────────────
  const voteRows = db.prepare(`
    SELECT author, permlink, weight_bps, transaction_id, created_at
    FROM audit_events
    WHERE username = ? AND type = 'vote_broadcast_success' AND author IS NOT NULL
    ORDER BY created_at ASC
  `).all(username) as Array<{
    author: string; permlink: string; weight_bps: number;
    transaction_id: string | null; created_at: string;
  }>;

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
      matched: 0, pending: 0, notFound: 0, pagesScanned: 0, resumed: false,
      rebuiltAt: new Date().toISOString(), durationMs: Date.now() - t0,
    };
  }

  const voteMap = new Map<string, typeof votes[0]>();
  for (const v of votes) voteMap.set(`${v.author}/${v.permlink}`, v);

  // ── 2. VESTS → SP conversion ──────────────────────────────────────────────
  const globalProps = await callWithRetry(
    c => c.database.getDynamicGlobalProperties(),
    { method: "getDynamicGlobalProperties", account: username },
    log,
  );
  const totalFund  = parseAmount(globalProps.total_vesting_fund_steem);
  const totalVests = parseAmount(globalProps.total_vesting_shares);
  const vestsPerSp = totalVests > 0 ? totalVests / totalFund : 20_000;

  // ── 3. Prepare upsert (runs after every page for durability) ─────────────
  const upsertReward = db.prepare(`
    INSERT INTO vb_vote_outcomes
      (vote_key, username, author, permlink, voted_at, weight_bps,
       realized_sp, realized_at, vote_trx_id, reward_trx_id, reward_block_num)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vote_key) DO UPDATE SET
      realized_sp      = excluded.realized_sp,
      realized_at      = excluded.realized_at,
      vote_trx_id      = COALESCE(excluded.vote_trx_id, vote_trx_id),
      reward_trx_id    = excluded.reward_trx_id,
      reward_block_num = excluded.reward_block_num,
      recorded_at      = datetime('now')
  `);

  // ── 4. Scan get_account_history with checkpoint/resume ───────────────────
  const parseTs  = (s: string) => new Date(s.endsWith("Z") ? s : s + "Z").getTime();
  const oldestVote = parseTs(votes[0].created_at);

  const savedCheckpoint = loadCheckpoint(username);
  const resumed   = savedCheckpoint !== null;
  let   from      = savedCheckpoint ?? -1;
  let   reachedEnd   = false;
  let   rewardsFound = 0;
  let   pagesScanned = 0;

  if (resumed) {
    log.info(`[Rebuild] Resuming from checkpoint: from=${from}`);
  }

  const PAGE_SIZE = 100;
  const MAX_PAGES = 50;

  for (let page = 0; page < MAX_PAGES && !reachedEnd; page++) {
    let batch: HistoryEntry[];
    try {
      batch = await callWithRetry(
        c => c.database.call("get_account_history", [username, from, PAGE_SIZE]) as Promise<HistoryEntry[]>,
        { method: "get_account_history", account: username, page, from },
        log,
      );
    } catch (err) {
      log.warn({ err, page, from, account: username },
        `[Rebuild] get_account_history exhausted retries at page ${page} — stopping with partial results`);
      break;
    }

    if (!batch || batch.length === 0) break;
    pagesScanned++;

    const newRewards: Array<Parameters<typeof upsertReward.run>> = [];

    for (const entry of [...batch].reverse()) {
      const ts = new Date(entry[1].timestamp + "Z").getTime();
      if (ts < oldestVote - 24 * 3600 * 1000) { reachedEnd = true; break; }

      const [opType, opData] = entry[1].op;
      if (opType === "curation_reward" && opData["curator"] === username) {
        rewardsFound++;
        const postKey = `${opData["comment_author"]}/${opData["comment_permlink"]}`;
        const vote    = voteMap.get(postKey);
        if (vote) {
          const sp = Math.round((parseAmount(opData["reward"]) / vestsPerSp) * 10_000) / 10_000;
          newRewards.push([
            `${username}/${postKey}`, username, vote.author, vote.permlink,
            vote.created_at, vote.weight_bps,
            sp, entry[1].timestamp,
            vote.transaction_id ?? null,
            entry[1].trx_id, entry[1].block,
          ]);
        }
      }
    }

    // Upsert this page's rewards immediately (durable even if next page fails)
    if (newRewards.length > 0) {
      const flushPage = db.transaction(() => {
        for (const args of newRewards) upsertReward.run(...args);
      });
      flushPage();
    }

    const oldest = batch[0][0];
    if (oldest <= 0) break;
    from = oldest - 1;

    saveCheckpoint(username, from);
  }

  log.info(`[Rebuild] Scanned ${rewardsFound} curation_reward ops (${pagesScanned} pages)`);

  // ── 5. Insert pending/not-found votes (INSERT OR IGNORE preserves existing rewards) ─
  const insertPending = db.prepare(`
    INSERT OR IGNORE INTO vb_vote_outcomes
      (vote_key, username, author, permlink, voted_at, weight_bps, vote_trx_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let matched = 0, pending = 0, notFound = 0;
  const nowMs = Date.now();

  const classifyAll = db.transaction(() => {
    for (const [postKey, vote] of voteMap) {
      const voteKey = `${username}/${postKey}`;
      const existing = db.prepare(
        "SELECT realized_sp FROM vb_vote_outcomes WHERE vote_key = ?"
      ).get(voteKey) as { realized_sp: number | null } | undefined;

      if (existing?.realized_sp != null) {
        matched++;
      } else {
        insertPending.run(voteKey, username, vote.author, vote.permlink,
          vote.created_at, vote.weight_bps, vote.transaction_id ?? null);
        const voteAge = nowMs - parseTs(vote.created_at);
        if (voteAge < 7 * 24 * 3600 * 1000) pending++; else notFound++;
      }
    }
  });

  classifyAll();
  clearCheckpoint(username);

  const report: RebuildReport = {
    username, votesFound: votes.length, rewardsFound, matched, pending, notFound,
    pagesScanned, resumed, rebuiltAt: new Date().toISOString(), durationMs: Date.now() - t0,
  };

  log.info(`[Rebuild] Done in ${report.durationMs}ms — matched:${matched} pending:${pending} notFound:${notFound} pages:${pagesScanned} resumed:${resumed}`);
  return report;
}
