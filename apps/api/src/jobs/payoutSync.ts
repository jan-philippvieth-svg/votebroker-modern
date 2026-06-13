/**
 * Payout Sync Job (A + C)
 * ========================
 * A) Rebuilds vb_vote_outcomes for all active users via get_account_history
 *    (curation_reward ops) → fills realized_sp / realized_at.
 * C) Cross-updates vb_global_vote_outcomes.realized_curation_sp from
 *    vb_vote_outcomes after rebuild, and fetches post_final_payout_sbd
 *    via get_content for posts that are > 7 days old.
 *
 * Runs daily at 04:00 UTC and once on startup (background, non-blocking).
 */

import { rebuildVoteOutcomes } from "../chain/rebuildVoteOutcomes.js";
import { enrichCurationEstimates } from "../chain/globalVoteOutcomes.js";
import { createSteemClient } from "../chain/steemBroadcaster.js";
import { getDb } from "../db/index.js";

const RUN_HOUR_UTC   = 4;
const RUN_MINUTE_UTC = 0;
const RATE_MS        = 120;

let _timer:   ReturnType<typeof setTimeout> | null = null;
let _running  = false;
let _started  = false;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export async function runPayoutSync(
  log: typeof console = console,
  opts: { chainScan?: boolean } = {},
): Promise<void> {
  if (_running) { log.info("[PayoutSync] Already running, skipping"); return; }
  _running = true;

  try {
    const db = getDb();

    // ── A) Rebuild vb_vote_outcomes for all voters (chain scan) ────────────
    // Skipped on startup runs — the Steem node is often overloaded outside
    // of the scheduled 04:00 UTC window. Only runs in the daily scheduled run.
    if (opts.chainScan !== false) {
      const users = db.prepare(
        "SELECT DISTINCT voter FROM vb_global_vote_outcomes ORDER BY voter"
      ).all() as Array<{ voter: string }>;

      log.info(`[PayoutSync] Rebuilding curation rewards for ${users.length} user(s)`);

      for (const { voter } of users) {
        try {
          const report = await rebuildVoteOutcomes(voter, log);
          log.info(`[PayoutSync] @${voter}: matched=${report.matched} pending=${report.pending}`);
        } catch (err) {
          log.warn({ err }, `[PayoutSync] rebuild failed for @${voter}`);
        }
      }
    } else {
      log.info("[PayoutSync] Skipping chain scan (startup run) — scheduled run handles it");
    }

    // ── A→C) Cross-update vb_global_vote_outcomes from vb_vote_outcomes ─────
    // realized_curation_sp
    db.prepare(`
      UPDATE vb_global_vote_outcomes
      SET realized_curation_sp = (
        SELECT vo.realized_sp
        FROM vb_vote_outcomes vo
        WHERE vo.username = vb_global_vote_outcomes.voter
          AND vo.author   = vb_global_vote_outcomes.author
          AND vo.permlink = vb_global_vote_outcomes.permlink
          AND vo.realized_sp IS NOT NULL
        LIMIT 1
      )
      WHERE realized_curation_sp IS NULL
        AND EXISTS (
          SELECT 1 FROM vb_vote_outcomes vo
          WHERE vo.username = vb_global_vote_outcomes.voter
            AND vo.author   = vb_global_vote_outcomes.author
            AND vo.permlink = vb_global_vote_outcomes.permlink
            AND vo.realized_sp IS NOT NULL
        )
    `).run();

    // realized_at
    db.prepare(`
      UPDATE vb_global_vote_outcomes
      SET realized_at = (
        SELECT vo.realized_at
        FROM vb_vote_outcomes vo
        WHERE vo.username = vb_global_vote_outcomes.voter
          AND vo.author   = vb_global_vote_outcomes.author
          AND vo.permlink = vb_global_vote_outcomes.permlink
          AND vo.realized_at IS NOT NULL
        LIMIT 1
      )
      WHERE realized_at IS NULL
        AND EXISTS (
          SELECT 1 FROM vb_vote_outcomes vo
          WHERE vo.username = vb_global_vote_outcomes.voter
            AND vo.author   = vb_global_vote_outcomes.author
            AND vo.permlink = vb_global_vote_outcomes.permlink
            AND vo.realized_at IS NOT NULL
        )
    `).run();

    const newlyRealized = (db.prepare(
      "SELECT COUNT(*) AS n FROM vb_global_vote_outcomes WHERE realized_curation_sp IS NOT NULL"
    ).get() as { n: number }).n;
    log.info(`[PayoutSync] Cross-update done — ${newlyRealized} rows now have realized_curation_sp`);

    // ── C) Fill post_final_payout_sbd for paid-out posts ────────────────────
    const unpaid = db.prepare(`
      SELECT DISTINCT author, permlink
      FROM vb_global_vote_outcomes
      WHERE voted_at < datetime('now', '-7 days')
        AND post_final_payout_sbd IS NULL
      ORDER BY voted_at ASC
      LIMIT 200
    `).all() as Array<{ author: string; permlink: string }>;

    log.info(`[PayoutSync] Fetching final payout for ${unpaid.length} posts`);

    const client = createSteemClient();
    const update = db.prepare(`
      UPDATE vb_global_vote_outcomes
      SET post_final_payout_sbd = ?
      WHERE author = ? AND permlink = ? AND post_final_payout_sbd IS NULL
    `);

    let finalUpdated = 0;
    for (const { author, permlink } of unpaid) {
      try {
        const post = await Promise.race([
          client.database.call("get_content", [author, permlink]),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("get_content timeout")), 8_000)),
        ]) as {
          author?:               string;
          total_payout_value?:   string;    // author payout (SBD) — non-zero after payout
          curator_payout_value?: string;    // curator payout (SP expressed as SBD) — non-zero after payout
          pending_payout_value?: string;    // pre-payout total — zero after payout
        };

        if (!post?.author) {
          update.run(0, author, permlink); // post deleted/not found — mark with 0
          finalUpdated++;
          continue;
        }

        const authorSbd   = parseFloat(String(post.total_payout_value   ?? "0").split(" ")[0]) || 0;
        const curatorSbd  = parseFloat(String(post.curator_payout_value ?? "0").split(" ")[0]) || 0;
        const pendingSbd  = parseFloat(String(post.pending_payout_value ?? "0").split(" ")[0]) || 0;

        // post_pending_payout_sbd at vote time = author + curator combined.
        // post_final_payout_sbd must use the same basis for a valid growth-factor comparison.
        // After payout: total_payout_value + curator_payout_value = full pool.
        // Before payout (still pending): skip — will be captured on next daily run.
        const hasPaidOut = authorSbd > 0 || curatorSbd > 0 || pendingSbd === 0;
        if (hasPaidOut) {
          const finalTotal = authorSbd + curatorSbd || null;
          update.run(finalTotal, author, permlink);
          finalUpdated++;
        }
      } catch { /* skip — will retry next run */ }

      await sleep(RATE_MS);
    }

    log.info(`[PayoutSync] post_final_payout_sbd set for ${finalUpdated} posts`);

    // ── D) Enrich curation estimates for model validation ─────────────────────
    // Runs after realized_curation_sp is cross-updated, so error metrics are
    // immediately computable for any newly realized vote.
    const voters = (db.prepare(
      "SELECT DISTINCT voter FROM vb_global_vote_outcomes ORDER BY voter"
    ).all() as Array<{ voter: string }>).map(r => r.voter);

    for (const voter of voters) {
      try {
        const result = await enrichCurationEstimates(voter, log);
        log.info(`[PayoutSync] estimates @${voter}: updated=${result.updated} skipped=${result.skipped}`);
      } catch (err) {
        log.warn({ err }, `[PayoutSync] enrichEstimates failed for @${voter}`);
      }
    }

    log.info("[PayoutSync] Done");
  } finally {
    _running = false;
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function msUntilNextRun(): number {
  const now  = new Date();
  const next = new Date(now);
  next.setUTCHours(RUN_HOUR_UTC, RUN_MINUTE_UTC, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export function startPayoutSync(log: typeof console = console): void {
  if (_started) return;
  _started = true;

  const schedule = () => {
    const delay = msUntilNextRun();
    _timer = setTimeout(async () => {
      try { await runPayoutSync(log); } catch (e) { log.warn({ err: e }, "[PayoutSync] error"); }
      schedule();
    }, delay);
    log.info(`[PayoutSync] Next run in ${(delay / 3_600_000).toFixed(1)}h`);
  };

  // Delay startup run by 120s — after Docker's health check start_period (90s).
  // The SQLite cross-update queries and Steem API calls in runPayoutSync block
  // the Node.js event loop; running them at startup would cause health check
  // failures. Scheduled 04:00 UTC run covers all data freshness requirements.
  setTimeout(() => {
    runPayoutSync(log, { chainScan: false }).catch(e => log.warn({ err: e }, "[PayoutSync] initial run error"));
  }, 120_000);
  schedule();
}

export function stopPayoutSync(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _started = false;
}
