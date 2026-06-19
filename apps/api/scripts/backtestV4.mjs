/**
 * Point-in-time Backtest: Opportunity Score v4 vs. v3 (as logged)
 * ===============================================================
 * Read-only against the PRODUCTION volume DB. Replays v4 over historical v3
 * shadow decisions and compares precision / false positives on the SAME
 * candidates, using the resolved post payout as the label.
 *
 * METHODOLOGY — strictly point-in-time. v4 may only use information that existed
 * at each row's run_at. Author/whale/community features are reconstructed from
 * vb_whale_vote_details and vb_global_vote_outcomes events dated < run_at. The
 * live vb_signal_author table is NOT read (it carries future information). Post-
 * level features (age, remainingHours, isSelfPost, category) come from the row's
 * own signals_json, which was written at evaluation time.
 *
 * Run:  npm run build && node scripts/backtestV4.mjs
 */

import Database from "better-sqlite3";
import { calcOpportunityScoreV4 } from "../dist/chain/opportunityScoreV4.js";

const DB_PATH = "/var/lib/docker/volumes/votebroker_data/_data/votebroker.db";
const GOOD_SBD = 1.0;                       // label: post settled to a worthwhile payout
const SETTLE_MIN = 7 * 24 * 60;             // payout finalises 7 days after post creation
const WHALE_WINDOW_MIN = 60 * 24 * 60;      // trailing window for "distinct whales for author"
const MIN_CV_SAMPLES = 3;

const db = new Database(DB_PATH, { readonly: true });
const ms = (s) => new Date(s).getTime();

// ── 1. Backtest candidates: logged v3 decision + resolved outcome ─────────────
const rows = db.prepare(`
  SELECT id, author, permlink, category, run_at, decision, post_score,
         resolved_payout_sbd, signals_json
  FROM vb_copilot_shadow_runs
  WHERE decision IN ('would_vote','skip_score')
    AND post_score IS NOT NULL
    AND outcome_status = 'resolved'
    AND resolved_payout_sbd IS NOT NULL
`).all();
console.log(`Backtest candidates (v3 decision + resolved outcome): ${rows.length}`);

// ── 2. Load event history into memory for point-in-time reconstruction ────────
// (a) Author payout history — enriched posts with a known settlement time.
// (b) Whale attention — every whale vote (author, whale, voted_at).
// (c) Community payout history.
const whaleRows = db.prepare(`
  SELECT author, permlink, whale, voted_at, post_created_at, total_payout_sbd, post_community
  FROM vb_whale_vote_details
`).all();

const authorPosts   = new Map();   // author -> [{ settleMs, payout }]
const authorWhales  = new Map();   // author -> [{ whale, voteMs }]
const communityPosts= new Map();   // community -> [{ settleMs, payout }]
const seenPost      = new Set();   // dedupe author/permlink for payout history

for (const r of whaleRows) {
  const voteMs = ms(r.voted_at);
  if (!authorWhales.has(r.author)) authorWhales.set(r.author, []);
  authorWhales.get(r.author).push({ whale: r.whale, voteMs });

  if (r.total_payout_sbd != null) {
    const key = r.author + "/" + r.permlink;
    if (!seenPost.has(key)) {
      seenPost.add(key);
      const baseMs = ms(r.post_created_at ?? r.voted_at);
      const settleMs = baseMs + SETTLE_MIN * 60_000;
      if (!authorPosts.has(r.author)) authorPosts.set(r.author, []);
      authorPosts.get(r.author).push({ settleMs, payout: r.total_payout_sbd });
      if (r.post_community) {
        if (!communityPosts.has(r.post_community)) communityPosts.set(r.post_community, []);
        communityPosts.get(r.post_community).push({ settleMs, payout: r.total_payout_sbd });
      }
    }
  }
}

// (d) Our own realized curation per vote, per author — for sp_per_vp CV.
//     Point-in-time via realized_at (a curation reward is only known once paid).
const gvoRows = db.prepare(`
  SELECT author, weight_bps, realized_curation_sp, realized_at
  FROM vb_global_vote_outcomes
  WHERE realized_curation_sp IS NOT NULL AND weight_bps > 0 AND realized_at IS NOT NULL
`).all();
const authorSpPerVp = new Map(); // author -> [{ realizedMs, spPerVp }]
for (const r of gvoRows) {
  if (!authorSpPerVp.has(r.author)) authorSpPerVp.set(r.author, []);
  authorSpPerVp.get(r.author).push({ realizedMs: ms(r.realized_at), spPerVp: r.realized_curation_sp / (r.weight_bps / 10000) });
}

const median = (a) => { if (!a.length) return null; const s=[...a].sort((x,y)=>x-y); const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const mean   = (a) => a.length ? a.reduce((s,v)=>s+v,0)/a.length : null;

// ── 3. Reconstruct features at run_at and score v4 ────────────────────────────
let fidAuthor = 0, fidWhale = 0, fidCommunity = 0, fidCv = 0;

function reconstruct(row) {
  const T = ms(row.run_at);
  const sig = JSON.parse(row.signals_json || "{}");

  // Author payout history known before T
  const posts = (authorPosts.get(row.author) ?? []).filter(p => p.settleMs < T).map(p => p.payout);
  const authorMedian = median(posts);
  const authorAvg    = mean(posts);
  if (posts.length > 0) fidAuthor++;

  // Distinct whales for this author in the trailing window before T
  const whset = new Set();
  for (const w of (authorWhales.get(row.author) ?? [])) {
    if (w.voteMs < T && w.voteMs >= T - WHALE_WINDOW_MIN * 60_000) whset.add(w.whale);
  }
  const whaleCount = whset.size;
  if (whaleCount > 0) fidWhale++;

  // Community payout history before T
  const comm = sig.community ?? null;
  const cposts = comm ? (communityPosts.get(comm) ?? []).filter(p => p.settleMs < T).map(p => p.payout) : [];
  const communityAvg = mean(cposts);
  if (cposts.length > 0) fidCommunity++;

  // sp_per_vp CV before T (>= MIN_CV_SAMPLES)
  const sp = (authorSpPerVp.get(row.author) ?? []).filter(x => x.realizedMs < T).map(x => x.spPerVp);
  let cv;
  if (sp.length >= MIN_CV_SAMPLES) {
    const m = mean(sp); const v = mean(sp.map(x => (x - m) ** 2));
    cv = m > 0 ? Math.sqrt(v) / m : undefined;
    if (cv !== undefined) fidCv++;
  }

  return {
    ageMinutes:            sig.ageMinutes ?? 0,
    remainingHours:        sig.remainingHours ?? 0,
    category:              row.category ?? "normal",
    isSelfPost:            sig.isSelfPost ?? false,
    // pendingPayoutSbd intentionally omitted — not logged AND v4 weights it 0.
    authorMedianPayoutSbd: authorMedian ?? undefined,
    authorAvgPayoutSbd:    authorAvg ?? undefined,
    whaleCount,
    whaleFollowRate:       undefined,   // not reconstructable point-in-time (no full post inventory)
    spPerVpCv:             cv,
    communityAvgPayoutSbd: communityAvg ?? undefined,
  };
}

// ── 4. Score and tally confusion matrices ─────────────────────────────────────
function newCM() { return { tp:0, fp:0, fn:0, tn:0, posPayouts:[] }; }
function add(cm, predPos, good, payout) {
  if (predPos && good) cm.tp++;
  else if (predPos && !good) cm.fp++;
  else if (!predPos && good) cm.fn++;
  else cm.tn++;
  if (predPos) cm.posPayouts.push(payout);
}
function report(name, cm) {
  const prec = cm.tp + cm.fp ? cm.tp / (cm.tp + cm.fp) : 0;
  const rec  = cm.tp + cm.fn ? cm.tp / (cm.tp + cm.fn) : 0;
  const f1   = prec + rec ? 2 * prec * rec / (prec + rec) : 0;
  const acc  = (cm.tp + cm.tn) / (cm.tp + cm.fp + cm.fn + cm.tn);
  const yld  = mean(cm.posPayouts);
  console.log(`  ${name.padEnd(14)} pred+=${(cm.tp+cm.fp).toString().padStart(4)}  TP=${cm.tp} FP=${cm.fp} FN=${cm.fn} TN=${cm.tn}` +
              `  | precision=${prec.toFixed(3)} recall=${rec.toFixed(3)} F1=${f1.toFixed(3)} acc=${acc.toFixed(3)}` +
              `  | Ø payout(pred+)=${yld?.toFixed(2)} SBD`);
}

const v3 = newCM(), v4 = newCM();
const v4hi = newCM(), v3hi = newCM();   // high-fidelity subset (author quality reconstructed)
let goodN = 0;

for (const row of rows) {
  const good = row.resolved_payout_sbd >= GOOD_SBD;
  if (good) goodN++;
  const params = reconstruct(row);
  const res = calcOpportunityScoreV4(params);

  const v3pos = row.decision === "would_vote";
  const v4pos = res.wouldAct;
  add(v3, v3pos, good, row.resolved_payout_sbd);
  add(v4, v4pos, good, row.resolved_payout_sbd);

  if (params.authorMedianPayoutSbd !== undefined) {
    add(v3hi, v3pos, good, row.resolved_payout_sbd);
    add(v4hi, v4pos, good, row.resolved_payout_sbd);
  }
}

// ── 5. Output ─────────────────────────────────────────────────────────────────
console.log(`\nLabel: good = resolved_payout >= ${GOOD_SBD} SBD`);
console.log(`Base rate (good): ${goodN}/${rows.length} = ${(goodN/rows.length).toFixed(3)}`);
console.log(`\nFeature reconstruction fidelity (point-in-time, < run_at):`);
console.log(`  author median payout: ${fidAuthor}/${rows.length} (${Math.round(100*fidAuthor/rows.length)}%)`);
console.log(`  whale count > 0:      ${fidWhale}/${rows.length} (${Math.round(100*fidWhale/rows.length)}%)`);
console.log(`  community payout:     ${fidCommunity}/${rows.length} (${Math.round(100*fidCommunity/rows.length)}%)`);
console.log(`  sp_per_vp CV:         ${fidCv}/${rows.length} (${Math.round(100*fidCv/rows.length)}%)`);

console.log(`\n=== FULL SET (n=${rows.length}) — predicted-positive = would-vote ===`);
report("v3 (as logged)", v3);
report("v4 (point-in-time)", v4);

console.log(`\n=== HIGH-FIDELITY SUBSET (author quality reconstructed, n=${v4hi.tp+v4hi.fp+v4hi.fn+v4hi.tn}) ===`);
report("v3 (as logged)", v3hi);
report("v4 (point-in-time)", v4hi);

console.log(`\nFP delta (full set): v4 makes ${v4.fp - v3.fp >= 0 ? "+" : ""}${v4.fp - v3.fp} FPs vs v3 (v3=${v3.fp}, v4=${v4.fp}).`);
console.log(`TP delta (full set): v4 keeps ${v4.tp - v3.tp >= 0 ? "+" : ""}${v4.tp - v3.tp} TPs vs v3 (v3=${v3.tp}, v4=${v4.tp}).`);
db.close();
