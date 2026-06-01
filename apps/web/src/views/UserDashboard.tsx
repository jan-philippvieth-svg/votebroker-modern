import { useEffect, useRef, useState } from "react";
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

// ── Design tokens ─────────────────────────────────────────────────────────────

const C = {
  ok:     "#3fb950",
  warn:   "#f0a500",
  err:    "#f85149",
  info:   "#58a6ff",
  purple: "#a371f7",
  fire:   "#ff6b35",
  dim:    "#8b949e",
  bg0:    "#080c10",
  bg1:    "#0d1117",
  bg2:    "#161b22",
  bg3:    "#1c2128",
  border: "#21262d",
  border2:"#30363d",
  text:   "#e6edf3",
  muted:  "#8b949e",
  faint:  "#484f58",
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

// ── VP Arc Gauge — definitively fixed ─────────────────────────────────────────
// Arc: 225° → 135° (270° clockwise sweep, gap at bottom)
// Max y of arc = cy + r×sin(135°) = cy + r×0.707
// SVG height = 200, cy = 90, r = 78 → max arc y = 90 + 55.1 = 145.1 + stroke/2=7.5 = 152.6
// SP text at y=167, vote text at y=183 — well below arc, no overlap possible.

function VpGauge({ pct, sp, voteUsd }: { pct: number; sp?: number; voteUsd?: number }) {
  const W = 220, H = 200;
  const cx = W / 2, cy = 90, r = 78, sw = 15;
  const col = vpCol(pct);
  const START = 225, SPAN = 270;
  const valDeg = START + (pct / 100) * SPAN;

  function pt(deg: number, radius = r): [number, number] {
    const rad = (deg - 90) * Math.PI / 180;
    return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
  }
  function arc(from: number, to: number) {
    const [sx, sy] = pt(from);
    const [ex, ey] = pt(to);
    const large = ((to - from + 360) % 360) > 180 ? 1 : 0;
    return `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
  }

  const [tx, ty] = pt(valDeg);
  const regenH = pct >= 99.9 ? 0 : (100 - pct) / 20 * 24;
  const regenLabel = regenH === 0 ? "fully charged"
    : regenH < 1 ? `${Math.round(regenH * 60)}m to full`
    : `${regenH.toFixed(1)}h to full`;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <defs>
        <filter id="vglow2">
          <feGaussianBlur stdDeviation="4" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>

      {/* Background track */}
      <path d={arc(START, START + SPAN)} fill="none" stroke="#111820" strokeWidth={sw} strokeLinecap="round"/>

      {/* Tick marks at 25 / 50 / 75 % */}
      {[25, 50, 75].map(v => {
        const d = START + (v / 100) * SPAN;
        const [ix, iy] = pt(d, r - sw * 0.55);
        const [ox, oy] = pt(d, r + sw * 0.55);
        return <line key={v} x1={ix.toFixed(1)} y1={iy.toFixed(1)} x2={ox.toFixed(1)} y2={oy.toFixed(1)} stroke="#2a3140" strokeWidth="2"/>;
      })}

      {/* Filled arc */}
      <path d={arc(START, valDeg)} fill="none" stroke={col} strokeWidth={sw} strokeLinecap="round" filter="url(#vglow2)"/>

      {/* Dot at current value */}
      <circle cx={tx.toFixed(2)} cy={ty.toFixed(2)} r={sw * 0.65} fill={col} filter="url(#vglow2)"/>

      {/* Central percentage — large, bold */}
      <text x={cx} y={cy - 4} textAnchor="middle" fill={col} fontSize="44" fontWeight="900" fontFamily="inherit">{pct.toFixed(1)}%</text>
      <text x={cx} y={cy + 20} textAnchor="middle" fill={C.dim} fontSize="11" letterSpacing="2.5" fontWeight="600">VOTING POWER</text>
      <text x={cx} y={cy + 36} textAnchor="middle" fill={C.faint} fontSize="11">{regenLabel}</text>

      {/* SP + vote value below the arc gap — cannot overlap arc (max arc y = 152.6) */}
      {sp !== undefined && voteUsd !== undefined && (
        <>
          <text x={cx} y="167" textAnchor="middle" fill={C.info} fontSize="13" fontWeight="700">{sp.toFixed(0)} SP</text>
          <text x={cx} y="183" textAnchor="middle" fill={C.faint} fontSize="11">full vote ≈ {fmtUsd(voteUsd)}</text>
        </>
      )}
    </svg>
  );
}

// ── KPI Tile — large number with label ────────────────────────────────────────

function KpiTile({ label, value, sub, color, onClick, glow }: {
  label: string; value: string | number; sub: string;
  color: string; onClick?: () => void; glow?: boolean;
}) {
  return (
    <div onClick={onClick} style={{
      background: `linear-gradient(160deg, ${C.bg2} 0%, ${C.bg1} 100%)`,
      border: `1px solid ${glow ? color + "55" : C.border}`,
      borderRadius: "14px",
      padding: "1.4rem 1.6rem",
      flex: "1 1 0",
      minWidth: "150px",
      cursor: onClick ? "pointer" : "default",
      display: "flex", flexDirection: "column" as const, justifyContent: "space-between",
      gap: "0.5rem",
      boxShadow: glow ? `0 0 24px ${color}22, inset 0 1px 0 ${color}18` : "none",
      transition: "border-color 0.25s, box-shadow 0.25s",
    }}>
      <span style={{ color: C.dim, fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.9px" }}>{label}</span>
      <div style={{ color, fontSize: "2.8rem", fontWeight: 900, lineHeight: 1, letterSpacing: "-1px" }}>{value}</div>
      <span style={{ color: C.muted, fontSize: "0.8rem", lineHeight: 1.35 }}>{sub}</span>
    </div>
  );
}

// ── Author card ────────────────────────────────────────────────────────────────

function AuthorCard({ rule, openPost, voteUsd, dnaData }: {
  rule: StrategyRuleLite; openPost: PostOpportunity | undefined;
  voteUsd: number; dnaData: DnaAuthor | undefined;
}) {
  const cat    = CAT[rule.category] ?? { color: C.dim, icon: "⚪", label: rule.category };
  const estUsd = Math.round(rule.maxWeightPct / 100 * voteUsd * 10000) / 10000;
  const initial = rule.username[0]?.toUpperCase() ?? "?";
  const hasOpp  = !!openPost;

  const relationship = (() => {
    if (!dnaData) return null;
    if (dnaData.voteCount >= 10) return `${dnaData.voteCount} votes · ${dnaData.sharePct}% of your curation`;
    if (dnaData.voteCount >= 3)  return `${dnaData.voteCount} votes · ${dnaData.avgWeightPct}% avg`;
    if (dnaData.voteCount >= 1)  return `${dnaData.voteCount} vote in history`;
    return null;
  })();

  return (
    <div style={{
      background: hasOpp ? cat.color + "0a" : C.bg3,
      border: `1px solid ${hasOpp ? cat.color + "55" : C.border}`,
      borderRadius: "10px", padding: "0.85rem 1rem",
      display: "flex", alignItems: "flex-start", gap: "0.75rem",
    }}>
      <div style={{
        width: "38px", height: "38px", borderRadius: "50%", flexShrink: 0,
        background: cat.color + "22", border: `2px solid ${cat.color}55`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "0.95rem", fontWeight: 800, color: cat.color,
      }}>{initial}</div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.2rem", flexWrap: "wrap" as const }}>
          <span style={{ color: C.info, fontWeight: 700, fontSize: "0.85rem" }}>@{rule.username}</span>
          <span style={{ background: cat.color + "1a", color: cat.color, border: `1px solid ${cat.color}33`, borderRadius: "4px", padding: "0 0.35rem", fontSize: "0.65rem", fontWeight: 700 }}>
            {cat.icon} {cat.label}
          </span>
          {hasOpp && (
            <span style={{ background: cat.color + "22", color: cat.color, borderRadius: "10px", padding: "0.05rem 0.4rem", fontSize: "0.65rem", fontWeight: 700 }}>
              ⚡ new post
            </span>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.78rem", marginBottom: relationship ? "0.2rem" : 0 }}>
          <span style={{ color: cat.color, fontWeight: 700 }}>{rule.maxWeightPct}%</span>
          <span style={{ color: C.faint }}>·</span>
          <span style={{ color: C.ok }}>{fmtUsd(estUsd)}/vote</span>
        </div>

        {relationship && <p style={{ color: C.faint, fontSize: "0.73rem", margin: 0 }}>{relationship}</p>}

        {openPost && (
          <div style={{ marginTop: "0.35rem", background: cat.color + "14", borderRadius: "5px", padding: "0.25rem 0.5rem", fontSize: "0.73rem" }}>
            <span style={{ color: cat.color, fontWeight: 600 }}>{fmtMin(openPost.ageMinutes)} ago</span>
            <span style={{ color: C.faint }}> · </span>
            <span style={{ color: C.muted }}>"{openPost.title.slice(0, 40)}{openPost.title.length > 40 ? "…" : ""}"</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Activity feed ─────────────────────────────────────────────────────────────

function ActivityFeed({ votes, opps, voteUsd, dnaAuthors, onAction }: {
  votes: RecentVote[]; opps: PostOpportunity[] | null;
  voteUsd: number; dnaAuthors: DnaAuthor[];
  onAction: { plan: () => void; opps: () => void; dna: () => void };
}) {
  const dnaMap  = new Map(dnaAuthors.map(a => [a.username, a]));
  const eligible = opps?.filter(p => p.eligible) ?? [];

  if (votes.length === 0 && eligible.length === 0) {
    return (
      <div style={{ padding: "0.5rem 0" }}>
        <div style={{ textAlign: "center", padding: "1rem 0 1.25rem" }}>
          <div style={{ fontSize: "2rem", marginBottom: "0.4rem" }}>🌱</div>
          <p style={{ color: C.muted, fontSize: "0.88rem", fontWeight: 600, margin: "0 0 0.2rem" }}>Your curation story starts here</p>
          <p style={{ color: C.faint, fontSize: "0.78rem", margin: "0 0 1rem", lineHeight: 1.5 }}>
            Every vote you cast builds relationships on the blockchain — permanently recorded.
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.4rem" }}>
          {[
            { icon: "⚡", label: "Find posts to vote now", sub: "Check which strategy authors posted recently", col: C.warn, fn: onAction.opps },
            { icon: "🗳",  label: "Generate a vote plan",  sub: "VoteBroker picks the best posts for you",      col: C.purple, fn: onAction.plan },
            { icon: "🧬", label: "Deepen your strategy",  sub: "Analyze your Vote-DNA and refine priorities",   col: C.info, fn: onAction.dna },
          ].map(a => (
            <button key={a.label} type="button" onClick={a.fn} style={{
              background: a.col + "10", border: `1px solid ${a.col}33`, borderRadius: "8px",
              color: a.col, cursor: "pointer", fontSize: "0.82rem", padding: "0.6rem 0.85rem",
              textAlign: "left" as const, display: "flex", alignItems: "center", gap: "0.6rem",
            }}>
              <span style={{ fontSize: "1.1rem" }}>{a.icon}</span>
              <div>
                <div style={{ fontWeight: 700 }}>{a.label}</div>
                <div style={{ color: C.faint, fontSize: "0.72rem" }}>{a.sub}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const items: Array<{ type: "vote" | "opp"; author: string; detail: string; context: string; time: string; usd?: number; col: string }> = [];

  votes.slice(0, 8).forEach(v => {
    const dna = dnaMap.get(v.author);
    const usd = Math.round(v.weightPct / 100 * voteUsd * 10000) / 10000;
    const ctx = dna
      ? dna.sharePct > 8 ? `#${dnaAuthors.findIndex(a => a.username === v.author) + 1} curated author`
        : dna.voteCount > 5 ? `${dna.voteCount} votes total`
        : "First vote"
      : "";
    items.push({ type: "vote", author: v.author, detail: `${v.weightPct}% vote`, context: ctx, time: fmtAgeIso(v.votedAt), usd, col: C.ok });
  });

  eligible.slice(0, 4).forEach(p => {
    const w = p.postScore >= 80 ? "optimal" : p.postScore >= 50 ? "good" : "late";
    items.push({ type: "opp", author: p.author, detail: `new post · ${fmtMin(p.ageMinutes)}`, context: `${w} window`, time: "open", col: C.warn });
  });

  return (
    <div>
      {items.map((item, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "center", gap: "0.75rem",
          padding: "0.65rem 0", borderBottom: i < items.length - 1 ? `1px solid ${C.bg3}` : "none",
        }}>
          <div style={{
            width: "32px", height: "32px", borderRadius: "50%", flexShrink: 0,
            background: item.col + "1a", border: `1.5px solid ${item.col}44`,
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.85rem",
          }}>
            {item.type === "vote" ? "✓" : "⚡"}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", flexWrap: "wrap" as const }}>
              <span style={{ color: C.info, fontWeight: 700, fontSize: "0.83rem" }}>@{item.author}</span>
              <span style={{ color: C.faint, fontSize: "0.74rem" }}>· {item.detail}</span>
            </div>
            {item.context && <p style={{ color: C.faint, fontSize: "0.72rem", margin: "0.05rem 0 0" }}>{item.context}</p>}
          </div>
          <div style={{ display: "flex", flexDirection: "column" as const, alignItems: "flex-end", flexShrink: 0 }}>
            {item.usd ? <span style={{ color: item.col, fontWeight: 700, fontSize: "0.82rem" }}>+{fmtUsd(item.usd)}</span> : null}
            <span style={{ color: C.faint, fontSize: "0.68rem" }}>{item.time}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── VP Projection sparkline ───────────────────────────────────────────────────

function VpProjection({ vpPct, votesPerDay, avgWeight }: { vpPct: number; votesPerDay: number; avgWeight: number }) {
  const spend  = votesPerDay * avgWeight / 100;
  const net    = 20 - spend;
  const days   = Array.from({ length: 8 }, (_, i) => Math.max(0, Math.min(100, vpPct + net * i)));
  const maxV   = Math.max(...days, 1);
  const minV   = Math.min(...days, 0);
  const endCol = vpCol(days[7]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: "4px", height: "56px" }}>
        {days.map((v, i) => (
          <div key={i} title={`+${i}d: ${v.toFixed(0)}%`} style={{
            flex: 1, height: `${Math.max(6, ((v - minV) / (maxV - minV || 1)) * 50 + 6)}px`,
            background: vpCol(v) + (i === 0 ? "ff" : "66"),
            borderRadius: "3px 3px 0 0", alignSelf: "flex-end", transition: "height 0.3s",
          }}/>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "6px", fontSize: "0.73rem" }}>
        <span style={{ color: C.faint }}>Now: <b style={{ color: vpCol(days[0]) }}>{vpPct.toFixed(0)}%</b></span>
        <span style={{ color: endCol, fontWeight: 700 }}>7d: {days[7].toFixed(0)}%{net >= 0 ? " ↗" : " ↘"}</span>
      </div>
    </div>
  );
}

// ── Category donut ────────────────────────────────────────────────────────────

function CategoryDonut({ rules }: { rules: StrategyRuleLite[] }) {
  const total = rules.length || 1;
  const cats  = Object.keys(CAT).filter(c => rules.some(r => r.category === c));
  const cx = 52, cy = 52, r = 38, sw = 16;
  let angle = -90;

  const slices = cats.map(c => {
    const n   = rules.filter(r => r.category === c).length;
    const pct = n / total;
    const deg = pct * 360;
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
    <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
      <svg width={104} height={104} viewBox="0 0 104 104" style={{ flexShrink: 0 }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1a2030" strokeWidth={sw}/>
        {slices.map(s => (
          <path key={s.c} d={s.d} fill="none" stroke={CAT[s.c].color} strokeWidth={sw} strokeLinecap="butt"/>
        ))}
        <text x={cx} y={cy + 6} textAnchor="middle" fill={C.text} fontSize="16" fontWeight="800">{rules.length}</text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.3rem" }}>
        {slices.map(s => (
          <div key={s.c} style={{ display: "flex", alignItems: "center", gap: "0.45rem", fontSize: "0.78rem" }}>
            <div style={{ width: "9px", height: "9px", borderRadius: "2px", background: CAT[s.c].color, flexShrink: 0 }}/>
            <span style={{ color: C.muted, minWidth: "62px" }}>{CAT[s.c].label}</span>
            <span style={{ color: C.text, fontWeight: 700 }}>{s.n}</span>
            <span style={{ color: C.faint }}>({Math.round(s.pct * 100)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Session vote bars ─────────────────────────────────────────────────────────

function SessionBars({ votes, voteUsd }: { votes: RecentVote[]; voteUsd: number }) {
  if (votes.length === 0) return (
    <div style={{ display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", flex: 1, gap: "0.4rem", opacity: 0.5 }}>
      <div style={{ fontSize: "1.8rem" }}>—</div>
      <p style={{ color: C.faint, fontSize: "0.78rem", margin: 0 }}>No votes yet this session</p>
    </div>
  );
  const max   = Math.max(...votes.map(v => v.weightPct), 1);
  const total = votes.reduce((s, v) => s + v.weightPct / 100 * voteUsd, 0);
  return (
    <div style={{ flex: 1 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: "4px", height: "56px" }}>
        {votes.slice(-14).map((v, i) => (
          <div key={i} title={`@${v.author}: ${v.weightPct}%`} style={{
            flex: 1, height: `${Math.max(6, (v.weightPct / max) * 50)}px`,
            background: C.ok + "88", borderRadius: "3px 3px 0 0", alignSelf: "flex-end",
          }}/>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "6px", fontSize: "0.73rem" }}>
        <span style={{ color: C.faint }}>{votes.length} votes cast</span>
        <span style={{ color: C.ok, fontWeight: 700 }}>+{fmtUsd(total)} today</span>
      </div>
    </div>
  );
}

// ── Insight strip ─────────────────────────────────────────────────────────────

function generateInsights(
  profile: CurationProfile | null, rules: StrategyRuleLite[],
  openOpps: PostOpportunity[], vpPct: number | null, _snap: SteemAccountSnapshot | null,
) {
  const out: Array<{ icon: string; text: string; color: string }> = [];
  if (!profile && rules.length === 0 && openOpps.length === 0) return out;

  if (openOpps.length > 0) {
    const best    = openOpps.reduce((a, b) => a.postScore > b.postScore ? a : b);
    const catRule = rules.find(r => r.username === best.author);
    out.push({
      icon: "⚡",
      text: `@${best.author} posted ${fmtMin(best.ageMinutes)} ago — ${best.ageMinutes <= 30 ? "optimal curation window" : "within reward window"}${catRule ? ` · ${CAT[catRule.category]?.label ?? ""}` : ""}`,
      color: catRule ? (CAT[catRule.category]?.color ?? C.warn) : C.warn,
    });
  }
  if (profile && profile.topAuthors.length > 0) {
    const top = profile.topAuthors[0];
    out.push({
      icon: "🧬",
      text: `Strongest bond: @${top.username} — ${top.voteCount} votes at ${top.avgWeightPct}% avg weight`,
      color: C.purple,
    });
  }
  if (vpPct !== null && profile) {
    const avgW     = rules.length > 0 ? rules.reduce((s, r) => s + r.maxWeightPct, 0) / rules.length : 0;
    const dailySpd = profile.votesPerDay * avgW / 100;
    if (vpPct > 92) out.push({ icon: "💡", text: `VP at ${vpPct.toFixed(1)}% — capacity to vote more today`, color: C.ok });
    else if (dailySpd > 20) out.push({ icon: "⚠", text: `Strategy spends ~${dailySpd.toFixed(1)}% VP/day — consider reducing weights`, color: C.warn });
  }
  return out.slice(0, 3);
}

// ── Section card wrapper ──────────────────────────────────────────────────────

const sectionCard: React.CSSProperties = {
  background: `linear-gradient(160deg, ${C.bg2} 0%, ${C.bg1} 100%)`,
  border: `1px solid ${C.border}`,
  borderRadius: "14px",
  padding: "1.25rem 1.5rem",
};

const sectionLabel: React.CSSProperties = {
  color: C.dim, fontSize: "0.72rem", fontWeight: 700,
  textTransform: "uppercase" as const, letterSpacing: "0.9px",
  margin: "0 0 1rem",
};

// ── Main Dashboard ────────────────────────────────────────────────────────────

export function UserDashboard(props: {
  session: AuthSession;
  snapshot: SteemAccountSnapshot | null;
  snapshotLoading: boolean;
  snapshotRefreshedAt?: Date;
  strategyRules: StrategyRuleLite[] | null;
  opportunities: PostOpportunity[] | null;
  opportunitiesLoading: boolean;
  votePlan: VotePlanResponse | null;
  curationProfile: CurationProfile | null;
  recentVotes: RecentVote[];
  onTabChange: (tab: "dna" | "dashboard" | "community" | "billing") => void;
  onGenerateVotes: () => void;
  onLoadOpportunities: () => void;
  onRefreshSnapshot?: () => void;
}) {
  const { snapshot, strategyRules, opportunities, votePlan, curationProfile, recentVotes } = props;

  const vpPct     = snapshot ? snapshot.votingPowerBps / 100 : null;
  const rules     = sortRules(strategyRules ?? []);
  const openOpps  = opportunities?.filter(p => p.eligible) ?? [];
  const oppMap    = new Map(openOpps.map(p => [p.author, p]));
  const dnaAuthors = curationProfile?.topAuthors ?? [];
  const dnaMap    = new Map(dnaAuthors.map(a => [a.username, a]));
  const avgWeight = rules.length > 0 ? rules.reduce((s, r) => s + r.maxWeightPct, 0) / rules.length : 0;
  const sessionUsd = recentVotes.reduce((s, v) => s + v.weightPct / 100 * (snapshot?.currentVoteUsd ?? 0), 0);
  const insights  = generateInsights(curationProfile, rules, openOpps, vpPct, snapshot);

  const setupSteps = [
    { done: true,                   label: "Connect SteemConnect",    sub: `@${props.session.user.username}`, cta: "" },
    { done: !!curationProfile,      label: "Analyze Vote-DNA",        sub: "Discover curation patterns",    cta: "Analyze", onClick: () => props.onTabChange("dna") },
    { done: rules.length > 0,       label: "Build strategy",          sub: "Choose authors and weights",    cta: "Build",   onClick: () => props.onTabChange("dna") },
    { done: opportunities !== null, label: "Find opportunities",      sub: "See which authors posted",       cta: "Check",   onClick: props.onLoadOpportunities },
    { done: recentVotes.length > 0, label: "Execute first vote",      sub: "Support your community on-chain",cta: "Vote",   onClick: () => { props.onTabChange("dna"); props.onGenerateVotes(); } },
  ];
  const setupDone = setupSteps.every(s => s.done);

  return (
    <div style={{ padding: "1.5rem 2rem", display: "flex", flexDirection: "column", gap: "1.25rem" }}>

      {/* ── Row 1: Hero — VP gauge + 4 big KPI tiles ─────────────── */}
      <div style={{ display: "flex", gap: "1rem", alignItems: "stretch" }}>

        {/* VP Card */}
        <div style={{
          ...sectionCard,
          padding: "1rem 1.25rem 0.75rem",
          display: "flex", flexDirection: "column" as const, alignItems: "center",
          minWidth: "240px", width: "240px", flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", marginBottom: "0.15rem" }}>
            <span style={{ color: C.faint, fontSize: "0.62rem", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.5px" }}>
              {props.snapshotLoading ? "Updating…" : props.snapshotRefreshedAt ? fmtAgeIso(props.snapshotRefreshedAt.toISOString()) : "Account"}
            </span>
            {props.onRefreshSnapshot && (
              <button type="button" onClick={props.onRefreshSnapshot} disabled={props.snapshotLoading} style={{
                background: "none", border: "none", cursor: "pointer",
                color: props.snapshotLoading ? C.faint : C.muted,
                fontSize: "0.9rem", padding: "0 0.1rem", lineHeight: 1,
                opacity: props.snapshotLoading ? 0.5 : 1,
              }} title="Refresh account data">↻</button>
            )}
          </div>
          {vpPct !== null
            ? <VpGauge pct={vpPct} sp={snapshot?.steemPowerSp} voteUsd={snapshot?.fullPowerVoteUsd}/>
            : <div style={{ height: "200px", display: "flex", alignItems: "center", justifyContent: "center", color: C.faint, fontSize: "0.88rem" }}>
                {props.snapshotLoading ? "Loading…" : "—"}
              </div>
          }
        </div>

        {/* 4 KPI tiles */}
        <KpiTile
          label="Vote Value Now"
          value={snapshot ? fmtUsd(snapshot.currentVoteUsd) : "—"}
          sub={vpPct && vpPct < 80 ? `⚠ VP recovering · full = ${fmtUsd(snapshot?.fullPowerVoteUsd ?? 0)}` : `at current VP · full = ${fmtUsd(snapshot?.fullPowerVoteUsd ?? 0)}`}
          color={vpPct ? vpCol(vpPct) : C.dim}
        />

        <KpiTile
          label="Open Opportunities"
          value={openOpps.length > 0 ? openOpps.length : opportunities === null ? "—" : "0"}
          sub={openOpps.length > 0
            ? `${openOpps.filter(p => p.postScore >= 80).length} in optimal window`
            : opportunities === null ? "tap to discover"
            : recentVotes.length > 0 ? "voted — re-scan for new posts ↻" : "all caught up ✓"}
          color={openOpps.length > 0 ? C.warn : opportunities !== null && recentVotes.length > 0 ? C.info : C.ok}
          glow={openOpps.length > 0}
          onClick={() => { props.onLoadOpportunities(); props.onTabChange("dna"); }}
        />

        <KpiTile
          label="Authors Curated"
          value={rules.length > 0 ? rules.length : "—"}
          sub={rules.length > 0
            ? `${new Set(rules.map(r => r.category)).size} categories · ${fmtUsd(avgWeight / 100 * (snapshot?.currentVoteUsd ?? 0))}/avg vote`
            : "build your strategy"}
          color={C.info}
          onClick={() => props.onTabChange("dna")}
        />

        <KpiTile
          label="Session Impact"
          value={recentVotes.length > 0 ? fmtUsd(sessionUsd) : "—"}
          sub={recentVotes.length > 0
            ? `${recentVotes.length} vote${recentVotes.length > 1 ? "s" : ""} cast today`
            : curationProfile
              ? `≈ ${fmtUsd(curationProfile.votesPerDay * 30 * (snapshot?.currentVoteUsd ?? 0) * avgWeight / 100)}/mo estimated`
              : "no votes yet"}
          color={recentVotes.length > 0 ? C.ok : C.purple}
        />
      </div>

      {/* ── Row 2: Insights strip (if any) ───────────────────────── */}
      {insights.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${insights.length}, 1fr)`, gap: "0.75rem" }}>
          {insights.map((ins, i) => (
            <div key={i} style={{
              background: ins.color + "0c", border: `1px solid ${ins.color}33`,
              borderRadius: "10px", padding: "0.85rem 1rem",
              display: "flex", alignItems: "flex-start", gap: "0.6rem",
            }}>
              <span style={{ fontSize: "1.1rem", flexShrink: 0 }}>{ins.icon}</span>
              <p style={{ color: C.muted, fontSize: "0.82rem", lineHeight: 1.5, margin: 0 }}>{ins.text}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Row 3: Curation identity banner ──────────────────────── */}
      {curationProfile && (
        <div style={{
          ...sectionCard,
          display: "flex", alignItems: "flex-start", gap: "1.25rem",
          padding: "1.1rem 1.5rem",
        }}>
          <div style={{
            fontSize: "2.2rem", lineHeight: 1, flexShrink: 0,
            filter: "drop-shadow(0 0 8px rgba(88,166,255,0.3))",
          }}>{DNA_EMOJI[curationProfile.dnaLabel] ?? "⚪"}</div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.35rem", flexWrap: "wrap" as const }}>
              <span style={{ color: C.info, fontSize: "1.05rem", fontWeight: 800 }}>{curationProfile.dnaLabel}</span>
              <span style={{ color: C.faint }}>·</span>
              <span style={{ color: C.muted, fontSize: "0.82rem" }}>
                {curationProfile.avgWeightPct >= 70 ? "high conviction" : curationProfile.avgWeightPct >= 45 ? "balanced" : "exploratory"}
                {curationProfile.selfVotePct < 5 ? " · community-first" : curationProfile.selfVotePct > 20 ? " · self-focused" : ""}
              </span>
            </div>
            <p style={{ color: C.text, fontSize: "0.85rem", margin: "0 0 0.6rem", lineHeight: 1.55 }}>
              You've curated <strong style={{ color: C.info }}>{curationProfile.uniqueAuthors} authors</strong> over{" "}
              <strong style={{ color: C.info }}>{curationProfile.periodDays} days</strong>, casting{" "}
              <strong style={{ color: C.ok }}>{curationProfile.votesAnalyzed} votes</strong> at{" "}
              <strong style={{ color: vpCol(curationProfile.avgWeightPct) }}>{curationProfile.avgWeightPct}%</strong> average weight.
            </p>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" as const }}>
              {[
                { label: "Votes/day", val: curationProfile.votesPerDay.toFixed(1) },
                { label: "Full-weight", val: `${curationProfile.fullWeightPct}%` },
                { label: "Self-votes", val: `${curationProfile.selfVotePct}%` },
                curationProfile.peakHoursUtc[0] ? { label: "Peak UTC", val: `${String(curationProfile.peakHoursUtc[0].hour).padStart(2,"0")}:00` } : null,
              ].filter(Boolean).map(f => (
                <span key={f!.label} style={{ background: C.bg3, border: `1px solid ${C.border}`, borderRadius: "5px", padding: "0.2rem 0.55rem", fontSize: "0.75rem", color: C.muted }}>
                  {f!.label}: <b style={{ color: C.text }}>{f!.val}</b>
                </span>
              ))}
            </div>
          </div>

          <div style={{ textAlign: "center", flexShrink: 0, paddingLeft: "0.5rem" }}>
            <div style={{ fontSize: "2rem", fontWeight: 900, color: C.purple, lineHeight: 1 }}>{curationProfile.votesAnalyzed}</div>
            <div style={{ color: C.faint, fontSize: "0.65rem", fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase" as const }}>votes</div>
          </div>
        </div>
      )}

      {/* ── Row 4: Authors (left) + Activity & Actions (right) ───── */}
      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: "1.25rem", alignItems: "start" }}>

        {/* Authors panel */}
        <div style={sectionCard}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
            <div>
              <p style={sectionLabel}>Curated Authors</p>
              {openOpps.length > 0 && (
                <p style={{ color: C.warn, fontSize: "0.82rem", margin: "-0.5rem 0 0", fontWeight: 600 }}>
                  ⚡ {openOpps.length} {openOpps.length === 1 ? "author has a" : "authors have"} new post{openOpps.length > 1 ? "s" : ""}
                </p>
              )}
            </div>
            <button type="button" onClick={() => props.onTabChange("dna")} style={{
              background: "none", border: `1px solid ${C.border}`, borderRadius: "6px",
              color: C.muted, cursor: "pointer", fontSize: "0.75rem", padding: "0.25rem 0.65rem",
            }}>
              Edit strategy →
            </button>
          </div>

          {rules.length === 0 ? (
            <div style={{ textAlign: "center", padding: "2rem 0" }}>
              <div style={{ fontSize: "2.5rem", marginBottom: "0.6rem" }}>🧬</div>
              <p style={{ color: C.muted, fontSize: "0.9rem", margin: "0 0 0.4rem", fontWeight: 600 }}>Your curation community awaits</p>
              <p style={{ color: C.faint, fontSize: "0.8rem", margin: "0 0 1rem", lineHeight: 1.55 }}>
                Analyze your voting history and VoteBroker will suggest authors for your strategy.
              </p>
              <button type="button" onClick={() => props.onTabChange("dna")} style={{
                background: C.info + "22", border: `1px solid ${C.info}`, borderRadius: "7px",
                color: C.info, cursor: "pointer", fontSize: "0.82rem", padding: "0.45rem 1rem", fontWeight: 700,
              }}>
                Analyze Vote-DNA →
              </button>
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
                {rules.slice(0, 12).map(r => (
                  <AuthorCard
                    key={r.username} rule={r}
                    openPost={oppMap.get(r.username)}
                    voteUsd={snapshot?.currentVoteUsd ?? 0}
                    dnaData={dnaMap.get(r.username)}
                  />
                ))}
              </div>
              {rules.length > 12 && (
                <p style={{ color: C.faint, fontSize: "0.75rem", textAlign: "center", marginTop: "0.6rem", marginBottom: 0 }}>
                  +{rules.length - 12} more in strategy
                </p>
              )}
            </>
          )}
        </div>

        {/* Right column: Activity + Actions */}
        <div style={{ display: "flex", flexDirection: "column" as const, gap: "1.25rem" }}>

          {/* Quick actions */}
          <div style={sectionCard}>
            <p style={sectionLabel}>Quick Actions</p>
            <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.5rem" }}>
              {[
                { icon: "🧬", label: "Vote-DNA",       sub: "Analyze & build strategy",               color: C.info,   fn: () => props.onTabChange("dna") },
                { icon: "🗳",  label: "Vote Plan",      sub: "Generate optimized plan",                color: C.purple, fn: () => { props.onTabChange("dna"); props.onGenerateVotes(); } },
                { icon: "⚡",  label: openOpps.length > 0 ? `Opportunities (${openOpps.length})` : "Opportunities",
                              sub: openOpps.length > 0 ? `${openOpps.length} posts open now` : "Find posts to vote",
                              color: openOpps.length > 0 ? C.warn : C.muted,
                              fn: () => { props.onLoadOpportunities(); props.onTabChange("dna"); } },
                { icon: "⚙",  label: "Settings",       sub: "Manage permissions",                     color: C.ok,     fn: () => props.onTabChange("billing") },
              ].map(a => (
                <button key={a.label} type="button" onClick={a.fn} style={{
                  background: a.color + "0e", border: `1px solid ${a.color}2a`, borderRadius: "10px",
                  padding: "0.85rem 1rem", cursor: "pointer", textAlign: "left" as const,
                  display: "flex", alignItems: "center", gap: "0.75rem",
                }}>
                  <span style={{ fontSize: "1.2rem" }}>{a.icon}</span>
                  <div>
                    <div style={{ color: C.text, fontSize: "0.85rem", fontWeight: 700 }}>{a.label}</div>
                    <div style={{ color: C.muted, fontSize: "0.73rem" }}>{a.sub}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Activity feed */}
          <div style={{ ...sectionCard, flex: 1 }}>
            <p style={sectionLabel}>Recent Activity</p>
            <ActivityFeed
              votes={recentVotes} opps={opportunities} voteUsd={snapshot?.currentVoteUsd ?? 0}
              dnaAuthors={dnaAuthors}
              onAction={{
                plan: () => { props.onTabChange("dna"); props.onGenerateVotes(); },
                opps: props.onLoadOpportunities,
                dna: () => props.onTabChange("dna"),
              }}
            />
          </div>

          {/* Setup checklist (only if not done) */}
          {!setupDone && (
            <div style={sectionCard}>
              <p style={sectionLabel}>Getting Started</p>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.4rem" }}>
                {setupSteps.map((s, i) => {
                  const next   = setupSteps.findIndex(x => !x.done);
                  const active = i === next;
                  return (
                    <div key={i} style={{
                      display: "flex", alignItems: "center", gap: "0.65rem",
                      padding: "0.5rem 0.75rem",
                      background: active ? C.info + "0d" : "transparent",
                      border: `1px solid ${active ? C.info + "33" : s.done ? C.ok + "18" : C.border}`,
                      borderRadius: "8px", opacity: i > next + 1 ? 0.4 : 1,
                    }}>
                      <div style={{
                        width: "24px", height: "24px", borderRadius: "50%", flexShrink: 0,
                        background: s.done ? C.ok + "1a" : active ? C.info + "1a" : C.bg3,
                        border: `1.5px solid ${s.done ? C.ok : active ? C.info : C.border}`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: "0.72rem", fontWeight: 700,
                        color: s.done ? C.ok : active ? C.info : C.faint,
                      }}>
                        {s.done ? "✓" : i + 1}
                      </div>
                      <div style={{ flex: 1 }}>
                        <p style={{ color: s.done ? C.muted : C.text, fontSize: "0.8rem", fontWeight: 600, margin: 0, textDecoration: s.done ? "line-through" : "none" }}>{s.label}</p>
                        <p style={{ color: C.faint, fontSize: "0.7rem", margin: 0 }}>{s.sub}</p>
                      </div>
                      {active && s.onClick && (
                        <button type="button" onClick={s.onClick} style={{
                          background: C.info + "1a", border: `1px solid ${C.info}`, borderRadius: "5px",
                          color: C.info, cursor: "pointer", fontSize: "0.73rem", padding: "0.2rem 0.6rem", fontWeight: 700, flexShrink: 0,
                        }}>{s.cta}</button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Row 5: Analytics strip ────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1.25rem" }}>

        <div style={sectionCard}>
          <p style={sectionLabel}>Strategy Mix</p>
          {rules.length > 0
            ? <CategoryDonut rules={rules}/>
            : <p style={{ color: C.faint, fontSize: "0.82rem", margin: 0 }}>No strategy yet — analyze Vote-DNA to start</p>}
        </div>

        <div style={sectionCard}>
          <p style={sectionLabel}>VP Projection — 7 days</p>
          {vpPct !== null && curationProfile
            ? <VpProjection vpPct={vpPct} votesPerDay={curationProfile.votesPerDay} avgWeight={avgWeight}/>
            : <p style={{ color: C.faint, fontSize: "0.82rem", margin: 0 }}>Analyze Vote-DNA to see projection</p>}
          {votePlan && (
            <div style={{ marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: `1px solid ${C.border}` }}>
              <span style={{ color: C.dim, fontSize: "0.7rem", textTransform: "uppercase" as const, letterSpacing: "0.5px" }}>Last Plan</span>
              <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.3rem", fontSize: "0.78rem" }}>
                <span style={{ color: C.purple, fontWeight: 700 }}>{votePlan.plan.length} votes</span>
                <span style={{ color: C.faint }}>·</span>
                <span style={{ color: C.muted }}>{votePlan.summary.estimatedVpSpendPct}% VP</span>
                <span style={{ color: C.faint }}>·</span>
                <span style={{ color: C.ok }}>{votePlan.summary.sustainability}</span>
              </div>
            </div>
          )}
        </div>

        <div style={{ ...sectionCard, display: "flex", flexDirection: "column" as const }}>
          <p style={sectionLabel}>Session Votes</p>
          <SessionBars votes={recentVotes} voteUsd={snapshot?.currentVoteUsd ?? 0}/>
          {recentVotes.length > 0 && (
            <div style={{ marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: `1px solid ${C.border}`, fontSize: "0.75rem" }}>
              {recentVotes.slice(0, 3).map((v, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0", color: C.muted }}>
                  <span>@{v.author}</span>
                  <span style={{ color: C.ok, fontWeight: 600 }}>{v.weightPct}%</span>
                </div>
              ))}
              {recentVotes.length > 3 && (
                <p style={{ color: C.faint, fontSize: "0.68rem", margin: "0.2rem 0 0", textAlign: "center" }}>
                  +{recentVotes.length - 3} more
                </p>
              )}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
