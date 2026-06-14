/**
 * Opportunity Refresh Job
 * ========================
 * Every 30 minutes: fetches recent posts from top whale-signal authors,
 * scores each with OpportunityScore v2, stores top 50 in vb_opportunity_cache.
 *
 * Cache is user-agnostic (category='normal' for discovery component).
 * The /api/opportunities/top endpoint enriches per-user (in_strategy, already_voted).
 */

import { getDb }                             from "../db/index.js";
import { fetchRecentPostsWithVotes }          from "../chain/recentPosts.js";
import { calcOpportunityScore, OPPORTUNITY_GATE } from "../chain/opportunityScore.js";
import { MIN_GROWTH_FACTOR_SAMPLE }           from "./signalCompute.js";

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;  // 30 minutes
const SOURCE_AUTHORS       = 80;               // top N whale-signal authors to scan
const MIN_WHALE_COUNT      = 2;               // minimum whale_count to be included
const POSTS_PER_AUTHOR     = 5;
const CACHE_TOP_N          = 50;              // store top N in cache
const FETCH_CONCURRENCY    = 10;

let _timer: ReturnType<typeof setTimeout> | null = null;
let _started = false;
let _running  = false;

// ── Author signal helpers ─────────────────────────────────────────────────────

function getTopWhaleAuthors(): Array<{ author: string; whale_count: number; avg_growth_factor: number | null; gf_sample_n: number | null }> {
  return getDb().prepare(`
    SELECT author, whale_count, avg_growth_factor, gf_sample_n
    FROM vb_signal_author
    WHERE whale_count >= ?
    ORDER BY whale_count DESC
    LIMIT ?
  `).all(MIN_WHALE_COUNT, SOURCE_AUTHORS) as Array<{ author: string; whale_count: number; avg_growth_factor: number | null; gf_sample_n: number | null }>;
}

// ── Main refresh ──────────────────────────────────────────────────────────────

export async function runOpportunityRefresh(log: typeof console = console): Promise<{ cached: number; scanned: number }> {
  if (_running) {
    log.info("[OpportunityRefresh] Already running, skipping");
    return { cached: 0, scanned: 0 };
  }
  _running = true;

  try {
    const db = getDb();
    const authors = getTopWhaleAuthors();

    if (authors.length === 0) {
      log.info("[OpportunityRefresh] No whale-signal authors found, skipping");
      return { cached: 0, scanned: 0 };
    }

    log.info(`[OpportunityRefresh] Scanning ${authors.length} authors…`);

    const authorMap = new Map(authors.map(a => [a.author, a]));

    // Fetch recent posts in batches
    const scored: Array<{
      author: string; permlink: string; title: string;
      age_minutes: number; remaining_hours: number;
      pending_payout_sbd: number; community: string | null;
      whale_count: number; author_avg_gf: number | null; author_gf_sample_n: number;
      score: number;
      score_payout: number; score_timing: number; score_signal: number;
      score_discovery: number; score_author: number;
    }> = [];

    let scanned = 0;

    for (let i = 0; i < authors.length; i += FETCH_CONCURRENCY) {
      const batch   = authors.slice(i, i + FETCH_CONCURRENCY);
      // "_dummy_" voter: we don't have a real user here; alreadyVoted will always be false
      const results = await Promise.allSettled(
        batch.map(a => fetchRecentPostsWithVotes(a.author, "_dummy_", POSTS_PER_AUTHOR))
      );

      for (let j = 0; j < results.length; j++) {
        const res    = results[j];
        const author = batch[j];

        if (res.status !== "fulfilled") continue;
        const posts = res.value;
        scanned += posts.length;

        for (const post of posts) {
          // Only eligible, non-expired posts within the payout window
          if (post.remainingHours <= 0 || post.ageMinutes < 5) continue;

          const reliableGf = (author.gf_sample_n ?? 0) >= MIN_GROWTH_FACTOR_SAMPLE
            ? (author.avg_growth_factor ?? undefined) : undefined;

          const result = calcOpportunityScore({
            ageMinutes:        post.ageMinutes,
            remainingHours:    post.remainingHours,
            category:          "normal",          // user-agnostic default
            pendingPayoutSbd:  post.pendingPayoutSbd,
            whaleCount:        author.whale_count,
            authorAvgSpPerVp:  reliableGf != null ? reliableGf / 10 : undefined,  // rough proxy
            isSelfPost:        false,
          });

          if (result.score < OPPORTUNITY_GATE) continue;

          scored.push({
            author:            post.author,
            permlink:          post.permlink,
            title:             post.title,
            age_minutes:       post.ageMinutes,
            remaining_hours:   post.remainingHours,
            pending_payout_sbd: post.pendingPayoutSbd,
            community:         post.community,
            whale_count:       author.whale_count,
            author_avg_gf:     (author.gf_sample_n ?? 0) >= MIN_GROWTH_FACTOR_SAMPLE ? (author.avg_growth_factor ?? null) : null,
            author_gf_sample_n: author.gf_sample_n ?? 0,
            score:             result.score,
            score_payout:      result.components.payoutSweetspot,
            score_timing:      result.components.timing,
            score_signal:      result.components.signalCurators,
            score_discovery:   result.components.discovery,
            score_author:      result.components.authorHistory,
          });
        }
      }
    }

    // Keep top CACHE_TOP_N by score
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, CACHE_TOP_N);

    // Replace cache atomically
    const now = new Date().toISOString();
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO vb_opportunity_cache
        (author, permlink, title, age_minutes, remaining_hours, pending_payout_sbd,
         community, whale_count, author_avg_gf, author_gf_sample_n,
         opportunity_score, score_payout, score_timing, score_signal, score_discovery, score_author,
         cached_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    db.transaction(() => {
      // Clear stale entries older than 2 hours before inserting fresh ones
      db.prepare("DELETE FROM vb_opportunity_cache WHERE cached_at < datetime('now', '-2 hours')").run();
      for (const e of top) {
        upsert.run(
          e.author, e.permlink, e.title,
          e.age_minutes, e.remaining_hours, e.pending_payout_sbd,
          e.community, e.whale_count,
          e.author_avg_gf, e.author_gf_sample_n,
          e.score, e.score_payout, e.score_timing, e.score_signal, e.score_discovery, e.score_author,
          now,
        );
      }
    })();

    log.info(`[OpportunityRefresh] scanned=${scanned} scored=${scored.length} cached=${top.length}`);
    return { cached: top.length, scanned };

  } finally {
    _running = false;
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export function startOpportunityRefresh(log: typeof console = console): void {
  if (_started) return;
  _started = true;

  const schedule = () => {
    _timer = setTimeout(async () => {
      try { await runOpportunityRefresh(log); } catch (e) { log.warn("[OpportunityRefresh] error:", e); }
      schedule();
    }, REFRESH_INTERVAL_MS);
  };

  // Run immediately on startup (delayed via server.ts setTimeout)
  runOpportunityRefresh(log).catch(e => log.warn("[OpportunityRefresh] startup error:", e));
  schedule();
  log.info(`[OpportunityRefresh] Started — interval ${REFRESH_INTERVAL_MS / 60_000} min`);
}

export function stopOpportunityRefresh(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _started = false;
}
