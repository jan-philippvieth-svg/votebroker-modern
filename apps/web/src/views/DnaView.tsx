// ── DnaView — CurationDnaPanel, StrategyEditor, SimulationPanel ──────────────
// Extracted from App.tsx — DNA analysis, strategy editing, vote planning UI

import React, { useState, useEffect } from "react";
import { Search, Dna as DnaIcon, UsersRound, Settings, BarChart2, ArrowRight } from "lucide-react";
import { createTranslator, type Locale, type TranslationKey } from "../i18n";
import type {
  CurationProfile,
  VotePlanResponse,
  VotePlanEntry,
  SteemAccountSnapshot,
  AuthSession,
  OpportunitiesMeta,
  PostOpportunity,
} from "../api";
import {
  type StrategyCategory,
  type StrategyRule,
  categoryLabel,
  categoryColor,
  computeDynamicWeights,
  generateStrategyFromProfile,
} from "./strategyTypes";
import {
  type VoteBatchResult,
  type VoteTarget,
  type LivePlanMetrics,
  VotePlanSection,
  OpenVoteOpportunities,
} from "./VotePlanView";

// ── InlineStrategyEditor — minimal author-add always available ────────────

function InlineStrategyEditor(props: {
  addUsername: string;
  setAddUsername: (v: string) => void;
  addCategory: StrategyCategory;
  setAddCategory: (v: StrategyCategory) => void;
  addManually: () => void;
  strategyRules: StrategyRule[] | null;
  onStrategyChange: (rules: StrategyRule[] | null) => void;
  t: ReturnType<typeof createTranslator>;
}) {
  const inputStyle = { background: "#f8fbfc", border: "1px solid #dde8ed", borderRadius: "6px", color: "#17202a", fontSize: "0.82rem", padding: "0.3rem 0.6rem" };
  return (
    <div style={{ border: "1px solid #dde8ed", borderRadius: "10px", padding: "1.25rem" }}>
      <p style={{ color: "#607078", fontSize: "0.75rem", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.5px", margin: "0 0 0.85rem" }}>
        🧬 Autor direkt hinzufügen
      </p>
      <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" as const, alignItems: "center", marginBottom: props.strategyRules && props.strategyRules.length > 0 ? "1rem" : 0 }}>
        <input
          placeholder="@username"
          value={props.addUsername}
          onChange={e => props.setAddUsername(e.target.value)}
          onKeyDown={e => e.key === "Enter" && props.addManually()}
          style={{ ...inputStyle, width: "160px" }}
        />
        <select
          value={props.addCategory}
          onChange={e => props.setAddCategory(e.target.value as StrategyCategory)}
          style={{ ...inputStyle, cursor: "pointer" }}
        >
          {(Object.keys(categoryLabel) as StrategyCategory[]).filter(k => k !== "ignorieren").map(k => (
            <option key={k} value={k}>{categoryLabel[k]}</option>
          ))}
        </select>
        <button
          onClick={props.addManually}
          type="button"
          style={{ background: "#2563eb", border: "none", borderRadius: "6px", color: "#fff", cursor: "pointer", fontSize: "0.82rem", fontWeight: 700, padding: "0.35rem 0.85rem" }}
        >
          Hinzufügen
        </button>
      </div>
      {props.strategyRules && props.strategyRules.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.4rem" }}>
          {props.strategyRules.filter(r => r.enabled).map(r => (
            <div key={r.username} style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.82rem", color: "#2d3a42" }}>
              <span style={{ background: categoryColor[r.category] + "18", color: categoryColor[r.category], borderRadius: "4px", padding: "0.1rem 0.4rem", fontSize: "0.7rem", fontWeight: 700 }}>
                {categoryLabel[r.category].split(" ")[0]}
              </span>
              <span style={{ fontWeight: 600 }}>@{r.username}</span>
              <button
                type="button"
                onClick={() => props.onStrategyChange(props.strategyRules!.filter(x => x.username !== r.username))}
                style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer", fontSize: "0.75rem", padding: "0 0.2rem", marginLeft: "auto" }}
              >✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Workflow Journey ──────────────────────────────────────────────────────────
// Visual 4-step journey card showing how VoteBroker works.
// Each step: numbered icon box (60×60) + title + description.
// Arrow connectors + tip panel on the right.

const JOURNEY_STEPS = [
  { num: 1, Icon: UsersRound, tab: "community" as const, color: "#7c3aed", iconBg: "linear-gradient(135deg, #f5f0ff 0%, #ede9fe 100%)", border: "#c4b5fd" },
  { num: 2, Icon: DnaIcon,    tab: "dna"       as const, color: "#2563eb", iconBg: "linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)", border: "#93c5fd" },
  { num: 3, Icon: Settings,   tab: "dna"       as const, color: "#16a34a", iconBg: "linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)", border: "#86efac" },
  { num: 4, Icon: BarChart2,  tab: "dashboard" as const, color: "#d97706", iconBg: "linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%)", border: "#fcd34d" },
] as const;

function WorkflowBar({ onNavigate, t }: {
  onNavigate: (tab: "community" | "dna" | "dashboard") => void;
  t: ReturnType<typeof createTranslator>;
}) {
  const labels = [
    { title: t("stepCommunity"), desc: t("stepCommunityDesc") },
    { title: t("stepDna"),       desc: t("stepDnaDesc")       },
    { title: t("stepStrategy"),  desc: t("stepStrategyDesc")  },
    { title: t("stepDashboard"), desc: t("stepDashboardDesc") },
  ];

  return (
    <div style={{
      display: "flex", alignItems: "stretch",
      background: "#ffffff",
      borderRadius: "16px",
      border: "1px solid #e0d4fc",
      boxShadow: "0 2px 12px rgba(124,58,237,0.06)",
      overflow: "hidden",
    }}>
      {/* Steps */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", padding: "1.25rem 1rem", gap: "0" }}>
        {JOURNEY_STEPS.map((step, i) => (
          <React.Fragment key={step.num}>
            <button
              type="button"
              onClick={() => onNavigate(step.tab)}
              style={{
                flex: 1, display: "flex", alignItems: "center", gap: "0.9rem",
                padding: "0.6rem 0.7rem",
                background: "none", border: "none", cursor: "pointer",
                borderRadius: "12px", textAlign: "left" as const,
                transition: "background 0.15s",
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = `${step.color}08`; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "none"; }}
            >
              {/* Numbered icon box */}
              <div style={{ position: "relative", flexShrink: 0 }}>
                <div style={{
                  width: "60px", height: "60px",
                  background: step.iconBg,
                  border: `1.5px solid ${step.border}`,
                  borderRadius: "14px",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <step.Icon size={28} color={step.color} strokeWidth={1.5} />
                </div>
                <div style={{
                  position: "absolute", top: "-7px", right: "-7px",
                  width: "20px", height: "20px",
                  background: step.color, borderRadius: "50%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: "0.6rem", fontWeight: 900, color: "#fff",
                  boxShadow: `0 1px 5px ${step.color}50`,
                }}>
                  {step.num}
                </div>
              </div>
              {/* Text */}
              <div style={{ minWidth: 0 }}>
                <div style={{ color: step.color, fontWeight: 800, fontSize: "0.87rem", lineHeight: 1.2, marginBottom: "5px" }}>
                  {labels[i].title}
                </div>
                <div style={{ color: "#607078", fontSize: "0.72rem", lineHeight: 1.4 }}>
                  {labels[i].desc}
                </div>
              </div>
            </button>
            {i < 3 && (
              <div style={{ flexShrink: 0, color: "#c5d3da", display: "flex", alignItems: "center", padding: "0 0.15rem" }}>
                <ArrowRight size={20} strokeWidth={1.5} />
              </div>
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Divider + Tip panel */}
      <div style={{ display: "flex", alignItems: "stretch" }}>
        <div style={{ width: "1px", background: "#e8eef2" }} />
        <div style={{ width: "160px", padding: "1.25rem 1rem", display: "flex", flexDirection: "column" as const, justifyContent: "center", gap: "0.4rem" }}>
          <div style={{ color: "#7c3aed", fontSize: "0.62rem", fontWeight: 800, textTransform: "uppercase" as const, letterSpacing: "0.9px" }}>
            {t("secWorkflowGuide")}
          </div>
          <p style={{ color: "#607078", fontSize: "0.72rem", margin: 0, lineHeight: 1.5 }}>
            {t("workflowTipText")}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── CurationDnaPanel ─────────────────────────────────────────────────────

export function CurationDnaPanel(props: {
  error: string | null;
  loading: boolean;
  profile: CurationProfile | null;
  session: AuthSession | null;
  strategyRules: StrategyRule[] | null;
  onStrategyChange: (rules: StrategyRule[] | null) => void;
  opportunities: PostOpportunity[] | null;
  opportunitiesMeta: import("../api").OpportunitiesMeta | null;
  opportunitiesLoading: boolean;
  opportunitiesError: string | null;
  accountSnapshot: SteemAccountSnapshot | null;
  onLoadOpportunities: () => void;
  onExecuteVotes: (targets: Array<{ author: string; permlink: string; weightBps: number }>) => Promise<VoteBatchResult>;
  onExecuteSingle: (target: { author: string; permlink: string; weightBps: number }) => Promise<{ transactionId: string }>;
  votePlan: VotePlanResponse | null;
  planLoading: boolean;
  planError: string | null;
  onGenerateVotes: () => void;
  onGenerateWithTarget: (targetPct: number) => void;
  targetVotingPowerPct: number;
  locale?: import("../i18n").Locale;
  onNavigate?: (tab: "dna" | "dashboard" | "community" | "billing" | "admin") => void;
}) {
  const t = createTranslator(props.locale ?? "de");
  const [addUsername, setAddUsername] = useState("");
  const [addCategory, setAddCategory] = useState<StrategyCategory>("bevorzugt");
  const [strategyOpen, setStrategyOpen] = useState(false);
  const [liveMetrics, setLiveMetrics] = useState<LivePlanMetrics | null>(null);

  const sectionLabel = {
    color: "#607078", fontSize: "0.75rem", textTransform: "uppercase" as const,
    letterSpacing: "0.5px", margin: "0 0 0.5rem", fontWeight: 600,
  };
  const chipBtn = {
    background: "#f0f5f7", border: "1px solid #dde8ed", borderRadius: "6px",
    color: "#607078", cursor: "pointer" as const, fontSize: "0.78rem", padding: "0.3rem 0.65rem",
  };

  const addManually = () => {
    const clean = addUsername.replace(/^@/, "").toLowerCase().trim();
    if (!clean) return;
    const dailyBudgetBps = 2000;
    const weights = computeDynamicWeights(
      [...(props.strategyRules ?? []), { username: clean, category: addCategory }],
      dailyBudgetBps
    );
    const weightBps = weights.get(clean) ?? 200;
    const newRule: StrategyRule = {
      username: clean, category: addCategory,
      maxWeightPct: Math.round(weightBps / 100 * 10) / 10,
      minWeightPct: addCategory === "immer_voten" ? 10 : 0,
      enabled: addCategory !== "ignorieren",
      source: "Manuell",
      sharePct: 0, voteCount: 0, avgWeightPct: 0,
      lastVoteDaysAgo: 0, selectionReasons: [],
      manuallyModified: true,
    };
    const existing = props.strategyRules ?? [];
    if (!existing.find(r => r.username === clean)) {
      props.onStrategyChange([...existing, newRule]);
    }
    setAddUsername("");
  };

  if (!props.session) return null;

  if (props.loading) {
    return (
      <section className="auth-bar">
        <div><span>Vote-DNA</span><strong>Analysiere Voting-Historie...</strong></div>
      </section>
    );
  }

  if (props.error) {
    return (
      <div style={{ maxWidth: "860px", margin: "0 auto" }}>
        <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: "10px", padding: "1rem 1.25rem", marginBottom: "1.5rem" }}>
          <strong style={{ color: "#dc2626", fontSize: "0.9rem" }}>Fehler beim Laden der Vote-Historie</strong>
          <p style={{ color: "#607078", fontSize: "0.82rem", margin: "0.25rem 0 0.75rem" }}>{props.error}</p>
          <button
            type="button"
            onClick={props.onGenerateVotes}
            style={{ background: "#fff", border: "1px solid #fca5a5", borderRadius: "6px", color: "#dc2626", cursor: "pointer", fontSize: "0.78rem", fontWeight: 600, padding: "0.3rem 0.75rem" }}
          >
            ↻ Erneut versuchen
          </button>
        </div>
        <InlineStrategyEditor
          addUsername={addUsername}
          setAddUsername={setAddUsername}
          addCategory={addCategory}
          setAddCategory={setAddCategory}
          addManually={addManually}
          strategyRules={props.strategyRules}
          onStrategyChange={props.onStrategyChange}
          t={t}
        />
      </div>
    );
  }

  if (!props.profile || props.profile.votesAnalyzed === 0) {
    return (
      <div style={{ maxWidth: "860px", margin: "0 auto", display: "flex", flexDirection: "column" as const, gap: "1.25rem" }}>
        {props.onNavigate && <WorkflowBar onNavigate={tab => props.onNavigate!(tab as "community" | "dna" | "dashboard" | "billing" | "admin")} t={t} />}
        {/* Kein Daten-Hinweis */}
        <div style={{ background: "linear-gradient(135deg, #f0f9ff 0%, #f8fbfc 100%)", border: "1px solid #bae6fd", borderRadius: "12px", padding: "1.5rem", display: "flex", alignItems: "flex-start", gap: "1rem" }}>
          <DnaIcon size={24} color="#0369a1" strokeWidth={1.5} style={{ flexShrink: 0, marginTop: "2px" }} />
          <div>
            <strong style={{ color: "#0369a1", fontSize: "1rem", display: "block", marginBottom: "0.4rem" }}>
              {t("stepDna")}
            </strong>
            <p style={{ color: "#607078", fontSize: "0.85rem", margin: "0 0 1rem", lineHeight: 1.6 }}>
              Noch keine Vote-Historie gefunden. Füge Autoren hinzu, die du regelmäßig unterstützen möchtest — VoteBroker erstellt daraus deine Strategie.
            </p>
            {props.onNavigate && (
              <button
                type="button"
                onClick={() => props.onNavigate!("community")}
                style={{ background: "#0369a1", border: "none", borderRadius: "8px", color: "#fff", cursor: "pointer", fontSize: "0.85rem", fontWeight: 700, padding: "0.55rem 1.1rem", display: "flex", alignItems: "center", gap: "0.5rem" }}
              >
                <Search size={14} />
                {t("stepCommunity")} →
              </button>
            )}
          </div>
        </div>
        <InlineStrategyEditor
          addUsername={addUsername}
          setAddUsername={setAddUsername}
          addCategory={addCategory}
          setAddCategory={setAddCategory}
          addManually={addManually}
          strategyRules={props.strategyRules}
          onStrategyChange={props.onStrategyChange}
          t={t}
        />
      </div>
    );
  }

  const p = props.profile;
  const topAuthors = p.topAuthors ?? [];
  const peakHours = p.peakHoursUtc ?? [];
  const maxBar = topAuthors.length > 0 ? Math.max(...topAuthors.map(a => a.voteCount)) : 1;
  const maxHour = peakHours.length > 0 ? Math.max(...peakHours.map(h => h.voteCount)) : 1;
  const generateStrategy = () => props.onStrategyChange(generateStrategyFromProfile(p));

  const regenerate = () => {
    const fresh = generateStrategyFromProfile(p);
    const prev = props.strategyRules;
    if (!prev) { props.onStrategyChange(fresh); return; }
    const manualMap = new Map(prev.filter(r => r.manuallyModified).map(r => [r.username, r]));
    props.onStrategyChange(fresh.map(r => manualMap.get(r.username) ?? r));
  };

  const updateRule = (username: string, patch: Partial<StrategyRule>) => {
    props.onStrategyChange(
      props.strategyRules?.map(r => r.username === username ? { ...r, ...patch, manuallyModified: true } : r) ?? null
    );
  };

  const removeRule = (username: string) => {
    props.onStrategyChange(props.strategyRules?.filter(r => r.username !== username) ?? null);
  };

  const strategyRules = props.strategyRules;
  const noStrategyYet = !strategyRules;

  // ── Kandidaten die nicht im Plan sind, aber aus offenen Chancen verfügbar ──
  const CAT_PRI_MAP: Record<string, number> = {
    immer_voten: 50, lieblingsautor: 40, bevorzugt: 30, normal: 20, niedrig: 10,
  };
  const planKeys = new Set((props.votePlan?.plan ?? []).map(e => `${e.author}/${e.permlink}`));
  const additionalCandidates: VotePlanEntry[] = strategyRules
    ? (props.opportunities ?? [])
        .filter(p => p.eligible && !planKeys.has(`${p.author}/${p.permlink}`))
        .flatMap(p => {
          const rule = strategyRules.find(r => r.username === p.author && r.enabled && r.category !== "ignorieren");
          if (!rule) return [];
          const wBps = Math.round(rule.maxWeightPct * 100);
          return [{
            author:             p.author,
            permlink:           p.permlink,
            title:              p.title || `${p.author}/${p.permlink}`,
            ageMinutes:         p.ageMinutes,
            remainingHours:     p.remainingHours ?? 168,
            postScore:          p.postScore,
            category:           rule.category,
            priority:           CAT_PRI_MAP[rule.category] ?? 0,
            suggestedWeightBps: wBps,
            suggestedWeightPct: Math.round(wBps / 100 * 10) / 10,
            expectedVoteUsd:    Math.round((wBps / 10_000) * (props.accountSnapshot?.currentVoteUsd ?? 0) * 10_000) / 10_000,
            reason:             `Score ${p.postScore} — aus offenen Chancen`,
            reasons:            [`Score ${p.postScore}`, `Aus offenen Chancen`],
            warning:            p.warning ?? null,
          } as VotePlanEntry];
        })
        .sort((a, b) => b.priority !== a.priority ? b.priority - a.priority : b.postScore - a.postScore)
    : [];

  // ── Shared section divider ───────────────────────────────────────────────
  const divider: React.CSSProperties = { marginTop: "1.5rem", borderTop: "1px solid #e8eef2", paddingTop: "1.25rem" };
  const inputStyle: React.CSSProperties = { background: "#f4f7f8", border: "1px solid #dde8ed", borderRadius: "6px", color: "#17202a", padding: "0.35rem 0.6rem", fontSize: "0.82rem" };

  return (
    <section style={{ padding: "1.5rem 2rem", display: "flex", flexDirection: "column" as const, gap: "1.25rem" }}>

      {/* ── 0. Prozessvisualisierung ── */}
      {props.onNavigate && <WorkflowBar onNavigate={tab => props.onNavigate!(tab as "community" | "dna" | "dashboard" | "billing" | "admin")} t={t} />}

      {/* ── 2. Handlungsempfehlung ── */}
      {!strategyRules ? (
        <div style={{ border: "1px dashed #2563eb44", borderRadius: "12px", padding: "1.75rem", background: "#f0f5ff", textAlign: "center" as const, marginBottom: "1.25rem" }}>
          <DnaIcon size={28} color="#2563eb" strokeWidth={1.5} style={{ marginBottom: "0.6rem" }} />
          <p style={{ color: "#17202a", fontSize: "0.95rem", fontWeight: 700, margin: "0 0 0.4rem" }}>{t("stepStrategy")}</p>
          <p style={{ color: "#607078", fontSize: "0.82rem", margin: "0 0 1rem", lineHeight: 1.55, maxWidth: "400px", marginLeft: "auto", marginRight: "auto" }}>
            VoteBroker analysiert deine Vote-Historie und generiert eine nachhaltige Curation-Strategie.
          </p>
          <button style={{ background: "#2563eb", border: "none", borderRadius: "8px", color: "#fff", cursor: "pointer", fontSize: "0.9rem", fontWeight: 700, padding: "0.65rem 1.4rem" }} type="button" onClick={generateStrategy}>
            {t("stepStrategy")} →
          </button>
        </div>
      ) : (
        <div style={{ background: "linear-gradient(160deg, #f0f9ff 0%, #ffffff 60%, #f0fdf4 100%)", border: "1px solid #bae6fd", borderRadius: "18px", padding: "1.75rem 2rem", marginBottom: "1.25rem" }}>
          {(() => {
            const snap       = props.accountSnapshot;
            const plan       = props.votePlan;
            const opps       = props.opportunities;
            const openCount  = (opps ?? []).filter(p => p.eligible).length;
            const hasOpps    = opps !== null;
            const vpNow      = snap ? snap.votingPowerBps / 100 : null;
            // Live-Werte aus Inline-Editing bevorzugen — nur wenn Plan vorhanden
            const vpPlan     = plan ? (liveMetrics?.vpAfterPct    ?? plan.report.vpAfterPlanPct)        : null;
            const vpMorgen   = plan ? (liveMetrics?.vpMorgenPct   ?? plan.report.expectedTomorrowVpPct) : null;
            const freeBudget = plan ? (liveMetrics?.freeBudgetPct ?? null)                              : null;
            const recovery   = plan?.report.recoveryMode ?? false;
            const reduction  = plan?.report.weightReductionPct ?? 0;
            const planVotes  = liveMetrics?.entryCount ?? plan?.summary.totalPosts ?? 0;

            const vpColor = (v: number | null) =>
              v === null ? "#8fa4b0" : v >= 80 ? "#16a34a" : v >= 65 ? "#d97706" : "#dc2626";

            // ── Assistenten-Botschaft ──────────────────────────────────────────
            let msgIcon = "🧬";
            let msgTitle = t("planMsgDefaultTitle");
            let msgBody  = t("planMsgDefault");

            if (props.opportunitiesLoading || props.planLoading) {
              msgIcon = "⏳"; msgTitle = t("planMsgAnalyzingTitle"); msgBody = t("planMsgAnalyzing");
            } else if (openCount > 0 && vpMorgen !== null) {
              const sustainTxt = vpMorgen >= 80
                ? t("planVpTomorrow").replace("{{vp}}", vpMorgen.toFixed(1))
                : t("planVpTomorrowLow").replace("{{vp}}", vpMorgen.toFixed(1));
              const planLine = planVotes > 0 && planVotes < openCount
                ? ` · ${t("planInPlan").replace("{{count}}", String(planVotes))}` : "";
              if (recovery && reduction > 0) {
                msgIcon = "⚡"; msgTitle = t("planMsgPlanReadyTitle").replace("{{count}}", String(openCount)) + planLine;
                msgBody = t("planMsgRecovery").replace("{{reduction}}", String(reduction)).replace("{{vp}}", sustainTxt);
              } else {
                msgIcon = "✅"; msgTitle = t("planMsgPlanReadyTitle").replace("{{count}}", String(openCount)) + planLine;
                msgBody = t("planMsgPlanReady").replace("{{votes}}", String(planVotes)).replace("{{vp}}", sustainTxt);
              }
            } else if (hasOpps && openCount === 0) {
              msgIcon = "✓"; msgTitle = t("planMsgAllVotedTitle"); msgBody = t("planMsgAllVoted");
            } else if (planVotes > 0 && !hasOpps) {
              msgIcon = "🗳"; msgTitle = t("planMsgNoPlanTitle").replace("{{votes}}", String(planVotes)); msgBody = t("planMsgNoPlan");
            }

            // ── KPI-Werte ──────────────────────────────────────────────────────
            const hasEdits = liveMetrics?.hasEdits ?? false;
            const kpis = [
              { value: vpNow    !== null ? `${vpNow.toFixed(1)}%`    : "—", label: "VP",          sub: snap ? `${snap.steemPowerSp.toFixed(0)} SP` : "…",                                            color: vpColor(vpNow)    },
              { value: vpPlan   !== null ? `${vpPlan.toFixed(1)}%`   : "—", label: t("planAfterPlan"),  sub: planVotes > 0 ? `${planVotes} Vote${planVotes !== 1 ? "s" : ""}${hasEdits ? ` ${t("planAdjusted")}` : ""}` : t("planNoPlan"), color: vpColor(vpPlan)   },
              { value: vpMorgen !== null ? `${vpMorgen.toFixed(1)}%` : "—", label: t("planVpMorgen"),  sub: freeBudget !== null && freeBudget > 0 ? `${freeBudget.toFixed(2)}% ${t("planVpFree").replace("{{budget}}", "")}` : vpMorgen !== null && vpMorgen >= 80 ? t("planVpTargetOk") : t("planVpRegen"), color: vpColor(vpMorgen) },
            ];

            return (
              <>
                {/* ── Botschaft ── */}
                <div style={{ marginBottom: "1.5rem" }}>
                  <h3 style={{ color: "#0c4a6e", fontSize: "1.4rem", fontWeight: 900, margin: "0 0 0.5rem", letterSpacing: "-0.5px", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <span>{msgIcon}</span> {msgTitle}
                  </h3>
                  <p style={{ color: "#374151", fontSize: "0.95rem", margin: 0, lineHeight: 1.55, maxWidth: "600px" }}>{msgBody}</p>
                </div>

                {/* ── Haupt-CTA ── */}
                <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.75rem", alignItems: "center", flexWrap: "wrap" as const }}>
                  {/* Primär: offene Votes (wenn vorhanden) oder Scan */}
                  {/* Primär-CTA: Scan oder Status */}
                  {openCount > 0 ? (
                    // Bereits gescannt und Votes gefunden → Status-Chip + Scroll-Hinweis
                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.85rem 1.5rem", background: "#fffbeb", border: "1.5px solid #f59e0b", borderRadius: "14px" }}>
                      <span style={{ color: "#92400e", fontSize: "1.15rem", fontWeight: 900 }}>{t("planOpenFound").replace("{{count}}", String(openCount))}</span>
                      <span style={{ color: "#78350f", fontSize: "0.8rem" }}>{t("planDetailsBelow")}</span>
                      <button type="button" onClick={props.onLoadOpportunities} disabled={props.opportunitiesLoading} style={{ marginLeft: "auto", background: "none", border: "1px solid #d97706", borderRadius: "8px", color: "#d97706", cursor: "pointer", fontSize: "0.75rem", fontWeight: 600, padding: "0.25rem 0.6rem" }}>
                        {props.opportunitiesLoading ? "…" : "↻"}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={props.opportunitiesLoading}
                      onClick={props.onLoadOpportunities}
                      style={{
                        background: hasOpps ? "#f4f7f8" : "#0ea5e9",
                        border: "none", borderRadius: "14px",
                        color: hasOpps ? "#607078" : "#fff",
                        cursor: "pointer", fontSize: "0.95rem", fontWeight: 900,
                        padding: "0.85rem 1.75rem",
                      }}
                    >
                      {props.opportunitiesLoading ? t("btnScanning") : hasOpps ? t("btnRescanNow") : t("btnScanPosts")}
                    </button>
                  )}

                  {/* Sekundär: Plan generieren / aktualisieren */}
                  <button
                    type="button"
                    disabled={props.planLoading}
                    onClick={() => props.onGenerateVotes()}
                    style={{
                      background: "transparent", border: "1.5px solid #cbd5e1",
                      borderRadius: "12px", color: "#475569",
                      cursor: "pointer", fontSize: "0.85rem",
                      fontWeight: 700, padding: "0.65rem 1.25rem",
                    }}
                  >
                    {props.planLoading ? t("planGenerating") : plan ? t("planUpdate") : t("planCreate")}
                  </button>
                </div>

                {/* ── Ziel VP morgen ── */}
                {(() => {
                  const currentVp = props.accountSnapshot
                    ? props.accountSnapshot.votingPowerBps / 100
                    : null;
                  const targets = [98, 95, 90, 85, 80] as const;
                  return (
                    <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.25rem", alignItems: "center", flexWrap: "wrap" as const }}>
                      <span style={{ color: "#94a3b8", fontSize: "0.72rem", fontWeight: 600, whiteSpace: "nowrap" as const }}>
                        {t("planTargetVpLabel")}
                      </span>
                      {targets.map(pct => {
                        const active  = props.targetVotingPowerPct === pct;
                        const budget  = currentVp !== null ? Math.max(0, Math.min(100, currentVp + 20) - pct) : null;
                        const label   = pct >= 95 ? t("planVpConservative") : pct >= 90 ? t("planVpBalanced") : pct >= 85 ? t("planVpStandard") : pct >= 80 ? t("planVpActive") : t("planVpAggressive");
                        return (
                          <button
                            key={pct}
                            type="button"
                            title={budget !== null ? `Budget: ≈${budget.toFixed(1)}% VP · ${label}` : label}
                            onClick={() => props.onGenerateWithTarget(pct)}
                            disabled={props.planLoading}
                            style={{
                              background: active ? "#0ea5e9" : "#f1f5f9",
                              border: active ? "none" : "1.5px solid #e2e8f0",
                              borderRadius: "20px", color: active ? "#fff" : "#475569",
                              cursor: "pointer", fontSize: "0.78rem",
                              fontWeight: active ? 800 : 600,
                              padding: "0.35rem 0.85rem",
                              display: "flex", flexDirection: "column" as const, alignItems: "center",
                            }}
                          >
                            <span style={{ fontWeight: 800 }}>{pct}%</span>
                            {budget !== null && (
                              <span style={{ fontSize: "0.62rem", opacity: 0.75 }}>≈{budget.toFixed(0)}% VP</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}

                {/* ── KPI-Kacheln ── */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem", marginBottom: "1.5rem" }}>
                  {kpis.map(k => (
                    <div key={k.label} style={{
                      background: "#ffffff", border: `1.5px solid ${k.color}22`,
                      borderRadius: "14px", padding: "1rem 1.25rem",
                    }}>
                      <div style={{ color: "#8fa4b0", fontSize: "0.65rem", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.8px", marginBottom: "0.3rem" }}>{k.label}</div>
                      <div style={{ color: k.color, fontSize: "2.8rem", fontWeight: 900, lineHeight: 1, letterSpacing: "-2px", marginBottom: "0.3rem" }}>{k.value}</div>
                      <div style={{ color: "#8fa4b0", fontSize: "0.72rem" }}>{k.sub}</div>
                    </div>
                  ))}
                </div>
              </>
            );
          })()}

          {/* ── Details ── */}
          <div style={{ borderTop: "1px solid #e0f0ff", paddingTop: "1.25rem" }}>
            {props.accountSnapshot && (
              <VotePlanSection
                plan={props.votePlan}
                loading={props.planLoading}
                error={props.planError}
                session={props.session!}
                currentVoteUsd={props.accountSnapshot?.currentVoteUsd}
                sbdPerSteem={props.accountSnapshot?.sbdPerSteem}
                onGenerate={props.onGenerateVotes}
                onExecuteSingle={props.onExecuteSingle}
                onMetricsChange={setLiveMetrics}
                additionalCandidates={additionalCandidates}
                locale={props.locale}
              />
            )}
            <div style={{ marginTop: "1.25rem" }}>
              <OpenVoteOpportunities
                opportunities={props.opportunities}
                meta={props.opportunitiesMeta}
                loading={props.opportunitiesLoading}
                error={props.opportunitiesError}
                strategyRules={strategyRules}
                accountSnapshot={props.accountSnapshot}
                onRefresh={props.onLoadOpportunities}
                onExecuteVotes={props.onExecuteVotes}
                locale={props.locale}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── 3. Insights ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.85rem", marginBottom: "1.25rem" }}>

        {/* Stärkste Beziehungen */}
        {topAuthors.length > 0 && (
          <div style={{ background: "#f8fbfc", border: "1px solid #dde8ed", borderRadius: "10px", padding: "0.9rem 1rem" }}>
            <p style={{ ...sectionLabel, marginBottom: "0.65rem" }}>{t("dnaRelationships")}</p>
            {topAuthors.slice(0, 6).map(a => (
              <div key={a.username} style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.3rem" }}>
                <span style={{ color: "#2563eb", fontSize: "0.74rem", minWidth: "100px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, fontWeight: 600 }}>@{a.username}</span>
                <div style={{ flex: 1, height: "4px", background: "#dde8ed", borderRadius: "2px" }}>
                  <div style={{ width: `${a.voteCount / maxBar * 100}%`, height: "100%", background: "#7c3aed", borderRadius: "2px" }} />
                </div>
                <span style={{ color: "#8fa4b0", fontSize: "0.68rem", minWidth: "48px", textAlign: "right" as const }}>{a.sharePct}%</span>
              </div>
            ))}
          </div>
        )}

        {/* Aktivitätsmuster */}
        {peakHours.length > 0 && (
          <div style={{ background: "#f8fbfc", border: "1px solid #dde8ed", borderRadius: "10px", padding: "0.9rem 1rem" }}>
            <p style={{ ...sectionLabel, marginBottom: "0.65rem" }}>{t("dnaActivityPattern")}</p>
            {peakHours.slice(0, 5).map(h => (
              <div key={h.hour} style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.25rem" }}>
                <span style={{ color: "#607078", fontSize: "0.73rem", minWidth: "38px" }}>{String(h.hour).padStart(2, "0")}:00</span>
                <div style={{ flex: 1, height: "4px", background: "#dde8ed", borderRadius: "2px" }}>
                  <div style={{ width: `${h.voteCount / maxHour * 100}%`, height: "100%", background: "#0d9488", borderRadius: "2px" }} />
                </div>
                <span style={{ color: "#8fa4b0", fontSize: "0.68rem", minWidth: "24px", textAlign: "right" as const }}>{h.voteCount}×</span>
              </div>
            ))}
          </div>
        )}

        {/* Kurator-Level + Nachhaltigkeit */}
        <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.75rem" }}>
          <div style={{ background: "#f8fbfc", border: "1px solid #dde8ed", borderRadius: "10px", padding: "0.9rem 1rem", flex: 1 }}>
            <p style={{ ...sectionLabel, marginBottom: "0.4rem" }}>{t("dnaSustainability")}</p>
            <p style={{ color: "#17202a", fontSize: "0.83rem", fontWeight: 700, margin: "0 0 0.2rem" }}>
              {p.powerStable.relevantAuthors} {t("sustainAuthors")}
            </p>
            <p style={{ color: "#607078", fontSize: "0.73rem", margin: 0, lineHeight: 1.5 }}>
              {t("sustainRecommended")} <b style={{ color: "#17202a" }}>{p.powerStable.maxAvgWeightPct}%</b>{t("sustainPerVote")}<br/>
              {t("sustainVpTarget")} <b style={{ color: "#17202a" }}>80–95%</b>
            </p>
          </div>
        </div>
      </div>

      {/* ── 4. Autoren-Strategie (einklappbar) ── */}
      <div style={{ border: "1px solid #dde8ed", borderRadius: "12px", overflow: "hidden" }}>
        {/* Sticky toggle header */}
        <button
          type="button"
          onClick={() => setStrategyOpen(o => !o)}
          style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "0.85rem 1.25rem", background: strategyOpen ? "#f4f7f8" : "#f8fbfc",
            border: "none", cursor: "pointer", textAlign: "left" as const,
            borderBottom: strategyOpen ? "1px solid #dde8ed" : "none",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span style={{ fontSize: "0.9rem" }}>🧬</span>
            <div>
              <span style={{ color: "#17202a", fontWeight: 700, fontSize: "0.9rem" }}>{t("dnaAuthorStrategy")}</span>
              {strategyRules && (
                <span style={{ color: "#8fa4b0", fontSize: "0.73rem", marginLeft: "0.6rem" }}>
                  {strategyRules.filter(r => r.enabled).length} aktiv
                  {strategyRules.filter(r => r.manuallyModified).length > 0
                    ? ` · ${strategyRules.filter(r => r.manuallyModified).length} ${t("stratManual")}`
                    : ""}
                </span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            {strategyRules && !strategyOpen && (
              <span style={{ display: "flex", gap: "0.3rem" }}>
                {(["immer_voten", "lieblingsautor", "bevorzugt", "normal", "niedrig"] as const)
                  .filter(cat => strategyRules.some(r => r.category === cat && r.enabled))
                  .map(cat => (
                    <span key={cat} style={{ background: categoryColor[cat] + "20", color: categoryColor[cat], borderRadius: "4px", padding: "0.1rem 0.4rem", fontSize: "0.67rem", fontWeight: 700 }}>
                      {strategyRules.filter(r => r.category === cat && r.enabled).length} {categoryLabel[cat].split(" ")[0]}
                    </span>
                  ))
                }
              </span>
            )}
            <span style={{ color: "#607078", fontSize: "0.85rem" }}>{strategyOpen ? "▲" : "▼"}</span>
          </div>
        </button>

        {strategyOpen && (
          <div style={{ padding: "1.25rem" }}>
            {/* Action buttons */}
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" as const, marginBottom: "1rem", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" as const, alignItems: "center" }}>
                <span style={{ color: "#607078", fontSize: "0.75rem", fontWeight: 600 }}>+ Autor:</span>
                <input
                  placeholder="@username"
                  value={addUsername}
                  onChange={e => setAddUsername(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addManually()}
                  style={{ ...inputStyle, width: "140px" }}
                />
                <select value={addCategory} onChange={e => setAddCategory(e.target.value as StrategyCategory)} style={{ ...inputStyle, cursor: "pointer" }}>
                  {(Object.keys(categoryLabel) as StrategyCategory[]).filter(k => k !== "ignorieren").map(k => (
                    <option key={k} value={k}>{categoryLabel[k]}</option>
                  ))}
                </select>
                <button onClick={addManually} type="button" style={{ background: "#2563eb14", border: "1px solid #2563eb40", borderRadius: "6px", color: "#2563eb", cursor: "pointer", fontSize: "0.78rem", fontWeight: 600, padding: "0.3rem 0.65rem" }}>
                  Hinzufügen
                </button>
              </div>
              {strategyRules && (
                <div style={{ display: "flex", gap: "0.4rem" }}>
                  <button style={{ ...chipBtn, fontSize: "0.78rem" }} type="button" onClick={regenerate}>↺ Anpassen</button>
                  <button style={{ background: "#2563eb", border: "none", borderRadius: "7px", color: "#fff", cursor: "pointer", fontSize: "0.78rem", fontWeight: 700, padding: "0.35rem 0.75rem" }} type="button" onClick={generateStrategy}>
                    ✦ Neu generieren
                  </button>
                </div>
              )}
            </div>

            {strategyRules && (
              <StrategyEditor rules={strategyRules} votesPerDay={p.votesPerDay} currentVoteUsd={props.accountSnapshot?.currentVoteUsd ?? 0} onUpdate={updateRule} onRemove={removeRule} locale={props.locale} />
            )}
          </div>
        )}
      </div>

    </section>
  );
}

function StrategyEditor(props: {
  rules: StrategyRule[];
  votesPerDay: number;
  currentVoteUsd: number;
  onUpdate: (username: string, patch: Partial<StrategyRule>) => void;
  onRemove: (username: string) => void;
  locale?: import("../i18n").Locale;
}) {
  return (
    <div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.83rem" }}>
          <thead>
            <tr style={{ color: "#607078", fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.4px", borderBottom: "1px solid #dde8ed" }}>
              <th style={{ textAlign: "left", padding: "0.2rem 0.35rem", fontWeight: 600, width: "20px" }} />
              <th style={{ textAlign: "left", padding: "0.2rem 0.35rem", fontWeight: 600, width: "20px" }}>An</th>
              <th style={{ textAlign: "left", padding: "0.2rem 0.35rem", fontWeight: 600 }}>Autor</th>
              <th style={{ textAlign: "left", padding: "0.2rem 0.35rem", fontWeight: 600 }}>Kategorie</th>
              <th style={{ textAlign: "center", padding: "0.2rem 0.35rem", fontWeight: 600 }}>Max % / ≈$</th>
              <th style={{ textAlign: "center", padding: "0.2rem 0.35rem", fontWeight: 600 }}>Min % / ≈$</th>
              <th style={{ textAlign: "left", padding: "0.2rem 0.35rem", fontWeight: 600 }}>Quelle</th>
              <th style={{ width: "20px" }} />
            </tr>
          </thead>
          <tbody>
            {props.rules.map(rule => (
              <StrategyRuleRow key={rule.username} rule={rule} currentVoteUsd={props.currentVoteUsd} onUpdate={props.onUpdate} onRemove={props.onRemove} locale={props.locale} />
            ))}
          </tbody>
        </table>
      </div>
      <SimulationPanel rules={props.rules} votesPerDay={props.votesPerDay} />
      <PlannedAutoVoteSection rules={props.rules} />
    </div>
  );
}

function StrategyRuleRow(props: {
  rule: StrategyRule;
  currentVoteUsd: number;
  onUpdate: (username: string, patch: Partial<StrategyRule>) => void;
  onRemove: (username: string) => void;
  locale?: import("../i18n").Locale;
}) {
  const t = createTranslator(props.locale ?? "de");
  const [expanded, setExpanded] = useState(false);
  const { rule, onUpdate } = props;
  const color = categoryColor[rule.category];
  const inputStyle = {
    background: "#dde8ed", border: "1px solid #30363d", borderRadius: "4px",
    color: "#17202a", padding: "0.2rem 0.3rem", fontSize: "0.79rem", width: "52px",
  };
  const selectStyle = {
    background: "#dde8ed", border: "1px solid #30363d", borderRadius: "4px",
    color: "#17202a", padding: "0.2rem 0.3rem", fontSize: "0.79rem", cursor: "pointer" as const,
  };

  const lastVoteLabel = rule.lastVoteDaysAgo === 0
    ? "heute"
    : rule.lastVoteDaysAgo === 1 ? "gestern"
    : `vor ${rule.lastVoteDaysAgo}d`;

  return (
    <>
      <tr style={{
        borderLeft: `3px solid ${rule.enabled ? color : "#c5d3da"}`,
        opacity: rule.enabled ? 1 : 0.4,
        background: rule.manuallyModified ? "#f4f7f8" : "transparent",
      }}>
        <td style={{ padding: "0.18rem 0.35rem" }}>
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            style={{ background: "none", border: "none", color: "#607078", cursor: "pointer", fontSize: "0.72rem", padding: "0 2px", lineHeight: 1 }}
          >
            {expanded ? "▾" : "▸"}
          </button>
        </td>
        <td style={{ padding: "0.18rem 0.35rem" }}>
          <input
            type="checkbox" checked={rule.enabled}
            onChange={e => onUpdate(rule.username, { enabled: e.target.checked })}
            style={{ cursor: "pointer", accentColor: color }}
          />
        </td>
        <td style={{ padding: "0.18rem 0.35rem" }}>
          <span style={{ color: "#2563eb", fontWeight: 600, fontSize: "0.83rem" }}>@{rule.username}</span>
        </td>
        <td style={{ padding: "0.18rem 0.35rem" }}>
          <select
            value={rule.category}
            onChange={e => onUpdate(rule.username, { category: e.target.value as StrategyCategory })}
            style={selectStyle}
          >
            {(Object.keys(categoryLabel) as StrategyCategory[]).map(k => (
              <option key={k} value={k}>{categoryLabel[k]}</option>
            ))}
          </select>
        </td>
        <td style={{ padding: "0.18rem 0.35rem", textAlign: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "1px" }}>
            <input type="number" min="0" max="100" step="0.5"
              value={rule.maxWeightPct}
              onChange={e => onUpdate(rule.username, { maxWeightPct: Math.min(100, Math.max(0, Number(e.target.value))) })}
              style={inputStyle}
            />
            {props.currentVoteUsd > 0 && (
              <span style={{ fontSize: "0.63rem", color: "#0d9488", fontWeight: 600, letterSpacing: "-0.2px" }}>
                ≈${(rule.maxWeightPct / 100 * props.currentVoteUsd).toFixed(3)}
              </span>
            )}
          </div>
        </td>
        <td style={{ padding: "0.18rem 0.35rem", textAlign: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "1px" }}>
            <input type="number" min="0" max="100" step="0.5"
              value={rule.minWeightPct}
              onChange={e => onUpdate(rule.username, { minWeightPct: Math.min(100, Math.max(0, Number(e.target.value))) })}
              style={inputStyle}
            />
            {props.currentVoteUsd > 0 && rule.minWeightPct > 0 && (
              <span style={{ fontSize: "0.63rem", color: "#8fa4b0", fontWeight: 600, letterSpacing: "-0.2px" }}>
                ≈${(rule.minWeightPct / 100 * props.currentVoteUsd).toFixed(3)}
              </span>
            )}
          </div>
        </td>
        <td style={{ padding: "0.18rem 0.35rem" }}>
          <span style={{ fontSize: "0.68rem", color: rule.manuallyModified ? "#d97706" : "#8fa4b0", whiteSpace: "nowrap" }}>
            {rule.manuallyModified ? "✎" : rule.source}
          </span>
        </td>
        <td style={{ padding: "0.18rem 0.35rem" }}>
          <button
            type="button"
            onClick={() => props.onRemove(rule.username)}
            style={{ background: "none", border: "none", color: "#8fa4b0", cursor: "pointer", fontSize: "0.78rem", padding: "0 2px" }}
            title="Entfernen"
          >
            ✕
          </button>
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: "#13181f" }}>
          <td colSpan={8} style={{ padding: "0.5rem 0.75rem 0.6rem 2rem", borderLeft: `3px solid ${color}` }}>
            <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", marginBottom: "0.4rem", fontSize: "0.78rem", color: "#607078" }}>
              {rule.voteCount > 0 && (
                <>
                  <span><b style={{ color: "#2d3a42" }}>{rule.voteCount}</b> Votes</span>
                  <span><b style={{ color: "#2d3a42" }}>{rule.sharePct}%</b> Anteil</span>
                  <span>⌀ <b style={{ color: "#2d3a42" }}>{rule.avgWeightPct}%</b> Gewicht</span>
                  <span>Letzter Vote: <b style={{ color: "#2d3a42" }}>{lastVoteLabel}</b></span>
                </>
              )}
              {rule.voteCount === 0 && <span style={{ fontStyle: "italic" }}>{t("stratNoDnaRecord")}</span>}
            </div>
            {rule.selectionReasons.length > 0 && (
              <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                {rule.selectionReasons.map(r => (
                  <span key={r} style={{
                    background: "#2563eb14", color: "#2563eb", border: "1px solid #1f6feb40",
                    borderRadius: "4px", padding: "0.1rem 0.45rem", fontSize: "0.71rem",
                  }}>
                    ✓ {r}
                  </span>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function SimulationPanel(props: { rules: StrategyRule[]; votesPerDay: number }) {
  const active     = props.rules.filter(r => r.enabled && r.category !== "ignorieren");
  const aboveDust  = active.filter(r => r.maxWeightPct * 100 >= 1000); // ≥ 10% = meaningful
  const belowDust  = active.length - aboveDust.length;
  const votesPerDay = Math.max(1, props.votesPerDay);

  // Weight stats only on meaningful votes
  const avgWeightBps = aboveDust.length > 0
    ? aboveDust.reduce((s, r) => s + r.maxWeightPct * 100, 0) / aboveDust.length
    : 0;
  const dailySpendBps = Math.round(votesPerDay * avgWeightBps);
  const regenBps = 2000;
  const netBps   = regenBps - dailySpendBps;

  // Category impact breakdown
  const byCategory = (cat: string) => aboveDust.filter(r => r.category === cat);
  const catGroups: Array<{ label: string; color: string; rules: StrategyRule[] }> = [
    { label: "🔥 Immer",       color: "#ff6b35", rules: byCategory("immer_voten")    },
    { label: "⭐ Liebling",    color: "#d97706", rules: byCategory("lieblingsautor") },
    { label: "🟦 Bevorzugt",  color: "#2563eb", rules: byCategory("bevorzugt")      },
    { label: "⚪ Normal",      color: "#16a34a", rules: byCategory("normal")         },
    { label: "⬇ Niedrig",    color: "#607078", rules: byCategory("niedrig")         },
  ].filter(g => g.rules.length > 0);

  const equilibriumVp = netBps >= 0 ? 100 : Math.max(0, Math.round(100 - (dailySpendBps - regenBps) / 20));
  const status: "sustainable" | "aggressive" | "critical" =
    netBps >= 200 ? "sustainable" : netBps >= -300 ? "aggressive" : "critical";
  const statusConfig = {
    sustainable: { icon: "✓", text: "Nachhaltig", color: "#16a34a" },
    aggressive:  { icon: "⚠", text: "Aggressiv — VP kann sinken", color: "#d97706" },
    critical:    { icon: "🔴", text: "Kritisch — VP entleert sich", color: "#dc2626" },
  }[status];

  return (
    <div style={{ margin: "0.75rem 0", padding: "0.75rem 1rem", background: "#f0f5f7", borderRadius: "6px", border: "1px solid #30363d" }}>
      <p style={{ color: "#607078", fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.5px", margin: "0 0 0.6rem", fontWeight: 600 }}>
        Strategie-Simulation
      </p>

      {/* Dust warning */}
      {belowDust > 0 && (
        <div style={{ background: "#2d2a0e", border: "1px solid #f0a50055", borderRadius: "4px", padding: "0.3rem 0.6rem", marginBottom: "0.5rem", fontSize: "0.77rem", color: "#d97706" }}>
          ⚠ {belowDust} {belowDust === 1 ? "Autor" : "Autoren"} mit zu geringem Gewicht (&lt;10%) — werden beim Vote übersprungen. Erhöhe `maxWeight%` oder ändere die Kategorie.
        </div>
      )}

      {/* Category impact table */}
      {catGroups.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", marginBottom: "0.6rem" }}>
          {catGroups.map(g => {
            const avgPct = Math.round(g.rules.reduce((s, r) => s + r.maxWeightPct, 0) / g.rules.length * 10) / 10;
            return (
              <div key={g.label} style={{ display: "flex", alignItems: "center", gap: "0.75rem", fontSize: "0.78rem" }}>
                <span style={{ color: g.color, minWidth: "100px", fontWeight: 600 }}>{g.label}</span>
                <span style={{ color: "#607078" }}>{g.rules.length} Autor{g.rules.length > 1 ? "en" : ""}</span>
                <span style={{ color: "#17202a" }}>Ø {avgPct}% pro Vote</span>
              </div>
            );
          })}
        </div>
      )}

      {/* VP stats */}
      <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", fontSize: "0.79rem", color: "#607078", marginBottom: "0.4rem" }}>
        <span>Sinnvolle Autoren: <b style={{ color: "#17202a" }}>{aboveDust.length}</b></span>
        <span>Ø Gewicht: <b style={{ color: "#17202a" }}>{Math.round(avgWeightBps / 100 * 10) / 10}%</b></span>
        <span>VP/Tag (est.): <b style={{ color: "#17202a" }}>{Math.round(dailySpendBps / 100 * 10) / 10}%</b></span>
        <span>Bilanz/Tag: <b style={{ color: netBps >= 0 ? "#16a34a" : "#dc2626" }}>{netBps >= 0 ? "+" : ""}{Math.round(netBps / 100 * 10) / 10}%</b></span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
        <span style={{ color: statusConfig.color, fontSize: "0.82rem", fontWeight: 600 }}>
          {statusConfig.icon} {statusConfig.text}
        </span>
        <span style={{ color: "#607078", fontSize: "0.77rem" }}>
          {status === "sustainable"
            ? `VP-Range: ${Math.max(80, equilibriumVp - 5)}–100%`
            : `Gleichgewichts-VP: ca. ${equilibriumVp}%`}
        </span>
      </div>
    </div>
  );
}

function PlannedAutoVoteSection(props: { rules: StrategyRule[] }) {
  const active = props.rules.filter(r => r.enabled && r.category !== "ignorieren");
  const byCategory = (cat: StrategyCategory) => active.filter(r => r.category === cat);

  return (
    <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", background: "#f0f5f7", borderRadius: "6px", border: "1px solid #30363d" }}>
      <p style={{ color: "#607078", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.5px", margin: "0 0 0.6rem", fontWeight: 600 }}>
        Geplante Auto-Vote-Autoren · {active.length} aktiv
      </p>
      {active.length === 0 ? (
        <p style={{ color: "#8fa4b0", fontSize: "0.82rem", margin: 0 }}>Keine aktiven Autoren in der Strategie.</p>
      ) : (
        (["lieblingsautor", "bevorzugt", "normal", "niedrig"] as StrategyCategory[]).map(cat => {
          const authors = byCategory(cat);
          if (authors.length === 0) return null;
          return (
            <div key={cat} style={{ marginBottom: "0.4rem", display: "flex", alignItems: "flex-start", gap: "0.5rem", flexWrap: "wrap" }}>
              <span style={{ color: categoryColor[cat], fontSize: "0.75rem", fontWeight: 600, minWidth: "120px" }}>
                {categoryLabel[cat]}
              </span>
              <span style={{ color: "#607078", fontSize: "0.8rem" }}>
                {authors.map(r => `@${r.username} (max ${r.maxWeightPct}%)`).join(" · ")}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}
