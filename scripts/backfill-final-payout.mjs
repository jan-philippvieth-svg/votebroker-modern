/**
 * One-shot backfill: fetches post_final_payout_sbd for realized rows
 * where the value is still NULL.
 *
 * Usage: node scripts/backfill-final-payout.mjs
 */

import Database from '/opt/votebroker-modern/node_modules/better-sqlite3/lib/index.js';
import { Client } from '/opt/votebroker-modern/node_modules/dsteem/lib/index.js';

const DB_PATH  = '/var/lib/docker/volumes/votebroker-modern_votebroker_data/_data/votebroker.db';
const NODE_URL = 'https://api.steemit.com';
const RATE_MS  = 300;

const db     = new Database(DB_PATH);
const client = new Client(NODE_URL);

const rows = db.prepare(`
  SELECT DISTINCT author, permlink
  FROM vb_global_vote_outcomes
  WHERE realized_curation_sp IS NOT NULL
    AND post_final_payout_sbd IS NULL
  ORDER BY author
`).all();

console.log(`Fetching ${rows.length} posts from chain…`);

const update = db.prepare(`
  UPDATE vb_global_vote_outcomes
  SET post_final_payout_sbd = ?
  WHERE author = ? AND permlink = ? AND post_final_payout_sbd IS NULL
`);

let done = 0, skipped = 0;

for (const { author, permlink } of rows) {
  try {
    const post = await client.database.call('get_content', [author, permlink]);

    if (!post?.author) {
      update.run(0, author, permlink);
      console.log(`  [NOT FOUND] ${author}/${permlink} → 0`);
      done++;
      continue;
    }

    const authorSbd  = parseFloat(String(post.total_payout_value   ?? '0').split(' ')[0]) || 0;
    const curatorSbd = parseFloat(String(post.curator_payout_value ?? '0').split(' ')[0]) || 0;
    const pendingSbd = parseFloat(String(post.pending_payout_value ?? '0').split(' ')[0]) || 0;

    const hasPaidOut = authorSbd > 0 || curatorSbd > 0 || pendingSbd === 0;

    if (hasPaidOut) {
      const finalTotal = authorSbd + curatorSbd || null;
      update.run(finalTotal, author, permlink);
      console.log(`  [OK] @${author} → ${finalTotal?.toFixed(3)} SBD (author=${authorSbd.toFixed(3)}, curator=${curatorSbd.toFixed(3)})`);
      done++;
    } else {
      console.log(`  [STILL PENDING] @${author} — skipping`);
      skipped++;
    }
  } catch (err) {
    console.error(`  [ERROR] @${author}/${permlink}: ${err.message}`);
  }

  await new Promise(r => setTimeout(r, RATE_MS));
}

console.log(`\nDone: ${done} updated, ${skipped} still pending`);

// Quick growth-factor preview for rows where both values are available
const preview = db.prepare(`
  SELECT author, strategy_category,
         post_pending_payout_sbd,
         post_final_payout_sbd,
         realized_curation_sp,
         vote_delay_minutes,
         ROUND(post_final_payout_sbd / NULLIF(post_pending_payout_sbd, 0), 2) AS growth_factor
  FROM vb_global_vote_outcomes
  WHERE voter = 'jan-philippvieth'
    AND realized_curation_sp IS NOT NULL
    AND post_pending_payout_sbd IS NOT NULL
    AND post_pending_payout_sbd > 0
    AND post_final_payout_sbd IS NOT NULL
    AND post_final_payout_sbd > 0
  ORDER BY growth_factor DESC
  LIMIT 20
`).all();

console.log(`\n─── Top 20 Growth-Faktoren (final/pending_at_vote) ───`);
console.log(`${'Author'.padEnd(20)} ${'Cat'.padEnd(14)} ${'Pend'.padStart(6)} ${'Final'.padStart(6)} ${'GrowthF'.padStart(7)} ${'CurSP'.padStart(6)} ${'Delay'.padStart(6)}`);
for (const r of preview) {
  console.log(
    `${String(r.author).padEnd(20)} ${String(r.strategy_category ?? '?').padEnd(14)} ` +
    `${String(r.post_pending_payout_sbd?.toFixed(2) ?? '?').padStart(6)} ` +
    `${String(r.post_final_payout_sbd?.toFixed(2)  ?? '?').padStart(6)} ` +
    `${String(r.growth_factor ?? '?').padStart(7)}x ` +
    `${String(r.realized_curation_sp?.toFixed(3) ?? '?').padStart(6)} ` +
    `${String(r.vote_delay_minutes?.toFixed(0) ?? '?').padStart(6)}min`
  );
}

// Aggregate by strategy_category
const agg = db.prepare(`
  SELECT strategy_category,
         COUNT(*) AS n,
         ROUND(AVG(post_final_payout_sbd / NULLIF(post_pending_payout_sbd, 0)), 2) AS avg_growth,
         ROUND(MIN(post_final_payout_sbd / NULLIF(post_pending_payout_sbd, 0)), 2) AS min_growth,
         ROUND(MAX(post_final_payout_sbd / NULLIF(post_pending_payout_sbd, 0)), 2) AS max_growth,
         ROUND(AVG(vote_delay_minutes), 0) AS avg_delay_min
  FROM vb_global_vote_outcomes
  WHERE voter = 'jan-philippvieth'
    AND realized_curation_sp IS NOT NULL
    AND post_pending_payout_sbd IS NOT NULL
    AND post_pending_payout_sbd > 0
    AND post_final_payout_sbd IS NOT NULL
    AND post_final_payout_sbd > 0
  GROUP BY strategy_category
  ORDER BY avg_growth DESC
`).all();

console.log(`\n─── Growth-Faktor nach Strategie-Kategorie ───`);
console.log(`${'Category'.padEnd(16)} ${'N'.padStart(4)} ${'AvgGrow'.padStart(8)} ${'Min'.padStart(6)} ${'Max'.padStart(6)} ${'AvgDelay'.padStart(9)}`);
for (const r of agg) {
  console.log(
    `${String(r.strategy_category ?? 'NULL').padEnd(16)} ` +
    `${String(r.n).padStart(4)} ` +
    `${String(r.avg_growth + 'x').padStart(8)} ` +
    `${String(r.min_growth + 'x').padStart(6)} ` +
    `${String(r.max_growth + 'x').padStart(6)} ` +
    `${String(r.avg_delay_min + 'min').padStart(9)}`
  );
}

db.close();
