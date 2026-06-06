// ── CommunityView — AuthorCard, WhaleSignalSection, CommunityDiscoverySection ─
// Extracted from App.tsx — community discovery and whale signals

import React, { useState } from "react";
import { createTranslator, type Locale } from "../i18n";
import type {
  AuthorDiscoveryCard,
  CommunityDiscovery,
  WhaleSignalsData,
  WhaleSignalEntry,
} from "../api";
import { type StrategyCategory, categoryLabel, categoryColor } from "./strategyTypes";

// ── Community Discovery Section ───────────────────────────────────────────────

const CD = {
  bg:     "#f8fafc",
  card:   "#ffffff",
  border: "#e2e8f0",
  text:   "#1e293b",
  dim:    "#64748b",
  faint:  "#94a3b8",
  ok:     "#16a34a",
  info:   "#2563eb",
  warn:   "#d97706",
  purple: "#7c3aed",
  tag:    "#f1f5f9",
};

const cdCard: React.CSSProperties = {
  background: CD.card,
  border: `1px solid ${CD.border}`,
  borderRadius: "10px",
  padding: "0.85rem 1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
};

const catColor: Record<string, string> = {
  immer_voten:    "#16a34a",
  lieblingsautor: "#7c3aed",
  bevorzugt:      "#2563eb",
  normal:         "#64748b",
  niedrig:        "#94a3b8",
};

export function AuthorCard({ card, onAdd }: {
  card: AuthorDiscoveryCard;
  onAdd: (username: string, cat: StrategyCategory) => void;
}) {
  const [picking, setPicking] = useState(false);
  const categories: { value: StrategyCategory; label: string }[] = [
    { value: "lieblingsautor", label: "Lieblingsautor" },
    { value: "bevorzugt",      label: "Bevorzugt" },
    { value: "normal",         label: "Normal" },
    { value: "niedrig",        label: "Niedrig" },
  ];

  return (
    <div style={cdCard}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <a
            href={`https://steemit.com/@${card.username}`}
            target="_blank" rel="noreferrer"
            style={{ color: CD.info, fontWeight: 700, fontSize: "0.92rem", textDecoration: "none" }}
          >
            @{card.username}
          </a>
          {card.topCategory && (
            <span style={{
              marginLeft: "0.5rem", fontSize: "0.68rem", fontWeight: 600,
              color: catColor[card.topCategory] ?? CD.dim,
              background: (catColor[card.topCategory] ?? CD.dim) + "18",
              borderRadius: "4px", padding: "0.1rem 0.4rem",
            }}>
              {card.topCategoryLabel}
            </span>
          )}
        </div>
        <div style={{ fontSize: "0.72rem", color: CD.dim, whiteSpace: "nowrap" }}>
          {card.curatorCount === 1 ? "1 Kurator" : `${card.curatorCount} Kuratoren`}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
        {card.reasons.map((r, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: "0.3rem", fontSize: "0.75rem", color: CD.dim }}>
            <span style={{ color: CD.ok, fontWeight: 700 }}>·</span> {r}
          </div>
        ))}
      </div>

      {!picking ? (
        <button
          onClick={() => setPicking(true)}
          style={{
            marginTop: "0.25rem", alignSelf: "flex-start",
            background: CD.info + "12", border: `1px solid ${CD.info}30`,
            borderRadius: "6px", color: CD.info, cursor: "pointer",
            fontSize: "0.72rem", fontWeight: 600, padding: "0.2rem 0.6rem",
          }}
        >
          + Zur Strategie
        </button>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.3rem", marginTop: "0.25rem" }}>
          {categories.map(c => (
            <button
              key={c.value}
              onClick={() => { onAdd(card.username, c.value); setPicking(false); }}
              style={{
                background: (catColor[c.value] ?? CD.dim) + "15",
                border: `1px solid ${catColor[c.value] ?? CD.dim}40`,
                borderRadius: "5px", color: catColor[c.value] ?? CD.dim,
                cursor: "pointer", fontSize: "0.68rem", fontWeight: 600,
                padding: "0.15rem 0.5rem",
              }}
            >
              {c.label}
            </button>
          ))}
          <button
            onClick={() => setPicking(false)}
            style={{ background: "none", border: "none", color: CD.faint, cursor: "pointer", fontSize: "0.68rem" }}
          >
            Abbrechen
          </button>
        </div>
      )}
    </div>
  );
}

// ── Whale Signal Section ──────────────────────────────────────────────────────

export function WhaleSignalSection({ data, loading, onAddToStrategy, t }: {
  data:            WhaleSignalsData | null;
  loading:         boolean;
  onAddToStrategy: (username: string, category: StrategyCategory) => void;
  t:               ReturnType<typeof createTranslator>;
}) {
  const [addedAuthors, setAddedAuthors] = useState<Set<string>>(new Set());
  const [adding, setAdding]             = useState<string | null>(null);
  const [expandedAuthor, setExpandedAuthor] = useState<string | null>(null);
  const [explainOpen, setExplainOpen]   = useState(false);

  if (loading) return (
    <div style={{ padding: "2rem", textAlign: "center", color: CD.dim, fontSize: "0.85rem" }}>
      {t("whaleActiveVoters")}…
    </div>
  );

  if (!data || data.authorsFound === 0) return null;

  const age = data.computedAt
    ? Math.round((Date.now() - new Date(data.computedAt).getTime()) / 3_600_000)
    : null;

  function handleAdd(author: string) {
    if (adding === author) return;
    setAdding(author);
    try {
      onAddToStrategy(author, "normal");
      setAddedAuthors(prev => new Set([...prev, author]));
    } finally {
      setAdding(null);
    }
  }

  function trustScore(whaleCount: number): { label: string; color: string; bg: string } {
    if (whaleCount >= 5) return { label: t("whaleScoreHigh"),   color: "#15803d", bg: "#dcfce7" };
    if (whaleCount >= 3) return { label: t("whaleScoreMedium"), color: "#854d0e", bg: "#fef9c3" };
    return                      { label: t("whaleScoreLow"),    color: CD.dim,    bg: CD.tag   };
  }

  return (
    <div>
      {/* ── Header + Meta ── */}
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", marginBottom: "0.5rem", flexWrap: "wrap" as const }}>
        <h2 style={{ fontSize: "1.15rem", fontWeight: 800, color: CD.text, margin: 0 }}>
          {t("whaleTitle")}
        </h2>
        <span style={{ fontSize: "0.72rem", color: CD.dim }}>
          {data.trackedWhales.length} {t("whaleActiveVoters")} · {data.authorsFound} {t("whaleAuthorsFound")} · {data.periodDays} {t("whalePeriodDays")}
          {age !== null && age < 48 && ` · ${t("whaleDataAge")} ${age}${t("whaleDataAgeH")}`}
        </span>
        <button
          type="button"
          onClick={() => setExplainOpen(o => !o)}
          style={{ marginLeft: "auto", background: "none", border: `1px solid ${CD.border}`,
            borderRadius: "6px", color: CD.dim, cursor: "pointer", fontSize: "0.7rem",
            padding: "0.15rem 0.5rem" }}
        >{explainOpen ? "▲" : "▼"} {t("whaleExplainTitle")}</button>
      </div>

      {/* ── Mini-Tutorial (ausklappbar) ── */}
      {explainOpen && (
        <div style={{
          background: "#f0f9ff", border: `1px solid #bae6fd`, borderRadius: "12px",
          padding: "1rem 1.25rem", marginBottom: "1rem",
          display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem",
        }}>
          {/* Wie funktioniert es */}
          <div>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "#0369a1", marginBottom: "0.5rem", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
              {t("whaleExplainTitle").replace("🐋 ", "")}
            </div>
            <ol style={{ margin: 0, paddingLeft: "1.2rem", fontSize: "0.78rem", color: "#0c4a6e", lineHeight: 1.6 }}>
              {(["whaleExplainStep1","whaleExplainStep2","whaleExplainStep3","whaleExplainStep4"] as const).map(k => (
                <li key={k} style={{ marginBottom: "0.2rem" }}>{t(k)}</li>
              ))}
            </ol>
            <div style={{ marginTop: "0.65rem", padding: "0.5rem 0.75rem", background: "#e0f2fe", borderRadius: "8px", fontSize: "0.72rem", color: "#075985", fontStyle: "italic" }}>
              💡 {t("whaleExplainExample")}
            </div>
          </div>
          {/* Warum nützlich */}
          <div>
            <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "#0369a1", marginBottom: "0.5rem", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
              {t("whaleExplainWhyTitle")}
            </div>
            <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.3rem" }}>
              {(["whaleBenefitEarly","whaleBenefitTrends","whaleBenefitExpand","whaleBenefitCuration","whaleBenefitLess"] as const).map(k => (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.78rem", color: "#0c4a6e" }}>
                  <span style={{ color: "#0ea5e9", fontWeight: 700, flexShrink: 0 }}>✓</span>
                  {t(k)}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Tabelle ── */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
          <thead>
            <tr style={{ borderBottom: `2px solid ${CD.border}` }}>
              <th style={{ textAlign: "left", padding: "0.4rem 0.6rem", color: CD.dim, fontWeight: 600, fontSize: "0.72rem" }}>{t("whaleColAuthor")}</th>
              <th style={{ textAlign: "center", padding: "0.4rem 0.6rem", color: CD.dim, fontWeight: 600, fontSize: "0.72rem" }}
                  title={t("whaleSignalTooltip")}>{t("whaleColSignalVoters")} ⓘ</th>
              <th style={{ textAlign: "center", padding: "0.4rem 0.6rem", color: CD.dim, fontWeight: 600, fontSize: "0.72rem" }}>{t("whaleColVotes")}</th>
              <th style={{ textAlign: "left", padding: "0.4rem 0.6rem", color: CD.dim, fontWeight: 600, fontSize: "0.72rem" }}>{t("whaleColInStrategy")}</th>
              <th style={{ padding: "0.4rem 0.6rem" }}></th>
            </tr>
          </thead>
          <tbody>
            {data.signals.slice(0, 30).map((s: WhaleSignalEntry, i: number) => {
              const inStrategy = s.inMyStrategy || addedAuthors.has(s.author);
              const isAdding   = adding === s.author;
              const trust      = trustScore(s.whaleCount);
              const expanded   = expandedAuthor === s.author;
              return (
                <React.Fragment key={s.author}>
                  <tr style={{
                    borderBottom: expanded ? "none" : `1px solid ${CD.border}`,
                    background: i % 2 === 0 ? "transparent" : CD.tag,
                    cursor: "pointer",
                  }} onClick={() => setExpandedAuthor(expanded ? null : s.author)}>
                    <td style={{ padding: "0.45rem 0.6rem" }}>
                      <div style={{ fontWeight: 700 }}>
                        <a href={`https://steemit.com/@${s.author}`} target="_blank" rel="noreferrer"
                          onClick={e => e.stopPropagation()}
                          style={{ color: CD.info, textDecoration: "none" }}>
                          @{s.author}
                        </a>
                      </div>
                      <div style={{ fontSize: "0.68rem", color: CD.faint, marginTop: "0.1rem" }}>
                        {s.whales.slice(0, 3).join(", ")}{s.whales.length > 3 ? ` +${s.whales.length - 3}` : ""}
                      </div>
                    </td>
                    <td style={{ textAlign: "center", padding: "0.45rem 0.6rem" }}>
                      <div style={{ display: "flex", flexDirection: "column" as const, alignItems: "center", gap: "0.15rem" }}>
                        <span style={{
                          background: trust.bg, color: trust.color,
                          fontWeight: 800, borderRadius: "999px",
                          padding: "0.1rem 0.6rem", fontSize: "0.85rem",
                        }}>{s.whaleCount}</span>
                        <span style={{ fontSize: "0.62rem", color: trust.color, fontWeight: 600 }}>{trust.label}</span>
                      </div>
                    </td>
                    <td style={{ textAlign: "center", padding: "0.45rem 0.6rem", color: CD.text, fontWeight: 600 }}>
                      {s.totalWhaleVotes}
                    </td>
                    <td style={{ padding: "0.45rem 0.6rem" }}>
                      {inStrategy
                        ? <span style={{ color: CD.ok, fontWeight: 700, fontSize: "0.75rem" }}>{t("whaleInStrategy")}</span>
                        : <span style={{ color: CD.faint, fontSize: "0.72rem" }}>{t("whaleNotInStrategy")}</span>}
                    </td>
                    <td style={{ padding: "0.45rem 0.6rem", textAlign: "right" as const }}>
                      {!inStrategy && (
                        <button
                          disabled={isAdding}
                          onClick={e => { e.stopPropagation(); handleAdd(s.author); }}
                          style={{
                            fontSize: "0.72rem", padding: "0.25rem 0.65rem",
                            background: isAdding ? CD.dim : CD.info, color: "#fff",
                            border: "none", borderRadius: "6px",
                            cursor: isAdding ? "default" : "pointer",
                            opacity: isAdding ? 0.7 : 1, fontWeight: 700,
                          }}
                        >{isAdding ? t("whaleAdding") : t("whaleAdd")}</button>
                      )}
                    </td>
                  </tr>
                  {/* ── Expandierter "Warum empfohlen?" Block ── */}
                  {expanded && (
                    <tr style={{ borderBottom: `1px solid ${CD.border}` }}>
                      <td colSpan={5} style={{ padding: "0.5rem 0.8rem 0.75rem 2.5rem", background: "#f8fafc" }}>
                        <div style={{ fontSize: "0.72rem", fontWeight: 700, color: CD.dim, marginBottom: "0.35rem" }}>
                          {t("whaleWhyTitle")} @{s.author}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.2rem" }}>
                          <span style={{ fontSize: "0.75rem", color: CD.text }}>
                            ✓ {t("whaleWhyVotedBy").replace("{{n}}", String(s.whaleCount))}
                          </span>
                          <span style={{ fontSize: "0.75rem", color: CD.text }}>
                            ✓ {t("whaleWhyTotalVotes").replace("{{n}}", String(s.totalWhaleVotes))}
                          </span>
                          {!inStrategy && (
                            <span style={{ fontSize: "0.75rem", color: CD.warn }}>
                              ✓ {t("whaleWhyNotInStrategy")}
                            </span>
                          )}
                          {s.whales.length > 0 && (
                            <span style={{ fontSize: "0.72rem", color: CD.faint, marginTop: "0.1rem" }}>
                              {t("whaleColVoters")}: {s.whales.join(", ")}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CommunityDiscoverySection({ discovery, loading, onAddToStrategy, locale }: {
  discovery: CommunityDiscovery | null;
  loading: boolean;
  onAddToStrategy: (username: string, category: StrategyCategory) => void;
  locale?: import("../i18n").Locale;
}) {
  const t = createTranslator(locale ?? "de");
  const hdr: React.CSSProperties = {
    fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase",
    letterSpacing: "0.06em", color: CD.dim, marginBottom: "0.6rem",
  };

  if (loading) {
    return (
      <div style={{ padding: "3rem", textAlign: "center", color: CD.dim, fontSize: "0.88rem" }}>
        {t("communityLoading")}
      </div>
    );
  }

  if (!discovery) {
    return (
      <div style={{ padding: "3rem", textAlign: "center", color: CD.dim, fontSize: "0.88rem" }}>
        {t("communityError")}
      </div>
    );
  }

  const { communityAuthors, discoveries, meta } = discovery;
  const hasAnything = communityAuthors.length > 0 || discoveries.length > 0;

  return (
    <div style={{ maxWidth: "960px", margin: "0 auto" }}>

      {/* Header */}
      <div style={{ marginBottom: "1.25rem" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "0.75rem" }}>
          <h2 style={{ fontSize: "1.15rem", fontWeight: 800, color: CD.text, margin: 0 }}>
            {t("communityTitle")}
          </h2>
          <span style={{ fontSize: "0.75rem", color: CD.dim }}>
            {meta.totalCurators} {meta.totalCurators === 1 ? t("communityKuratorSing") : t("communityKuratorPlur")} · {meta.myAuthorCount} {t("communityInStrategy")}
          </span>
        </div>
        {meta.dataQuality !== "rich" && (
          <div style={{
            marginTop: "0.6rem", padding: "0.5rem 0.75rem",
            background: "#fef9c3", border: "1px solid #fde047",
            borderRadius: "8px", fontSize: "0.78rem", color: "#713f12",
          }}>
            {meta.dataQuality === "empty"
              ? t("communityNoticeEmpty")
              : t("communityNoticeSparse").replace("{{n}}", String(meta.totalCurators))}
          </div>
        )}
      </div>

      {!hasAnything ? (
        <div style={{
          padding: "3rem", textAlign: "center", background: CD.card,
          border: `1px solid ${CD.border}`, borderRadius: "12px",
          color: CD.dim, fontSize: "0.88rem",
        }}>
          <div style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>🔍</div>
          {t("communityEmptyTitle")}<br />
          <span style={{ fontSize: "0.78rem" }}>
            {t("communityEmptySub")}
          </span>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", alignItems: "start" }}>

          {/* Left: Community Authors (≥2 strategies) */}
          <div>
            <div style={hdr}>
              {t("communityGemeinschaft")}
              {communityAuthors.length > 0 && (
                <span style={{ color: CD.ok, marginLeft: "0.4rem" }}>· {communityAuthors.length}</span>
              )}
            </div>
            <p style={{ fontSize: "0.75rem", color: CD.faint, marginBottom: "0.75rem", marginTop: 0 }}>
              {t("communityGemSub")}
            </p>
            {communityAuthors.length === 0 ? (
              <div style={{ padding: "1.5rem", background: CD.tag, borderRadius: "10px", textAlign: "center", color: CD.dim, fontSize: "0.8rem" }}>
                {t("communityGemEmpty")}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                {communityAuthors.map(c => (
                  <AuthorCard key={c.username} card={c} onAdd={onAddToStrategy} />
                ))}
              </div>
            )}
          </div>

          {/* Right: Discoveries (in other strategies, not mine) */}
          <div>
            <div style={hdr}>
              {t("communityDiscoveries")}
              {discoveries.length > 0 && (
                <span style={{ color: CD.info, marginLeft: "0.4rem" }}>· {discoveries.length}</span>
              )}
            </div>
            <p style={{ fontSize: "0.75rem", color: CD.faint, marginBottom: "0.75rem", marginTop: 0 }}>
              {t("communityDiscSub")}
            </p>
            {discoveries.length === 0 ? (
              <div style={{ padding: "1.5rem", background: CD.tag, borderRadius: "10px", textAlign: "center", color: CD.dim, fontSize: "0.8rem" }}>
                {t("communityDiscEmpty")}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                {discoveries.map(c => (
                  <AuthorCard key={c.username} card={c} onAdd={onAddToStrategy} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{ marginTop: "1.25rem", fontSize: "0.68rem", color: CD.faint, textAlign: "right" }}>
        {t("communityFooterAt")} {new Date(discovery.computedAt).toLocaleTimeString(locale ?? "de", { hour: "2-digit", minute: "2-digit" })}{t("communityFooterUhr") ? ` ${t("communityFooterUhr")}` : ""}
        {" · "}{t("communityFooterDev")}
      </div>
    </div>
  );
}

export function SummaryCard(props: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <section className="summary-card">
      <div className="summary-icon">{props.icon}</div>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <p>{props.detail}</p>
    </section>
  );
}
