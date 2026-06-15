/**
 * Opportunity Refresh Job
 * ========================
 * Every 30 minutes: queries vb_whale_vote_details for posts whales are actively
 * voting RIGHT NOW, calls get_content for live state (age, payout, title),
 * scores with OpportunityScore v2, and stores top 50 in vb_opportunity_cache.
 *
 * Source: real per-post whale_count from blockchain activity (not historical author aggregate).
 * Cache is user-agnostic (category='normal'). The /api/opportunities/top endpoint
 * enriches per-user (in_strategy, already_voted) at query time.
 */

import { getDb }                             from "../db/index.js";
import { createSteemClient }                 from "../chain/steemBroadcaster.js";
import { calcOpportunityScore, OPPORTUNITY_GATE } from "../chain/opportunityScore.js";
import { MIN_GROWTH_FACTOR_SAMPLE }           from "./signalCompute.js";

const REFRESH_INTERVAL_MS     = 30 * 60 * 1000;
const SOURCE_POSTS             = 200;  // candidate posts from vb_whale_vote_details
const MIN_WHALE_COUNT_PER_POST = 2;   // minimum distinct whale votes per post
const VOTE_WINDOW_DAYS         = 5;   // look back N days for whale votes
const CACHE_TOP_N              = 50;  // store top N in cache
const FETCH_CONCURRENCY        = 10;  // parallel get_content calls

let _timer: ReturnType<typeof setTimeout> | null = null;
let _started = false;
let _running  = false;

// ── DB helpers ────────────────────────────────────────────────────────────────

interface WhalePost {
  author:          string;
  permlink:        string;
  whale_count:     number;
  last_whale_vote: string;
}

interface AuthorSignal {
  avg_growth_factor: number | null;
  gf_sample_n:       number | null;
  avg_sp_per_vp:     number | null;
}

function getWhaleActivePosts(): WhalePost[] {
  return getDb().prepare(`
    SELECT
      author, permlink,
      COUNT(DISTINCT whale) AS whale_count,
      MAX(voted_at)         AS last_whale_vote
    FROM vb_whale_vote_details
    WHERE voted_at >= datetime('now', '-${VOTE_WINDOW_DAYS} days')
    GROUP BY author, permlink
    HAVING COUNT(DISTINCT whale) >= ?
    ORDER BY last_whale_vote DESC, whale_count DESC
    LIMIT ?
  `).all(MIN_WHALE_COUNT_PER_POST, SOURCE_POSTS) as WhalePost[];
}

function getAuthorSignals(authors: string[]): Map<string, AuthorSignal> {
  if (authors.length === 0) return new Map();
  const placeholders = authors.map(() => "?").join(",");
  const rows = getDb().prepare(`
    SELECT author, avg_growth_factor, gf_sample_n, avg_sp_per_vp
    FROM vb_signal_author
    WHERE author IN (${placeholders})
  `).all(...authors) as Array<{ author: string } & AuthorSignal>;

  const map = new Map<string, AuthorSignal>();
  for (const r of rows) {
    map.set(r.author, {
      avg_growth_factor: r.avg_growth_factor,
      gf_sample_n:       r.gf_sample_n,
      avg_sp_per_vp:     r.avg_sp_per_vp,
    });
  }
  return map;
}

// ── Chain call ────────────────────────────────────────────────────────────────

interface PostContent {
  title:                string;
  created:              string;
  pending_payout_value: string;
  community:            string | null;
}

function parseSbd(val: string | null | undefined): number {
  if (!val) return 0;
  return parseFloat(String(val).split(" ")[0]) || 0;
}

function toUtcMs(iso: string): number {
  return new Date(iso.endsWith("Z") ? iso : iso + "Z").getTime();
}

async function fetchPostContent(
  client: ReturnType<typeof createSteemClient>,
  author: string,
  permlink: string,
): Promise<PostContent | null> {
  try {
    const post = await client.database.call("get_content", [author, permlink]) as {
      title:                string;
      created:              string;
      pending_payout_value: string;
      category:             string;
      id:                   number;
    };
    if (!post || !post.created || post.id === 0) return null;
    return {
      title:                post.title,
      created:              post.created,
      pending_payout_value: post.pending_payout_value,
      community:            post.category ?? null,
    };
  } catch {
    return null;
  }
}

// ── Main refresh ──────────────────────────────────────────────────────────────

export async function runOpportunityRefresh(log: typeof console = console): Promise<{ cached: number; scanned: number }> {
  if (_running) {
    log.info("[OpportunityRefresh] Already running, skipping");
    return { cached: 0, scanned: 0 };
  }
  _running = true;

  try {
    const db     = getDb();
    const client = createSteemClient();
    const posts  = getWhaleActivePosts();

    if (posts.length === 0) {
      log.info("[OpportunityRefresh] No whale-active posts found, skipping");
      return { cached: 0, scanned: 0 };
    }

    log.info(`[OpportunityRefresh] ${posts.length} whale-active posts to evaluate…`);

    // Prefetch author GF + sp_per_vp signals for all unique authors
    const uniqueAuthors = [...new Set(posts.map(p => p.author))];
    const authorSignals = getAuthorSignals(uniqueAuthors);

    const now           = Date.now();
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    const scored: Array<{
      author: string; permlink: string; title: string;
      age_minutes: number; remaining_hours: number;
      pending_payout_sbd: number; community: string | null;
      whale_count: number;
      author_avg_gf: number | null; author_gf_sample_n: number;
      score: number;
      score_payout: number; score_timing: number; score_signal: number;
      score_discovery: number; score_author: number;
    }> = [];

    let scanned = 0;

    for (let i = 0; i < posts.length; i += FETCH_CONCURRENCY) {
      const batch   = posts.slice(i, i + FETCH_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(p => fetchPostContent(client, p.author, p.permlink))
      );

      for (let j = 0; j < results.length; j++) {
        const res  = results[j];
        const post = batch[j];
        scanned++;

        if (res.status !== "fulfilled" || !res.value) continue;
        const content = res.value;

        const createdMs      = toUtcMs(content.created);
        const ageMinutes     = (now - createdMs) / 60_000;
        const remainingHours = Math.max(0, (SEVEN_DAYS_MS - (now - createdMs)) / 3_600_000);

        // Hard filters: expired or curation window not yet open
        if (remainingHours <= 0 || ageMinutes < 5) continue;

        const pendingPayoutSbd = parseSbd(content.pending_payout_value);
        const signal           = authorSignals.get(post.author);

        // Author GF — display only, requires n >= MIN_GROWTH_FACTOR_SAMPLE
        const gfSampleN   = signal?.gf_sample_n ?? 0;
        const authorAvgGf = gfSampleN >= MIN_GROWTH_FACTOR_SAMPLE
          ? (signal?.avg_growth_factor ?? null) : null;

        // Author sp_per_vp — for authorHistory score component; use gf_sample_n >= 3 as confidence gate
        const authorSpPerVp = gfSampleN >= 3 ? (signal?.avg_sp_per_vp ?? undefined) : undefined;

        const result = calcOpportunityScore({
          ageMinutes,
          remainingHours,
          category:         "normal",         // user-agnostic; enriched per-user at query time
          pendingPayoutSbd,
          whaleCount:       post.whale_count, // real per-post whale count from blockchain
          authorAvgSpPerVp: authorSpPerVp,
          isSelfPost:       false,
        });

        if (result.score < OPPORTUNITY_GATE) continue;

        scored.push({
          author:             post.author,
          permlink:           post.permlink,
          title:              content.title,
          age_minutes:        ageMinutes,
          remaining_hours:    remainingHours,
          pending_payout_sbd: pendingPayoutSbd,
          community:          content.community,
          whale_count:        post.whale_count,
          author_avg_gf:      authorAvgGf,
          author_gf_sample_n: gfSampleN,
          score:              result.score,
          score_payout:       result.components.payoutSweetspot,
          score_timing:       result.components.timing,
          score_signal:       result.components.signalCurators,
          score_discovery:    result.components.discovery,
          score_author:       result.components.authorHistory,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, CACHE_TOP_N);

    const nowIso = new Date().toISOString();
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO vb_opportunity_cache
        (author, permlink, title, age_minutes, remaining_hours, pending_payout_sbd,
         community, whale_count, author_avg_gf, author_gf_sample_n,
         opportunity_score, score_payout, score_timing, score_signal, score_discovery, score_author,
         cached_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    db.transaction(() => {
      db.prepare("DELETE FROM vb_opportunity_cache WHERE cached_at < datetime('now', '-2 hours')").run();
      for (const e of top) {
        upsert.run(
          e.author, e.permlink, e.title,
          e.age_minutes, e.remaining_hours, e.pending_payout_sbd,
          e.community, e.whale_count,
          e.author_avg_gf, e.author_gf_sample_n,
          e.score, e.score_payout, e.score_timing, e.score_signal, e.score_discovery, e.score_author,
          nowIso,
        );
      }
    })();

    log.info(`[OpportunityRefresh] scanned=${scanned} above-gate=${scored.length} cached=${top.length}`);
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

  runOpportunityRefresh(log).catch(e => log.warn("[OpportunityRefresh] startup error:", e));
  schedule();
  log.info(`[OpportunityRefresh] Started — interval ${REFRESH_INTERVAL_MS / 60_000} min`);
}

export function stopOpportunityRefresh(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _started = false;
}
