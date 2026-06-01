import { useEffect, useState } from "react";
import type {
  AuthSession, CurationProfile, GrowthData,
  OpportunitiesMeta, PostOpportunity, SteemAccountSnapshot, VotePlanResponse,
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

// ── Design — warm, generous, community-first ──────────────────────────────────

const C = {
  ok:     "#2ecc8a", warn: "#f5a623", err: "#e05c5c",
  info:   "#4da8f0", purple: "#9d6df0", fire: "#f07a35",
  teal:   "#2ec4b6", gold: "#f1c40f",
  dim:    "#7fa8cc", bg0: "#080d14",  bg1: "#0d1724",
  bg2:    "#152032", bg3: "#1c2d40",  bg4: "#243548",
  border: "#263850", border2: "#2e4460",
  text:   "#ddeaf8", muted: "#7fa8cc", faint: "#3d5a73",
};

const CAT_DEF: Record<string, { color: string; icon: string; tKey: TranslationKey; pri: number }> = {
  immer_voten:    { color: C.fire,   icon: "🔥", tKey: "catAlways",    pri: 5 },
  lieblingsautor: { color: C.warn,   icon: "⭐", tKey: "catFavorite",  pri: 4 },
  bevorzugt:      { color: C.info,   icon: "🟦", tKey: "catPreferred", pri: 3 },
  normal:         { color: C.ok,     icon: "⚪", tKey: "catNormal",    pri: 2 },
  niedrig:        { color: C.dim,    icon: "⬇", tKey: "catLow",       pri: 1 },
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
  "Niche Specialist": "🟤", "Regular Curator": "⚪",
};

// Curator Journey — progression based on UNIQUE AUTHORS (community metric)
const JOURNEY: ReadonlyArray<{ key: TranslationKey; minA: number; maxA: number; color: string; emoji: string }> = [
  { key: "levelNewCurator",       minA: 0,   maxA: 5,        color: C.dim,    emoji: "🌱" },
  { key: "levelActiveSup",        minA: 5,   maxA: 15,       color: C.ok,     emoji: "🌿" },
  { key: "levelCommunityBuilder", minA: 15,  maxA: 30,       color: C.info,   emoji: "🌳" },
  { key: "levelTrustedCurator",   minA: 30,  maxA: 60,       color: C.purple, emoji: "⭐" },
  { key: "levelEcosystemSup",     minA: 60,  maxA: 100,      color: C.warn,   emoji: "🌟" },
  { key: "levelLegend",           minA: 100, maxA: Infinity, color: C.gold,   emoji: "🏆" },
];

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

// ── Shared styles ─────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: `linear-gradient(160deg, ${C.bg2} 0%, ${C.bg1} 100%)`,
  border: `1px solid ${C.border}`, borderRadius: "16px", padding: "1.5rem 1.75rem",
};
const lbl: React.CSSProperties = {
  color: C.dim, fontSize: "0.72rem", fontWeight: 700,
  textTransform: "uppercase" as const, letterSpacing: "1px", margin: "0 0 1rem",
};

// ── Community Hero — the first thing you see ──────────────────────────────────

function CommunityHero({ profile, growth, t }: {
  profile: CurationProfile | null;
  growth: GrowthData | null;
  t: ReturnType<typeof createTranslator>;
}) {
  if (!profile) return null;

  const totalVotes   = growth?.summary.totalVotes   ?? profile.votesAnalyzed;
  const totalAuthors = growth?.summary.totalUniqueAuthors ?? profile.uniqueAuthors;
  const activeDays   = growth?.summary.activeDays   ?? profile.periodDays;
  const streak       = growth?.summary.longestStreak ?? 0;
  const currStreak   = growth?.summary.currentStreak ?? 0;

  const dnaKey       = DNA_LABEL_MAP[profile.dnaLabel];
  const dnaLabel     = dnaKey ? t(dnaKey) : profile.dnaLabel;
  const dnaConviction= profile.avgWeightPct>=70 ? t("dnaHighConviction") : profile.avgWeightPct>=45 ? t("dnaBalanced") : t("dnaExploratory");
  const selfNote     = profile.selfVotePct<5 ? t("dnaCommunityFirst") : profile.selfVotePct>20 ? t("dnaSelfFocused") : "";

  const stats = [
    { value: totalAuthors.toLocaleString(), label: t("impactAuthors"),     color: C.purple, big: true  },
    { value: totalVotes.toLocaleString(),   label: t("impactVotes"),        color: C.info,   big: false },
    { value: String(activeDays),            label: t("impactActiveDays"),   color: C.teal,   big: false },
    { value: streak > 0 ? `${streak}d` : "—", label: t("impactStreak"),   color: C.warn,   big: false },
    ...(currStreak > 1 ? [{ value: `${currStreak}d`, label: t("impactCurrentStreak"), color: C.ok, big: false }] : []),
  ];

  return (
    <div style={{
      background: `linear-gradient(135deg, #162540 0%, #0f1c30 50%, #162035 100%)`,
      border: `1px solid ${C.border2}`,
      borderRadius: "20px",
      padding: "2rem 2.25rem",
      display: "flex", flexDirection: "column" as const, gap: "1.5rem",
    }}>
      {/* DNA Identity header */}
      <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
        <span style={{ fontSize: "2.4rem", filter: `drop-shadow(0 0 12px ${C.purple}66)` }}>{DNA_EMOJI[profile.dnaLabel] ?? "⚪"}</span>
        <div>
          <div style={{ color: C.info, fontWeight: 800, fontSize: "1.1rem", letterSpacing: "-0.3px" }}>{dnaLabel}</div>
          <div style={{ color: C.faint, fontSize: "0.75rem", marginTop: "2px" }}>{dnaConviction}{selfNote ? ` · ${selfNote}` : ""}</div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" as const }}>
          <div style={{ color: C.faint, fontSize: "0.68rem", fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase" as const }}>@{profile.username}</div>
          <div style={{ color: C.faint, fontSize: "0.68rem" }}>{profile.avgWeightPct}% {t("kpiAvgWeight").toLowerCase()}</div>
        </div>
      </div>

      {/* Giant impact numbers */}
      <div style={{ display: "flex", gap: 0, alignItems: "stretch" }}>
        {stats.map((s, i) => (
          <div key={i} style={{
            flex: s.big ? "1.8" : "1",
            textAlign: "center" as const,
            padding: "0.5rem 0.75rem",
            borderRight: i < stats.length - 1 ? `1px solid ${C.border}` : "none",
          }}>
            <div style={{ color: s.color, fontSize: s.big ? "3.8rem" : "2.6rem", fontWeight: 900, lineHeight: 1, letterSpacing: s.big ? "-2px" : "-1px", filter: s.big ? `drop-shadow(0 0 16px ${s.color}44)` : "none" }}>
              {s.value}
            </div>
            <div style={{ color: C.faint, fontSize: "0.68rem", fontWeight: 700, letterSpacing: "0.8px", textTransform: "uppercase" as const, marginTop: "0.35rem" }}>
              {s.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Community Growth Chart — the story ───────────────────────────────────────

function CommunityGrowthChart({ growth, growthLoading, growthPeriod, setGrowthPeriod, t }: {
  growth: GrowthData | null;
  growthLoading: boolean;
  growthPeriod: "30d" | "90d" | "all";
  setGrowthPeriod: (p: "30d" | "90d" | "all") => void;
  t: ReturnType<typeof createTranslator>;
}) {
  const data    = growth?.dataPoints.filter(d => d.cumAuthors > 0) ?? [];
  const total   = growth?.summary.totalVotes ?? 0;
  const authors = growth?.summary.totalUniqueAuthors ?? 0;

  const emptyState = () => {
    if (total === 0) return (
      <div style={{ textAlign: "center", padding: "2rem 1rem" }}>
        <div style={{ fontSize: "3rem", marginBottom: "0.75rem" }}>🌱</div>
        <p style={{ color: C.text, fontSize: "1rem", fontWeight: 700, margin: "0 0 0.5rem" }}>{t("growthEmptyZero")}</p>
        <p style={{ color: C.muted, fontSize: "0.82rem", margin: 0, lineHeight: 1.6, maxWidth: "420px", marginLeft: "auto", marginRight: "auto" }}>{t("growthEmptyBuildingNote")}</p>
      </div>
    );
    return (
      <div style={{ textAlign: "center", padding: "1.5rem 1rem" }}>
        <div style={{ fontSize: "2.2rem", marginBottom: "0.5rem" }}>📈</div>
        <p style={{ color: C.text, fontSize: "0.9rem", fontWeight: 700, margin: "0 0 0.3rem" }}>{t("growthEmptyFew")}</p>
        <p style={{ color: C.muted, fontSize: "0.78rem", margin: "0 0 1rem", lineHeight: 1.5 }}>{t("growthEmptyFewSub")}</p>
        <div style={{ display: "flex", justifyContent: "center", gap: "2rem" }}>
          <div style={{ textAlign: "center" as const }}>
            <div style={{ color: C.purple, fontSize: "2rem", fontWeight: 900 }}>{authors}</div>
            <div style={{ color: C.faint, fontSize: "0.68rem", letterSpacing: "0.5px" }}>{t("impactAuthors").toUpperCase()}</div>
          </div>
          <div style={{ textAlign: "center" as const }}>
            <div style={{ color: C.info, fontSize: "2rem", fontWeight: 900 }}>{total}</div>
            <div style={{ color: C.faint, fontSize: "0.68rem", letterSpacing: "0.5px" }}>{t("impactVotes").toUpperCase()}</div>
          </div>
        </div>
      </div>
    );
  };

  const W=700, H=160, padL=8, padR=8, padT=12, padB=24;
  const cW=W-padL-padR, cH=H-padT-padB;
  const maxA = Math.max(...data.map(d=>d.cumAuthors), 1);
  const maxV = Math.max(...data.map(d=>d.cumVotes),   1);
  const maxDA= Math.max(...data.map(d=>d.newAuthors),  1);
  const n    = data.length;

  function xP(i: number)     { return padL+(i/(n-1))*cW; }
  function yA(v: number)     { return padT+cH-(v/maxA)*cH; }
  function yV(v: number)     { return padT+cH-(v/maxV)*cH; }

  const authPath = data.map((d,i)=>`${i===0?"M":"L"} ${xP(i).toFixed(1)} ${yA(d.cumAuthors).toFixed(1)}`).join(" ");
  const votePath = data.map((d,i)=>`${i===0?"M":"L"} ${xP(i).toFixed(1)} ${yV(d.cumVotes).toFixed(1)}`).join(" ");
  const fillAuth = `${authPath} L ${(padL+cW).toFixed(1)} ${(padT+cH).toFixed(1)} L ${padL.toFixed(1)} ${(padT+cH).toFixed(1)} Z`;

  // Milestone markers at 10, 25, 50, 100 authors
  const milestones = [10, 25, 50, 100].filter(m => m < maxA && m > 0);

  const labelIdxs = n > 1 ? [0, Math.floor((n-1)/2), n-1] : [];

  return (
    <div style={{ ...card, padding: "1.5rem 1.75rem" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "0.75rem" }}>
        <div>
          <p style={{ ...lbl, margin: 0 }}>{t("growthChartTitle")}</p>
          <p style={{ color: C.faint, fontSize: "0.72rem", margin: "0.2rem 0 0", fontStyle: "italic" }}>{t("growthChartNote")}</p>
        </div>
        <div style={{ display: "flex", gap: "0.3rem", flexShrink: 0 }}>
          {(["30d","90d","all"] as const).map(p => (
            <button key={p} type="button" onClick={() => setGrowthPeriod(p)} style={{
              background: growthPeriod===p ? C.purple+"22" : "none",
              border: `1px solid ${growthPeriod===p ? C.purple : C.border}`,
              borderRadius: "6px", color: growthPeriod===p ? C.purple : C.faint,
              cursor: "pointer", fontSize: "0.7rem", padding: "0.18rem 0.5rem", fontWeight: 600,
            }}>
              {p==="30d"?t("growthPeriod30d"):p==="90d"?t("growthPeriod90d"):t("growthPeriodAll")}
            </button>
          ))}
        </div>
      </div>

      {growthLoading ? (
        <p style={{ color: C.faint, fontSize: "0.82rem", margin: "1rem 0", textAlign: "center" }}>{t("growthLoading")}</p>
      ) : data.length < 3 ? emptyState() : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }} preserveAspectRatio="none">
            <defs>
              <linearGradient id="authFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.purple} stopOpacity="0.25"/>
                <stop offset="100%" stopColor={C.purple} stopOpacity="0"/>
              </linearGradient>
            </defs>
            {/* Subtle grid */}
            {[0.25,0.5,0.75].map(f => (
              <line key={f} x1={padL} y1={padT+cH*(1-f)} x2={padL+cW} y2={padT+cH*(1-f)} stroke={C.border} strokeWidth="0.5"/>
            ))}
            {/* Daily new author bars (context) */}
            {data.map((d,i) => d.newAuthors>0 && (
              <rect key={i} x={xP(i)-Math.max(1,cW/n/2)} y={padT+cH-(d.newAuthors/maxDA)*(cH*0.3)} width={Math.max(2,cW/n-1)} height={(d.newAuthors/maxDA)*(cH*0.3)} fill={C.purple+"18"} rx="1"/>
            ))}
            {/* Milestone lines */}
            {milestones.map(m => {
              const y = yA(m);
              return <line key={m} x1={padL} y1={y} x2={padL+cW} y2={y} stroke={C.purple+"33"} strokeWidth="1" strokeDasharray="4 4"/>;
            })}
            {/* Votes line (secondary, thin, blue) */}
            <path d={votePath} fill="none" stroke={C.info+"55"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            {/* Authors fill */}
            <path d={fillAuth} fill="url(#authFill)"/>
            {/* Authors line (primary, thick, purple) */}
            <path d={authPath} fill="none" stroke={C.purple} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
            {/* End dot — current value */}
            <circle cx={xP(n-1).toFixed(1)} cy={yA(data[n-1].cumAuthors).toFixed(1)} r="5" fill={C.purple} filter="url(#gvp)"/>
            <text x={xP(n-1)+6} y={yA(data[n-1].cumAuthors)-4} fill={C.purple} fontSize="10" fontWeight="700">{data[n-1].cumAuthors}</text>
            {/* X labels */}
            {labelIdxs.map(i => (
              <text key={i} x={xP(i)} y={H-5} textAnchor="middle" fill={C.faint} fontSize="9">{data[i].day.slice(5)}</text>
            ))}
          </svg>
          <div style={{ display: "flex", gap: "1.5rem", marginTop: "8px", fontSize: "0.73rem", flexWrap: "wrap" as const }}>
            <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <span style={{ display: "inline-block", width: "18px", height: "3px", background: C.purple, borderRadius: "2px" }}/>
              <span style={{ color: C.muted }}>{t("growthCumAuthors")} ({data[n-1].cumAuthors})</span>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <span style={{ display: "inline-block", width: "18px", height: "2px", background: C.info+"88", borderRadius: "1px" }}/>
              <span style={{ color: C.muted }}>{t("growthCumVotes")} ({data[n-1].cumVotes.toLocaleString()})</span>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ── Curator Journey — level progression based on unique authors ───────────────

function CuratorJourney({ totalAuthors, t }: {
  totalAuthors: number; t: ReturnType<typeof createTranslator>;
}) {
  const level  = journeyLevel(totalAuthors);
  const isMax  = level.idx === JOURNEY.length - 1;
  const nextThr = isMax ? totalAuthors : JOURNEY[level.idx + 1].minA;
  const pct    = isMax ? 100 : Math.min(100, ((totalAuthors - level.minA) / (nextThr - level.minA)) * 100);
  const remaining = isMax ? 0 : nextThr - totalAuthors;
  const nextLevel = isMax ? null : JOURNEY[level.idx + 1];

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: "1.25rem" }}>
      {/* Current level badge */}
      <div style={{
        display: "flex", alignItems: "center", gap: "1rem",
        padding: "1.1rem 1.25rem",
        background: `linear-gradient(135deg, ${level.color}18 0%, ${C.bg3} 100%)`,
        border: `1.5px solid ${level.color}44`, borderRadius: "12px",
      }}>
        <span style={{ fontSize: "2.4rem", filter: `drop-shadow(0 0 10px ${level.color}66)` }}>{level.emoji}</span>
        <div>
          <div style={{ color: level.color, fontWeight: 900, fontSize: "1.05rem" }}>{t(level.key)}</div>
          <div style={{ color: C.faint, fontSize: "0.72rem", marginTop: "2px" }}>
            {totalAuthors} {t("levelAuthorsOf")}
          </div>
        </div>
      </div>

      {/* Progress to next */}
      {!isMax && nextLevel && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px", fontSize: "0.73rem" }}>
            <span style={{ color: C.muted }}>{remaining} {t("levelMoreAuthors")} <b style={{ color: nextLevel.color }}>{t(nextLevel.key)}</b></span>
            <span style={{ color: level.color, fontWeight: 700 }}>{pct.toFixed(0)}%</span>
          </div>
          <div style={{ height: "10px", background: C.bg3, borderRadius: "5px", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: `linear-gradient(90deg, ${level.color}88, ${level.color})`, borderRadius: "5px", transition: "width 0.7s ease", boxShadow: `0 0 8px ${level.color}55` }}/>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "4px", fontSize: "0.67rem", color: C.faint }}>
            <span>{totalAuthors}</span><span>{nextThr}</span>
          </div>
        </div>
      )}
      {isMax && <p style={{ color: C.gold, fontSize: "0.82rem", fontWeight: 700, margin: 0 }}>{t("levelMaxReached")}</p>}

      {/* Level track */}
      <div>
        <div style={{ display: "flex", gap: "3px", marginBottom: "4px" }}>
          {JOURNEY.map((l, i) => (
            <div key={l.key} style={{ flex: 1, height: "6px", borderRadius: "3px", background: i <= level.idx ? l.color : C.bg3, transition: "background 0.4s" }} title={t(l.key)}/>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.6rem", color: C.faint }}>
          <span>{JOURNEY[0].emoji}</span>
          <span>{JOURNEY[JOURNEY.length-1].emoji}</span>
        </div>
      </div>

      {/* Journey steps (compact) */}
      <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.3rem" }}>
        {JOURNEY.map((l, i) => (
          <div key={l.key} style={{ display: "flex", alignItems: "center", gap: "0.6rem", opacity: i > level.idx + 1 ? 0.35 : 1 }}>
            <span style={{ fontSize: "0.9rem", width: "20px", textAlign: "center" as const }}>{l.emoji}</span>
            <div style={{ flex: 1, height: "1px", background: i <= level.idx ? l.color+"55" : C.border }}/>
            <span style={{ fontSize: "0.68rem", fontWeight: 700, color: i <= level.idx ? l.color : C.faint, minWidth: "110px" }}>{t(l.key)}</span>
            <span style={{ fontSize: "0.63rem", color: C.faint, width: "40px", textAlign: "right" as const }}>{l.minA === 0 ? "0" : `${l.minA}+`}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Relationships Panel ───────────────────────────────────────────────────────

function RelationshipsPanel({ authors, t }: {
  authors: CurationProfile["topAuthors"]; t: ReturnType<typeof createTranslator>;
}) {
  if (authors.length === 0) return (
    <p style={{ color: C.faint, fontSize: "0.82rem", margin: 0 }}>—</p>
  );

  const maxVotes = Math.max(...authors.map(a => a.voteCount), 1);

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.85rem" }}>
      {authors.slice(0, 5).map((a, i) => {
        const isTop = i === 0;
        const barW  = (a.voteCount / maxVotes) * 100;
        return (
          <div key={a.username} style={{
            padding: "0.75rem 0.9rem",
            background: isTop ? `linear-gradient(135deg, ${C.purple}14, ${C.bg3})` : C.bg3,
            border: `1px solid ${isTop ? C.purple+"44" : C.border}`,
            borderRadius: "10px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.65rem", marginBottom: "0.4rem" }}>
              {/* Avatar */}
              <div style={{ width: "36px", height: "36px", borderRadius: "50%", flexShrink: 0, background: `linear-gradient(135deg, ${C.purple}33, ${C.info}22)`, border: `2px solid ${C.purple}44`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.95rem", fontWeight: 800, color: C.purple }}>
                {a.username[0]?.toUpperCase() ?? "?"}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <span style={{ color: C.info, fontWeight: 700, fontSize: "0.85rem" }}>@{a.username}</span>
                  {isTop && <span style={{ background: C.purple+"22", color: C.purple, borderRadius: "8px", padding: "0 0.35rem", fontSize: "0.6rem", fontWeight: 700 }}>#{i+1} {t("relStrongestNote")}</span>}
                </div>
                <div style={{ color: C.faint, fontSize: "0.7rem", marginTop: "1px" }}>
                  {a.voteCount} {t("relVotesTogether")} · {a.sharePct}% {t("relShareCuration")}
                  {a.lastVoteDaysAgo !== undefined && a.lastVoteDaysAgo >= 0 && (
                    <span style={{ color: a.lastVoteDaysAgo <= 3 ? C.ok : C.faint }}> · {a.lastVoteDaysAgo === 0 ? t("timeToday") : `${t("relLastVoted")} ${a.lastVoteDaysAgo} ${t("relDays")}`}</span>
                  )}
                </div>
              </div>
              <div style={{ flexShrink: 0, textAlign: "right" as const }}>
                <div style={{ color: C.purple, fontWeight: 800, fontSize: "1.1rem" }}>{a.voteCount}</div>
                <div style={{ color: C.faint, fontSize: "0.6rem" }}>votes</div>
              </div>
            </div>
            {/* Relationship strength bar */}
            <div style={{ height: "3px", background: C.bg4, borderRadius: "2px", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${barW}%`, background: `linear-gradient(90deg, ${C.purple}88, ${C.purple})`, borderRadius: "2px" }}/>
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
  onAction: { plan:()=>void; opps:()=>void; dna:()=>void };
  t: ReturnType<typeof createTranslator>;
}) {
  const eligible = opps?.filter(p => p.eligible) ?? [];

  if (votes.length === 0 && eligible.length === 0) return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.5rem" }}>
      <div style={{ textAlign: "center", padding: "0.75rem 0 1rem" }}>
        <div style={{ fontSize: "1.8rem", marginBottom: "0.3rem" }}>🌱</div>
        <p style={{ color: C.muted, fontSize: "0.85rem", fontWeight: 600, margin: "0 0 0.15rem" }}>{t("actNoActivity")}</p>
        <p style={{ color: C.faint, fontSize: "0.75rem", margin: 0 }}>{t("actStartTimeline")}</p>
      </div>
      {[
        { icon:"⚡", label:t("btnFindOpps"),    col:C.warn,   fn:onAction.opps },
        { icon:"🗳", label:t("btnGeneratePlan"), col:C.purple, fn:onAction.plan },
      ].map(a => (
        <button key={a.label} type="button" onClick={a.fn} style={{ background:a.col+"10", border:`1px solid ${a.col}33`, borderRadius:"9px", color:a.col, cursor:"pointer", fontSize:"0.8rem", padding:"0.55rem 0.85rem", textAlign:"left" as const, display:"flex", alignItems:"center", gap:"0.5rem" }}>
          <span>{a.icon}</span><span style={{ fontWeight:600 }}>{a.label}</span>
        </button>
      ))}
    </div>
  );

  const items: Array<{ col:string; icon:string; line1:string; line2:string; right:string }> = [];
  eligible.slice(0,3).forEach(p => {
    const w = p.postScore>=80?t("oppOptimalWindow"):p.postScore>=50?t("oppGoodWindow"):t("oppLateWindow");
    items.push({ col:C.warn, icon:"⚡", line1:`@${p.author}`, line2:`${t("actNewPost")} · ${fmtMin(p.ageMinutes)} ago · ${w}`, right:t("actOpen") });
  });
  votes.slice(0,8).forEach(v => {
    items.push({ col:C.ok, icon:"✓", line1:`@${v.author}`, line2:`${v.weightPct}% vote`, right:`+${fmtUsd(v.weightPct/100*voteUsd)} · ${fmtAge(v.votedAt,t)}` });
  });

  return (
    <div>
      {items.map((item, i) => (
        <div key={i} style={{ display:"flex", alignItems:"center", gap:"0.6rem", padding:"0.55rem 0", borderBottom:i<items.length-1?`1px solid ${C.border}`:"none" }}>
          <div style={{ width:"28px", height:"28px", borderRadius:"50%", flexShrink:0, background:item.col+"18", border:`1.5px solid ${item.col}44`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:"0.8rem" }}>{item.icon}</div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ color:C.info, fontWeight:700, fontSize:"0.8rem" }}>{item.line1}</div>
            <div style={{ color:C.faint, fontSize:"0.7rem" }}>{item.line2}</div>
          </div>
          <div style={{ color:C.muted, fontSize:"0.68rem", flexShrink:0, whiteSpace:"nowrap" as const }}>{item.right}</div>
        </div>
      ))}
    </div>
  );
}

// ── Technical strip — compact, at the bottom ──────────────────────────────────

function TechnicalStrip({ snapshot, snapshotLoading, opportunities, opportunitiesMeta, recentVotes, votePlan, strategyRules, curationProfile, onRefresh, onLoadOpps, onTabChange, onGenerateVotes, snapshotRefreshedAt, t }: {
  snapshot: SteemAccountSnapshot | null; snapshotLoading: boolean; snapshotRefreshedAt?: Date;
  opportunities: PostOpportunity[] | null; opportunitiesMeta: OpportunitiesMeta | null;
  recentVotes: RecentVote[]; votePlan: VotePlanResponse | null; strategyRules: StrategyRuleLite[] | null;
  curationProfile: CurationProfile | null;
  onRefresh?: () => void; onLoadOpps: () => void;
  onTabChange: (tab: "dna" | "dashboard" | "community" | "billing") => void; onGenerateVotes: () => void;
  t: ReturnType<typeof createTranslator>;
}) {
  const vpPct    = snapshot ? snapshot.votingPowerBps / 100 : null;
  const openOpps = opportunities?.filter(p => p.eligible) ?? [];
  const avgW     = strategyRules && strategyRules.length > 0 ? strategyRules.filter(r => r.enabled).reduce((s, r) => s + r.maxWeightPct, 0) / strategyRules.filter(r => r.enabled).length : 0;
  const sessUsd  = recentVotes.reduce((s, v) => s + v.weightPct / 100 * (snapshot?.currentVoteUsd ?? 0), 0);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr", gap: "1rem" }}>
      {/* VP compact card */}
      <div style={{ ...card, padding: "1.1rem 1.25rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem" }}>
          <span style={{ color: C.dim, fontSize: "0.68rem", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.8px" }}>{t("secTechnical")}</span>
          {onRefresh && <button type="button" onClick={onRefresh} disabled={snapshotLoading} style={{ background:"none", border:"none", cursor:"pointer", color:snapshotLoading?C.faint:C.muted, fontSize:"0.9rem", padding:0 }}>↻</button>}
        </div>
        {vpPct !== null ? (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: "0.4rem", marginBottom: "0.4rem" }}>
              <span style={{ color: vpCol(vpPct), fontSize: "1.8rem", fontWeight: 900, lineHeight: 1 }}>{vpPct.toFixed(1)}%</span>
              <span style={{ color: C.faint, fontSize: "0.72rem" }}>VP</span>
              {snapshot && <span style={{ color: C.faint, fontSize: "0.72rem", marginLeft: "auto" }}>{fmtUsd(snapshot.currentVoteUsd)}/vote</span>}
            </div>
            <div style={{ height: "6px", background: C.bg3, borderRadius: "3px", overflow: "hidden", marginBottom: "0.35rem" }}>
              <div style={{ height:"100%", width:`${vpPct}%`, background:vpCol(vpPct), borderRadius:"3px", transition:"width 0.5s", boxShadow:`0 0 6px ${vpCol(vpPct)}66` }}/>
            </div>
            {(() => {
              const regenH = vpPct >= 99.9 ? 0 : (100 - vpPct) / 20 * 24;
              const to90 = vpPct >= 90 ? null : (90-vpPct)/20*24;
              return (
                <div style={{ display:"flex", gap:"0.5rem", fontSize:"0.68rem" }}>
                  {to90 && <span style={{ color: C.ok }}>→ 90% in {to90 < 1 ? `${Math.round(to90*60)}m` : `${to90.toFixed(1)}h`}</span>}
                  {regenH > 0 && <span style={{ color: C.faint, marginLeft:"auto" }}>full in {regenH<1?`${Math.round(regenH*60)}m`:`${regenH.toFixed(1)}h`}</span>}
                  {regenH === 0 && <span style={{ color: C.ok, marginLeft:"auto" }}>✓ fully charged</span>}
                </div>
              );
            })()}
            {snapshot && <div style={{ color: C.faint, fontSize: "0.65rem", marginTop: "0.35rem" }}>{snapshot.steemPowerSp.toFixed(0)} SP · full: {fmtUsd(snapshot.fullPowerVoteUsd)}</div>}
          </>
        ) : (
          <div style={{ color: C.faint, fontSize: "0.82rem" }}>{snapshotLoading ? "Loading…" : "—"}</div>
        )}
        {snapshotRefreshedAt && <div style={{ color: C.faint, fontSize: "0.6rem", marginTop: "0.25rem" }}>{fmtAge(snapshotRefreshedAt.toISOString(), t)}</div>}
      </div>

      {/* Opportunities */}
      <div style={{ ...card, padding: "1.1rem 1.25rem", cursor: "pointer" }} onClick={() => { onLoadOpps(); onTabChange("dna"); }}>
        <p style={{ ...lbl, margin: "0 0 0.5rem" }}>{t("kpiOpenOpps")}</p>
        <div style={{ color: openOpps.length>0?C.warn:opportunities!==null?C.ok:C.dim, fontSize: "2.2rem", fontWeight: 900, lineHeight: 1, letterSpacing: "-1px", marginBottom: "0.4rem" }}>
          {openOpps.length > 0 ? openOpps.length : opportunities === null ? "—" : "0"}
        </div>
        <div style={{ fontSize: "0.72rem", display: "flex", flexDirection: "column" as const, gap: "0.12rem" }}>
          {openOpps.length > 0 && <span style={{ color: C.warn }}>{openOpps.filter(p=>p.postScore>=80).length} {t("oppOptimalWindow")}</span>}
          {opportunitiesMeta && <span style={{ color: C.faint }}>{opportunitiesMeta.scannedAuthors}/{opportunitiesMeta.requestedAuthors} {t("oppScanned")}</span>}
          {opportunities === null && <span style={{ color: C.muted }}>{t("oppTapToDiscover")}</span>}
          {opportunities !== null && openOpps.length === 0 && <span style={{ color: C.info }}>{t("oppVotedRescan")}</span>}
        </div>
      </div>

      {/* Session + Monthly */}
      <div style={{ ...card, padding: "1.1rem 1.25rem" }}>
        <p style={{ ...lbl, margin: "0 0 0.5rem" }}>{t("kpiSessionImpact")}</p>
        <div style={{ color: recentVotes.length>0?C.ok:C.purple, fontSize: "2.2rem", fontWeight: 900, lineHeight: 1, letterSpacing: "-1px", marginBottom: "0.4rem" }}>
          {recentVotes.length > 0 ? fmtUsd(sessUsd) : "—"}
        </div>
        <div style={{ fontSize: "0.72rem", color: C.faint }}>
          {recentVotes.length > 0 ? `${recentVotes.length} ${t("actVotesInSession")}` : t("emptyNoVotesToday")}
          {curationProfile && snapshot && <div style={{ color: C.purple, marginTop: "2px" }}>~{fmtUsd(curationProfile.votesPerDay*30*snapshot.currentVoteUsd*avgW/100)}/mo est.</div>}
        </div>
      </div>

      {/* Quick Actions */}
      <div style={{ ...card, padding: "1.1rem 1.25rem" }}>
        <p style={{ ...lbl, margin: "0 0 0.65rem" }}>{t("secQuickActions")}</p>
        <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.4rem" }}>
          {([
            { icon:"🧬", label:t("btnVoteDna"),  col:C.info,   fn:()=>onTabChange("dna") },
            { icon:"🗳",  label:t("btnVotePlan"), col:C.purple, fn:()=>{onTabChange("dna");onGenerateVotes();} },
            { icon:"⚡",  label:openOpps.length>0?`${t("btnOpportunities")} (${openOpps.length})`:t("btnScan"), col:openOpps.length>0?C.warn:C.muted, fn:()=>{onLoadOpps();onTabChange("dna");} },
            { icon:"⚙",  label:t("btnSettings"), col:C.ok,     fn:()=>onTabChange("billing") },
          ] as const).map((a, i) => (
            <button key={i} type="button" onClick={a.fn} style={{ background:a.col+"0e", border:`1px solid ${a.col}25`, borderRadius:"7px", padding:"0.4rem 0.6rem", cursor:"pointer", textAlign:"left" as const, display:"flex", alignItems:"center", gap:"0.4rem" }}>
              <span style={{ fontSize:"0.85rem" }}>{a.icon}</span>
              <span style={{ color:C.text, fontSize:"0.75rem", fontWeight:700 }}>{a.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Authors grid (strategy) ───────────────────────────────────────────────────

function AuthorGrid({ rules, openOpps, snapshot, dnaMap, onTabChange, t }: {
  rules: StrategyRuleLite[]; openOpps: PostOpportunity[];
  snapshot: SteemAccountSnapshot | null;
  dnaMap: Map<string, CurationProfile["topAuthors"][number]>;
  onTabChange: (tab: "dna" | "dashboard" | "community" | "billing") => void; t: ReturnType<typeof createTranslator>;
}) {
  if (rules.length === 0) return (
    <div style={{ ...card, textAlign: "center" as const, padding: "2rem" }}>
      <div style={{ fontSize: "2rem", marginBottom: "0.6rem" }}>🧬</div>
      <p style={{ color: C.muted, fontSize: "0.88rem", margin: "0 0 0.85rem", fontWeight: 600 }}>{t("emptyAuthors")}</p>
      <button type="button" onClick={() => onTabChange("dna")} style={{ background:C.info+"22", border:`1px solid ${C.info}`, borderRadius:"8px", color:C.info, cursor:"pointer", fontSize:"0.82rem", padding:"0.45rem 1rem", fontWeight:700 }}>{t("btnAnalyzeDna")}</button>
    </div>
  );

  const oppMap = new Map(openOpps.map(p => [p.author, p]));
  const voteUsd = snapshot?.currentVoteUsd ?? 0;

  return (
    <div style={card}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"1rem" }}>
        <p style={{ ...lbl, margin:0 }}>{t("secCuratedAuthors")} — {rules.length}
          {openOpps.length > 0 && <span style={{ color:C.warn, marginLeft:"0.75rem" }}>⚡ {openOpps.length} new</span>}
        </p>
        <button type="button" onClick={() => onTabChange("dna")} style={{ background:"none", border:`1px solid ${C.border}`, borderRadius:"6px", color:C.muted, cursor:"pointer", fontSize:"0.73rem", padding:"0.22rem 0.55rem" }}>{t("btnEditStrategy")}</button>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:"0.5rem" }}>
        {rules.slice(0, 16).map(r => {
          const cat = CAT_DEF[r.category] ?? { color:C.dim, icon:"⚪", tKey:"catNormal" as TranslationKey, pri:2 };
          const op  = oppMap.get(r.username);
          const dna = dnaMap.get(r.username);
          const est = Math.round(r.maxWeightPct/100*voteUsd*10000)/10000;
          return (
            <div key={r.username} style={{ background:op?cat.color+"0a":C.bg3, border:`1px solid ${op?cat.color+"55":C.border}`, borderRadius:"8px", padding:"0.6rem 0.75rem", display:"flex", gap:"0.5rem", alignItems:"flex-start" }}>
              <div style={{ width:"30px", height:"30px", borderRadius:"50%", flexShrink:0, background:cat.color+"20", border:`2px solid ${cat.color}44`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:"0.8rem", fontWeight:800, color:cat.color }}>{r.username[0]?.toUpperCase()}</div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:"0.25rem", flexWrap:"wrap" as const }}>
                  <span style={{ color:C.info, fontWeight:700, fontSize:"0.76rem" }}>@{r.username}</span>
                  {op && <span style={{ color:cat.color, fontSize:"0.6rem", fontWeight:700 }}>⚡</span>}
                </div>
                <div style={{ fontSize:"0.68rem", color:C.faint, marginTop:"1px" }}>
                  {r.maxWeightPct}% · {fmtUsd(est)}{dna?` · ${dna.voteCount}v`:""}
                </div>
                {op && <div style={{ fontSize:"0.65rem", color:cat.color, marginTop:"2px" }}>{fmtMin(op.ageMinutes)} ago</div>}
              </div>
            </div>
          );
        })}
        {rules.length > 16 && (
          <div style={{ gridColumn:"1/-1", color:C.faint, fontSize:"0.73rem", textAlign:"center", paddingTop:"0.25rem" }}>
            +{rules.length-16} more · <span style={{ color:C.info, cursor:"pointer" }} onClick={() => onTabChange("dna")}>view all →</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export function UserDashboard(props: {
  session: AuthSession; locale: Locale;
  snapshot: SteemAccountSnapshot | null; snapshotLoading: boolean; snapshotRefreshedAt?: Date;
  strategyRules: StrategyRuleLite[] | null;
  opportunities: PostOpportunity[] | null; opportunitiesLoading: boolean;
  opportunitiesMeta: OpportunitiesMeta | null;
  votePlan: VotePlanResponse | null;
  curationProfile: CurationProfile | null;
  recentVotes: RecentVote[];
  onTabChange: (tab: "dna" | "dashboard" | "community" | "billing") => void;
  onGenerateVotes: () => void; onLoadOpportunities: () => void; onRefreshSnapshot?: () => void;
}) {
  const t = createTranslator(props.locale);
  const { snapshot, strategyRules, opportunities, opportunitiesMeta, votePlan, curationProfile, recentVotes } = props;

  const rules      = sortRules(strategyRules ?? []);
  const openOpps   = opportunities?.filter(p => p.eligible) ?? [];
  const dnaAuthors = curationProfile?.topAuthors ?? [];
  const dnaMap     = new Map(dnaAuthors.map(a => [a.username, a]));

  const totalAuthors = curationProfile?.uniqueAuthors ?? 0;

  const [growthData,    setGrowthData]    = useState<GrowthData | null>(null);
  const [growthLoading, setGrowthLoading] = useState(false);
  const [growthPeriod,  setGrowthPeriod]  = useState<"30d"|"90d"|"all">("all");

  useEffect(() => {
    setGrowthLoading(true);
    fetchGrowthData(props.session.token, growthPeriod)
      .then(setGrowthData).catch(() => {}).finally(() => setGrowthLoading(false));
  }, [props.session.token, growthPeriod]);

  return (
    <div style={{ padding: "1.5rem 2rem", display: "flex", flexDirection: "column", gap: "1.5rem" }}>

      {/* ── 1. Community Hero ─────────────────────────────────── */}
      {curationProfile
        ? <CommunityHero profile={curationProfile} growth={growthData} t={t}/>
        : (
          <div style={{ ...card, display:"flex", alignItems:"center", gap:"0.85rem", padding:"1.1rem 1.5rem" }}>
            <span style={{ fontSize:"1.6rem" }}>🧬</span>
            <span style={{ color:C.muted, fontSize:"0.88rem", flex:1, lineHeight:1.5 }}>{t("emptyDnaHint")}</span>
            <button type="button" onClick={() => props.onTabChange("dna")} style={{ background:C.info+"22", border:`1px solid ${C.info}`, borderRadius:"8px", color:C.info, cursor:"pointer", fontSize:"0.82rem", padding:"0.45rem 1rem", fontWeight:700, flexShrink:0 }}>{t("btnAnalyzeDna")}</button>
          </div>
        )
      }

      {/* ── 2. Community Growth Chart ─────────────────────────── */}
      <CommunityGrowthChart
        growth={growthData} growthLoading={growthLoading}
        growthPeriod={growthPeriod} setGrowthPeriod={setGrowthPeriod}
        t={t}
      />

      {/* ── 3. Journey | Relationships | Activity ─────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1.5rem", alignItems: "start" }}>
        <div style={card}>
          <p style={lbl}>{t("secCuratorJourney")}</p>
          <CuratorJourney totalAuthors={growthData?.summary.totalUniqueAuthors ?? totalAuthors} t={t}/>
        </div>
        <div style={card}>
          <p style={lbl}>{t("secRelationships")}</p>
          {dnaAuthors.length > 0
            ? <RelationshipsPanel authors={dnaAuthors} t={t}/>
            : <p style={{ color:C.faint, fontSize:"0.82rem", margin:0 }}>{t("emptyDnaHint")}</p>}
        </div>
        <div style={card}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"0.75rem" }}>
            <p style={{ ...lbl, margin:0 }}>{t("secRecentActivity")}</p>
            {recentVotes.length > 0 && <span style={{ color:C.faint, fontSize:"0.68rem" }}>{recentVotes.length} {t("actVotesInSession")}</span>}
          </div>
          <ActivityTimeline
            votes={recentVotes} voteUsd={snapshot?.currentVoteUsd??0}
            opps={opportunities}
            onAction={{ plan:()=>{props.onTabChange("dna");props.onGenerateVotes();}, opps:props.onLoadOpportunities, dna:()=>props.onTabChange("dna") }}
            t={t}
          />
        </div>
      </div>

      {/* ── 4. Author Strategy Grid ──────────────────────────────── */}
      {strategyRules !== null && (
        <AuthorGrid rules={rules} openOpps={openOpps} snapshot={snapshot} dnaMap={dnaMap} onTabChange={props.onTabChange} t={t}/>
      )}

      {/* ── 5. Technical Strip (VP, Opportunities, Session, Actions) */}
      <TechnicalStrip
        snapshot={snapshot} snapshotLoading={props.snapshotLoading} snapshotRefreshedAt={props.snapshotRefreshedAt}
        opportunities={opportunities} opportunitiesMeta={opportunitiesMeta}
        recentVotes={recentVotes} votePlan={votePlan}
        strategyRules={strategyRules} curationProfile={curationProfile}
        onRefresh={props.onRefreshSnapshot}
        onLoadOpps={props.onLoadOpportunities}
        onTabChange={props.onTabChange} onGenerateVotes={props.onGenerateVotes}
        t={t}
      />

    </div>
  );
}
