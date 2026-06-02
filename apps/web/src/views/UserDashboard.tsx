import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AuthSession, CurationProfile, DailyEarnings, GrowthData,
  OpportunitiesMeta, PendingCuration, PendingDebugPost, PostOpportunity,
  SteemAccountSnapshot, TodayStats, VBEarningsResult, VotePlanResponse,
} from "../api";
import { fetchVBEarnings } from "../api";
import { fetchGrowthData, fetchPendingCuration, fetchTodayStats } from "../api";
import { createTranslator, type Locale, type TranslationKey } from "../i18n";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecentVote {
  author: string; permlink: string; title: string; weightPct: number; votedAt: string;
}
interface StrategyRuleLite {
  username: string; category: string; maxWeightPct: number; enabled: boolean;
}

// ── Light-mode design — matches Community tab ─────────────────────────────────
// Body bg: #f4f7f8  Cards: #fff + shadow  Text: #17202a  Accent: #1c7c73

const C = {
  // Page & surfaces
  pageBg:  "#f4f7f8",
  card:    "#ffffff",
  inner:   "#f0f5f7",   // track backgrounds, inner areas
  inner2:  "#e4ecf0",   // slightly stronger inner

  // Text hierarchy
  text:    "#17202a",
  muted:   "#4b6070",
  faint:   "#8fa4b0",
  dim:     "#607078",   // section labels

  // Borders
  border:  "#dde8ed",
  border2: "#c5d3da",

  // Semantic accents — vibrant, contrast on white
  ok:      "#16a34a",   // green
  warn:    "#d97706",   // amber
  err:     "#dc2626",   // red
  info:    "#2563eb",   // blue
  purple:  "#7c3aed",   // violet
  teal:    "#0d9488",   // teal (Community tab primary)
  fire:    "#ea580c",   // orange
  gold:    "#d97706",   // gold

  // Backwards-compat aliases
  bg0: "#f4f7f8", bg1: "#f4f7f8", bg2: "#ffffff",
  bg3: "#f0f5f7", bg4: "#e4ecf0",
};

// Card shadow — matches Community tab panels
const SHADOW = "0 2px 8px rgba(17,37,45,0.06), 0 1px 3px rgba(17,37,45,0.04)";
const SHADOW_MD = "0 4px 16px rgba(17,37,45,0.08), 0 1px 4px rgba(17,37,45,0.05)";

const CAT_DEF: Record<string, { color: string; icon: string; tKey: TranslationKey; pri: number }> = {
  immer_voten:    { color: C.fire,   icon: "🔥", tKey: "catAlways",    pri: 5 },
  lieblingsautor: { color: C.warn,   icon: "⭐", tKey: "catFavorite",  pri: 4 },
  bevorzugt:      { color: C.info,   icon: "🟦", tKey: "catPreferred", pri: 3 },
  normal:         { color: C.ok,     icon: "⚪", tKey: "catNormal",    pri: 2 },
  niedrig:        { color: C.faint,  icon: "⬇", tKey: "catLow",       pri: 1 },
};

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
  "Niche Specialist": "🟤", "Regular Curator": "⚫",
};

// Curator Journey — based on unique AUTHORS
const JOURNEY: ReadonlyArray<{ key: TranslationKey; minA: number; maxA: number; color: string; emoji: string }> = [
  { key: "levelNewCurator",       minA: 0,   maxA: 5,        color: C.faint,  emoji: "🌱" },
  { key: "levelActiveSup",        minA: 5,   maxA: 15,       color: C.ok,     emoji: "🌿" },
  { key: "levelCommunityBuilder", minA: 15,  maxA: 30,       color: C.info,   emoji: "🌳" },
  { key: "levelTrustedCurator",   minA: 30,  maxA: 60,       color: C.purple, emoji: "⭐" },
  { key: "levelEcosystemSup",     minA: 60,  maxA: 100,      color: C.warn,   emoji: "🌟" },
  { key: "levelLegend",           minA: 100, maxA: Infinity, color: C.gold,   emoji: "🏆" },
];

// ── Shared styles ─────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: C.card, borderRadius: "16px", padding: "1.5rem 1.75rem",
  boxShadow: SHADOW, border: `1px solid ${C.border}`,
};
const lbl: React.CSSProperties = {
  color: C.muted, fontSize: "0.72rem", fontWeight: 700,
  textTransform: "uppercase" as const, letterSpacing: "0.8px", margin: "0 0 1rem",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function vpCol(v: number)  { return v >= 85 ? C.ok : v >= 65 ? C.warn : C.err; }
function fmtUsd(v: number) { return v < 0.0005 ? "<$0.001" : `$${v.toFixed(3)}`; }
function fmtMin(min: number) {
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}
function fmtAge(iso: string, t: ReturnType<typeof createTranslator>) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 2) return t("timeJustNow");
  if (m < 60) return `${m}${t("timeMinAgo")}`;
  if (m < 1440) return `${Math.round(m / 60)}${t("timeHourAgo")}`;
  return `${Math.round(m / 1440)}${t("timeDayAgo")}`;
}
function sortRules(r: StrategyRuleLite[]) {
  return [...r].filter(x => x.enabled && x.category !== "ignorieren")
    .sort((a, b) => (CAT_DEF[b.category]?.pri ?? 0) - (CAT_DEF[a.category]?.pri ?? 0));
}
function journeyLevel(authors: number) {
  for (let i = JOURNEY.length - 1; i >= 0; i--)
    if (authors >= JOURNEY[i].minA) return { ...JOURNEY[i], idx: i };
  return { ...JOURNEY[0], idx: 0 };
}
function votesPerDay7(votes: RecentVote[]): Array<{ short: string; count: number }> {
  const result: Record<string, number> = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
    result[d.toISOString().slice(0, 10)] = 0;
  }
  for (const v of votes) { const day = v.votedAt.slice(0, 10); if (day in result) result[day]++; }
  const labels = ["Su","Mo","Tu","We","Th","Fr","Sa"];
  return Object.entries(result).map(([day, count]) => ({ count, short: labels[new Date(day+"T12:00:00Z").getUTCDay()] }));
}

// ── Community Hero ─────────────────────────────────────────────────────────────

function CommunityHero({ profile, growth, t }: {
  profile: CurationProfile; growth: GrowthData | null;
  t: ReturnType<typeof createTranslator>;
}) {
  const totalAuthors = growth?.summary.totalUniqueAuthors ?? profile.uniqueAuthors;
  const totalVotes   = growth?.summary.totalVotes   ?? profile.votesAnalyzed;
  const activeDays   = growth?.summary.activeDays   ?? profile.periodDays;
  const streak       = growth?.summary.longestStreak ?? 0;
  const currStreak   = growth?.summary.currentStreak ?? 0;

  const dnaKey   = DNA_LABEL_MAP[profile.dnaLabel];
  const dnaLabel = dnaKey ? t(dnaKey) : profile.dnaLabel;
  const dnaConv  = profile.avgWeightPct>=70 ? t("dnaHighConviction") : profile.avgWeightPct>=45 ? t("dnaBalanced") : t("dnaExploratory");
  const selfNote = profile.selfVotePct<5 ? t("dnaCommunityFirst") : profile.selfVotePct>20 ? t("dnaSelfFocused") : "";

  const stats = [
    { value: totalAuthors.toLocaleString(), label: t("impactAuthors"),      color: C.purple, big: true  },
    { value: totalVotes.toLocaleString(),   label: t("impactVotes"),         color: C.info,   big: false },
    { value: String(activeDays),            label: t("impactActiveDays"),    color: C.teal,   big: false },
    { value: streak>0 ? `${streak}d` : "—",label: t("impactStreak"),        color: C.warn,   big: false },
    ...(currStreak>1 ? [{ value:`${currStreak}d`, label:t("impactCurrentStreak"), color:C.ok, big:false }] : []),
  ];

  return (
    <div style={{
      background: "linear-gradient(135deg, #f0eafe 0%, #ffffff 55%, #e8faf7 100%)",
      borderRadius: "20px", padding: "2rem 2.25rem",
      boxShadow: SHADOW_MD,
      border: `1px solid #e0d4fc`,
      display: "flex", flexDirection: "column" as const, gap: "1.5rem",
    }}>
      {/* DNA Identity */}
      <div style={{ display:"flex", alignItems:"center", gap:"1rem" }}>
        <span style={{ fontSize:"2.4rem", lineHeight:1 }}>{DNA_EMOJI[profile.dnaLabel] ?? "⚫"}</span>
        <div>
          <div style={{ color: C.purple, fontWeight:800, fontSize:"1.1rem" }}>{dnaLabel}</div>
          <div style={{ color: C.muted, fontSize:"0.75rem", marginTop:"2px" }}>{dnaConv}{selfNote?` · ${selfNote}`:""}</div>
        </div>
        <div style={{ marginLeft:"auto", textAlign:"right" as const }}>
          <div style={{ color: C.muted, fontSize:"0.72rem", fontWeight:700 }}>@{profile.username}</div>
          <div style={{ color: C.faint, fontSize:"0.68rem" }}>{profile.avgWeightPct}% {t("kpiAvgWeight").toLowerCase()}</div>
        </div>
      </div>

      {/* Giant impact numbers */}
      <div style={{ display:"flex", gap:0, alignItems:"stretch" }}>
        {stats.map((s, i) => (
          <div key={i} style={{
            flex: s.big ? "1.8" : "1",
            textAlign: "center" as const,
            padding: "0.5rem 0.75rem",
            borderRight: i<stats.length-1 ? `1px solid ${C.border}` : "none",
          }}>
            <div style={{ color:s.color, fontSize:s.big?"3.8rem":"2.4rem", fontWeight:900, lineHeight:1, letterSpacing:s.big?"-2px":"-1px" }}>
              {s.value}
            </div>
            <div style={{ color:C.muted, fontSize:"0.68rem", fontWeight:700, letterSpacing:"0.8px", textTransform:"uppercase" as const, marginTop:"0.35rem" }}>
              {s.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Community Growth Chart ─────────────────────────────────────────────────────

function CommunityGrowthChart({ growth, growthLoading, growthPeriod, setGrowthPeriod, t }: {
  growth: GrowthData | null; growthLoading: boolean;
  growthPeriod: "30d"|"90d"|"all"; setGrowthPeriod: (p:"30d"|"90d"|"all")=>void;
  t: ReturnType<typeof createTranslator>;
}) {
  const data    = growth?.dataPoints.filter(d => d.cumAuthors > 0) ?? [];
  const total   = growth?.summary.totalVotes ?? 0;
  const authors = growth?.summary.totalUniqueAuthors ?? 0;

  const emptyState = () => total===0 ? (
    <div style={{ textAlign:"center", padding:"2rem 1rem" }}>
      <div style={{ fontSize:"3rem", marginBottom:"0.75rem" }}>🌱</div>
      <p style={{ color:C.text, fontSize:"1rem", fontWeight:700, margin:"0 0 0.5rem" }}>{t("growthEmptyZero")}</p>
      <p style={{ color:C.muted, fontSize:"0.82rem", margin:"0 auto", lineHeight:1.6, maxWidth:"420px" }}>{t("growthEmptyBuildingNote")}</p>
    </div>
  ) : (
    <div style={{ textAlign:"center", padding:"1.5rem 1rem" }}>
      <div style={{ fontSize:"2.2rem", marginBottom:"0.5rem" }}>📈</div>
      <p style={{ color:C.text, fontSize:"0.9rem", fontWeight:700, margin:"0 0 0.3rem" }}>{t("growthEmptyFew")}</p>
      <p style={{ color:C.muted, fontSize:"0.78rem", margin:"0 0 1rem", lineHeight:1.5 }}>{t("growthEmptyFewSub")}</p>
      <div style={{ display:"flex", justifyContent:"center", gap:"2.5rem" }}>
        <div style={{ textAlign:"center" as const }}>
          <div style={{ color:C.purple, fontSize:"2rem", fontWeight:900 }}>{authors}</div>
          <div style={{ color:C.faint, fontSize:"0.68rem", letterSpacing:"0.5px" }}>{t("impactAuthors").toUpperCase()}</div>
        </div>
        <div style={{ textAlign:"center" as const }}>
          <div style={{ color:C.info, fontSize:"2rem", fontWeight:900 }}>{total}</div>
          <div style={{ color:C.faint, fontSize:"0.68rem", letterSpacing:"0.5px" }}>{t("impactVotes").toUpperCase()}</div>
        </div>
      </div>
    </div>
  );

  const W=700, H=160, padL=8, padR=8, padT=12, padB=24;
  const cW=W-padL-padR, cH=H-padT-padB;
  const maxA=Math.max(...data.map(d=>d.cumAuthors),1);
  const maxV=Math.max(...data.map(d=>d.cumVotes),1);
  const maxDA=Math.max(...data.map(d=>d.newAuthors),1);
  const n=data.length;

  function xP(i:number)  { return padL+(i/(n-1))*cW; }
  function yA(v:number)  { return padT+cH-(v/maxA)*cH; }
  function yV(v:number)  { return padT+cH-(v/maxV)*cH; }

  const authPath=data.map((d,i)=>`${i===0?"M":"L"} ${xP(i).toFixed(1)} ${yA(d.cumAuthors).toFixed(1)}`).join(" ");
  const votePath=data.map((d,i)=>`${i===0?"M":"L"} ${xP(i).toFixed(1)} ${yV(d.cumVotes).toFixed(1)}`).join(" ");
  const fillAuth=`${authPath} L ${(padL+cW).toFixed(1)} ${(padT+cH).toFixed(1)} L ${padL.toFixed(1)} ${(padT+cH).toFixed(1)} Z`;
  const milestones=[10,25,50,100].filter(m=>m<maxA&&m>0);
  const labelIdxs=n>1?[0,Math.floor((n-1)/2),n-1]:[];

  return (
    <div style={card}>
      <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:"0.75rem" }}>
        <div>
          <p style={{ ...lbl, margin:0 }}>{t("growthChartTitle")}</p>
          <p style={{ color:C.faint, fontSize:"0.72rem", margin:"0.2rem 0 0", fontStyle:"italic" }}>{t("growthChartNote")}</p>
        </div>
        <div style={{ display:"flex", gap:"0.3rem", flexShrink:0 }}>
          {(["30d","90d","all"] as const).map(p => (
            <button key={p} type="button" onClick={()=>setGrowthPeriod(p)} style={{
              background: growthPeriod===p ? C.purple+"15" : "none",
              border: `1px solid ${growthPeriod===p ? C.purple : C.border}`,
              borderRadius:"6px", color:growthPeriod===p?C.purple:C.faint,
              cursor:"pointer", fontSize:"0.7rem", padding:"0.18rem 0.5rem", fontWeight:600,
            }}>
              {p==="30d"?t("growthPeriod30d"):p==="90d"?t("growthPeriod90d"):t("growthPeriodAll")}
            </button>
          ))}
        </div>
      </div>

      {growthLoading ? (
        <p style={{ color:C.faint, fontSize:"0.82rem", margin:"1rem 0", textAlign:"center" }}>{t("growthLoading")}</p>
      ) : data.length<3 ? emptyState() : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:H }} preserveAspectRatio="none">
            <defs>
              <linearGradient id="authFillL" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.purple} stopOpacity="0.15"/>
                <stop offset="100%" stopColor={C.purple} stopOpacity="0"/>
              </linearGradient>
            </defs>
            {[0.25,0.5,0.75].map(f=>(
              <line key={f} x1={padL} y1={padT+cH*(1-f)} x2={padL+cW} y2={padT+cH*(1-f)} stroke={C.border} strokeWidth="0.75"/>
            ))}
            {data.map((d,i)=>d.newAuthors>0&&(
              <rect key={i} x={xP(i)-Math.max(1,cW/n/2)} y={padT+cH-(d.newAuthors/maxDA)*(cH*0.28)} width={Math.max(2,cW/n-1)} height={(d.newAuthors/maxDA)*(cH*0.28)} fill={C.purple+"14"} rx="1"/>
            ))}
            {milestones.map(m=>(
              <line key={m} x1={padL} y1={yA(m)} x2={padL+cW} y2={yA(m)} stroke={C.purple+"33"} strokeWidth="1" strokeDasharray="4 4"/>
            ))}
            <path d={votePath} fill="none" stroke={C.info+"44"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d={fillAuth} fill="url(#authFillL)"/>
            <path d={authPath} fill="none" stroke={C.purple} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx={xP(n-1).toFixed(1)} cy={yA(data[n-1].cumAuthors).toFixed(1)} r="5" fill={C.purple}/>
            <text x={parseFloat(xP(n-1).toFixed(1))+8} y={parseFloat(yA(data[n-1].cumAuthors).toFixed(1))-4} fill={C.purple} fontSize="10" fontWeight="700">{data[n-1].cumAuthors}</text>
            {labelIdxs.map(i=>(
              <text key={i} x={xP(i)} y={H-5} textAnchor="middle" fill={C.faint} fontSize="9">{data[i].day.slice(5)}</text>
            ))}
          </svg>
          <div style={{ display:"flex", gap:"1.5rem", marginTop:"8px", fontSize:"0.73rem", flexWrap:"wrap" as const }}>
            <span style={{ display:"flex", alignItems:"center", gap:"0.4rem" }}>
              <span style={{ display:"inline-block", width:"18px", height:"3px", background:C.purple, borderRadius:"2px" }}/>
              <span style={{ color:C.muted }}>{t("growthCumAuthors")} ({data[n-1].cumAuthors})</span>
            </span>
            <span style={{ display:"flex", alignItems:"center", gap:"0.4rem" }}>
              <span style={{ display:"inline-block", width:"18px", height:"2px", background:C.info+"66", borderRadius:"1px" }}/>
              <span style={{ color:C.muted }}>{t("growthCumVotes")} ({data[n-1].cumVotes.toLocaleString()})</span>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ── Curator Journey ───────────────────────────────────────────────────────────

function CuratorJourney({ totalAuthors, t }: { totalAuthors: number; t: ReturnType<typeof createTranslator> }) {
  const level    = journeyLevel(totalAuthors);
  const isMax    = level.idx === JOURNEY.length - 1;
  const nextThr  = isMax ? totalAuthors : JOURNEY[level.idx+1].minA;
  const pct      = isMax ? 100 : Math.min(100, ((totalAuthors-level.minA)/(nextThr-level.minA))*100);
  const remaining = isMax ? 0 : nextThr - totalAuthors;
  const nextLevel = isMax ? null : JOURNEY[level.idx+1];

  return (
    <div style={{ display:"flex", flexDirection:"column" as const, gap:"1.25rem" }}>
      {/* Badge */}
      <div style={{
        display:"flex", alignItems:"center", gap:"1rem", padding:"1.1rem 1.25rem",
        background: `linear-gradient(135deg, ${level.color}12 0%, ${C.inner} 100%)`,
        border:`1.5px solid ${level.color}30`, borderRadius:"12px",
      }}>
        <span style={{ fontSize:"2.4rem", lineHeight:1 }}>{level.emoji}</span>
        <div>
          <div style={{ color:level.color, fontWeight:900, fontSize:"1.05rem" }}>{t(level.key)}</div>
          <div style={{ color:C.muted, fontSize:"0.72rem", marginTop:"2px" }}>{totalAuthors} {t("levelAuthorsOf")}</div>
        </div>
      </div>

      {/* Progress */}
      {!isMax && nextLevel && (
        <div>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"6px", fontSize:"0.73rem" }}>
            <span style={{ color:C.muted }}>{remaining} {t("levelMoreAuthors")} <b style={{ color:nextLevel.color }}>{t(nextLevel.key)}</b></span>
            <span style={{ color:level.color, fontWeight:700 }}>{pct.toFixed(0)}%</span>
          </div>
          <div style={{ height:"10px", background:C.inner, borderRadius:"5px", overflow:"hidden", border:`1px solid ${C.border}` }}>
            <div style={{ height:"100%", width:`${pct}%`, background:`linear-gradient(90deg,${level.color}88,${level.color})`, borderRadius:"5px", transition:"width 0.7s ease" }}/>
          </div>
          <div style={{ display:"flex", justifyContent:"space-between", marginTop:"4px", fontSize:"0.67rem", color:C.faint }}>
            <span>{totalAuthors}</span><span>{nextThr}</span>
          </div>
        </div>
      )}
      {isMax && <p style={{ color:C.gold, fontSize:"0.82rem", fontWeight:700, margin:0 }}>{t("levelMaxReached")}</p>}

      {/* Level track */}
      <div>
        <div style={{ display:"flex", gap:"3px", marginBottom:"4px" }}>
          {JOURNEY.map((l,i)=>(
            <div key={l.key} title={t(l.key)} style={{ flex:1, height:"6px", borderRadius:"3px", background:i<=level.idx?l.color:C.inner2, border:`1px solid ${C.border}`, transition:"background 0.4s" }}/>
          ))}
        </div>
        <div style={{ display:"flex", justifyContent:"space-between", fontSize:"0.6rem", color:C.faint }}>
          <span>{JOURNEY[0].emoji}</span><span>{JOURNEY[JOURNEY.length-1].emoji}</span>
        </div>
      </div>

      {/* Journey steps */}
      <div style={{ display:"flex", flexDirection:"column" as const, gap:"0.3rem" }}>
        {JOURNEY.map((l,i)=>(
          <div key={l.key} style={{ display:"flex", alignItems:"center", gap:"0.6rem", opacity:i>level.idx+1?0.35:1 }}>
            <span style={{ fontSize:"0.9rem", width:"20px", textAlign:"center" as const }}>{l.emoji}</span>
            <div style={{ flex:1, height:"1px", background:i<=level.idx?l.color+"44":C.border }}/>
            <span style={{ fontSize:"0.68rem", fontWeight:700, color:i<=level.idx?l.color:C.muted, minWidth:"110px" }}>{t(l.key)}</span>
            <span style={{ fontSize:"0.63rem", color:C.faint, width:"40px", textAlign:"right" as const }}>{l.minA===0?"0":`${l.minA}+`}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Relationships Panel ───────────────────────────────────────────────────────

function RelationshipsPanel({ authors, t }: { authors: CurationProfile["topAuthors"]; t: ReturnType<typeof createTranslator> }) {
  if (authors.length===0) return <p style={{ color:C.faint, fontSize:"0.82rem", margin:0 }}>—</p>;
  const maxVotes=Math.max(...authors.map(a=>a.voteCount),1);

  return (
    <div style={{ display:"flex", flexDirection:"column" as const, gap:"0.75rem" }}>
      {authors.slice(0,5).map((a,i)=>{
        const isTop=i===0;
        const barW=(a.voteCount/maxVotes)*100;
        return (
          <div key={a.username} style={{
            padding:"0.85rem 1rem",
            background:isTop?`linear-gradient(135deg,${C.purple}08,${C.inner})`:`${C.inner}`,
            border:`1px solid ${isTop?C.purple+"30":C.border}`,
            borderRadius:"10px",
          }}>
            <div style={{ display:"flex", alignItems:"center", gap:"0.65rem", marginBottom:"0.35rem" }}>
              <div style={{ width:"36px", height:"36px", borderRadius:"50%", flexShrink:0, background:`linear-gradient(135deg,${C.purple}22,${C.info}18)`, border:`2px solid ${C.purple}30`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:"0.95rem", fontWeight:800, color:C.purple }}>
                {a.username[0]?.toUpperCase()??"?"}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:"0.4rem" }}>
                  <span style={{ color:C.info, fontWeight:700, fontSize:"0.85rem" }}>@{a.username}</span>
                  {isTop && <span style={{ background:C.purple+"15", color:C.purple, borderRadius:"8px", padding:"0 0.35rem", fontSize:"0.6rem", fontWeight:700 }}>#{i+1} {t("relStrongestNote")}</span>}
                </div>
                <div style={{ color:C.faint, fontSize:"0.7rem", marginTop:"1px" }}>
                  {a.voteCount} {t("relVotesTogether")} · {a.sharePct}% {t("relShareCuration")}
                  {a.lastVoteDaysAgo!==undefined&&a.lastVoteDaysAgo>=0&&(
                    <span style={{ color:a.lastVoteDaysAgo<=3?C.ok:C.faint }}> · {a.lastVoteDaysAgo===0?t("timeToday"):`${t("relLastVoted")} ${a.lastVoteDaysAgo} ${t("relDays")}`}</span>
                  )}
                </div>
              </div>
              <div style={{ flexShrink:0, textAlign:"right" as const }}>
                <div style={{ color:C.purple, fontWeight:800, fontSize:"1.1rem" }}>{a.voteCount}</div>
                <div style={{ color:C.faint, fontSize:"0.6rem" }}>votes</div>
              </div>
            </div>
            <div style={{ height:"3px", background:C.inner2, borderRadius:"2px", overflow:"hidden" }}>
              <div style={{ height:"100%", width:`${barW}%`, background:`linear-gradient(90deg,${C.purple}66,${C.purple})`, borderRadius:"2px" }}/>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Activity timeline ─────────────────────────────────────────────────────────

function ActivityTimeline({ votes, voteUsd, opps, onAction, t }: {
  votes: RecentVote[]; voteUsd: number; opps: PostOpportunity[] | null;
  onAction:{plan:()=>void;opps:()=>void;dna:()=>void};
  t: ReturnType<typeof createTranslator>;
}) {
  const eligible=opps?.filter(p=>p.eligible)??[];

  if (votes.length===0&&eligible.length===0) return (
    <div style={{ display:"flex", flexDirection:"column" as const, gap:"0.5rem" }}>
      <div style={{ textAlign:"center", padding:"0.75rem 0 1rem" }}>
        <div style={{ fontSize:"1.8rem", marginBottom:"0.3rem" }}>🌱</div>
        <p style={{ color:C.text, fontSize:"0.85rem", fontWeight:600, margin:"0 0 0.15rem" }}>{t("actNoActivity")}</p>
        <p style={{ color:C.muted, fontSize:"0.75rem", margin:0 }}>{t("actStartTimeline")}</p>
      </div>
      {([
        {icon:"⚡",label:t("btnFindOpps"),    col:C.warn,   fn:onAction.opps},
        {icon:"🗳", label:t("btnGeneratePlan"), col:C.purple, fn:onAction.plan},
      ] as const).map(a=>(
        <button key={a.label} type="button" onClick={a.fn} style={{ background:`${a.col}12`, border:`1px solid ${a.col}30`, borderRadius:"9px", color:a.col, cursor:"pointer", fontSize:"0.8rem", padding:"0.55rem 0.85rem", textAlign:"left" as const, display:"flex", alignItems:"center", gap:"0.5rem" }}>
          <span>{a.icon}</span><span style={{ fontWeight:600 }}>{a.label}</span>
        </button>
      ))}
    </div>
  );

  const items:[string,string,string,string,string][] = [];
  eligible.slice(0,3).forEach(p=>{
    const w=p.postScore>=80?t("oppOptimalWindow"):p.postScore>=50?t("oppGoodWindow"):t("oppLateWindow");
    items.push([C.warn,"⚡",`@${p.author}`,`${t("actNewPost")} · ${fmtMin(p.ageMinutes)} · ${w}`,t("actOpen")]);
  });
  votes.slice(0,8).forEach(v=>{
    items.push([C.ok,"✓",`@${v.author}`,`${v.weightPct}% vote`,`+${fmtUsd(v.weightPct/100*voteUsd)} · ${fmtAge(v.votedAt,t)}`]);
  });

  return (
    <div>
      {items.map(([col,icon,l1,l2,right],i)=>(
        <div key={i} style={{ display:"flex", alignItems:"center", gap:"0.6rem", padding:"0.55rem 0", borderBottom:i<items.length-1?`1px solid ${C.border}`:"none" }}>
          <div style={{ width:"28px", height:"28px", borderRadius:"50%", flexShrink:0, background:`${col}14`, border:`1.5px solid ${col}30`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:"0.8rem", color:col }}>{icon}</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ color:C.info, fontWeight:700, fontSize:"0.84rem" }}>{l1}</div>
            <div style={{ color:C.dim, fontSize:"0.76rem" }}>{l2}</div>
          </div>
          <div style={{ color:C.dim, fontSize:"0.74rem", flexShrink:0, whiteSpace:"nowrap" as const }}>{right}</div>
        </div>
      ))}
    </div>
  );
}

// ── VP Gauge — adapted for light background ───────────────────────────────────
// Arc track uses light gray, all text uses dark colors

function VpGauge({ pct, sp, voteUsd }: { pct: number; sp?: number; voteUsd?: number }) {
  const W=240, H=240, cx=W/2, cy=100, r=88, sw=17;
  const col=vpCol(pct);
  const START=225, SPAN=270, valDeg=START+(pct/100)*SPAN;

  function pt(deg:number,radius=r):[number,number] {
    const rad=(deg-90)*Math.PI/180;
    return [cx+radius*Math.cos(rad),cy+radius*Math.sin(rad)];
  }
  function arc(from:number,to:number) {
    const [sx,sy]=pt(from),[ex,ey]=pt(to);
    const large=((to-from+360)%360)>180?1:0;
    return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
  }

  const [tx,ty]=pt(valDeg);
  const regenH=pct>=99.9?0:(100-pct)/20*24;
  const regenLabel=regenH===0?"fully charged":regenH<1?`${Math.round(regenH*60)}m to full`:`${regenH.toFixed(1)}h to full`;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <defs>
        <filter id="gvpL"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      {/* Light track */}
      <path d={arc(START,START+SPAN)} fill="none" stroke={C.inner2} strokeWidth={sw} strokeLinecap="round"/>
      {/* Threshold markers */}
      {[65,85].map(v=>{
        const d=START+(v/100)*SPAN;
        const [ix,iy]=pt(d,r-sw*0.7),[ox,oy]=pt(d,r+sw*0.7);
        return <line key={v} x1={ix.toFixed(1)} y1={iy.toFixed(1)} x2={ox.toFixed(1)} y2={oy.toFixed(1)} stroke={v===65?C.warn+"44":C.ok+"44"} strokeWidth="2"/>;
      })}
      {/* Filled arc */}
      <path d={arc(START,valDeg)} fill="none" stroke={col} strokeWidth={sw} strokeLinecap="round" filter="url(#gvpL)"/>
      {/* Dot */}
      <circle cx={tx.toFixed(2)} cy={ty.toFixed(2)} r={sw*0.65} fill={col} filter="url(#gvpL)"/>
      {/* Text — dark on light */}
      <text x={cx} y={cy-2} textAnchor="middle" fill={col} fontSize="50" fontWeight="900" fontFamily="inherit">{pct.toFixed(1)}%</text>
      <text x={cx} y={cy+24} textAnchor="middle" fill={C.muted} fontSize="11" letterSpacing="2.5" fontWeight="700">VOTING POWER</text>
      <text x={cx} y={cy+42} textAnchor="middle" fill={C.faint} fontSize="12">{regenLabel}</text>
      {sp!==undefined&&voteUsd!==undefined&&(
        <>
          <text x={cx} y="196" textAnchor="middle" fill={C.info} fontSize="14" fontWeight="700">{sp.toFixed(0)} SP</text>
          <text x={cx} y="214" textAnchor="middle" fill={C.faint} fontSize="12">full vote ≈ {fmtUsd(voteUsd)}</text>
        </>
      )}
    </svg>
  );
}

// ── Operative KPI Row (Cockpit — direkt nach Hero) ────────────────────────────

function OperativeKPIRow({ snapshot, snapshotLoading, snapshotRefreshedAt, opportunities, opportunitiesMeta, onRefresh, onLoadOpps, onTabChange, t }: {
  snapshot: SteemAccountSnapshot|null; snapshotLoading: boolean; snapshotRefreshedAt?: Date;
  opportunities: PostOpportunity[]|null; opportunitiesMeta: OpportunitiesMeta|null;
  onRefresh?: ()=>void; onLoadOpps: ()=>void;
  onTabChange:(tab:"dna"|"dashboard"|"community"|"billing")=>void;
  t: ReturnType<typeof createTranslator>;
}) {
  const vpPct    = snapshot ? snapshot.votingPowerBps / 100 : null;
  const openOpps = opportunities?.filter(p => p.eligible) ?? [];

  return (
    <div style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr", gap:"1rem" }}>

      {/* Voting Power */}
      <div style={card}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.6rem" }}>
          <span style={{ color:C.muted, fontSize:"0.72rem", fontWeight:700, textTransform:"uppercase" as const, letterSpacing:"0.8px" }}>{t("kpiVotingPower")}</span>
          {onRefresh&&<button type="button" onClick={onRefresh} disabled={snapshotLoading} style={{ background:"none", border:"none", cursor:"pointer", color:snapshotLoading?C.faint:C.muted, fontSize:"0.9rem", padding:0 }}>↻</button>}
        </div>
        {vpPct!==null?(
          <>
            <div style={{ display:"flex", alignItems:"baseline", gap:"0.4rem", marginBottom:"0.4rem" }}>
              <span style={{ color:vpCol(vpPct), fontSize:"2.6rem", fontWeight:900, lineHeight:1, letterSpacing:"-1px" }}>{vpPct.toFixed(1)}%</span>
              <span style={{ color:C.dim, fontSize:"0.85rem", fontWeight:600 }}>VP</span>
              {snapshot&&<span style={{ color:C.info, fontSize:"0.9rem", fontWeight:700, marginLeft:"auto" }}>{fmtUsd(snapshot.currentVoteUsd)}<span style={{ color:C.dim, fontSize:"0.72rem", fontWeight:400 }}>/vote</span></span>}
            </div>
            <div style={{ height:"7px", background:C.inner, borderRadius:"4px", overflow:"hidden", marginBottom:"0.4rem", border:`1px solid ${C.border}` }}>
              <div style={{ height:"100%", width:`${vpPct}%`, background:vpCol(vpPct), borderRadius:"4px", transition:"width 0.6s" }}/>
            </div>
            {(()=>{
              const regenH=vpPct>=99.9?0:(100-vpPct)/20*24;
              const to90=vpPct>=90?null:(90-vpPct)/20*24;
              return (
                <div style={{ display:"flex", gap:"0.5rem", fontSize:"0.75rem" }}>
                  {to90&&<span style={{ color:C.ok, fontWeight:600 }}>→ 90% in {to90<1?`${Math.round(to90*60)}m`:`${to90.toFixed(1)}h`}</span>}
                  {regenH>0&&<span style={{ color:C.dim, marginLeft:"auto" }}>voll in {regenH<1?`${Math.round(regenH*60)}m`:`${regenH.toFixed(1)}h`}</span>}
                  {regenH===0&&<span style={{ color:C.ok, marginLeft:"auto" }}>✓ voll geladen</span>}
                </div>
              );
            })()}
            {snapshot&&<div style={{ color:C.dim, fontSize:"0.73rem", marginTop:"0.4rem" }}>{snapshot.steemPowerSp.toFixed(0)} SP · 100%: {fmtUsd(snapshot.fullPowerVoteUsd)}</div>}
          </>
        ):(
          <div style={{ color:C.dim, fontSize:"0.82rem" }}>{snapshotLoading?"Lädt…":"—"}</div>
        )}
        {snapshotRefreshedAt&&<div style={{ color:C.faint, fontSize:"0.65rem", marginTop:"0.3rem" }}>{fmtAge(snapshotRefreshedAt.toISOString(),t)}</div>}
      </div>

      {/* Offene Chancen */}
      <div
        style={{ ...card, cursor:"pointer" }}
        onClick={() => {
          // Only trigger a fresh scan if no data loaded yet — avoids overwriting
          // locally-voted posts with stale server data (race condition after vote)
          if (opportunities === null) onLoadOpps();
          onTabChange("dna");
        }}
      >
        <p style={{ ...lbl, margin:"0 0 0.6rem" }}>{t("kpiOpenOpps")}</p>
        <div style={{ color:openOpps.length>0?C.warn:opportunities!==null?C.ok:C.muted, fontSize:"2.6rem", fontWeight:900, lineHeight:1, letterSpacing:"-1px", marginBottom:"0.5rem" }}>
          {openOpps.length>0?openOpps.length:opportunities===null?"—":"0"}
        </div>
        <div style={{ fontSize:"0.8rem", display:"flex", flexDirection:"column" as const, gap:"0.2rem" }}>
          {openOpps.length>0&&<span style={{ color:C.warn, fontWeight:700 }}>{openOpps.filter(p=>p.postScore>=80).length} {t("oppOptimalWindow")}</span>}
          {opportunitiesMeta&&<span style={{ color:C.dim }}>{opportunitiesMeta.scannedAuthors}/{opportunitiesMeta.requestedAuthors} {t("oppScanned")}</span>}
          {opportunities===null&&<span style={{ color:C.muted }}>{t("oppTapToDiscover")}</span>}
          {opportunities!==null&&openOpps.length===0&&<span style={{ color:C.info }}>{t("oppVotedRescan")}</span>}
        </div>
      </div>
    </div>
  );
}

// ── Curation Timeline (Heute | Pending 7d | 30 Tage) ─────────────────────────

function PendingDebugPanel({ data }: { data: PendingCuration }) {
  const [open, setOpen] = useState(false);
  const db = data.debug;
  const skipped = db.skipped;
  const totalSkipped = skipped.alreadyPaidOut + skipped.payoutZero + skipped.noVoteFound + skipped.weightZero + skipped.limitReached;

  const tdR: React.CSSProperties = { textAlign: "right", padding: "0.15rem 0.4rem", fontVariantNumeric: "tabular-nums" };
  const tdL: React.CSSProperties = { textAlign: "left",  padding: "0.15rem 0.4rem", color: C.dim };

  return (
    <div style={{ marginTop: "1rem", borderTop: `1px solid ${C.border}`, paddingTop: "0.6rem" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ background: "none", border: "none", cursor: "pointer", color: C.muted, fontSize: "0.72rem", padding: 0, display: "flex", alignItems: "center", gap: "0.3rem" }}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>Debug-Ansicht</span>
        <span style={{ color: C.faint }}>· {data.sbdPerSteemUsed.toFixed(4)} SBD/STEEM · {totalSkipped} übersprungen</span>
      </button>

      {open && (
        <div style={{ marginTop: "0.6rem", fontSize: "0.73rem", color: C.text }}>

          {/* ── Coverage + Preis ── */}
          <div style={{ marginBottom: "0.5rem", padding: "0.3rem 0.5rem", background: "#fffbe6", borderRadius: "6px", border: "1px solid #f5d000" }}>
            <div>
              <strong>Coverage:</strong>&nbsp;
              {db.uniqueTotal} unique Posts gefunden&nbsp;·&nbsp;
              {db.fetched} abgerufen&nbsp;·&nbsp;
              {data.postCount} offen (mit Wert)
              {db.skipped.limitReached > 0 && (
                <span style={{ color: "#c00", fontWeight: 700 }}>&nbsp;· ⚠ {db.skipped.limitReached} durch Limit übersprungen</span>
              )}
            </div>
            <div style={{ marginTop: "0.2rem" }}>
              Gerechnet mit&nbsp;<strong>{data.sbdPerSteemUsed.toFixed(4)} SBD/STEEM</strong>
              &nbsp;·&nbsp;Summe pending_payout: <strong>{db.totalPayoutUsd.toFixed(4)} USD</strong>
            </div>
          </div>

          {/* ── Übersprungene Posts ── */}
          {totalSkipped > 0 && (
            <div style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontWeight: 700, marginBottom: "0.25rem", color: C.warn }}>Übersprungen ({totalSkipped})</div>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <tbody>
                  {skipped.alreadyPaidOut > 0 && <tr><td style={tdL}>Bereits ausgezahlt</td><td style={tdR}>{skipped.alreadyPaidOut}</td></tr>}
                  {skipped.payoutZero     > 0 && <tr><td style={tdL}>pending_payout = 0</td><td style={tdR}>{skipped.payoutZero}</td></tr>}
                  {skipped.noVoteFound    > 0 && <tr><td style={tdL}>Kein eigener Vote in active_votes</td><td style={tdR}>{skipped.noVoteFound}</td></tr>}
                  {skipped.weightZero     > 0 && <tr><td style={tdL}>Curation-Weight = 0 (Early-Vote-Penalty)</td><td style={tdR}>{skipped.weightZero}</td></tr>}
                  {skipped.limitReached   > 0 && <tr><td style={tdL}>Limit überschritten</td><td style={tdR}>{skipped.limitReached}</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Top-10 Breakdown ── */}
          {db.top10.length > 0 && (
            <div>
              <div style={{ fontWeight: 700, marginBottom: "0.25rem" }}>
                Top {db.top10.length} Posts · Methode: Curation-Weight
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "580px" }}>
                  <thead>
                    <tr style={{ background: C.border + "55" }}>
                      <th style={{ ...tdL, fontWeight: 600 }}>Autor/Permlink</th>
                      <th style={{ ...tdR, fontWeight: 600 }}>Pool SBD</th>
                      <th style={{ ...tdR, fontWeight: 600 }}>Weight %</th>
                      <th style={{ ...tdR, fontWeight: 600, color: C.ok }}>≈ SP (weight)</th>
                      <th style={{ ...tdR, fontWeight: 600, color: C.dim }}>SP (rshares)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {db.top10.map((p: PendingDebugPost, i: number) => (
                      <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
                        <td style={{ ...tdL, maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <a
                            href={`https://steemit.com/@${p.author}/${p.permlink}`}
                            target="_blank" rel="noreferrer"
                            style={{ color: C.info, textDecoration: "none" }}
                            title={`@${p.author}/${p.permlink}`}
                          >@{p.author}</a>
                          <span style={{ color: C.faint }}>&nbsp;/{p.permlink.slice(0,20)}{p.permlink.length>20?"…":""}</span>
                        </td>
                        <td style={tdR}>{p.pendingPayoutSbd.toFixed(3)}</td>
                        <td style={tdR}>{p.sharePctWeight.toFixed(3)}%</td>
                        <td style={{ ...tdR, color: C.ok, fontWeight: 700 }}>{p.estimatedSp.toFixed(4)}</td>
                        <td style={{ ...tdR, color: C.dim }}>{p.estimatedSpRshares.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CurationTriple({ snapshot, todayStats, todayLoading, pendingCuration, pendingLoading, t }: {
  snapshot: SteemAccountSnapshot|null;
  todayStats: TodayStats|null; todayLoading: boolean;
  pendingCuration: PendingCuration|null; pendingLoading: boolean;
  t: ReturnType<typeof createTranslator>;
}) {
  const voteUsd       = snapshot?.currentVoteUsd ?? 0;
  const estCuration   = todayStats
    ? todayStats.votes.reduce((s, v) => s + (v.weightBps / 10000) * voteUsd * 0.25, 0) : 0;
  const vpConsumedPct = todayStats ? todayStats.totalWeightBps / 5000 : 0;

  // Big hero number + unit
  const Hero = ({ val, unit, col, sub }: { val: string; unit: string; col: string; sub?: string }) => (
    <div style={{ marginBottom:"0.7rem" }}>
      <div>
        <span style={{ color:col, fontSize:"2.8rem", fontWeight:900, lineHeight:1, letterSpacing:"-1.5px" }}>{val}</span>
        <span style={{ color:col, fontSize:"1rem", fontWeight:700, marginLeft:"0.35rem", opacity:0.75 }}>{unit}</span>
      </div>
      {sub && <div style={{ color:C.dim, fontSize:"0.82rem", marginTop:"0.15rem" }}>{sub}</div>}
    </div>
  );

  const Row = ({ label, value, col, bold }: { label: string; value: string; col?: string; bold?: boolean }) => (
    <div style={{ display:"flex", justifyContent:"space-between", fontSize:"0.8rem", padding:"0.12rem 0" }}>
      <span style={{ color:C.dim }}>{label}</span>
      <span style={{ color:col ?? C.text, fontWeight:bold ? 700 : 600 }}>{value}</span>
    </div>
  );

  const Divider = () => <div style={{ borderTop:`1px solid ${C.border}`, margin:"0.5rem 0" }}/>;

  const nextPayout = pendingCuration?.nextPayout;
  const nextPayoutLabel = nextPayout ? (() => {
    const h = (new Date(nextPayout.cashoutTime + "Z").getTime() - Date.now()) / 3_600_000;
    return h < 24 ? `in ${h.toFixed(0)}h` : `in ${(h/24).toFixed(1)}d`;
  })() : null;

  return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"1rem" }}>

      {/* ── Heute ── */}
      <div style={{
        ...card,
        borderTop:`4px solid ${C.info}`,
        background:"linear-gradient(160deg,#f0f9ff 0%,#ffffff 55%)",
      }}>
        <p style={{ ...lbl, margin:"0 0 0.85rem", color:C.info }}>Heute</p>
        {todayLoading ? (
          <div style={{ color:C.dim, fontSize:"0.88rem" }}>Lädt…</div>
        ) : !todayStats || todayStats.totalVotes === 0 ? (
          <div style={{ color:C.dim, fontSize:"0.88rem" }}>{t("emptyNoVotesToday")}</div>
        ) : (
          <>
            <Hero val={String(todayStats.totalVotes)} unit="Votes" col={C.info}/>
            <Row label="Durchläufe"    value={String(todayStats.runsCount)}/>
            <Row label="Autoren"        value={String(todayStats.uniqueAuthors)}/>
            <Divider/>
            <Row label="VP verbraucht"   value={`−${vpConsumedPct.toFixed(1)}%`} col={C.warn} bold/>
            <Row label="→ Pending Pool" value={`+${fmtUsd(estCuration)}`}        col={C.ok}  bold/>
          </>
        )}
      </div>

      {/* ── Pending 7 Tage ── */}
      <div style={{
        ...card,
        borderTop:`4px solid ${C.ok}`,
        background:"linear-gradient(160deg,#f0fdf4 0%,#ffffff 55%)",
      }}>
        <p style={{ ...lbl, margin:"0 0 0.85rem", color:C.ok }}>Pending · 7 Tage</p>
        {pendingLoading ? (
          <div style={{ color:C.dim, fontSize:"0.88rem" }}>Lädt…</div>
        ) : !pendingCuration || pendingCuration.pendingUsd <= 0 ? (
          <div style={{ color:C.dim, fontSize:"0.88rem" }}>Keine offenen Curations</div>
        ) : (
          <>
            <Hero
              val={pendingCuration.pendingSp.toFixed(3)}
              unit="SP"
              col={C.ok}
              sub={`≈ ${fmtUsd(pendingCuration.pendingUsd)}`}
            />
            <Row label="Offene Posts"   value={String(pendingCuration.postCount)}/>
            <Row label="Votes (7d)"     value={String(pendingCuration.voteCount)}/>
            {nextPayout && nextPayoutLabel && (
              <>
                <Divider/>
                <div style={{ background:C.ok+"10", borderRadius:"8px", padding:"0.45rem 0.65rem", border:`1px solid ${C.ok}25` }}>
                  <div style={{ color:C.muted, fontSize:"0.72rem", fontWeight:600, marginBottom:"0.15rem" }}>Nächster Payout</div>
                  <div style={{ color:C.ok, fontWeight:900, fontSize:"1rem" }}>{nextPayoutLabel}</div>
                  <div style={{ color:C.dim, fontSize:"0.78rem" }}>{nextPayout.estimatedSp.toFixed(3)} SP · {fmtUsd(nextPayout.estimatedUsd)}</div>
                </div>
              </>
            )}
            {pendingCuration.computedAt && (
              <div style={{ color:C.faint, fontSize:"0.65rem", marginTop:"0.6rem" }}>
                Stand: {new Date(pendingCuration.computedAt).toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit"})} Uhr
                {pendingCuration.sbdPerSteemUsed && (
                  <span> · {pendingCuration.sbdPerSteemUsed.toFixed(4)} SBD/STEEM</span>
                )}
              </div>
            )}
            {pendingCuration.debug && <PendingDebugPanel data={pendingCuration} />}
          </>
        )}
      </div>

      {/* ── 30 Tage ── */}
      <div style={{
        ...card,
        borderTop:`4px solid ${C.purple}`,
        background:"linear-gradient(160deg,#faf5ff 0%,#ffffff 55%)",
      }}>
        <p style={{ ...lbl, margin:"0 0 0.85rem", color:C.purple }}>Verdient · 30 Tage</p>
        {pendingLoading ? (
          <div style={{ color:C.dim, fontSize:"0.88rem" }}>Lädt…</div>
        ) : !pendingCuration ? (
          <div style={{ color:C.dim, fontSize:"0.88rem" }}>—</div>
        ) : (
          <>
            <Hero
              val={pendingCuration.earned30dSp.toFixed(3)}
              unit="SP"
              col={C.purple}
              sub={`≈ ${fmtUsd(pendingCuration.earned30dUsd)}`}
            />
            <Row label="Payouts"        value={String(pendingCuration.earned30dCount)}/>
            <Divider/>
            <Row label="Ø / Payout"
              value={pendingCuration.earned30dCount > 0
                ? `${(pendingCuration.earned30dSp / pendingCuration.earned30dCount).toFixed(4)} SP`
                : "—"}/>
            {pendingCuration.earned30dCount > 0 && (
              <Row
                label="Ø / Tag"
                value={`${(pendingCuration.earned30dSp / 30).toFixed(3)} SP`}
                col={C.purple} bold
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Alle Durchläufe heute ─────────────────────────────────────────────────────

function AllRunsPanel({ todayStats, snapshot }: {
  todayStats: TodayStats|null;
  snapshot: SteemAccountSnapshot|null;
}) {
  const [expandedRun, setExpandedRun] = useState<number|null>(null);

  if (!todayStats || todayStats.runs.length === 0) return null;

  const voteUsd      = snapshot?.currentVoteUsd ?? 0;
  const currentVpPct = snapshot ? snapshot.votingPowerBps / 100 : null;
  const totalConsumed = todayStats.totalWeightBps / 5000;
  const vpBeforeDay   = currentVpPct !== null ? Math.min(100, currentVpPct + totalConsumed) : null;

  let cumConsumed = 0;
  const runsWithVp = todayStats.runs.map(run => {
    const vpBeforeRun = vpBeforeDay !== null ? Math.max(0, vpBeforeDay - cumConsumed) : null;
    const consumed    = run.weightBps / 5000;
    cumConsumed      += consumed;
    const vpAfterRun  = vpBeforeDay !== null ? Math.max(0, vpBeforeDay - cumConsumed) : null;
    return { run, vpBeforeRun, vpAfterRun, consumed };
  });

  const totalValue = (todayStats.totalWeightBps / 10000) * voteUsd;

  return (
    <div style={{ ...card, borderLeft:`3px solid ${C.ok}` }}>
      <p style={{ ...lbl, margin:"0 0 0.75rem" }}>Durchläufe heute</p>

      <div style={{ display:"flex", flexDirection:"column" as const, gap:"0.5rem" }}>
        {runsWithVp.map(({ run, vpBeforeRun, vpAfterRun, consumed }, i) => {
          const time      = new Date(run.startedAt).toLocaleTimeString("de-DE", { hour:"2-digit", minute:"2-digit" });
          const val       = (run.weightBps / 10000) * voteUsd;
          const expanded  = expandedRun === i;
          // Votes belonging to this run
          const runVotes  = todayStats.votes.filter(v =>
            v.votedAt >= run.startedAt && v.votedAt <= run.endedAt
          );
          return (
            <div key={i} style={{ background:C.inner, borderRadius:"10px", border:`1px solid ${expanded ? C.ok+"50" : C.border}`, overflow:"hidden" }}>
              {/* Run header — clickable */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => setExpandedRun(expanded ? null : i)}
                onKeyDown={e => e.key==="Enter" && setExpandedRun(expanded ? null : i)}
                style={{ padding:"0.75rem 1rem", cursor:"pointer", display:"flex", flexDirection:"column" as const, gap:"0.35rem" }}
              >
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span style={{ color:C.text, fontWeight:800, fontSize:"0.9rem" }}>
                    Durchlauf {i + 1}
                    <span style={{ color:C.dim, fontWeight:500, marginLeft:"0.5rem", fontSize:"0.82rem" }}>{time} Uhr</span>
                  </span>
                  <div style={{ display:"flex", alignItems:"center", gap:"0.6rem" }}>
                    <span style={{ color:C.ok, fontWeight:800, fontSize:"0.9rem" }}>{fmtUsd(val)}</span>
                    <span style={{ color:C.faint, fontSize:"0.78rem" }}>{expanded ? "▲" : "▼"}</span>
                  </div>
                </div>
                <div style={{ display:"flex", gap:"1.25rem", fontSize:"0.8rem", flexWrap:"wrap" as const }}>
                  <span style={{ color:C.info, fontWeight:700 }}>{run.voteCount} {run.voteCount===1?"Vote":"Votes"}</span>
                  <span style={{ color:C.text, fontWeight:600 }}>{run.authors.length} Autoren</span>
                  {vpBeforeRun !== null && vpAfterRun !== null
                    ? <span style={{ color:C.warn, fontWeight:700 }}>{vpBeforeRun.toFixed(1)}% → {vpAfterRun.toFixed(1)}% (−{consumed.toFixed(1)}%)</span>
                    : <span style={{ color:C.warn, fontWeight:700 }}>−{consumed.toFixed(1)}% VP</span>
                  }
                </div>
                {!expanded && (
                  <div style={{ fontSize:"0.73rem", color:C.dim }}>
                    {run.authors.map(a => <span key={a} style={{ marginRight:"0.45rem" }}>@{a}</span>)}
                  </div>
                )}
              </div>
              {/* Expanded vote list */}
              {expanded && (
                <div style={{ borderTop:`1px solid ${C.border}`, background:"#fff" }}>
                  {runVotes.map((v, vi) => (
                    <div key={vi} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"0.45rem 1rem", borderBottom: vi < runVotes.length - 1 ? `1px solid ${C.border}` : "none", fontSize:"0.78rem" }}>
                      <div>
                        <span style={{ color:C.info, fontWeight:700 }}>@{v.author}</span>
                        <span style={{ color:C.faint, marginLeft:"0.4rem" }}>{(v.weightBps / 100).toFixed(1)}%</span>
                      </div>
                      <div style={{ display:"flex", gap:"0.75rem", color:C.dim }}>
                        <span>{fmtUsd((v.weightBps / 10000) * voteUsd)}</span>
                        <span style={{ color:C.ok }}>+{fmtUsd((v.weightBps / 10000) * voteUsd * 0.25)}</span>
                        <span style={{ color:C.faint }}>{new Date(v.votedAt).toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit"})}</span>
                      </div>
                    </div>
                  ))}
                  <div style={{ padding:"0.4rem 1rem", background:C.inner, fontSize:"0.75rem", display:"flex", gap:"1.5rem", color:C.dim }}>
                    <span style={{ fontWeight:700, color:C.text }}>Gesamt</span>
                    <span style={{ color:C.ok, fontWeight:700 }}>+{fmtUsd(val * 0.25)} Curation</span>
                    <span>{fmtUsd(val)} verteilt</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Gesamt-Zeile */}
        <div style={{ borderTop:`2px solid ${C.border}`, paddingTop:"0.65rem", display:"flex", gap:"1.5rem", fontSize:"0.82rem", flexWrap:"wrap" as const, alignItems:"center" }}>
          <span style={{ color:C.text, fontWeight:800 }}>Gesamt heute</span>
          <span style={{ color:C.ok, fontWeight:700 }}>{todayStats.totalVotes} Votes</span>
          <span style={{ color:C.info, fontWeight:600 }}>{todayStats.uniqueAuthors} Autoren</span>
          <span style={{ color:C.warn, fontWeight:700 }}>−{totalConsumed.toFixed(1)}% VP</span>
          <span style={{ color:C.dim, fontWeight:600 }}>Vote-Wert: {fmtUsd(totalValue)}</span>
          <span style={{ color:C.ok, fontWeight:700 }}>+{fmtUsd(totalValue * 0.25)} Curation</span>
        </div>
      </div>
    </div>
  );
}

// ── VP-Graph mit Tooltip (heute, aus Vote-Events rekonstruiert) ───────────────

function VpGraphToday({ todayStats, snapshot }: {
  todayStats: TodayStats|null;
  snapshot: SteemAccountSnapshot|null;
}) {
  const [hoverIdx, setHoverIdx] = useState<number|null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const voteUsd = snapshot?.currentVoteUsd ?? 0;

  if (!todayStats || todayStats.votes.length === 0 || !snapshot) return null;

  // Build VP curve: work backwards from current VP
  const currentVp = snapshot.votingPowerBps / 100;
  // Accumulate total VP consumed today
  const totalConsumed = todayStats.votes.reduce((s, v) => s + v.weightBps / 5000, 0);
  // VP at start of day ≈ current + all consumed (minus regen — ignore regen for simplicity)
  const vpAtStart = Math.min(100, currentVp + totalConsumed);

  // Map each vote to its run number
  const votes = todayStats.votes;
  const runs  = todayStats.runs;
  function runIdxForVote(votedAt: string): number {
    for (let i = 0; i < runs.length; i++) {
      if (votedAt >= runs[i].startedAt && votedAt <= runs[i].endedAt) return i;
    }
    return -1;
  }

  // Pre-compute VP before/after per run for tooltip
  const runVpMap = new Map<number, { vpBefore: number; vpAfter: number }>();
  {
    let acc = vpAtStart;
    for (let i = 0; i < runs.length; i++) {
      const vpBefore = acc;
      const consumed = runs[i].weightBps / 5000;
      acc = Math.max(0, acc - consumed);
      runVpMap.set(i, { vpBefore, vpAfter: acc });
    }
  }

  type Point = { time: string; vp: number; weightBps: number; runIdx: number; runVotes: number; runAuthors: number; runVpBefore: number; runVpAfter: number };
  const points: Point[] = [];
  let vp = vpAtStart;
  for (let i = 0; i < votes.length; i++) {
    const v = votes[i];
    const consumed = v.weightBps / 5000;
    const ri = runIdxForVote(v.votedAt);
    const run = ri >= 0 ? runs[ri] : null;
    const rvp = ri >= 0 ? (runVpMap.get(ri) ?? { vpBefore: vp, vpAfter: vp }) : { vpBefore: vp, vpAfter: vp };
    points.push({
      time: v.votedAt, vp: Math.max(0, vp - consumed),
      weightBps: v.weightBps, runIdx: ri,
      runVotes: run?.voteCount ?? 1, runAuthors: run?.authors.length ?? 1,
      runVpBefore: rvp.vpBefore, runVpAfter: rvp.vpAfter,
    });
    vp = Math.max(0, vp - consumed);
  }
  // Add current point (no vote)
  points.push({ time: new Date().toISOString(), vp: currentVp, weightBps: 0, runIdx: -1, runVotes: 0, runAuthors: 0, runVpBefore: currentVp, runVpAfter: currentVp });

  const W = 400, H = 80;
  const pad = { l:8, r:8, t:8, b:8 };
  const vpMin = Math.max(0, Math.min(...points.map(p=>p.vp)) - 5);
  const vpMax = Math.min(100, vpAtStart + 2);
  const xScale = (i: number) => pad.l + (i / (points.length - 1)) * (W - pad.l - pad.r);
  const yScale = (v: number) => H - pad.b - ((v - vpMin) / (vpMax - vpMin || 1)) * (H - pad.t - pad.b);

  const pathD = points.map((p, i) => `${i===0?"M":"L"}${xScale(i).toFixed(1)},${yScale(p.vp).toFixed(1)}`).join(" ");
  const fillD = pathD + ` L${xScale(points.length-1).toFixed(1)},${H-pad.b} L${pad.l},${H-pad.b} Z`;

  const hovered = hoverIdx !== null ? points[hoverIdx] : null;

  return (
    <div style={{ ...card, paddingBottom:"0.5rem" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.4rem" }}>
        <p style={{ ...lbl, margin:0 }}>VP heute</p>
        <span style={{ color:C.dim, fontSize:"0.75rem", fontWeight:600 }}>{votes.length} Votes · {vpAtStart.toFixed(1)}% → {currentVp.toFixed(1)}%</span>
      </div>
      <div style={{ position:"relative" }}>
        <svg
          ref={svgRef}
          width="100%" viewBox={`0 0 ${W} ${H}`}
          style={{ display:"block", overflow:"visible" }}
          onMouseLeave={() => setHoverIdx(null)}
          onMouseMove={e => {
            const rect = svgRef.current?.getBoundingClientRect();
            if (!rect) return;
            const x = (e.clientX - rect.left) / rect.width * W;
            let closest = 0;
            let closestDist = Infinity;
            points.forEach((_, i) => { const d = Math.abs(xScale(i) - x); if (d < closestDist) { closestDist = d; closest = i; } });
            setHoverIdx(closest);
          }}
        >
          <defs>
            <linearGradient id="vpFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.ok} stopOpacity="0.25"/>
              <stop offset="100%" stopColor={C.ok} stopOpacity="0.02"/>
            </linearGradient>
          </defs>
          <path d={fillD} fill="url(#vpFill)"/>
          <path d={pathD} fill="none" stroke={C.ok} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          {hoverIdx !== null && (
            <line
              x1={xScale(hoverIdx)} y1={pad.t} x2={xScale(hoverIdx)} y2={H-pad.b}
              stroke={C.faint} strokeWidth="1" strokeDasharray="3,2"
            />
          )}
          {points.map((p, i) => p.weightBps > 0 && (
            <circle key={i} cx={xScale(i)} cy={yScale(p.vp)} r={hoverIdx===i?4:2.5}
              fill={hoverIdx===i?C.ok:C.ok+"99"} stroke="#fff" strokeWidth="1"/>
          ))}
        </svg>
        {hovered && hoverIdx !== null && (
          <div style={{
            position:"absolute",
            left: Math.min(Math.max(xScale(hoverIdx) / W * 100, 14), 70) + "%",
            top: "-4px",
            transform: "translateX(-50%)",
            background: "#0f172a", color:"#e2e8f0",
            borderRadius:"12px", padding:"0.7rem 1rem",
            fontSize:"0.8rem", lineHeight:1.75,
            pointerEvents:"none",
            boxShadow:"0 8px 24px rgba(0,0,0,0.4)",
            zIndex:10, minWidth:"180px",
          }}>
            {/* Header */}
            <div style={{ fontWeight:800, fontSize:"0.88rem", color:"#fff", marginBottom:"0.3rem", display:"flex", justifyContent:"space-between", alignItems:"baseline" }}>
              <span>{new Date(hovered.time).toLocaleTimeString("de-DE",{hour:"2-digit",minute:"2-digit"})} Uhr</span>
              {hovered.runIdx >= 0 && <span style={{ color:"#94a3b8", fontWeight:600, fontSize:"0.75rem" }}>Durchlauf #{hovered.runIdx+1}</span>}
            </div>
            {hovered.weightBps > 0 ? (
              <>
                {/* Run summary */}
                <div style={{ color:"#cbd5e1", marginBottom:"0.25rem" }}>
                  {hovered.runVotes} {hovered.runVotes===1?"Vote":"Votes"} · {hovered.runAuthors} Autoren
                </div>
                {/* VP before → after for whole run */}
                <div style={{ color:"#fcd34d", fontWeight:700 }}>
                  VP: {hovered.runVpBefore.toFixed(1)}% → {hovered.runVpAfter.toFixed(1)}%
                </div>
                <div style={{ color:"#94a3b8", fontSize:"0.74rem" }}>
                  −{(hovered.runVpBefore - hovered.runVpAfter).toFixed(2)}% VP
                </div>
                {/* Value */}
                <div style={{ borderTop:"1px solid #1e293b", marginTop:"0.35rem", paddingTop:"0.35rem" }}>
                  <div style={{ color:"#93c5fd" }}>Vote-Wert: {fmtUsd((hovered.weightBps/10000)*voteUsd)}</div>
                  <div style={{ color:"#6ee7b7", fontWeight:700 }}>+{fmtUsd((hovered.weightBps/10000)*voteUsd*0.25)} Est. Curation</div>
                </div>
              </>
            ) : (
              <div style={{ color:"#86efac", fontWeight:700 }}>VP jetzt: {hovered.vp.toFixed(1)}%</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── VoteBroker Earnings Card — Bar + Line combined chart ─────────────────────

type VBEarningsPeriod = "7d" | "30d" | "90d" | "all";

interface EnrichedDay {
  date:         string;
  realizedSp:   number;
  pendingSp:    number;   // estimated pending portion for this day
  totalSp:      number;   // realized + pending
  cumTotalSp:   number;   // running total incl. pending
  cumRealSp:    number;   // running total realized only
  votes:        number;
}

function enrichWithPending(data: DailyEarnings[], pendingSp: number): EnrichedDay[] {
  // Distribute pending proportionally across the last 7 days by vote count.
  // Days older than 7d can't have pending (posts already paid out).
  const last7 = data.slice(-7);
  const totalVotes7d = last7.reduce((s, d) => s + d.votes, 0);
  const cutoffIdx    = data.length - 7;

  let cumReal = 0, cumTotal = 0;
  return data.map((d, i) => {
    const dailyPending = (i >= cutoffIdx && totalVotes7d > 0)
      ? (d.votes / totalVotes7d) * pendingSp
      : 0;
    const totalSp = d.realizedSp + dailyPending;
    cumReal  += d.realizedSp;
    cumTotal += totalSp;
    return {
      date:       d.date,
      realizedSp: d.realizedSp,
      pendingSp:  Math.round(dailyPending * 10_000) / 10_000,
      totalSp:    Math.round(totalSp * 10_000) / 10_000,
      cumTotalSp: Math.round(cumTotal * 10_000) / 10_000,
      cumRealSp:  Math.round(cumReal  * 10_000) / 10_000,
      votes:      d.votes,
    };
  });
}

function VBEarningsChart({ data, pendingSp, sbdPerSteem }: {
  data: DailyEarnings[];
  pendingSp: number;
  sbdPerSteem: number;
}) {
  const [hoverIdx, setHoverIdx] = useState<number|null>(null);
  if (!data.length) return null;

  const PURPLE  = "#7c3aed";
  const ORANGE  = "#d97706";
  const enriched = useMemo(() => enrichWithPending(data, pendingSp), [data, pendingSp]);

  const maxBar = Math.max(...enriched.map(d => d.totalSp), 0.001);
  const maxCum = Math.max(enriched[enriched.length - 1]?.cumTotalSp ?? 0, 0.001);
  const W = 400, H = 108, PAD = 6;
  const barW  = Math.max(1, (W / enriched.length) * 0.62);
  const barX  = (i: number) => PAD + (i / enriched.length) * (W - 2*PAD) + barW * 0.2;
  const barH  = (sp: number) => Math.max(0, (sp / maxBar) * (H - PAD - 16));
  const lineX = (i: number) => PAD + ((i + 0.5) / enriched.length) * (W - 2*PAD);
  const lineY = (v: number) => H - PAD - ((v / maxCum) * (H - PAD - 16));

  const linePoints = enriched.map((d, i) => `${lineX(i)},${lineY(d.cumTotalSp)}`).join(" ");
  const hovD = hoverIdx !== null ? enriched[hoverIdx] : null;

  // Tooltip position — clamp to edges
  const tipPct = hoverIdx !== null
    ? Math.min(85, Math.max(15, ((hoverIdx + 0.5) / enriched.length) * 100))
    : 50;

  return (
    <div style={{ position:"relative", userSelect:"none" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
        style={{ width:"100%", height:"108px", display:"block" }}
        onMouseLeave={() => setHoverIdx(null)}>
        <defs>
          <linearGradient id="vb-cum-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={PURPLE} stopOpacity="0.12"/>
            <stop offset="100%" stopColor={PURPLE} stopOpacity="0.0"/>
          </linearGradient>
        </defs>

        {/* Area under cumulative line */}
        <polygon
          points={[
            `${lineX(0)},${H-PAD}`,
            ...enriched.map((d,i) => `${lineX(i)},${lineY(d.cumTotalSp)}`),
            `${lineX(enriched.length-1)},${H-PAD}`,
          ].join(" ")}
          fill="url(#vb-cum-grad)"/>

        {/* Stacked daily bars: realized (bottom, purple) + pending (top, orange) */}
        {enriched.map((d, i) => {
          const realH  = barH(d.realizedSp);
          const pendH  = barH(d.pendingSp);
          const totalH = realH + pendH;
          const isHov  = hoverIdx === i;
          return (
            <g key={i} style={{ cursor:"pointer" }} onMouseEnter={() => setHoverIdx(i)}>
              {/* Invisible hit area */}
              <rect x={barX(i)} y={H - PAD - totalH - 2} width={barW}
                height={totalH + 4} fill="transparent"/>
              {/* Pending portion (top, orange) */}
              {pendH > 0 && (
                <rect x={barX(i)} y={H - PAD - totalH} width={barW} height={pendH}
                  fill={isHov ? ORANGE : ORANGE + "aa"} rx="1.5"/>
              )}
              {/* Realized portion (bottom, purple) */}
              {realH > 0 && (
                <rect x={barX(i)} y={H - PAD - realH} width={barW} height={realH}
                  fill={isHov ? PURPLE : PURPLE + "bb"} rx="1.5"
                  style={{ borderRadius: pendH > 0 ? "0 0 1.5px 1.5px" : "1.5px" }}/>
              )}
              {/* Zero-vote day marker */}
              {totalH === 0 && (
                <line x1={barX(i) + barW/2} y1={H-PAD-1} x2={barX(i)+barW/2} y2={H-PAD+1}
                  stroke="#e2e8f0" strokeWidth="1"/>
              )}
            </g>
          );
        })}

        {/* Cumulative line */}
        <polyline points={linePoints} fill="none"
          stroke={PURPLE} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"
          style={{ pointerEvents:"none" }}/>

        {/* Hover dot on cumulative line */}
        {hoverIdx !== null && (
          <circle cx={lineX(hoverIdx)} cy={lineY(enriched[hoverIdx].cumTotalSp)}
            r={3.5} fill={PURPLE} stroke="white" strokeWidth="1.5"
            style={{ pointerEvents:"none" }}/>
        )}
      </svg>

      {/* Tooltip */}
      {hovD && (
        <div style={{
          position:"absolute", left:`${tipPct}%`, bottom:"108px",
          transform:"translateX(-50%)",
          background:"#1e293b", border:`1px solid ${PURPLE}55`,
          borderRadius:"10px", padding:"0.5rem 0.75rem",
          pointerEvents:"none", zIndex:10, whiteSpace:"nowrap",
          fontSize:"0.7rem", color:"#e2e8f0", lineHeight:1.6,
          boxShadow:"0 4px 12px rgba(0,0,0,0.3)",
        }}>
          <div style={{ fontWeight:700, color:"#c4b5fd", marginBottom:"0.25rem" }}>
            {new Date(hovD.date+"T12:00:00Z").toLocaleDateString("de-DE",{day:"numeric",month:"short"})}
          </div>
          {hovD.votes > 0 && (
            <div style={{ color:"#94a3b8", marginBottom:"0.2rem" }}>
              VoteBroker Votes: <b style={{ color:"#e2e8f0" }}>{hovD.votes}</b>
            </div>
          )}
          {hovD.realizedSp > 0 && (
            <div>Realisiert: <b style={{ color:"#a78bfa" }}>{hovD.realizedSp.toFixed(4)} SP</b></div>
          )}
          {hovD.pendingSp > 0 && (
            <div>Pending: <b style={{ color:ORANGE }}>{hovD.pendingSp.toFixed(4)} SP</b></div>
          )}
          {hovD.totalSp > 0 && (
            <div style={{ borderTop:"1px solid #334155", marginTop:"0.2rem", paddingTop:"0.2rem" }}>
              Gesamt: <b style={{ color:"#fff" }}>{hovD.totalSp.toFixed(4)} SP</b>
            </div>
          )}
          <div>Kumuliert: <b style={{ color:"#c4b5fd" }}>{hovD.cumTotalSp.toFixed(3)} SP</b></div>
          {hovD.totalSp > 0 && sbdPerSteem > 0 && (
            <div style={{ color:"#64748b" }}>
              ≈ {(hovD.totalSp * sbdPerSteem).toFixed(4)} SBD
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function VBEarningsCard({ session, pendingCuration, todayStats, snapshot, t }: {
  session: AuthSession;
  pendingCuration: PendingCuration|null;
  todayStats: TodayStats|null;
  snapshot: SteemAccountSnapshot|null;
  t: ReturnType<typeof createTranslator>;
}) {
  const [period, setPeriod] = useState<VBEarningsPeriod>("30d");
  const [data,   setData]   = useState<VBEarningsResult|null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetchVBEarnings(session.token, period)
      .then(setData).catch(()=>setData(null))
      .finally(()=>setLoading(false));
  }, [session.token, period]);

  const sbdPrStm = snapshot?.sbdPerSteem ?? 0.051;
  const periods: { id: VBEarningsPeriod; label: string }[] = [
    { id:"7d",  label:"7 Tage"  },
    { id:"30d", label:"30 Tage" },
    { id:"90d", label:"90 Tage" },
    { id:"all", label:"All-time"},
  ];

  const PURPLE     = "#7c3aed";
  const ORANGE     = "#d97706";
  const realizedSp = data?.totals.realizedSp ?? 0;
  const pendingSp  = pendingCuration?.pendingSp ?? 0;
  const totalSp    = realizedSp + pendingSp;   // what VoteBroker actually earned you
  const usdApprox  = totalSp * sbdPrStm;
  const todayVotes = todayStats?.totalVotes ?? 0;
  const spPerVote  = data && data.totals.voteCount > 0 ? totalSp / data.totals.voteCount : 0;
  const gameTip    = todayVotes > 0 && spPerVote > 0
    ? `✅ ${todayVotes} Votes heute · Ø ${spPerVote.toFixed(4)} SP pro Vote`
    : todayVotes > 0
    ? `✅ ${todayVotes} Votes heute durch VoteBroker verteilt`
    : `🌱 Starte heute deinen ersten VoteBroker-Run`;

  return (
    <div style={{ ...card, background:"linear-gradient(135deg,#faf5ff 0%,#f5f3ff 60%,#ede9fe 100%)" }}>
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.75rem" }}>
        <div style={{ display:"flex", alignItems:"center", gap:"0.5rem" }}>
          <span style={{ fontSize:"0.95rem" }}>💜</span>
          <span style={{ fontSize:"0.82rem", fontWeight:700, color:C.text, letterSpacing:"-0.2px" }}>
            Verdienst durch VoteBroker
          </span>
        </div>
        <div style={{ display:"flex", gap:"0.2rem" }}>
          {periods.map(p => (
            <button key={p.id} type="button" onClick={()=>setPeriod(p.id)}
              style={{ background: period===p.id ? PURPLE : "#f1f5f9",
                border:`1px solid ${period===p.id ? PURPLE : "#e2e8f0"}`,
                borderRadius:"5px", color: period===p.id ? "#fff" : C.dim,
                cursor:"pointer", fontSize:"0.65rem", fontWeight:700,
                padding:"0.18rem 0.45rem", lineHeight:1 }}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ color:C.faint, fontSize:"0.82rem", padding:"1rem 0", textAlign:"center" }}>Lädt…</div>
      ) : !data ? (
        <div style={{ color:C.faint, fontSize:"0.82rem", textAlign:"center", padding:"1rem 0" }}>
          Noch keine Earnings-Daten verfügbar.
        </div>
      ) : (
        <>
          {/* Attribution notice */}
          {data.notice && (
            <div style={{ background:"#fef3c7", border:"1px solid #fde047", borderRadius:"6px",
              padding:"0.35rem 0.6rem", fontSize:"0.7rem", color:"#713f12", marginBottom:"0.6rem" }}>
              ℹ {data.notice}
            </div>
          )}

          {/* Cause → Effect Narrative: "N Votes → X SP aufgebaut" */}
          <div style={{ display:"flex", alignItems:"stretch", gap:"0", marginBottom:"0.5rem" }}>

            {/* Cause: total VB Votes in period (same reference as the SP total) */}
            <div style={{
              background: "#ede9fe", borderRadius:"10px 0 0 10px",
              padding:"0.6rem 0.85rem", minWidth:"80px", textAlign:"center",
              borderRight:"2px solid #ddd6fe",
            }}>
              <div style={{ fontSize:"1.65rem", fontWeight:900, color:PURPLE, letterSpacing:"-1px", lineHeight:1 }}>
                {data.totals.voteCount > 0 ? data.totals.voteCount : "—"}
              </div>
              <div style={{ fontSize:"0.67rem", color:"#7c3aed", fontWeight:600, marginTop:"0.1rem" }}>
                Votes
              </div>
              {todayVotes > 0 && data.totals.voteCount > todayVotes && (
                <div style={{ fontSize:"0.58rem", color:"#a78bfa", marginTop:"0.1rem" }}>
                  davon {todayVotes} heute
                </div>
              )}
            </div>

            {/* Arrow */}
            <div style={{
              display:"flex", alignItems:"center", justifyContent:"center",
              background:"#f5f3ff", padding:"0 0.5rem",
              fontSize:"1rem", color:"#a78bfa",
            }}>↓</div>

            {/* Effect: SP aufgebaut */}
            <div style={{
              background:"#f5f3ff", borderRadius:"0 10px 10px 0",
              padding:"0.5rem 0.85rem", flex:1,
            }}>
              <div style={{ fontSize:"2rem", fontWeight:900, color:PURPLE, letterSpacing:"-1.5px", lineHeight:1 }}>
                {totalSp > 0 ? totalSp.toFixed(3) : "—"}
                <span style={{ fontSize:"0.85rem", fontWeight:700, marginLeft:"0.25rem", opacity:0.7 }}>SP</span>
              </div>
              <div style={{ fontSize:"0.68rem", color:C.dim, marginTop:"0.1rem", display:"flex", gap:"0.5rem", flexWrap:"wrap" }}>
                {totalSp > 0 && <span>≈ {usdApprox.toFixed(3)} SBD</span>}
                {realizedSp > 0 && <span style={{ color:"#a78bfa" }}>{realizedSp.toFixed(3)} realisiert</span>}
                {pendingSp > 0 && <span style={{ color:ORANGE }}>+{pendingSp.toFixed(3)} pending</span>}
              </div>
              {/* Rate: Ø SP per Vote */}
              {data.totals.voteCount > 0 && totalSp > 0 && (
                <div style={{ fontSize:"0.65rem", color:C.faint, marginTop:"0.08rem" }}>
                  Ø {(totalSp / data.totals.voteCount).toFixed(4)} SP pro Vote
                </div>
              )}
            </div>

            {/* Detail tooltip anchor */}
            <div title={`Attribution seit: ${data.attributionStart ?? "—"}\nRealisiert (on-chain): ${realizedSp.toFixed(4)} SP aus ${data.totals.realizedCount} Payouts\nPending: ${pendingSp.toFixed(4)} SP aus offenen Posts`}
              style={{ display:"flex", alignItems:"flex-start", padding:"0.3rem 0.3rem 0 0.4rem", cursor:"help" }}>
              <span style={{ fontSize:"0.6rem", color:C.faint }}>ℹ</span>
            </div>
          </div>

          {/* Bar + Line chart — shown when any votes OR pending exist */}
          {(data.dailyData.some(d => d.votes > 0) || pendingSp > 0) ? (
            <>
              {/* Legend */}
              <div style={{ fontSize:"0.62rem", color:C.faint, marginBottom:"0.25rem", display:"flex", gap:"1rem", alignItems:"center" }}>
                <span style={{ display:"flex", alignItems:"center", gap:"0.25rem" }}>
                  <span style={{ display:"inline-block", width:"8px", height:"8px", background:"#7c3aed", borderRadius:"2px" }}/>
                  Realisiert
                </span>
                <span style={{ display:"flex", alignItems:"center", gap:"0.25rem" }}>
                  <span style={{ display:"inline-block", width:"8px", height:"8px", background:"#d97706", borderRadius:"2px" }}/>
                  Pending
                </span>
                <span style={{ display:"flex", alignItems:"center", gap:"0.25rem" }}>
                  <span style={{ display:"inline-block", width:"14px", height:"2px", background:"#7c3aed", borderRadius:"1px" }}/>
                  kumuliert
                </span>
              </div>
              <VBEarningsChart
                data={data.dailyData}
                pendingSp={pendingSp}
                sbdPerSteem={sbdPrStm}
              />
            </>
          ) : (
            <div style={{ textAlign:"center", padding:"1.5rem 0",
              color:C.faint, fontSize:"0.8rem",
              border:`1px dashed #7c3aed33`, borderRadius:"8px" }}>
              Noch keine VoteBroker-Votes in diesem Zeitraum.
              {data.attributionStart && (
                <div style={{ marginTop:"0.3rem", fontSize:"0.7rem" }}>
                  Attribution aktiv seit {data.attributionStart}
                </div>
              )}
            </div>
          )}

          {/* Gamification */}
          <div style={{ marginTop:"0.55rem", paddingTop:"0.45rem",
            borderTop:`1px solid ${PURPLE}22`,
            fontSize:"0.73rem", color:C.dim, fontWeight:600 }}>
            {gameTip}
          </div>
        </>
      )}
    </div>
  );
}

// ── Quick Actions Card (unten) ─────────────────────────────────────────────────

function QuickActionsCard({ opportunities, onLoadOpps, onTabChange, onGenerateVotes, t }: {
  opportunities: PostOpportunity[]|null;
  onLoadOpps: ()=>void;
  onTabChange:(tab:"dna"|"dashboard"|"community"|"billing")=>void;
  onGenerateVotes: ()=>void;
  t: ReturnType<typeof createTranslator>;
}) {
  const openOpps=opportunities?.filter(p=>p.eligible)??[];
  return (
    <div style={{ ...card, maxWidth:"320px" }}>
      <p style={{ ...lbl, margin:"0 0 0.65rem" }}>{t("secQuickActions")}</p>
      <div style={{ display:"flex", flexDirection:"column" as const, gap:"0.4rem" }}>
        {([
          {icon:"🧬",label:t("btnVoteDna"), col:C.info,   fn:()=>onTabChange("dna")},
          {icon:"🗳", label:t("btnVotePlan"),col:C.purple, fn:()=>{onTabChange("dna");onGenerateVotes();}},
          {icon:"⚡", label:openOpps.length>0?`${t("btnOpportunities")} (${openOpps.length})`:t("btnScan"),col:openOpps.length>0?C.warn:C.muted,fn:()=>{onLoadOpps();onTabChange("dna");}},
          {icon:"⚙", label:t("btnSettings"),col:C.ok,     fn:()=>onTabChange("billing")},
        ] as const).map((a,i)=>(
          <button key={i} type="button" onClick={a.fn} style={{ background:`${a.col}10`, border:`1px solid ${a.col}30`, borderRadius:"7px", padding:"0.4rem 0.6rem", cursor:"pointer", textAlign:"left" as const, display:"flex", alignItems:"center", gap:"0.4rem" }}>
            <span style={{ fontSize:"0.85rem" }}>{a.icon}</span>
            <span style={{ color:C.text, fontSize:"0.75rem", fontWeight:700 }}>{a.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Author Strategy Grid ──────────────────────────────────────────────────────

function AuthorGrid({ rules, openOpps, snapshot, dnaMap, onTabChange, t }: {
  rules: StrategyRuleLite[]; openOpps: PostOpportunity[];
  snapshot: SteemAccountSnapshot|null;
  dnaMap: Map<string,CurationProfile["topAuthors"][number]>;
  onTabChange:(tab:"dna"|"dashboard"|"community"|"billing")=>void;
  t: ReturnType<typeof createTranslator>;
}) {
  if (rules.length===0) return (
    <div style={{ ...card, textAlign:"center", padding:"2rem" }}>
      <div style={{ fontSize:"2rem", marginBottom:"0.6rem" }}>🧬</div>
      <p style={{ color:C.text, fontSize:"0.88rem", margin:"0 0 0.85rem", fontWeight:600 }}>{t("emptyAuthors")}</p>
      <button type="button" onClick={()=>onTabChange("dna")} style={{ background:C.info+"15", border:`1px solid ${C.info}40`, borderRadius:"8px", color:C.info, cursor:"pointer", fontSize:"0.82rem", padding:"0.45rem 1rem", fontWeight:700 }}>{t("btnAnalyzeDna")}</button>
    </div>
  );

  const oppMap=new Map(openOpps.map(p=>[p.author,p]));
  const voteUsd=snapshot?.currentVoteUsd??0;

  return (
    <div style={card}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"1rem" }}>
        <p style={{ ...lbl, margin:0 }}>{t("secCuratedAuthors")} — {rules.length}
          {openOpps.length>0&&<span style={{ color:C.warn, marginLeft:"0.75rem" }}>⚡ {openOpps.length} new</span>}
        </p>
        <button type="button" onClick={()=>onTabChange("dna")} style={{ background:"none", border:`1px solid ${C.border}`, borderRadius:"6px", color:C.muted, cursor:"pointer", fontSize:"0.73rem", padding:"0.22rem 0.55rem" }}>{t("btnEditStrategy")}</button>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:"0.5rem" }}>
        {rules.slice(0,16).map(r=>{
          const cat=CAT_DEF[r.category]??{color:C.faint,icon:"⚪",tKey:"catNormal" as TranslationKey,pri:2};
          const op=oppMap.get(r.username);
          const dna=dnaMap.get(r.username);
          const est=Math.round(r.maxWeightPct/100*voteUsd*10000)/10000;
          return (
            <div key={r.username} style={{ background:op?`${cat.color}08`:C.inner, border:`1px solid ${op?`${cat.color}30`:C.border}`, borderRadius:"8px", padding:"0.6rem 0.75rem", display:"flex", gap:"0.5rem", alignItems:"flex-start" }}>
              <div style={{ width:"30px", height:"30px", borderRadius:"50%", flexShrink:0, background:`${cat.color}18`, border:`2px solid ${cat.color}30`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:"0.8rem", fontWeight:800, color:cat.color }}>
                {r.username[0]?.toUpperCase()}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:"0.25rem", flexWrap:"wrap" as const }}>
                  <span style={{ color:C.info, fontWeight:700, fontSize:"0.76rem" }}>@{r.username}</span>
                  {op&&<span style={{ color:cat.color, fontSize:"0.6rem", fontWeight:700 }}>⚡</span>}
                </div>
                <div style={{ fontSize:"0.68rem", color:C.muted, marginTop:"1px" }}>
                  {r.maxWeightPct}% · {fmtUsd(est)}{dna?` · ${dna.voteCount}v`:""}
                </div>
                {op&&<div style={{ fontSize:"0.65rem", color:cat.color, marginTop:"2px" }}>{fmtMin(op.ageMinutes)} ago</div>}
              </div>
            </div>
          );
        })}
        {rules.length>16&&(
          <div style={{ gridColumn:"1/-1", color:C.faint, fontSize:"0.73rem", textAlign:"center", paddingTop:"0.25rem" }}>
            +{rules.length-16} more · <span style={{ color:C.info, cursor:"pointer" }} onClick={()=>onTabChange("dna")}>view all →</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export function UserDashboard(props: {
  session: AuthSession; locale: Locale;
  snapshot: SteemAccountSnapshot|null; snapshotLoading: boolean; snapshotRefreshedAt?: Date;
  strategyRules: StrategyRuleLite[]|null;
  opportunities: PostOpportunity[]|null; opportunitiesLoading: boolean;
  opportunitiesMeta: OpportunitiesMeta|null;
  votePlan: VotePlanResponse|null;
  curationProfile: CurationProfile|null;
  recentVotes: RecentVote[];
  onTabChange:(tab:"dna"|"dashboard"|"community"|"billing")=>void;
  onGenerateVotes:()=>void; onLoadOpportunities:()=>void; onRefreshSnapshot?:()=>void;
}) {
  const t=createTranslator(props.locale);
  const { snapshot,strategyRules,opportunities,opportunitiesMeta,curationProfile }=props;

  const rules     =sortRules(strategyRules??[]);
  const openOpps  =opportunities?.filter(p=>p.eligible)??[];
  const dnaAuthors=curationProfile?.topAuthors??[];
  const dnaMap    =new Map(dnaAuthors.map(a=>[a.username,a]));
  const totalAuthors=curationProfile?.uniqueAuthors??0;

  const [growthData,   setGrowthData]   =useState<GrowthData|null>(null);
  const [growthLoading,setGrowthLoading]=useState(false);
  const [growthPeriod, setGrowthPeriod] =useState<"30d"|"90d"|"all">("all");

  const [todayStats,   setTodayStats]   =useState<TodayStats|null>(null);
  const [todayLoading, setTodayLoading] =useState(true);

  const [pendingCuration,  setPendingCuration]  =useState<PendingCuration|null>(null);
  const [pendingLoading,   setPendingLoading]   =useState(true);

  const loadTodayStats = () => {
    setTodayLoading(true);
    fetchTodayStats(props.session.token)
      .then(setTodayStats).catch(()=>{}).finally(()=>setTodayLoading(false));
  };

  const loadPendingCuration = () => {
    setPendingLoading(true);
    fetchPendingCuration(props.session.token, snapshot?.sbdPerSteem)
      .then(setPendingCuration).catch(()=>setPendingCuration(null)).finally(()=>setPendingLoading(false));
  };

  useEffect(()=>{
    setGrowthLoading(true);
    fetchGrowthData(props.session.token,growthPeriod)
      .then(setGrowthData).catch(()=>{}).finally(()=>setGrowthLoading(false));
  },[props.session.token,growthPeriod]);

  useEffect(()=>{
    loadTodayStats();
    loadPendingCuration();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[props.session.token]);

  // Refresh today stats whenever recentVotes changes (= after a vote run)
  const recentVotesLen = props.recentVotes.length;
  useEffect(()=>{
    if (recentVotesLen > 0) { loadTodayStats(); loadPendingCuration(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[recentVotesLen]);

  return (
    <div style={{ padding:"1.5rem 2rem", display:"flex", flexDirection:"column" as const, gap:"1.5rem" }}>

      {/* 1. Community Hero */}
      {curationProfile
        ? <CommunityHero profile={curationProfile} growth={growthData} t={t}/>
        : (
          <div style={{ ...card, display:"flex", alignItems:"center", gap:"0.85rem", padding:"1.1rem 1.5rem" }}>
            <span style={{ fontSize:"1.6rem" }}>🧬</span>
            <span style={{ color:C.muted, fontSize:"0.88rem", flex:1, lineHeight:1.5 }}>{t("emptyDnaHint")}</span>
            <button type="button" onClick={()=>props.onTabChange("dna")} style={{ background:C.info+"15", border:`1px solid ${C.info}40`, borderRadius:"8px", color:C.info, cursor:"pointer", fontSize:"0.82rem", padding:"0.45rem 1rem", fontWeight:700, flexShrink:0 }}>{t("btnAnalyzeDna")}</button>
          </div>
        )
      }

      {/* 2. VP + Offene Chancen */}
      <OperativeKPIRow
        snapshot={snapshot} snapshotLoading={props.snapshotLoading} snapshotRefreshedAt={props.snapshotRefreshedAt}
        opportunities={opportunities} opportunitiesMeta={opportunitiesMeta}
        onRefresh={props.onRefreshSnapshot} onLoadOpps={props.onLoadOpportunities}
        onTabChange={props.onTabChange} t={t}
      />

      {/* 2b. Curation Timeline: Heute | Pending 7d | 30 Tage */}
      <CurationTriple
        snapshot={snapshot}
        todayStats={todayStats} todayLoading={todayLoading}
        pendingCuration={pendingCuration} pendingLoading={pendingLoading}
        t={t}
      />

      {/* 2c. VoteBroker Earnings — attributierter Verdienst (Bar+Line chart) */}
      <VBEarningsCard
        session={props.session}
        pendingCuration={pendingCuration}
        todayStats={todayStats}
        snapshot={snapshot}
        t={t}
      />

      {/* 2b. Letzter Durchlauf + VP-Graph */}
      {(todayStats?.lastRun || (todayStats && todayStats.votes.length > 0)) && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"1rem" }}>
          <AllRunsPanel todayStats={todayStats} snapshot={snapshot}/>
          <VpGraphToday todayStats={todayStats} snapshot={snapshot}/>
        </div>
      )}

      {/* 3+4. Curator Journey | Beziehungen | Aktivität */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"1.5rem", alignItems:"start" }}>
        <div style={card}>
          <p style={lbl}>{t("secCuratorJourney")}</p>
          <CuratorJourney totalAuthors={growthData?.summary.totalUniqueAuthors??totalAuthors} t={t}/>
        </div>
        <div style={card}>
          <p style={lbl}>{t("secRelationships")}</p>
          {dnaAuthors.length>0
            ?<RelationshipsPanel authors={dnaAuthors} t={t}/>
            :<p style={{ color:C.faint, fontSize:"0.82rem", margin:0 }}>{t("emptyDnaHint")}</p>}
        </div>
        <div style={card}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.75rem" }}>
            <p style={{ ...lbl, margin:0 }}>{t("secRecentActivity")}</p>
            {todayStats && todayStats.totalVotes > 0 && <span style={{ color:C.faint, fontSize:"0.68rem" }}>{todayStats.totalVotes} heute</span>}
          </div>
          <ActivityTimeline votes={todayStats?.votes.slice(0,8).map(v=>({ author:v.author, permlink:v.permlink, title:"", weightPct:v.weightBps/100, votedAt:v.votedAt }))??[]} voteUsd={snapshot?.currentVoteUsd??0} opps={opportunities}
            onAction={{plan:()=>{props.onTabChange("dna");props.onGenerateVotes();},opps:props.onLoadOpportunities,dna:()=>props.onTabChange("dna")}} t={t}/>
        </div>
      </div>

      {/* 5. Wachstum */}
      <CommunityGrowthChart
        growth={growthData} growthLoading={growthLoading}
        growthPeriod={growthPeriod} setGrowthPeriod={setGrowthPeriod} t={t}
      />

      {/* 6. Autorenliste */}
      {strategyRules!==null&&(
        <AuthorGrid rules={rules} openOpps={openOpps} snapshot={snapshot} dnaMap={dnaMap} onTabChange={props.onTabChange} t={t}/>
      )}

      {/* 7. Aktionen */}
      <QuickActionsCard
        opportunities={opportunities} onLoadOpps={props.onLoadOpportunities}
        onTabChange={props.onTabChange} onGenerateVotes={props.onGenerateVotes} t={t}
      />

    </div>
  );
}
