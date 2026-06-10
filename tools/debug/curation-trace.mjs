#!/usr/bin/env node
/**
 * curation-trace.mjs  —  Per-Post Curation Calculation Trace
 *
 * Führt dieselbe Berechnung wie steemPendingCuration.ts durch und gibt
 * pro Post alle Zwischenschritte aus. Ziel: Abweichung zu SteemWorld
 * post-genau einkreisen.
 *
 * Usage:
 *   node tools/debug/curation-trace.mjs <username> [options]
 *
 * Options:
 *   --node   URL    Steem RPC node  (default: https://api.steemit.com)
 *   --factor N      Curation factor (default: 0.20)
 *   --sort   field  delta|sp|payout|share|time  (default: delta)
 *   --method w|r    weight (w) oder rshares (r) als primäre Methode
 *
 * Output-Spalten:
 *   author/permlink · pool_sbd · sbd_per_steem · my_weight · sum_weight
 *   · weight_share% · rshares_share% · sp_weight · sp_rshares · delta
 *
 * Formel (weight-Methode):
 *   pool_sbd × FACTOR × (my_weight / sum_weight) / sbd_per_steem
 */

// ── CLI args ──────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const username = args.find(a => !a.startsWith("--"));
if (!username) {
  console.error("Usage: node curation-trace.mjs <username> [--node URL] [--factor 0.20] [--sort delta|sp|payout|share|time] [--method w|r]");
  process.exit(1);
}

function flagVal(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
}

const nodeUrl = flagVal("--node",   process.env.STEEM_NODE_URL ?? "https://api.steemit.com");
const FACTOR  = parseFloat(flagVal("--factor", "0.20"));
const sortBy  = flagVal("--sort",   "delta");
const method  = flagVal("--method", "w");
const topN    = parseInt(flagVal("--top",    "20"), 10);

// ── RPC helper ────────────────────────────────────────────────────────────────

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function rpc(method, params, retries = 6) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(nodeUrl, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = await res.json();
      if (json.error) {
        const code = json.error?.code;
        if (attempt < retries && (code === -32003 || code === -32000)) {
          const delay = 1500 * (attempt + 1);
          process.stderr.write(`  [retry ${attempt+1}/${retries} in ${delay}ms — ${json.error.message}]\n`);
          await sleep(delay);
          continue;
        }
        throw new Error(`RPC ${method}: ${JSON.stringify(json.error)}`);
      }
      return json.result;
    } catch (err) {
      if (attempt < retries && !(err.message?.startsWith("RPC "))) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

function parseAmount(v) {
  return parseFloat(String(v).split(" ")[0]) || 0;
}

// ── 1. Globale Props + Preisfeed ──────────────────────────────────────────────

process.stderr.write(`Fetching global props + price feed ...\n`);
const [globalProps, feedHistory] = await Promise.all([
  rpc("condenser_api.get_dynamic_global_properties", []),
  rpc("condenser_api.get_feed_history",              []),
]);

const totalFundSteem  = parseAmount(globalProps.total_vesting_fund_steem);
const totalVestShares = parseAmount(globalProps.total_vesting_shares);
const vestsPerSp      = totalVestShares > 0 ? totalVestShares / totalFundSteem : 20_000;

// Median SBD/STEEM aus letzten Preisfeed-Einträgen
const priceSamples = (feedHistory.price_history ?? []).slice(-20);
const sbdPerSteem  = priceSamples.length > 0
  ? priceSamples.reduce((s, p) => s + parseAmount(p.base) / Math.max(parseAmount(p.quote), 1e-9), 0) / priceSamples.length
  : 0.05;

// ── 2. Account-History: Vote-Ops der letzten 7 Tage ─────────────────────────

process.stderr.write(`Fetching account history for @${username} ...\n`);

const nowMs    = Date.now();
const cutoff7d = nowMs - 7 * 24 * 3600 * 1000;

const voteOps = [];
let from = -1;
let done = false;

for (let page = 0; page < 30 && !done; page++) {
  const batch = await rpc("condenser_api.get_account_history", [username, from, 50]);
  if (!batch || batch.length === 0) break;

  for (const entry of [...batch].reverse()) {
    const ts = new Date(entry[1].timestamp + "Z").getTime();
    if (ts < cutoff7d) { done = true; break; }
    const [opType, opData] = entry[1].op;
    if (opType === "vote" && opData.voter === username) {
      voteOps.push({ author: String(opData.author), permlink: String(opData.permlink) });
    }
  }
  const oldestSeq = batch[0][0];
  if (oldestSeq <= 0) break;
  from = oldestSeq - 1;
  await sleep(300);
}

// Deduplizieren
const seen   = new Set();
const unique = voteOps.filter(v => {
  const k = `${v.author}/${v.permlink}`;
  if (seen.has(k)) return false;
  seen.add(k); return true;
});

process.stderr.write(`Found ${unique.length} unique vote targets (7d window)\n`);

// ── 3. Posts fetchen (max 15 parallel) ───────────────────────────────────────

process.stderr.write(`Fetching ${unique.length} posts ...\n`);

const CONCURRENCY = 15;
const allContent  = [];

for (let i = 0; i < unique.length; i += CONCURRENCY) {
  const batch   = unique.slice(i, i + CONCURRENCY);
  const settled = await Promise.allSettled(
    batch.map(v => rpc("condenser_api.get_content", [v.author, v.permlink]))
  );
  for (let j = 0; j < settled.length; j++) {
    allContent.push({ meta: batch[j], result: settled[j] });
  }
}

// ── 4. Berechnung pro Post ────────────────────────────────────────────────────

const rows = [];
const skipped = { paid: 0, zero: 0, noVote: 0, weightZero: 0 };

for (const { meta, result } of allContent) {
  if (result.status !== "fulfilled") continue;
  const post = result.value;

  if (new Date(post.cashout_time + "Z").getTime() <= nowMs) { skipped.paid++;        continue; }
  const payout = parseAmount(post.pending_payout_value);
  if (payout <= 0)                                           { skipped.zero++;        continue; }

  const votes  = post.active_votes ?? [];
  const myVote = votes.find(v => v.voter === username);
  if (!myVote)                                               { skipped.noVote++;      continue; }

  const sumWeight  = votes.reduce((s, v) => s + Math.max(0, Number(v.weight)),  0);
  const myWeight   = Math.max(0, Number(myVote.weight));
  if (myWeight <= 0 || sumWeight <= 0)                       { skipped.weightZero++;  continue; }

  const sumRshares = votes.reduce((s, v) => s + Math.max(0, Number(v.rshares)), 0);
  const myRshares  = Math.max(0, Number(myVote.rshares));

  const shareW = myWeight  / sumWeight;
  const shareR = sumRshares > 0 ? myRshares / sumRshares : 0;

  const spWeight  = payout * FACTOR * shareW / sbdPerSteem;
  const spRshares = payout * FACTOR * shareR / sbdPerSteem;
  const spBeem    = payout * 0.5    * shareW / sbdPerSteem;   // beem: factor 0.5, weight-method
  const delta     = spWeight - spRshares;          // + = weight höher als rshares

  rows.push({
    author:         meta.author,
    permlink:       meta.permlink,
    cashoutTime:    post.cashout_time,
    payout,
    sbdPerSteem,
    myWeight,
    sumWeight,
    shareW,
    myRshares,
    sumRshares,
    shareR,
    spWeight,
    spRshares,
    spBeem,
    delta,
  });
}

// ── 5. Sortieren ──────────────────────────────────────────────────────────────

const sorted = [...rows].sort((a, b) => {
  switch (sortBy) {
    case "sp":      return b.spWeight  - a.spWeight;
    case "payout":  return b.payout    - a.payout;
    case "share":   return b.shareW    - a.shareW;
    case "time":    return new Date(a.cashoutTime).getTime() - new Date(b.cashoutTime).getTime();
    default:        return Math.abs(b.delta) - Math.abs(a.delta);   // "delta"
  }
});

// ── 6. Ausgabe ────────────────────────────────────────────────────────────────

const totalSpWeight  = rows.reduce((s, r) => s + r.spWeight,  0);
const totalSpRshares = rows.reduce((s, r) => s + r.spRshares, 0);
const totalSpBeem    = rows.reduce((s, r) => s + r.spBeem,    0);
const totalDelta     = totalSpWeight - totalSpRshares;

const fmtPost = (author, permlink) => {
  const tag = `@${author}/${permlink}`;
  return tag.length > 42 ? tag.slice(0, 41) + "…" : tag.padEnd(42);
};
const f4 = n => n.toFixed(4).padStart(9);
const f3 = n => n.toFixed(3).padStart(8);
const pct = n => (n * 100).toFixed(4).padStart(9) + "%";
const sign = n => (n >= 0 ? "+" : "") + n.toFixed(4).padStart(8);

const header = [
  "",
  `CURATION TRACE  @${username}  (${new Date().toISOString()})`,
  `Node:       ${nodeUrl}`,
  `SBD/STEEM:  ${sbdPerSteem.toFixed(6)}  (avg of last ${priceSamples.length} feed entries)`,
  `VESTS/SP:   ${vestsPerSp.toFixed(2)}`,
  `Factor:     ${FACTOR}  (beem uses 0.5)`,
  `Window:     7 days  ·  ${unique.length} unique posts fetched  ·  ${rows.length} open`,
  `Skipped:    paid=${skipped.paid}  zero=${skipped.zero}  noVote=${skipped.noVote}  weightZero=${skipped.weightZero}`,
  `Sort:       ${sortBy}  ·  Top-${topN} in formula trace`,
  "",
  "Formula (weight):  pool_sbd × " + FACTOR + " × (my_weight / sum_weight) / sbd_per_steem",
  "Formula (rshares): pool_sbd × " + FACTOR + " × (my_rshares / sum_rshares) / sbd_per_steem",
  "Formula (beem):    pool_sbd × 0.5    × (my_weight / sum_weight) / sbd_per_steem",
  "",
];

const colHead =
  "Post                                           " +
  " Pool-SBD " +
  " W-Share% " +
  " R-Share% " +
  " SP(weight)" +
  " SP(rshares)" +
  "  SP(beem×0.5)" +
  "     Δ(w-r)" +
  "  myW/sumW      myR/sumR";

const sep = "─".repeat(colHead.length);

const dataLines = sorted.map(r => {
  const msLeft = new Date(r.cashoutTime + "Z").getTime() - nowMs;
  const hLeft  = Math.floor(msLeft / 3_600_000);
  const mLeft  = Math.floor((msLeft % 3_600_000) / 60_000);
  const due    = `${hLeft}h${mLeft}m`.padStart(7);

  return (
    fmtPost(r.author, r.permlink) + " " +
    due                           + " " +
    f3(r.payout)                  + " " +
    pct(r.shareW)                 + " " +
    pct(r.shareR)                 + " " +
    f4(r.spWeight)                + "  " +
    f4(r.spRshares)               + "  " +
    f4(r.spBeem)                  + "  " +
    sign(r.delta)                 + "  " +
    `${Math.round(r.myWeight)}/${Math.round(r.sumWeight)}  ${Math.round(r.myRshares)}/${Math.round(r.sumRshares)}`
  );
});

// Per-Post Formel für die Top-N nach |delta|
const topPosts = [...rows].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, topN);
const formulaLines = [
  "",
  `── Top-${topN} Posts nach |Δ| — Pool SBD · my_weight/sum_weight · my_rshares/sum_rshares · SP(weight) · SP(rshares) · SP(beem) ──`,
  "",
  ...topPosts.flatMap(r => [
    `@${r.author}/${r.permlink}`,
    `  Pool: ${r.payout.toFixed(4)} SBD  |  my_W: ${Math.round(r.myWeight)}  sum_W: ${Math.round(r.sumWeight)}  shareW: ${(r.shareW*100).toFixed(6)}%`,
    `  my_R: ${Math.round(r.myRshares)}  sum_R: ${Math.round(r.sumRshares)}  shareR: ${(r.shareR*100).toFixed(6)}%`,
    `  SP(weight)  = ${r.payout.toFixed(4)} × ${FACTOR} × ${r.shareW.toFixed(8)} / ${r.sbdPerSteem.toFixed(6)} = ${r.spWeight.toFixed(6)} SP`,
    `  SP(rshares) = ${r.payout.toFixed(4)} × ${FACTOR} × ${r.shareR.toFixed(8)} / ${r.sbdPerSteem.toFixed(6)} = ${r.spRshares.toFixed(6)} SP`,
    `  SP(beem)    = ${r.payout.toFixed(4)} × 0.5000 × ${r.shareW.toFixed(8)} / ${r.sbdPerSteem.toFixed(6)} = ${r.spBeem.toFixed(6)} SP`,
    `  Δ(weight-rshares) = ${sign(r.delta)} SP`,
    "",
  ]),
];

const footer = [
  sep,
  `${"TOTAL".padEnd(42)}` +
  `${" ".repeat(7)}` +
  `${f3(rows.reduce((s, r) => s + r.payout, 0))}` +
  `${" ".repeat(20)}` +
  `${f4(totalSpWeight)}  ` +
  `${f4(totalSpRshares)}  ` +
  `${f4(totalSpBeem)}  ` +
  `${sign(totalDelta)}`,
  "",
  `weight total (×${FACTOR}):   ${totalSpWeight.toFixed(4)} SP`,
  `rshares total (×${FACTOR}):  ${totalSpRshares.toFixed(4)} SP`,
  `beem total (×0.5, weight):   ${totalSpBeem.toFixed(4)} SP  (${(totalSpBeem/totalSpWeight*0.2/0.5).toFixed(2)}× weight-total)`,
  `delta W-R:                   ${sign(totalDelta)} SP`,
  `delta beem-rshares:          ${sign(totalSpBeem - totalSpRshares)} SP`,
  "",
  "Wenn delta ≈ 0: weight und rshares liefern dasselbe Ergebnis.",
  "Wenn delta > 0: weight überschätzt (andere Voter haben early-voter timing penalty).",
  "Falls SteemWorld ≈ rshares-total: → Methode auf rshares umstellen, Faktor bleibt 0.20.",
  "Falls SteemWorld ≈ beem-total:   → Faktor auf 0.50 ändern (sehr unwahrscheinlich).",
  "",
];

const output = [
  ...header,
  colHead,
  sep,
  ...dataLines,
  ...formulaLines,
  ...footer,
].join("\n");

process.stdout.write(output + "\n");
