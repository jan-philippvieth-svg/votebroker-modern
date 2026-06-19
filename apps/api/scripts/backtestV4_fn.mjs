/**
 * V4 False-Negative analysis + single-lever recall optimisation.
 * Point-in-time, read-only against the production volume DB. Same reconstruction
 * as scripts/backtestV4.mjs. Buckets the FNs by cause, then finds the single
 * threshold or feature change that maximises recall while keeping precision >= 0.95.
 *
 * Run: npm run build && node scripts/backtestV4_fn.mjs
 */
import Database from "better-sqlite3";
import { calcOpportunityScoreV4 } from "../dist/chain/opportunityScoreV4.js";

const DB_PATH = "/var/lib/docker/volumes/votebroker_data/_data/votebroker.db";
const GOOD_SBD = 1.0, SETTLE_MIN = 7*24*60, WHALE_WINDOW_MIN = 60*24*60, MIN_CV = 3;
const PREC_FLOOR = 0.95;
const db = new Database(DB_PATH, { readonly: true });
const ms = (s) => new Date(s).getTime();
const median = (a)=>{ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const mean = (a)=> a.length ? a.reduce((s,v)=>s+v,0)/a.length : null;
// inverse of v4 authorQualityFeature: median that yields a target authorQ in [0,1]
const medianForQ = (q) => Math.expm1(q * Math.log1p(5));

const rows = db.prepare(`
  SELECT author, category, run_at, decision, resolved_payout_sbd, signals_json
  FROM vb_copilot_shadow_runs
  WHERE decision IN ('would_vote','skip_score') AND post_score IS NOT NULL
    AND outcome_status='resolved' AND resolved_payout_sbd IS NOT NULL`).all();

// ── history ──
const wr = db.prepare(`SELECT author,permlink,whale,voted_at,post_created_at,total_payout_sbd,post_community FROM vb_whale_vote_details`).all();
const authorPosts=new Map(), authorWhales=new Map(), commPosts=new Map(), seen=new Set();
for (const r of wr) {
  if(!authorWhales.has(r.author)) authorWhales.set(r.author,[]);
  authorWhales.get(r.author).push({whale:r.whale, voteMs:ms(r.voted_at)});
  if(r.total_payout_sbd!=null){ const k=r.author+"/"+r.permlink; if(!seen.has(k)){ seen.add(k);
    const settleMs=ms(r.post_created_at??r.voted_at)+SETTLE_MIN*60000;
    if(!authorPosts.has(r.author)) authorPosts.set(r.author,[]); authorPosts.get(r.author).push({settleMs,payout:r.total_payout_sbd});
    if(r.post_community){ if(!commPosts.has(r.post_community)) commPosts.set(r.post_community,[]); commPosts.get(r.post_community).push({settleMs,payout:r.total_payout_sbd}); }
  }}
}
const gvo = db.prepare(`SELECT author,weight_bps,realized_curation_sp,realized_at FROM vb_global_vote_outcomes WHERE realized_curation_sp IS NOT NULL AND weight_bps>0 AND realized_at IS NOT NULL`).all();
const aSp=new Map();
for(const r of gvo){ if(!aSp.has(r.author)) aSp.set(r.author,[]); aSp.get(r.author).push({realizedMs:ms(r.realized_at), v:r.realized_curation_sp/(r.weight_bps/10000)}); }

function featuresAt(row){
  const T=ms(row.run_at), sig=JSON.parse(row.signals_json||"{}");
  const posts=(authorPosts.get(row.author)??[]).filter(p=>p.settleMs<T).map(p=>p.payout);
  const whset=new Set(); for(const w of (authorWhales.get(row.author)??[])) if(w.voteMs<T && w.voteMs>=T-WHALE_WINDOW_MIN*60000) whset.add(w.whale);
  const comm=sig.community??null;
  const cposts=comm?(commPosts.get(comm)??[]).filter(p=>p.settleMs<T).map(p=>p.payout):[];
  const sp=(aSp.get(row.author)??[]).filter(x=>x.realizedMs<T).map(x=>x.v);
  let cv; if(sp.length>=MIN_CV){ const m=mean(sp),v=mean(sp.map(x=>(x-m)**2)); cv=m>0?Math.sqrt(v)/m:undefined; }
  return {
    sig, authorReconstructed: posts.length>0, communityReconstructed: cposts.length>0,
    params: {
      ageMinutes: sig.ageMinutes??0, remainingHours: sig.remainingHours??0,
      category: row.category??"normal", isSelfPost: sig.isSelfPost??false,
      authorMedianPayoutSbd: median(posts)??undefined, authorAvgPayoutSbd: mean(posts)??undefined,
      whaleCount: whset.size, whaleFollowRate: undefined, spPerVpCv: cv,
      communityAvgPayoutSbd: mean(cposts)??undefined,
    },
  };
}

// ── score everyone once ──
const scored=[]; const fns=[];
for(const row of rows){
  const good=row.resolved_payout_sbd>=GOOD_SBD;
  const f=featuresAt(row); const res=calcOpportunityScoreV4(f.params);
  const rec={ pGood:res.pGood, thr:res.threshold, hard:res.hardSkip, good, payout:row.resolved_payout_sbd,
              category:f.params.category, f, comp:res.components };
  scored.push(rec);
  if(good && !res.wouldAct) fns.push(rec);
}
console.log(`Total candidates: ${rows.length} | V4 false negatives (good but skipped): ${fns.length}`);

// ── confusion helper on a predicate ──
function pr(predFn){
  let tp=0,fp=0,fn=0,tn=0;
  for(const r of scored){ const p=predFn(r); if(p&&r.good)tp++; else if(p&&!r.good)fp++; else if(!p&&r.good)fn++; else tn++; }
  const prec=tp+fp?tp/(tp+fp):1, rec=tp+fn?tp/(tp+fn):0;
  return {tp,fp,fn,tn,prec,rec};
}
const basePred=(r)=>!r.hard && r.pGood>=r.thr;
const base=pr(basePred);
console.log(`Baseline (priors): precision=${base.prec.toFixed(3)} recall=${base.rec.toFixed(3)} FP=${base.fp} FN=${base.fn}`);

// ── 1. Bucket the FNs (primary cause, priority order) ──
const buckets={ knapp_unter_schwelle:[], fehlende_autorhistorie:[], fehlende_whale_signale:[], timing:[], community:[], sonstige:[] };
const tagCount={ knapp:0, missingAuthor:0, missingWhale:0, timingHurt:0, missingCommunity:0 };
for(const r of fns){
  const gap=r.thr-r.pGood;
  const fe=r.comp.features;
  const knapp=gap<=0.05;
  const missingAuthor=!r.f.authorReconstructed;
  const missingWhale=fe.whaleC===0;          // whaleConfirm feature 0 ⇒ no usable whale signal
  const timingHurt=fe.timing<0.5 || r.comp.reverseAuction<0 || r.comp.freshnessDecay<0;
  const missingComm=!r.f.communityReconstructed;
  if(knapp)tagCount.knapp++; if(missingAuthor)tagCount.missingAuthor++; if(missingWhale)tagCount.missingWhale++;
  if(timingHurt)tagCount.timingHurt++; if(missingComm)tagCount.missingCommunity++;
  // primary assignment
  let b;
  if(knapp) b="knapp_unter_schwelle";
  else if(missingAuthor) b="fehlende_autorhistorie";
  else if(missingWhale) b="fehlende_whale_signale";
  else if(timingHurt) b="timing";
  else if(missingComm) b="community";
  else b="sonstige";
  buckets[b].push({gap, payout:r.payout, pGood:r.pGood});
}
console.log(`\n=== FN buckets (primary cause, mutually exclusive, sum=${fns.length}) ===`);
for(const [k,v] of Object.entries(buckets)){
  if(!v.length){ console.log(`  ${k.padEnd(24)} 0`); continue; }
  console.log(`  ${k.padEnd(24)} n=${String(v.length).padStart(3)}  median gap=${median(v.map(x=>x.gap)).toFixed(3)}  median payout=${median(v.map(x=>x.payout)).toFixed(2)} SBD  median pGood=${median(v.map(x=>x.pGood)).toFixed(3)}`);
}
console.log(`\n  (overlapping tags) knapp≤0.05=${tagCount.knapp}  missingAuthor=${tagCount.missingAuthor}  missingWhale=${tagCount.missingWhale}  timingHurt=${tagCount.timingHurt}  missingCommunity=${tagCount.missingCommunity}`);
const gapHist=(lo,hi)=>fns.filter(r=>{const g=r.thr-r.pGood; return g>lo&&g<=hi;}).length;
console.log(`  gap distribution: ≤0.05=${gapHist(-1,0.05)}  0.05–0.10=${gapHist(0.05,0.10)}  0.10–0.20=${gapHist(0.10,0.20)}  >0.20=${fns.filter(r=>r.thr-r.pGood>0.20).length}`);

// ── 2. Lever A: uniform threshold shift Δ (single threshold knob) ──
console.log(`\n=== Lever A: uniform threshold shift (pred+ if pGood >= thr - Δ) ===`);
let bestA=null;
for(let d=0; d<=0.40001; d+=0.005){
  const m=pr(r=>!r.hard && r.pGood>=r.thr-d);
  if(m.prec>=PREC_FLOOR && (!bestA || m.rec>bestA.rec)) bestA={d, ...m};
}
if(bestA) console.log(`  best Δ keeping precision≥${PREC_FLOOR}: Δ=${bestA.d.toFixed(3)} → precision=${bestA.prec.toFixed(3)} recall=${bestA.rec.toFixed(3)} (FN ${base.fn}→${bestA.fn}, recovered ${base.fn-bestA.fn}) FP=${bestA.fp}`);
// show a couple points along the curve
for(const d of [0.05,0.10,0.15,0.20]){ const m=pr(r=>!r.hard && r.pGood>=r.thr-d); console.log(`    Δ=${d.toFixed(2)} → precision=${m.prec.toFixed(3)} recall=${m.rec.toFixed(3)} FN=${m.fn} FP=${m.fp}`); }

// ── 3. Lever B: raise neutral author prior (helps fehlende_autorhistorie) ──
// Re-score only missing-author rows with a synthetic median = medianForQ(prior).
console.log(`\n=== Lever B: raise neutral author prior (missing-author rows only) ===`);
let bestB=null;
for(const prior of [0.55,0.60,0.65,0.70,0.75,0.80]){
  const synth=medianForQ(prior);
  let tp=0,fp=0,fn=0;
  for(const r of scored){
    let pos;
    if(!r.f.authorReconstructed){
      const p2={...r.f.params, authorMedianPayoutSbd:synth, authorAvgPayoutSbd:synth};
      const res2=calcOpportunityScoreV4(p2); pos=!res2.hardSkip && res2.wouldAct;
    } else pos = !r.hard && r.pGood>=r.thr;
    if(pos&&r.good)tp++; else if(pos&&!r.good)fp++; else if(!pos&&r.good)fn++;
  }
  const prec=tp+fp?tp/(tp+fp):1, rec=tp/(tp+fn);
  const ok=prec>=PREC_FLOOR;
  console.log(`  prior=${prior.toFixed(2)} (synthMedian=${synth.toFixed(2)} SBD) → precision=${prec.toFixed(3)} recall=${rec.toFixed(3)} FN=${fn} ${ok?'':'(<0.95 ✗)'}`);
  if(ok && (!bestB||rec>bestB.rec)) bestB={prior,prec,rec,fn};
}

// ── 4. Verdict ──
console.log(`\n=== Single-lever verdict (precision floor ${PREC_FLOOR}) ===`);
const optA=bestA?{name:`Threshold-Shift Δ=${bestA.d.toFixed(3)}`,rec:bestA.rec,fn:bestA.fn,prec:bestA.prec}:null;
const optB=bestB?{name:`Autor-Prior=${bestB.prior.toFixed(2)}`,rec:bestB.rec,fn:bestB.fn,prec:bestB.prec}:null;
for(const o of [optA,optB]) if(o) console.log(`  ${o.name.padEnd(26)} recall=${o.rec.toFixed(3)} FN=${o.fn} (recovered ${base.fn-o.fn}) precision=${o.prec.toFixed(3)}`);
const win=[optA,optB].filter(Boolean).sort((x,y)=>y.rec-x.rec)[0];
if(win) console.log(`  → größter Recall-Gewinn bei Precision≥${PREC_FLOOR}: ${win.name} (recall ${base.rec.toFixed(3)}→${win.rec.toFixed(3)}, +${(win.rec-base.rec).toFixed(3)}; ${base.fn-win.fn} FNs zurückgeholt)`);
db.close();
