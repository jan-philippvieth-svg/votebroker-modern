// ── OpportunitiesView — Top Opportunities from blockchain ──────────────────────
// Displays top-N scored posts; cache refreshed every 30 min server-side.
// Score components explain WHY a post is interesting (not an auto-vote signal).

import React, { useState } from "react";
import { createTranslator, type Locale } from "../i18n";
import {
  executeVote, VoteBroadcastError,
  getPersistedStrategy, persistStrategy,
  type OpportunitiesData, type OpportunityEntry, type OpportunityComponents, type AuthSession,
} from "../api";

const C = {
  bg:     "#f8fafc",
  card:   "#ffffff",
  border: "#e2e8f0",
  text:   "#1e293b",
  dim:    "#64748b",
  faint:  "#94a3b8",
  ok:     "#16a34a",
  warn:   "#d97706",
  info:   "#2563eb",
  red:    "#dc2626",
  purple: "#7c3aed",
  tag:    "#f1f5f9",
};

type T = ReturnType<typeof createTranslator>;

// ── Score badge ───────────────────────────────────────────────────────────────

function scoreBadge(score: number): { bg: string; color: string } {
  if (score >= 75) return { bg: "#dcfce7", color: "#15803d" };
  if (score >= 55) return { bg: "#fef9c3", color: "#92400e" };
  if (score >= 35) return { bg: "#e0f2fe", color: "#0369a1" };
  return { bg: C.tag, color: C.dim };
}

function tierLabel(score: number, t: T): string {
  if (score >= 75) return t("oppTierExcellent");
  if (score >= 55) return t("oppTierGood");
  if (score >= 35) return t("oppTierMonitor");
  return t("oppTierLow");
}

// ── Top 1-2 reasons from score components ─────────────────────────────────────

function topReasons(c: OpportunityComponents, t: T): string[] {
  const parts: Array<{ label: string; pts: number }> = [
    { label: t("oppReasonPayout"),    pts: c.payoutSweetspot },
    { label: t("oppReasonTiming"),    pts: c.timing          },
    { label: t("oppReasonSignal"),    pts: c.signalCurators  },
    { label: t("oppReasonDiscovery"), pts: c.discovery       },
    { label: t("oppReasonAuthor"),    pts: c.authorHistory   },
  ];
  return parts
    .sort((a, b) => b.pts - a.pts)
    .slice(0, 2)
    .filter(p => p.pts > 0)
    .map(p => p.label);
}

// ── Age/time formatting ───────────────────────────────────────────────────────

function fmtAge(minutes: number, t: T): string {
  if (minutes < 60) return `${Math.round(minutes)} ${t("oppMinAgo")}`;
  return `${(minutes / 60).toFixed(1)} ${t("oppHAgo")}`;
}

function fmtRemaining(hours: number, t: T): string {
  if (hours < 1) return `${Math.round(hours * 60)} ${t("oppMinAgo")}`;
  return `${hours.toFixed(0)} ${t("oppHAgo")}`;
}

// ── GF display ────────────────────────────────────────────────────────────────

function gfColor(gf: number): string {
  if (gf >= 2.0) return C.ok;
  if (gf >= 1.2) return C.warn;
  return C.faint;
}

// ── Score component pills ─────────────────────────────────────────────────────

function ScoreBreakdown({ c }: { c: OpportunityComponents }) {
  // Short labels are language-neutral abbreviations — no translation needed
  const items = [
    { label: "Pool",   pts: c.payoutSweetspot, max: 35 },
    { label: "Timing", pts: c.timing,          max: 25 },
    { label: "Signal", pts: c.signalCurators,  max: 20 },
    { label: "Disc.",  pts: c.discovery,        max: 10 },
    { label: "Autor",  pts: c.authorHistory,   max: 10 },
  ];
  return (
    <div style={{ display: "flex", gap: "0.2rem", flexWrap: "wrap" as const, marginTop: "0.25rem" }}>
      {items.map(({ label, pts, max }) => {
        const pct = pts / max;
        const bg  = pct >= 0.8 ? "#dcfce7" : pct >= 0.5 ? "#fef9c3" : C.tag;
        const cl  = pct >= 0.8 ? "#15803d" : pct >= 0.5 ? "#92400e" : C.faint;
        return (
          <span key={label} style={{
            fontSize: "0.62rem", fontWeight: 600, padding: "0.1rem 0.35rem",
            background: bg, color: cl, borderRadius: "4px",
          }}>{label} {pts}</span>
        );
      })}
    </div>
  );
}

// ── Detail panel text helpers ─────────────────────────────────────────────────

function poolDetailText(pendingSbd: number, t: T): string {
  const sbd = pendingSbd < 0.5 ? pendingSbd.toFixed(3) : pendingSbd.toFixed(2);
  const key = pendingSbd < 0.5 ? "oppDetailPoolBest"
    : pendingSbd < 2.0  ? "oppDetailPoolGood"
    : pendingSbd < 5.0  ? "oppDetailPoolMid"
    : pendingSbd < 10.0 ? "oppDetailPoolHigh"
    : "oppDetailPoolMax";
  return t(key).replace("{{sbd}}", sbd);
}

function timingDetailText(ageMinutes: number, remainingHours: number, t: T): string {
  const age = ageMinutes < 60 ? `${Math.round(ageMinutes)} ${t("oppMinAgo")}` : `${(ageMinutes / 60).toFixed(1)} ${t("oppHAgo")}`;
  const rem = `${remainingHours.toFixed(0)}${t("oppHAgo")}`;
  const key = ageMinutes <= 15  ? "oppDetailTimingBest"
    : ageMinutes <= 60   ? "oppDetailTimingGood"
    : ageMinutes <= 360  ? "oppDetailTimingMid"
    : ageMinutes <= 1440 ? "oppDetailTimingLate"
    : "oppDetailTimingMin";
  return t(key).replace("{{age}}", age).replace("{{rem}}", rem);
}

function signalDetailText(whaleCount: number, t: T): string {
  if (whaleCount === 0)  return t("oppDetailSignalNone");
  if (whaleCount === 1)  return t("oppDetailSignalOne");
  const key = whaleCount <= 3  ? "oppDetailSignalFew"
    : whaleCount <= 5  ? "oppDetailSignalSweet"
    : whaleCount <= 8  ? "oppDetailSignalMid"
    : whaleCount <= 12 ? "oppDetailSignalHigh"
    : "oppDetailSignalMax";
  return t(key).replace("{{n}}", String(whaleCount));
}

function discoveryDetailText(category: string | null, t: T): string {
  if (!category)              return t("oppDetailDiscNone");
  if (category === "immer_voten")    return t("oppDetailDiscImmer");
  if (category === "lieblingsautor") return t("oppDetailDiscLiebling");
  if (category === "bevorzugt")      return t("oppDetailDiscBevorzugt");
  if (category === "normal")         return t("oppDetailDiscNormal");
  if (category === "niedrig")        return t("oppDetailDiscNiedrig");
  return category;
}

function authorDetailText(pts: number, avgGf: number | null, gfSampleN: number, t: T): string {
  const base = pts >= 9  ? t("oppDetailAuthorTop")
    : pts >= 7           ? t("oppDetailAuthorAbove")
    : pts >= 5 && gfSampleN === 0 ? t("oppDetailAuthorNoData")
    : pts >= 5           ? t("oppDetailAuthorAvg")
    : pts >= 2           ? t("oppDetailAuthorBelow")
    : t("oppDetailAuthorPoor");
  if (avgGf != null && gfSampleN >= 3) {
    return `${base} ${t("oppDetailAuthorGf").replace("{{gf}}", avgGf.toFixed(2)).replace("{{n}}", String(gfSampleN))}`;
  }
  if (gfSampleN > 0 && gfSampleN < 3) {
    return `${base} ${t("oppDetailAuthorFewData").replace("{{n}}", String(gfSampleN))}`;
  }
  return base;
}

// ── Score detail panel (shown in expanded row) ────────────────────────────────

function ScoreDetail({ opp, t }: { opp: OpportunityEntry; t: T }) {
  const c = opp.components;

  const rows = [
    { label: "Pool",                     pts: c.payoutSweetspot, max: 35, detail: poolDetailText(opp.pendingPayoutSbd, t) },
    { label: "Timing",                   pts: c.timing,          max: 25, detail: timingDetailText(opp.ageMinutes, opp.remainingHours, t) },
    { label: t("oppFactorSignalLabel"),  pts: c.signalCurators,  max: 20, detail: signalDetailText(opp.whaleCount, t) },
    { label: "Discovery",                pts: c.discovery,        max: 10, detail: discoveryDetailText(opp.myCategory, t) },
    { label: t("oppFactorAuthorLabel"),  pts: c.authorHistory,   max: 10, detail: authorDetailText(c.authorHistory, opp.authorAvgGf, opp.authorGfSampleN, t) },
  ];

  const badge = scoreBadge(opp.opportunityScore);

  return (
    <div style={{ padding: "0.75rem 1rem 0.8rem", background: "#f8fafc", borderTop: "1px solid #e2e8f0" }}>
      {rows.map(row => {
        const pct   = row.pts / row.max;
        const color = pct >= 0.8 ? C.ok : pct >= 0.5 ? C.warn : C.faint;
        return (
          <div key={row.label} style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.32rem" }}>
            <span style={{ width: "100px", fontSize: "0.72rem", fontWeight: 700, color: C.text, flexShrink: 0 }}>
              {row.label}
            </span>
            <span style={{ width: "38px", textAlign: "right" as const, fontSize: "0.8rem", fontWeight: 800, color, flexShrink: 0 }}>
              +{row.pts}
            </span>
            <div style={{ flex: "0 0 90px", height: "5px", background: C.border, borderRadius: "3px", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${pct * 100}%`, background: color, borderRadius: "3px" }} />
            </div>
            <span style={{ fontSize: "0.62rem", color: C.faint, flexShrink: 0, width: "24px" }}>/{row.max}</span>
            <span style={{ fontSize: "0.72rem", color: C.dim, flex: 1 }}>{row.detail}</span>
          </div>
        );
      })}

      <div style={{ borderTop: `1px solid ${C.border}`, marginTop: "0.55rem", paddingTop: "0.45rem", display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" as const }}>
        <span style={{ fontWeight: 800, fontSize: "0.85rem", color: C.text }}>
          {t("oppDetailLabel")} {opp.opportunityScore}/100
        </span>
        <span style={{
          background: badge.bg, color: badge.color,
          fontWeight: 700, fontSize: "0.72rem", borderRadius: "5px",
          padding: "0.1rem 0.5rem",
        }}>
          {tierLabel(opp.opportunityScore, t)}
        </span>
        <span style={{ fontSize: "0.68rem", color: C.faint }}>
          {t("oppDetailGate")}
        </span>
      </div>
    </div>
  );
}

// ── Legend panel ──────────────────────────────────────────────────────────────

function LegendPanel({ t }: { t: T }) {
  const [open, setOpen] = useState(false);

  const tiers = [
    { range: "75–100", key: "oppTierExcellent", bg: "#dcfce7", color: "#15803d" },
    { range: "55–74",  key: "oppTierGood",      bg: "#fef9c3", color: "#92400e" },
    { range: "35–54",  key: "oppTierMonitor",   bg: "#e0f2fe", color: "#0369a1" },
    { range: "< 35",   key: "oppTierLow",       bg: C.tag,     color: C.faint   },
  ] as const;

  const factors = [
    { label: "Pool",                    max: 35, descKey: "oppFactorPoolDesc"      },
    { label: "Timing",                  max: 25, descKey: "oppFactorTimingDesc"    },
    { label: t("oppFactorSignalLabel"), max: 20, descKey: "oppFactorSignalDesc"    },
    { label: "Discovery",               max: 10, descKey: "oppFactorDiscoveryDesc" },
    { label: t("oppFactorAuthorLabel"), max: 10, descKey: "oppFactorAuthorDesc"    },
  ] as const;

  return (
    <div style={{ marginBottom: "0.85rem" }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          background: "none", border: "none", cursor: "pointer",
          color: C.dim, fontSize: "0.78rem", padding: 0,
          display: "flex", alignItems: "center", gap: "0.35rem",
          textDecoration: "underline dotted", textUnderlineOffset: "2px",
        }}
      >
        <span>{open ? "▲" : "ℹ"}</span>
        <span>{open ? t("oppLegendHide") : t("oppLegendTitle")}</span>
      </button>

      {open && (
        <div style={{ marginTop: "0.6rem", background: C.card, border: `1px solid ${C.border}`, borderRadius: "10px", padding: "1rem 1.25rem", fontSize: "0.78rem" }}>
          <div style={{ display: "flex", flexWrap: "wrap" as const, gap: "1.5rem", marginBottom: "0.85rem" }}>

            {/* Rating tiers */}
            <div>
              <div style={{ fontWeight: 700, color: C.text, marginBottom: "0.4rem", fontSize: "0.8rem" }}>{t("oppLegendRatingTitle")}</div>
              {tiers.map(tier => (
                <div key={tier.key} style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.2rem" }}>
                  <span style={{ background: tier.bg, color: tier.color, borderRadius: "5px", padding: "0.1rem 0.45rem", fontWeight: 700, fontSize: "0.72rem", width: "50px", textAlign: "center" as const }}>
                    {tier.range}
                  </span>
                  <span style={{ color: C.dim }}>{t(tier.key)}</span>
                </div>
              ))}
            </div>

            {/* Factors */}
            <div style={{ flex: 1, minWidth: "300px" }}>
              <div style={{ fontWeight: 700, color: C.text, marginBottom: "0.2rem", fontSize: "0.8rem" }}>{t("oppLegendFactorsTitle")}</div>
              <div style={{ color: C.faint, fontSize: "0.7rem", marginBottom: "0.4rem" }}>
                <em>{t("oppLegendFactorsSubtitle")}</em>
              </div>
              <table style={{ borderCollapse: "collapse" as const, width: "100%" }}>
                <tbody>
                  {factors.map(f => (
                    <tr key={f.label}>
                      <td style={{ padding: "0.2rem 0.6rem 0.2rem 0", fontWeight: 700, color: C.text, whiteSpace: "nowrap" as const, verticalAlign: "top" }}>{f.label}</td>
                      <td style={{ padding: "0.2rem 0.6rem 0.2rem 0", color: C.info, fontWeight: 800, whiteSpace: "nowrap" as const, verticalAlign: "top" }}>0–{f.max}</td>
                      <td style={{ padding: "0.2rem 0", color: C.dim, lineHeight: 1.45, verticalAlign: "top" }}>{t(f.descKey)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ color: C.faint, fontSize: "0.71rem", borderTop: `1px solid ${C.border}`, paddingTop: "0.45rem" }}>
            {t("oppLegendFooter")}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Vote action panel ─────────────────────────────────────────────────────────

const WEIGHT_OPTIONS = [
  { label: "25%",  bps: 2500 },
  { label: "50%",  bps: 5000 },
  { label: "75%",  bps: 7500 },
  { label: "100%", bps: 10000 },
];

function VotePanel({ opp, token, onVoted }: {
  opp:     OpportunityEntry;
  token:   string;
  onVoted: () => void;
}) {
  const [weightBps, setWeightBps]   = useState(10000);
  const [status, setStatus]         = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg]     = useState<string | null>(null);

  async function handleVote() {
    setStatus("loading"); setErrorMsg(null);
    try {
      await executeVote(token, {
        author:    opp.author,
        permlink:  opp.permlink,
        weightBps,
        broadcastMode: "server",
        strategyCategory: opp.myCategory ?? undefined,
      });
      setStatus("success");
      onVoted();
    } catch (err) {
      const msg = err instanceof VoteBroadcastError ? err.message
        : err instanceof Error ? err.message
        : "Vote fehlgeschlagen";
      setErrorMsg(msg);
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", color: C.ok, fontSize: "0.75rem", fontWeight: 600 }}>
        <span>✓</span><span>Gevoted</span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.3rem", minWidth: "130px" }}>
      {/* Weight selector */}
      <div style={{ display: "flex", gap: "0.2rem" }}>
        {WEIGHT_OPTIONS.map(opt => (
          <button
            key={opt.bps}
            type="button"
            onClick={() => setWeightBps(opt.bps)}
            style={{
              fontSize: "0.62rem", fontWeight: 600, padding: "0.15rem 0.3rem",
              borderRadius: "3px", cursor: "pointer",
              background: weightBps === opt.bps ? C.info + "22" : "transparent",
              border: `1px solid ${weightBps === opt.bps ? C.info : C.border}`,
              color: weightBps === opt.bps ? C.info : C.dim,
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {/* Confirm button */}
      <button
        type="button"
        disabled={status === "loading"}
        onClick={() => void handleVote()}
        style={{
          background: C.ok + "18", border: `1px solid ${C.ok}55`,
          color: C.ok, borderRadius: "4px", cursor: "pointer",
          fontSize: "0.72rem", fontWeight: 700, padding: "0.2rem 0.5rem",
          opacity: status === "loading" ? 0.6 : 1,
        }}
      >
        {status === "loading" ? "…" : "Vote"}
      </button>
      {status === "error" && (
        <div style={{ fontSize: "0.62rem", color: C.red, maxWidth: "140px", lineHeight: 1.3 }}>
          {errorMsg}
        </div>
      )}
    </div>
  );
}

// ── Strategy add panel ────────────────────────────────────────────────────────

const STRATEGY_CATEGORIES = [
  { value: "immer_voten",    label: "Immer voten" },
  { value: "lieblingsautor", label: "Lieblingsautor" },
  { value: "bevorzugt",      label: "Bevorzugt" },
  { value: "normal",         label: "Normal" },
] as const;

function AddToStrategyPanel({ author, token, onAdded, onAddToStrategy }: {
  author:             string;
  token:              string;
  onAdded:            () => void;
  onAddToStrategy?:   (author: string, category: string) => void;
}) {
  const [category, setCategory] = useState<string>("normal");
  const [status,   setStatus]   = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function handleAdd() {
    setStatus("loading"); setErrorMsg(null);
    try {
      if (onAddToStrategy) {
        // Use App-level callback: weight calculation + local state update + persist via effect
        onAddToStrategy(author, category);
      } else {
        // Fallback: direct persist (no weight fields — legacy path)
        const existing = (await getPersistedStrategy(token)) as Array<{
          username: string; enabled: boolean; category: string; manuallyModified?: boolean;
        }> | null ?? [];
        const filtered = existing.filter(r => r.username.toLowerCase() !== author.toLowerCase());
        await persistStrategy(token, [existing.find(r => r.username.toLowerCase() === author.toLowerCase()) ?? { username: author, enabled: true, category, manuallyModified: true }, ...filtered]);
      }
      setStatus("success");
      onAdded();
    } catch {
      setErrorMsg("Speichern fehlgeschlagen");
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", color: C.purple, fontSize: "0.75rem", fontWeight: 600 }}>
        <span>✓</span><span>Hinzugefügt</span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.3rem", minWidth: "130px" }}>
      <select
        value={category}
        onChange={e => setCategory(e.target.value)}
        style={{
          fontSize: "0.68rem", padding: "0.15rem 0.3rem", borderRadius: "3px",
          border: `1px solid ${C.border}`, background: C.card, color: C.text,
          cursor: "pointer",
        }}
      >
        {STRATEGY_CATEGORIES.map(c => (
          <option key={c.value} value={c.value}>{c.label}</option>
        ))}
      </select>
      <button
        type="button"
        disabled={status === "loading"}
        onClick={() => void handleAdd()}
        style={{
          background: C.purple + "18", border: `1px solid ${C.purple}55`,
          color: C.purple, borderRadius: "4px", cursor: "pointer",
          fontSize: "0.72rem", fontWeight: 700, padding: "0.2rem 0.5rem",
          opacity: status === "loading" ? 0.6 : 1,
        }}
      >
        {status === "loading" ? "…" : "+ Strategie"}
      </button>
      {status === "error" && (
        <div style={{ fontSize: "0.62rem", color: C.red }}>{errorMsg}</div>
      )}
    </div>
  );
}

// ── Action cell ───────────────────────────────────────────────────────────────

function ActionCell({ opp, token, onAddToStrategy }: {
  opp: OpportunityEntry; token: string;
  onAddToStrategy?: (author: string, category: string) => void;
}) {
  const [voteOpen,     setVoteOpen]     = useState(false);
  const [strategyOpen, setStrategyOpen] = useState(false);
  const [voted,        setVoted]        = useState(opp.alreadyVoted);
  const [inStrategy,   setInStrategy]   = useState(opp.inMyStrategy);

  return (
    <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.35rem", minWidth: "130px" }}>

      {/* Vote action */}
      {voted ? (
        <span style={{ fontSize: "0.7rem", color: C.dim, fontStyle: "italic" }}>Bereits gevoted</span>
      ) : voteOpen ? (
        <VotePanel
          opp={opp}
          token={token}
          onVoted={() => { setVoted(true); setVoteOpen(false); }}
        />
      ) : (
        <button
          type="button"
          onClick={() => { setVoteOpen(true); setStrategyOpen(false); }}
          style={{
            background: C.ok + "18", border: `1px solid ${C.ok}55`,
            color: C.ok, borderRadius: "4px", cursor: "pointer",
            fontSize: "0.72rem", fontWeight: 700, padding: "0.22rem 0.55rem",
          }}
        >
          Vote
        </button>
      )}

      {/* Strategy action */}
      {inStrategy ? (
        <span style={{ fontSize: "0.65rem", color: C.purple, fontWeight: 600 }}>
          ✓ In Strategie{opp.myCategory ? ` (${opp.myCategory})` : ""}
        </span>
      ) : strategyOpen ? (
        <AddToStrategyPanel
          author={opp.author}
          token={token}
          onAddToStrategy={onAddToStrategy}
          onAdded={() => { setInStrategy(true); setStrategyOpen(false); }}
        />
      ) : (
        <button
          type="button"
          onClick={() => { setStrategyOpen(true); setVoteOpen(false); }}
          style={{
            background: "transparent", border: `1px solid ${C.border}`,
            color: C.dim, borderRadius: "4px", cursor: "pointer",
            fontSize: "0.68rem", fontWeight: 600, padding: "0.18rem 0.45rem",
          }}
        >
          + Strategie
        </button>
      )}
    </div>
  );
}

// ── Single opportunity row ─────────────────────────────────────────────────────

function OpportunityRow({ opp, idx, expanded, onToggle, t, token, onAddToStrategy }: {
  opp:              OpportunityEntry;
  idx:              number;
  expanded:         boolean;
  onToggle:         () => void;
  t:                T;
  token:            string | null;
  onAddToStrategy?: (author: string, category: string) => void;
}) {
  const badge   = scoreBadge(opp.opportunityScore);
  const reasons = topReasons(opp.components, t);

  return (
    <>
      <tr style={{
        borderBottom: expanded ? "none" : `1px solid ${C.border}`,
        background: expanded ? "#f0f9ff" : idx % 2 === 0 ? "transparent" : C.tag,
      }}>
        {/* Rank */}
        <td style={{ padding: "0.5rem 0.4rem", textAlign: "center" as const, color: C.faint, fontSize: "0.72rem", fontWeight: 700 }}>
          {idx + 1}
        </td>

        {/* Post */}
        <td style={{ padding: "0.5rem 0.6rem", maxWidth: "240px" }}>
          <a
            href={`https://steemit.com/@${opp.author}/${opp.permlink}`}
            target="_blank" rel="noreferrer"
            style={{ color: C.info, fontWeight: 700, fontSize: "0.82rem", textDecoration: "none",
              display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const,
              maxWidth: "220px" }}
            title={opp.title}
          >
            {opp.title || `@${opp.author}`}
          </a>
          <div style={{ fontSize: "0.68rem", color: C.faint, marginTop: "0.1rem" }}>
            @{opp.author}
            {opp.inMyStrategy && (
              <span style={{ marginLeft: "0.4rem", color: C.ok, fontWeight: 600 }}>{t("oppInStrategy")}</span>
            )}
            {opp.alreadyVoted && (
              <span style={{ marginLeft: "0.4rem", color: C.dim }}>{t("oppAlreadyVoted")}</span>
            )}
          </div>
        </td>

        {/* Score — clickable to expand */}
        <td style={{ padding: "0.5rem 0.6rem", textAlign: "center" as const }}>
          <button
            type="button"
            onClick={onToggle}
            title={t("oppLegendTitle")}
            style={{
              display: "inline-flex", flexDirection: "column" as const, alignItems: "center",
              background: expanded ? "#bfdbfe" : badge.bg,
              color: expanded ? "#1d4ed8" : badge.color,
              fontWeight: 800, fontSize: "1rem", borderRadius: "8px",
              padding: "0.2rem 0.6rem", minWidth: "42px",
              border: `1.5px solid ${expanded ? "#93c5fd" : "transparent"}`,
              cursor: "pointer",
            }}
          >
            {opp.opportunityScore}
            <span style={{ fontSize: "0.52rem", fontWeight: 500, opacity: 0.7 }}>{expanded ? "▲" : "▼"}</span>
          </button>
          <ScoreBreakdown c={opp.components} />
        </td>

        {/* Expected GF */}
        <td style={{ padding: "0.5rem 0.6rem", textAlign: "right" as const, fontWeight: 700,
          color: opp.authorAvgGf != null ? gfColor(opp.authorAvgGf) : C.faint }}>
          {opp.authorAvgGf != null
            ? `${opp.authorAvgGf.toFixed(2)}×`
            : <span style={{ color: C.faint, fontWeight: 400, fontSize: "0.72rem" }}>—</span>}
          {opp.authorAvgGf != null && opp.authorGfSampleN > 0 && (
            <div style={{ fontSize: "0.6rem", color: C.faint, fontWeight: 400 }}>n={opp.authorGfSampleN}</div>
          )}
        </td>

        {/* Whales */}
        <td style={{ padding: "0.5rem 0.6rem", textAlign: "center" as const }}>
          {opp.whaleCount > 0 ? (
            <span style={{
              fontWeight: 700, fontSize: "0.85rem",
              color: opp.whaleCount >= 5 ? C.ok : opp.whaleCount >= 3 ? C.warn : C.dim,
            }}>
              {opp.whaleCount}
            </span>
          ) : <span style={{ color: C.faint }}>—</span>}
        </td>

        {/* Timing */}
        <td style={{ padding: "0.5rem 0.6rem", fontSize: "0.78rem" }}>
          <div style={{ color: opp.ageMinutes <= 60 ? C.ok : opp.ageMinutes <= 360 ? C.warn : C.dim, fontWeight: 600 }}>
            {fmtAge(opp.ageMinutes, t)} {t("oppAgeLabel")}
          </div>
          <div style={{ color: C.faint, fontSize: "0.68rem" }}>
            {fmtRemaining(opp.remainingHours, t)} {t("oppRemainingLabel")}
          </div>
        </td>

        {/* Pending payout */}
        <td style={{ padding: "0.5rem 0.6rem", textAlign: "right" as const, fontWeight: 600, fontSize: "0.82rem",
          color: opp.pendingPayoutSbd < 0.5 ? C.ok : opp.pendingPayoutSbd < 5 ? C.warn : C.dim }}>
          {opp.pendingPayoutSbd > 0 ? `${opp.pendingPayoutSbd.toFixed(2)} SBD` : "—"}
        </td>

        {/* Community */}
        <td style={{ padding: "0.5rem 0.6rem", fontSize: "0.72rem", color: C.dim, maxWidth: "100px" }}>
          {opp.community
            ? <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }} title={opp.community}>{opp.community}</span>
            : <span style={{ color: C.faint }}>—</span>}
        </td>

        {/* Reason */}
        <td style={{ padding: "0.5rem 0.6rem" }}>
          <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.15rem" }}>
            {reasons.map((r, i) => (
              <span key={i} style={{ fontSize: "0.72rem", color: C.text }}>
                <span style={{ color: C.ok, fontWeight: 700, marginRight: "0.2rem" }}>·</span>{r}
              </span>
            ))}
          </div>
        </td>

        {/* Actions */}
        <td style={{ padding: "0.4rem 0.6rem", verticalAlign: "top" as const }}>
          {token
            ? <ActionCell opp={opp} token={token} onAddToStrategy={onAddToStrategy} />
            : <span style={{ color: C.faint, fontSize: "0.68rem" }}>Login erforderlich</span>
          }
        </td>
      </tr>

      {/* Expanded detail row */}
      {expanded && (
        <tr style={{ borderBottom: `1px solid ${C.border}` }}>
          <td colSpan={10} style={{ padding: 0 }}>
            <ScoreDetail opp={opp} t={t} />
          </td>
        </tr>
      )}
    </>
  );
}

// ── Main View ─────────────────────────────────────────────────────────────────

export function OpportunitiesView({ data, loading, locale, session, onAddToStrategy }: {
  data:              OpportunitiesData | null;
  loading:           boolean;
  locale?:           Locale;
  session?:          AuthSession | null;
  onAddToStrategy?:  (author: string, category: string) => void;
}) {
  const t = createTranslator(locale ?? "de");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const thStyle: React.CSSProperties = {
    textAlign: "left", padding: "0.4rem 0.6rem",
    color: C.dim, fontWeight: 600, fontSize: "0.72rem",
    whiteSpace: "nowrap" as const,
  };

  return (
    <div style={{ padding: "1.25rem 1.5rem", maxWidth: "1200px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", marginBottom: "0.5rem", flexWrap: "wrap" as const }}>
        <h2 style={{ fontSize: "1.15rem", fontWeight: 800, color: C.text, margin: 0 }}>
          {t("oppTitle")}
        </h2>
        {data && (
          <span style={{ fontSize: "0.72rem", color: C.dim }}>
            {data.opportunities.length > 0 && `${t("oppCacheAge")} ${data.cacheAgeMinutes ?? "?"} ${t("oppCacheAgeMin")} · `}
            {data.totalInCache} {t("oppTotalCached")}
          </span>
        )}
      </div>
      <p style={{ fontSize: "0.78rem", color: C.faint, margin: "0 0 0.85rem 0" }}>
        {t("oppSubtitle")}
      </p>

      {/* Legend */}
      <LegendPanel t={t} />

      {loading && (
        <div style={{ padding: "3rem", textAlign: "center", color: C.dim, fontSize: "0.85rem" }}>
          {t("oppLoading")}
        </div>
      )}

      {!loading && (!data || data.opportunities.length === 0) && (
        <div style={{
          padding: "3rem", textAlign: "center", background: C.card,
          border: `1px solid ${C.border}`, borderRadius: "12px",
          color: C.dim, fontSize: "0.85rem", lineHeight: 1.6,
        }}>
          <div style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>🔍</div>
          {t("oppEmpty")}
        </div>
      )}

      {!loading && data && data.opportunities.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
            <thead>
              <tr style={{ borderBottom: `2px solid ${C.border}` }}>
                <th style={{ ...thStyle, textAlign: "center", width: "32px" }}>#</th>
                <th style={thStyle}>{t("oppColPost")}</th>
                <th style={{ ...thStyle, textAlign: "center" }}>
                  {t("oppColAttractiveness")}
                  <span style={{ color: C.faint, fontWeight: 400, fontSize: "0.62rem", marginLeft: "0.3rem", display: "block" }}>▼ Detail</span>
                </th>
                <th style={{ ...thStyle, textAlign: "right" }} title={t("oppGfTip")}>{t("oppColGf")} ⓘ</th>
                <th style={{ ...thStyle, textAlign: "center" }}>{t("oppColWhales")}</th>
                <th style={thStyle}>{t("oppColTiming")}</th>
                <th style={{ ...thStyle, textAlign: "right" }}>{t("oppColPayout")}</th>
                <th style={thStyle}>{t("oppColCommunity")}</th>
                <th style={thStyle}>{t("oppColReason")}</th>
                <th style={{ ...thStyle, textAlign: "center" }}>Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {data.opportunities.map((opp, i) => {
                const key = `${opp.author}/${opp.permlink}`;
                return (
                  <OpportunityRow
                    key={key}
                    opp={opp}
                    idx={i}
                    expanded={expandedKey === key}
                    onToggle={() => setExpandedKey(k => k === key ? null : key)}
                    t={t}
                    token={session?.token ?? null}
                    onAddToStrategy={onAddToStrategy}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
