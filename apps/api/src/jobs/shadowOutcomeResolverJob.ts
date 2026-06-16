/**
 * Shadow Outcome Resolver Job
 *
 * Runs daily at 06:00 UTC. For each shadow-run row (would_vote / skip_score /
 * skip_budget) where the 7-day payout window has closed, fetches the final
 * post state via get_content and writes back the resolved payout, vote counts,
 * and an outcome_status so the confusion matrix can be computed.
 *
 * outcome_status values:
 *   unresolved       — not yet processed (default)
 *   resolved         — get_content succeeded and payout is written
 *   content_missing  — post returned no author (deleted / not found)
 *   error            — network / timeout error — will retry on next run
 */

import { createSteemClient } from "../chain/steemBroadcaster.js";
import { getDb } from "../db/index.js";

const RUN_HOUR_UTC   = 6;
const RUN_MINUTE_UTC = 0;
const RATE_MS        = 150;
const BATCH_LIMIT    = 300;
// Require 7 days + 12 hours to be safely past payout
const MIN_AGE_HOURS  = 7 * 24 + 12;

let _timer:   ReturnType<typeof setTimeout> | null = null;
let _running  = false;
let _started  = false;

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ── Core resolver ─────────────────────────────────────────────────────────────

export async function runShadowOutcomeResolver(log: typeof console = console): Promise<void> {
  if (_running) { log.info("[ShadowResolver] Already running, skipping"); return; }
  _running = true;

  try {
    const db     = getDb();
    const client = createSteemClient();

    // Fetch unresolved rows that are old enough (7.5 days), limit one per unique post
    const unresolved = db.prepare(`
      SELECT DISTINCT author, permlink
      FROM vb_copilot_shadow_runs
      WHERE outcome_status = 'unresolved'
        AND decision IN ('would_vote', 'skip_score', 'skip_budget')
        AND author IS NOT NULL
        AND permlink IS NOT NULL
        AND run_at < datetime('now', '-${MIN_AGE_HOURS} hours')
      ORDER BY run_at ASC
      LIMIT ${BATCH_LIMIT}
    `).all() as Array<{ author: string; permlink: string }>;

    log.info(`[ShadowResolver] ${unresolved.length} unique posts to resolve`);
    if (unresolved.length === 0) return;

    const updateResolved = db.prepare(`
      UPDATE vb_copilot_shadow_runs
      SET outcome_status              = 'resolved',
          resolved_payout_sbd        = @payout,
          resolved_vote_count        = @voteCount,
          resolved_active_votes_count = @activeVoteCount,
          resolved_at                = @resolvedAt
      WHERE author = @author AND permlink = @permlink
        AND outcome_status = 'unresolved'
    `);

    const updateMissing = db.prepare(`
      UPDATE vb_copilot_shadow_runs
      SET outcome_status = 'content_missing', resolved_at = @resolvedAt
      WHERE author = @author AND permlink = @permlink
        AND outcome_status = 'unresolved'
    `);

    const updateError = db.prepare(`
      UPDATE vb_copilot_shadow_runs
      SET outcome_status = 'error', resolved_at = @resolvedAt
      WHERE author = @author AND permlink = @permlink
        AND outcome_status = 'unresolved'
    `);

    let resolved = 0, missing = 0, errors = 0;

    for (const { author, permlink } of unresolved) {
      const resolvedAt = new Date().toISOString();

      try {
        const post = await Promise.race([
          client.database.call("get_content", [author, permlink]),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8_000)),
        ]) as {
          author?:               string;
          total_payout_value?:   string;   // non-zero after settlement
          curator_payout_value?: string;
          pending_payout_value?: string;
          net_votes?:            number;
          active_votes?:         unknown[];
        };

        if (!post?.author) {
          updateMissing.run({ author, permlink, resolvedAt });
          missing++;
        } else {
          const authorSbd  = parseFloat(String(post.total_payout_value   ?? "0").split(" ")[0]) || 0;
          const curatorSbd = parseFloat(String(post.curator_payout_value ?? "0").split(" ")[0]) || 0;
          const pendingSbd = parseFloat(String(post.pending_payout_value ?? "0").split(" ")[0]) || 0;

          // After payout: author + curator = full pool; pending = 0
          // If still pending (edge case): use pending as best estimate
          const payout = (authorSbd + curatorSbd) > 0
            ? authorSbd + curatorSbd
            : pendingSbd;

          updateResolved.run({
            author,
            permlink,
            payout,
            voteCount:       post.net_votes ?? null,
            activeVoteCount: post.active_votes?.length ?? null,
            resolvedAt,
          });
          resolved++;
        }
      } catch {
        updateError.run({ author, permlink, resolvedAt });
        errors++;
      }

      await sleep(RATE_MS);
    }

    log.info(
      `[ShadowResolver] Done — resolved=${resolved} missing=${missing} errors=${errors} ` +
      `(errors will retry next daily run)`
    );
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

export function startShadowOutcomeResolver(log: typeof console = console): void {
  if (_started) return;
  _started = true;

  function schedule(): void {
    const delay = msUntilNextRun();
    log.info(`[ShadowResolver] Next run in ${Math.round(delay / 60_000)} min (${RUN_HOUR_UTC}:${String(RUN_MINUTE_UTC).padStart(2,"0")} UTC)`);
    _timer = setTimeout(async () => {
      try { await runShadowOutcomeResolver(log); } catch (err) { log.warn("[ShadowResolver] run error:", err); }
      schedule();
    }, delay);
  }

  // Run once on startup (background, delayed — the resolver is cheap but we
  // don't want it competing with payoutSync's 04:00 chain scan)
  setTimeout(() => {
    runShadowOutcomeResolver(log).catch(err => log.warn("[ShadowResolver] startup run error:", err));
    schedule();
  }, 15_000);

  log.info("[ShadowResolver] Started — resolves shadow outcomes daily at 06:00 UTC");
}

export function stopShadowOutcomeResolver(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _started = false;
}
