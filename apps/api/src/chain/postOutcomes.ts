/**
 * Canonical Post-Outcome layer (Refactoring Phase 1)
 * ==================================================
 * One row per POST — keyed (author, permlink) — describing only properties of the
 * post itself: when it was created, its community, the final payout, vote counts,
 * and when it settled. This is deliberately independent of:
 *   - WHO voted and what they earned  → vote-outcome (vb_vote_outcomes)
 *   - what a model PREDICTED          → model-prediction (Phase 2, vb_model_predictions)
 *
 * Phase 1 is strictly additive:
 *   - vb_global_vote_outcomes, vb_copilot_shadow_runs, vb_whale_vote_details and all
 *     their columns stay unchanged; existing readers are untouched.
 *   - The vote-broadcast pipeline (recordVoteAtBroadcast) is NOT modified.
 *   - The table is backfilled once from vb_global_vote_outcomes with NO chain re-scan,
 *     then kept fresh by the existing enrichment jobs that already resolve these facts.
 *
 * See docs/decisions/ADR-006 / the 2026-06-22 devlog for the Phase 2/3 separation plan.
 */

import { getDb } from "../db/index.js";

type Db = ReturnType<typeof getDb>;

/** A partial post-outcome — only the fields a given resolver knows about. */
export interface PostOutcomePatch {
  author: string;
  permlink: string;
  postCreatedAt?: string | null;
  community?: string | null;
  finalPayout?: number | null;
  netVotes?: number | null;
  activeVotes?: number | null;
  paidAt?: string | null;
}

/**
 * Canonical writer. Merge-upsert one post outcome.
 *
 * Merge semantics:
 *   - Stable identity fields (post_created_at, community, paid_at, resolved_at) keep
 *     their first known value (COALESCE existing first) — they never flip.
 *   - Resolved/measured fields (final_payout, net_votes, active_votes) take the newest
 *     non-null value (COALESCE excluded first).
 *   - resolved_at is stamped the first time a non-null final_payout is recorded.
 *
 * Safe to call from any resolver/enrichment job. Never throws on a missing column
 * because the table is created in db migrations before any job runs.
 */
export function upsertPostOutcome(db: Db, p: PostOutcomePatch): void {
  const resolvedAt = p.finalPayout != null ? new Date().toISOString() : null;
  db.prepare(`
    INSERT INTO vb_post_outcomes
      (author, permlink, post_created_at, community, final_payout,
       net_votes, active_votes, paid_at, resolved_at, recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(author, permlink) DO UPDATE SET
      post_created_at = COALESCE(vb_post_outcomes.post_created_at, excluded.post_created_at),
      community       = COALESCE(vb_post_outcomes.community,       excluded.community),
      final_payout    = COALESCE(excluded.final_payout, vb_post_outcomes.final_payout),
      net_votes       = COALESCE(excluded.net_votes,    vb_post_outcomes.net_votes),
      active_votes    = COALESCE(excluded.active_votes, vb_post_outcomes.active_votes),
      paid_at         = COALESCE(vb_post_outcomes.paid_at,     excluded.paid_at),
      resolved_at     = COALESCE(vb_post_outcomes.resolved_at, excluded.resolved_at),
      recorded_at     = datetime('now')
  `).run(
    p.author, p.permlink,
    p.postCreatedAt ?? null,
    p.community ?? null,
    p.finalPayout ?? null,
    p.netVotes ?? null,
    p.activeVotes ?? null,
    p.paidAt ?? null,
    resolvedAt,
  );
}

/**
 * One-time backfill + ongoing reconciliation from vb_global_vote_outcomes.
 *
 * Collapses the per-voter gvo rows into one canonical row per (author, permlink).
 * Pure SQL, no blockchain calls. Idempotent: re-running only fills gaps and refreshes
 * resolved values via the same merge semantics as upsertPostOutcome, so it is safe to
 * run at startup and after every enrichment cycle.
 *
 * Returns the number of canonical post rows after the merge.
 */
export function syncPostOutcomesFromGvo(db: Db, log: typeof console = console): { rows: number } {
  db.prepare(`
    INSERT INTO vb_post_outcomes
      (author, permlink, post_created_at, community, final_payout,
       net_votes, active_votes, paid_at, resolved_at, recorded_at)
    SELECT
      author,
      permlink,
      MAX(post_created_at),
      MAX(post_community),
      MAX(post_final_payout_sbd),
      MAX(post_net_votes),
      MAX(post_active_votes_count),
      MAX(realized_at),
      CASE WHEN MAX(post_final_payout_sbd) IS NOT NULL THEN datetime('now') END,
      datetime('now')
    FROM vb_global_vote_outcomes
    GROUP BY author, permlink
    ON CONFLICT(author, permlink) DO UPDATE SET
      post_created_at = COALESCE(vb_post_outcomes.post_created_at, excluded.post_created_at),
      community       = COALESCE(vb_post_outcomes.community,       excluded.community),
      final_payout    = COALESCE(excluded.final_payout, vb_post_outcomes.final_payout),
      net_votes       = COALESCE(excluded.net_votes,    vb_post_outcomes.net_votes),
      active_votes    = COALESCE(excluded.active_votes, vb_post_outcomes.active_votes),
      paid_at         = COALESCE(vb_post_outcomes.paid_at,     excluded.paid_at),
      resolved_at     = COALESCE(vb_post_outcomes.resolved_at, excluded.resolved_at),
      recorded_at     = datetime('now')
  `).run();

  const rows = (db.prepare("SELECT COUNT(*) AS n FROM vb_post_outcomes").get() as { n: number }).n;
  log.info(`[PostOutcomes] synced from vb_global_vote_outcomes — ${rows} canonical post rows`);
  return { rows };
}
