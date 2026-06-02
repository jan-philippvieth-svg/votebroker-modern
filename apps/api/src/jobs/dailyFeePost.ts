import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import { ensureDailyFeePost } from "../chain/steemFeePost.js";
import { writeAuditEvent } from "../audit/auditLog.js";
import { broadcastConfig } from "../config.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type FeePostStatus = "success" | "failed" | "skipped";

export interface FeePostLogEntry {
  id:             string;
  dateStr:        string;
  status:         FeePostStatus;
  permlink:       string | null;
  alreadyExisted: boolean;
  error:          string | null;
  executedAt:     string;
  nextRunAt:      string | null;
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

type FeeLogRow = {
  id: string; date_str: string; status: string;
  permlink: string | null; already_existed: number;
  error: string | null; executed_at: string; next_run_at: string | null;
};

function rowToEntry(row: FeeLogRow): FeePostLogEntry {
  return {
    id:             row.id,
    dateStr:        row.date_str,
    status:         row.status as FeePostStatus,
    permlink:       row.permlink,
    alreadyExisted: row.already_existed !== 0,
    error:          row.error,
    executedAt:     row.executed_at,
    nextRunAt:      row.next_run_at,
  };
}

export function getRecentFeePostLog(limit = 10): FeePostLogEntry[] {
  const rows = getDb().prepare(
    "SELECT * FROM fee_post_log ORDER BY executed_at DESC LIMIT ?"
  ).all(limit) as FeeLogRow[];
  return rows.map(rowToEntry);
}

export function getLastFeePostRun(): FeePostLogEntry | null {
  const row = getDb().prepare(
    "SELECT * FROM fee_post_log ORDER BY executed_at DESC LIMIT 1"
  ).get() as FeeLogRow | undefined;
  return row ? rowToEntry(row) : null;
}

function logRun(entry: Omit<FeePostLogEntry, "id" | "executedAt">): void {
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO fee_post_log (id, date_str, status, permlink, already_existed, error, executed_at, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), entry.dateStr, entry.status, entry.permlink,
         entry.alreadyExisted ? 1 : 0, entry.error, now, entry.nextRunAt);
}

// ── Scheduler timing ──────────────────────────────────────────────────────────

const RUN_HOUR_UTC   = 1;   // 01:00 UTC
const RUN_MINUTE_UTC = 0;

function nextRunTime(): Date {
  const now  = new Date();
  const next = new Date(now);
  next.setUTCHours(RUN_HOUR_UTC, RUN_MINUTE_UTC, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function msUntilNextRun(): number {
  return nextRunTime().getTime() - Date.now();
}

// ── Core job ──────────────────────────────────────────────────────────────────

/**
 * @param date  Override the target date (default: today UTC). Pass a past date to retroactively
 *              publish a missing fee post without affecting tomorrow's scheduled run.
 */
export async function runDailyFeePost(
  log: typeof console = console,
  date?: Date,
  forceUpdate?: boolean,
): Promise<FeePostLogEntry> {
  const now     = date ?? new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const nextRun = nextRunTime();
  const account = broadcastConfig.account;

  log.info(`[DailyFeePost] Running for ${dateStr}${date ? " (retroactive)" : ""}${forceUpdate ? " (force-update)" : ""} — next scheduled run at ${nextRun.toISOString()}`);

  try {
    const result = await ensureDailyFeePost({ newUsers: [], date: now, forceUpdate });

    const entry: Omit<FeePostLogEntry, "id" | "executedAt"> = {
      dateStr,
      status:         result.alreadyExisted ? "skipped" : "success",
      permlink:       result.permlink,
      alreadyExisted: result.alreadyExisted,
      error:          null,
      nextRunAt:      nextRun.toISOString(),
    };
    logRun(entry);

    if (result.alreadyExisted) {
      log.info(`[DailyFeePost] Post already exists: @${result.author}/${result.permlink}`);
      writeAuditEvent({
        type:      "fee_post_skipped",
        username:  account,
        author:    result.author,
        permlink:  result.permlink,
        weightBps: 0,
        detail:    `Fee settlement post already exists for ${dateStr}`,
      });
    } else {
      log.info(`[DailyFeePost] ✓ Published @${result.author}/${result.permlink}`);
      writeAuditEvent({
        type:      "fee_post_published",
        username:  account,
        author:    result.author,
        permlink:  result.permlink,
        weightBps: 0,
        detail:    `Fee settlement post published for ${dateStr}${date ? " (manual retroactive trigger)" : ""}`,
      });
    }

    return { ...entry, id: "latest", executedAt: now.toISOString() };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error(`[DailyFeePost] ✗ Failed for ${dateStr}: ${error}`);

    writeAuditEvent({
      type:      "fee_post_failed",
      username:  account,
      author:    account,
      permlink:  `daily-fees-${dateStr}`,
      weightBps: 0,
      detail:    `Fee settlement post failed for ${dateStr}: ${error}`,
    });

    const entry: Omit<FeePostLogEntry, "id" | "executedAt"> = {
      dateStr,
      status:         "failed",
      permlink:       null,
      alreadyExisted: false,
      error,
      nextRunAt:      nextRun.toISOString(),
    };
    logRun(entry);

    return { ...entry, id: "latest", executedAt: now.toISOString() };
  }
}

// ── Scheduler loop ────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setTimeout> | null = null;
let _started = false;

export function startDailyFeePostScheduler(log: typeof console = console): void {
  if (_started) return;
  _started = true;

  function schedule(): void {
    const delay = msUntilNextRun();
    const nextRun = nextRunTime();
    log.info(`[DailyFeePost] Scheduler started — next run at ${nextRun.toISOString()} (in ${(delay / 3600000).toFixed(1)}h)`);

    _timer = setTimeout(async () => {
      await runDailyFeePost(log);
      schedule(); // reschedule for next day
    }, delay);
  }

  schedule();
}

export function stopDailyFeePostScheduler(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _started = false;
}
