import { useEffect, useState } from "react";
import type {
  AuthSession,
  CurationProfile,
  GrowthData,
  OpportunitiesMeta,
  PostOpportunity,
  SteemAccountSnapshot,
  VotePlanResponse,
} from "../api";
import { fetchGrowthData } from "../api";
import { createTranslator, type Locale, type TranslationKey } from "../i18n";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecentVote {
  author: string; permlink: string; title: string; weightPct: number; votedAt: string;
}

interface StrategyRuleLite {
  username: string; category: string; maxWeightPct: number; enabled: boolean;
}

// ── Design tokens — warm community palette ────────────────────────────────────
// Philosophy: warm navy dark (not cold GitHub black), vibrant accents,
// generous whitespace, rounded forms — feels like growth, not monitoring.

const C = {
  ok:      "#2ecc8a",   // emerald — friendlier than github green
  warn:    "#f5a623",   // warm amber
  err:     "#e05c5c",   // coral red
  info:    "#4da8f0",   // sky blue
  purple:  "#9d6df0",   // warm violet
  fire:    "#f07a35",   // warm orange
  teal:    "#2ec4b6",   // teal
  gold:    "#f1c40f",   // achievement
  dim:     "#7fa8cc",   // blue-muted
  bg0:     "#080d14",   // deepest
  bg1:     "#0d1724",   // main background — warm navy
  bg2:     "#152032",   // card background
  bg3:     "#1c2d40",   // inner elements
  bg4:     "#243548",   // subtle hover
  border:  "#263850",   // visible borders
  border2: "#2e4460",
  text:    "#ddeaf8",   // warm white
  muted:   "#7fa8cc",
  faint:   "#3d5a73",
};

const CAT_DEF: Record<string, { color: string; icon: string; tKey: TranslationKey; pri: number }> = {
  immer_voten:    { color: C.fire,   icon: "🔥", tKey: "catAlways",    pri: 5 },
  lieblingsautor: { color: C.warn,   icon: "⭐", tKey: "catFavorite",  pri: 4 },
  bevorzugt:      { color: C.info,   icon: "🟦", tKey: "catPreferred", pri: 3 },
  normal:         { color: C.ok,     icon: "⚪", tKey: "catNormal",    pri: 2 },
  niedrig:        { color: C.dim,    icon: "⬇", tKey: "catLow",       pri: 1 },
};

// Maps backend DNA label → i18n key
const DNA_LABEL_MAP: Record<string, TranslationKey> = {
  "Regular Curator":         "dnaRegularCurator",
  "Broad Explorer":          "dnaBroadExplorer",
  "Loyal Community Curator": "dnaLoyalCommunity",
  "Loyal Inner Circle":      "dnaLoyalInner",
  "High-Frequency Curator":  "dnaHighFreq",
  "Niche Specialist":        "dnaNiche",
  "Self-Focused Voter":      "dnaLabelSelfVoter",
  "Strategic Weight Voter":  "dnaStrategicWeight",
};

const DNA_EMOJI: Record<string, string> = {
  "Self-Focused Voter": "🔴", "Loyal Inner Circle": "🟣",
  "Loyal Community Curator": "🟦", "Broad Explorer": "🟢",
  "Strategic Weight Voter": "🟡", "High-Frequency Curator": "🟠",
  "Niche Specialist": "🟤", "Regular Curator": "⚪",
};

const LEVELS: ReadonlyArray<{ key: TranslationKey; min: number; max: number; color: string; emoji: string }> = [
  { key: "levelNewCurator",       min: 0,    max: 25,        color: C.dim,    emoji: "🌱" },
  { key: "levelActiveSup",        min: 25,   max: 100,       color: C.ok,     emoji: "🌿" },
  { key: "levelCommunityBuilder", min: 100,  max: 300,       color: C.info,   emoji: "🌳" },
  { key: "levelTrustedCurator",   min: 300,  max: 750,       color: C.purple, emoji: "⭐" },
  { key: "levelEcosystemSup",     min: 750,  max: 2000,      color: C.warn,   emoji: "🌟" },
  { key: "levelLegend",           min: 2000, max: Infinity,  color: C.gold,   emoji: "🏆" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function vpCol(v: number)  { return v >= 85 ? C.ok : v >= 65 ? C.warn : C.err; }
function fmtUsd(v: number) { return v < 0.0005 ? "<$0.001" : `$${v.toFixed(3)}`; }

function fmtAgeIso(iso: string, t: ReturnType<typeof createTranslator>) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 2)    return t("timeJustNow");
  if (m < 60)   return `${m}${t("timeMinAgo")}`;
  if (m < 1440) return `${Math.round(m / 60)}${t("timeHourAgo")}`;
  return `${Math.round(m / 1440)}${t("timeDayAgo")}`;
}

function fmtMin(min: number) {
  if (min < 60)   return `${min}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

function sortRules(r: StrategyRuleLite[]) {
  return [...r].filter(x => x.enabled && x.category !== "ignorieren")
    .sort((a, b) => (CAT_DEF[b.category]?.pri ?? 0) - (CAT_DEF[a.category]?.pri ?? 0));
}

function votesPerDay(votes: RecentVote[]): Array<{ day: string; short: string; count: number }> {
  const result: Record<string, number> = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
    result[d.toISOString().slice(0, 10)] = 0;
  }
  for (const v of votes) {
    const day = v.votedAt.slice(0, 10);
    if (day in result) result[day]++;
  }
  const labels = ["Su","Mo","Tu","We","Th","Fr","Sa"];
  return Object.entries(result).map(([day, count]) => ({
    day, count, short: labels[new Date(day + "T12:00:00Z").getUTCDay()],
  }));
}

function curatorLevel(votes: number) {
  for (let i = LEVELS.length - 1; i >= 0; i--) {
    if (votes >= LEVELS[i].min) return { ...LEVELS[i], idx: i };
  }
  return { ...LEVELS[0], idx: 0 };
}

// ── Shared card style — warmer, more generous ─────────────────────────────────

const card: React.CSSProperties = {
  background: `linear-gradient(160deg, ${C.bg2} 0%, ${C.bg1} 100%)`,
  border: `1px solid ${C.border}`,
  borderRadius: "16px",
  padding: "1.5rem 1.75rem",
};

const lbl: React.CSSProperties = {
  color: C.dim, fontSize: "0.72rem", fontWeight: 700,
  textTransform: "uppercase" as const, letterSpacing: "1px", margin: 0,
};

// ── VP Arc Gauge (225°→135°, 270° sweep) ─────────────────────────────────────
// max arc y = cy(100) + r(88)×sin(135°) + stroke/2 = 100+62.2+8.5 = 170.7
// SP text at y=196, vote text at y=214 — no overlap possible.

function VpGauge({ pct, sp, voteUsd }: { pct: number; sp?: number; voteUsd?: number }) {
  const W = 240, H = 240, cx = W/2, cy = 100, r = 88, sw = 17;
  const col = vpCol(pct);
  const START = 225, SPAN = 270, valDeg = START + (pct/100)*SPAN;

  function pt(deg: number, radius = r): [number, number] {
    const rad = (deg - 90) * Math.PI / 180;
    return [cx + radius*Math.cos(rad), cy + radius*Math.sin(rad)];
  }
  function arc(from: number, to: number) {
    const [sx, sy] = pt(from), [ex, ey] = pt(to);
    const large = ((to - from + 360) % 360) > 180 ? 1 : 0;
    return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
  }

  const [tx, ty] = pt(valDeg);
  const regenH = pct >= 99.9 ? 0 : (100-pct)/20*24;
  const regenLabel = regenH===0 ? "fully charged"
    : regenH < 1 ? `${Math.round(regenH*60)}m to full`
    : `${regenH.toFixed(1)}h to full`;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <defs>
        <filter id="gvp"><feGaussianBlur stdDeviation="5" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <radialGradient id="rg" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={col} stopOpacity="0.12"/>
          <stop offset="100%" stopColor={col} stopOpacity="0"/>
        </radialGradient>
      </defs>
      <circle cx={cx} cy={cy} r={r-sw/2} fill="url(#rg)"/>
      <path d={arc(START, START+SPAN)} fill="none" stroke={C.bg3} strokeWidth={sw} strokeLinecap="round"/>
      {[65,85].map(v => {
        const d = START+(v/100)*SPAN;
        const [ix,iy] = pt(d, r-sw*0.7), [ox,oy] = pt(d, r+sw*0.7);
        return <line key={v} x1={ix.toFixed(1)} y1={iy.toFixed(1)} x2={ox.toFixed(1)} y2={oy.toFixed(1)} stroke={v===65?C.warn+"55":C.ok+"55"} strokeWidth="2.5"/>;
      })}
      <path d={arc(START, valDeg)} fill="none" stroke={col} strokeWidth={sw} strokeLinecap="round" filter="url(#gvp)"/>
      <circle cx={tx.toFixed(2)} cy={ty.toFixed(2)} r={sw*0.65} fill={col} filter="url(#gvp)"/>
      <text x={cx} y={cy-2} textAnchor="middle" fill={col} fontSize="50" fontWeight="900" fontFamily="inherit">{pct.toFixed(1)}%</text>
      <text x={cx} y={cy+24} textAnchor="middle" fill={C.dim} fontSize="11" letterSpacing="2.5" fontWeight="700">VOTING POWER</text>
      <text x={cx} y={cy+42} textAnchor="middle" fill={C.faint} fontSize="12">{regenLabel}</text>
      {sp !== undefined && voteUsd !== undefined && (
        <>
          <text x={cx} y="196" textAnchor="middle" fill={C.info} fontSize="14" fontWeight="700">{sp.toFixed(0)} SP</text>
          <text x={cx} y="214" textAnchor="middle" fill={C.faint} fontSize="12">full vote ≈ {fmtUsd(voteUsd)}</text>
        </>
      )}
    </svg>
  );
}

// ── VP Regen bar ──────────────────────────────────────────────────────────────

function VpRegenBar({ pct }: { pct: number }) {
  const col = vpCol(pct);
  const regenH = pct >= 99.9 ? 0 : (100-pct)/20*24;
  const to80 = pct >= 80 ? null : (80-pct)/20*24;
  const to90 = pct >= 90 ? null : (90-pct)/20*24;

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.5rem" }}>
      <div style={{ height: "8px", background: C.bg3, borderRadius: "4px", overflow: "hidden", position: "relative" as const }}>
        <div style={{ position: "absolute", left: "65%", top: 0, bottom: 0, width: "20%", background: C.warn+"22" }}/>
        <div style={{ position: "absolute", left: "85%", top: 0, bottom: 0, right: 0, background: C.ok+"22" }}/>
        <div style={{ height: "100%", width: `${pct}%`, background: col, borderRadius: "4px", transition: "width 0.6s ease", boxShadow: `0 0 10px ${col}66` }}/>
      </div>
      <div style={{ display: "flex", gap: "0.75rem", fontSize: "0.72rem", flexWrap: "wrap" as const }}>
        {to80 !== null && <span style={{ color: C.warn }}>→ 80% in {to80<1?`${Math.round(to80*60)}m`:`${to80.toFixed(1)}h`}</span>}
        {to90 !== null && <span style={{ color: C.ok }}>→ 90% in {to90<1?`${Math.round(to90*60)}m`:`${to90.toFixed(1)}h`}</span>}
        {regenH > 0 && <span style={{ color: C.faint, marginLeft: "auto" }}>full in {regenH<1?`${Math.round(regenH*60)}m`:`${regenH.toFixed(1)}h`}</span>}
        {regenH === 0 && <span style={{ color: C.ok, marginLeft: "auto" }}>✓ fully charged</span>}
      </div>
    </div>
  );
}

// ── VP 7-day projection ───────────────────────────────────────────────────────

function VpProjection({ vpPct, votesPerDayR, avgWeight }: { vpPct: number; votesPerDayR: number; avgWeight: number }) {
  const spend = votesPerDayR*avgWeight/100, net = 20-spend;
  const days  = Array.from({ length: 8 }, (_, i) => Math.max(0, Math.min(100, vpPct+net*i)));
  const maxV  = Math.max(...days,1), minV = Math.min(...days,0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: "4px", height: "64px" }}>
        {days.map((v, i) => (
          <div key={i} title={`+${i}d: ${v.toFixed(0)}%`} style={{
            flex: 1, height: `${Math.max(8,((v-minV)/(maxV-minV||1))*58+6)}px`,
            background: vpCol(v)+(i===0?"ff":"55"), borderRadius: "3px 3px 0 0", alignSelf: "flex-end",
          }}/>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "6px", fontSize: "0.72rem" }}>
        <span style={{ color: C.faint }}>Today</span>
        <span style={{ color: vpCol(days[7]), fontWeight: 700 }}>+7d: {days[7].toFixed(0)}%{net>=0?" ↗":" ↘"}</span>
      </div>
    </div>
  );
}

// ── Votes per day (last 7d) ───────────────────────────────────────────────────

function VotesPerDayChart({ votes }: { votes: RecentVote[] }) {
  const data  = votesPerDay(votes);
  const maxC  = Math.max(...data.map(d => d.count), 1);
  const total = data.reduce((s, d) => s+d.count, 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: "5px", height: "56px" }}>
        {data.map((d, i) => (
          <div key={d.day} style={{ flex: 1, display: "flex", flexDirection: "column" as const, alignItems: "center" }}>
            <div title={`${d.day}: ${d.count}`} style={{
              width: "100%", height: `${Math.max(3,(d.count/maxC)*48)}px`,
              background: d.count===0 ? C.bg3 : i===data.length-1 ? C.info : C.info+"66",
              borderRadius: "3px 3px 0 0",
            }}/>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: "5px", marginTop: "4px" }}>
        {data.map(d => <div key={d.day} style={{ flex: 1, textAlign: "center" as const, fontSize: "0.62rem", color: C.faint }}>{d.short}</div>)}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "4px", fontSize: "0.72rem" }}>
        <span style={{ color: C.faint }}>Last 7 days</span>
        <span style={{ color: C.info, fontWeight: 700 }}>{total} votes</span>
      </div>
    </div>
  );
}

// ── Growth chart — real data only ─────────────────────────────────────────────

function GrowthChart({ growth, t }: { growth: GrowthData; t: ReturnType<typeof createTranslator> }) {
  const data  = growth.dataPoints.filter(d => d.cumVotes > 0 || d.cumAuthors > 0);
  const total = growth.summary.totalVotes;

  // Three states: no votes at all, some votes but few points, enough for chart
  if (total === 0) {
    return (
      <div style={{ textAlign: "center", padding: "1.5rem 0.5rem" }}>
        <div style={{ fontSize: "2.5rem", marginBottom: "0.6rem" }}>🌱</div>
        <p style={{ color: C.text, fontSize: "0.9rem", fontWeight: 700, margin: "0 0 0.4rem" }}>{t("growthEmptyZero")}</p>
        <p style={{ color: C.muted, fontSize: "0.78rem", margin: 0, lineHeight: 1.55 }}>{t("growthEmptyZeroSub")}</p>
      </div>
    );
  }
  if (data.length < 3) {
    return (
      <div style={{ textAlign: "center", padding: "1rem 0.5rem" }}>
        <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>📈</div>
        <p style={{ color: C.text, fontSize: "0.88rem", fontWeight: 700, margin: "0 0 0.3rem" }}>{t("growthEmptyFew")}</p>
        <p style={{ color: C.muted, fontSize: "0.75rem", margin: "0 0 0.75rem", lineHeight: 1.5 }}>{t("growthEmptyFewSub")}</p>
        <div style={{ display: "flex", justifyContent: "center", gap: "1.5rem", fontSize: "0.82rem" }}>
          <span style={{ color: C.info }}><b style={{ fontSize: "1.4rem", fontWeight: 900 }}>{total}</b><br/><span style={{ color: C.faint }}>{t("growthVotesCast")}</span></span>
          <span style={{ color: C.purple }}><b style={{ fontSize: "1.4rem", fontWeight: 900 }}>{growth.summary.totalUniqueAuthors}</b><br/><span style={{ color: C.faint }}>{t("growthUniqueAuthors")}</span></span>
        </div>
      </div>
    );
  }

  const W = 600, H = 140;
  const padL=4, padR=4, padT=8, padB=20;
  const cW=W-padL-padR, cH=H-padT-padB;
  const maxVotes   = Math.max(...data.map(d => d.cumVotes),  1);
  const maxAuthors = Math.max(...data.map(d => d.cumAuthors), 1);
  const maxDayV    = Math.max(...data.map(d => d.votes), 1);
  const n          = data.length;

  function xPos(i: number)    { return padL+(i/(n-1))*cW; }
  function yVotes(v: number)  { return padT+cH-(v/maxVotes)*cH; }
  function yAuthors(v: number){ return padT+cH-(v/maxAuthors)*cH; }

  const votesPath = data.map((d,i) => `${i===0?"M":"L"} ${xPos(i).toFixed(1)} ${yVotes(d.cumVotes).toFixed(1)}`).join(" ");
  const authPath  = data.map((d,i) => `${i===0?"M":"L"} ${xPos(i).toFixed(1)} ${yAuthors(d.cumAuthors).toFixed(1)}`).join(" ");
  const fillPath  = `${votesPath} L ${(padL+cW).toFixed(1)} ${(padT+cH).toFixed(1)} L ${padL.toFixed(1)} ${(padT+cH).toFixed(1)} Z`;
  const labelIdxs = [0, Math.floor((n-1)/2), n-1];

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }} preserveAspectRatio="none">
        <defs>
          <linearGradient id="gFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.info} stopOpacity="0.2"/>
            <stop offset="100%" stopColor={C.info} stopOpacity="0"/>
          </linearGradient>
        </defs>
        {[0.25,0.5,0.75].map(f => (
          <line key={f} x1={padL} y1={padT+cH*(1-f)} x2={padL+cW} y2={padT+cH*(1-f)} stroke={C.border} strokeWidth="1"/>
        ))}
        {data.map((d,i) => d.votes>0 && (
          <rect key={i} x={xPos(i)-Math.max(1,cW/n/2)} y={padT+cH-(d.votes/maxDayV)*(cH*0.35)}
            width={Math.max(2,cW/n-1)} height={(d.votes/maxDayV)*(cH*0.35)} fill={C.info+"1a"} rx="1"/>
        ))}
        <path d={fillPath} fill="url(#gFill)"/>
        <path d={votesPath} fill="none" stroke={C.info} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
        <path d={authPath}  fill="none" stroke={C.purple} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="4 3"/>
        <circle cx={xPos(n-1).toFixed(1)} cy={yVotes(data[n-1].cumVotes).toFixed(1)} r="4" fill={C.info}/>
        <circle cx={xPos(n-1).toFixed(1)} cy={yAuthors(data[n-1].cumAuthors).toFixed(1)} r="3" fill={C.purple}/>
        {labelIdxs.map(i => (
          <text key={i} x={xPos(i)} y={H-4} textAnchor="middle" fill={C.faint} fontSize="9">{data[i].day.slice(5)}</text>
        ))}
      </svg>
      <div style={{ display: "flex", gap: "1.25rem", marginTop: "8px", fontSize: "0.73rem" }}>
        <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <span style={{ display: "inline-block", width: "18px", height: "3px", background: C.info, borderRadius: "2px" }}/>
          <span style={{ color: C.muted }}>{t("growthCumVotes")} ({data[n-1].cumVotes.toLocaleString()})</span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <span style={{ display: "inline-block", width: "18px", borderTop: `2px dashed ${C.purple}` }}/>
          <span style={{ color: C.muted }}>{t("growthCumAuthors")} ({data[n-1].cumAuthors})</span>
        </span>
      </div>
    </div>
  );
}

// ── Curator Level + Progress ──────────────────────────────────────────────────

function CuratorProgress({ totalVotes, totalAuthors, t }: {
  totalVotes: number; totalAuthors: number; t: ReturnType<typeof createTranslator>;
}) {
  const level    = curatorLevel(totalVotes);
  const isMax    = level.idx === LEVELS.length - 1;
  const nextThr  = isMax ? totalVotes : LEVELS[level.idx + 1].min;
  const pct      = isMax ? 100 : Math.min(100, ((totalVotes-level.min)/(nextThr-level.min))*100);
  const remaining = isMax ? 0 : nextThr - totalVotes;

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: "1rem" }}>
      {/* Badge */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.85rem" }}>
        <div style={{ fontSize: "2.2rem", lineHeight: 1, filter: `drop-shadow(0 0 8px ${level.color}88)` }}>{level.emoji}</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "5px" }}>
            <span style={{ color: level.color, fontWeight: 800, fontSize: "1rem" }}>{t(level.key)}</span>
            <span style={{ color: level.color, fontWeight: 700, fontSize: "0.78rem" }}>{pct.toFixed(0)}%</span>
          </div>
          <div style={{ height: "10px", background: C.bg3, borderRadius: "5px", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: `linear-gradient(90deg, ${level.color}aa, ${level.color})`, borderRadius: "5px", transition: "width 0.7s ease", boxShadow: `0 0 10px ${level.color}55` }}/>
          </div>
          <p style={{ color: C.faint, fontSize: "0.7rem", margin: "4px 0 0" }}>
            {isMax ? t("levelMaxReached") : `${remaining.toLocaleString()} ${t("levelProgressLabel")}`}
          </p>
        </div>
      </div>

      {/* Level track */}
      <div style={{ display: "flex", gap: "3px", alignItems: "center" }}>
        {LEVELS.map((l, i) => (
          <div key={l.key} style={{ flex: i===LEVELS.length-1?2:1, height: "5px", borderRadius: "3px", background: i<=level.idx ? l.color : C.bg3, transition: "background 0.4s" }} title={t(l.key)}/>
        ))}
      </div>

      {/* Two numbers */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
        <div style={{ textAlign: "center" as const, padding: "0.85rem 0.5rem", background: `linear-gradient(135deg, ${C.info}12, ${C.bg3})`, border: `1px solid ${C.info}25`, borderRadius: "12px" }}>
          <div style={{ color: C.info, fontSize: "2rem", fontWeight: 900, lineHeight: 1 }}>{totalVotes.toLocaleString()}</div>
          <div style={{ color: C.faint, fontSize: "0.62rem", marginTop: "0.2rem", letterSpacing: "0.6px", textTransform: "uppercase" as const }}>{t("growthVotesCast")}</div>
        </div>
        <div style={{ textAlign: "center" as const, padding: "0.85rem 0.5rem", background: `linear-gradient(135deg, ${C.purple}12, ${C.bg3})`, border: `1px solid ${C.purple}25`, borderRadius: "12px" }}>
          <div style={{ color: C.purple, fontSize: "2rem", fontWeight: 900, lineHeight: 1 }}>{totalAuthors}</div>
          <div style={{ color: C.faint, fontSize: "0.62rem", marginTop: "0.2rem", letterSpacing: "0.6px", textTransform: "uppercase" as const }}>{t("growthUniqueAuthors")}</div>
        </div>
      </div>
    </div>
  );
}

// ── Impact Metrics ────────────────────────────────────────────────────────────

function ImpactMetrics({ growth, curationProfile, t }: {
  growth: GrowthData | null; curationProfile: CurationProfile | null;
  t: ReturnType<typeof createTranslator>;
}) {
  const s = growth?.summary;
  const rows: Array<{ label: string; value: string; color: string }> = [];

  if (s) {
    if (s.currentStreak > 0) rows.push({ label: t("growthCurrentStreak"), value: `${s.currentStreak} ${t("growthDays")}`, color: C.warn });
    if (s.longestStreak > 0) rows.push({ label: t("growthLongestStreak"), value: `${s.longestStreak} ${t("growthDays")}`, color: C.ok });
    rows.push({ label: t("growthActiveDays"), value: `${s.activeDays}`, color: C.info });
    if (s.firstVoteAt) rows.push({ label: t("growthFirstVote"), value: s.firstVoteAt, color: C.faint });
  }
  if (curationProfile?.topAuthors[0]) {
    const top = curationProfile.topAuthors[0];
    rows.push({ label: t("strongestBond"), value: `@${top.username} · ${top.voteCount}v`, color: C.purple });
  }

  if (rows.length === 0) return <p style={{ color: C.faint, fontSize: "0.8rem", margin: 0 }}>—</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.5rem" }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.78rem", padding: "0.35rem 0", borderBottom: i<rows.length-1?`1px solid ${C.border}`:"none" }}>
          <span style={{ color: C.muted }}>{r.label}</span>
          <span style={{ color: r.color, fontWeight: 700 }}>{r.value}</span>
        </div>
      ))}
      <p style={{ color: C.faint, fontSize: "0.65rem", margin: "0.25rem 0 0", lineHeight: 1.4 }}>
        {t("growthNoImpactData")} — {t("growthNoImpactSub")}
      </p>
    </div>
  );
}

// ── Peak hours chart ──────────────────────────────────────────────────────────

function PeakHoursChart({ hours }: { hours: Array<{ hour: number; voteCount: number }> }) {
  if (hours.length === 0) return null;
  const maxV = Math.max(...hours.map(h => h.voteCount), 1);
  const full = Array.from({ length: 24 }, (_, i) => ({ h: i, v: hours.find(x => x.hour===i)?.voteCount??0 }));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: "2px", height: "32px" }}>
        {full.map(({ h, v }) => (
          <div key={h} title={`${String(h).padStart(2,"0")}:00 UTC — ${v} votes`} style={{
            flex: 1, height: `${Math.max(2,(v/maxV)*28)}px`,
            background: v===0 ? C.bg3 : C.purple+(v===maxV?"ff":"88"),
            borderRadius: "1px 1px 0 0", alignSelf: "flex-end",
          }}/>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "4px", fontSize: "0.63rem", color: C.faint }}>
        <span>00:00</span>
        <span style={{ color: C.purple }}>Peak: {String(hours[0].hour).padStart(2,"0")}:00 UTC</span>
        <span>23:00</span>
      </div>
    </div>
  );
}

// ── Top authors chart ─────────────────────────────────────────────────────────

function TopAuthorsChart({ authors }: { authors: CurationProfile["topAuthors"] }) {
  const top = authors.slice(0,6);
  if (top.length===0) return null;
  const maxPct = Math.max(...top.map(a => a.sharePct), 1);

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.5rem" }}>
      {top.map((a, i) => (
        <div key={a.username} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ color: C.faint, fontSize: "0.65rem", width: "14px", textAlign: "right" as const, flexShrink: 0 }}>#{i+1}</span>
          <span style={{ color: C.info, fontSize: "0.75rem", fontWeight: 600, width: "90px", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>@{a.username}</span>
          <div style={{ flex: 1, height: "6px", background: C.bg3, borderRadius: "3px", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(a.sharePct/maxPct)*100}%`, background: `linear-gradient(90deg, ${C.purple}88, ${C.purple})`, borderRadius: "3px" }}/>
          </div>
          <span style={{ color: C.muted, fontSize: "0.72rem", width: "34px", textAlign: "right" as const, flexShrink: 0 }}>{a.sharePct}%</span>
          <span style={{ color: C.faint, fontSize: "0.68rem", width: "26px", textAlign: "right" as const, flexShrink: 0 }}>{a.voteCount}v</span>
        </div>
      ))}
    </div>
  );
}

// ── Category donut ────────────────────────────────────────────────────────────

function CategoryDonut({ rules, t }: { rules: StrategyRuleLite[]; t: ReturnType<typeof createTranslator> }) {
  const total = rules.length || 1;
  const cats  = Object.keys(CAT_DEF).filter(c => rules.some(r => r.category===c));
  const cx=52, cy=52, r=36, sw=14;
  let angle = -90;

  const slices = cats.map(c => {
    const n = rules.filter(r => r.category===c).length;
    const pct=n/total, deg=pct*360;
    function pp(d: number) {
      const rad=(d-90)*Math.PI/180;
      return { x:(cx+r*Math.cos(rad)).toFixed(1), y:(cy+r*Math.sin(rad)).toFixed(1) };
    }
    const s=pp(angle), e=pp(angle+deg);
    const d=`M ${s.x} ${s.y} A ${r} ${r} 0 ${deg>180?1:0} 1 ${e.x} ${e.y}`;
    angle+=deg;
    return { c, n, d, pct };
  }).filter(s => s.n>0);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
      <svg width={104} height={104} viewBox="0 0 104 104" style={{ flexShrink: 0 }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.bg3} strokeWidth={sw}/>
        {slices.map(s => <path key={s.c} d={s.d} fill="none" stroke={CAT_DEF[s.c].color} strokeWidth={sw} strokeLinecap="butt"/>)}
        <text x={cx} y={cy+6} textAnchor="middle" fill={C.text} fontSize="15" fontWeight="800">{rules.length}</text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.3rem" }}>
        {slices.map(s => (
          <div key={s.c} style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.75rem" }}>
            <div style={{ width: "8px", height: "8px", borderRadius: "2px", background: CAT_DEF[s.c].color, flexShrink: 0 }}/>
            <span style={{ color: C.muted, minWidth: "60px" }}>{CAT_DEF[s.c].icon} {t(CAT_DEF[s.c].tKey)}</span>
            <span style={{ color: C.text, fontWeight: 700 }}>{s.n}</span>
            <span style={{ color: C.faint }}>({Math.round(s.pct*100)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Compact author card ───────────────────────────────────────────────────────

function AuthorCard({ rule, openPost, voteUsd, dnaData, t }: {
  rule: StrategyRuleLite; openPost: PostOpportunity | undefined;
  voteUsd: number; dnaData: CurationProfile["topAuthors"][number] | undefined;
  t: ReturnType<typeof createTranslator>;
}) {
  const cat    = CAT_DEF[rule.category] ?? { color: C.dim, icon: "⚪", tKey: "catNormal" as TranslationKey, pri: 2 };
  const estUsd = Math.round(rule.maxWeightPct/100*voteUsd*10000)/10000;
  const initial = rule.username[0]?.toUpperCase() ?? "?";

  return (
    <div style={{ background: openPost?cat.color+"0a":C.bg3, border: `1px solid ${openPost?cat.color+"55":C.border}`, borderRadius: "10px", padding: "0.75rem 0.9rem", display: "flex", alignItems: "flex-start", gap: "0.65rem" }}>
      <div style={{ width: "34px", height: "34px", borderRadius: "50%", flexShrink: 0, background: cat.color+"20", border: `2px solid ${cat.color}44`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.88rem", fontWeight: 800, color: cat.color }}>{initial}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", flexWrap: "wrap" as const, marginBottom: "0.15rem" }}>
          <span style={{ color: C.info, fontWeight: 700, fontSize: "0.82rem" }}>@{rule.username}</span>
          <span style={{ background: cat.color+"1a", color: cat.color, border: `1px solid ${cat.color}33`, borderRadius: "3px", padding: "0 0.28rem", fontSize: "0.62rem", fontWeight: 700 }}>{cat.icon} {t(cat.tKey)}</span>
          {openPost && <span style={{ background: cat.color+"22", color: cat.color, borderRadius: "8px", padding: "0 0.32rem", fontSize: "0.62rem", fontWeight: 700 }}>⚡ {t("actNewPost")}</span>}
        </div>
        <div style={{ display: "flex", gap: "0.45rem", fontSize: "0.74rem" }}>
          <span style={{ color: cat.color, fontWeight: 700 }}>{rule.maxWeightPct}%</span>
          <span style={{ color: C.faint }}>·</span>
          <span style={{ color: C.ok }}>{fmtUsd(estUsd)}</span>
          {dnaData && <><span style={{ color: C.faint }}>·</span><span style={{ color: C.faint }}>{dnaData.voteCount}v</span></>}
        </div>
        {openPost && (
          <div style={{ marginTop: "0.28rem", background: cat.color+"12", borderRadius: "5px", padding: "0.2rem 0.4rem", fontSize: "0.68rem" }}>
            <span style={{ color: cat.color, fontWeight: 600 }}>{fmtMin(openPost.ageMinutes)} ago</span>
            <span style={{ color: C.faint }}> · "{openPost.title.slice(0,32)}{openPost.title.length>32?"…":""}"</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Activity timeline ─────────────────────────────────────────────────────────

function ActivityTimeline({ votes, voteUsd, dnaAuthors, opps, onAction, t }: {
  votes: RecentVote[]; voteUsd: number;
  dnaAuthors: CurationProfile["topAuthors"]; opps: PostOpportunity[] | null;
  onAction: { plan: () => void; opps: () => void; dna: () => void };
  t: ReturnType<typeof createTranslator>;
}) {
  const dnaMap   = new Map(dnaAuthors.map(a => [a.username, a]));
  const eligible = opps?.filter(p => p.eligible) ?? [];

  if (votes.length===0 && eligible.length===0) {
    return (
      <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.5rem" }}>
        <div style={{ textAlign: "center", padding: "0.75rem 0 1rem" }}>
          <div style={{ fontSize: "1.8rem", marginBottom: "0.3rem" }}>🌱</div>
          <p style={{ color: C.muted, fontSize: "0.85rem", fontWeight: 600, margin: "0 0 0.15rem" }}>{t("actNoActivity")}</p>
          <p style={{ color: C.faint, fontSize: "0.75rem", margin: 0 }}>{t("actStartTimeline")}</p>
        </div>
        {([
          { icon: "⚡", label: t("btnFindOpps"),    col: C.warn,   fn: onAction.opps },
          { icon: "🗳",  label: t("btnGeneratePlan"), col: C.purple, fn: onAction.plan },
          { icon: "🧬", label: t("btnDeepStrategy"), col: C.info,   fn: onAction.dna  },
        ] as const).map(a => (
          <button key={a.label} type="button" onClick={a.fn} style={{ background: a.col+"10", border: `1px solid ${a.col}33`, borderRadius: "9px", color: a.col, cursor: "pointer", fontSize: "0.82rem", padding: "0.6rem 0.9rem", textAlign: "left" as const, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span>{a.icon}</span><span style={{ fontWeight: 600 }}>{a.label}</span>
          </button>
        ))}
      </div>
    );
  }

  const items: Array<{ col: string; icon: string; line1: string; line2: string; right: string }> = [];
  eligible.slice(0,3).forEach(p => {
    const w = p.postScore>=80?t("oppOptimalWindow"):p.postScore>=50?t("oppGoodWindow"):t("oppLateWindow");
    items.push({ col: C.warn, icon: "⚡", line1: `@${p.author}`, line2: `${t("actNewPost")} · ${fmtMin(p.ageMinutes)} ago · ${w}`, right: t("actOpen") });
  });
  votes.slice(0,10).forEach(v => {
    const dna = dnaMap.get(v.author);
    const usd = v.weightPct/100*voteUsd;
    items.push({ col: C.ok, icon: "✓", line1: `@${v.author}`, line2: `${v.weightPct}% vote${dna?` · ${dna.voteCount} total`:""}`, right: `+${fmtUsd(usd)} · ${fmtAgeIso(v.votedAt, t)}` });
  });

  return (
    <div>
      {items.map((item, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: "0.65rem", padding: "0.6rem 0", borderBottom: i<items.length-1?`1px solid ${C.border}`:"none" }}>
          <div style={{ width: "28px", height: "28px", borderRadius: "50%", flexShrink: 0, background: item.col+"18", border: `1.5px solid ${item.col}44`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.8rem" }}>{item.icon}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: C.info, fontWeight: 700, fontSize: "0.8rem" }}>{item.line1}</div>
            <div style={{ color: C.faint, fontSize: "0.7rem" }}>{item.line2}</div>
          </div>
          <div style={{ color: C.muted, fontSize: "0.68rem", flexShrink: 0, textAlign: "right" as const, whiteSpace: "nowrap" as const }}>{item.right}</div>
        </div>
      ))}
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export function UserDashboard(props: {
  session: AuthSession;
  locale: Locale;
  snapshot: SteemAccountSnapshot | null;
  snapshotLoading: boolean;
  snapshotRefreshedAt?: Date;
  strategyRules: StrategyRuleLite[] | null;
  opportunities: PostOpportunity[] | null;
  opportunitiesLoading: boolean;
  opportunitiesMeta: OpportunitiesMeta | null;
  votePlan: VotePlanResponse | null;
  curationProfile: CurationProfile | null;
  recentVotes: RecentVote[];
  onTabChange: (tab: "dna" | "dashboard" | "community" | "billing") => void;
  onGenerateVotes: () => void;
  onLoadOpportunities: () => void;
  onRefreshSnapshot?: () => void;
}) {
  const t = createTranslator(props.locale);
  const { snapshot, strategyRules, opportunities, opportunitiesMeta, votePlan, curationProfile, recentVotes } = props;

  const vpPct      = snapshot ? snapshot.votingPowerBps/100 : null;
  const rules      = sortRules(strategyRules ?? []);
  const openOpps   = opportunities?.filter(p => p.eligible) ?? [];
  const oppMap     = new Map(openOpps.map(p => [p.author, p]));
  const dnaAuthors = curationProfile?.topAuthors ?? [];
  const dnaMap     = new Map(dnaAuthors.map(a => [a.username, a]));
  const avgWeight  = rules.length>0 ? rules.reduce((s,r)=>s+r.maxWeightPct,0)/rules.length : 0;
  const sessionUsd = recentVotes.reduce((s,v)=>s+v.weightPct/100*(snapshot?.currentVoteUsd??0),0);
  const noPostAuthors = opportunitiesMeta ? Object.values(opportunitiesMeta.perAuthor).filter(v=>v.noRecentPosts).length : null;

  // Translate DNA label from backend
  const dnaLabelKey = curationProfile ? DNA_LABEL_MAP[curationProfile.dnaLabel] : undefined;
  const dnaLabelTranslated = curationProfile
    ? (dnaLabelKey ? t(dnaLabelKey) : curationProfile.dnaLabel)
    : "";

  // Conviction / self-vote labels
  const dnaConviction = (curationProfile?.avgWeightPct??0)>=70 ? t("dnaHighConviction")
    : (curationProfile?.avgWeightPct??0)>=45 ? t("dnaBalanced") : t("dnaExploratory");
  const dnaSelfNote = (curationProfile?.selfVotePct??0)<5 ? t("dnaCommunityFirst")
    : (curationProfile?.selfVotePct??0)>20 ? t("dnaSelfFocused") : "";

  // Growth data
  const [growthData, setGrowthData]     = useState<GrowthData | null>(null);
  const [growthLoading, setGrowthLoading] = useState(false);
  const [growthPeriod, setGrowthPeriod] = useState<"30d"|"90d"|"all">("30d");

  useEffect(() => {
    setGrowthLoading(true);
    fetchGrowthData(props.session.token, growthPeriod)
      .then(setGrowthData)
      .catch(() => {})
      .finally(() => setGrowthLoading(false));
  }, [props.session.token, growthPeriod]);

  const showGrowthPanel = curationProfile || (growthData && growthData.summary.totalVotes > 0);

  return (
    <div style={{ padding: "1.5rem 2rem", display: "flex", flexDirection: "column", gap: "1.5rem" }}>

      {/* ── DNA Stats Strip ──────────────────────────────────────────── */}
      {curationProfile ? (
        <div style={{
          background: `linear-gradient(135deg, ${C.bg2} 0%, ${C.bg1} 100%)`,
          border: `1px solid ${C.border}`, borderRadius: "16px", padding: "1.25rem 1.75rem",
          display: "flex", alignItems: "stretch", gap: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.85rem", paddingRight: "1.75rem", marginRight: "1.75rem", borderRight: `1px solid ${C.border2}`, flexShrink: 0 }}>
            <span style={{ fontSize: "2.2rem", filter: `drop-shadow(0 0 10px ${C.purple}55)` }}>{DNA_EMOJI[curationProfile.dnaLabel] ?? "⚪"}</span>
            <div>
              <div style={{ color: C.info, fontWeight: 800, fontSize: "1rem" }}>{dnaLabelTranslated}</div>
              <div style={{ color: C.faint, fontSize: "0.72rem", marginTop: "2px" }}>{dnaConviction}{dnaSelfNote?` · ${dnaSelfNote}`:""}</div>
            </div>
          </div>
          {([
            { val: curationProfile.votesAnalyzed,              fmt: (v:number)=>v.toLocaleString(), label: t("kpiVotesCast"),  color: C.info   },
            { val: curationProfile.uniqueAuthors,               fmt: (v:number)=>String(v),         label: t("kpiAuthors"),   color: C.purple },
            { val: curationProfile.periodDays,                  fmt: (v:number)=>`${v}d`,           label: t("kpiHistory"),   color: C.teal   },
            { val: curationProfile.avgWeightPct,                fmt: (v:number)=>`${v}%`,           label: t("kpiAvgWeight"), color: vpCol(curationProfile.avgWeightPct) },
            { val: Math.round(curationProfile.votesPerDay*10)/10, fmt:(v:number)=>`${v}`,           label: t("kpiVotesDay"),  color: C.warn   },
          ] as const).map((s, i) => (
            <div key={i} style={{ flex: 1, textAlign: "center" as const, padding: "0 0.5rem" }}>
              <div style={{ color: s.color, fontSize: "2.8rem", fontWeight: 900, lineHeight: 1, letterSpacing: "-1px" }}>{s.fmt(s.val)}</div>
              <div style={{ color: C.faint, fontSize: "0.66rem", fontWeight: 700, letterSpacing: "1px", marginTop: "0.3rem" }}>{s.label}</div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ ...card, display: "flex", alignItems: "center", gap: "0.85rem", padding: "1.1rem 1.5rem" }}>
          <span style={{ fontSize: "1.6rem" }}>🧬</span>
          <span style={{ color: C.muted, fontSize: "0.88rem", flex: 1, lineHeight: 1.5 }}>{t("emptyDnaHint")}</span>
          <button type="button" onClick={() => props.onTabChange("dna")} style={{ background: C.info+"22", border: `1px solid ${C.info}`, borderRadius: "8px", color: C.info, cursor: "pointer", fontSize: "0.82rem", padding: "0.45rem 1rem", fontWeight: 700, flexShrink: 0 }}>
            {t("btnAnalyzeDna")}
          </button>
        </div>
      )}

      {/* ── Growth Panel ─────────────────────────────────────────────── */}
      {showGrowthPanel && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.8fr 1fr", gap: "1.5rem", alignItems: "start" }}>
          <div style={card}>
            <p style={{ ...lbl, marginBottom: "1.1rem" }}>{t("secCuratorLevel")}</p>
            <CuratorProgress
              totalVotes={growthData?.summary.totalVotes ?? curationProfile?.votesAnalyzed ?? 0}
              totalAuthors={growthData?.summary.totalUniqueAuthors ?? curationProfile?.uniqueAuthors ?? 0}
              t={t}
            />
          </div>
          <div style={card}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
              <p style={lbl}>{t("secGrowth")}</p>
              <div style={{ display: "flex", gap: "0.3rem" }}>
                {(["30d","90d","all"] as const).map(p => (
                  <button key={p} type="button" onClick={() => setGrowthPeriod(p)} style={{
                    background: growthPeriod===p ? C.info+"22" : "none",
                    border: `1px solid ${growthPeriod===p ? C.info : C.border}`,
                    borderRadius: "6px", color: growthPeriod===p ? C.info : C.faint,
                    cursor: "pointer", fontSize: "0.7rem", padding: "0.18rem 0.5rem", fontWeight: 600,
                  }}>
                    {p==="30d"?t("growthPeriod30d"):p==="90d"?t("growthPeriod90d"):t("growthPeriodAll")}
                  </button>
                ))}
              </div>
            </div>
            {growthLoading
              ? <p style={{ color: C.faint, fontSize: "0.82rem", margin: 0 }}>{t("growthLoading")}</p>
              : growthData ? <GrowthChart growth={growthData} t={t}/> : null}
          </div>
          <div style={card}>
            <p style={{ ...lbl, marginBottom: "1rem" }}>{t("secImpact")}</p>
            <ImpactMetrics growth={growthData} curationProfile={curationProfile} t={t}/>
          </div>
        </div>
      )}

      {/* ── VP hero + KPI tiles ──────────────────────────────────────── */}
      <div style={{ display: "flex", gap: "1.5rem", alignItems: "stretch" }}>
        <div style={{ ...card, padding: "1.1rem 1.25rem", display: "flex", flexDirection: "column" as const, alignItems: "center", minWidth: "265px", width: "265px", flexShrink: 0 }}>
          <div style={{ display: "flex", width: "100%", justifyContent: "space-between", alignItems: "center", marginBottom: "0.1rem" }}>
            <span style={lbl}>{t("kpiVotingPower")}</span>
            {props.onRefreshSnapshot && <button type="button" onClick={props.onRefreshSnapshot} disabled={props.snapshotLoading} style={{ background: "none", border: "none", cursor: "pointer", color: props.snapshotLoading?C.faint:C.muted, fontSize: "0.95rem", padding: 0 }}>↻</button>}
          </div>
          {vpPct !== null ? (
            <>
              <VpGauge pct={vpPct} sp={snapshot?.steemPowerSp} voteUsd={snapshot?.fullPowerVoteUsd}/>
              <div style={{ width: "100%", marginTop: "0.5rem" }}><VpRegenBar pct={vpPct}/></div>
            </>
          ) : (
            <div style={{ height: "240px", display: "flex", alignItems: "center", justifyContent: "center", color: C.faint }}>{props.snapshotLoading?"Loading…":"—"}</div>
          )}
          {props.snapshotRefreshedAt && <div style={{ color: C.faint, fontSize: "0.65rem", marginTop: "0.5rem" }}>{fmtAgeIso(props.snapshotRefreshedAt.toISOString(), t)}</div>}
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column" as const, gap: "1.5rem" }}>
          <div style={{ display: "flex", gap: "1.5rem", flex: 1 }}>
            {/* Vote Value */}
            <div style={{ ...card, flex: 1, display: "flex", flexDirection: "column" as const, justifyContent: "space-between" }}>
              <span style={lbl}>{t("kpiVoteValueNow")}</span>
              <div style={{ color: vpPct?vpCol(vpPct):C.dim, fontSize: "3rem", fontWeight: 900, lineHeight: 1, letterSpacing: "-1.5px", margin: "0.5rem 0 0.4rem" }}>{snapshot?fmtUsd(snapshot.currentVoteUsd):"—"}</div>
              <div style={{ fontSize: "0.77rem" }}>
                {snapshot && <span style={{ color: C.faint }}>Full: <b style={{ color: C.text }}>{fmtUsd(snapshot.fullPowerVoteUsd)}</b></span>}
                {vpPct && vpPct<80 && <span style={{ color: C.warn, marginLeft: "0.5rem" }}>⚠ {t("vpRecovering")}</span>}
              </div>
            </div>
            {/* Opportunities */}
            <div onClick={() => { props.onLoadOpportunities(); props.onTabChange("dna"); }} style={{ ...card, flex: 1, display: "flex", flexDirection: "column" as const, justifyContent: "space-between", cursor: "pointer", border: `1px solid ${openOpps.length>0?C.warn+"55":C.border}`, boxShadow: openOpps.length>0?`0 0 24px ${C.warn}18`:"none" }}>
              <span style={lbl}>{t("kpiOpenOpps")}</span>
              <div style={{ color: openOpps.length>0?C.warn:opportunities!==null?C.ok:C.dim, fontSize: "3rem", fontWeight: 900, lineHeight: 1, letterSpacing: "-1.5px", margin: "0.5rem 0 0.4rem" }}>{openOpps.length>0?openOpps.length:opportunities===null?"—":"0"}</div>
              <div style={{ fontSize: "0.77rem", display: "flex", flexDirection: "column" as const, gap: "0.15rem" }}>
                {openOpps.length>0 && <span style={{ color: C.warn }}>{openOpps.filter(p=>p.postScore>=80).length} {t("oppOptimalWindow")}</span>}
                {opportunitiesMeta && <span style={{ color: C.faint }}>{opportunitiesMeta.scannedAuthors}/{opportunitiesMeta.requestedAuthors} {t("oppScanned")}</span>}
                {noPostAuthors!==null && noPostAuthors>0 && <span style={{ color: C.faint }}>{noPostAuthors} {t("oppInactive")}</span>}
                {opportunities===null && <span style={{ color: C.muted }}>{t("oppTapToDiscover")}</span>}
                {opportunities!==null && openOpps.length===0 && recentVotes.length>0 && <span style={{ color: C.info }}>{t("oppVotedRescan")}</span>}
              </div>
            </div>
            {/* Session */}
            <div style={{ ...card, flex: 1, display: "flex", flexDirection: "column" as const, justifyContent: "space-between" }}>
              <span style={lbl}>{t("kpiSessionImpact")}</span>
              <div style={{ color: recentVotes.length>0?C.ok:C.purple, fontSize: "3rem", fontWeight: 900, lineHeight: 1, letterSpacing: "-1.5px", margin: "0.5rem 0 0.4rem" }}>{recentVotes.length>0?fmtUsd(sessionUsd):"—"}</div>
              <div style={{ fontSize: "0.77rem", display: "flex", flexDirection: "column" as const, gap: "0.15rem" }}>
                {recentVotes.length>0 ? <span style={{ color: C.faint }}>{recentVotes.length} vote{recentVotes.length>1?"s":""} {t("actVotesInSession")}</span> : <span style={{ color: C.faint }}>{t("emptyNoVotesToday")}</span>}
                {curationProfile && snapshot && <span style={{ color: C.purple }}>~{fmtUsd(curationProfile.votesPerDay*30*snapshot.currentVoteUsd*avgWeight/100)}/mo est.</span>}
              </div>
            </div>
          </div>
          {/* Charts sub-row */}
          <div style={{ display: "flex", gap: "1.5rem" }}>
            <div style={{ ...card, flex: 1 }}>
              <p style={{ ...lbl, marginBottom: "0.85rem" }}>{t("secVpProjection")}</p>
              {vpPct!==null && curationProfile ? <VpProjection vpPct={vpPct} votesPerDayR={curationProfile.votesPerDay} avgWeight={avgWeight}/> : <p style={{ color: C.faint, fontSize: "0.82rem", margin: 0 }}>{t("emptyDnaEnable")}</p>}
            </div>
            <div style={{ ...card, flex: 1 }}>
              <p style={{ ...lbl, marginBottom: "0.85rem" }}>{t("secVotesLastDays")}</p>
              <VotesPerDayChart votes={recentVotes}/>
            </div>
            {curationProfile && curationProfile.peakHoursUtc.length>0 && (
              <div style={{ ...card, flex: 1 }}>
                <p style={{ ...lbl, marginBottom: "0.85rem" }}>{t("secActivityPattern")}</p>
                <PeakHoursChart hours={curationProfile.peakHoursUtc}/>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Authors + Analytics + Activity ───────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "1.5rem", alignItems: "start" }}>

        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.1rem" }}>
            <div>
              <p style={lbl}>{t("secCuratedAuthors")} — {rules.length}</p>
              {openOpps.length>0 && <p style={{ color: C.warn, fontSize: "0.8rem", margin: "0.3rem 0 0", fontWeight: 600 }}>⚡ {openOpps.length} new post{openOpps.length>1?"s":""}</p>}
            </div>
            <button type="button" onClick={() => props.onTabChange("dna")} style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: "7px", color: C.muted, cursor: "pointer", fontSize: "0.75rem", padding: "0.28rem 0.65rem" }}>{t("btnEditStrategy")}</button>
          </div>
          {rules.length===0 ? (
            <div style={{ textAlign: "center", padding: "2rem 0" }}>
              <div style={{ fontSize: "2.2rem", marginBottom: "0.6rem" }}>🧬</div>
              <p style={{ color: C.muted, fontSize: "0.88rem", margin: "0 0 0.85rem", fontWeight: 600 }}>{t("emptyAuthors")}</p>
              <p style={{ color: C.faint, fontSize: "0.78rem", margin: "0 0 1rem", lineHeight: 1.5 }}>{t("emptyAuthorsSub")}</p>
              <button type="button" onClick={() => props.onTabChange("dna")} style={{ background: C.info+"22", border: `1px solid ${C.info}`, borderRadius: "8px", color: C.info, cursor: "pointer", fontSize: "0.82rem", padding: "0.45rem 1rem", fontWeight: 700 }}>{t("btnAnalyzeDna")}</button>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.55rem" }}>
              {rules.slice(0,15).map(r => <AuthorCard key={r.username} rule={r} openPost={oppMap.get(r.username)} voteUsd={snapshot?.currentVoteUsd??0} dnaData={dnaMap.get(r.username)} t={t}/>)}
              {rules.length>15 && <div style={{ gridColumn:"1/-1", color: C.faint, fontSize: "0.75rem", textAlign: "center", paddingTop: "0.3rem" }}>+{rules.length-15} more · <span style={{ color: C.info, cursor: "pointer" }} onClick={() => props.onTabChange("dna")}>view all →</span></div>}
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column" as const, gap: "1.5rem" }}>
          {curationProfile && curationProfile.topAuthors.length>0 && (
            <div style={card}>
              <p style={{ ...lbl, marginBottom: "1rem" }}>{t("secTopAuthors")}</p>
              <TopAuthorsChart authors={curationProfile.topAuthors}/>
            </div>
          )}
          {rules.length>0 && (
            <div style={card}>
              <p style={{ ...lbl, marginBottom: "0.85rem" }}>{t("secStrategyMix")}</p>
              <CategoryDonut rules={rules} t={t}/>
              {votePlan && <div style={{ marginTop: "0.85rem", paddingTop: "0.75rem", borderTop: `1px solid ${C.border}`, display: "flex", gap: "0.75rem", fontSize: "0.77rem" }}>
                <span style={{ color: C.dim }}>Last plan:</span>
                <span style={{ color: C.purple, fontWeight: 700 }}>{votePlan.plan.length} votes</span>
                <span style={{ color: C.faint }}>·</span>
                <span style={{ color: C.muted }}>{votePlan.summary.estimatedVpSpendPct}% VP</span>
              </div>}
            </div>
          )}
          <div style={{ ...card, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.85rem" }}>
              <p style={lbl}>{t("secRecentActivity")}</p>
              {recentVotes.length>0 && <span style={{ color: C.faint, fontSize: "0.7rem" }}>{recentVotes.length} {t("actVotesInSession")}</span>}
            </div>
            <ActivityTimeline votes={recentVotes} voteUsd={snapshot?.currentVoteUsd??0} dnaAuthors={dnaAuthors} opps={opportunities} onAction={{ plan:()=>{props.onTabChange("dna");props.onGenerateVotes();}, opps:props.onLoadOpportunities, dna:()=>props.onTabChange("dna") }} t={t}/>
          </div>
          <div style={card}>
            <p style={{ ...lbl, marginBottom: "0.85rem" }}>{t("secQuickActions")}</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.55rem" }}>
              {([
                { icon:"🧬", label:t("btnVoteDna"),  color:C.info,   fn:()=>props.onTabChange("dna") },
                { icon:"🗳",  label:t("btnVotePlan"), color:C.purple, fn:()=>{props.onTabChange("dna");props.onGenerateVotes();} },
                { icon:"⚡",  label:openOpps.length>0?`${t("btnOpportunities")} (${openOpps.length})`:t("btnScan"), color:openOpps.length>0?C.warn:C.muted, fn:()=>{props.onLoadOpportunities();props.onTabChange("dna");} },
                { icon:"⚙",  label:t("btnSettings"), color:C.ok,     fn:()=>props.onTabChange("billing") },
              ] as const).map((a,i) => (
                <button key={i} type="button" onClick={a.fn} style={{ background:a.color+"0e", border:`1px solid ${a.color}28`, borderRadius:"9px", padding:"0.7rem 0.8rem", cursor:"pointer", textAlign:"left" as const, display:"flex", alignItems:"center", gap:"0.5rem" }}>
                  <span style={{ fontSize:"1rem" }}>{a.icon}</span>
                  <span style={{ color:C.text, fontSize:"0.82rem", fontWeight:700 }}>{a.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
