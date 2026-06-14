// ── OpportunitiesView — Top Opportunities from blockchain ──────────────────────
// Displays top-N scored posts; cache refreshed every 30 min server-side.
// Score components explain WHY a post is interesting (not an auto-vote signal).

import React from "react";
import { createTranslator, type Locale } from "../i18n";
import type { OpportunitiesData, OpportunityEntry, OpportunityComponents } from "../api";

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

// ── Score badge ───────────────────────────────────────────────────────────────

function scoreBadge(score: number): { bg: string; color: string } {
  if (score >= 75) return { bg: "#dcfce7", color: "#15803d" };
  if (score >= 55) return { bg: "#fef9c3", color: "#92400e" };
  if (score >= 35) return { bg: "#e0f2fe", color: "#0369a1" };
  return { bg: C.tag, color: C.dim };
}

// ── Top 1-2 reasons from score components ─────────────────────────────────────

function topReasons(
  c: OpportunityComponents,
  t: ReturnType<typeof createTranslator>,
): string[] {
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

function fmtAge(minutes: number, t: ReturnType<typeof createTranslator>): string {
  if (minutes < 60) return `${Math.round(minutes)} ${t("oppMinAgo")}`;
  return `${(minutes / 60).toFixed(1)} ${t("oppHAgo")}`;
}

function fmtRemaining(hours: number, t: ReturnType<typeof createTranslator>): string {
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
  const items = [
    { label: "Pool",    pts: c.payoutSweetspot, max: 35 },
    { label: "Timing",  pts: c.timing,          max: 25 },
    { label: "Signal",  pts: c.signalCurators,  max: 20 },
    { label: "Disc.",   pts: c.discovery,        max: 10 },
    { label: "Autor",   pts: c.authorHistory,   max: 10 },
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

// ── Single opportunity row ─────────────────────────────────────────────────────

function OpportunityRow({ opp, idx, t }: {
  opp: OpportunityEntry;
  idx: number;
  t:   ReturnType<typeof createTranslator>;
}) {
  const badge   = scoreBadge(opp.opportunityScore);
  const reasons = topReasons(opp.components, t);

  return (
    <tr style={{
      borderBottom: `1px solid ${C.border}`,
      background: idx % 2 === 0 ? "transparent" : C.tag,
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

      {/* Score */}
      <td style={{ padding: "0.5rem 0.6rem", textAlign: "center" as const }}>
        <div style={{
          display: "inline-flex", flexDirection: "column" as const, alignItems: "center",
          background: badge.bg, color: badge.color,
          fontWeight: 800, fontSize: "1rem", borderRadius: "8px",
          padding: "0.2rem 0.6rem", minWidth: "42px",
        }}>
          {opp.opportunityScore}
        </div>
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
    </tr>
  );
}

// ── Main View ─────────────────────────────────────────────────────────────────

export function OpportunitiesView({ data, loading, locale }: {
  data:    OpportunitiesData | null;
  loading: boolean;
  locale?: Locale;
}) {
  const t = createTranslator(locale ?? "de");

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
      <p style={{ fontSize: "0.78rem", color: C.faint, margin: "0 0 1.25rem 0" }}>
        {t("oppSubtitle")}
      </p>

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
                <th style={{ ...thStyle, textAlign: "center" }} title={t("oppScoreTip")}>{t("oppColScore")} ⓘ</th>
                <th style={{ ...thStyle, textAlign: "right" }} title={t("oppGfTip")}>{t("oppColGf")} ⓘ</th>
                <th style={{ ...thStyle, textAlign: "center" }}>{t("oppColWhales")}</th>
                <th style={thStyle}>{t("oppColTiming")}</th>
                <th style={{ ...thStyle, textAlign: "right" }}>{t("oppColPayout")}</th>
                <th style={thStyle}>{t("oppColCommunity")}</th>
                <th style={thStyle}>{t("oppColReason")}</th>
              </tr>
            </thead>
            <tbody>
              {data.opportunities.map((opp, i) => (
                <OpportunityRow key={`${opp.author}/${opp.permlink}`} opp={opp} idx={i} t={t} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
