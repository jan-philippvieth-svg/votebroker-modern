/**
 * Whale Signal Discovery
 * ======================
 * Discovers which authors are regularly voted by high-value curators ("whales").
 * Results cached in SQLite — never fetched live on page load.
 *
 * Approach: scan multiple post feeds (trending/hot/created) and extract
 * whale appearances from active_votes. This avoids scanning witness account
 * histories (which are flooded with producer_reward ops).
 *
 * Long-term goal: auto-discover the whale list from the data itself —
 * accounts that appear frequently with high rshares on successful posts.
 */

import { createSteemClient } from "./steemBroadcaster.js";
import { getDb } from "../db/index.js";

// ── Config ────────────────────────────────────────────────────────────────────

// Seed list of known active curation whales.
// Criteria: high vote value, diverse curated authors, not exchanges/bots/services.
// This list grows automatically via discoverTopVoters().
export const SEED_WHALES = [
  "steemchiller",
  "realrobinhood",
  "germansailor",
  "michelangelo3",
];

const POSTS_PER_FEED = 100;
const MIN_RSHARES_FOR_WHALE = 5_000_000_000; // ~$0.10+ vote to qualify as signal

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WhaleSignal {
  author:          string;
  whaleCount:      number;
  whales:          string[];
  totalWhaleVotes: number;
  lastWhaleVoteAt: string | null;
  inMyStrategy?:  boolean;
}

export interface WhaleSignalsResult {
  signals:       WhaleSignal[];
  trackedWhales: string[];
  periodDays:    number;
  computedAt:    string | null;
  authorsFound:  number;
}

type SteemPost = {
  author: string;
  permlink: string;
  created: string;
  pending_payout_value?: string;
  total_payout_value?: string;
  active_votes?: Array<{ voter: string; rshares: string | number; time?: string }>;
};

// ── Auto-discover top voters from post feeds ──────────────────────────────────
// Finds accounts appearing most often with high rshares — the actual active whales.

// Payout-Obergrenze für Auto-Discovery: Voter die überwiegend hochpreisige Posts voten
// sind meist Bots/Vote-Services (tipu, upvu etc.) — kein echtes Qualitätssignal.
const PAYOUT_CEILING_SBD = 12;
const MIN_PAYOUT_SAMPLE   = 5;

export async function discoverTopVoters(
  topN = 20,
  log: typeof console = console,
): Promise<string[]> {
  const client = createSteemClient();
  const voterRshares  = new Map<string, bigint>();
  const voterPayouts  = new Map<string, number[]>();

  for (const feed of ["get_discussions_by_trending", "get_discussions_by_hot"] as const) {
    let posts: SteemPost[] = [];
    try {
      posts = await client.database.call(feed, [{ tag: "", limit: POSTS_PER_FEED, truncate_body: 1 }]) as SteemPost[];
    } catch { continue; }

    for (const post of posts) {
      const postPayout =
        parseFloat((post.pending_payout_value ?? "0 SBD").split(" ")[0]) +
        parseFloat((post.total_payout_value   ?? "0 SBD").split(" ")[0]);

      for (const vote of post.active_votes ?? []) {
        const rs = BigInt(Math.abs(Number(vote.rshares ?? 0)));
        if (rs < BigInt(MIN_RSHARES_FOR_WHALE)) continue;
        voterRshares.set(vote.voter, (voterRshares.get(vote.voter) ?? 0n) + rs);
        if (!voterPayouts.has(vote.voter)) voterPayouts.set(vote.voter, []);
        voterPayouts.get(vote.voter)!.push(postPayout);
      }
    }
  }

  const sorted = [...voterRshares.entries()]
    .filter(([voter]) => {
      const payouts = voterPayouts.get(voter) ?? [];
      if (payouts.length < MIN_PAYOUT_SAMPLE) return true; // zu wenig Daten → nicht filtern
      const avg = payouts.reduce((a, b) => a + b, 0) / payouts.length;
      return avg <= PAYOUT_CEILING_SBD;
    })
    .sort((a, b) => (b[1] > a[1] ? 1 : -1))
    .slice(0, topN)
    .map(([voter]) => voter);

  log.info(`[WhaleSignals] Top voters discovered: ${sorted.slice(0, 10).join(", ")}...`);
  return sorted;
}

// ── Main rebuild ──────────────────────────────────────────────────────────────

export async function rebuildWhaleSignals(
  seedWhales:  string[]    = SEED_WHALES,
  periodDays:  number      = 30,
  log: typeof console      = console,
): Promise<{ scanned: number; authorsFound: number; whalesUsed: number }> {
  const db     = getDb();
  const client = createSteemClient();

  log.info(`[WhaleSignals] Starting rebuild — seed whales: ${seedWhales.join(", ")}`);

  // Expand whale list with auto-discovered top voters
  const discovered = await discoverTopVoters(30, log);
  const whaleSet   = new Set([...seedWhales, ...discovered]);
  log.info(`[WhaleSignals] Effective whale pool: ${whaleSet.size} accounts`);

  // Author signal map: author → whale → {count, lastAt}
  const signals = new Map<string, Map<string, { count: number; lastAt: string | null }>>();
  let totalScanned = 0;

  // Scan multiple feeds
  const feeds = [
    "get_discussions_by_trending",
    "get_discussions_by_hot",
    "get_discussions_by_created",
    "get_discussions_by_promoted",
  ] as const;

  for (const feed of feeds) {
    let posts: SteemPost[] = [];
    try {
      posts = await client.database.call(feed, [{ tag: "", limit: POSTS_PER_FEED, truncate_body: 1 }]) as SteemPost[];
    } catch { continue; }

    for (const post of posts) {
      totalScanned++;
      for (const vote of post.active_votes ?? []) {
        if (!whaleSet.has(vote.voter)) continue;
        const rs = Math.abs(Number(vote.rshares ?? 0));
        if (rs < MIN_RSHARES_FOR_WHALE) continue;

        if (!signals.has(post.author)) signals.set(post.author, new Map());
        const authorMap = signals.get(post.author)!;
        if (!authorMap.has(vote.voter)) {
          authorMap.set(vote.voter, { count: 1, lastAt: vote.time ?? null });
        } else {
          const e = authorMap.get(vote.voter)!;
          e.count++;
          if (vote.time && (!e.lastAt || vote.time > e.lastAt)) e.lastAt = vote.time;
        }
      }
    }
    log.info(`[WhaleSignals] Feed ${feed}: ${posts.length} posts`);
  }

  // Upsert into cache
  const upsert = db.prepare(`
    INSERT INTO vb_whale_author_signals
      (author, whale, vote_count, last_voted_at, period_days, computed_at)
    VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?, datetime('now'))
    ON CONFLICT(author, whale) DO UPDATE SET
      vote_count    = excluded.vote_count,
      last_voted_at = COALESCE(excluded.last_voted_at, last_voted_at),
      period_days   = excluded.period_days,
      computed_at   = datetime('now')
  `);

  db.transaction(() => {
    // Clear old entries for the effective whale set
    for (const whale of whaleSet) {
      db.prepare("DELETE FROM vb_whale_author_signals WHERE whale = ?").run(whale);
    }
    for (const [author, whaleMap] of signals) {
      for (const [whale, { count, lastAt }] of whaleMap) {
        upsert.run(author, whale, count, lastAt, periodDays);
      }
    }
  })();

  const authorsFound = signals.size;
  log.info(`[WhaleSignals] Done — ${totalScanned} posts, ${authorsFound} authors, ${whaleSet.size} whales`);
  return { scanned: totalScanned, authorsFound, whalesUsed: whaleSet.size };
}

// ── Read from cache ───────────────────────────────────────────────────────────

export function getWhaleSignals(
  userStrategyAuthors: Set<string> = new Set(),
  minWhaleVotes = 1,
  limit         = 50,
): WhaleSignalsResult {
  const db = getDb();

  // ── Community-Relevanz: Curatoren filtern die keinen der Strategie-Autoren gevoted haben ──
  // Nur relevant wenn der Nutzer eine Strategie hat — sonst werden alle Curatoren angezeigt.
  let whaleFilter = "";
  let whaleFilterParams: string[] = [];

  if (userStrategyAuthors.size > 0) {
    const placeholders = [...userStrategyAuthors].map(() => "?").join(",");
    const relevantWhales = (db.prepare(`
      SELECT DISTINCT whale FROM vb_whale_author_signals WHERE author IN (${placeholders})
    `).all([...userStrategyAuthors]) as Array<{ whale: string }>).map(r => r.whale);

    if (relevantWhales.length > 0) {
      const whalePlaceholders = relevantWhales.map(() => "?").join(",");
      whaleFilter = `AND whale IN (${whalePlaceholders})`;
      whaleFilterParams = relevantWhales;
    }
    // Kein Overlap gefunden → kein Filter (Fallback auf alle Curatoren)
  }

  const rows = db.prepare(`
    SELECT
      author,
      COUNT(DISTINCT whale)   as whale_count,
      GROUP_CONCAT(whale)     as whales_csv,
      SUM(vote_count)         as total_votes,
      MAX(last_voted_at)      as last_voted,
      MAX(computed_at)        as computed_at
    FROM vb_whale_author_signals
    ${whaleFilter}
    GROUP BY author
    HAVING SUM(vote_count) >= ?
      AND MAX(last_voted_at) >= datetime('now', '-60 days')
    ORDER BY whale_count DESC, total_votes DESC
    LIMIT ?
  `).all([...whaleFilterParams, minWhaleVotes, limit]) as Array<{
    author: string; whale_count: number; whales_csv: string;
    total_votes: number; last_voted: string | null; computed_at: string;
  }>;

  const computedAt = rows[0]?.computed_at ?? null;

  // trackedWhales: aktive Curatoren aus dem gefilterten Signal-Pool
  const trackedWhales = whaleFilterParams.length > 0
    ? whaleFilterParams
    : (db.prepare("SELECT DISTINCT whale FROM vb_whale_author_signals").all() as Array<{ whale: string }>).map(r => r.whale);

  const periodDays = (db.prepare(
    "SELECT period_days FROM vb_whale_author_signals LIMIT 1"
  ).get() as { period_days: number } | undefined)?.period_days ?? 30;

  const signals: WhaleSignal[] = rows.map(r => ({
    author:          r.author,
    whaleCount:      r.whale_count,
    whales:          r.whales_csv ? r.whales_csv.split(",") : [],
    totalWhaleVotes: r.total_votes,
    lastWhaleVoteAt: r.last_voted,
    inMyStrategy:    userStrategyAuthors.has(r.author),
  }));

  return { signals, trackedWhales, periodDays, computedAt, authorsFound: signals.length };
}
