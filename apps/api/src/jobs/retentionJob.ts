/**
 * Retention / Pruning Job
 * =======================
 * Several tables grow unbounded with normal operation (post scans every 90s, VP
 * samples every 15 min, shadow runs every 30 min, whale vote details). On a
 * single-file SQLite this eventually hurts query latency and backup size.
 *
 * This job deletes rows past a conservative retention window once per day. The
 * windows are deliberately generous — they prune dead weight, never live signal:
 *   - Aggregates (vb_signal_author/community) are recomputed nightly from the
 *     retained raw rows, so trimming old raw rows only shrinks the look-back.
 *   - High-value rows are kept: successful vote audit events forever, CoPilot
 *     `would_vote` decisions (precision history), and all growth snapshots
 *     (the research time-series, bounded by vote count, not by time).
 *
 * Tables that already self-prune are left alone (vb_opportunity_cache prunes on
 * every refresh; sessions are pruned on startup — re-pruned here for long uptimes).
 */

import { getDb } from "../db/index.js";

// ── Retention windows (days) ────────────────────────────────────────────────
const KEEP_POSTS_DAYS          = 14;   // vb_posts: past the 7-day payout window + buffer
const KEEP_VP_SNAPSHOTS_DAYS   = 120;  // vb_vp_snapshots: VP charts look back ≤30d
const KEEP_AUDIT_NOISE_DAYS    = 180;  // audit_events: non-success events (attempt/blocked/…)
const KEEP_SHADOW_SKIP_DAYS    = 60;   // vb_copilot_shadow_runs: skip_* rows (keep would_vote)
const KEEP_WHALE_DETAILS_DAYS  = 120;  // vb_whale_vote_details: whale behaviour recency
const KEEP_AUTHORITY_DAYS      = 30;   // authority_cache: stale entries re-fetch on demand

interface PruneResult { table: string; deleted: number }

let _timer: ReturnType<typeof setTimeout> | null = null;
let _started = false;
let _running = false;

const _stats = {
  lastRunAt:   null as string | null,
  lastDeleted: null as number | null,
  totalRuns:   0,
};

export function getRetentionStats() { return { ..._stats }; }

export function runRetention(log: typeof console = console): PruneResult[] {
  if (_running) { log.info("[Retention] Already running, skipping"); return []; }
  _running = true;
  const results: PruneResult[] = [];

  // Each delete is independent — one failing table must not abort the rest.
  const prune = (table: string, sql: string, ...params: unknown[]): void => {
    try {
      const info = getDb().prepare(sql).run(...(params as [])) as { changes: number };
      if (info.changes > 0) results.push({ table, deleted: info.changes });
    } catch (err) {
      log.warn(`[Retention] prune ${table} failed:`, err);
    }
  };

  try {
    prune("vb_posts",
      `DELETE FROM vb_posts WHERE created < datetime('now', '-${KEEP_POSTS_DAYS} days')`);

    prune("vb_vp_snapshots",
      `DELETE FROM vb_vp_snapshots WHERE sampled_at < datetime('now', '-${KEEP_VP_SNAPSHOTS_DAYS} days')`);

    // Keep successful vote/fee-vote events (all-time analytics); prune the noisy rest.
    prune("audit_events",
      `DELETE FROM audit_events
        WHERE created_at < datetime('now', '-${KEEP_AUDIT_NOISE_DAYS} days')
          AND type NOT IN ('vote_broadcast_success', 'fee_vote_broadcast_success')`);

    // Keep would_vote decisions (author precision history); prune skip/no-post noise.
    prune("vb_copilot_shadow_runs",
      `DELETE FROM vb_copilot_shadow_runs
        WHERE run_at < datetime('now', '-${KEEP_SHADOW_SKIP_DAYS} days')
          AND decision != 'would_vote'`);

    prune("vb_whale_vote_details",
      `DELETE FROM vb_whale_vote_details WHERE voted_at < datetime('now', '-${KEEP_WHALE_DETAILS_DAYS} days')`);

    prune("authority_cache",
      `DELETE FROM authority_cache WHERE checked_at < datetime('now', '-${KEEP_AUTHORITY_DAYS} days')`);

    prune("sessions",
      `DELETE FROM sessions WHERE expiry <= datetime('now')`);

    // Reclaim WAL space without a full (locking) VACUUM.
    try { getDb().pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }

    const totalDeleted = results.reduce((s, r) => s + r.deleted, 0);
    _stats.lastRunAt   = new Date().toISOString();
    _stats.lastDeleted = totalDeleted;
    _stats.totalRuns++;

    if (totalDeleted > 0) {
      log.info(`[Retention] Pruned ${totalDeleted} rows: ` +
        results.map(r => `${r.table}=${r.deleted}`).join(" "));
    } else {
      log.info("[Retention] Nothing to prune");
    }
  } finally {
    _running = false;
  }

  return results;
}

// ── Scheduler — daily at 03:15 UTC (between signalCompute 02:30 and payoutSync 04:00) ──

const RUN_HOUR_UTC   = 3;
const RUN_MINUTE_UTC = 15;

function msUntilNextRun(): number {
  const now  = new Date();
  const next = new Date(now);
  next.setUTCHours(RUN_HOUR_UTC, RUN_MINUTE_UTC, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export function startRetention(log: typeof console = console): void {
  if (_started) return;
  _started = true;

  const schedule = () => {
    const delay = msUntilNextRun();
    _timer = setTimeout(() => {
      try { runRetention(log); } catch (e) { log.warn("[Retention] error:", e); }
      schedule();
    }, delay);
    log.info(`[Retention] Next run in ${(delay / 3_600_000).toFixed(1)}h`);
  };

  schedule();
}

export function stopRetention(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _started = false;
}
