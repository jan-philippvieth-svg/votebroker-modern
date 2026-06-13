import { useEffect, useMemo, useRef, useState } from "react";
import { Users, Dna, Target, type LucideIcon } from "lucide-react";
import { todayString, startOfLocalDay, localDateString } from "../utils/timezone";
import type {
  AuthSession, CurationProfile, DailyEarnings, DailyHistoryPoint, DailyHistoryResult,
  DailyHistorySummary, GrowthAnalytics, GrowthBucket, GrowthData, OpportunitiesMeta,
  PendingCuration, PendingDebugPost, PostOpportunity, SteemAccountSnapshot, TodayStats,
  VBEarningsResult, VotePlanResponse, VpBudget,
} from "../api";
import { fetchGrowthAnalytics, fetchGrowthAnalyticsVersion, fetchVBEarnings, fetchVpBudget } from "../api";
import { fetchDailyHistory, fetchGrowthData, fetchPendingCuration, fetchTodayStats } from "../api";
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

  // ── Semantic color system (DO NOT REUSE for other meanings) ────────────────
  // 🟢 ok     = Realisiert / verdient / Erfolg / abgeschlossen
  // 🟠 warn   = Pending / offen / wartet auf Auszahlung
  // 🔴 err    = Kosten / Fees / Fehler / Verluste
  // 🔵 info   = Aktionen / Links / Navigation / operative Metriken
  // 🟣 purple = Lifetime / Aggregation / Statistik / neutraler Verlauf
  // Every new card must use one of these five — not a custom color.
  ok:      "#16a34a",   // 🟢 realized / earned / success
  warn:    "#d97706",   // 🟠 pending / open / waiting
  err:     "#dc2626",   // 🔴 cost / fee / error / loss
  info:    "#2563eb",   // 🔵 action / link / navigation / activity
  purple:  "#7c3aed",   // 🟣 lifetime / aggregate / statistic
  teal:    "#0d9488",   // Community tab primary (contextual, not semantic)
  fire:    "#ea580c",   // (deprecated — use warn instead)
  gold:    "#d97706",   // (deprecated — use warn instead)

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

function vpCol(v: number)  { return v >= 70 ? C.ok : v >= 50 ? C.warn : C.err; }
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
function votesPerDay7(votes: RecentVote[], tz?: string): Array<{ short: string; count: number }> {
  const result: Record<string, number> = {};
  const todayStart = startOfLocalDay(new Date(), tz);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(todayStart.getTime() - i * 86_400_000);
    result[localDateString(d, tz)] = 0;
  }
  for (const v of votes) {
    const day = localDateString(new Date(v.votedAt), tz);
    if (day in result) result[day]++;
  }
  const labels = ["Su","Mo","Tu","We","Th","Fr","Sa"];
  return Object.entries(result).map(([day, count]) => ({ count, short: labels[new Date(day+"T12:00:00Z").getUTCDay()] }));
}

// ── Community Hero ─────────────────────────────────────────────────────────────

function CommunityHero({ profile, growth, todayStats, snapshot, t }: {
  profile: CurationProfile; growth: GrowthData | null;
  todayStats: TodayStats | null;
  snapshot: SteemAccountSnapshot | null;
  t: ReturnType<typeof createTranslator>;
}) {
  const totalAuthors = growth?.summary.totalUniqueAuthors ?? profile.uniqueAuthors;
  const totalVotes   = growth?.summary.totalVotes         ?? profile.votesAnalyzed;
  const activeDays   = growth?.summary.activeDays         ?? profile.periodDays;
  const streak       = growth?.summary.longestStreak ?? 0;
  const currStreak   = growth?.summary.currentStreak ?? 0;

  // Profile KPIs (primary — left, large)
  const profileKpis = [
    { value: totalAuthors.toLocaleString(), label: t("impactAuthors"),   color: C.purple },
    { value: totalVotes.toLocaleString(),   label: t("impactVotes"),     color: C.info   },
    { value: String(activeDays),            label: t("impactActiveDays"), color: C.teal  },
  ];

  // Serie komprimiert: "42d / 7d laufend" als ein Wert
  const serieVal = streak > 0
    ? (currStreak > 1 ? `${streak}d · ${currStreak}d` : `${streak}d`)
    : "—";
  const serieLabel = currStreak > 1
    ? `${t("impactStreak")} · ${t("impactCurrentStreak")}`
    : t("impactStreak");

  // Daily VP — right side compact
  const currentVp  = snapshot ? snapshot.votingPowerBps / 100 : null;
  const vpConsumed = todayStats ? todayStats.totalWeightBps / 5000 : 0;
  const vpStart    = currentVp !== null ? Math.min(100, Math.round((currentVp + vpConsumed) * 10) / 10) : null;
  const votesToday = todayStats?.totalVotes ?? 0;
  const vpNowColor = currentVp !== null && currentVp >= 80 ? C.ok : currentVp !== null && currentVp >= 60 ? C.warn : C.err;

  return (
    <div style={{
      background: "linear-gradient(135deg, #f0eafe 0%, #ffffff 55%, #e8faf7 100%)",
      borderRadius: "20px", padding: "2rem 2.25rem",
      boxShadow: SHADOW_MD,
      border: `1px solid #e0d4fc`,
      display: "flex", flexDirection: "column" as const, gap: "1.5rem",
    }}>
      {/* Account identity — neutral header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ color: C.purple, fontWeight:800, fontSize:"1.05rem" }}>@{profile.username}</div>
        <div style={{ color: C.faint, fontSize:"0.68rem" }}>{profile.avgWeightPct}% {t("kpiAvgWeight").toLowerCase()}</div>
      </div>

      {/* KPI-Zeile: Profil-Metriken (links, groß) + Tages-VP (rechts, kompakt) */}
      <div style={{ display:"flex", gap:0, alignItems:"stretch" }}>

        {/* Profil-KPIs — Autoren, Votes, Aktive Tage */}
        {profileKpis.map((k, i) => (
          <div key={i} style={{
            flex:1,
            textAlign:"center" as const,
            padding:"0.5rem 0.75rem",
            borderRight:`1px solid ${C.border}`,
          }}>
            <div style={{ color:k.color, fontSize:"2.6rem", fontWeight:900, lineHeight:1, letterSpacing:"-1.5px" }}>
              {k.value}
            </div>
            <div style={{ color:C.muted, fontSize:"0.68rem", fontWeight:700, letterSpacing:"0.8px", textTransform:"uppercase" as const, marginTop:"0.3rem" }}>
              {k.label}
            </div>
          </div>
        ))}

        {/* Serie komprimiert */}
        {streak > 0 && (
          <div style={{ flex:1, textAlign:"center" as const, padding:"0.5rem 0.75rem", borderRight:`1px solid ${C.border}` }}>
            <div style={{ color:C.warn, fontSize:"2.6rem", fontWeight:900, lineHeight:1, letterSpacing:"-1.5px" }}>{serieVal}</div>
            <div style={{ color:C.muted, fontSize:"0.68rem", fontWeight:700, letterSpacing:"0.8px", textTransform:"uppercase" as const, marginTop:"0.3rem" }}>{serieLabel}</div>
          </div>
        )}

        {/* Tages-VP — rechts, 3 Zeilen kompakt */}
        <div style={{
          display:"flex", flexDirection:"column" as const, justifyContent:"center",
          padding:"0.5rem 0.75rem 0.5rem 1rem", gap:"0.3rem", minWidth:"120px",
        }}>
          {[
            { val: vpStart !== null ? `${vpStart.toFixed(1)}%` : "—", lbl: t("kpiVpStartToday"), col: C.muted },
            { val: String(votesToday),                                  lbl: t("kpiVotesToday"),   col: C.info  },
            { val: currentVp !== null ? `${currentVp.toFixed(1)}%` : "—", lbl: t("kpiVpNow"),  col: vpNowColor },
          ].map((row, i) => (
            <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:"0.5rem" }}>
              <span style={{ color:C.faint, fontSize:"0.65rem", fontWeight:600, textTransform:"uppercase" as const, whiteSpace:"nowrap" as const }}>{row.lbl}</span>
              <span style={{ color:row.col, fontWeight:800, fontSize:"0.85rem" }}>{row.val}</span>
            </div>
          ))}
        </div>
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


// ── Contextual Hints ─────────────────────────────────────────────────────────
// Small action chips, rendered only when a setup step is missing.
// When all conditions are met the component returns null — zero space taken.

function ContextualHints({ hasCommunity, hasDna, hasStrategy, onTabChange, t }: {
  hasCommunity: boolean;
  hasDna: boolean;
  hasStrategy: boolean;
  onTabChange: (tab: "dna" | "dashboard" | "community" | "billing") => void;
  t: ReturnType<typeof createTranslator>;
}) {
  const hints: Array<{ icon: LucideIcon; label: string; tab: "community" | "dna"; color: string }> = [];
  if (!hasCommunity) hints.push({ icon: Users,  label: t("stepCommunity"), tab: "community", color: C.purple });
  if (!hasDna)       hints.push({ icon: Dna,    label: t("stepDna"),       tab: "dna",       color: C.info   });
  if (!hasStrategy)  hints.push({ icon: Target, label: t("stepStrategy"),  tab: "dna",       color: C.ok     });
  if (hints.length === 0) return null;
  return (
    <div style={{ display:"flex", gap:"0.5rem", flexWrap:"wrap" as const }}>
      {hints.map(h => {
        const Icon = h.icon;
        return (
          <button key={h.label} type="button" onClick={() => onTabChange(h.tab)}
            style={{
              display:"flex", alignItems:"center", gap:"0.4rem",
              padding:"0.35rem 0.8rem",
              background:`${h.color}10`, border:`1px solid ${h.color}30`,
              borderRadius:"20px", color:h.color,
              cursor:"pointer", fontSize:"0.78rem", fontWeight:700,
              transition:"background 0.12s",
            }}
          >
            <Icon size={12} strokeWidth={2} />
            {h.label}
          </button>
        );
      })}
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
                <div style={{ color:C.faint, fontSize:"0.6rem" }}>{t("unitVotes")}</div>
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
    <div data-testid="dashboard-marketing-section" style={{ display:"grid", gridTemplateColumns:"1.4fr 1fr", gap:"1rem" }}>

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
              {snapshot&&<span style={{ color:C.info, fontSize:"0.9rem", fontWeight:700, marginLeft:"auto" }}>{fmtUsd(snapshot.currentVoteUsd)}<span style={{ color:C.dim, fontSize:"0.78rem", fontWeight:400 }}>/vote</span></span>}
            </div>
            <div style={{ height:"7px", background:C.inner, borderRadius:"4px", overflow:"hidden", marginBottom:"0.4rem", border:`1px solid ${C.border}` }}>
              <div style={{ height:"100%", width:`${vpPct}%`, background:vpCol(vpPct), borderRadius:"4px", transition:"width 0.6s" }}/>
            </div>
            {(()=>{
              const regenH=vpPct>=99.9?0:(100-vpPct)/20*24;
              const to90=vpPct>=90?null:(90-vpPct)/20*24;
              return (
                <div style={{ display:"flex", gap:"0.5rem", fontSize:"0.85rem" }}>
                  {to90&&<span style={{ color:C.ok, fontWeight:600 }}>{t("vpTo90In")} {to90<1?`${Math.round(to90*60)}m`:`${to90.toFixed(1)}h`}</span>}
                  {regenH>0&&<span style={{ color:C.dim, marginLeft:"auto" }}>{t("vpFullIn")} {regenH<1?`${Math.round(regenH*60)}m`:`${regenH.toFixed(1)}h`}</span>}
                  {regenH===0&&<span style={{ color:C.ok, marginLeft:"auto" }}>✓ {t("vpFullyCharged")}</span>}
                </div>
              );
            })()}
            {snapshot&&<div style={{ color:C.dim, fontSize:"0.85rem", marginTop:"0.4rem" }}>{snapshot.steemPowerSp.toFixed(0)} SP · 100%: {fmtUsd(snapshot.fullPowerVoteUsd)}</div>}
          </>
        ):(
          <div style={{ color:C.dim, fontSize:"0.82rem" }}>{snapshotLoading?t("loading"):"—"}</div>
        )}
        {snapshotRefreshedAt&&<div style={{ color:C.faint, fontSize:"0.73rem", marginTop:"0.3rem" }}>{fmtAge(snapshotRefreshedAt.toISOString(),t)}</div>}
      </div>

      {/* Offene Chancen */}
      <div
        style={{ ...card, cursor:"pointer" }}
        onClick={() => {
          if (opportunities === null) onLoadOpps();
          onTabChange("dna");
        }}
      >
        <p style={{ ...lbl, margin:"0 0 0.6rem" }}>{t("kpiOpenOpps")}</p>

        {opportunities === null ? (
          /* Not yet scanned */
          <>
            <div style={{ color:C.muted, fontSize:"2.6rem", fontWeight:900, lineHeight:1, letterSpacing:"-1px", marginBottom:"0.5rem" }}>—</div>
            <div style={{ fontSize:"0.9rem", color:C.muted }}>{t("oppTapToDiscover")}</div>
          </>
        ) : openOpps.length > 0 ? (
          /* Open votes available */
          <>
            <div style={{ color:C.warn, fontSize:"2.6rem", fontWeight:900, lineHeight:1, letterSpacing:"-1px", marginBottom:"0.5rem" }}>
              {openOpps.length}
            </div>
            <div style={{ fontSize:"0.9rem", display:"flex", flexDirection:"column" as const, gap:"0.2rem" }}>
              {openOpps.filter(p=>p.postScore>=80).length > 0 && (
                <span style={{ color:C.warn, fontWeight:700 }}>
                  {openOpps.filter(p=>p.postScore>=80).length} {t("oppOptimalWindow")}
                </span>
              )}
              {opportunitiesMeta && (
                <span style={{ color:C.dim }}>
                  {opportunitiesMeta.scannedAuthors}/{opportunitiesMeta.requestedAuthors} {t("oppScanned")}
                </span>
              )}
            </div>
          </>
        ) : (
          /* All voted — positive empty state */
          <>
            <div style={{ color:C.ok, fontSize:"1.6rem", fontWeight:900, lineHeight:1, marginBottom:"0.4rem" }}>
              ✓
            </div>
            <div style={{ fontSize:"0.9rem", display:"flex", flexDirection:"column" as const, gap:"0.25rem" }}>
              <span style={{ color:C.ok, fontWeight:700 }}>{t("oppAllVoted")}</span>
              {opportunitiesMeta && (
                <span style={{ color:C.dim }}>
                  {opportunitiesMeta.scannedAuthors}/{opportunitiesMeta.requestedAuthors} {t("oppScanned")}
                </span>
              )}
              <span style={{ color:C.dim }}>{t("oppNoneFound")}</span>
              {(() => {
                const voted = (opportunities ?? []).filter(p => p.alreadyVoted && p.remainingHours > 0);
                const minRemaining = voted.length > 0
                  ? Math.min(...voted.map(p => p.remainingHours))
                  : null;
                return (
                  <span style={{ color:C.faint, fontSize:"0.85rem", marginTop:"0.1rem" }}>
                    {t("oppNextScanIn")}{" "}
                    <b style={{ color:C.dim }}>
                      {minRemaining !== null && minRemaining < 2
                        ? t("opp30min")
                        : t("opp60min")}
                    </b>
                  </span>
                );
              })()}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Curation Timeline (Heute | Pending 7d | 30 Tage) ─────────────────────────

const PAGE_SIZE = 15;

function PendingDebugPanel({ data, t }: { data: PendingCuration; t: ReturnType<typeof createTranslator> }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"top" | "next">("top");
  const [page, setPage] = useState(0);
  const db = data.debug;
  const skipped = db.skipped;
  const totalSkipped = skipped.alreadyPaidOut + skipped.payoutZero + skipped.noVoteFound + skipped.weightZero + skipped.limitReached;

  const tdR: React.CSSProperties = { textAlign: "right", padding: "0.15rem 0.4rem", fontVariantNumeric: "tabular-nums" };
  const tdL: React.CSSProperties = { textAlign: "left",  padding: "0.15rem 0.4rem", color: C.dim };

  const allPosts    = db.posts       ?? [];
  const allByTime   = db.postsByTime ?? [];

  const sourcePosts = view === "top" ? allPosts : allByTime;
  const totalPages  = Math.ceil(sourcePosts.length / PAGE_SIZE);
  const visiblePage = Math.min(page, Math.max(0, totalPages - 1));
  const pagePosts   = sourcePosts.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE);

  const spDelta = data.pendingSpRshares != null
    ? Math.round((data.pendingSpRshares - data.pendingSp) * 1_000) / 1_000
    : null;

  return (
    <div style={{ marginTop: "1rem", borderTop: `1px solid ${C.border}`, paddingTop: "0.6rem" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ background: "none", border: "none", cursor: "pointer", color: C.muted, fontSize: "0.72rem", padding: 0, display: "flex", alignItems: "center", gap: "0.3rem" }}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>{t("debugTitle")}</span>
        <span style={{ color: C.faint }}>· {data.sbdPerSteemUsed.toFixed(4)} SBD/SP · {totalSkipped} {t("debugSkipped")}</span>
      </button>

      {open && (
        <div style={{ marginTop: "0.6rem", fontSize: "0.73rem", color: C.text }}>

          {/* ── Coverage + Preis + Methoden-Vergleich ── */}
          <div style={{ marginBottom: "0.5rem", padding: "0.3rem 0.5rem", background: "#fffbe6", borderRadius: "6px", border: "1px solid #f5d000" }}>
            <div>
              <strong>{t("debugCoverage")}</strong>&nbsp;
              {db.uniqueTotal} unique Posts&nbsp;·&nbsp;
              {db.fetched} {t("debugFetched")}&nbsp;·&nbsp;
              {data.postCount} {t("debugOpenWithValue")}
              {db.skipped.limitReached > 0 && (
                <span style={{ color: "#c00", fontWeight: 700 }}>&nbsp;· ⚠ {db.skipped.limitReached} {t("debugLimitSkipped")}</span>
              )}
            </div>
            <div style={{ marginTop: "0.2rem" }}>
              {t("debugCalculatedWith")}&nbsp;<strong>{data.sbdPerSteemUsed.toFixed(4)} SBD/SP</strong>
              &nbsp;·&nbsp;{t("debugSumPending")} <strong title={t("debugSumPendingTip")}>{db.totalPayoutUsd.toFixed(2)} SBD</strong>
            </div>
            {spDelta !== null && (
              <div style={{ marginTop: "0.25rem", display: "flex", gap: "1rem", flexWrap: "wrap" }}>
                <span>weight: <strong style={{ color: C.ok }}>{data.pendingSp.toFixed(3)} SP</strong></span>
                <span>rshares: <strong style={{ color: C.dim }}>{data.pendingSpRshares.toFixed(3)} SP</strong></span>
                <span style={{ color: Math.abs(spDelta) > 0.05 ? C.warn : C.faint }}>
                  Δ {spDelta > 0 ? "+" : ""}{spDelta.toFixed(3)} SP
                </span>
              </div>
            )}
          </div>

          {/* ── Übersprungene Posts ── */}
          {totalSkipped > 0 && (
            <div style={{ marginBottom: "0.5rem" }}>
              <div style={{ fontWeight: 700, marginBottom: "0.25rem", color: C.warn }}>{t("debugSkippedSection")} ({totalSkipped})</div>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <tbody>
                  {skipped.alreadyPaidOut > 0 && <tr><td style={tdL}>{t("debugAlreadyPaid")}</td><td style={tdR}>{skipped.alreadyPaidOut}</td></tr>}
                  {skipped.payoutZero     > 0 && <tr><td style={tdL}>pending_payout = 0</td><td style={tdR}>{skipped.payoutZero}</td></tr>}
                  {skipped.noVoteFound    > 0 && <tr><td style={tdL}>Kein eigener Vote in active_votes</td><td style={tdR}>{skipped.noVoteFound}</td></tr>}
                  {skipped.weightZero     > 0 && <tr><td style={tdL}>{t("debugEarlyVote")}</td><td style={tdR}>{skipped.weightZero}</td></tr>}
                  {skipped.limitReached   > 0 && <tr><td style={tdL}>Limit überschritten</td><td style={tdR}>{skipped.limitReached}</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Post-Breakdown mit Pagination ── */}
          {sourcePosts.length > 0 && (
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.35rem" }}>
                <span style={{ fontWeight: 700 }}>
                  {view === "top"
                    ? t("debugTopPosts").replace("{{n}}", String(allPosts.length))
                    : t("debugNextPayouts").replace("{{n}}", String(allByTime.length))}
                </span>
                <div style={{ display: "flex", gap: "0.25rem", marginLeft: "auto" }}>
                  {(["top", "next"] as const).map(v => (
                    <button key={v}
                      onClick={() => { setView(v); setPage(0); }}
                      style={{
                        background: view === v ? C.info : "none",
                        color:      view === v ? "#fff" : C.muted,
                        border:     `1px solid ${view === v ? C.info : C.border}`,
                        borderRadius: "4px", padding: "0.1rem 0.5rem",
                        fontSize: "0.7rem", cursor: "pointer",
                        fontWeight: view === v ? 700 : 400,
                      }}
                    >{v === "top" ? t("debugTabTop") : t("debugTabNext")}</button>
                  ))}
                </div>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "580px" }}>
                  <thead>
                    <tr style={{ background: C.border + "55" }}>
                      <th style={{ ...tdL, fontWeight: 600 }}>{t("debugColAuthor")}</th>
                      <th style={{ ...tdR, fontWeight: 600, color: C.warn }}>{t("debugColDue")}</th>
                      <th style={{ ...tdR, fontWeight: 600 }}>{t("debugColPoolSbd")}</th>
                      <th style={{ ...tdR, fontWeight: 600 }}>{t("debugColWeight")}</th>
                      <th style={{ ...tdR, fontWeight: 600, color: C.ok }}>{t("debugColEstSP")}</th>
                      <th style={{ ...tdR, fontWeight: 600, color: C.dim }}>{t("debugColEstRshares")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagePosts.map((p: PendingDebugPost, i: number) => {
                      const msLeft = new Date(p.cashoutTime + "Z").getTime() - Date.now();
                      const h = Math.floor(msLeft / 3_600_000);
                      const m = Math.floor((msLeft % 3_600_000) / 60_000);
                      const countdown = msLeft <= 0 ? t("debugDueNow") : h > 0 ? `${h}h ${m}m` : `${m}m`;
                      return (
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
                          <td style={{ ...tdR, color: C.warn, fontWeight: 600, whiteSpace: "nowrap" }}>{countdown}</td>
                          <td style={tdR}>{p.pendingPayoutSbd.toFixed(3)}</td>
                          <td style={tdR}>{p.sharePctWeight.toFixed(3)}%</td>
                          <td style={{ ...tdR, color: C.ok, fontWeight: 700 }}>{p.estimatedSp.toFixed(4)}</td>
                          <td style={{ ...tdR, color: C.dim }}>{p.estimatedSpRshares.toFixed(4)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {sourcePosts.length > PAGE_SIZE && (
                    <tfoot>
                      <tr>
                        <td colSpan={6} style={{ padding: "0.3rem 0.4rem", textAlign: "center" }}>
                          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "0.5rem" }}>
                            <button
                              disabled={visiblePage === 0}
                              onClick={() => setPage(p => Math.max(0, p - 1))}
                              style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: "4px", padding: "0.1rem 0.5rem", cursor: visiblePage === 0 ? "default" : "pointer", color: visiblePage === 0 ? C.faint : C.muted, fontSize: "0.7rem" }}
                            >‹</button>
                            <span style={{ color: C.faint, fontSize: "0.7rem" }}>
                              {visiblePage + 1} / {totalPages} · {sourcePosts.length} Posts
                            </span>
                            <button
                              disabled={visiblePage >= totalPages - 1}
                              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                              style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: "4px", padding: "0.1rem 0.5rem", cursor: visiblePage >= totalPages - 1 ? "default" : "pointer", color: visiblePage >= totalPages - 1 ? C.faint : C.muted, fontSize: "0.7rem" }}
                            >›</button>
                          </div>
                        </td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── VP Budget Row ─────────────────────────────────────────────────────────────

function VpBudgetRow({ budget, todayWeightBps, t }: {
  budget: VpBudget | null;
  todayWeightBps: number | null;
  t: ReturnType<typeof createTranslator>;
}) {
  if (!budget) return null;

  const statusColor =
    budget.status === "recovering" ? C.ok   :
    budget.status === "depleting"  ? C.err  : C.info;
  const statusIcon =
    budget.status === "recovering" ? "↑" :
    budget.status === "depleting"  ? "↓" : "↔";

  const avgPct    = budget.avgDailySpendBps / 100;
  const regenPct  = (budget.regenBps / 100).toFixed(0);
  const netPct    = (Math.abs(budget.netDailyBps) / 100).toFixed(1);
  const netSign   = budget.netDailyBps >= 0 ? "+" : "−";

  // Today's VP spend derived from todayStats (same formula as CurationTriple)
  const todayPct  = todayWeightBps !== null ? todayWeightBps / 5000 : null;
  const diff      = todayPct !== null ? todayPct - avgPct : null;
  const diffSign  = diff !== null && diff >= 0 ? "+" : "−";
  const diffCol   = diff === null ? C.faint : diff > 2 ? C.err : diff < -2 ? C.ok : C.muted;

  return (
    <div style={{ ...card, padding: "0.85rem 1.25rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" as const }}>
        {/* Status badge */}
        <div style={{
          display: "flex", alignItems: "center", gap: "0.35rem",
          background: statusColor + "15", border: `1px solid ${statusColor}35`,
          borderRadius: "8px", padding: "0.3rem 0.7rem", flexShrink: 0,
        }}>
          <span style={{ color: statusColor, fontWeight: 800, fontSize: "0.95rem" }}>{statusIcon}</span>
          <span style={{ color: statusColor, fontWeight: 700, fontSize: "0.75rem", textTransform: "uppercase" as const, letterSpacing: "0.5px" }}>
            {t(`vpBudgetStatus_${budget.status}` as any)}
          </span>
        </div>

        {/* Heute vs. 7d-Ø comparison block */}
        <div style={{
          display: "flex", alignItems: "center", gap: "0.5rem",
          background: C.inner, borderRadius: "8px", padding: "0.3rem 0.75rem",
          border: `1px solid ${C.border}`, flexShrink: 0,
        }}>
          <div style={{ display: "flex", flexDirection: "column" as const, alignItems: "center" }}>
            <span style={{ color: C.text, fontWeight: 800, fontSize: "0.9rem" }}>
              {todayPct !== null ? `${todayPct.toFixed(1)}%` : "—"}
            </span>
            <span style={{ color: C.faint, fontSize: "0.6rem", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.5px" }}>Heute</span>
          </div>
          <span style={{ color: C.faint, fontSize: "0.8rem" }}>vs.</span>
          <div style={{ display: "flex", flexDirection: "column" as const, alignItems: "center" }}>
            <span style={{ color: C.muted, fontWeight: 700, fontSize: "0.9rem" }}>{avgPct.toFixed(1)}%</span>
            <span style={{ color: C.faint, fontSize: "0.6rem", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.5px" }}>⌀ 7d</span>
          </div>
          {diff !== null && (
            <span style={{ color: diffCol, fontWeight: 700, fontSize: "0.8rem", marginLeft: "0.15rem" }}>
              {diffSign}{Math.abs(diff).toFixed(1)}%
            </span>
          )}
        </div>

        {/* Regen / Netto / Nachhaltig */}
        {[
          { lbl: t("vpBudgetRegen"),   val: `+${regenPct}% / ${t("vpBudgetDay")}`,                       col: C.ok        },
          { lbl: `${t("vpBudgetNet")} ⌀ 7d`, val: `${netSign}${netPct}% / ${t("vpBudgetDay")}`,          col: statusColor },
          { lbl: t("vpBudgetSustain"), val: budget.sustainableVotesPerDay !== null
              ? `${budget.sustainableVotesPerDay} ${t("vpBudgetVotesPerDay")}` : "—",
            col: C.muted },
        ].map((m, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column" as const, alignItems: "center", flex: 1, minWidth: "80px" }}>
            <span style={{ color: m.col, fontWeight: 800, fontSize: "0.9rem" }}>{m.val}</span>
            <span style={{ color: C.faint, fontSize: "0.63rem", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.5px", marginTop: "0.15rem" }}>{m.lbl}</span>
          </div>
        ))}

        {/* Avg weight info */}
        <div style={{ color: C.faint, fontSize: "0.72rem", marginLeft: "auto", whiteSpace: "nowrap" as const }}>
          ⌀ {budget.avgWeightPct}% · {budget.activeDaysIn7d}d {t("vpBudgetActive")}
        </div>
      </div>
    </div>
  );
}

function CurationTriple({ snapshot, todayStats, todayLoading, pendingCuration, pendingLoading, dailyHistory, dailyHistoryLoading, lifetimeEarnings, timezone, t }: {
  snapshot: SteemAccountSnapshot|null;
  todayStats: TodayStats|null; todayLoading: boolean;
  pendingCuration: PendingCuration|null; pendingLoading: boolean;
  dailyHistory: DailyHistoryResult|null; dailyHistoryLoading: boolean;
  lifetimeEarnings: VBEarningsResult|null;
  timezone?: string;
  t: ReturnType<typeof createTranslator>;
}) {
  const voteUsd          = snapshot?.currentVoteUsd ?? 0;
  const sbdPerSteem      = snapshot?.sbdPerSteem ?? 0;
  const estVoteValue     = todayStats ? (todayStats.totalWeightBps / 10000) * voteUsd : 0;
  const estCuration      = estVoteValue * 0.25;
  const estCurationSteem = sbdPerSteem > 0 ? estCuration / sbdPerSteem : null;
  const vpConsumedPct    = todayStats ? todayStats.totalWeightBps / 5000 : 0;

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

  const Row = ({ label, value, col, bold, size }: { label: string; value: string; col?: string; bold?: boolean; size?: string }) => (
    <div style={{ display:"flex", justifyContent:"space-between", fontSize: size ?? "0.8rem", padding:"0.12rem 0" }}>
      <span style={{ color:C.dim }}>{label}</span>
      <span style={{ color:col ?? C.text, fontWeight:bold ? 700 : 600 }}>{value}</span>
    </div>
  );

  const Divider = () => <div style={{ borderTop:`1px solid ${C.border}`, margin:"0.5rem 0" }}/>;

  return (
    <div data-testid="dashboard-kpi-section" style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"1rem" }}>

      {/* ── Heute ── */}
      <div style={{
        ...card,
        borderTop:`4px solid ${C.info}`,
        background:"linear-gradient(160deg,#f0f9ff 0%,#ffffff 55%)",
      }}>
        <p style={{ ...lbl, margin:"0 0 0.85rem", color:C.info }}>{t("cardHeute")}</p>
        {todayLoading ? (
          <div style={{ color:C.dim, fontSize:"0.88rem" }}>Lädt…</div>
        ) : !todayStats || todayStats.totalVotes === 0 ? (
          <div style={{ color:C.dim, fontSize:"0.88rem" }}>{t("emptyNoVotesToday")}</div>
        ) : (
          <>
            <Hero val={String(todayStats.totalVotes)} unit={t("unitVotes")} col={C.info}/>
            <Row size="0.9rem" label={t("cardRuns")}    value={String(todayStats.runsCount)}/>
            <Row size="0.9rem" label={t("cardAuthors")} value={String(todayStats.uniqueAuthors)}/>
            <Divider/>
            <Row size="0.9rem" label={t("cardVpConsumed")}      value={`−${vpConsumedPct.toFixed(1)}%`} col={C.warn} bold/>
            <Row size="0.9rem" label={t("cardTotalVoteValue")}  value={fmtUsd(estVoteValue)} col={C.text}/>
            <Row size="0.9rem" label={t("cardExpectedCuration")}
              value={estCurationSteem !== null
                ? `+${fmtUsd(estCuration)} · ≈${estCurationSteem.toFixed(3)} SP`
                : `+${fmtUsd(estCuration)}`}
              col={C.ok} bold/>
          </>
        )}
      </div>

      {/* ── 7-Tage-Historie ── blau/neutral = Verlauf */}
      <div style={{
        ...card,
        borderTop:`4px solid ${C.info}`,
        background:"linear-gradient(160deg,#f0f9ff 0%,#ffffff 55%)",
      }}>
        <p style={{ ...lbl, margin:"0 0 0.85rem", color:C.info }}>{t("cardHistoryTitle")}</p>
        {dailyHistoryLoading ? (
          <div style={{ color:C.dim, fontSize:"0.88rem" }}>Lädt…</div>
        ) : !dailyHistory || dailyHistory.days.length === 0 ? (
          <div style={{ color:C.dim, fontSize:"0.88rem" }}>{t("emptyNoVotesToday")}</div>
        ) : (() => {
          const { days: pts, summary: sum } = dailyHistory;
          const today = todayString(timezone);
          const totalCur = (sum.totalWeightBps / 10000) * voteUsd * 0.25;
          const avgCurPerVote = sum.totalVotes > 0 ? totalCur / sum.totalVotes : 0;
          return (
            <>
              <div style={{ overflowX:"auto" }}>
                <table style={{ borderCollapse:"collapse", width:"100%", fontSize:"0.8rem" }}>
                  <thead>
                    <tr style={{ borderBottom:`1px solid ${C.border}` }}>
                      <th style={{ textAlign:"left",  padding:"0.15rem 0.4rem 0.35rem", color:C.muted, fontWeight:600 }}>{t("cardHistoryDay")}</th>
                      <th style={{ textAlign:"right", padding:"0.15rem 0.4rem 0.35rem", color:C.muted, fontWeight:600 }}>{t("cardHistoryVotes")}</th>
                      <th style={{ textAlign:"right", padding:"0.15rem 0.4rem 0.35rem", color:C.muted, fontWeight:600 }}>{t("cardHistoryAuthors")}</th>
                      <th style={{ textAlign:"right", padding:"0.15rem 0.4rem 0.35rem", color:C.muted, fontWeight:600 }}>{t("cardHistoryCuration")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pts.map((d, i) => {
                      const estCur  = (d.total_weight_bps / 10000) * voteUsd * 0.25;
                      const isToday = d.day === today;
                      const label   = isToday ? t("cardHistoryToday") : d.day.slice(5);
                      const isBest  = sum.bestDay?.day === d.day && pts.filter(p => p.votes > 0).length > 1;
                      return (
                        <tr key={d.day} style={{
                          borderTop: i > 0 ? `1px solid ${C.border}` : undefined,
                          background: isToday ? C.info + "08" : undefined,
                        }}>
                          <td style={{ padding:"0.22rem 0.4rem", color: isToday ? C.info : C.dim, fontWeight: isToday ? 700 : 400 }}>
                            {label}{isBest ? <span style={{ color:C.ok, fontSize:"0.68rem", marginLeft:"0.3rem" }}>↑</span> : null}
                          </td>
                          <td style={{ padding:"0.22rem 0.4rem", textAlign:"right", color:C.text, fontVariantNumeric:"tabular-nums" }}>{d.votes}</td>
                          <td style={{ padding:"0.22rem 0.4rem", textAlign:"right", color:C.text, fontVariantNumeric:"tabular-nums" }}>{d.unique_authors}</td>
                          <td style={{ padding:"0.22rem 0.4rem", textAlign:"right", color:C.ok, fontVariantNumeric:"tabular-nums", fontWeight:600 }}>
                            {estCur > 0 ? `≈${fmtUsd(estCur)}` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* ── Aggregatzeile ── */}
              <div style={{ marginTop:"0.65rem", borderTop:`2px solid ${C.border}`, paddingTop:"0.55rem" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:"0.3rem" }}>
                  <span style={{ color:C.muted, fontSize:"0.72rem", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.04em" }}>{t("cardHistoryTotal")}</span>
                  {avgCurPerVote > 0 && (
                    <span style={{ color:C.purple, fontSize:"0.73rem", fontWeight:600 }}>
                      Ø {fmtUsd(avgCurPerVote)} / Vote
                    </span>
                  )}
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"0.3rem 0.5rem" }}>
                  <div style={{ textAlign:"center", background:C.info+"0d", borderRadius:"6px", padding:"0.3rem 0.2rem" }}>
                    <div style={{ color:C.info, fontSize:"1.2rem", fontWeight:900, lineHeight:1 }}>{sum.totalVotes}</div>
                    <div style={{ color:C.muted, fontSize:"0.65rem", marginTop:"0.1rem" }}>{t("cardHistoryVotes")}</div>
                  </div>
                  <div style={{ textAlign:"center", background:C.text+"08", borderRadius:"6px", padding:"0.3rem 0.2rem" }}>
                    <div style={{ color:C.text, fontSize:"1.2rem", fontWeight:900, lineHeight:1 }}>{sum.totalUniqueAuthors}</div>
                    <div style={{ color:C.muted, fontSize:"0.65rem", marginTop:"0.1rem" }}>{t("cardHistoryAuthors")}</div>
                  </div>
                  <div style={{ textAlign:"center", background:C.ok+"0d", borderRadius:"6px", padding:"0.3rem 0.2rem" }}>
                    <div style={{ color:C.ok, fontSize:"1.2rem", fontWeight:900, lineHeight:1 }}>{totalCur > 0 ? `≈${fmtUsd(totalCur)}` : "—"}</div>
                    <div style={{ color:C.muted, fontSize:"0.65rem", marginTop:"0.1rem" }}>{t("cardHistoryCuration")}</div>
                  </div>
                </div>
              </div>
            </>
          );
        })()}
      </div>

      {/* ── VoteBroker Lifetime ── */}
      {(() => {
        const lft   = lifetimeEarnings;
        const realSp  = lft?.totals.realizedSp ?? 0;
        const pendSp  = pendingCuration?.pendingSp ?? 0;
        const totalSp = realSp + pendSp;
        const votes   = lft?.totals.voteCount ?? 0;
        const spPV    = votes > 0 && totalSp > 0 ? totalSp / votes : 0;
        const since   = lft?.attributionStart ?? null;
        const sbdPrStm = snapshot?.sbdPerSteem ?? 0.051;
        const loading  = !lft && pendingLoading;
        return (
          <div style={{
            ...card,
            borderTop:`4px solid ${C.ok}`,
            background:"linear-gradient(160deg,#f0fdf4 0%,#ffffff 55%)",
          }}>
            <p style={{ ...lbl, margin:"0 0 0.85rem", color:C.ok }}>{t("cardLifetimeTitle")}</p>
            {loading ? (
              <div style={{ color:C.dim, fontSize:"0.88rem" }}>Lädt…</div>
            ) : (
              <>
                {/* USD primär */}
                <Hero
                  val={totalSp > 0 ? fmtUsd(totalSp * sbdPrStm) : "—"}
                  unit=""
                  col={C.ok}
                  sub={totalSp > 0 ? undefined : t("cardAttributionRunning")}
                />

                {/* Curation Rewards — fachlich getrennt nach Status */}
                {votes > 0 && <Row size="0.9rem" label={t("cardVotesTotal")} value={String(votes)}/>}
                <Divider/>
                {realSp > 0
                  ? <Row size="0.9rem" label={t("cardRealizedCuration")} value={`${realSp.toFixed(3)} SP`} col={C.ok}/>
                  : <Row size="0.9rem" label={t("cardRealizedCuration")} value={t("cardNoPayoutsYet")} col={C.faint}/>
                }
                {pendSp > 0 && (
                  <Row size="0.9rem" label={t("cardExpectedCuration")} value={`≈ ${pendSp.toFixed(3)} SP`} col={C.warn}/>
                )}
                {spPV > 0 && (
                  <><Divider/><Row size="0.9rem" label={t("cardAvgCurationPerVote")} value={`≈ ${spPV.toFixed(4)} SP`} col={C.purple} bold/></>
                )}
                {since && (
                  <div style={{ color:C.faint, fontSize:"0.73rem", marginTop:"0.5rem" }}>
                    {t("cardAttributionSince")} {since}
                  </div>
                )}
                {pendingCuration?.debug && <PendingDebugPanel data={pendingCuration} t={t} />}
              </>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// ── Growth Analytics Panel ────────────────────────────────────────────────────

type GrowthDimension = "delay" | "category" | "pool" | "community" | "author" | "weekday";

function growthColor(g: number | null): string {
  if (g === null) return C.faint;
  if (g >= 3.0)  return C.ok;
  if (g >= 2.0)  return C.warn;
  if (g >= 1.2)  return C.dim;
  return C.err;
}

function GrowthTable({ buckets }: { buckets: GrowthBucket[] }) {
  if (buckets.length === 0)
    return <p style={{ color: C.faint, fontSize: "0.8rem", margin: "0.5rem 0 0" }}>Keine Daten</p>;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
      <thead>
        <tr style={{ color: C.faint, textAlign: "left" }}>
          <th style={{ padding: "0.2rem 0.4rem 0.2rem 0", fontWeight: 500 }}>Gruppe</th>
          <th style={{ padding: "0.2rem 0.4rem", fontWeight: 500, textAlign: "right" }}>n</th>
          <th style={{ padding: "0.2rem 0.4rem", fontWeight: 500, textAlign: "right" }}>Ø Wachstum</th>
          <th style={{ padding: "0.2rem 0 0.2rem 0.4rem", fontWeight: 500, textAlign: "right" }}>Ø Pool (Vote)</th>
        </tr>
      </thead>
      <tbody>
        {buckets.map(b => (
          <tr key={b.label} style={{ borderTop: `1px solid ${C.border}` }}>
            <td style={{ padding: "0.25rem 0.4rem 0.25rem 0", color: C.text }}>{b.label}</td>
            <td style={{ padding: "0.25rem 0.4rem", color: C.faint, textAlign: "right" }}>{b.n}</td>
            <td style={{ padding: "0.25rem 0.4rem", textAlign: "right" }}>
              {b.avgGrowth !== null
                ? <strong style={{ color: growthColor(b.avgGrowth) }}>{b.avgGrowth.toFixed(2)}×</strong>
                : <span style={{ color: C.faint }}>—</span>}
            </td>
            <td style={{ padding: "0.25rem 0 0.25rem 0.4rem", color: C.faint, textAlign: "right" }}>
              {b.avgPendingSbd !== null ? `${b.avgPendingSbd.toFixed(2)} SBD` : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const GROWTH_DIM_LABELS: Record<GrowthDimension, string> = {
  delay:     "Vote Delay",
  category:  "Kategorie",
  pool:      "Pool-Größe",
  community: "Community",
  author:    "Autor",
  weekday:   "Wochentag",
};

function GrowthAnalyticsPanel({ data, loading }: {
  data: GrowthAnalytics | null;
  loading: boolean;
}) {
  const [open,   setOpen]   = useState(false);
  const [dim,    setDim]    = useState<GrowthDimension>("delay");

  const buckets: Record<GrowthDimension, GrowthBucket[]> = data ? {
    delay:     data.byDelay,
    category:  data.byCategory,
    pool:      data.byPoolBucket,
    community: data.byCommunity,
    author:    data.byAuthor,
    weekday:   data.byWeekday,
  } : { delay: [], category: [], pool: [], community: [], author: [], weekday: [] };

  const overallColor = data?.avgGrowth !== null && data?.avgGrowth !== undefined
    ? growthColor(data.avgGrowth) : C.faint;

  return (
    <div style={{ ...card, marginTop: 0 }}>
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
        onClick={() => setOpen(o => !o)}
      >
        <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.15rem" }}>
          <p style={{ ...lbl, margin: 0 }}>Growth Analytics</p>
          {data && (
            <span style={{ fontSize: "0.75rem", color: C.faint }}>
              {data.n} Posts ausgewertet
              {data.avgGrowth !== null && (
                <> · Ø Wachstum{" "}
                  <strong style={{ color: overallColor }}>{data.avgGrowth.toFixed(2)}×</strong>
                  {data.avgGrowth >= 2.0 && data.avgGrowth < 3.0 &&
                    <span style={{ color: C.faint }}> (Hypothese: ~2.5×)</span>}
                </>
              )}
            </span>
          )}
        </div>
        <span style={{ color: C.faint, fontSize: "0.85rem", userSelect: "none" }}>{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div style={{ marginTop: "1rem" }}>
          {loading && <p style={{ color: C.faint, fontSize: "0.82rem", margin: 0 }}>Lade…</p>}

          {!loading && !data && (
            <p style={{ color: C.faint, fontSize: "0.82rem", margin: 0 }}>
              Noch keine abgeschlossenen Posts mit gespeichertem Pool-Wachstum.
              Daten werden täglich nach Auszahlung ergänzt.
            </p>
          )}

          {!loading && data && data.n === 0 && (
            <p style={{ color: C.faint, fontSize: "0.82rem", margin: 0 }}>
              Noch keine Daten — {data.n} Posts mit final/pending vorhanden.
            </p>
          )}

          {!loading && data && data.n > 0 && (
            <>
              {/* Dimension selector */}
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" as const, marginBottom: "0.75rem" }}>
                {(Object.keys(GROWTH_DIM_LABELS) as GrowthDimension[]).map(d => (
                  <button
                    key={d}
                    onClick={() => setDim(d)}
                    style={{
                      fontSize: "0.75rem", padding: "0.2rem 0.6rem",
                      borderRadius: "4px", border: `1px solid ${dim === d ? C.info : C.border}`,
                      background: dim === d ? C.info + "22" : "transparent",
                      color: dim === d ? C.info : C.faint,
                      cursor: "pointer",
                    }}
                  >
                    {GROWTH_DIM_LABELS[d]}
                  </button>
                ))}
              </div>

              <GrowthTable buckets={buckets[dim]} />

              <p style={{ color: C.faint, fontSize: "0.72rem", marginTop: "0.75rem", marginBottom: 0 }}>
                growth_factor = post_final_payout / pool_at_vote_time · Ø ≈ 2.5 bestätigt Faktor 0.20-Hypothese
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Alle Durchläufe heute ─────────────────────────────────────────────────────

function AllRunsPanel({ todayStats, snapshot, timezone, locale, t }: {
  todayStats: TodayStats|null;
  snapshot: SteemAccountSnapshot|null;
  timezone?: string; locale?: string;
  t: ReturnType<typeof createTranslator>;
}) {
  const fmt = makeFmt(timezone??"", locale??"de");
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
      <p style={{ ...lbl, margin:"0 0 0.75rem" }}>{t("cardRunsToday")}</p>

      <div style={{ display:"flex", flexDirection:"column" as const, gap:"0.5rem" }}>
        {runsWithVp.map(({ run, vpBeforeRun, vpAfterRun, consumed }, i) => {
          const time      = fmt.time(run.startedAt);
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
                    {t("cardRunLabel")} {i + 1}
                    <span style={{ color:C.dim, fontWeight:500, marginLeft:"0.5rem", fontSize:"0.82rem" }}>{time}{t("cardUhr") ? ` ${t("cardUhr")}` : ""}</span>
                  </span>
                  <div style={{ display:"flex", alignItems:"center", gap:"0.6rem" }}>
                    <span style={{ color:C.ok, fontWeight:800, fontSize:"0.9rem" }}>{fmtUsd(val)}</span>
                    <span style={{ color:C.faint, fontSize:"0.78rem" }}>{expanded ? "▲" : "▼"}</span>
                  </div>
                </div>
                <div style={{ display:"flex", gap:"1.25rem", fontSize:"0.8rem", flexWrap:"wrap" as const }}>
                  <span style={{ color:C.info, fontWeight:700 }}>{run.voteCount} {run.voteCount===1?t("unitVote"):t("unitVotes")}</span>
                  <span style={{ color:C.text, fontWeight:600 }}>{run.authors.length} {t("unitAuthors")}</span>
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
                        <span style={{ color:C.faint }}>{fmt.time(v.votedAt)}</span>
                      </div>
                    </div>
                  ))}
                  <div style={{ padding:"0.4rem 1rem", background:C.inner, fontSize:"0.75rem", display:"flex", gap:"1.5rem", color:C.dim }}>
                    <span style={{ fontWeight:700, color:C.text }}>{t("cardTotalRun")}</span>
                    <span style={{ color:C.ok, fontWeight:700 }}>+{fmtUsd(val * 0.25)} {t("cardCuration")}</span>
                    <span>{fmtUsd(val)} {t("cardDistributed")}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Gesamt-Zeile */}
        <div style={{ borderTop:`2px solid ${C.border}`, paddingTop:"0.65rem", display:"flex", gap:"1.5rem", fontSize:"0.82rem", flexWrap:"wrap" as const, alignItems:"center" }}>
          <span style={{ color:C.text, fontWeight:800 }}>{t("cardTotalToday")}</span>
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

function VpGraphToday({ todayStats, snapshot, timezone, locale }: {
  todayStats: TodayStats|null;
  snapshot: SteemAccountSnapshot|null;
  timezone?: string; locale?: string;
}) {
  const t = createTranslator((locale ?? "de") as import("../i18n").Locale);
  const fmt = makeFmt(timezone??"", locale??"de");
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
        <p style={{ ...lbl, margin:0 }}>{t("chartVpToday")}</p>
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
              <span>{fmt.time(hovered.time)} Uhr</span>
              {hovered.runIdx >= 0 && <span style={{ color:"#94a3b8", fontWeight:600, fontSize:"0.75rem" }}>Durchlauf #{hovered.runIdx+1}</span>}
            </div>
            {hovered.weightBps > 0 ? (
              <>
                {/* Run summary */}
                <div style={{ color:"#cbd5e1", marginBottom:"0.25rem" }}>
                  {hovered.runVotes} {hovered.runVotes===1?t("unitVote"):t("unitVotes")} · {hovered.runAuthors} {t("unitAuthors")}
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

  const GREEN   = "#16a34a";   // realized = earned = completed
  const ORANGE  = "#d97706";   // pending  = open   = waiting
  const PURPLE  = "#7c3aed";   // cumulative line (neutral aggregate)
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

        {/* Stacked daily bars: realized (bottom, green) + pending (top, orange) */}
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
              {/* Realized portion (bottom, green) */}
              {realH > 0 && (
                <rect x={barX(i)} y={H - PAD - realH} width={barW} height={realH}
                  fill={isHov ? GREEN : GREEN + "bb"} rx="1.5"
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
            {new Date(hovD.date+"T12:00:00Z").toLocaleDateString("de-DE",{day:"numeric",month:"short", timeZone:"UTC"})}
          </div>
          {hovD.votes > 0 && (
            <div style={{ color:"#94a3b8", marginBottom:"0.2rem" }}>
              VoteBroker Votes: <b style={{ color:"#e2e8f0" }}>{hovD.votes}</b>
            </div>
          )}
          {hovD.realizedSp > 0 && (
            <div>Realisiert (SP): <b style={{ color:"#4ade80" }}>{hovD.realizedSp.toFixed(4)} SP</b></div>
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

function VBEarningsCard({ session, pendingCuration, todayStats, snapshot, recentVotesCount, t }: {
  session: AuthSession;
  pendingCuration: PendingCuration|null;
  todayStats: TodayStats|null;
  snapshot: SteemAccountSnapshot|null;
  recentVotesCount: number;
  t: ReturnType<typeof createTranslator>;
}) {
  const [period, setPeriod] = useState<VBEarningsPeriod>("7d");
  const [data,   setData]   = useState<VBEarningsResult|null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // session/period changes: fetch immediately
    // recentVotesCount changes: debounce 800ms so last audit_event is committed
    const delay = recentVotesCount > 0 ? 800 : 0;
    const t = setTimeout(() => {
      setLoading(true);
      fetchVBEarnings(session.token, period)
        .then(setData).catch(()=>setData(null))
        .finally(()=>setLoading(false));
    }, delay);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.token, period, recentVotesCount]);

  const sbdPrStm = snapshot?.sbdPerSteem ?? 0.051;
  const periods: { id: VBEarningsPeriod; label: string }[] = [
    { id:"7d",  label: t("earnings7d")     },
    { id:"30d", label: t("earnings30d")    },
    { id:"90d", label: t("earnings90d")    },
    { id:"all", label: t("earningsAllTime")},
  ];

  const PURPLE     = "#7c3aed";
  const ORANGE     = "#d97706";
  const realizedSp = data?.totals.realizedSp ?? 0;
  const pendingSp  = pendingCuration?.pendingSp ?? 0;
  const totalSp    = realizedSp + pendingSp;   // what VoteBroker actually earned you
  const usdApprox  = totalSp * sbdPrStm;
  const todayVotes = todayStats?.totalVotes ?? 0;
  const spPerVote  = data && data.totals.voteCount > 0 ? totalSp / data.totals.voteCount : 0;
  const since      = data?.attributionStart ?? "";
  const totalVotes = data?.totals.voteCount ?? 0;
  const gameTip    = totalVotes > 0 && spPerVote > 0
    ? t("chartVbVotesTip")
        .replace("{{total}}", String(totalVotes))
        .replace("{{since}}", since ? ` ${t("chartVbSince").replace("{{date}}", since)}` : "")
        .replace("{{today}}", `${t("chartVbVotesToday").replace("{{n}}", String(todayVotes > 0 ? todayVotes : 0))}`)
        .replace("{{avg}}", spPerVote.toFixed(4))
    : todayVotes > 0
    ? `✅ ${todayVotes} ${t("chartVbVotes")}`
    : `🌱 ${t("emptyNoVotesToday")}`;

  return (
    <div style={{ ...card, background:"linear-gradient(135deg,#faf5ff 0%,#f5f3ff 60%,#ede9fe 100%)" }}>
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.75rem" }}>
        <div style={{ display:"flex", alignItems:"center", gap:"0.5rem" }}>
          <span style={{ fontSize:"0.95rem" }}>💜</span>
          <span style={{ fontSize:"0.82rem", fontWeight:700, color:C.text, letterSpacing:"-0.2px" }}>
            {t("chartCurationTitle")}
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

          {/* ── KPI-Zone: zwei klare Spalten, groß und lesbar ── */}
          <div style={{
            display:"grid", gridTemplateColumns:"auto 1fr",
            gap:"0", marginBottom:"0.75rem",
            background:"#ede9fe", borderRadius:"12px", overflow:"hidden",
          }}>
            {/* Linke Spalte: Votes (Ursache) */}
            <div style={{
              padding:"0.85rem 1.1rem", textAlign:"center",
              borderRight:"2px solid #ddd6fe",
              display:"flex", flexDirection:"column", justifyContent:"center",
            }}>
              <div style={{ fontSize:"2.4rem", fontWeight:900, color:PURPLE, letterSpacing:"-2px", lineHeight:1 }}>
                {data.totals.voteCount > 0 ? data.totals.voteCount : "—"}
              </div>
              <div style={{ fontSize:"0.75rem", color:"#7c3aed", fontWeight:700, marginTop:"0.2rem" }}>
                {t("chartVbVotes")}
              </div>
              {todayVotes > 0 && data.totals.voteCount > todayVotes && (
                <div style={{ fontSize:"0.7rem", color:"#a78bfa", marginTop:"0.15rem" }}>
                  {t("chartVbVotesToday").replace("{{n}}", String(todayVotes))}
                </div>
              )}
            </div>

            {/* Pfeil + rechte Spalte: SP (Wirkung) */}
            <div style={{ background:"#f5f3ff", padding:"0.85rem 1.1rem", position:"relative" }}>
              {/* Pfeil */}
              <div style={{
                position:"absolute", left:"-12px", top:"50%", transform:"translateY(-50%)",
                background:"#f5f3ff", color:"#a78bfa", fontSize:"1.1rem",
                padding:"0.1rem 0", lineHeight:1,
              }}>→</div>

              {/* Total — USD primär */}
              <div style={{ fontSize:"2.4rem", fontWeight:900, color:C.ok, letterSpacing:"-2px", lineHeight:1 }}>
                {totalSp > 0 ? fmtUsd(usdApprox) : "—"}
              </div>

              {/* SP sekundär */}
              {totalSp > 0 && (
                <div style={{ fontSize:"0.75rem", color:C.dim, marginTop:"0.15rem" }}>
                  {totalSp.toFixed(3)} SP
                </div>
              )}

              {/* Curation — getrennt nach Status */}
              <div style={{ fontSize:"0.73rem", marginTop:"0.2rem", display:"flex", gap:"0.6rem", flexWrap:"wrap" }}>
                {realizedSp > 0 && (
                  <span style={{ color:C.ok, fontWeight:600 }}>
                    {realizedSp.toFixed(3)} {t("earningsRealizedSP")}
                  </span>
                )}
                {pendingSp > 0 && (
                  <span style={{ color:ORANGE, fontWeight:600 }}>
                    ≈{pendingSp.toFixed(3)} {t("earningsExpectedSP")}
                  </span>
                )}
              </div>

              {/* Rate */}
              {data.totals.voteCount > 0 && totalSp > 0 && (
                <div style={{ fontSize:"0.7rem", color:C.dim, marginTop:"0.12rem" }}>
                  Ø <b style={{ color:PURPLE }}>{(totalSp / data.totals.voteCount).toFixed(4)} SP</b> pro Vote
                </div>
              )}

              {/* Tooltip anchor */}
              <div title={`Attribution seit: ${data.attributionStart ?? "—"}\nRealisiert (SP-Anteil aus curation_reward): ${realizedSp.toFixed(4)} SP aus ${data.totals.realizedCount} Payouts\nPending (offene Posts): ≈ ${pendingSp.toFixed(4)} SP`}
                style={{ position:"absolute", top:"0.4rem", right:"0.5rem",
                  fontSize:"0.62rem", color:C.faint, cursor:"help" }}>ℹ</div>
            </div>
          </div>

          {/* ── Chart ── */}
          {(data.dailyData.some(d => d.votes > 0) || pendingSp > 0) ? (
            <>
              <div style={{ fontSize:"0.62rem", color:C.faint, marginBottom:"0.2rem", display:"flex", gap:"0.9rem", alignItems:"center" }}>
                <span style={{ display:"flex", alignItems:"center", gap:"0.22rem" }}>
                  <span style={{ display:"inline-block", width:"8px", height:"8px", background:C.ok, borderRadius:"2px" }}/>
                  Realisiert (SP)
                </span>
                <span style={{ display:"flex", alignItems:"center", gap:"0.22rem" }}>
                  <span style={{ display:"inline-block", width:"8px", height:"8px", background:ORANGE, borderRadius:"2px" }}/>
                  Pending
                </span>
                <span style={{ display:"flex", alignItems:"center", gap:"0.22rem" }}>
                  <span style={{ display:"inline-block", width:"14px", height:"2px", background:PURPLE, borderRadius:"1px" }}/>
                  kumuliert
                </span>
              </div>
              <VBEarningsChart data={data.dailyData} pendingSp={pendingSp} sbdPerSteem={sbdPrStm}/>
            </>
          ) : (
            <div style={{ textAlign:"center", padding:"1.5rem 0", color:C.faint, fontSize:"0.8rem",
              border:`1px dashed ${PURPLE}33`, borderRadius:"8px" }}>
              {t("chartNoVotes")}
              {data.attributionStart && (
                <div style={{ marginTop:"0.3rem", fontSize:"0.7rem" }}>Attribution aktiv seit {data.attributionStart}</div>
              )}
            </div>
          )}

          {/* ── Gamification-Zeile ── */}
          <div style={{ marginTop:"0.5rem", paddingTop:"0.4rem",
            borderTop:`1px solid ${PURPLE}22`,
            fontSize:"0.73rem", color:C.dim, fontWeight:600 }}>
            {gameTip}
          </div>
        </>
      )}
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
      <div style={{ display:"flex", justifyContent:"center", marginBottom:"0.6rem" }}><Dna size={28} color={C.info} strokeWidth={1.5} /></div>
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

// ── Timezone-aware formatting ─────────────────────────────────────────────────

function makeFmt(timezone: string, locale: string) {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const lc = locale === "de" ? "de-DE" : "en-GB";
  return {
    time:     (d: Date | string) => new Date(d).toLocaleTimeString(lc, { timeZone: tz, hour: "2-digit", minute: "2-digit" }),
    datetime: (d: Date | string) => new Date(d).toLocaleString(lc, { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
    date:     (d: Date | string) => new Date(d).toLocaleDateString(lc, { timeZone: tz, day: "numeric", month: "short" }),
    dateShort:(d: Date | string) => new Date(d).toLocaleDateString(lc, { timeZone: tz, month: "numeric", day: "numeric" }),
    // Returns local day string YYYY-MM-DD for grouping (respects timezone boundary)
    dayKey:   (d: Date | string) => {
      const dt = new Date(d);
      return new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(dt); // sv-SE gives YYYY-MM-DD
    },
    tz,
  };
}

export function UserDashboard(props: {
  session: AuthSession; locale: Locale; timezone?: string;
  snapshot: SteemAccountSnapshot|null; snapshotLoading: boolean; snapshotRefreshedAt?: Date;
  strategyRules: StrategyRuleLite[]|null;
  opportunities: PostOpportunity[]|null; opportunitiesLoading: boolean;
  opportunitiesMeta: OpportunitiesMeta|null;
  votePlan: VotePlanResponse|null;
  curationProfile: CurationProfile|null;
  recentVotes: RecentVote[];
  voteExecutionCount?: number;   // uncapped counter — increments per vote for reliable refresh
  onTabChange:(tab:"dna"|"dashboard"|"community"|"billing")=>void;
  onGenerateVotes:()=>void; onLoadOpportunities:()=>void; onRefreshSnapshot?:()=>void;
}) {
  const t=createTranslator(props.locale);
  const fmt=makeFmt(props.timezone??"",props.locale);
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

  const [dailyHistory,      setDailyHistory]      =useState<DailyHistoryResult|null>(null);
  const [dailyHistoryLoading, setDailyHistoryLoading] =useState(true);

  const [vpBudget, setVpBudget] = useState<VpBudget|null>(null);

  const [growthAnalytics,        setGrowthAnalytics]        = useState<GrowthAnalytics|null>(null);
  const [growthAnalyticsLoading, setGrowthAnalyticsLoading] = useState(false);
  const [growthAnalyticsFetched, setGrowthAnalyticsFetched] = useState(false);
  const growthAnalyticsVersionRef = useRef<string | null>(null);

  const loadGrowthAnalytics = (token: string) => {
    setGrowthAnalyticsLoading(true);
    fetchGrowthAnalytics(token)
      .then(d => {
        growthAnalyticsVersionRef.current = d.dataVersion ?? null;
        setGrowthAnalytics(d);
        setGrowthAnalyticsFetched(true);
      })
      .catch(()=> setGrowthAnalyticsFetched(true))
      .finally(()=> setGrowthAnalyticsLoading(false));
  };

  const checkAndRefreshGrowthAnalytics = (token: string) => {
    fetchGrowthAnalyticsVersion(token)
      .then(({ dataVersion }) => {
        if (dataVersion !== growthAnalyticsVersionRef.current) {
          loadGrowthAnalytics(token);
        }
      })
      .catch(() => {});
  };

  // Lifetime VoteBroker earnings — fetched once, not period-dependent
  const [lifetimeEarnings, setLifetimeEarnings] =useState<VBEarningsResult|null>(null);

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

  const loadDailyHistory = () => {
    setDailyHistoryLoading(true);
    fetchDailyHistory(props.session.token, 7)
      .then(setDailyHistory).catch(()=>setDailyHistory(null)).finally(()=>setDailyHistoryLoading(false));
  };

  useEffect(()=>{
    setGrowthLoading(true);
    fetchGrowthData(props.session.token,growthPeriod)
      .then(setGrowthData).catch(()=>{}).finally(()=>setGrowthLoading(false));
  },[props.session.token,growthPeriod]);

  useEffect(()=>{
    loadTodayStats();
    loadPendingCuration();
    loadDailyHistory();
    // Lifetime fetch — "all" period, run once
    fetchVBEarnings(props.session.token, "all")
      .then(setLifetimeEarnings).catch(()=>{});
    fetchVpBudget(props.session.token)
      .then(setVpBudget).catch(()=>{});
    // Growth Analytics — fetched on mount, then on visibility-change (tab refocus)
    // when the server reports a new dataVersion (payoutSync ran overnight).
    loadGrowthAnalytics(props.session.token);
    const token = props.session.token;
    const onVisibility = () => {
      if (document.visibilityState === "visible") checkAndRefreshGrowthAnalytics(token);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[props.session.token]);

  // Refresh live data after each vote.
  // Today-stats and pending-curation refresh immediately (their sources are instant).
  // Earnings/chart refresh is debounced by 800ms so the last vote's audit_event
  // is guaranteed to be committed before the read — fixes "1 vote behind" bug.
  const voteExecCount = props.voteExecutionCount ?? 0;
  useEffect(()=>{
    if (voteExecCount === 0) return;
    loadTodayStats();
    loadPendingCuration();
    loadDailyHistory();
    loadGrowthAnalytics(props.session.token);
    const t = setTimeout(() => {
      fetchVBEarnings(props.session.token, "all")
        .then(setLifetimeEarnings).catch(()=>{});
    }, 800);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[voteExecCount]);

  return (
    <div style={{ padding:"1.5rem 2rem", display:"flex", flexDirection:"column" as const, gap:"1.5rem" }}>

      {/* 1. Community Hero */}
      {curationProfile
        ? <CommunityHero profile={curationProfile} growth={growthData} todayStats={todayStats} snapshot={snapshot} t={t}/>
        : (
          <div style={{ ...card, display:"flex", alignItems:"center", gap:"0.85rem", padding:"1.1rem 1.5rem" }}>
            <Dna size={22} color={C.info} strokeWidth={1.5} style={{ flexShrink:0 }} />
            <span style={{ color:C.muted, fontSize:"0.88rem", flex:1, lineHeight:1.5 }}>{t("emptyDnaHint")}</span>
            <button type="button" onClick={()=>props.onTabChange("dna")} style={{ background:C.info+"15", border:`1px solid ${C.info}40`, borderRadius:"8px", color:C.info, cursor:"pointer", fontSize:"0.82rem", padding:"0.45rem 1rem", fontWeight:700, flexShrink:0 }}>{t("btnAnalyzeDna")}</button>
          </div>
        )
      }

      {/* 2. VoteBroker Earnings — primäres Fortschritts-Modul */}
      <VBEarningsCard
        session={props.session}
        pendingCuration={pendingCuration}
        todayStats={todayStats}
        snapshot={snapshot}
        recentVotesCount={voteExecCount}
        t={t}
      />

      {/* 3. VP + Offene Chancen */}
      <OperativeKPIRow
        snapshot={snapshot} snapshotLoading={props.snapshotLoading} snapshotRefreshedAt={props.snapshotRefreshedAt}
        opportunities={opportunities} opportunitiesMeta={opportunitiesMeta}
        onRefresh={props.onRefreshSnapshot} onLoadOpps={props.onLoadOpportunities}
        onTabChange={props.onTabChange} t={t}
      />

      {/* 4. VP-Budget: täglicher Verbrauch vs. Regen */}
      <VpBudgetRow budget={vpBudget} todayWeightBps={todayStats?.totalWeightBps ?? null} t={t} />

      {/* 5. Curation Timeline: Heute | 7-Tage | Lifetime */}
      <CurationTriple
        snapshot={snapshot}
        todayStats={todayStats} todayLoading={todayLoading}
        pendingCuration={pendingCuration} pendingLoading={pendingLoading}
        dailyHistory={dailyHistory} dailyHistoryLoading={dailyHistoryLoading}
        lifetimeEarnings={lifetimeEarnings}
        timezone={props.timezone}
        t={t}
      />

      {/* 2b. Letzter Durchlauf + VP-Graph */}
      {(todayStats?.lastRun || (todayStats && todayStats.votes.length > 0)) && (
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"1rem" }}>
          <AllRunsPanel todayStats={todayStats} snapshot={snapshot} timezone={props.timezone} locale={props.locale} t={t}/>
          <VpGraphToday todayStats={todayStats} snapshot={snapshot} timezone={props.timezone} locale={props.locale}/>
        </div>
      )}

      {/* Adaptive Guidance — only rendered when a setup step is missing */}
      <ContextualHints
        hasCommunity={totalAuthors > 0}
        hasDna={curationProfile !== null}
        hasStrategy={strategyRules !== null}
        onTabChange={props.onTabChange}
        t={t}
      />

      {/* 3+4. Beziehungen | Aktivität */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"1.5rem", alignItems:"start" }}>
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

      {/* 6. Growth Analytics */}
      {growthAnalyticsFetched && (
        <GrowthAnalyticsPanel
          data={growthAnalytics}
          loading={growthAnalyticsLoading}
        />
      )}

      {/* 7. Autorenliste */}
      {strategyRules!==null&&(
        <AuthorGrid rules={rules} openOpps={openOpps} snapshot={snapshot} dnaMap={dnaMap} onTabChange={props.onTabChange} t={t}/>
      )}

    </div>
  );
}
