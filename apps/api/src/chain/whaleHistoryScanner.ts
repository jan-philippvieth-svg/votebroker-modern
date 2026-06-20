/**
 * Historical Whale Vote Scanner
 * ==============================
 * Scans get_account_history for known whale accounts and stores all vote ops
 * into vb_whale_vote_details. Runs incrementally — picks up from last stored
 * voted_at per whale, so re-runs are cheap.
 *
 * Scan depth: 90 days or until the last stored vote (whichever is more recent).
 * Rate-limited at ~150ms between API calls to avoid node hammering.
 */

import { createSteemClient } from "./steemBroadcaster.js";
import { getDb } from "../db/index.js";
import { SEED_WHALES, discoverTopVoters } from "./whaleSignals.js";

const LOOKBACK_DAYS = 90;
const PAGE_SIZE     = 100;   // api.steemit.com hard-limits get_account_history to 100
const MAX_PAGES     = 2000;  // 200k ops max per whale before giving up
const RATE_MS       = 150;   // ms between API calls
const SCAN_INTERVAL_MS = 15 * 60 * 1000; // re-scan every 15 min so fresh whale votes
                                          // land inside the opportunity timing window (≤2h)

type HistoryEntry = [
  number,
  {
    trx_id:    string;
    block:     number;
    timestamp: string;
    op:        [string, Record<string, unknown>];
  }
];

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

let _running = false;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _started = false;

export async function scanWhaleHistory(
  log: typeof console = console,
): Promise<{ whalesScanned: number; votesInserted: number }> {
  if (_running) {
    log.info("[WhaleHistory] Already running, skipping");
    return { whalesScanned: 0, votesInserted: 0 };
  }
  _running = true;

  try {
    return await runScan(log);
  } finally {
    _running = false;
  }
}

async function runScan(
  log: typeof console = console,
): Promise<{ whalesScanned: number; votesInserted: number }> {
  const db     = getDb();
  const client = createSteemClient();

  // Build whale list: seed + auto-discovered top voters
  const discovered = await discoverTopVoters(60, log);
  const whales     = [...new Set([...SEED_WHALES, ...discovered])];
  const cutoffMs   = Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1_000;

  log.info(`[WhaleHistory] Scanning ${whales.length} whales, ${LOOKBACK_DAYS}d lookback`);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO vb_whale_vote_details (whale, author, permlink, voted_at, vote_weight_bps)
    VALUES (?, ?, ?, ?, ?)
  `);

  let totalInserted = 0;
  let whalesScanned = 0;

  for (const whale of whales) {
    // Incremental: only fetch since the last stored vote for this whale (max 90d ago)
    const lastRow = db.prepare(
      "SELECT MAX(voted_at) AS last FROM vb_whale_vote_details WHERE whale = ?"
    ).get(whale) as { last: string | null };
    const lastMs   = lastRow?.last ? new Date(lastRow.last + "Z").getTime() : 0;
    const sinceMs  = Math.max(cutoffMs, lastMs);

    let from       = -1;
    let reachedEnd = false;
    let wInserted  = 0;

    for (let page = 0; page < MAX_PAGES && !reachedEnd; page++) {
      let batch: HistoryEntry[];
      try {
        batch = await client.database.call(
          "get_account_history", [whale, from, PAGE_SIZE]
        ) as HistoryEntry[];
      } catch (err) {
        log.warn(`[WhaleHistory] @${whale} p${page} API error:`, err);
        break;
      }

      if (!batch || batch.length === 0) break;

      const rows: [string, string, string, string, number][] = [];

      for (const entry of [...batch].reverse()) {
        const tsMs = new Date(entry[1].timestamp + "Z").getTime();
        if (tsMs < sinceMs) { reachedEnd = true; break; }

        const [opType, opData] = entry[1].op;
        if (opType !== "vote" || opData["voter"] !== whale) continue;

        const weightBps = Math.abs(Number(opData["weight"] ?? 0));
        if (weightBps === 0) continue; // unvotes / 0-weight — skip

        rows.push([
          whale,
          String(opData["author"] ?? ""),
          String(opData["permlink"] ?? ""),
          entry[1].timestamp,
          weightBps,
        ]);
      }

      if (rows.length > 0) {
        const batchInsert = db.transaction(() => {
          for (const row of rows) {
            const r = insert.run(...row);
            if (r.changes > 0) wInserted++;
          }
        });
        batchInsert();
      }

      const oldest = batch[0][0];
      if (oldest <= 0) break;
      from = oldest - 1;

      await sleep(RATE_MS);
    }

    log.info(`[WhaleHistory] @${whale}: +${wInserted} new votes`);
    totalInserted += wInserted;
    whalesScanned++;

    await sleep(RATE_MS);
  }

  log.info(`[WhaleHistory] Done — ${whalesScanned} whales, ${totalInserted} votes inserted`);
  return { whalesScanned, votesInserted: totalInserted };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
// Runs an immediate scan, then re-scans every SCAN_INTERVAL_MS. Without this the
// scan only ran once at startup, so whale-vote ingestion froze after boot and the
// opportunity cache dried up once every whale-voted post aged past the 2h timing
// window. Incremental re-scans are cheap (picks up from last stored voted_at).
export function startWhaleHistoryScanner(log: typeof console = console): void {
  if (_started) return;
  _started = true;

  const schedule = () => {
    _timer = setTimeout(async () => {
      try { await scanWhaleHistory(log); } catch (e) { log.warn("[WhaleHistory] scan error:", e); }
      schedule();
    }, SCAN_INTERVAL_MS);
  };

  scanWhaleHistory(log).catch(e => log.warn("[WhaleHistory] startup scan error:", e));
  schedule();
  log.info(`[WhaleHistory] Started — interval ${SCAN_INTERVAL_MS / 60_000} min`);
}

export function stopWhaleHistoryScanner(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _started = false;
}
