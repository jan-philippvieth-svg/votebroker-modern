/**
 * Post Scanner — Central Blockchain Adapter
 *
 * Runs every 90 seconds. Collects every unique enabled author across all
 * users' strategies, deduplicates them, and fetches their recent posts from
 * the Steem blockchain in one unified batch operation.
 *
 * Results are written to vb_posts (SQLite). All downstream components —
 * Opportunity Scanner, Shadow Scanner, future analytics — read from SQLite
 * instead of making individual RPC calls. The blockchain is queried by exactly
 * one component.
 *
 * Architecture:
 *   Steem blockchain
 *        ↓
 *   Post Scanner (this job)
 *        ↓
 *   vb_posts / vb_post_scan_log  (SQLite)
 *        ↓
 *   ┌──────────────┬──────────────┬────────────────┐
 *   │ Opportunity  │    Shadow    │   (future)     │
 *   │   Scanner    │   Scanner    │   Analytics    │
 *   └──────────────┴──────────────┴────────────────┘
 */

import { getDb } from "../db/index.js";
import { createSteemClient } from "../chain/steemBroadcaster.js";
import { setPostCache } from "../chain/postCache.js";

const SCAN_INTERVAL_MS = 90_000;
const FETCH_TIMEOUT_MS = 8_000;
const POSTS_PER_AUTHOR = 10;
const BATCH            = 15;  // concurrent RPC calls per round

interface RawPost {
  author:               string;
  permlink:             string;
  title:                string;
  created:              string;
  pending_payout_value?: string;
  parent_permlink?:      string;
  active_votes?:         Array<{ voter: string; weight: number }>;
}

// ── Author collection ─────────────────────────────────────────────────────────

function getAllUniqueAuthors(): string[] {
  const rows = getDb()
    .prepare("SELECT rules_json FROM strategy_rules")
    .all() as Array<{ rules_json: string }>;

  const authors = new Set<string>();
  for (const row of rows) {
    try {
      const rules = JSON.parse(row.rules_json) as Array<{
        username: string; enabled: boolean; category: string;
      }>;
      for (const r of rules) {
        if (r.enabled && r.category !== "ignorieren" && r.username?.trim()) {
          authors.add(r.username.toLowerCase().trim());
        }
      }
    } catch { /* malformed JSON — skip */ }
  }
  return [...authors];
}

// ── Blockchain fetch (single author) ─────────────────────────────────────────

async function fetchAuthorPosts(author: string): Promise<RawPost[] | null> {
  const client = createSteemClient();
  const db = client.database as unknown as {
    call(method: string, params: unknown[]): Promise<RawPost[]>
  };
  try {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("steem_timeout")), FETCH_TIMEOUT_MS)
    );
    const posts = await Promise.race([
      db.call("get_discussions_by_blog", [{ tag: author, limit: POSTS_PER_AUTHOR }]),
      timeout,
    ]);
    return Array.isArray(posts) ? posts : null;
  } catch {
    return null;
  }
}

// ── DB write helpers ──────────────────────────────────────────────────────────

interface Runnable { run(...args: unknown[]): unknown }

function upsertPosts(
  author:     string,
  posts:      RawPost[],
  upsertPost: Runnable,
  upsertLog:  Runnable,
): number {
  const own = posts.filter(p => p.author === author); // exclude reblogs
  upsertLog.run(author, own.length);

  for (const post of own) {
    const pendingSbd = parseFloat(
      (post.pending_payout_value ?? "0 SBD").split(" ")[0]
    ) || 0;
    const votesJson  = post.active_votes ? JSON.stringify(post.active_votes) : null;
    const voteCount  = post.active_votes?.length ?? 0;
    upsertPost.run(
      post.author, post.permlink, post.title ?? "", post.created,
      pendingSbd, votesJson, voteCount, post.parent_permlink ?? null,
    );
  }

  // Also warm the in-memory postCache so concurrent requests within the same
  // 150s window skip the DB entirely.
  setPostCache(author, own);

  return own.length;
}

// ── Main scanner run ──────────────────────────────────────────────────────────

export async function runPostScanner(log = console): Promise<void> {
  const db      = getDb();
  const authors = getAllUniqueAuthors();
  if (authors.length === 0) return;

  const upsertPost = db.prepare(`
    INSERT INTO vb_posts
      (author, permlink, title, created, pending_payout_sbd,
       active_votes_json, active_votes_count, parent_permlink, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(author, permlink) DO UPDATE SET
      pending_payout_sbd  = excluded.pending_payout_sbd,
      active_votes_json   = excluded.active_votes_json,
      active_votes_count  = excluded.active_votes_count,
      fetched_at          = excluded.fetched_at
  `);

  const upsertLog = db.prepare(`
    INSERT INTO vb_post_scan_log (author, scanned_at, post_count)
    VALUES (?, datetime('now'), ?)
    ON CONFLICT(author) DO UPDATE SET
      scanned_at = datetime('now'),
      post_count = excluded.post_count
  `);

  let rpcCalls       = 0;
  let postsStored    = 0;
  let fetchErrors    = 0;

  for (let i = 0; i < authors.length; i += BATCH) {
    const batch   = authors.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(a => fetchAuthorPosts(a)));

    db.transaction(() => {
      for (let j = 0; j < results.length; j++) {
        const author = batch[j];
        const result = results[j];
        rpcCalls++;

        if (result.status === "fulfilled" && result.value !== null) {
          postsStored += upsertPosts(author, result.value, upsertPost, upsertLog);
        } else {
          fetchErrors++;
          // Do NOT update scan_log on error — keeps the entry stale so
          // readers fall back to the cached or RPC path.
        }
      }
    })();
  }

  log.info(
    `[PostScanner] ${authors.length} unique authors, ${rpcCalls} RPC calls, ` +
    `${postsStored} posts stored, ${fetchErrors} fetch errors`
  );
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let _started = false;

export function startPostScanner(log = console): void {
  if (_started) return;
  _started = true;

  function schedule(): void {
    setTimeout(async () => {
      try { await runPostScanner(log); } catch (err) { log.warn("[PostScanner] run error:", err); }
      schedule();
    }, SCAN_INTERVAL_MS);
  }

  // First run is immediate — vb_posts needs to be warm before the Shadow Scanner
  // fires (5 min after start) and before the first Opportunity Scan request.
  runPostScanner(log)
    .then(() => schedule())
    .catch(err => { log.warn("[PostScanner] initial run error:", err); schedule(); });

  log.info("[PostScanner] Started — scanning every 90s (first run immediate)");
}
