import { useEffect, useRef } from "react";
import type {
  AuthSession,
  CurationProfile,
  PostOpportunity,
  SteemAccountSnapshot,
  VotePlanResponse,
} from "../api";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecentVote {
  author: string; permlink: string; title: string; weightPct: number; votedAt: string;
}

interface StrategyRuleLite {
  username: string; category: string; maxWeightPct: number; enabled: boolean;
}

type DnaAuthor = {
  username: string; voteCount: number; sharePct: number; avgWeightPct: number;
  compositeScore: number; lastVoteDaysAgo: number; selectionReasons: string[];
};

// ── Design ────────────────────────────────────────────────────────────────────

const C = {
  ok: "#3fb950", warn: "#f0a500", err: "#f85149", info: "#58a6ff",
  purple: "#a371f7", fire: "#ff6b35", dim: "#8b949e",
  bg1: "#0d1117", bg2: "#161b22", bg3: "#1c2128",
  border: "#21262d", border2: "#30363d",
  text: "#e6edf3", muted: "#8b949e", faint: "#484f58",
};

const CAT: Record<string, { color: string; icon: string; label: string; pri: number }> = {
  immer_voten:    { color: C.fire,   icon: "🔥", label: "Always",    pri: 5 },
  lieblingsautor: { color: C.warn,   icon: "⭐", label: "Favorite",  pri: 4 },
  bevorzugt:      { color: C.info,   icon: "🟦", label: "Preferred", pri: 3 },
  normal:         { color: C.ok,     icon: "⚪", label: "Normal",    pri: 2 },
  niedrig:        { color: C.dim,    icon: "⬇", label: "Low",       pri: 1 },
};

const DNA_EMOJI: Record<string, string> = {
  "Self-Focused Voter": "🔴", "Loyal Inner Circle": "🟣",
  "Loyal Community Curator": "🟦", "Broad Explorer": "🟢",
  "Strategic Weight Voter": "🟡", "High-Frequency Curator": "🟠",
  "Niche Specialist": "🟤", "Regular Curator": "⚪",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtAgeIso(iso: string) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 2)    return "just now";
  if (m < 60)   return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}
function fmtMin(min: number) {
  if (min < 60)   return `${min}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}
function fmtUsd(v: number) { return v < 0.0005 ? "<$0.001" : `$${v.toFixed(3)}`; }
function vpCol(v: number)   { return v >= 85 ? C.ok : v >= 65 ? C.warn : C.err; }
function sortRules(r: StrategyRuleLite[]) {
  return [...r].filter(x => x.enabled && x.category !== "ignorieren")
    .sort((a, b) => (CAT[b.category]?.pri ?? 0) - (CAT[a.category]?.pri ?? 0));
}

// ── Auto-count animation ──────────────────────────────────────────────────────

function useCount(target: number, duration = 800) {
  const ref = useRef<number>(0);
  const [, tick] = useRef<(v: number) => void>(() => {}).current as unknown as [never, never];
  // Simple — just return target for SSR-safe rendering
  return target;
}

// ── Auto-generated insights ───────────────────────────────────────────────────

function generateInsights(
  profile: CurationProfile | null,
  rules: StrategyRuleLite[],
  openOpps: PostOpportunity[],
  vpPct: number | null,
  snapshot: SteemAccountSnapshot | null,
) {
  const insights: Array<{ icon: string; text: string; color: string; action?: string }> = [];

  if (!profile && rules.length === 0 && openOpps.length === 0) return [];

  // Best open opportunity
  if (openOpps.length > 0) {
    const best = openOpps.reduce((a, b) => a.postScore > b.postScore ? a : b);
    const catRule = rules.find(r => r.username === best.author);
    const catColor = catRule ? (CAT[catRule.category]?.color ?? C.warn) : C.warn;
    insights.push({
      icon: "⚡",
      text: `@${best.author} posted ${fmtMin(best.ageMinutes)} ago — ${best.ageMinutes <= 30 ? "optimal curation window" : "still within reward window"}${catRule ? ` · ${CAT[catRule.category]?.label ?? ""}` : ""}`,
      color: catColor,
    });
  }

  // DNA-based insight on top author
  if (profile && profile.topAuthors.length > 0) {
    const top = profile.topAuthors[0];
    const convict = top.avgWeightPct >= 80 ? "strong conviction" : top.avgWeightPct >= 50 ? "solid support" : "exploratory";
    insights.push({
      icon: "🧬",
      text: `Your strongest curation bond: @${top.username} — ${top.voteCount} votes at ${top.avgWeightPct}% avg weight (${convict})`,
      color: C.purple,
    });
  }

  // VP sustainability message
  if (vpPct !== null && profile) {
    const avgW = rules.length > 0 ? rules.reduce((s, r) => s + r.maxWeightPct, 0) / rules.length : 0;
    const dailySpend = profile.votesPerDay * avgW / 100; // % per day
    if (vpPct > 92) {
      insights.push({ icon: "💡", text: `VP at ${vpPct.toFixed(1)}% — you have capacity to vote more today without affecting sustainability`, color: C.ok });
    } else if (dailySpend > 20) {
      insights.push({ icon: "⚠", text: `Strategy spends ~${dailySpend.toFixed(1)}% VP/day — consider reducing weights on lower-priority authors`, color: C.warn });
    } else {
      insights.push({ icon: "✓", text: `Strategy is sustainable — estimated ${Math.round(dailySpend * 10) / 10}% VP/day with your current ${rules.length} authors`, color: C.ok });
    }
  }

  // Profile duration insight
  if (profile && profile.periodDays > 14) {
    const hrs = profile.peakHoursUtc[0];
    const peakText = hrs ? `Your peak activity: ${String(hrs.hour).padStart(2,"0")}:00 UTC` : "";
    insights.push({
      icon: "📊",
      text: `${profile.periodDays}-day curation history analyzed · ${profile.uniqueAuthors} authors · ${peakText}`,
      color: C.info,
    });
  }

  return insights.slice(0, 3);
}

// ── VP Arc Gauge ──────────────────────────────────────────────────────────────

function VpGauge({ pct, size = 160 }: { pct: number; size?: number }) {
  const cx = size / 2, cy = size * 0.52, r = size * 0.37, sw = size * 0.078;
  const col = vpCol(pct);
  const start = 145, total = 250;
  const valDeg = start + (pct / 100) * total;

  function p(deg: number, rr: number) {
    const rad = (deg - 90) * Math.PI / 180;
    return { x: (cx + rr * Math.cos(rad)).toFixed(1), y: (cy + rr * Math.sin(rad)).toFixed(1) };
  }
  function arc(a: number, b: number) {
    const s = p(a, r), e = p(b, r);
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${((b-a+360)%360) > 180 ? 1 : 0} 1 ${e.x} ${e.y}`;
  }

  const tick = p(valDeg, r);
  const regenH = pct >= 99.9 ? 0 : (100 - pct) / 20 * 24;
  const regenText = regenH === 0 ? "fully charged" : regenH < 1 ? `${Math.round(regenH*60)}m to full` : `${regenH.toFixed(1)}h to full`;

  return (
    <svg width={size} height={size * 0.77} viewBox={`0 0 ${size} ${size * 0.77}`} style={{ overflow: "visible" }}>
      <defs>
        <filter id="vglow"><feGaussianBlur stdDeviation="3" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      <path d={arc(start, start + total)} fill="none" stroke="#1a2030" strokeWidth={sw} strokeLinecap="round"/>
      {[20,40,60,80].map(v => {
        const d = start + (v/100)*total, i = p(d, r - sw*0.6), o = p(d, r + 2);
        return <line key={v} x1={i.x} y1={i.y} x2={o.x} y2={o.y} stroke="#2d3748" strokeWidth="1.5"/>;
      })}
      <path d={arc(start, valDeg)} fill="none" stroke={col} strokeWidth={sw} strokeLinecap="round" filter="url(#vglow)"/>
      <circle cx={tick.x} cy={tick.y} r={sw*0.55} fill={col} filter="url(#vglow)"/>
      <text x={cx} y={cy - 6} textAnchor="middle" fill={col} fontSize={size*0.155} fontWeight="800" fontFamily="inherit">{pct.toFixed(1)}</text>
      <text x={cx} y={cy + size*0.09} textAnchor="middle" fill={C.dim} fontSize={size*0.063} letterSpacing="1">VOTING POWER</text>
      <text x={cx} y={cy + size*0.17} textAnchor="middle" fill={C.faint} fontSize={size*0.053}>{regenText}</text>
    </svg>
  );
}

// ── Curation Identity Banner ──────────────────────────────────────────────────

function CurationIdentityBanner({ profile, snapshot }: { profile: CurationProfile; snapshot: SteemAccountSnapshot | null }) {
  const emoji = DNA_EMOJI[profile.dnaLabel] ?? "⚪";
  const conv  = profile.avgWeightPct >= 70 ? "high conviction" : profile.avgWeightPct >= 45 ? "balanced approach" : "exploratory style";
  const selfNote = profile.selfVotePct < 5 ? "community-first" : profile.selfVotePct > 20 ? "self-focused" : "";
  const peakHour = profile.peakHoursUtc[0];

  const estMonthly = snapshot && profile.votesPerDay
    ? Math.round(profile.votesPerDay * 30 * snapshot.currentVoteUsd * (profile.avgWeightPct / 100) * 100) / 100
    : null;

  return (
    <div style={{
      background: `linear-gradient(135deg, ${C.bg2} 0%, ${C.bg1} 100%)`,
      border: `1px solid ${C.border2}`,
      borderRadius: "12px", padding: "1rem 1.25rem",
      display: "flex", alignItems: "flex-start", gap: "1rem",
    }}>
      {/* DNA icon */}
      <div style={{
        fontSize: "2rem", lineHeight: 1, flexShrink: 0, marginTop: "0.1rem",
        filter: "drop-shadow(0 0 6px rgba(88,166,255,0.3))",
      }}>{emoji}</div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Identity line */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.3rem", flexWrap: "wrap" }}>
          <span style={{ color: C.info, fontSize: "1rem", fontWeight: 800 }}>{profile.dnaLabel}</span>
          <span style={{ color: C.faint, fontSize: "0.78rem" }}>·</span>
          <span style={{ color: C.muted, fontSize: "0.78rem" }}>{conv}{selfNote ? ` · ${selfNote}` : ""}</span>
        </div>

        {/* Narrative sentence */}
        <p style={{ color: C.text, fontSize: "0.82rem", margin: "0 0 0.5rem", lineHeight: 1.5 }}>
          You've curated <strong style={{ color: C.info }}>{profile.uniqueAuthors} authors</strong> over{" "}
          <strong style={{ color: C.info }}>{profile.periodDays} days</strong>, casting{" "}
          <strong style={{ color: C.ok }}>{profile.votesAnalyzed} votes</strong> at an average weight of{" "}
          <strong style={{ color: vpCol(profile.avgWeightPct) }}>{profile.avgWeightPct}%</strong>.
          {estMonthly ? <> At this pace, you move an estimated{" "}
            <strong style={{ color: C.ok }}>{fmtUsd(estMonthly)}/month</strong> in curation support.</> : null}
        </p>

        {/* DNA facts row */}
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {[
            { label: "Votes/day", val: profile.votesPerDay.toFixed(1) },
            { label: "Full-weight %", val: `${profile.fullWeightPct}%` },
            { label: "Self-votes", val: `${profile.selfVotePct}%` },
            peakHour ? { label: "Peak hour", val: `${String(peakHour.hour).padStart(2,"0")}:00 UTC` } : null,
          ].filter(Boolean).map(f => (
            <span key={f!.label} style={{
              background: C.bg3, border: `1px solid ${C.border}`, borderRadius: "5px",
              padding: "0.15rem 0.5rem", fontSize: "0.72rem", color: C.muted,
            }}>
              {f!.label}: <b style={{ color: C.text }}>{f!.val}</b>
            </span>
          ))}
        </div>
      </div>

      {/* Votes badge */}
      <div style={{ textAlign: "center", flexShrink: 0 }}>
        <div style={{ fontSize: "1.8rem", fontWeight: 800, color: C.purple, lineHeight: 1 }}>{profile.votesAnalyzed}</div>
        <div style={{ color: C.faint, fontSize: "0.65rem", fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase" as const }}>total votes</div>
      </div>
    </div>
  );
}

// ── Insight cards ─────────────────────────────────────────────────────────────

function InsightCards({ insights }: { insights: ReturnType<typeof generateInsights> }) {
  if (insights.length === 0) return null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${insights.length}, 1fr)`, gap: "0.6rem" }}>
      {insights.map((ins, i) => (
        <div key={i} style={{
          background: ins.color + "0c", border: `1px solid ${ins.color}33`,
          borderRadius: "9px", padding: "0.7rem 0.85rem",
          display: "flex", alignItems: "flex-start", gap: "0.5rem",
        }}>
          <span style={{ fontSize: "1rem", flexShrink: 0, marginTop: "0.05rem" }}>{ins.icon}</span>
          <p style={{ color: C.muted, fontSize: "0.76rem", lineHeight: 1.45, margin: 0 }}>
            {ins.text}
          </p>
        </div>
      ))}
    </div>
  );
}

// ── Rich Author Card ──────────────────────────────────────────────────────────

function AuthorCard({ rule, openPost, voteUsd, dnaData }: {
  rule: StrategyRuleLite;
  openPost: PostOpportunity | undefined;
  voteUsd: number;
  dnaData: DnaAuthor | undefined;
}) {
  const cat     = CAT[rule.category] ?? { color: C.dim, icon: "⚪", label: rule.category };
  const estUsd  = Math.round(rule.maxWeightPct / 100 * voteUsd * 10000) / 10000;
  const initial = rule.username[0]?.toUpperCase() ?? "?";
  const hasOpp  = !!openPost;

  // Relationship narrative
  const relationship = (() => {
    if (!dnaData) return null;
    if (dnaData.voteCount >= 10) return `${dnaData.voteCount} votes · ${dnaData.sharePct}% of your curation`;
    if (dnaData.voteCount >= 3)  return `${dnaData.voteCount} votes · ${dnaData.avgWeightPct}% avg weight`;
    if (dnaData.voteCount >= 1)  return `${dnaData.voteCount} vote in history`;
    return null;
  })();

  const convictionLabel = dnaData && dnaData.avgWeightPct >= 80 ? "high conviction"
    : dnaData && dnaData.avgWeightPct >= 50 ? "solid"
    : null;

  return (
    <div style={{
      background: hasOpp ? cat.color + "08" : C.bg2,
      border: `1px solid ${hasOpp ? cat.color + "55" : C.border}`,
      borderRadius: "10px", padding: "0.7rem 0.85rem",
      display: "flex", alignItems: "flex-start", gap: "0.6rem",
    }}>
      {/* Avatar */}
      <div style={{
        width: "34px", height: "34px", borderRadius: "50%", flexShrink: 0,
        background: cat.color + "25", border: `2px solid ${cat.color}55`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "0.85rem", fontWeight: 800, color: cat.color,
      }}>{initial}</div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.3rem", marginBottom: "0.15rem", flexWrap: "wrap" }}>
          <span style={{ color: C.info, fontWeight: 700, fontSize: "0.8rem" }}>@{rule.username}</span>
          <span style={{ background: cat.color + "1a", color: cat.color, border: `1px solid ${cat.color}33`, borderRadius: "4px", padding: "0 0.3rem", fontSize: "0.62rem", fontWeight: 700 }}>
            {cat.icon} {cat.label}
          </span>
          {hasOpp && (
            <span style={{ background: cat.color + "22", color: cat.color, borderRadius: "10px", padding: "0 0.35rem", fontSize: "0.62rem", fontWeight: 700, animation: "pulse 2s infinite" }}>
              ⚡ new post
            </span>
          )}
        </div>

        {/* Weight line */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.72rem", marginBottom: relationship ? "0.2rem" : 0 }}>
          <span style={{ color: cat.color, fontWeight: 700 }}>{rule.maxWeightPct}%</span>
          <span style={{ color: C.faint }}>→</span>
          <span style={{ color: C.ok }}>{fmtUsd(estUsd)} per vote</span>
          {convictionLabel && <span style={{ color: C.faint }}>· {convictionLabel}</span>}
        </div>

        {/* Relationship */}
        {relationship && (
          <p style={{ color: C.faint, fontSize: "0.69rem", margin: "0.1rem 0 0" }}>{relationship}</p>
        )}

        {/* Open post */}
        {openPost && (
          <div style={{ marginTop: "0.3rem", background: cat.color + "12", borderRadius: "5px", padding: "0.25rem 0.4rem", fontSize: "0.69rem" }}>
            <span style={{ color: cat.color, fontWeight: 600 }}>{fmtMin(openPost.ageMinutes)} ago</span>
            <span style={{ color: C.faint }}> · </span>
            <span style={{ color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, display: "inline-block", maxWidth: "140px", verticalAlign: "bottom" }}>
              "{openPost.title.slice(0, 35)}{openPost.title.length > 35 ? "…" : ""}"
            </span>
            {openPost.postScore >= 80 && <span style={{ color: C.ok, marginLeft: "0.3rem" }}>⭐ best window</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Activity Feed with context ────────────────────────────────────────────────

function ActivityFeed({ votes, opps, voteUsd, dnaAuthors, onAction }: {
  votes: RecentVote[];
  opps: PostOpportunity[] | null;
  voteUsd: number;
  dnaAuthors: DnaAuthor[];
  onAction: { plan: () => void; opps: () => void; dna: () => void };
}) {
  const dnaMap = new Map(dnaAuthors.map(a => [a.username, a]));
  const eligible = opps?.filter(p => p.eligible) ?? [];

  if (votes.length === 0 && eligible.length === 0) {
    return (
      <div style={{ padding: "0.5rem 0" }}>
        <div style={{ textAlign: "center", padding: "0.75rem 0 1rem" }}>
          <div style={{ fontSize: "1.8rem", marginBottom: "0.35rem" }}>🌱</div>
          <p style={{ color: C.muted, fontSize: "0.82rem", fontWeight: 600, margin: "0 0 0.2rem" }}>Your curation story starts here</p>
          <p style={{ color: C.faint, fontSize: "0.73rem", margin: "0 0 1rem", lineHeight: 1.5 }}>
            Every vote you cast builds relationships on the blockchain — permanently recorded, transparently visible.
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.35rem" }}>
          {[
            { icon: "⚡", label: "Find posts to vote now", sub: "Check which strategy authors posted recently", col: C.warn, fn: onAction.opps },
            { icon: "🗳",  label: "Generate a vote plan",  sub: "VoteBroker picks the best posts for you",        col: C.purple, fn: onAction.plan },
            { icon: "🧬", label: "Deepen your strategy",  sub: "Analyze your Vote-DNA and refine priorities",     col: C.info, fn: onAction.dna },
          ].map(a => (
            <button key={a.label} type="button" onClick={a.fn} style={{
              background: a.col + "10", border: `1px solid ${a.col}33`, borderRadius: "7px",
              color: a.col, cursor: "pointer", fontSize: "0.78rem", padding: "0.5rem 0.75rem",
              textAlign: "left" as const, display: "flex", alignItems: "center", gap: "0.5rem",
            }}>
              <span style={{ fontSize: "1rem" }}>{a.icon}</span>
              <div>
                <div style={{ fontWeight: 600 }}>{a.label}</div>
                <div style={{ color: C.faint, fontSize: "0.68rem" }}>{a.sub}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const items: Array<{ type: "vote" | "opp"; author: string; detail: string; context: string; time: string; usd?: number; col: string }> = [];

  votes.slice(0, 7).forEach(v => {
    const dna = dnaMap.get(v.author);
    const usd = Math.round(v.weightPct / 100 * voteUsd * 10000) / 10000;
    const ctx = dna
      ? dna.sharePct > 8 ? `Your #${dnaAuthors.findIndex(a => a.username === v.author) + 1} curated author`
        : dna.voteCount > 5 ? `${dna.voteCount} votes in history`
        : "First vote for this author"
      : "";
    items.push({ type: "vote", author: v.author, detail: `${v.weightPct}% vote`, context: ctx, time: fmtAgeIso(v.votedAt), usd, col: C.ok });
  });

  eligible.slice(0, 3).forEach(p => {
    const window = p.postScore >= 80 ? "optimal window" : p.postScore >= 50 ? "good window" : "late window";
    items.push({ type: "opp", author: p.author, detail: `new post · ${fmtMin(p.ageMinutes)}`, context: window, time: "open", col: C.warn });
  });

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: 0 }}>
      {items.map((item, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "center", gap: "0.65rem",
          padding: "0.55rem 0", borderBottom: i < items.length - 1 ? `1px solid #12171e` : "none",
        }}>
          <div style={{
            width: "30px", height: "30px", borderRadius: "50%", flexShrink: 0,
            background: item.col + "1a", border: `1.5px solid ${item.col}44`,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.82rem",
          }}>
            {item.type === "vote" ? "✓" : "⚡"}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.3rem", flexWrap: "wrap" }}>
              <span style={{ color: C.info, fontWeight: 600, fontSize: "0.79rem" }}>@{item.author}</span>
              <span style={{ color: C.faint, fontSize: "0.7rem" }}>· {item.detail}</span>
            </div>
            {item.context && <p style={{ color: C.faint, fontSize: "0.68rem", margin: "0.05rem 0 0" }}>{item.context}</p>}
          </div>
          <div style={{ display: "flex", flexDirection: "column" as const, alignItems: "flex-end", flexShrink: 0 }}>
            {item.usd ? <span style={{ color: item.col, fontWeight: 700, fontSize: "0.78rem" }}>+{fmtUsd(item.usd)}</span> : null}
            <span style={{ color: C.faint, fontSize: "0.65rem" }}>{item.time}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── VP Projection ─────────────────────────────────────────────────────────────

function VpProjection({ vpPct, votesPerDay, avgWeight }: { vpPct: number; votesPerDay: number; avgWeight: number }) {
  const spend = votesPerDay * avgWeight / 100;
  const net   = 20 - spend; // regen 20%/day
  const days  = Array.from({ length: 8 }, (_, i) => Math.max(0, Math.min(100, vpPct + net * i)));
  const maxV  = Math.max(...days, 1);
  const minV  = Math.min(...days, 0);
  const endCol = vpCol(days[7]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: "3px", height: "44px" }}>
        {days.map((v, i) => (
          <div key={i} title={`+${i}d: ${v.toFixed(0)}%`} style={{
            flex: 1, height: `${Math.max(5, ((v - minV) / (maxV - minV || 1)) * 40 + 4)}px`,
            background: vpCol(v) + (i === 0 ? "ff" : "77"),
            borderRadius: "2px 2px 0 0", alignSelf: "flex-end",
          }} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "3px", fontSize: "0.63rem", color: C.faint }}>
        <span>Now: {vpPct.toFixed(0)}%</span>
        <span style={{ color: endCol, fontWeight: 600 }}>7d: {days[7].toFixed(0)}%{net >= 0 ? " ↗" : " ↘"}</span>
      </div>
    </div>
  );
}

// ── Category donut ────────────────────────────────────────────────────────────

function CategoryDonut({ rules }: { rules: StrategyRuleLite[] }) {
  const total = rules.length || 1;
  const cats  = Object.keys(CAT).filter(c => rules.some(r => r.category === c));
  const cx = 44, cy = 44, r = 34, sw = 14;
  let angle = -90;

  const slices = cats.map(c => {
    const n    = rules.filter(r => r.category === c).length;
    const pct  = n / total;
    const deg  = pct * 360;
    function pp(d: number) {
      const rad = (d - 90) * Math.PI / 180;
      return { x: (cx + r * Math.cos(rad)).toFixed(1), y: (cy + r * Math.sin(rad)).toFixed(1) };
    }
    const s = pp(angle), e = pp(angle + deg);
    const d = `M ${s.x} ${s.y} A ${r} ${r} 0 ${deg > 180 ? 1 : 0} 1 ${e.x} ${e.y}`;
    angle += deg;
    return { c, n, d, pct };
  }).filter(s => s.n > 0);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.85rem" }}>
      <svg width={88} height={88} viewBox="0 0 88 88" style={{ flexShrink: 0 }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1a2030" strokeWidth={sw}/>
        {slices.map(s => (
          <path key={s.c} d={s.d} fill="none" stroke={CAT[s.c].color} strokeWidth={sw} strokeLinecap="butt"/>
        ))}
        <text x={cx} y={cy+5} textAnchor="middle" fill={C.text} fontSize="14" fontWeight="700">{rules.length}</text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.22rem" }}>
        {slices.map(s => (
          <div key={s.c} style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.72rem" }}>
            <div style={{ width: "8px", height: "8px", borderRadius: "2px", background: CAT[s.c].color, flexShrink: 0 }}/>
            <span style={{ color: C.muted, minWidth: "58px" }}>{CAT[s.c].label}</span>
            <span style={{ color: C.text, fontWeight: 700 }}>{s.n}</span>
            <span style={{ color: C.faint }}>({Math.round(s.pct * 100)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Session bar chart ─────────────────────────────────────────────────────────

function SessionBars({ votes, voteUsd }: { votes: RecentVote[]; voteUsd: number }) {
  if (votes.length === 0) return (
    <div style={{ textAlign: "center", padding: "0.75rem 0", color: C.faint, fontSize: "0.77rem" }}>
      No votes yet this session
    </div>
  );
  const max = Math.max(...votes.map(v => v.weightPct), 1);
  const total = votes.reduce((s, v) => s + v.weightPct / 100 * voteUsd, 0);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: "3px", height: "44px" }}>
        {votes.slice(-12).map((v, i) => (
          <div key={i} title={`@${v.author}: ${v.weightPct}%`} style={{
            flex: 1, height: `${Math.max(5, (v.weightPct / max) * 40)}px`,
            background: C.ok + "88", borderRadius: "2px 2px 0 0", alignSelf: "flex-end",
          }}/>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "3px", fontSize: "0.63rem", color: C.faint }}>
        <span>{votes.length} votes</span>
        <span style={{ color: C.ok, fontWeight: 600 }}>+{fmtUsd(total)} impact</span>
      </div>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

export function UserDashboard(props: {
  session: AuthSession;
  snapshot: SteemAccountSnapshot | null;
  snapshotLoading: boolean;
  strategyRules: StrategyRuleLite[] | null;
  opportunities: PostOpportunity[] | null;
  opportunitiesLoading: boolean;
  votePlan: VotePlanResponse | null;
  curationProfile: CurationProfile | null;
  recentVotes: RecentVote[];
  onTabChange: (tab: "dna" | "dashboard" | "community" | "billing") => void;
  onGenerateVotes: () => void;
  onLoadOpportunities: () => void;
}) {
  const { snapshot, strategyRules, opportunities, votePlan, curationProfile, recentVotes } = props;

  const vpPct      = snapshot ? snapshot.votingPowerBps / 100 : null;
  const rules      = sortRules(strategyRules ?? []);
  const openOpps   = opportunities?.filter(p => p.eligible) ?? [];
  const oppMap     = new Map(openOpps.map(p => [p.author, p]));
  const dnaAuthors = curationProfile?.topAuthors ?? [];
  const dnaMap     = new Map(dnaAuthors.map(a => [a.username, a]));

  const avgWeight  = rules.length > 0 ? rules.reduce((s, r) => s + r.maxWeightPct, 0) / rules.length : 0;
  const sessionUsd = recentVotes.reduce((s, v) => s + v.weightPct / 100 * (snapshot?.currentVoteUsd ?? 0), 0);

  const insights = generateInsights(curationProfile, rules, openOpps, vpPct, snapshot);

  const setupSteps = [
    { done: true,                             label: "Connect SteemConnect",     sub: `Logged in as @${props.session.user.username}`, cta: "" },
    { done: !!curationProfile,                label: "Analyze your Vote-DNA",   sub: "Discover your curation patterns",               cta: "Analyze", onClick: () => props.onTabChange("dna") },
    { done: rules.length > 0,                 label: "Build your strategy",     sub: "Choose authors and vote weights",                cta: "Build",   onClick: () => props.onTabChange("dna") },
    { done: opportunities !== null,           label: "Find open opportunities", sub: "See which strategy authors posted recently",    cta: "Check",   onClick: props.onLoadOpportunities },
    { done: recentVotes.length > 0,           label: "Execute your first vote", sub: "Support your community on-chain",               cta: "Vote",    onClick: () => { props.onTabChange("dna"); props.onGenerateVotes(); } },
  ];
  const setupDone = setupSteps.every(s => s.done);

  return (
    <div style={{ padding: "1rem 1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}>

      {/* ── Curation identity banner ───────────────────────────── */}
      {curationProfile && (
        <CurationIdentityBanner profile={curationProfile} snapshot={snapshot} />
      )}

      {/* ── Auto-insights ─────────────────────────────────────── */}
      {insights.length > 0 && <InsightCards insights={insights} />}

      {/* ── Hero: VP + Impact grid ────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "1rem", alignItems: "stretch" }}>

        {/* VP Gauge */}
        <div style={{ background: `linear-gradient(145deg, ${C.bg2}, ${C.bg1})`, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "1rem 1.25rem", display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", minWidth: "175px" }}>
          {vpPct !== null ? (
            <>
              <VpGauge pct={vpPct} size={160}/>
              {snapshot && (
                <p style={{ fontSize: "0.72rem", color: C.muted, textAlign: "center", margin: "0.4rem 0 0" }}>
                  <span style={{ color: C.info, fontWeight: 600 }}>{snapshot.steemPowerSp.toFixed(0)} SP</span>
                  <span style={{ color: C.faint }}> · full vote = </span>
                  <span style={{ color: C.ok, fontWeight: 600 }}>{fmtUsd(snapshot.fullPowerVoteUsd)}</span>
                </p>
              )}
            </>
          ) : (
            <div style={{ color: C.faint, padding: "2rem" }}>{props.snapshotLoading ? "Loading…" : "—"}</div>
          )}
        </div>

        {/* KPI grid — emotional labels */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gridTemplateRows: "1fr 1fr", gap: "0.6rem" }}>
          {[
            {
              label: "Vote Value Now",
              value: snapshot ? fmtUsd(snapshot.currentVoteUsd) : "—",
              sub: vpPct && vpPct < 80 ? "⚠ VP recovering" : "at current voting power",
              color: vpPct ? vpCol(vpPct) : C.dim, big: true,
            },
            {
              label: "Open Opportunities",
              value: openOpps.length > 0 ? `${openOpps.length}` : opportunities === null ? "—" : "0",
              sub: openOpps.length > 0 ? `${openOpps.filter(p => p.postScore >= 80).length} in optimal window` : opportunities === null ? "tap to discover" : "all caught up ✓",
              color: openOpps.length > 0 ? C.warn : C.ok, big: true,
              onClick: () => { props.onLoadOpportunities(); props.onTabChange("dna"); },
            },
            {
              label: "Authors You Support",
              value: rules.length > 0 ? rules.length : "—",
              sub: rules.length > 0 ? `${new Set(rules.map(r => r.category)).size} categories · ${fmtUsd(avgWeight / 100 * (snapshot?.currentVoteUsd ?? 0))} avg/vote` : "build your strategy",
              color: C.info, big: true,
              onClick: () => props.onTabChange("dna"),
            },
            {
              label: "Session Impact",
              value: recentVotes.length > 0 ? fmtUsd(sessionUsd) : "—",
              sub: recentVotes.length > 0 ? `${recentVotes.length} votes cast today` : "no votes yet",
              color: C.ok,
            },
            {
              label: "Monthly Estimate",
              value: curationProfile && snapshot ? fmtUsd(curationProfile.votesPerDay * 30 * snapshot.currentVoteUsd * avgWeight / 100) : "—",
              sub: curationProfile ? `≈ ${curationProfile.votesPerDay}/day at ${avgWeight.toFixed(0)}% avg` : "analyze Vote-DNA",
              color: C.purple,
            },
            {
              label: "Plan Ready",
              value: votePlan?.plan.length ?? "—",
              sub: votePlan ? `${votePlan.summary.estimatedVpSpendPct}% VP · ${votePlan.summary.sustainability}` : "generate vote plan",
              color: C.purple,
              onClick: () => props.onTabChange("dna"),
            },
          ].map((k, i) => (
            <div key={i} onClick={k.onClick} style={{
              background: C.bg2, border: `1px solid ${C.border}`, borderRadius: "10px",
              padding: "0.75rem 1rem", cursor: k.onClick ? "pointer" : "default",
            }}>
              <p style={{ color: C.dim, fontSize: "0.65rem", textTransform: "uppercase" as const, letterSpacing: "0.5px", fontWeight: 600, margin: "0 0 0.2rem" }}>{k.label}</p>
              <div style={{ color: k.color, fontSize: k.big ? "1.55rem" : "1.35rem", fontWeight: 800, lineHeight: 1, marginBottom: "0.2rem" }}>{k.value}</div>
              <p style={{ color: C.faint, fontSize: "0.68rem", margin: 0 }}>{k.sub}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Authors + Activity ─────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1.55fr 1fr", gap: "1rem" }}>

        {/* Authors */}
        <div style={{ background: `linear-gradient(180deg, ${C.bg2}, ${C.bg1})`, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "1rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.65rem" }}>
            <div>
              <p style={{ color: C.dim, fontSize: "0.65rem", textTransform: "uppercase" as const, letterSpacing: "0.5px", fontWeight: 600, margin: "0 0 0.1rem" }}>Curated Authors</p>
              {openOpps.length > 0 && (
                <p style={{ color: C.warn, fontSize: "0.72rem", margin: 0, fontWeight: 600 }}>
                  ⚡ {openOpps.length} {openOpps.length === 1 ? "author has a" : "authors have"} new post{openOpps.length > 1 ? "s" : ""}
                </p>
              )}
            </div>
            <button type="button" onClick={() => props.onTabChange("dna")} style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: "5px", color: C.muted, cursor: "pointer", fontSize: "0.71rem", padding: "0.2rem 0.5rem" }}>
              Edit →
            </button>
          </div>

          {rules.length === 0 ? (
            <div style={{ textAlign: "center", padding: "1.5rem 0" }}>
              <div style={{ fontSize: "1.8rem", marginBottom: "0.4rem" }}>🧬</div>
              <p style={{ color: C.muted, fontSize: "0.82rem", margin: "0 0 0.4rem" }}>Your curation community awaits</p>
              <p style={{ color: C.faint, fontSize: "0.73rem", margin: "0 0 0.75rem", lineHeight: 1.5 }}>
                Analyze your voting history and VoteBroker will automatically suggest authors to include in your strategy.
              </p>
              <button type="button" onClick={() => props.onTabChange("dna")} style={{ background: C.info + "22", border: `1px solid ${C.info}`, borderRadius: "6px", color: C.info, cursor: "pointer", fontSize: "0.77rem", padding: "0.35rem 0.85rem", fontWeight: 600 }}>
                Analyze Vote-DNA →
              </button>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.45rem" }}>
              {rules.slice(0, 10).map(r => (
                <AuthorCard
                  key={r.username} rule={r}
                  openPost={oppMap.get(r.username)}
                  voteUsd={snapshot?.currentVoteUsd ?? 0}
                  dnaData={dnaMap.get(r.username)}
                />
              ))}
              {rules.length > 10 && (
                <div style={{ gridColumn: "1/-1", color: C.faint, fontSize: "0.71rem", textAlign: "center", paddingTop: "0.2rem" }}>
                  +{rules.length - 10} more in strategy
                </div>
              )}
            </div>
          )}
        </div>

        {/* Activity + Setup */}
        <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.75rem" }}>
          <div style={{ background: `linear-gradient(180deg, ${C.bg2}, ${C.bg1})`, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "1rem", flex: 1 }}>
            <p style={{ color: C.dim, fontSize: "0.65rem", textTransform: "uppercase" as const, letterSpacing: "0.5px", fontWeight: 600, margin: "0 0 0.6rem" }}>Activity</p>
            <ActivityFeed
              votes={recentVotes} opps={opportunities} voteUsd={snapshot?.currentVoteUsd ?? 0}
              dnaAuthors={dnaAuthors}
              onAction={{ plan: () => { props.onTabChange("dna"); props.onGenerateVotes(); }, opps: props.onLoadOpportunities, dna: () => props.onTabChange("dna") }}
            />
          </div>

          {!setupDone && (
            <div style={{ background: `linear-gradient(180deg, ${C.bg2}, ${C.bg1})`, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "1rem" }}>
              <p style={{ color: C.dim, fontSize: "0.65rem", textTransform: "uppercase" as const, letterSpacing: "0.5px", fontWeight: 600, margin: "0 0 0.5rem" }}>
                Getting started
              </p>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.35rem" }}>
                {setupSteps.map((s, i) => {
                  const next = setupSteps.findIndex(x => !x.done);
                  const active = i === next;
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.45rem 0.65rem", background: active ? C.info + "0d" : "transparent", border: `1px solid ${active ? C.info + "33" : s.done ? C.ok + "18" : C.border}`, borderRadius: "7px", opacity: i > next + 1 ? 0.45 : 1 }}>
                      <div style={{ width: "22px", height: "22px", borderRadius: "50%", flexShrink: 0, background: s.done ? C.ok + "1a" : active ? C.info + "1a" : C.bg3, border: `1.5px solid ${s.done ? C.ok : active ? C.info : C.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.7rem", fontWeight: 700, color: s.done ? C.ok : active ? C.info : C.faint }}>
                        {s.done ? "✓" : i + 1}
                      </div>
                      <div style={{ flex: 1 }}>
                        <p style={{ color: s.done ? C.muted : C.text, fontSize: "0.76rem", fontWeight: 600, margin: 0, textDecoration: s.done ? "line-through" : "none" }}>{s.label}</p>
                        <p style={{ color: C.faint, fontSize: "0.67rem", margin: 0 }}>{s.sub}</p>
                      </div>
                      {active && s.onClick && (
                        <button type="button" onClick={s.onClick} style={{ background: C.info + "1a", border: `1px solid ${C.info}`, borderRadius: "4px", color: C.info, cursor: "pointer", fontSize: "0.7rem", padding: "0.15rem 0.5rem", fontWeight: 600, flexShrink: 0 }}>{s.cta}</button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Analytics row ─────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1rem" }}>
        <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "1rem" }}>
          <p style={{ color: C.dim, fontSize: "0.65rem", textTransform: "uppercase" as const, letterSpacing: "0.5px", fontWeight: 600, margin: "0 0 0.6rem" }}>Strategy Mix</p>
          {rules.length > 0 ? <CategoryDonut rules={rules}/> : <p style={{ color: C.faint, fontSize: "0.77rem" }}>No strategy yet</p>}
        </div>
        <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "1rem" }}>
          <p style={{ color: C.dim, fontSize: "0.65rem", textTransform: "uppercase" as const, letterSpacing: "0.5px", fontWeight: 600, margin: "0 0 0.6rem" }}>VP Projection — 7 days</p>
          {vpPct !== null && curationProfile
            ? <VpProjection vpPct={vpPct} votesPerDay={curationProfile.votesPerDay} avgWeight={avgWeight}/>
            : <p style={{ color: C.faint, fontSize: "0.77rem" }}>Analyze Vote-DNA to see projection</p>}
        </div>
        <div style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "1rem" }}>
          <p style={{ color: C.dim, fontSize: "0.65rem", textTransform: "uppercase" as const, letterSpacing: "0.5px", fontWeight: 600, margin: "0 0 0.6rem" }}>Session Votes</p>
          <SessionBars votes={recentVotes} voteUsd={snapshot?.currentVoteUsd ?? 0}/>
        </div>
      </div>

      {/* ── Actions ───────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.6rem" }}>
        {[
          { icon: "🧬", label: "Vote-DNA",      sub: "Analyze & build strategy",  color: C.info,   fn: () => props.onTabChange("dna") },
          { icon: "🗳",  label: "Vote Plan",     sub: "Generate optimized plan",   color: C.purple, fn: () => { props.onTabChange("dna"); props.onGenerateVotes(); } },
          { icon: "⚡",  label: "Opportunities", sub: openOpps.length > 0 ? `${openOpps.length} posts open now` : "Find posts to vote", color: openOpps.length > 0 ? C.warn : C.faint, fn: () => { props.onLoadOpportunities(); props.onTabChange("dna"); } },
          { icon: "⚙",  label: "Settings",      sub: "Manage permissions",        color: C.ok,     fn: () => props.onTabChange("billing") },
        ].map(a => (
          <button key={a.label} type="button" onClick={a.fn} style={{
            background: a.color + "0d", border: `1px solid ${a.color}2a`, borderRadius: "10px",
            padding: "0.9rem 0.85rem", cursor: "pointer", textAlign: "left" as const,
            display: "flex", flexDirection: "column" as const, gap: "0.25rem",
          }}>
            <span style={{ fontSize: "1.1rem" }}>{a.icon}</span>
            <span style={{ color: C.text, fontSize: "0.82rem", fontWeight: 700 }}>{a.label}</span>
            <span style={{ color: C.muted, fontSize: "0.7rem" }}>{a.sub}</span>
          </button>
        ))}
      </div>

    </div>
  );
}
