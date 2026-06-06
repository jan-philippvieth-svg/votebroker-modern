/**
 * Whale Vote Enrichment Job
 * ==========================
 * For every unenriched row in vb_whale_vote_details, fetches get_content and
 * stores post timing (vote_delay_min), final payout, and community.
 *
 * Prioritises posts that are old enough to have paid out (> 7 days).
 * Runs at startup and then every hour to catch newly added rows.
 * Rate-limited at 120ms per request.
 */

import { createSteemClient } from "../chain/steemBroadcaster.js";
import { getDb } from "../db/index.js";

const BATCH_SIZE  = 20;    // rows per run chunk
const RATE_MS     = 120;
const INTERVAL_MS = 60 * 60 * 1_000; // hourly

let _timer: ReturnType<typeof setTimeout> | null = null;
let _running = false;
let _started = false;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function parseAmount(v: unknown): number {
  return parseFloat(String(v).split(" ")[0]) || 0;
}

export async function runWhaleEnrichment(
  batchSize = BATCH_SIZE,
  log: typeof console = console,
): Promise<{ processed: number; errors: number }> {
  if (_running) { log.info("[WhaleEnrich] Already running, skipping"); return { processed: 0, errors: 0 }; }
  _running = true;

  try {
    const db     = getDb();
    const client = createSteemClient();

    // Prefer posts that have had time to pay out (> 7 days old)
    const rows = db.prepare(`
      SELECT whale, author, permlink, voted_at
      FROM vb_whale_vote_details
      WHERE enriched_at IS NULL
      ORDER BY
        CASE WHEN voted_at < datetime('now', '-7 days') THEN 0 ELSE 1 END,
        voted_at ASC
      LIMIT ?
    `).all(batchSize) as Array<{ whale: string; author: string; permlink: string; voted_at: string }>;

    if (rows.length === 0) {
      log.info("[WhaleEnrich] Nothing to enrich");
      return { processed: 0, errors: 0 };
    }

    log.info(`[WhaleEnrich] Processing ${rows.length} rows`);

    const update = db.prepare(`
      UPDATE vb_whale_vote_details SET
        post_created_at    = ?,
        vote_delay_min     = ?,
        total_payout_sbd   = ?,
        curator_payout_sbd = ?,
        pending_payout_sbd = ?,
        post_community     = ?,
        enriched_at        = datetime('now')
      WHERE whale = ? AND author = ? AND permlink = ?
    `);

    let processed = 0;
    let errors    = 0;

    for (const row of rows) {
      try {
        const post = await client.database.call("get_content", [row.author, row.permlink]) as {
          author?:              string;
          created?:             string;
          category?:            string;
          parent_permlink?:     string;
          json_metadata?:       string;
          total_payout_value?:  string;
          curator_payout_value?: string;
          pending_payout_value?: string;
        };

        if (!post?.author) {
          // Post deleted or not found — mark as enriched with nulls so we don't retry
          db.prepare(`
            UPDATE vb_whale_vote_details SET enriched_at = datetime('now')
            WHERE whale = ? AND author = ? AND permlink = ?
          `).run(row.whale, row.author, row.permlink);
          processed++;
          continue;
        }

        // Timing
        let postCreatedAt: string | null  = post.created ?? null;
        let voteDelayMin:  number | null  = null;
        if (post.created) {
          const postMs = new Date(post.created + "Z").getTime();
          const voteMs = new Date(row.voted_at + "Z").getTime();
          if (!isNaN(postMs) && !isNaN(voteMs)) {
            voteDelayMin = Math.round((voteMs - postMs) / 60_000 * 10) / 10;
          }
        }

        // Payouts
        const totalPayout   = parseAmount(post.total_payout_value);
        const curatorPayout = parseAmount(post.curator_payout_value);
        const pendingPayout = parseAmount(post.pending_payout_value);

        // Community: json_metadata.community → parent_permlink → category
        let community: string | null = null;
        if (post.json_metadata) {
          try {
            const meta = JSON.parse(post.json_metadata) as { community?: string };
            community  = meta.community ?? null;
          } catch { /* malformed */ }
        }
        if (!community && post.parent_permlink) community = post.parent_permlink;
        if (!community && post.category)        community = post.category;

        update.run(
          postCreatedAt, voteDelayMin,
          totalPayout || null, curatorPayout || null, pendingPayout || null,
          community,
          row.whale, row.author, row.permlink,
        );
        processed++;
      } catch (err) {
        log.warn(`[WhaleEnrich] Error enriching ${row.author}/${row.permlink}:`, err);
        errors++;
      }

      await sleep(RATE_MS);
    }

    log.info(`[WhaleEnrich] Done — processed: ${processed}, errors: ${errors}`);
    return { processed, errors };
  } finally {
    _running = false;
  }
}

export function startWhaleEnrichment(log: typeof console = console): void {
  if (_started) return;
  _started = true;

  const schedule = () => {
    _timer = setTimeout(async () => {
      try { await runWhaleEnrichment(BATCH_SIZE, log); } catch (e) { log.warn("[WhaleEnrich] error:", e); }
      schedule();
    }, INTERVAL_MS);
  };

  // Run a large initial batch on startup, then hourly top-ups
  runWhaleEnrichment(500, log).catch(e => log.warn("[WhaleEnrich] initial run error:", e));
  schedule();
  log.info("[WhaleEnrich] Started — initial batch 500 rows, then hourly top-ups");
}

export function stopWhaleEnrichment(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _started = false;
}
