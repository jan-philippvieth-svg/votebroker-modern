/**
 * Signal Layer Compute Job
 * =========================
 * Aggregates enriched vb_whale_vote_details into the Signal Layer tables:
 *   vb_signal_author    — payout quality, whale follow rate, optimal timing
 *   vb_signal_community — community-level yield and whale activity
 *
 * Runs nightly (02:30 UTC) and can be triggered manually via admin endpoint.
 * Requires enriched rows — skips if fewer than 50 enriched rows exist.
 */

import { getDb } from "../db/index.js";

const RUN_HOUR_UTC   = 2;
const RUN_MINUTE_UTC = 30;

// Minimum sample sizes before a metric is considered reliable enough to display/use.
// Show "zu wenig Daten" in UI when below these thresholds.
export const MIN_SP_PER_VP_SAMPLE  = 3;  // avg_sp_per_vp (from vb_global_vote_outcomes)
export const MIN_GROWTH_FACTOR_SAMPLE = 5; // avg_growth_factor — GF can be very volatile at n<5

let _timer: ReturnType<typeof setTimeout> | null = null;
let _started = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function optimalWindow(p25: number | null, p75: number | null): string {
  if (p25 === null || p75 === null) return "unbekannt";
  const mid = (p25 + p75) / 2;
  const spread = p75 - p25;
  if (spread > 300) return "variabel";     // >5h spread → no clear window
  if (mid < 30)     return "5-30min";
  if (mid < 120)    return "30-120min";
  if (mid < 360)    return "2-6h";
  return "6h+";
}

// ── Author signals ────────────────────────────────────────────────────────────

function computeAuthorSignals(log: typeof console): void {
  const db = getDb();

  // Fetch all enriched rows (in-memory for percentile computation)
  type Row = {
    author: string; whale: string; permlink: string;
    total_payout_sbd: number | null;
    curator_payout_sbd: number | null;
    vote_delay_min: number | null;
  };
  const rows = db.prepare(`
    SELECT author, whale, permlink, total_payout_sbd, curator_payout_sbd, vote_delay_min
    FROM vb_whale_vote_details
    WHERE enriched_at IS NOT NULL
  `).all() as Row[];

  if (rows.length < 50) {
    log.info("[SignalCompute] Not enough enriched rows yet (<50), skipping author signals");
    return;
  }

  // Group by author
  const byAuthor = new Map<string, {
    payouts:    number[];
    curators:   number[];
    delays:     number[];
    whales:     Set<string>;
    permlinks:  Set<string>;
  }>();

  for (const row of rows) {
    if (!byAuthor.has(row.author)) {
      byAuthor.set(row.author, { payouts: [], curators: [], delays: [], whales: new Set(), permlinks: new Set() });
    }
    const g = byAuthor.get(row.author)!;
    if (row.total_payout_sbd != null && row.total_payout_sbd > 0) g.payouts.push(row.total_payout_sbd);
    if (row.curator_payout_sbd != null && row.curator_payout_sbd > 0) g.curators.push(row.curator_payout_sbd);
    if (row.vote_delay_min != null && row.vote_delay_min >= 5 && row.vote_delay_min < 10080) {
      g.delays.push(row.vote_delay_min); // ≥5 min: sub-5-min votes give 0 curation reward
    }
    g.whales.add(row.whale);
    g.permlinks.add(row.permlink);
  }

  // Compute top whales per author from signal table
  type WhaleCount = { whale: string; cnt: number };
  const topWhalesByAuthor = new Map<string, string[]>();
  const whaleCounts = db.prepare(`
    SELECT author, whale, SUM(vote_count) as cnt
    FROM vb_whale_author_signals
    GROUP BY author, whale
    ORDER BY author, cnt DESC
  `).all() as Array<{ author: string; whale: string; cnt: number }>;

  for (const row of whaleCounts) {
    if (!topWhalesByAuthor.has(row.author)) topWhalesByAuthor.set(row.author, []);
    const arr = topWhalesByAuthor.get(row.author)!;
    if (arr.length < 3) arr.push(row.whale);
  }

  // Compute total distinct posts per author (for follow_rate denominator)
  const distinctPosts = db.prepare(`
    SELECT author, COUNT(DISTINCT permlink) as cnt
    FROM vb_whale_vote_details WHERE enriched_at IS NOT NULL
    GROUP BY author
  `).all() as Array<{ author: string; cnt: number }>;
  const postsPerAuthor = new Map(distinctPosts.map(r => [r.author, r.cnt]));

  // Upsert signal rows
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO vb_signal_author
      (author, avg_payout_sbd, median_payout_sbd, p75_payout_sbd, avg_curator_sbd,
       whale_count, whale_follow_rate, top_whales,
       p25_delay_min, p50_delay_min, p75_delay_min, optimal_window,
       sample_posts, data_days, computed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
  `);

  const now = Date.now();
  const insert = db.transaction(() => {
    for (const [author, g] of byAuthor) {
      if (g.permlinks.size < 2) continue; // need at least 2 posts for meaningful signal

      g.payouts.sort((a, b) => a - b);
      g.curators.sort((a, b) => a - b);
      g.delays.sort((a, b) => a - b);

      const avgPayout    = g.payouts.length > 0
        ? g.payouts.reduce((s, v) => s + v, 0) / g.payouts.length : null;
      const medPayout    = percentile(g.payouts, 0.5);
      const p75Payout    = percentile(g.payouts, 0.75);
      const avgCurator   = g.curators.length > 0
        ? g.curators.reduce((s, v) => s + v, 0) / g.curators.length : null;

      const p25Delay = percentile(g.delays, 0.25);
      const p50Delay = percentile(g.delays, 0.5);
      const p75Delay = percentile(g.delays, 0.75);
      const window   = optimalWindow(p25Delay, p75Delay);

      const totalPosts   = postsPerAuthor.get(author) ?? g.permlinks.size;
      // whale_follow_rate: fraction of posts where ≥1 whale voted (proxy: posts with delay data)
      const followRate   = g.permlinks.size / totalPosts;

      const topWhalesArr = topWhalesByAuthor.get(author) ?? [...g.whales].slice(0, 3);

      // Estimate data window in days from oldest to newest delay data
      const dataDays = 90; // conservative; actual range from voted_at would need another query

      upsert.run(
        author,
        avgPayout    !== null ? Math.round(avgPayout    * 1000) / 1000 : null,
        medPayout    !== null ? Math.round(medPayout    * 1000) / 1000 : null,
        p75Payout    !== null ? Math.round(p75Payout    * 1000) / 1000 : null,
        avgCurator   !== null ? Math.round(avgCurator   * 1000) / 1000 : null,
        g.whales.size,
        Math.round(followRate * 1000) / 1000,
        JSON.stringify(topWhalesArr),
        p25Delay !== null ? Math.round(p25Delay * 10) / 10 : null,
        p50Delay !== null ? Math.round(p50Delay * 10) / 10 : null,
        p75Delay !== null ? Math.round(p75Delay * 10) / 10 : null,
        window,
        g.permlinks.size,
        dataDays,
      );
    }
  });

  insert();

  // Enrich with Growth Factor from vb_global_vote_outcomes (post-level metric, voter-independent)
  // GF = post_final_payout_sbd / post_pending_payout_sbd — measures post growth after vote
  // r(log_gf, sp_per_vp) = 0.868 (ADR-005) — strongest predictor we have
  const gfRows = db.prepare(`
    SELECT author,
           AVG(post_final_payout_sbd / post_pending_payout_sbd) as avg_gf,
           COUNT(*) as n
    FROM vb_global_vote_outcomes
    WHERE post_pending_payout_sbd > 0.01
      AND post_final_payout_sbd IS NOT NULL
      AND post_final_payout_sbd / post_pending_payout_sbd BETWEEN 0.1 AND 100
    GROUP BY author
    HAVING COUNT(*) >= 3
  `).all() as Array<{ author: string; avg_gf: number; n: number }>;

  if (gfRows.length > 0) {
    const updateGf = db.prepare(`
      UPDATE vb_signal_author
      SET avg_growth_factor = ?, gf_sample_n = ?
      WHERE author = ?
    `);
    db.transaction(() => {
      for (const r of gfRows) {
        updateGf.run(Math.round(r.avg_gf * 100) / 100, r.n, r.author);
      }
    })();
    log.info(`[SignalCompute] Growth factor enriched for ${gfRows.length} authors`);
  }

  log.info(`[SignalCompute] Author signals: ${byAuthor.size} authors processed`);
}

// ── Community signals ─────────────────────────────────────────────────────────

function computeCommunitySignals(log: typeof console): void {
  const db = getDb();

  type Row = {
    community: string;
    total_payout_sbd: number | null;
    curator_payout_sbd: number | null;
    permlink: string;
    whale_count: number;
  };

  // CTE pre-aggregates whale_count per post — avoids correlated subquery
  // that would execute 13k+ times against a 450k-row table and block the event loop.
  const rows = db.prepare(`
    WITH whale_counts AS (
      SELECT author, permlink, COUNT(DISTINCT whale) AS whale_count
      FROM vb_whale_vote_details
      GROUP BY author, permlink
    )
    SELECT
      d.post_community    AS community,
      d.total_payout_sbd,
      d.curator_payout_sbd,
      d.permlink,
      COALESCE(wc.whale_count, 0) AS whale_count
    FROM vb_whale_vote_details d
    LEFT JOIN whale_counts wc ON wc.author = d.author AND wc.permlink = d.permlink
    WHERE d.enriched_at IS NOT NULL
      AND d.post_community IS NOT NULL
      AND d.post_community != ''
  `).all() as Row[];

  if (rows.length === 0) return;

  // Group by community
  const byCommunity = new Map<string, {
    payouts:   number[];
    curators:  number[];
    whaleCounts: number[];
    posts:     Set<string>;
  }>();

  for (const row of rows) {
    const c = row.community;
    if (!byCommunity.has(c)) {
      byCommunity.set(c, { payouts: [], curators: [], whaleCounts: [], posts: new Set() });
    }
    const g = byCommunity.get(c)!;
    g.posts.add(row.permlink);
    if (row.total_payout_sbd != null && row.total_payout_sbd >= 0) g.payouts.push(row.total_payout_sbd);
    if (row.curator_payout_sbd != null && row.curator_payout_sbd >= 0) g.curators.push(row.curator_payout_sbd);
    g.whaleCounts.push(row.whale_count);
  }

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO vb_signal_community
      (community, avg_payout_sbd, median_payout_sbd, avg_curator_sbd, whale_activity, posts_sampled, computed_at)
    VALUES (?,?,?,?,?,?,datetime('now'))
  `);

  db.transaction(() => {
    for (const [community, g] of byCommunity) {
      if (g.posts.size < 3) continue;
      g.payouts.sort((a, b) => a - b);

      const avg    = g.payouts.length > 0 ? g.payouts.reduce((s, v) => s + v, 0) / g.payouts.length : null;
      const med    = percentile(g.payouts, 0.5);
      const avgCur = g.curators.length > 0 ? g.curators.reduce((s, v) => s + v, 0) / g.curators.length : null;
      const whaleAct = g.whaleCounts.reduce((s, v) => s + v, 0) / g.whaleCounts.length;

      upsert.run(
        community,
        avg    !== null ? Math.round(avg    * 1000) / 1000 : null,
        med    !== null ? Math.round(med    * 1000) / 1000 : null,
        avgCur !== null ? Math.round(avgCur * 1000) / 1000 : null,
        Math.round(whaleAct * 100) / 100,
        g.posts.size,
      );
    }
  })();

  log.info(`[SignalCompute] Community signals: ${byCommunity.size} communities processed`);
}

// ── Main entry ────────────────────────────────────────────────────────────────

export async function runSignalCompute(log: typeof console = console): Promise<void> {
  log.info("[SignalCompute] Starting signal layer computation");
  computeAuthorSignals(log);
  computeCommunitySignals(log);
  log.info("[SignalCompute] Done");
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function msUntilNextRun(): number {
  const now  = new Date();
  const next = new Date(now);
  next.setUTCHours(RUN_HOUR_UTC, RUN_MINUTE_UTC, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export function startSignalCompute(log: typeof console = console): void {
  if (_started) return;
  _started = true;

  const schedule = () => {
    const delay = msUntilNextRun();
    _timer = setTimeout(async () => {
      try { await runSignalCompute(log); } catch (e) { log.warn("[SignalCompute] error:", e); }
      schedule();
    }, delay);
    log.info(`[SignalCompute] Next run in ${(delay / 3_600_000).toFixed(1)}h`);
  };

  // No immediate startup run — this is a nightly analytics job (02:30 UTC).
  // Running it on startup would block the event loop with a full table scan
  // against vb_whale_vote_details (450k+ rows) right as the server comes up.
  schedule();
}

export function stopSignalCompute(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _started = false;
}
