// ── VotePlanView — VotePlanSection, OpenVoteOpportunities, RecoveryBanner ──────
// Extracted from App.tsx — vote plan execution and opportunity scanning

import React, { useState, useEffect, useRef } from "react";
import { createTranslator } from "../i18n";
import type {
  VotePlanResponse,
  VotePlanEntry,
  ConstraintReport,
  PostOpportunity,
  SteemAccountSnapshot,
  AuthSession,
  OpportunitiesMeta,
} from "../api";
import { type StrategyCategory, type StrategyRule, categoryColor, categoryLabel } from "./strategyTypes";

export interface VoteBatchResult {
  ok:      number;
  failed:  number;
  skipped: number;
  results: Array<{
    author:         string;
    permlink:       string;
    status:         "success" | "failed" | "skipped";
    transactionId?: string;
    errorMessage?:  string;
    errorCode?:     string;
  }>;
}

export interface VoteTarget {
  author: string;
  permlink: string;
  title: string;
  ageMinutes: number;
  weightBps: number;
  category: StrategyCategory;
}

export function formatAge(minutes: number): string {
  if (minutes < 60)   return `vor ${minutes} Min.`;
  if (minutes < 1440) return `vor ${Math.round(minutes / 60)} Std.`;
  return `vor ${Math.round(minutes / 1440)} Tag(en)`;
}

// ── VotePlanSection — Plan → Preview → Confirm → Execute (sequential) ─────────

function RecoveryBanner({ report, t }: { report: ConstraintReport; t: ReturnType<typeof createTranslator> }) {
  if (!report.recoveryMode && report.weightReductionPct === 0) return null;

  const isRecovery = report.recoveryMode;
  const reduced    = report.weightReductionPct;
  const tomorrow   = report.expectedTomorrowVpPct;

  if (!isRecovery && reduced === 0) return null;

  let title = "";
  let body  = "";

  if (isRecovery && reduced > 0) {
    title = t("recoveryTitle");
    body  = t("recoveryBody").replace("{{reduction}}", String(reduced)).replace("{{tomorrow}}", String(tomorrow));
  } else if (isRecovery) {
    title = t("recoveryTitle");
    body  = t("recoveryBodyNoReduction");
  } else {
    title = t("adjustedTitle");
    body  = t("adjustedBody").replace("{{reduction}}", String(reduced)).replace("{{tomorrow}}", String(tomorrow));
  }

  return (
    <div style={{
      background: "#fffbeb", border: "1px solid #f59e0b44", borderRadius: "12px",
      padding: "0.85rem 1.1rem", marginBottom: "0.85rem",
    }}>
      <div style={{ color: "#92400e", fontWeight: 800, fontSize: "0.88rem", marginBottom: "0.25rem" }}>{title}</div>
      <div style={{ color: "#78350f", fontSize: "0.82rem", lineHeight: 1.55 }}>{body}</div>
    </div>
  );
}

function ConstraintBadge(props: { report: ConstraintReport }) {
  const r = props.report;
  const stopColor = r.stoppedBy === "none" ? "#16a34a" : "#d97706";
  const budget = r.dynamicBudgetPct ?? r.effectiveBudgetPct;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", fontSize: "0.73rem", marginBottom: "0.6rem" }}>
      <span style={{ background: "#dde8ed", border: "1px solid #30363d", borderRadius: "4px", color: "#607078", padding: "0.15rem 0.5rem" }}>
        Tages-Budget: <b style={{ color: "#17202a" }}>{budget.toFixed(1)}%</b>
      </span>
      <span style={{ background: "#dde8ed", border: "1px solid #30363d", borderRadius: "4px", color: "#607078", padding: "0.15rem 0.5rem" }}>
        Max Votes: <b style={{ color: "#17202a" }}>{r.maxVotesPerRun}</b>
      </span>
      {r.expectedTomorrowVpPct !== undefined && (
        <span style={{ background: "#dde8ed", border: "1px solid #30363d", borderRadius: "4px", color: "#607078", padding: "0.15rem 0.5rem" }}>
          VP morgen: <b style={{ color: r.expectedTomorrowVpPct >= 80 ? "#16a34a" : "#d97706" }}>{r.expectedTomorrowVpPct}%</b>
        </span>
      )}
      {r.excludedVotes > 0 && (
        <span style={{ background: stopColor + "22", border: `1px solid ${stopColor}55`, borderRadius: "4px", color: stopColor, padding: "0.15rem 0.5rem", fontWeight: 600 }}>
          ⚠ {r.excludedVotes} übersprungen — {r.stoppedByLabel}
        </span>
      )}
      {r.stoppedBy === "none" && r.includedVotes > 0 && (
        <span style={{ background: "#1b4332", border: "1px solid #3fb95055", borderRadius: "4px", color: "#16a34a", padding: "0.15rem 0.5rem", fontWeight: 600 }}>
          ✓ {r.stoppedByLabel}
        </span>
      )}
    </div>
  );
}

const PLAN_CATEGORY_COLOR: Record<string, string> = {
  immer_voten: "#ff6b35", lieblingsautor: "#d97706",
  bevorzugt:   "#2563eb", normal:         "#16a34a", niedrig: "#607078",
};
const PLAN_CATEGORY_ICON: Record<string, string> = {
  immer_voten: "🔥", lieblingsautor: "⭐", bevorzugt: "🟦", normal: "⚪", niedrig: "⬇",
};

type PlanPhase = "idle" | "generated" | "confirming" | "executing" | "done";

interface VoteLogEntry {
  author: string; permlink: string; title: string;
  status: "sent" | "skipped" | "failed"; message: string;
}

export interface LivePlanMetrics {
  vpAfterPct: number;
  vpMorgenPct: number;
  vpCostPct: number;
  entryCount: number;
  hasEdits: boolean;
  freeBudgetPct: number;
}

type VoteDisplayMode = "pct" | "usd" | "sp";

export function VotePlanSection(props: {
  plan: VotePlanResponse | null;
  loading: boolean;
  error: string | null;
  session: AuthSession;
  currentVoteUsd?: number; // dollar value of a 100% vote at current VP — for override recalc
  sbdPerSteem?: number;    // SBD/STEEM — for SP conversion: expectedVoteUsd / sbdPerSteem ≈ SP
  onGenerate: () => void;
  onExecuteSingle: (target: { author: string; permlink: string; weightBps: number; strategyCategory?: string }) => Promise<{ transactionId: string }>;
  onPlanExecuted?: () => void;
  onMetricsChange?: (m: LivePlanMetrics) => void;
  additionalCandidates?: VotePlanEntry[];
  locale?: import("../i18n").Locale;
}) {
  const t = createTranslator(props.locale ?? "de");
  const [phase, setPhase]           = useState<PlanPhase>("idle");
  const [confirmed, setConfirmed]   = useState(false);
  const [execLog, setExecLog]       = useState<VoteLogEntry[]>([]);
  const [execIndex, setExecIndex]   = useState(0);
  const [aborted, setAborted]       = useState(false);
  const [overrides, setOverrides]   = useState<Map<string, number>>(new Map());
  const [additions, setAdditions]   = useState<VotePlanEntry[]>([]);  // manuell hinzugefügte Kandidaten
  const [excluded, setExcluded]     = useState<Set<string>>(new Set()); // manuell deaktivierte Votes
  const confirmingRef = useRef<HTMLDivElement>(null);

  // Display mode — persisted in localStorage
  const [voteMode, setVoteModeRaw] = useState<VoteDisplayMode>(() =>
    (window.localStorage.getItem("votebroker.voteDisplayMode") as VoteDisplayMode | null) ?? "pct"
  );
  const setVoteMode = (m: VoteDisplayMode) => {
    window.localStorage.setItem("votebroker.voteDisplayMode", m);
    setVoteModeRaw(m);
  };
  const sbdPerSteem    = props.sbdPerSteem    && props.sbdPerSteem    > 0 ? props.sbdPerSteem    : 0.05;
  const currentVoteUsd = props.currentVoteUsd && props.currentVoteUsd > 0 ? props.currentVoteUsd : 0;

  const chipBtn = {
    background: "#f0f5f7", border: "1px solid #dde8ed", borderRadius: "6px",
    color: "#607078", cursor: "pointer" as const, fontSize: "0.78rem", padding: "0.3rem 0.65rem",
  };
  const sectionLabel = {
    color: "#607078", fontSize: "0.75rem", textTransform: "uppercase" as const,
    letterSpacing: "0.5px", margin: 0, fontWeight: 600,
  };

  const plan = props.plan;
  const entries = plan?.plan ?? [];
  const sustainColor = { sustainable: "#16a34a", aggressive: "#d97706", critical: "#dc2626" }[plan?.summary.sustainability ?? "sustainable"];

  // ── Inline weight editor + additions helpers ─────────────────────────────
  const MANA_DIV = 5_000; // weight_bps / 5000 = VP cost %

  // Base plan entries with override weights applied.
  // expectedVoteUsd = (bps / 10_000) * currentVoteUsd  (dollar value of the vote)
  // Bug that was here: used currentVpPct/100 instead of currentVoteUsd → off by ~100×
  const effectiveEntries = entries.map(e => {
    const key = `${e.author}/${e.permlink}`;
    const bps = overrides.get(key) ?? e.suggestedWeightBps;
    const usd = currentVoteUsd > 0
      ? Math.round((bps / 10_000) * currentVoteUsd * 10_000) / 10_000
      : e.expectedVoteUsd * (bps / Math.max(1, e.suggestedWeightBps)); // fallback: scale original
    return { ...e, suggestedWeightBps: bps, suggestedWeightPct: Math.round(bps / 100 * 10) / 10,
      expectedVoteUsd: usd };
  });

  // Manually added entries (also support overrides)
  const additionEntries = additions.map(e => {
    const key = `${e.author}/${e.permlink}`;
    const bps = overrides.get(key) ?? e.suggestedWeightBps;
    const usd = currentVoteUsd > 0
      ? Math.round((bps / 10_000) * currentVoteUsd * 10_000) / 10_000
      : e.expectedVoteUsd * (bps / Math.max(1, e.suggestedWeightBps));
    return { ...e, suggestedWeightBps: bps, suggestedWeightPct: Math.round(bps / 100 * 10) / 10,
      expectedVoteUsd: usd };
  });

  // Full plan = base + added
  const allPlanEntries    = [...effectiveEntries, ...additionEntries];
  // Active = all entries that haven't been manually deactivated
  const activePlanEntries = allPlanEntries.filter(e => !excluded.has(`${e.author}/${e.permlink}`));

  const vpNowPct     = plan?.summary.currentVpPct ?? 0;
  const origVpCost   = entries.reduce((s, e) => s + e.suggestedWeightBps / MANA_DIV, 0);
  const effVpCost    = activePlanEntries.reduce((s, e) => s + e.suggestedWeightBps / MANA_DIV, 0);
  const origVpMorgen = Math.min(100, Math.round((vpNowPct - origVpCost + 20) * 10) / 10);
  const effVpMorgen  = Math.min(100, Math.round((vpNowPct - effVpCost  + 20) * 10) / 10);
  const savedVpPct   = Math.round((origVpCost - effVpCost) * 100) / 100;
  const hasEdits     = overrides.size > 0 || additions.length > 0 || excluded.size > 0;

  // Which additional candidates actually fit in the remaining budget?
  const dynamicBudget  = plan?.report.dynamicBudgetPct ?? 0;
  const addedKeys      = new Set(additions.map(e => `${e.author}/${e.permlink}`));
  let remainBudget     = Math.max(0, dynamicBudget - activePlanEntries.reduce((s, e) => s + e.suggestedWeightBps / MANA_DIV, 0));
  const fittingCandidates: VotePlanEntry[] = [];
  for (const c of (props.additionalCandidates ?? [])) {
    const key = `${c.author}/${c.permlink}`;
    if (addedKeys.has(key)) continue; // already added
    const cost = c.suggestedWeightBps / MANA_DIV;
    if (cost <= remainBudget + 0.001) {  // small tolerance for float rounding
      fittingCandidates.push(c);
      remainBudget -= cost;
    }
  }
  const addlPossible = fittingCandidates.length;

  function toggleExclude(key: string) {
    setExcluded(prev => {
      const s = new Set(prev);
      if (s.has(key)) s.delete(key); else s.add(key);
      return s;
    });
  }

  function adjustWeight(key: string, deltaBps: number) {
    const entry = entries.find(e => `${e.author}/${e.permlink}` === key);
    if (!entry) return;
    const current = overrides.get(key) ?? entry.suggestedWeightBps;
    const next = Math.max(500, Math.min(10_000, current + deltaBps));
    setOverrides(prev => new Map(prev).set(key, next));
  }
  function resetWeight(key: string) {
    setOverrides(prev => { const m = new Map(prev); m.delete(key); return m; });
  }

  // Transition to "generated" whenever a new plan arrives — auto-fill remaining budget
  useEffect(() => {
    if (plan !== null) {
      setPhase("generated");
      setConfirmed(false); setExecLog([]); setExecIndex(0); setAborted(false);
      setOverrides(new Map());

      // Auto-fill: add fitting candidates from pre-scanned opportunities into the plan.
      // The server plan only fetches independently — remaining budget often goes unused.
      // This bridges the gap between server-plan and client-side opportunities.
      const planKeys   = new Set(plan.plan.map(e => `${e.author}/${e.permlink}`));
      const planCost   = plan.plan.reduce((s, e) => s + e.suggestedWeightBps / 5_000, 0);
      let remaining    = Math.max(0, (plan.report.dynamicBudgetPct ?? 0) - planCost);
      const autoAdded: VotePlanEntry[] = [];
      for (const c of (props.additionalCandidates ?? [])) {
        if (planKeys.has(`${c.author}/${c.permlink}`)) continue;
        const cost = c.suggestedWeightBps / 5_000;
        if (cost <= remaining + 0.001) {
          autoAdded.push(c);
          remaining -= cost;
        }
      }
      setAdditions(autoAdded);

      // Preserve exclusions for author/permlink combos still present in the refreshed plan.
      // Drops exclusions for entries that no longer appear (post expired, voted, etc.).
      const newKeys = new Set([
        ...plan.plan.map(e => `${e.author}/${e.permlink}`),
        ...autoAdded.map(e => `${e.author}/${e.permlink}`),
      ]);
      setExcluded(prev => prev.size === 0 ? prev : new Set([...prev].filter(k => newKeys.has(k))));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  // Report live metrics upward — only when a plan exists (avoid showing 0%/20% before first plan)
  useEffect(() => {
    if (!props.onMetricsChange || !plan) return;
    const freeBudget = Math.max(0, Math.round((plan.report.dynamicBudgetPct - effVpCost) * 100) / 100);
    props.onMetricsChange({
      vpAfterPct:    Math.max(0, Math.round((vpNowPct - effVpCost) * 10) / 10),
      vpMorgenPct:   effVpMorgen,
      vpCostPct:     Math.round(effVpCost * 100) / 100,
      entryCount:    activePlanEntries.length,
      hasEdits,
      freeBudgetPct: freeBudget,
    });
  }, [overrides, plan, excluded]);

  useEffect(() => {
    if (phase === "confirming") {
      confirmingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [phase]);

  function reset() {
    setPhase(plan ? "generated" : "idle");
    setConfirmed(false); setExecLog([]); setExecIndex(0); setAborted(false);
  }

  async function startExecution() {
    if (!confirmed || activePlanEntries.length === 0) return;
    setPhase("executing");
    setExecLog([]);
    setAborted(false);
    const log: VoteLogEntry[] = [];

    for (let i = 0; i < activePlanEntries.length; i++) {
      if (aborted) break;
      setExecIndex(i);
      const e = activePlanEntries[i];
      try {
        // Direct call — throws VoteBroadcastError on any failure
        const result = await props.onExecuteSingle({
          author:           e.author,
          permlink:         e.permlink,
          weightBps:        e.suggestedWeightBps,
          strategyCategory: e.category,
        });
        const txShort = result.transactionId.length > 12
          ? result.transactionId.slice(0, 12) + "…"
          : result.transactionId;
        const entry: VoteLogEntry = {
          author: e.author, permlink: e.permlink, title: e.title,
          status: "sent",
          message: `${e.suggestedWeightPct}% · TX: ${txShort}`,
        };
        log.push(entry);
        setExecLog([...log]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unbekannter Fehler";
        // Classify error type for smart handling
        const isAlreadyVoted    = msg.includes("already_voted") || msg.includes("already") || msg.includes("duplicate");
        const isPostMissing     = msg.includes("post_not_found") || msg.includes("nicht gefunden");
        // Post-specific chain rejections: skip and continue (not a systemic error)
        const isPostSpecific    = msg.includes("Invalid cast") || msg.includes("object_type")
                                || msg.includes("cashout_time") || msg.includes("cannot_vote")
                                || msg.includes("post_rejected") || msg.includes("Post vom Node abgelehnt");
        const skipWithoutStop   = isAlreadyVoted || isPostMissing || isPostSpecific;

        const entry: VoteLogEntry = {
          author: e.author, permlink: e.permlink, title: e.title,
          status: (isAlreadyVoted || isPostSpecific) ? "skipped" : "failed",
          message: msg,
        };
        log.push(entry);
        setExecLog([...log]);
        if (!skipWithoutStop) { setAborted(true); break; } // Stop on authority/network errors
      }
      // 1.5s delay between votes (Steem rate-limit protection)
      if (i < entries.length - 1 && !aborted) await new Promise(r => setTimeout(r, 1500));
    }
    setPhase("done");
    props.onPlanExecuted?.();
  }

  return (
    <div>
      {props.error && <p style={{ color: "#dc2626", fontSize: "0.82rem", margin: "0 0 0.5rem" }}>{props.error}</p>}

      {/* ── Phase: generated (plan view) ───────────── */}
      {phase === "generated" && (
        <>
          {entries.length === 0 ? (
            <p style={{ color: "#16a34a", fontSize: "0.82rem" }}>✓ Alles up-to-date — keine offenen Posts von Strategie-Autoren.</p>
          ) : (
            <>
              {/* Dry-run notice */}
              <div style={{ background: "#1b3a2e", border: "1px solid #3fb95055", borderRadius: "5px", padding: "0.5rem 0.75rem", marginBottom: "0.5rem", fontSize: "0.78rem", color: "#16a34a" }}>
                🔍 Dry-Run-Ansicht — noch keine Votes gesendet. Überprüfe den Plan und bestätige im nächsten Schritt.
              </div>

              {/* Recovery banner */}
              {plan?.report && <RecoveryBanner report={plan.report} t={t} />}

              {/* Transparenz: gefunden vs. im Plan */}
              {plan?.report && plan.report.excludedVotes > 0 && (
                <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "10px", padding: "0.7rem 1rem", marginBottom: "0.75rem", display: "flex", alignItems: "flex-start", gap: "0.75rem" }}>
                  <span style={{ fontSize: "1.1rem", flexShrink: 0 }}>💡</span>
                  <div>
                    <div style={{ color: "#1e293b", fontWeight: 700, fontSize: "0.85rem", marginBottom: "0.15rem" }}>
                      {entries.length} im Plan · {plan.report.excludedVotes} ausgeschlossen
                    </div>
                    <div style={{ color: "#64748b", fontSize: "0.78rem", lineHeight: 1.5 }}>
                      Budget heute: {plan.report.dynamicBudgetPct.toFixed(1)}% VP · Gewichte reduzieren (−) schafft Platz für weitere Votes.
                    </div>
                  </div>
                </div>
              )}

              {/* Live-Impact wenn Gewichte editiert wurden */}
              {hasEdits && (
                <div style={{ background: savedVpPct > 0 ? "#f0fdf4" : "#fef2f2", border: `1.5px solid ${savedVpPct > 0 ? "#86efac" : "#fca5a5"}`, borderRadius: "12px", padding: "0.85rem 1.1rem", marginBottom: "0.75rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "1.25rem", flexWrap: "wrap" as const, marginBottom: "0.4rem" }}>
                    <span style={{ color: savedVpPct > 0 ? "#15803d" : "#dc2626", fontSize: "0.9rem", fontWeight: 800 }}>
                      {savedVpPct > 0 ? `✓ ${savedVpPct.toFixed(2)}% VP gespart` : `+${Math.abs(savedVpPct).toFixed(2)}% VP zusätzlich`}
                    </span>
                    <span style={{ color: "#64748b", fontSize: "0.82rem" }}>
                      VP morgen: <b style={{ color: origVpMorgen >= 80 ? "#15803d" : "#d97706" }}>{origVpMorgen.toFixed(1)}%</b>
                      {" → "}<b style={{ color: effVpMorgen >= 80 ? "#15803d" : "#d97706", fontSize: "0.95rem" }}>{effVpMorgen.toFixed(1)}%</b>
                    </span>
                    {additions.length > 0 && (
                      <span style={{ color: "#0369a1", fontSize: "0.78rem" }}>
                        ✓ {additions.length} Opportunit{additions.length === 1 ? "y" : "ies"} automatisch ergänzt
                      </span>
                    )}
                    {excluded.size > 0 && (
                      <span style={{ color: "#6b7280", fontSize: "0.78rem" }}>
                        {excluded.size} Vote{excluded.size > 1 ? "s" : ""} deaktiviert
                      </span>
                    )}
                    {plan?.report.dynamicBudgetPct !== undefined && (
                      <span style={{ color: "#64748b", fontSize: "0.78rem" }}>
                        Freies Budget: <b style={{ color: "#0369a1" }}>{Math.max(0, plan.report.dynamicBudgetPct - effVpCost).toFixed(2)}% VP</b>
                      </span>
                    )}
                    <button onClick={() => { setOverrides(new Map()); setAdditions([]); }} style={{ marginLeft: "auto", background: "none", border: "1px solid #94a3b8", borderRadius: "6px", color: "#64748b", cursor: "pointer", fontSize: "0.75rem", padding: "0.2rem 0.6rem" }}>↩ Alles zurücksetzen</button>
                  </div>
                </div>
              )}

              {/* ── Anzeige-Modus-Umschalter ── */}
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.4rem", gap: "0.2rem" }}>
                {(["pct", "usd", "sp"] as VoteDisplayMode[]).map(m => {
                  const labels: Record<VoteDisplayMode, string> = { pct: "%", usd: "$", sp: "SP" };
                  const active = voteMode === m;
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setVoteMode(m)}
                      style={{
                        background:   active ? "#2563eb" : "#f1f5f9",
                        border:       active ? "1px solid #2563eb" : "1px solid #e2e8f0",
                        borderRadius: "5px",
                        color:        active ? "#fff" : "#64748b",
                        cursor:       "pointer",
                        fontSize:     "0.68rem",
                        fontWeight:   700,
                        lineHeight:   1,
                        padding:      "0.2rem 0.45rem",
                      }}
                      title={{ pct: "Vote-Gewicht in Prozent", usd: "Gegenwert in Dollar ($)", sp: "Gegenwert in Steem Power (SP)" }[m]}
                    >
                      {labels[m]}
                    </button>
                  );
                })}
              </div>

              {/* ── Plan-Karten mit Inline-Controls ── */}
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem", marginBottom: "0.75rem" }}>
                {allPlanEntries.map(e => {
                  const key = `${e.author}/${e.permlink}`;
                  const color = PLAN_CATEGORY_COLOR[e.category] ?? "#607078";
                  const isAdded   = addedKeys.has(key);
                  const isEdited  = overrides.has(key);
                  const origBps   = isAdded
                    ? (additions.find(x => `${x.author}/${x.permlink}` === key)?.suggestedWeightBps ?? e.suggestedWeightBps)
                    : (entries.find(x => `${x.author}/${x.permlink}` === key)?.suggestedWeightBps ?? e.suggestedWeightBps);
                  const scoreBg    = e.postScore >= 80 ? "#dcfce7" : e.postScore >= 50 ? "#fef9c3" : "#f0f5f7";
                  const scoreColor = e.postScore >= 80 ? "#15803d" : e.postScore >= 50 ? "#a16207" : "#607078";
                  const isExcluded = excluded.has(key);
                  return (
                    <div key={key} style={{
                      background: isExcluded ? "#f8fafc" : isAdded ? "#f0fdf4" : isEdited ? "#f8faff" : "#ffffff",
                      border: `1px solid ${isExcluded ? "#d1d5db" : isAdded ? "#86efac" : isEdited ? "#93c5fd" : e.warning ? "#fde68a" : "#e5e7eb"}`,
                      borderLeft: `4px solid ${isExcluded ? "#d1d5db" : isAdded ? "#16a34a" : color}`,
                      borderRadius: "10px", padding: "0.65rem 0.85rem",
                      display: "flex", gap: "0.75rem", alignItems: "center",
                      transition: "background 0.15s, border-color 0.15s",
                    }}>
                      {/* Deaktivierungs-Checkbox — immer volle Opazität */}
                      <label title={isExcluded ? "Vote aktivieren" : "Vote aus Plan entfernen"} style={{ flexShrink: 0, display: "flex", alignItems: "center", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={!isExcluded}
                          onChange={() => toggleExclude(key)}
                          style={{ width: "15px", height: "15px", cursor: "pointer", accentColor: "#16a34a", flexShrink: 0 }}
                        />
                      </label>

                      {/* Card-Inhalt — bei deaktiviert ausgegraut */}
                      <div style={{ display: "flex", flex: 1, gap: "0.75rem", alignItems: "center", opacity: isExcluded ? 0.45 : 1, transition: "opacity 0.15s", minWidth: 0 }}>

                      {/* Score-Badge (hinzugefügte: grünes +) */}
                      <div style={{ flexShrink: 0, width: "40px", height: "40px", borderRadius: "9px", background: isExcluded ? "#e5e7eb" : isAdded ? "#dcfce7" : scoreBg, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column" as const, position: "relative" as const }}>
                        {isAdded && <span style={{ position: "absolute" as const, top: "-5px", right: "-5px", background: "#16a34a", color: "#fff", borderRadius: "50%", width: "14px", height: "14px", fontSize: "0.65rem", fontWeight: 900, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>+</span>}
                        <span style={{ color: isExcluded ? "#9ca3af" : isAdded ? "#15803d" : scoreColor, fontSize: "0.95rem", fontWeight: 900, lineHeight: 1 }}>{e.postScore}</span>
                        <span style={{ color: isExcluded ? "#9ca3af" : isAdded ? "#15803d" : scoreColor, fontSize: "0.52rem", fontWeight: 700, opacity: 0.6 }}>score</span>
                      </div>

                      {/* Titel + Metadaten */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ color: isExcluded ? "#9ca3af" : "#111827", fontSize: "0.91rem", fontWeight: 700, margin: "0 0 0.18rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, textDecoration: isExcluded ? "line-through" : "none" }}>
                          {e.title || `${e.author}/${e.permlink}`}
                          {isAdded && <span style={{ marginLeft: "0.5rem", background: "#dcfce7", color: "#15803d", borderRadius: "4px", padding: "0.05rem 0.35rem", fontSize: "0.65rem", fontWeight: 700 }}>hinzugefügt</span>}
                        </p>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.73rem", color: "#9ca3af" }}>
                          <span style={{ color: isExcluded ? "#9ca3af" : "#2563eb", fontWeight: 600 }}>@{e.author}</span>
                          <span>·</span><span>{formatAge(e.ageMinutes)}</span>
                          {e.remainingHours < 48 && <><span>·</span><span style={{ color: e.remainingHours < 24 ? "#d97706" : "#9ca3af" }}>{e.remainingHours.toFixed(0)}h</span></>}
                        </div>
                      </div>

                      {/* Inline-Gewichts-Editor */}
                      <div style={{ flexShrink: 0, display: "flex", flexDirection: "column" as const, alignItems: "flex-end", gap: "0.25rem", minWidth: "96px" }}>
                        {/* Stepper mit modus-abhängiger Primärwert-Anzeige */}
                        <div style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                          <button onClick={() => adjustWeight(key, -500)} style={{ width: "26px", height: "26px", borderRadius: "7px", background: "#f1f5f9", border: "1px solid #e2e8f0", color: "#475569", cursor: "pointer", fontSize: "1.05rem", lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>−</button>
                          <span style={{ color: isEdited ? "#2563eb" : color, fontSize: "1.1rem", fontWeight: 900, minWidth: "52px", textAlign: "center" as const }}>
                            {voteMode === "pct" && `${e.suggestedWeightPct}%`}
                            {voteMode === "usd" && (e.expectedVoteUsd > 0 ? `$${e.expectedVoteUsd.toFixed(3)}` : "—")}
                            {voteMode === "sp"  && (e.expectedVoteUsd > 0 ? `${(e.expectedVoteUsd / sbdPerSteem).toFixed(3)}` : "—")}
                          </span>
                          <button onClick={() => adjustWeight(key, +500)} style={{ width: "26px", height: "26px", borderRadius: "7px", background: "#f1f5f9", border: "1px solid #e2e8f0", color: "#475569", cursor: "pointer", fontSize: "1.05rem", lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>+</button>
                        </div>
                        {/* Sekundärwert — das jeweils andere */}
                        <div style={{ textAlign: "center" as const, fontSize: "0.67rem", color: isEdited ? "#93c5fd" : "#9ca3af" }}>
                          {voteMode === "pct" && e.expectedVoteUsd > 0 && `≈$${e.expectedVoteUsd.toFixed(4)}`}
                          {voteMode === "usd" && `${e.suggestedWeightPct}% Vote`}
                          {voteMode === "sp"  && `${e.suggestedWeightPct}% · SP`}
                        </div>
                        {/* VP-Kosten — immer sichtbar */}
                        <div style={{ textAlign: "center" as const, fontSize: "0.67rem", color: isEdited ? "#2563eb" : "#9ca3af" }}>
                          VP: {(e.suggestedWeightBps / 5000).toFixed(2)}%
                        </div>
                        {/* Reset wenn editiert */}
                        {isEdited && (
                          <button onClick={() => resetWeight(key)} style={{ background: "none", border: "none", color: "#93c5fd", cursor: "pointer", fontSize: "0.65rem", padding: 0 }}>
                            ↩ {(origBps / 100).toFixed(1)}%
                          </button>
                        )}
                      </div>

                      </div>{/* end card-content wrapper */}
                    </div>
                  );
                })}
              </div>

              <button
                style={{ background: "#d97706", border: "none", borderRadius: "10px", color: "#fff", cursor: "pointer", fontSize: "0.92rem", fontWeight: 800, padding: "0.65rem 1.4rem" }}
                type="button"
                disabled={activePlanEntries.length === 0}
                onClick={() => { setPhase("confirming"); setConfirmed(false); }}
              >
                {t("planConfirmBtn").replace("{{count}}", String(activePlanEntries.length))}
              </button>
            </>
          )}
        </>
      )}

      {/* ── Phase: confirming ──────────────────────── */}
      {phase === "confirming" && plan && (
        <div ref={confirmingRef} style={{ borderRadius: "14px", overflow: "hidden", border: "1.5px solid #f59e0b" }}>

          {/* Header — compact meta strip */}
          <div style={{ background: "#fffbeb", padding: "0.65rem 1.1rem", display: "flex", gap: "1.25rem", flexWrap: "wrap" as const, alignItems: "center", fontSize: "0.8rem", borderBottom: "1px solid #fde68a" }}>
            <span style={{ color: "#78350f", fontWeight: 700, fontSize: "0.88rem" }}>
              {t("planConfirmTitle").replace("{{count}}", String(activePlanEntries.length))}
            </span>
            <span style={{ color: "#92400e" }}>{t("planVpNow")} <b>{plan.summary.currentVpPct.toFixed(1)}%</b></span>
            <span style={{ color: "#92400e" }}>{t("planVpCost")} <b>{plan.summary.estimatedVpSpendPct}%</b></span>
            <span style={{ color: "#92400e" }}>{t("planVpAfter")} <b style={{ color: sustainColor }}>{plan.summary.estimatedVpAfterPct.toFixed(1)}%</b></span>
            <span style={{ color: sustainColor, fontWeight: 600 }}>
              {plan.summary.sustainability === "sustainable" ? t("planSustainSustainable") : plan.summary.sustainability === "aggressive" ? t("planSustainAggressive") : t("planSustainCritical")}
            </span>
          </div>

          {/* Main confirm area */}
          <div style={{ background: "#ffffff", padding: "1.25rem 1.1rem" }}>
            <div style={{ textAlign: "center" as const, marginBottom: "0.85rem", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" }}>
              <span style={{ fontSize: "1.6rem", lineHeight: 1 }}>⚠️</span>
              <span style={{ fontSize: "1rem", fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase" as const, color: "#b45309" }}>
                {t("planConfirmLastStep")}
              </span>
              <span style={{ fontSize: "1.6rem", lineHeight: 1 }}>⚠️</span>
            </div>

            {/* THE dominant element: checkbox + text */}
            <label style={{
              display: "flex", flexDirection: "row" as const, alignItems: "center", justifyContent: "center", gap: "0.85rem",
              cursor: "pointer",
              background: confirmed ? "#f0fdf4" : "#fafafa",
              border: `2.5px solid ${confirmed ? "#16a34a" : "#d1d5db"}`,
              borderRadius: "12px",
              padding: "1rem 1.25rem",
              marginBottom: "1rem",
              transition: "border-color 0.15s, background 0.15s",
            }}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={e => setConfirmed(e.target.checked)}
                style={{ display: "inline-block", accentColor: "#16a34a", width: "22px", height: "22px", minWidth: "22px", flexShrink: 0, cursor: "pointer", margin: 0 }}
              />
              <span style={{ fontSize: "1rem", fontWeight: 700, color: confirmed ? "#15803d" : "#374151", lineHeight: 1.4 }}>
                {t("planConfirmCheck").replace("{{count}}", String(activePlanEntries.length))}
              </span>
            </label>

            {/* Safeguards note — secondary, small */}
            <p style={{ fontSize: "0.75rem", color: "#9ca3af", margin: "0 0 1rem", paddingLeft: "0.25rem" }}>
              <b style={{ color: "#6b7280" }}>{t("planSafeguards")}</b> {t("planSafeguardsDetail")}
            </p>

            {/* Actions */}
            <div style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
              <button
                type="button"
                disabled={!confirmed}
                onClick={() => void startExecution()}
                style={{
                  background: confirmed ? "#16a34a" : "#e5e7eb",
                  border: "none", borderRadius: "10px",
                  color: confirmed ? "#ffffff" : "#9ca3af",
                  cursor: confirmed ? "pointer" : "not-allowed",
                  fontSize: "0.95rem", fontWeight: 800,
                  padding: "0.7rem 1.5rem",
                  transition: "background 0.15s, color 0.15s",
                }}
              >
                {t("planSendNow").replace("{{count}}", String(allPlanEntries.length))}
              </button>
              <button style={chipBtn} type="button" onClick={reset}>{t("planBack")}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Phase: executing ───────────────────────── */}
      {phase === "executing" && (
        <div style={{ background: "#ffffff", border: "1px solid #30363d", borderRadius: "6px", padding: "0.75rem 1rem" }}>
          <p style={{ color: "#2d3a42", fontWeight: 600, margin: "0 0 0.5rem" }}>
            {t("planSendingProgress").replace("{{sent}}", String(execLog.length)).replace("{{total}}", String(allPlanEntries.length))}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem", fontFamily: "monospace", fontSize: "0.77rem" }}>
            {execLog.map((l, i) => (
              <div key={i} style={{ color: l.status === "sent" ? "#16a34a" : l.status === "skipped" ? "#607078" : "#dc2626" }}>
                {l.status === "sent" ? "✓" : l.status === "skipped" ? "⊘" : "✗"} @{l.author}/{l.permlink.slice(0, 30)} — {l.message}
              </div>
            ))}
            {execLog.length < allPlanEntries.length && !aborted && (
              <div style={{ color: "#607078" }}>⏳ @{allPlanEntries[execIndex]?.author ?? "..."}...</div>
            )}
            {aborted && <div style={{ color: "#dc2626" }}>{t("planAbortError")}</div>}
          </div>
        </div>
      )}

      {/* ── Phase: done ────────────────────────────── */}
      {phase === "done" && (
        <div>
          <div style={{ padding: "0.6rem 0.75rem", background: "#f0f5f7", borderRadius: "5px", border: "1px solid #30363d", fontSize: "0.82rem", marginBottom: "0.5rem" }}>
            <b style={{ color: "#2d3a42" }}>{t("planResultTitle")}</b>
            {" "}<span style={{ color: "#16a34a" }}>{t("planResultSent").replace("{{count}}", String(execLog.filter(l => l.status === "sent").length))}</span>
            {execLog.filter(l => l.status === "skipped").length > 0 && <span style={{ color: "#607078", marginLeft: "0.75rem" }}>{t("planResultSkipped").replace("{{count}}", String(execLog.filter(l => l.status === "skipped").length))}</span>}
            {execLog.filter(l => l.status === "failed").length > 0 && <span style={{ color: "#dc2626", marginLeft: "0.75rem" }}>{t("planResultFailed").replace("{{count}}", String(execLog.filter(l => l.status === "failed").length))}</span>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem", fontFamily: "monospace", fontSize: "0.75rem", marginBottom: "0.5rem", maxHeight: "200px", overflowY: "auto" }}>
            {execLog.map((l, i) => (
              <div key={i} style={{ color: l.status === "sent" ? "#16a34a" : l.status === "skipped" ? "#607078" : "#dc2626" }}>
                {l.status === "sent" ? "✓" : l.status === "skipped" ? "⊘" : "✗"} @{l.author} — {l.message}
              </div>
            ))}
          </div>
          <button style={chipBtn} type="button" onClick={() => { reset(); props.onGenerate(); }}>{t("planRegenerate")}</button>
        </div>
      )}
    </div>
  );
}

export function OpenVoteOpportunities(props: {
  opportunities: PostOpportunity[] | null;
  meta: import("../api").OpportunitiesMeta | null;
  loading: boolean;
  error: string | null;
  strategyRules: StrategyRule[];
  accountSnapshot: SteemAccountSnapshot | null;
  onRefresh: () => void;
  onExecuteVotes: (targets: VoteTarget[]) => Promise<VoteBatchResult>;
  locale?: import("../i18n").Locale;
}) {
  const t = createTranslator(props.locale ?? "de");
  const [preview, setPreview] = useState<VoteTarget[] | null>(null);
  const [voting, setVoting] = useState(false);
  const [voteResult, setVoteResult] = useState<VoteBatchResult | null>(null);

  const ruleMap = new Map(props.strategyRules.map(r => [r.username, r]));

  // Build per-author opportunity groups
  const authorGroups: Array<{
    rule: StrategyRule;
    posts: PostOpportunity[];
    eligible: PostOpportunity[];
    voted: PostOpportunity[];
  }> = props.strategyRules
    .filter(r => r.enabled && r.category !== "ignorieren")
    .map(rule => {
      const posts = (props.opportunities ?? []).filter(p => p.author === rule.username);
      return {
        rule,
        posts,
        eligible: posts.filter(p => p.eligible),
        voted: posts.filter(p => p.alreadyVoted),
      };
    })
    .filter(g => g.posts.length > 0 || props.opportunities !== null);

  const allEligible: VoteTarget[] = authorGroups.flatMap(g =>
    g.eligible.map(p => ({
      author: p.author,
      permlink: p.permlink,
      title: p.title,
      ageMinutes: p.ageMinutes,
      weightBps: Math.round(g.rule.maxWeightPct * 100),
      category: g.rule.category,
    }))
  );

  const totalOpen    = allEligible.length;
  const avgWeightPct = totalOpen > 0
    ? Math.round(allEligible.reduce((s, t) => s + t.weightBps, 0) / totalOpen / 100 * 10) / 10
    : 0;
  // Steem: each vote costs weight_pct / 50 VP (100% vote = 2% VP, full regen in 5 days = 50 votes)
  const currentVpPct   = (props.accountSnapshot?.votingPowerBps ?? 10000) / 100;
  const totalVpCostPct = allEligible.reduce((s, t) => s + t.weightBps / 5_000, 0);
  const vpAfterPct     = Math.max(0, Math.round((currentVpPct - totalVpCostPct) * 10) / 10);

  async function executePreview() {
    if (!preview || preview.length === 0) return;
    setVoting(true);
    setVoteResult(null);
    const result = await props.onExecuteVotes(preview);
    setVoting(false);
    setVoteResult(result);
    setPreview(null);
  }

  const chipBtn = {
    background: "#f0f5f7", border: "1px solid #dde8ed", borderRadius: "6px",
    color: "#607078", cursor: "pointer" as const, fontSize: "0.78rem", padding: "0.3rem 0.65rem",
  };
  const sectionLabel = {
    color: "#607078", fontSize: "0.75rem", textTransform: "uppercase" as const,
    letterSpacing: "0.5px", margin: 0, fontWeight: 600,
  };

  // Self-posts from the voter — eligible immediately (visibility > curation timing)
  const selfPostOpps = (props.opportunities ?? []).filter(
    p => p.isSelfPost && p.eligible && !p.alreadyVoted
  );

  return (
    <div>
      {/* Self-post alert — shown prominently when own post is detected */}
      {selfPostOpps.length > 0 && (
        <div style={{
          background: "linear-gradient(135deg, #0f2318 0%, #0d2233 100%)",
          border: "1px solid #16a34a55",
          borderRadius: "10px",
          padding: "0.85rem 1rem",
          marginBottom: "0.85rem",
          display: "flex", flexDirection: "column" as const, gap: "0.5rem",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ fontSize: "1.1rem" }}>🚀</span>
            <span style={{ color: "#4ade80", fontWeight: 700, fontSize: "0.88rem" }}>
              {t("selfPostDetected")}
            </span>
          </div>
          {selfPostOpps.map(p => (
            <div key={`${p.author}/${p.permlink}`} style={{ paddingLeft: "1.6rem" }}>
              <div style={{ color: "#e2e8f0", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.15rem" }}>
                {p.title || `${p.author}/${p.permlink}`}
              </div>
              <div style={{ color: "#94a3b8", fontSize: "0.78rem" }}>
                {p.ageMinutes < 60
                  ? t("selfPostPublishedMin").replace("{{min}}", String(p.ageMinutes))
                  : t("selfPostPublishedHour").replace("{{hours}}", (p.ageMinutes / 60).toFixed(1))}
              </div>
              <div style={{ color: "#6ee7b7", fontSize: "0.78rem", marginTop: "0.1rem" }}>
                {t("selfPostRecommend")}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* KPI-Header — nur wenn bereits gescannt */}
      {props.opportunities !== null && (
        <div style={{ display: "flex", alignItems: "center", gap: "1.5rem", marginBottom: "1rem", flexWrap: "wrap" as const }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
            <span style={{
              fontSize: "3rem", fontWeight: 900, lineHeight: 1, letterSpacing: "-2px",
              color: totalOpen > 0 ? "#d97706" : "#16a34a",
            }}>
              {totalOpen}
            </span>
            <span style={{ color: "#607078", fontSize: "0.85rem", fontWeight: 700 }}>
              {totalOpen === 1 ? t("openVoteLabel1") : totalOpen === 0 ? t("openVoteLabelDone") : t("openVoteLabelN")}
            </span>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginLeft: "auto" }}>
            <button
              style={{ background: "#f0f5f7", border: "1px solid #dde8ed", borderRadius: "7px", color: "#607078", cursor: "pointer", fontSize: "0.82rem", padding: "0.45rem 0.9rem", fontWeight: 600 }}
              type="button"
              disabled={props.loading}
              onClick={props.onRefresh}
            >
              {props.loading ? t("btnScanning") : t("btnRefresh")}
            </button>
          </div>
        </div>
      )}

      {props.error && (
        <p style={{ color: "#dc2626", fontSize: "0.82rem", margin: "0 0 0.75rem" }}>{props.error}</p>
      )}

      {/* Scan Meta — kompakt */}
      {props.meta && !props.loading && (
        <div style={{ background: "#f8fbfc", border: "1px solid #dde8ed", borderRadius: "8px", padding: "0.5rem 0.85rem", marginBottom: "0.75rem", fontSize: "0.73rem" }}>
          <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap" as const, color: "#8fa4b0" }}>
            <span>{t("scanMetaSummary").replace("{{scanned}}", String(props.meta.scannedAuthors)).replace("{{requested}}", String(props.meta.requestedAuthors)).replace("{{posts}}", String(props.meta.totalPosts)).replace("{{eligible}}", String(props.meta.eligiblePosts))}</span>
          </div>
          {/* Per-author breakdown — highlight authors with 0 posts */}
          {(() => {
            const noPost  = Object.entries(props.meta.perAuthor).filter(([, v]) => v.noRecentPosts).map(([k]) => k);
            const withPost = Object.entries(props.meta.perAuthor).filter(([, v]) => !v.noRecentPosts && v.eligible > 0).map(([k]) => k);
            return (
              <>
                {withPost.length > 0 && (
                  <div style={{ color: "#16a34a", fontSize: "0.72rem" }}>
                    {t("scanMetaWithPosts").replace("{{authors}}", withPost.join(", "))}
                  </div>
                )}
                {noPost.length > 0 && (
                  <div style={{ color: "#8fa4b0", fontSize: "0.72rem", marginTop: "0.15rem" }}>
                    {t("scanMetaNoPosts").replace("{{authors}}", `${noPost.slice(0, 10).join(", ")}${noPost.length > 10 ? ` +${noPost.length - 10}` : ""}`)}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* Per-author groups */}
      {props.opportunities !== null && authorGroups.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.65rem" }}>
          {authorGroups.map(group => {
            const authorTargets = group.eligible.map(p => ({
              author: p.author, permlink: p.permlink, title: p.title, ageMinutes: p.ageMinutes,
              weightBps: Math.round(group.rule.maxWeightPct * 100), category: group.rule.category,
            }));
            const color = categoryColor[group.rule.category];
            const hasOpen = group.eligible.length > 0;
            return (
              <div key={group.rule.username} style={{
                background: hasOpen ? "#fffbf0" : "#f8fbfc",
                border: `1px solid ${hasOpen ? "#f59e0b44" : "#dde8ed"}`,
                borderLeft: `4px solid ${hasOpen ? color : "#c5d3da"}`,
                borderRadius: "10px", padding: "0.85rem 1rem",
              }}>
                {/* Autor-Header */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" as const, gap: "0.5rem", marginBottom: group.eligible.length > 0 ? "0.65rem" : 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" as const }}>
                    <span style={{ color: "#1d4ed8", fontWeight: 800, fontSize: "1.05rem" }}>@{group.rule.username}</span>
                    <span style={{ background: color + "18", color, border: `1px solid ${color}30`, borderRadius: "5px", padding: "0.1rem 0.45rem", fontSize: "0.72rem", fontWeight: 700 }}>
                      {categoryLabel[group.rule.category]}
                    </span>
                    {/* Offene Votes Badge */}
                    {hasOpen ? (
                      <span style={{ background: "#fef3c7", color: "#92400e", border: "1px solid #f59e0b44", borderRadius: "6px", padding: "0.15rem 0.55rem", fontSize: "0.8rem", fontWeight: 800 }}>
                        {group.eligible.length} offen
                      </span>
                    ) : group.voted.length > 0 ? (
                      <span style={{ color: "#16a34a", fontSize: "0.78rem", fontWeight: 600 }}>✓ gevoted</span>
                    ) : null}
                    {group.posts.length > 0 && (
                      <span style={{ color: "#8fa4b0", fontSize: "0.73rem" }}>
                        {formatAge(Math.min(...group.posts.map(p => p.ageMinutes)))} · {group.rule.maxWeightPct}%
                      </span>
                    )}
                  </div>
                  {hasOpen && (
                    <button
                      style={{ background: color + "15", border: `1px solid ${color}50`, borderRadius: "7px", color, cursor: "pointer", fontSize: "0.82rem", fontWeight: 700, padding: "0.35rem 0.8rem" }}
                      type="button"
                      disabled={voting}
                      onClick={() => { setPreview(authorTargets); setVoteResult(null); }}
                    >
                      Vote {group.eligible.length === 1 ? "diesen Post" : `${group.eligible.length} Posts`}
                    </button>
                  )}
                </div>

                {/* Eligible posts — Post-Titel prominent */}
                {group.eligible.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.4rem" }}>
                    {group.eligible.map(p => (
                      <div key={p.permlink} style={{
                        background: "#ffffff", border: "1px solid #f0d080", borderRadius: "7px",
                        padding: "0.55rem 0.75rem",
                      }}>
                        <div style={{ color: "#17202a", fontSize: "0.92rem", fontWeight: 700, marginBottom: "0.2rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                          {p.title || p.permlink}
                        </div>
                        <div style={{ display: "flex", gap: "0.75rem", fontSize: "0.73rem", color: "#8fa4b0", flexWrap: "wrap" as const }}>
                          <span>{formatAge(p.ageMinutes)}</span>
                          {p.remainingHours > 0 && <span style={{ color: p.remainingHours < 24 ? "#d97706" : "#8fa4b0" }}>{p.remainingHours.toFixed(0)}h verbleibend</span>}
                          <span style={{ color: p.postScore >= 80 ? "#16a34a" : p.postScore >= 50 ? "#d97706" : "#8fa4b0", fontWeight: 600 }}>Score {p.postScore}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Vote preview / confirmation */}
      {preview && preview.length > 0 && (
        <div style={{ marginTop: "0.75rem", padding: "0.75rem 1rem", background: "#ffffff", border: "1px solid #f0a500", borderRadius: "6px" }}>
          <p style={{ color: "#d97706", fontWeight: 600, margin: "0 0 0.5rem", fontSize: "0.87rem" }}>
            Vote-Vorschau — {preview.length} {preview.length === 1 ? "Post" : "Posts"}
          </p>
          <div style={{ color: "#607078", fontSize: "0.8rem", marginBottom: "0.6rem", display: "flex", gap: "1.25rem", flexWrap: "wrap" }}>
            <span>Autoren: <b style={{ color: "#17202a" }}>{new Set(preview.map(t => t.author)).size}</b></span>
            <span>Ø Gewicht: <b style={{ color: "#17202a" }}>{avgWeightPct}%</b></span>
            <span>Aktuelle VP: <b style={{ color: "#17202a" }}>{currentVpPct.toFixed(1)}%</b></span>
            <span>VP danach: <b style={{ color: vpAfterPct < 75 ? "#dc2626" : vpAfterPct < 85 ? "#d97706" : "#16a34a" }}>{vpAfterPct}%</b></span>
          </div>
          <div style={{ marginBottom: "0.75rem", maxHeight: "160px", overflowY: "auto" }}>
            {preview.map(t => (
              <div key={`${t.author}/${t.permlink}`} style={{ display: "flex", gap: "0.75rem", fontSize: "0.77rem", padding: "0.15rem 0", color: "#607078" }}>
                <span style={{ color: "#2563eb" }}>@{t.author}</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#2d3a42" }}>{t.title || t.permlink}</span>
                <span style={{ whiteSpace: "nowrap", color: categoryColor[t.category], fontWeight: 600 }}>{(t.weightBps / 100).toFixed(1)}%</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              style={{ ...chipBtn, background: "#2563eb14", borderColor: "#2563eb", color: "#2563eb", fontWeight: 600 }}
              type="button"
              disabled={voting}
              onClick={executePreview}
            >
              {voting ? `Voten läuft...` : `Jetzt voten (${preview.length} Posts)`}
            </button>
            <button
              style={chipBtn}
              type="button"
              disabled={voting}
              onClick={() => setPreview(null)}
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}

      {/* Vote result — per-vote detail */}
      {voteResult && (
        <div style={{ marginTop: "0.6rem", background: "#f0f5f7", border: "1px solid #30363d", borderRadius: "6px", padding: "0.6rem 0.75rem" }}>
          {/* Summary line */}
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "0.5rem", fontSize: "0.8rem" }}>
            {voteResult.ok > 0 && <span style={{ color: "#16a34a", fontWeight: 600 }}>✓ {voteResult.ok} gesendet</span>}
            {voteResult.skipped > 0 && <span style={{ color: "#607078", fontWeight: 600 }}>⊘ {voteResult.skipped} übersprungen</span>}
            {voteResult.failed > 0 && <span style={{ color: "#dc2626", fontWeight: 600 }}>✗ {voteResult.failed} fehlgeschlagen</span>}
          </div>
          {/* Per-vote results */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
            {voteResult.results.map((r, i) => {
              const statusColor = r.status === "success" ? "#16a34a" : r.status === "skipped" ? "#607078" : "#dc2626";
              const statusIcon  = r.status === "success" ? "✓" : r.status === "skipped" ? "⊘" : "✗";
              const txShort     = r.transactionId && r.transactionId.length >= 12
                ? r.transactionId.slice(0, 12) + "…"
                : r.transactionId;
              return (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", fontSize: "0.77rem" }}>
                  <span style={{ color: statusColor, fontWeight: 700, flexShrink: 0 }}>{statusIcon}</span>
                  <span style={{ color: "#2563eb", flexShrink: 0 }}>@{r.author}</span>
                  <span style={{ color: "#8fa4b0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>/{r.permlink.slice(0, 40)}{r.permlink.length > 40 ? "…" : ""}</span>
                  {r.status === "success" && txShort && (
                    <span style={{ color: "#16a34a", flexShrink: 0, fontFamily: "monospace" }}>TX: {txShort}</span>
                  )}
                  {r.status !== "success" && r.errorMessage && (
                    <span style={{ color: statusColor, flexShrink: 0, maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.errorMessage}>
                      {r.errorMessage}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
