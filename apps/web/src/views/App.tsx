import { AdminDashboard, isAdmin } from "./AdminDashboard";
import { UserDashboard, type RecentVote } from "./UserDashboard";
import {
  AlertTriangle,
  BadgeDollarSign,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Gauge,
  LineChart,
  Network,
  Send,
  ShieldCheck,
  TrendingUp,
  Users,
  WalletCards
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  checkPostingAuthority,
  completeSteemConnectCallback,
  executeVote,
  getAccountSnapshot,
  getAuthorityGrantUrl,
  getCommunityOverview,
  getConsentCatalog,
  getConsentState,
  checkSessionValid,
  DEFAULT_CONSTRAINTS,
  generateVotePlan,
  getCurationDna,
  getPersistedStrategy,
  getVoteOpportunities,
  getSteemConnectUrl,
  persistStrategy,
  type ConstraintReport,
  type VotePlanEntry,
  type VotePlanResponse,
  VoteBroadcastError,
  grantConsent,
  quoteVote,
  revokeConsent,
  signOut,
  type AuthSession,
  type CommunityPoolOverview,
  type ConsentRecord,
  type ConsentState,
  type ConsentType,
  type CurationProfile,
  type PostOpportunity,
  type SteemAccountSnapshot,
  type VotePlanConstraints,
  type VoteExecutionResponse,
  type VoteQuoteResponse
} from "../api";
import { createTranslator, locales, type Locale } from "../i18n";

const statusLabel = {
  active: "Aktiv",
  warning: "Warnung",
  paused: "Pausiert",
  payment_required: "Freischaltung noetig"
};

const dashboardStats = {
  totalCuratedUsd: 42.0,
  activeVoteUsd: 18.75,
  feeUsd: 1.26,
  pendingFeesUsd: 0.08,
  feeCoverage: 96,
  votingPowerHealth: 78,
  curationEfficiency: 33.3
};

const curationSeries = [
  { day: "Mo", curated: 4.2, fees: 0.13, power: 86 },
  { day: "Di", curated: 6.8, fees: 0.2, power: 82 },
  { day: "Mi", curated: 5.4, fees: 0.16, power: 77 },
  { day: "Do", curated: 8.2, fees: 0.25, power: 72 },
  { day: "Fr", curated: 7.1, fees: 0.21, power: 80 },
  { day: "Sa", curated: 5.9, fees: 0.18, power: 84 },
  { day: "So", curated: 4.4, fees: 0.13, power: 78 }
];

const voteFlow = [
  { label: "Active votes", value: "$18.75", color: "teal" },
  { label: "Covered fees", value: "$1.18", color: "green" },
  { label: "Pending fees", value: "$0.08", color: "yellow" },
  { label: "Paused risk", value: "Low", color: "orange" }
];

const timingDelayOptions = [5, 10, 15, 20, 25, 30];

interface VoteBatchResult {
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

// Parses Steemit / PeakD / Hive.blog URLs or @author/permlink into parts
function parseSteemPost(input: string): { author: string; permlink: string } | null {
  const s = input.trim();
  if (!s) return null;
  // URL: https://steemit.com/.../@author/permlink
  try {
    const url = new URL(s);
    const m = url.pathname.match(/@([a-z0-9._-]{3,})\/([\w-]{3,})/);
    if (m) return { author: m[1], permlink: m[2] };
  } catch {}
  // @author/permlink or author/permlink
  const m2 = s.match(/^@?([a-z0-9._-]{3,})\/([\w-]{3,})$/);
  if (m2) return { author: m2[1], permlink: m2[2] };
  return null;
}

function voteErrorMessage(err: unknown): { message: string; code: string; hint?: string } {
  if (err instanceof VoteBroadcastError) {
    const hints: Record<string, string> = {
      session_expired:              "Bitte oben rechts abmelden und erneut mit SteemConnect einloggen.",
      target_vote_consent_required: "Einstellungen → Vote-Consent aktivieren.",
      missing_posting_authority:    "Einstellungen → Posting Authority erteilen → @votebroker.",
      missing_posting_wif:          "Serverseitiges Voting nicht verfügbar. Bitte Betreiber kontaktieren.",
      account_paused:               "Einstellungen → offene Rechnung begleichen.",
    };
    return { message: err.message, code: err.code, hint: hints[err.code] };
  }
  return { message: "Unbekannter Fehler. Bitte Browser-Konsole prüfen.", code: "unknown" };
}

export function App() {
  const [locale, setLocale] = useState<Locale>(() => (window.localStorage.getItem("votebroker.locale") as Locale | null) ?? "de");
  const [session, setSession] = useState<AuthSession | null>(() => {
    const raw = window.localStorage.getItem("votebroker.session");
    return raw ? JSON.parse(raw) as AuthSession : null;
  });
  const [username, setUsername] = useState("demo");
  const [postUrl, setPostUrl] = useState("");
  const [author, setAuthor] = useState("authorname");
  const [permlink, setPermlink] = useState("example-post");
  const [urlParseError, setUrlParseError] = useState<string | null>(null);
  const [desiredVoteUsd, setDesiredVoteUsd] = useState(2.5);
  const [timingMode, setTimingMode] = useState<"auto" | "manual">("auto");
  const [voteDelayMinutes, setVoteDelayMinutes] = useState(15);
  const [plannedVotesToday, setPlannedVotesToday] = useState(10);
  const [targetVotingPowerPct, setTargetVotingPowerPct] = useState(80);
  const [result, setResult] = useState<VoteQuoteResponse | null>(null);
  const [execution, setExecution] = useState<VoteExecutionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [executionError, setExecutionError] = useState<{ message: string; code: string; hint?: string } | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [consentCatalog, setConsentCatalog] = useState<ConsentRecord[]>([]);
  const [consentState, setConsentState] = useState<ConsentState | null>(null);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [communityOverview, setCommunityOverview] = useState<CommunityPoolOverview | null>(null);
  const [communityError, setCommunityError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [consentLoading, setConsentLoading] = useState<ConsentType | null>(null);
  const [hasAuthority, setHasAuthority] = useState<boolean | null>(null);
  const [authorityGrantUrl, setAuthorityGrantUrl] = useState("");
  const [accountSnapshot, setAccountSnapshot] = useState<SteemAccountSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [curationProfile, setCurationProfile] = useState<CurationProfile | null>(null);
  const [curationLoading, setCurationLoading] = useState(false);
  const [curationError, setCurationError] = useState<string | null>(null);
  const [opportunities, setOpportunities] = useState<PostOpportunity[] | null>(null);
  const [opportunitiesMeta, setOpportunitiesMeta] = useState<import("../api").OpportunitiesMeta | null>(null);
  const [opportunitiesLoading, setOpportunitiesLoading] = useState(false);
  const [opportunitiesError, setOpportunitiesError] = useState<string | null>(null);
  const [votePlan, setVotePlan] = useState<VotePlanResponse | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [recentVotes, setRecentVotes] = useState<RecentVote[]>([]);
  const [snapshotRefreshedAt, setSnapshotRefreshedAt] = useState<Date | null>(null);
  const [strategyRules, setStrategyRules] = useState<StrategyRule[] | null>(() => {
    try {
      const saved = window.localStorage.getItem("votebroker.strategy");
      return saved ? JSON.parse(saved) as StrategyRule[] : null;
    } catch { return null; }
  });
  // Prevents debounce-save from overwriting API data before hydration completes
  const [strategyHydrated, setStrategyHydrated] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [activeTab, setActiveTab] = useState<"dna" | "dashboard" | "community" | "billing" | "admin">("dna");
  const t = createTranslator(locale);

  useEffect(() => {
    getConsentCatalog()
      .then(setConsentCatalog)
      .catch((err) => setConsentError(err instanceof Error ? err.message : "Consent catalog could not be loaded"));
  }, []);

  // Validate stored session against the server on startup
  useEffect(() => {
    if (!session) return;
    checkSessionValid(session.token).then(valid => {
      if (!valid) {
        setSessionExpired(true);
        setSession(null);
        window.localStorage.removeItem("votebroker.session");
      }
    });
  }, []);

  useEffect(() => {
    if (!session) {
      setConsentState(null);
      setHasAuthority(null);
      setAuthorityGrantUrl("");
      return;
    }

    getConsentState(session.token)
      .then(setConsentState)
      .catch((err) => setConsentError(err instanceof Error ? err.message : "Consent state could not be loaded"));

    setHasAuthority(null);
    checkPostingAuthority(session.user.username)
      .then(setHasAuthority)
      .catch(() => setHasAuthority(false));

    getAuthorityGrantUrl()
      .then(setAuthorityGrantUrl)
      .catch(() => {});

    setSnapshotLoading(true);
    setAccountSnapshot(null);
    getAccountSnapshot(session.user.username)
      .then((snap) => { setAccountSnapshot(snap); setUsername(snap.username); })
      .catch(() => {})
      .finally(() => setSnapshotLoading(false));

    setCurationLoading(true);
    setCurationProfile(null);
    setCurationError(null);
    getCurationDna(session.user.username, 500)
      .then(setCurationProfile)
      .catch((err) => setCurationError(err instanceof Error ? err.message : "Vote-DNA konnte nicht geladen werden."))
      .finally(() => setCurationLoading(false));
  }, [session]);

  useEffect(() => {
    getCommunityOverview(username)
      .then((overview) => {
        setCommunityOverview(overview);
        setCommunityError(null);
      })
      .catch((err) => setCommunityError(err instanceof Error ? err.message : "Community pool could not be loaded"));
  }, [username]);

  useEffect(() => {
    const callback = readSteemConnectCallback();
    if (!callback) {
      return;
    }

    setAuthLoading(true);
    completeSteemConnectCallback(callback)
      .then((nextSession) => {
        setSession(nextSession);
        setUsername(nextSession.user.username);
        window.localStorage.setItem("votebroker.session", JSON.stringify(nextSession));
        window.history.replaceState({}, document.title, window.location.pathname);
      })
      .catch((err) => setAuthError(err instanceof Error ? err.message : "Login failed"))
      .finally(() => setAuthLoading(false));
  }, []);

  // Step 1: On login, load strategy from API (authoritative source)
  // Sets hydrated=true when done so debounce-save knows it's safe to write
  useEffect(() => {
    if (!session) {
      setStrategyHydrated(false);
      return;
    }
    setStrategyHydrated(false);
    getPersistedStrategy(session.token)
      .then(rules => {
        if (rules && rules.length > 0) {
          // API data is newer/authoritative → overwrite localStorage
          setStrategyRules(rules as StrategyRule[]);
          window.localStorage.setItem("votebroker.strategy", JSON.stringify(rules));
        }
        // If API returns null, keep local state (first use or cleared)
      })
      .catch(() => {})
      .finally(() => setStrategyHydrated(true));
  }, [session?.token]);

  // Step 2: After hydration, debounce-persist user changes to API + localStorage
  useEffect(() => {
    if (!strategyHydrated || strategyRules === null || !session) return;
    window.localStorage.setItem("votebroker.strategy", JSON.stringify(strategyRules));
    const timer = setTimeout(() => {
      persistStrategy(session.token, strategyRules).catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
  }, [strategyRules, strategyHydrated]);

  // Refresh account snapshot (VP, SP, vote value) — called after voting and on a 60s interval
  function refreshSnapshot() {
    if (!session) return;
    setSnapshotLoading(true);
    getAccountSnapshot(session.user.username)
      .then(snap => { setAccountSnapshot(snap); setUsername(snap.username); setSnapshotRefreshedAt(new Date()); })
      .catch(() => {})
      .finally(() => setSnapshotLoading(false));
  }

  // 60s polling for snapshot while on dashboard tab
  useEffect(() => {
    if (!session || activeTab !== "dashboard") return;
    setSnapshotRefreshedAt(new Date()); // mark initial load as "refreshed now"
    const id = setInterval(refreshSnapshot, 60_000);
    return () => clearInterval(id);
  }, [session?.token, activeTab]);

  const votePercent = useMemo(() => {
    if (!result) return "0.00";
    return (result.quote.voteWeightBps / 100).toFixed(2);
  }, [result]);

  function addAuthorToStrategy(username: string, category: StrategyCategory = "bevorzugt") {
    const clean = username.replace(/^@/, "").toLowerCase().trim();
    if (!clean) return;
    const base = Math.max(5, curationProfile?.powerStable.maxAvgWeightPct ?? 20);
    const maxFor: Record<StrategyCategory, number> = {
      immer_voten:    Math.min(100, Math.round(base * 3)),
      lieblingsautor: Math.min(100, Math.round(base * 2.5)),
      bevorzugt:      Math.min(100, Math.round(base * 1.5)),
      normal:         Math.min(100, Math.round(base)),
      niedrig:        Math.max(1,   Math.round(base * 0.4)),
      ignorieren:     0,
    };
    const newRule: StrategyRule = {
      username: clean, category,
      maxWeightPct: maxFor[category],
      minWeightPct: category === "immer_voten" ? 10 : 0,
      enabled: category !== "ignorieren",
      source: "Manuell",
      sharePct: 0, voteCount: 0, avgWeightPct: 0,
      lastVoteDaysAgo: 0, selectionReasons: [],
      manuallyModified: true,
    };
    setStrategyRules(prev => {
      if (!prev) return [newRule];
      if (prev.find(r => r.username === clean)) return prev;
      return [...prev, newRule];
    });
  }

  async function generateVotes() {
    if (!session || !strategyRules || !accountSnapshot) return;
    setPlanLoading(true);
    setPlanError(null);
    try {
      const currentVpPct = accountSnapshot.votingPowerBps / 100;

      // VP-adaptive constraints: when VP is high, allow spending more per run
      // This enables meaningful votes without draining VP unsustainably
      const adaptiveConstraints: typeof DEFAULT_CONSTRAINTS = {
        ...DEFAULT_CONSTRAINTS,
        // Floor: ensure at least 20% VP remains after this run
        // But never go below the user's configured target (targetVotingPowerPct)
        minVpPct: Math.max(20, Math.min(DEFAULT_CONSTRAINTS.minVpPct, currentVpPct - 30)),
        // When VP > 90%: allow spending up to 70% of current VP in one run
        // When VP < 80%: cap at 20% to conserve
        maxVpSpendPct: currentVpPct >= 90 ? 70
          : currentVpPct >= 80 ? 40
          : currentVpPct >= 70 ? 20
          : 10,
      };

      const plan = await generateVotePlan({
        voterUsername:  session.user.username,
        currentVpBps:   accountSnapshot.votingPowerBps,
        currentVoteUsd: accountSnapshot.currentVoteUsd,
        targetVpPct:    targetVotingPowerPct,
        constraints:    adaptiveConstraints,
        rules: strategyRules.map(r => ({
          username:         r.username,
          category:         r.category,
          maxWeightPct:     r.maxWeightPct,
          minWeightPct:     r.minWeightPct,
          enabled:          r.enabled,
          selectionReasons: r.selectionReasons,
        }))
      });
      setVotePlan(plan);
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "Plan konnte nicht generiert werden");
    } finally {
      setPlanLoading(false);
    }
  }

  async function loadOpportunities() {
    if (!session || !strategyRules) return;

    // Deduplicate + filter active non-ignored authors
    const allActive = strategyRules
      .filter(r => r.enabled && r.category !== "ignorieren")
      .map(r => r.username.toLowerCase().trim())
      .filter(Boolean);
    const unique = [...new Set(allActive)];

    console.log(
      `[VoteBroker] loadOpportunities — Strategy has ${strategyRules.length} rules, ` +
      `${allActive.length} active (${allActive.length - unique.length} dupes removed), ` +
      `sending ${unique.length} authors:`,
      unique
    );

    if (unique.length === 0) return;
    setOpportunitiesLoading(true);
    setOpportunitiesError(null);
    try {
      const result = await getVoteOpportunities(unique, session.user.username);
      setOpportunities(result.opportunities);
      setOpportunitiesMeta(result.meta);

      // Log the meta summary in the browser console for easy debugging
      console.log("[VoteBroker] Opportunity scan complete:", {
        requested:    result.meta.requestedAuthors,
        scanned:      result.meta.scannedAuthors,
        totalPosts:   result.meta.totalPosts,
        eligible:     result.meta.eligiblePosts,
        perAuthor:    result.meta.perAuthor,
      });

      // Flag authors with no recent posts
      const noPostAuthors = Object.entries(result.meta.perAuthor)
        .filter(([, v]) => v.noRecentPosts)
        .map(([k]) => k);
      if (noPostAuthors.length > 0) {
        console.warn("[VoteBroker] Authors with no recent posts on Steem:", noPostAuthors);
      }
    } catch (err) {
      setOpportunitiesError(err instanceof Error ? err.message : "Fehler beim Laden der offenen Votes");
    } finally {
      setOpportunitiesLoading(false);
    }
  }

  async function executeStrategyVotes(
    targets: Array<{ author: string; permlink: string; weightBps: number }>
  ): Promise<VoteBatchResult> {
    if (!session) return { ok: 0, failed: 0, skipped: 0, results: [] };
    let ok = 0, failed = 0, skipped = 0;
    const results: VoteBatchResult["results"] = [];

    for (const target of targets) {
      try {
        const res = await executeVote(session.token, {
          author: target.author, permlink: target.permlink, weightBps: target.weightBps
        });
        ok++;
        results.push({ author: target.author, permlink: target.permlink, status: "success", transactionId: res.transactionId });
        setOpportunities(prev => prev?.map(p =>
          p.author === target.author && p.permlink === target.permlink
            ? { ...p, alreadyVoted: true, eligible: false } : p
        ) ?? null);
        setRecentVotes(prev => [{
          author: target.author, permlink: target.permlink, title: "",
          weightPct: Math.round(target.weightBps / 100 * 10) / 10,
          votedAt: new Date().toISOString(),
        }, ...prev].slice(0, 20));
      } catch (err) {
        const msg  = err instanceof Error ? err.message : String(err);
        const code = err instanceof VoteBroadcastError ? err.code : "broadcast_failed";
        const isAlreadyVoted = code === "already_voted" || msg.includes("already");
        if (isAlreadyVoted) {
          skipped++;
          results.push({ author: target.author, permlink: target.permlink, status: "skipped", errorMessage: "Bereits gevoted", errorCode: "already_voted" });
          // Mark as voted in UI
          setOpportunities(prev => prev?.map(p =>
            p.author === target.author && p.permlink === target.permlink
              ? { ...p, alreadyVoted: true, eligible: false } : p
          ) ?? null);
        } else {
          failed++;
          results.push({ author: target.author, permlink: target.permlink, status: "failed", errorMessage: msg, errorCode: code });
        }
      }
      if (targets.indexOf(target) < targets.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    // After batch is done, refresh VP and re-scan opportunities
    if (ok + skipped > 0) {
      setTimeout(() => refreshSnapshot(), 4_000);
      if (opportunities !== null) setTimeout(() => loadOpportunities(), 7_000);
    }
    return { ok, failed, skipped, results };
  }

  // Direct single-vote executor — throws on any failure, returns real transactionId
  async function executeSingleVote(target: { author: string; permlink: string; weightBps: number }): Promise<{ transactionId: string }> {
    if (!session) throw new VoteBroadcastError("session_expired", "Session abgelaufen. Bitte erneut einloggen.");
    const result = await executeVote(session.token, target); // throws VoteBroadcastError on failure
    // Track in dashboard recent votes
    setRecentVotes(prev => [{
      author:    target.author,
      permlink:  target.permlink,
      title:     "",
      weightPct: Math.round(target.weightBps / 100 * 10) / 10,
      votedAt:   new Date().toISOString(),
    }, ...prev].slice(0, 20));
    // Mark as voted in opportunities
    setOpportunities(prev => prev?.map(p =>
      p.author === target.author && p.permlink === target.permlink
        ? { ...p, alreadyVoted: true, eligible: false }
        : p
    ) ?? null);
    // Refresh VP after the Steem node has processed the transaction
    setTimeout(() => refreshSnapshot(), 4_000);
    if (opportunities !== null) setTimeout(() => loadOpportunities(), 7_000);
    return { transactionId: result.transactionId };
  }

  function changeLocale(nextLocale: Locale) {
    setLocale(nextLocale);
    window.localStorage.setItem("votebroker.locale", nextLocale);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setExecution(null);
    setExecutionError(null);

    try {
      const quote = await quoteVote({
        username,
        author,
        permlink,
        desiredVoteUsd,
        timingMode,
        voteDelayMinutes: timingMode === "manual" ? voteDelayMinutes : undefined,
        plannedVotesToday,
        targetVotingPowerBps: targetVotingPowerPct * 100
      });
      setResult(quote);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function connectSteem() {
    setAuthLoading(true);
    setAuthError(null);

    try {
      const url = await getSteemConnectUrl();
      window.location.assign(url);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Login could not be started");
      setAuthLoading(false);
    }
  }

  async function disconnect() {
    if (session) {
      await signOut(session.token);
    }
    setSession(null);
    setHasAuthority(null);
    setAuthorityGrantUrl("");
    setAccountSnapshot(null);
    setCurationProfile(null);
    window.localStorage.removeItem("votebroker.session");
  }

  async function updateConsent(type: ConsentType, action: "grant" | "revoke") {
    if (!session) {
      setConsentError("Please connect with SteemConnect first.");
      return;
    }

    setConsentLoading(type);
    setConsentError(null);
    try {
      const nextState = action === "grant"
        ? await grantConsent(session.token, type)
        : await revokeConsent(session.token, type);
      setConsentState(nextState);
    } catch (err) {
      setConsentError(err instanceof Error ? err.message : "Consent could not be updated");
    } finally {
      setConsentLoading(null);
    }
  }

  async function broadcastQuotedVote() {
    if (!session || !result) {
      setExecutionError({ message: "Bitte zuerst mit SteemConnect verbinden und eine Quote erstellen.", code: "no_session" });
      return;
    }

    setExecutionError(null);
    try {
      const nextExecution = await executeVote(session.token, {
        author: result.quote.author,
        permlink: result.quote.permlink,
        weightBps: result.quote.voteWeightBps
      });
      setExecution(nextExecution);
    } catch (err) {
      const parsed = voteErrorMessage(err);
      setExecutionError(parsed);
      if (parsed.code === "session_expired") {
        setSession(null);
        window.localStorage.removeItem("votebroker.session");
        setSessionExpired(true);
      }
    }
  }

  // ── PRE-LOGIN: Landing page with value proposition ───────────────────────
  if (!session) {
    const landingFeatures = [
      {
        icon: "🎯",
        title: "Deine Lieblingsautoren immer im Blick",
        desc: "VoteBroker analysiert deine Vote-Historie und erkennt, welche Autoren dir wirklich wichtig sind — und schlägt dir nachhaltige Vote-Gewichte vor.",
      },
      {
        icon: "⚡",
        title: "Voting Power gesund halten",
        desc: "Wer zu viel auf einmal votet, kann morgen kaum noch unterstützen. VoteBroker verteilt deine VP so, dass du jeden Tag für viele Autoren da sein kannst.",
      },
      {
        icon: "🔒",
        title: "Du entscheidest immer selbst",
        desc: "VoteBroker schlägt vor und bereitet vor. Der Klick liegt bei dir. Kein autonomes Voten, keine Überraschungen.",
      },
    ];
    return (
      <main className="shell" style={{ minHeight: "100vh", background: "#0d1117" }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "1rem 1.5rem", borderBottom: "1px solid #21262d" }}>
          <span style={{ fontWeight: 700, color: "#58a6ff", fontSize: "1rem", letterSpacing: "-0.3px" }}>VoteBroker</span>
          <label className="language-select">
            <span>{t("language")}</span>
            <select value={locale} onChange={(event) => changeLocale(event.target.value as Locale)}>
              {locales.map((item) => (
                <option key={item.code} value={item.code}>{item.label}</option>
              ))}
            </select>
          </label>
        </header>

        <div style={{ maxWidth: "580px", margin: "0 auto", padding: "3.5rem 1.5rem 4rem" }}>

          {/* Hero */}
          <div style={{ textAlign: "center", marginBottom: "2.5rem" }}>
            <p style={{ color: "#8b949e", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "1px", fontWeight: 600, marginBottom: "0.75rem" }}>
              Community Support für Steem
            </p>
            <h1 style={{ color: "#e6edf3", fontSize: "1.75rem", fontWeight: 800, lineHeight: 1.25, margin: "0 0 1rem", letterSpacing: "-0.5px" }}>
              Unterstütze die Autoren,<br />die dir wichtig sind
            </h1>
            <p style={{ color: "#8b949e", fontSize: "0.95rem", lineHeight: 1.6, margin: 0, maxWidth: "460px", marginInline: "auto" }}>
              VoteBroker ist ein Curation-Management-System für Steem. Es hilft dir,
              deine Lieblingsautoren regelmäßig und nachhaltig zu supporten —
              ohne deine Voting Power zu erschöpfen.
            </p>
          </div>

          {/* Feature list */}
          <div style={{ display: "flex", flexDirection: "column" as const, gap: "0.75rem", marginBottom: "2.5rem" }}>
            {landingFeatures.map(f => (
              <div key={f.title} style={{
                display: "flex", gap: "0.85rem", alignItems: "flex-start",
                background: "#161b22", border: "1px solid #21262d", borderRadius: "10px",
                padding: "0.85rem 1rem",
              }}>
                <span style={{ fontSize: "1.35rem", lineHeight: 1, marginTop: "0.05rem", flexShrink: 0 }}>{f.icon}</span>
                <div>
                  <p style={{ color: "#e6edf3", fontSize: "0.88rem", fontWeight: 600, margin: "0 0 0.2rem" }}>{f.title}</p>
                  <p style={{ color: "#8b949e", fontSize: "0.8rem", lineHeight: 1.5, margin: 0 }}>{f.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Alerts */}
          {sessionExpired && (
            <div className="notice danger" style={{ marginBottom: "1rem" }}>
              <AlertTriangle size={16} />
              <div>
                <strong>Session abgelaufen.</strong>
                <p style={{ margin: "0.25rem 0 0", fontSize: "0.82rem" }}>Der Server wurde neugestartet. Bitte erneut einloggen.</p>
              </div>
            </div>
          )}
          {authError && (
            <div className="notice danger" style={{ marginBottom: "1rem" }}>
              <AlertTriangle size={16} />
              {authError}
            </div>
          )}

          {/* CTA */}
          <button
            className="secondary-button"
            disabled={authLoading}
            style={{ width: "100%", justifyContent: "center", padding: "0.85rem 1.5rem", fontSize: "1rem", fontWeight: 700, borderRadius: "8px" }}
            type="button"
            onClick={connectSteem}
          >
            <ShieldCheck size={18} />
            {authLoading ? t("connecting") : "Mit SteemLogin verbinden"}
          </button>

          <p style={{ color: "#484f58", fontSize: "0.73rem", marginTop: "0.85rem", textAlign: "center", lineHeight: 1.6 }}>
            Login via SteemLogin (Posting Authority) · Kein Key-Speicher · Jederzeit widerrufbar
          </p>
        </div>
      </main>
    );
  }

  // ── POST-LOGIN: Tabbed layout ─────────────────────────────────────────────
  return (
    <main className="shell">

      {/* Compact topbar */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.75rem 1.5rem", borderBottom: "1px solid #21262d", background: "#0d1117", flexWrap: "wrap", gap: "0.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <span style={{ fontWeight: 700, color: "#58a6ff", fontSize: "0.95rem" }}>VoteBroker</span>
          {accountSnapshot ? (
            <span style={{ color: "#8b949e", fontSize: "0.82rem" }}>
              @{accountSnapshot.username} · <b style={{ color: "#e6edf3" }}>{accountSnapshot.steemPowerSp.toFixed(0)} SP</b> · <b style={{ color: "#e6edf3" }}>{(accountSnapshot.votingPowerBps / 100).toFixed(1)}%</b> VP · ~<b style={{ color: "#e6edf3" }}>${accountSnapshot.currentVoteUsd.toFixed(4)}</b>
            </span>
          ) : (
            <span style={{ color: "#8b949e", fontSize: "0.82rem" }}>@{session.user.username}</span>
          )}
          {hasAuthority === false && (
            <a href={authorityGrantUrl} style={{ color: "#f0883e", fontSize: "0.78rem", textDecoration: "none", border: "1px solid #f0883e", padding: "0.15rem 0.5rem", borderRadius: "4px" }}>
              ⚠ Posting Authority erteilen
            </a>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <label className="language-select">
            <span>{t("language")}</span>
            <select value={locale} onChange={(event) => changeLocale(event.target.value as Locale)}>
              {locales.map((item) => (
                <option key={item.code} value={item.code}>{item.label}</option>
              ))}
            </select>
          </label>
          <button className="secondary-button" type="button" onClick={disconnect} style={{ padding: "0.3rem 0.75rem", fontSize: "0.8rem" }}>
            {t("signout")}
          </button>
        </div>
      </header>

      {/* Tab navigation */}
      <nav style={{ display: "flex", borderBottom: "1px solid #21262d", background: "#0d1117", padding: "0 1.5rem" }}>
        {(["dna", "dashboard", "community", "billing"] as const).map((tab) => {
          const labels: Record<string, string> = {
            dna: "🧬 Vote-DNA",
            dashboard: "📊 Dashboard",
            community: "👥 Community",
            billing: "⚙ Einstellungen"
          };
          return (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              style={{
                background: "none", border: "none", cursor: "pointer",
                padding: "0.75rem 1.25rem", fontSize: "0.875rem", fontWeight: 500,
                color: activeTab === tab ? "#e6edf3" : "#8b949e",
                borderBottom: activeTab === tab ? "2px solid #58a6ff" : "2px solid transparent",
                marginBottom: "-1px"
              }}
            >
              {labels[tab]}
            </button>
          );
        })}
        {/* Admin tab — only visible for owner */}
        {isAdmin(session) && (
          <button
            type="button"
            onClick={() => setActiveTab("admin")}
            style={{
              background: "none", border: "none", cursor: "pointer",
              padding: "0.75rem 1.25rem", fontSize: "0.875rem", fontWeight: 500,
              color: activeTab === "admin" ? "#f0a500" : "#8b949e",
              borderBottom: activeTab === "admin" ? "2px solid #f0a500" : "2px solid transparent",
              marginBottom: "-1px", marginLeft: "auto"
            }}
          >
            🛡 Admin
          </button>
        )}
      </nav>

      {/* Tab: Vote-DNA */}
      {activeTab === "dna" && (
        <div style={{ padding: "1.25rem 1.5rem" }}>
          <CurationDnaPanel
            error={curationError}
            loading={curationLoading}
            profile={curationProfile}
            session={session}
            strategyRules={strategyRules}
            onStrategyChange={setStrategyRules}
            opportunities={opportunities}
            opportunitiesMeta={opportunitiesMeta}
            opportunitiesLoading={opportunitiesLoading}
            opportunitiesError={opportunitiesError}
            accountSnapshot={accountSnapshot}
            onLoadOpportunities={loadOpportunities}
            onExecuteVotes={executeStrategyVotes}
            onExecuteSingle={executeSingleVote}
            votePlan={votePlan}
            planLoading={planLoading}
            planError={planError}
            onGenerateVotes={generateVotes}
          />
        </div>
      )}

      {/* Tab: Dashboard */}
      {activeTab === "dashboard" && (
        <UserDashboard
          session={session}
          snapshot={accountSnapshot}
          snapshotLoading={snapshotLoading}
          snapshotRefreshedAt={snapshotRefreshedAt ?? undefined}
          strategyRules={strategyRules}
          opportunities={opportunities}
          opportunitiesLoading={opportunitiesLoading}
          votePlan={votePlan}
          curationProfile={curationProfile}
          recentVotes={recentVotes}
          onTabChange={setActiveTab}
          onGenerateVotes={generateVotes}
          onLoadOpportunities={loadOpportunities}
          onRefreshSnapshot={refreshSnapshot}
        />
      )}

      {/* Tab: Community */}
      {activeTab === "community" && (
        <div style={{ padding: "1.25rem 1.5rem" }}>
          <CommunityPoolSection communityError={communityError} overview={communityOverview} onAddToStrategy={addAuthorToStrategy} />
        </div>
      )}

      {/* Tab: Billing / Einstellungen */}
      {activeTab === "billing" && (
        <div>
          <AuthorityPanel grantUrl={authorityGrantUrl} hasAuthority={hasAuthority} session={session} />
          <ConsentPanel
            catalog={consentCatalog}
            consentError={consentError}
            loadingType={consentLoading}
            onGrant={(type) => updateConsent(type, "grant")}
            onRevoke={(type) => updateConsent(type, "revoke")}
            session={session}
            state={consentState}
            t={t}
          />
        </div>
      )}

      {/* Tab: Admin Dashboard — only for @jan-philippvieth */}
      {activeTab === "admin" && isAdmin(session) && (
        <AdminDashboard session={session} />
      )}

    </main>
  );
}

function readSteemConnectCallback(): { code?: string; accessToken?: string; expiresIn?: number; state: string } | null {
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const search = url.searchParams;
  const state = search.get("state") ?? hash.get("state");
  const code = search.get("code") ?? undefined;
  const accessToken = search.get("access_token") ?? hash.get("access_token") ?? undefined;
  const expiresRaw = search.get("expires_in") ?? hash.get("expires_in");
  const expiresIn = expiresRaw ? Number(expiresRaw) : undefined;

  if (!state || (!code && !accessToken)) {
    return null;
  }

  return {
    code,
    accessToken,
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : undefined,
    state
  };
}

function VoteExecutionPanel(props: {
  quote: VoteQuoteResponse;
  execution: VoteExecutionResponse | null;
  error: { message: string; code: string; hint?: string } | null;
  hasSession: boolean;
  onExecute: () => void;
}) {
  const errorActionLink: Record<string, { label: string; tab: string }> = {
    target_vote_consent_required: { label: "Einstellungen öffnen", tab: "billing" },
    missing_posting_authority:    { label: "Posting Authority erteilen", tab: "billing" },
  };

  return (
    <section className="execution-panel">
      <div>
        <span>Live Vote Broadcast</span>
        <strong>{props.hasSession ? "Bereit — Vote-Consent erforderlich" : "Login erforderlich"}</strong>
        <p>VoteBroker sendet diesen Vote erst nach aktivem Vote-Consent. Der Posting-Key verlässt niemals den Server.</p>
      </div>
      <button className="primary-button" disabled={!props.hasSession || props.quote.quote.voteWeightBps <= 0} type="button" onClick={props.onExecute}>
        <Send size={16} />
        Vote senden
      </button>
      {props.execution && (
        <p className="execution-success">✓ Broadcast akzeptiert · TX: {props.execution.transactionId}</p>
      )}
      {props.error && (
        <div style={{ marginTop: "0.5rem" }}>
          <p className="execution-error" style={{ margin: 0 }}>
            ✗ {props.error.message}
          </p>
          {props.error.hint && (
            <p style={{ color: "#8b949e", fontSize: "0.78rem", margin: "0.2rem 0 0" }}>
              → {props.error.hint}
            </p>
          )}
          {errorActionLink[props.error.code] && (
            <p style={{ color: "#58a6ff", fontSize: "0.78rem", margin: "0.2rem 0 0" }}>
              Gehe zu: Einstellungen-Tab
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function PowerRecommendationResult(props: { recommendation: VoteQuoteResponse["quote"]["powerRecommendation"] }) {
  const recommendation = props.recommendation;
  const tone = recommendation.riskLevel === "low"
    ? "good"
    : recommendation.riskLevel === "medium"
      ? "watch"
      : "danger";

  return (
    <section className={`power-stable-result ${tone}`}>
      <div className="power-stable-head">
        <div>
          <span>Power-Stable Empfehlung</span>
          <strong>{recommendation.message}</strong>
        </div>
        <b>{recommendation.riskLevel}</b>
      </div>
      <p>{recommendation.detail}</p>
      <div className="power-stable-metrics">
        <Metric label="Empfohlen max." value={`${(recommendation.maxAverageVoteWeightBps / 100).toFixed(2)}%`} />
        <Metric label="Dieser Vote" value={`${(recommendation.desiredVoteWeightBps / 100).toFixed(2)}%`} />
        <Metric label="Tagesbudget" value={`${(recommendation.dailyPowerBudgetBps / 100).toFixed(2)}%`} />
        <Metric label="Ziel morgen" value={`${(recommendation.targetVotingPowerBps / 100).toFixed(0)}%`} />
      </div>
    </section>
  );
}

function BillingTransparency(props: { invoice: VoteQuoteResponse["feeInvoice"] }) {
  const modeTone = props.invoice.billingMode === "billable" || props.invoice.billingMode === "grace"
    ? "billable"
    : props.invoice.billingMode === "paused"
      ? "paused"
      : "free";

  return (
    <section className={`billing-transparency ${modeTone}`}>
      <div className="billing-transparency-head">
        <div>
          <span>Payment Rule</span>
          <strong>{props.invoice.transparency.headline}</strong>
        </div>
        <b>{props.invoice.billingMode}</b>
      </div>
      <p>{props.invoice.transparency.userMessage}</p>
      <small>{props.invoice.transparency.detail}</small>
      <ul>
        {props.invoice.transparency.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {props.invoice.transparency.donationAllowed && (
        <div className="donation-strip">
          Freiwilliger Support-Vote ist erlaubt, aber keine Pflicht.
        </div>
      )}
    </section>
  );
}

function TimingResult(props: { timing: VoteQuoteResponse["quote"]["timing"] }) {
  const bestOptions = [...props.timing.options].sort((left, right) => right.score - left.score).slice(0, 3);

  return (
    <section className="timing-result">
      <div className="timing-result-head">
        <div>
          <span>Vote Timing</span>
          <strong>{props.timing.selectedDelayMinutes} min nach Post-Erstellung</strong>
        </div>
        <div className="timing-score">
          <span>{props.timing.score}</span>
          Score
        </div>
      </div>
      <div className="timing-rationale">
        {props.timing.rationale.map((entry) => (
          <p key={entry}>{entry}</p>
        ))}
      </div>
      <div className="timing-options">
        {bestOptions.map((option) => (
          <div className={option.delayMinutes === props.timing.selectedDelayMinutes ? "selected" : ""} key={option.delayMinutes}>
            <strong>{option.delayMinutes} min</strong>
            <span>{option.score}/100</span>
            <small>{option.riskPct}% Risiko</small>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Consent Center metadata ───────────────────────────────────────────────────

const CONSENT_META: Record<ConsentType, {
  icon: string;
  label: string;
  description: string;
  note: string;
  required: boolean;
}> = {
  login: {
    icon: "🔐",
    label: "Login",
    description: "Erlaubt VoteBroker deinen Account zu erkennen und eine lokale Session zu erstellen.",
    note: "Erforderlich für alle anderen Funktionen.",
    required: true,
  },
  target_vote: {
    icon: "📊",
    label: "Zielvote Berechnung",
    description: "VoteBroker darf Vote-Werte und Zielgewichte für deinen Account berechnen.",
    note: "Erforderlich für die Quote-Funktion.",
    required: false,
  },
  auto_vote: {
    icon: "🤖",
    label: "Automatisches Voting",
    description: "VoteBroker darf in deinem Namen Votes auf Steem senden — nur nach expliziter Freigabe und gemäß deiner Strategie.",
    note: "Kann jederzeit deaktiviert werden. Nur mit aktiver Posting Authority.",
    required: false,
  },
  fee_post_vote: {
    icon: "💰",
    label: "Fee Posts",
    description: "VoteBroker darf transparente Servicegebühren durch einen Vote auf den ausgewiesenen Gebührenpost begleichen.",
    note: "Nur ausgeführt wenn eine offene Rechnung vorliegt.",
    required: false,
  },
  ai_strategy: {
    icon: "🧬",
    label: "AI Strategie Optimierung",
    description: "VoteBroker darf deine Voting-Historie analysieren um personalisierte Strategie-Empfehlungen zu erstellen.",
    note: "Voting-Daten werden nicht gespeichert oder an Dritte weitergegeben.",
    required: false,
  },
};

// Ordered display
const CONSENT_ORDER: ConsentType[] = ["login", "target_vote", "auto_vote", "fee_post_vote", "ai_strategy"];

function ConsentPanel(props: {
  catalog: ConsentRecord[];
  consentError: string | null;
  loadingType: ConsentType | null;
  onGrant: (type: ConsentType) => void;
  onRevoke: (type: ConsentType) => void;
  session: AuthSession | null;
  state: ConsentState | null;
  t: ReturnType<typeof createTranslator>;
}) {
  const activeTypes = new Set(props.state?.active.map((r) => r.type) ?? []);
  const history = props.state?.history.filter(r => r.status === "revoked").slice(0, 5) ?? [];

  const panelStyle: React.CSSProperties = {
    background: "#0d1117", border: "1px solid #21262d", borderRadius: "8px", padding: "1.25rem 1.5rem",
    marginBottom: "1rem"
  };

  return (
    <div>
      {/* Header */}
      <div style={{ ...panelStyle, marginBottom: "0.75rem" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.25rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <ShieldCheck size={18} style={{ color: "#58a6ff" }} />
            <span style={{ color: "#e6edf3", fontWeight: 700, fontSize: "1rem" }}>Berechtigungen</span>
          </div>
          <span style={{ color: "#8b949e", fontSize: "0.78rem" }}>
            {activeTypes.size} von {CONSENT_ORDER.length} aktiv
          </span>
        </div>
        <p style={{ color: "#8b949e", fontSize: "0.82rem", margin: 0 }}>
          Du behältst die vollständige Kontrolle. Jede Berechtigung kann jederzeit widerrufen werden.
        </p>
      </div>

      {props.consentError && (
        <div style={{ background: "#3d0e0e", border: "1px solid #f85149", borderRadius: "6px", padding: "0.6rem 0.75rem", marginBottom: "0.75rem", color: "#f85149", fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <AlertTriangle size={14} />
          {props.consentError}
        </div>
      )}

      {/* Consent list */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
        {CONSENT_ORDER.map(type => {
          const meta    = CONSENT_META[type];
          const active  = activeTypes.has(type);
          const loading = props.loadingType === type;
          const disabled = !props.session || loading;
          const catalog = props.catalog.find(r => r.type === type);

          return (
            <div
              key={type}
              style={{
                background: "#161b22",
                border: `1px solid ${active ? "#21262d" : "#21262d"}`,
                borderLeft: `3px solid ${active ? "#3fb950" : "#30363d"}`,
                borderRadius: "6px",
                padding: "0.85rem 1rem",
                display: "flex",
                alignItems: "flex-start",
                gap: "0.85rem",
                opacity: disabled && !meta.required ? 0.7 : 1,
              }}
            >
              {/* Status indicator */}
              <div style={{ fontSize: "1.25rem", lineHeight: 1, marginTop: "0.1rem", flexShrink: 0 }}>
                {active ? "✅" : "⬜"}
              </div>

              {/* Content */}
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.2rem" }}>
                  <span style={{ fontSize: "0.95rem" }}>{meta.icon}</span>
                  <span style={{ color: "#e6edf3", fontWeight: 600, fontSize: "0.9rem" }}>{meta.label}</span>
                  {meta.required && (
                    <span style={{ background: "#1b4332", color: "#3fb950", border: "1px solid #3fb95055", borderRadius: "4px", padding: "0.05rem 0.4rem", fontSize: "0.68rem", fontWeight: 600 }}>
                      Erforderlich
                    </span>
                  )}
                  {!active && !meta.required && (
                    <span style={{ color: "#484f58", fontSize: "0.72rem" }}>Nicht aktiv</span>
                  )}
                </div>
                <p style={{ color: "#8b949e", fontSize: "0.8rem", margin: "0 0 0.2rem", lineHeight: 1.4 }}>
                  {meta.description}
                </p>
                <p style={{ color: "#484f58", fontSize: "0.73rem", margin: 0, fontStyle: "italic" }}>
                  {meta.note}
                </p>
              </div>

              {/* Toggle */}
              <div style={{ flexShrink: 0 }}>
                {meta.required ? (
                  <span style={{ color: "#3fb950", fontSize: "0.78rem", fontWeight: 600 }}>Immer aktiv</span>
                ) : active ? (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => props.onRevoke(type)}
                    style={{
                      background: "#21262d", border: "1px solid #f8514955", borderRadius: "5px",
                      color: "#f85149", cursor: disabled ? "default" : "pointer",
                      fontSize: "0.78rem", padding: "0.3rem 0.7rem", fontWeight: 600,
                    }}
                  >
                    {loading ? "..." : "Deaktivieren"}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => props.onGrant(type)}
                    style={{
                      background: "#1f6feb22", border: "1px solid #1f6feb", borderRadius: "5px",
                      color: "#58a6ff", cursor: disabled ? "default" : "pointer",
                      fontSize: "0.78rem", padding: "0.3rem 0.7rem", fontWeight: 600,
                    }}
                  >
                    {loading ? "..." : "Aktivieren"}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Recent revocations */}
      {history.length > 0 && (
        <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", background: "#0d1117", border: "1px solid #21262d", borderRadius: "6px" }}>
          <p style={{ color: "#8b949e", fontSize: "0.73rem", textTransform: "uppercase", letterSpacing: "0.5px", margin: "0 0 0.5rem", fontWeight: 600 }}>
            Letzte Änderungen
          </p>
          {history.map(record => (
            <div key={record.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.78rem", color: "#8b949e", marginBottom: "0.2rem" }}>
              <span style={{ color: record.status === "granted" ? "#3fb950" : "#f85149" }}>
                {record.status === "granted" ? "✓ Aktiviert" : "✗ Deaktiviert"}
              </span>
              <span>{CONSENT_META[record.type as ConsentType]?.label ?? record.title}</span>
              <span style={{ color: "#484f58" }}>
                {new Date(record.revokedAt ?? record.createdAt ?? "").toLocaleDateString("de-DE")}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AuthBar(props: {
  authError: string | null;
  authLoading: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  session: AuthSession | null;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <section className="auth-bar">
      <div>
        <span>{props.t("steemConnect")}</span>
        <strong>
          {props.session ? `@${props.session.user.username} ${props.t("connected")}` : props.t("nonCustodialLogin")}
        </strong>
      </div>
      {props.authError && (
        <div className="auth-error">
          <AlertTriangle size={15} />
          {props.authError}
        </div>
      )}
      {props.session ? (
        <button className="secondary-button" type="button" onClick={props.onDisconnect}>
          {props.t("signout")}
        </button>
      ) : (
        <button className="secondary-button" disabled={props.authLoading} type="button" onClick={props.onConnect}>
          <ShieldCheck size={16} />
          {props.authLoading ? props.t("connecting") : props.t("connect")}
        </button>
      )}
    </section>
  );
}

// ── Vote-DNA constants & strategy types ──────────────────────────────────

const dnaEmoji: Record<string, string> = {
  "Self-Focused Voter":      "🔴",
  "Loyal Inner Circle":      "🟣",
  "Loyal Community Curator": "🟦",
  "Broad Explorer":          "🟢",
  "Strategic Weight Voter":  "🟡",
  "High-Frequency Curator":  "🟠",
  "Niche Specialist":        "🟤",
  "Regular Curator":         "⚪",
};

type StrategyCategory = "immer_voten" | "lieblingsautor" | "bevorzugt" | "normal" | "niedrig" | "ignorieren";

const categoryLabel: Record<StrategyCategory, string> = {
  immer_voten:    "🔥 Immer voten",
  lieblingsautor: "⭐ Lieblingsautor",
  bevorzugt:      "🟦 Bevorzugt",
  normal:         "⚪ Normal",
  niedrig:        "⬇ Niedrige Priorität",
  ignorieren:     "🚫 Ignorieren",
};

const categoryColor: Record<StrategyCategory, string> = {
  immer_voten:    "#ff6b35",
  lieblingsautor: "#f0a500",
  bevorzugt:      "#58a6ff",
  normal:         "#3fb950",
  niedrig:        "#8b949e",
  ignorieren:     "#f85149",
};

const PRIORITY_MULTIPLIER: Record<StrategyCategory, number> = {
  immer_voten:    4.0,
  lieblingsautor: 2.5,
  bevorzugt:      1.5,
  normal:         1.0,
  niedrig:        0.4,
  ignorieren:     0,
};

interface StrategyRule {
  username: string;
  category: StrategyCategory;
  maxWeightPct: number;
  minWeightPct: number;
  enabled: boolean;
  source: string;
  sharePct: number;
  voteCount: number;
  avgWeightPct: number;
  lastVoteDaysAgo: number;
  selectionReasons: string[];
  manuallyModified: boolean;
}

// ── Category-based meaningful vote weights ──────────────────────────────────
// Quality over quantity: fewer, stronger votes instead of many dust votes.
// The daily budget (2000 BPS = 20%/day) limits how often these can be used.

const CATEGORY_TARGET_BPS: Record<StrategyCategory, number> = {
  immer_voten:    10_000,  // 100% — always maximum
  lieblingsautor:  7_500,  // 75%
  bevorzugt:       3_000,  // 30%
  normal:          1_500,  // 15%
  niedrig:         1_000,  // 10%
  ignorieren:          0,
};

// Below these minimums: skip entirely (no dust votes)
const CATEGORY_MIN_BPS: Record<StrategyCategory, number> = {
  immer_voten:    5_000,  // 50%
  lieblingsautor: 3_000,  // 30%
  bevorzugt:      1_500,  // 15%
  normal:         1_000,  // 10%
  niedrig:          500,  //  5%
  ignorieren:         0,
};

// Minimum dust threshold — votes below this are worthless and skipped
const DUST_THRESHOLD_BPS = 1_000; // 10%

function computeDynamicWeights(
  authors: Array<{ username: string; category: StrategyCategory }>,
  _dailyBudgetBps: number  // kept for API compat, not used in new model
): Map<string, number> {
  // Use category-based fixed targets — no proportional dilution across all authors
  return new Map(
    authors
      .filter(a => a.category !== "ignorieren")
      .map(a => [a.username, CATEGORY_TARGET_BPS[a.category] ?? DUST_THRESHOLD_BPS])
  );
}

function generateStrategyFromProfile(profile: CurationProfile): StrategyRule[] {
  const self = profile.username.toLowerCase();

  const categorized: Array<typeof profile.topAuthors[0] & { category: StrategyCategory }> =
    profile.topAuthors.map((author, idx) => {
      const isSelf = author.username.toLowerCase() === self;
      let category: StrategyCategory;
      if (isSelf)        category = "ignorieren";
      else if (idx < 2)  category = "lieblingsautor";
      else if (idx < 10) category = "bevorzugt";
      else if (idx < 25) category = "normal";
      else               category = "niedrig";
      return { ...author, category };
    });

  return categorized.map(author => {
    const targetBps  = CATEGORY_TARGET_BPS[author.category] ?? 0;
    const minBps     = CATEGORY_MIN_BPS[author.category]    ?? 0;
    const maxWeightPct = Math.round(targetBps / 100 * 10) / 10;
    const minWeightPct = Math.round(minBps    / 100 * 10) / 10;

    return {
      username:         author.username,
      category:         author.category,
      maxWeightPct,
      minWeightPct,
      enabled:          author.category !== "ignorieren",
      source:           "Vote-DNA",
      sharePct:         author.sharePct,
      voteCount:        author.voteCount,
      avgWeightPct:     author.avgWeightPct,
      lastVoteDaysAgo:  author.lastVoteDaysAgo,
      selectionReasons: author.selectionReasons,
      manuallyModified: false,
    };
  });
}

// ── CurationDnaPanel ─────────────────────────────────────────────────────

function CurationDnaPanel(props: {
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
}) {
  const [addUsername, setAddUsername] = useState("");
  const [addCategory, setAddCategory] = useState<StrategyCategory>("bevorzugt");

  const sectionLabel = {
    color: "#8b949e", fontSize: "0.75rem", textTransform: "uppercase" as const,
    letterSpacing: "0.5px", margin: "0 0 0.5rem", fontWeight: 600,
  };
  const chipBtn = {
    background: "#161b22", border: "1px solid #30363d", borderRadius: "5px",
    color: "#c9d1d9", cursor: "pointer" as const, fontSize: "0.78rem", padding: "0.3rem 0.65rem",
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
      <section className="auth-bar">
        <div>
          <span>Vote-DNA</span>
          <strong style={{ color: "#f85149" }}>Fehler beim Laden der Vote-Historie</strong>
          <p style={{ color: "#8b949e", fontSize: "0.82rem", margin: "0.25rem 0 0" }}>{props.error}</p>
        </div>
      </section>
    );
  }

  if (!props.profile || props.profile.votesAnalyzed === 0) {
    return (
      <section className="auth-bar">
        <div>
          <span>Vote-DNA</span>
          <strong>Keine Vote-Historie gefunden</strong>
          <p style={{ color: "#8b949e", fontSize: "0.82rem", margin: "0.25rem 0 0" }}>
            Für eine Vote-DNA-Analyse werden mindestens einige Votes benötigt.
          </p>
        </div>
      </section>
    );
  }

  const p = props.profile;
  const topAuthors = p.topAuthors ?? [];
  const peakHours = p.peakHoursUtc ?? [];
  const maxBar = topAuthors.length > 0 ? Math.max(...topAuthors.map(a => a.voteCount)) : 1;
  const maxHour = peakHours.length > 0 ? Math.max(...peakHours.map(h => h.voteCount)) : 1;
  const emoji = dnaEmoji[p.dnaLabel] ?? "⚪";

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

  const strategyRules = props.strategyRules;

  const noStrategyYet = !strategyRules;

  return (
    <section style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: "8px", padding: "1.25rem 1.5rem" }}>

      {/* ── Onboarding-Flow für neue Nutzer ─────────────────── */}
      {noStrategyYet && (
        <div style={{
          background: "linear-gradient(135deg, #1a2332, #161b22)",
          border: "1px solid #1f6feb55",
          borderRadius: "10px",
          padding: "1rem 1.25rem",
          marginBottom: "1.25rem",
          display: "flex",
          flexDirection: "column" as const,
          gap: "0.6rem",
        }}>
          <p style={{ color: "#58a6ff", fontSize: "0.72rem", textTransform: "uppercase" as const, letterSpacing: "0.5px", fontWeight: 700, margin: 0 }}>
            Dein Einstieg
          </p>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" as const }}>
            {[
              { n: "1", label: "Vote-Historie analysiert", done: true },
              { n: "2", label: "Autoren-Strategie generieren", done: false, active: true },
              { n: "3", label: "Posts finden & voten", done: false },
            ].map(step => (
              <div key={step.n} style={{
                display: "flex", alignItems: "center", gap: "0.4rem",
                padding: "0.35rem 0.65rem",
                borderRadius: "6px",
                background: step.active ? "#1f6feb22" : step.done ? "#3fb95015" : "transparent",
                border: `1px solid ${step.active ? "#1f6feb" : step.done ? "#3fb95044" : "#30363d"}`,
              }}>
                <span style={{
                  width: "18px", height: "18px", borderRadius: "50%", fontSize: "0.68rem", fontWeight: 700,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: step.done ? "#3fb950" : step.active ? "#1f6feb" : "#21262d",
                  color: step.done || step.active ? "#0d1117" : "#8b949e",
                  flexShrink: 0,
                }}>
                  {step.done ? "✓" : step.n}
                </span>
                <span style={{ fontSize: "0.78rem", color: step.active ? "#e6edf3" : step.done ? "#3fb950" : "#8b949e", fontWeight: step.active ? 600 : 400 }}>
                  {step.label}
                </span>
              </div>
            ))}
          </div>
          <p style={{ color: "#8b949e", fontSize: "0.78rem", margin: 0, lineHeight: 1.5 }}>
            VoteBroker hat deine letzten Votes analysiert und deine Lieblingsautoren erkannt.
            Generiere jetzt deine Curation-Strategie — du kannst danach alles anpassen.
          </p>
        </div>
      )}

      {/* ── DNA Profil-Header ──── */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: "0.75rem", marginBottom: "1.25rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span style={{ fontSize: "1.75rem", lineHeight: 1 }}>{emoji}</span>
          <div>
            <span style={{ fontSize: "0.75rem", color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.5px" }}>Vote-DNA Profil</span>
            <div style={{ color: "#58a6ff", fontSize: "1.05rem", fontWeight: 700, marginTop: "0.1rem" }}>{p.dnaLabel}</div>
            <p style={{ color: "#8b949e", fontSize: "0.82rem", margin: "0.25rem 0 0", maxWidth: "480px" }}>{p.dnaDescription}</p>
          </div>
        </div>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", fontSize: "0.82rem", color: "#8b949e" }}>
          <span><b style={{ color: "#e6edf3" }}>{p.votesAnalyzed}</b> Votes</span>
          <span><b style={{ color: "#e6edf3" }}>{p.periodDays}</b> Tage</span>
          <span><b style={{ color: "#e6edf3" }}>{p.votesPerDay}</b>/Tag</span>
          <span><b style={{ color: "#e6edf3" }}>{p.uniqueAuthors}</b> Autoren</span>
          <span><b style={{ color: "#e6edf3" }}>{p.selfVotePct}%</b> Self</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>

        {/* Top Autoren */}
        <div>
          <p style={sectionLabel}>Top Autoren (nach Composite-Score)</p>
          {topAuthors.slice(0, 10).map(a => (
            <div key={a.username} style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.3rem" }}>
              <span style={{ color: "#8b949e", fontSize: "0.78rem", minWidth: "130px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>@{a.username}</span>
              <div style={{ flex: 1, height: "6px", background: "#21262d", borderRadius: "3px" }}>
                <div style={{ width: `${a.voteCount / maxBar * 100}%`, height: "100%", background: "#1f6feb", borderRadius: "3px" }} />
              </div>
              <span style={{ color: "#8b949e", fontSize: "0.73rem", minWidth: "70px", textAlign: "right", whiteSpace: "nowrap" }}>
                {a.sharePct}% · ⌀{a.avgWeightPct}%
              </span>
            </div>
          ))}
        </div>

        {/* Power-Stable + Aktivität */}
        <div>
          <div style={{ padding: "0.75rem", background: "#161b22", borderRadius: "6px", border: "1px solid #30363d", marginBottom: "1rem" }}>
            <p style={{ ...sectionLabel, margin: "0 0 0.5rem" }}>Nachhaltige VP-Nutzung</p>
            <p style={{ color: "#e6edf3", fontSize: "0.87rem", fontWeight: 600, margin: "0 0 0.25rem" }}>
              {p.powerStable.relevantAuthors} Autoren erkannt, die du regelmäßig supportest
            </p>
            <p style={{ color: "#8b949e", fontSize: "0.79rem", margin: "0 0 0.6rem", lineHeight: 1.5 }}>
              Voting Power regeneriert sich täglich um ca. 20%. Wer jeden Tag zu schwer votet,
              startet den nächsten Tag mit einer schwächeren VP — und kann weniger Autoren
              sinnvoll unterstützen. Das Ziel: VP nie unter ~80% fallen lassen.
            </p>
            <p style={{ color: "#c9d1d9", fontSize: "0.79rem", fontWeight: 600, margin: "0 0 0.3rem" }}>Empfohlene Strategie für dich</p>
            <ul style={{ color: "#8b949e", fontSize: "0.79rem", margin: "0 0 0.5rem", paddingLeft: "1.1rem" }}>
              <li>Durchschnittlich <b style={{ color: "#e6edf3" }}>{p.powerStable.maxAvgWeightPct}%</b> pro Vote — merkbarer Support, ohne VP zu zerstören</li>
              <li>VP-Zielbereich <b style={{ color: "#e6edf3" }}>80–95%</b> — so bleibst du täglich handlungsfähig</li>
              <li>Vollständige tägliche Regeneration möglich</li>
            </ul>
          </div>
          <p style={sectionLabel}>Aktivität UTC</p>
          {peakHours.map(h => (
            <div key={h.hour} style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.3rem" }}>
              <span style={{ color: "#8b949e", fontSize: "0.78rem", minWidth: "40px" }}>{String(h.hour).padStart(2, "0")}:00</span>
              <div style={{ flex: 1, height: "6px", background: "#21262d", borderRadius: "3px" }}>
                <div style={{ width: `${h.voteCount / maxHour * 100}%`, height: "100%", background: "#3fb950", borderRadius: "3px" }} />
              </div>
              <span style={{ color: "#8b949e", fontSize: "0.75rem", minWidth: "32px", textAlign: "right" }}>{h.voteCount}×</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Strategie ──────────────────────────────────────── */}
      <div style={{ marginTop: "1.25rem", borderTop: "1px solid #21262d", paddingTop: "1rem" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.75rem" }}>
          <p style={{ ...sectionLabel, margin: 0 }}>
            Curation-Strategie
            {strategyRules && (
              <span style={{ color: "#484f58", fontWeight: 400, textTransform: "none", marginLeft: "0.5rem" }}>
                {strategyRules.filter(r => r.enabled).length} aktiv · {strategyRules.filter(r => r.manuallyModified).length} manuell
              </span>
            )}
          </p>
          <div style={{ display: "flex", gap: "0.4rem" }}>
            {strategyRules && (
              <>
                <button style={chipBtn} type="button" onClick={regenerate}>
                  Regenerieren
                </button>
                <button
                  style={{ ...chipBtn, background: "#1f6feb22", borderColor: "#1f6feb", color: "#58a6ff", fontWeight: 600 }}
                  type="button"
                  onClick={generateStrategy}
                >
                  Aus DNA neu generieren
                </button>
              </>
            )}
          </div>
        </div>

        {/* Manuell hinzufügen */}
        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          <input
            placeholder="@username"
            value={addUsername}
            onChange={e => setAddUsername(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addManually()}
            style={{ background: "#21262d", border: "1px solid #30363d", borderRadius: "5px", color: "#e6edf3", padding: "0.3rem 0.6rem", fontSize: "0.82rem", width: "160px" }}
          />
          <select
            value={addCategory}
            onChange={e => setAddCategory(e.target.value as StrategyCategory)}
            style={{ background: "#21262d", border: "1px solid #30363d", borderRadius: "5px", color: "#e6edf3", padding: "0.3rem 0.5rem", fontSize: "0.82rem", cursor: "pointer" }}
          >
            {(Object.keys(categoryLabel) as StrategyCategory[]).filter(k => k !== "ignorieren").map(k => (
              <option key={k} value={k}>{categoryLabel[k]}</option>
            ))}
          </select>
          <button
            onClick={addManually}
            type="button"
            style={{ background: "#21262d", border: "1px solid #30363d", borderRadius: "5px", color: "#c9d1d9", cursor: "pointer", fontSize: "0.78rem", padding: "0.3rem 0.65rem" }}
          >
            + Hinzufügen
          </button>
        </div>

        {!strategyRules ? (
          <div style={{
            border: "1px dashed #1f6feb88",
            borderRadius: "8px",
            padding: "1.1rem 1.25rem",
            background: "#1f6feb08",
          }}>
            <p style={{ color: "#e6edf3", fontSize: "0.88rem", fontWeight: 600, margin: "0 0 0.4rem" }}>
              Schritt 2: Autoren-Strategie generieren
            </p>
            <p style={{ color: "#8b949e", fontSize: "0.8rem", margin: "0 0 0.85rem", lineHeight: 1.55 }}>
              VoteBroker ordnet deine Lieblingsautoren automatisch in Kategorien ein
              (Lieblingsautor, Bevorzugt, Normal) und berechnet nachhaltige Vote-Gewichte.
              Du kannst danach alles frei anpassen oder Autoren manuell hinzufügen.
            </p>
            <button
              style={{
                background: "#1f6feb", border: "none", borderRadius: "6px",
                color: "#fff", cursor: "pointer", fontSize: "0.85rem",
                fontWeight: 700, padding: "0.55rem 1.1rem",
              }}
              type="button"
              onClick={generateStrategy}
            >
              Strategie aus Vote-DNA generieren →
            </button>
          </div>
        ) : (
          <StrategyEditor
            rules={strategyRules}
            votesPerDay={p.votesPerDay}
            onUpdate={updateRule}
            onRemove={removeRule}
          />
        )}
      </div>

      {/* ── Vote Plan generieren ──────────────────────────── */}
      {strategyRules && props.accountSnapshot && (
        <div style={{ marginTop: "1.25rem", borderTop: "1px solid #21262d", paddingTop: "1rem" }}>
          <VotePlanSection
            plan={props.votePlan}
            loading={props.planLoading}
            error={props.planError}
            session={props.session!}
            onGenerate={props.onGenerateVotes}
            onExecuteSingle={props.onExecuteSingle}
          />
        </div>
      )}

      {/* ── Offene Votes ──────────────────────────────────── */}
      {strategyRules && (
        <div style={{ marginTop: "1.25rem", borderTop: "1px solid #21262d", paddingTop: "1rem" }}>
          <OpenVoteOpportunities
            opportunities={props.opportunities}
            meta={props.opportunitiesMeta}
            loading={props.opportunitiesLoading}
            error={props.opportunitiesError}
            strategyRules={strategyRules}
            accountSnapshot={props.accountSnapshot}
            onRefresh={props.onLoadOpportunities}
            onExecuteVotes={props.onExecuteVotes}
          />
        </div>
      )}

    </section>
  );
}

function StrategyEditor(props: {
  rules: StrategyRule[];
  votesPerDay: number;
  onUpdate: (username: string, patch: Partial<StrategyRule>) => void;
  onRemove: (username: string) => void;
}) {
  return (
    <div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
          <thead>
            <tr style={{ color: "#8b949e", fontSize: "0.71rem", textTransform: "uppercase", letterSpacing: "0.4px" }}>
              <th style={{ textAlign: "left", padding: "0.3rem 0.4rem", fontWeight: 600, width: "24px" }} />
              <th style={{ textAlign: "left", padding: "0.3rem 0.4rem", fontWeight: 600, width: "20px" }}>An</th>
              <th style={{ textAlign: "left", padding: "0.3rem 0.4rem", fontWeight: 600 }}>Autor</th>
              <th style={{ textAlign: "left", padding: "0.3rem 0.4rem", fontWeight: 600 }}>Kategorie</th>
              <th style={{ textAlign: "center", padding: "0.3rem 0.4rem", fontWeight: 600 }}>Max %</th>
              <th style={{ textAlign: "center", padding: "0.3rem 0.4rem", fontWeight: 600 }}>Min %</th>
              <th style={{ textAlign: "left", padding: "0.3rem 0.4rem", fontWeight: 600 }}>Quelle</th>
              <th style={{ width: "20px" }} />
            </tr>
          </thead>
          <tbody>
            {props.rules.map(rule => (
              <StrategyRuleRow key={rule.username} rule={rule} onUpdate={props.onUpdate} onRemove={props.onRemove} />
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
  onUpdate: (username: string, patch: Partial<StrategyRule>) => void;
  onRemove: (username: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { rule, onUpdate } = props;
  const color = categoryColor[rule.category];
  const inputStyle = {
    background: "#21262d", border: "1px solid #30363d", borderRadius: "4px",
    color: "#e6edf3", padding: "0.2rem 0.3rem", fontSize: "0.79rem", width: "52px",
  };
  const selectStyle = {
    background: "#21262d", border: "1px solid #30363d", borderRadius: "4px",
    color: "#e6edf3", padding: "0.2rem 0.3rem", fontSize: "0.79rem", cursor: "pointer" as const,
  };

  const lastVoteLabel = rule.lastVoteDaysAgo === 0
    ? "heute"
    : rule.lastVoteDaysAgo === 1 ? "gestern"
    : `vor ${rule.lastVoteDaysAgo}d`;

  return (
    <>
      <tr style={{
        borderLeft: `3px solid ${rule.enabled ? color : "#30363d"}`,
        opacity: rule.enabled ? 1 : 0.4,
        background: rule.manuallyModified ? "#1c2128" : "transparent",
      }}>
        <td style={{ padding: "0.3rem 0.4rem" }}>
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            style={{ background: "none", border: "none", color: "#8b949e", cursor: "pointer", fontSize: "0.75rem", padding: "0 2px", lineHeight: 1 }}
          >
            {expanded ? "▾" : "▸"}
          </button>
        </td>
        <td style={{ padding: "0.3rem 0.4rem" }}>
          <input
            type="checkbox" checked={rule.enabled}
            onChange={e => onUpdate(rule.username, { enabled: e.target.checked })}
            style={{ cursor: "pointer", accentColor: color }}
          />
        </td>
        <td style={{ padding: "0.3rem 0.4rem" }}>
          <span style={{ color: "#58a6ff", fontWeight: 500 }}>@{rule.username}</span>
        </td>
        <td style={{ padding: "0.3rem 0.4rem" }}>
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
        <td style={{ padding: "0.3rem 0.4rem", textAlign: "center" }}>
          <input type="number" min="0" max="100" step="0.5"
            value={rule.maxWeightPct}
            onChange={e => onUpdate(rule.username, { maxWeightPct: Math.min(100, Math.max(0, Number(e.target.value))) })}
            style={inputStyle}
          />
        </td>
        <td style={{ padding: "0.3rem 0.4rem", textAlign: "center" }}>
          <input type="number" min="0" max="100" step="0.5"
            value={rule.minWeightPct}
            onChange={e => onUpdate(rule.username, { minWeightPct: Math.min(100, Math.max(0, Number(e.target.value))) })}
            style={inputStyle}
          />
        </td>
        <td style={{ padding: "0.3rem 0.4rem" }}>
          <span style={{ fontSize: "0.69rem", color: rule.manuallyModified ? "#f0a500" : "#484f58", whiteSpace: "nowrap" }}>
            {rule.manuallyModified ? "✎ manuell" : rule.source}
          </span>
        </td>
        <td style={{ padding: "0.3rem 0.4rem" }}>
          <button
            type="button"
            onClick={() => props.onRemove(rule.username)}
            style={{ background: "none", border: "none", color: "#484f58", cursor: "pointer", fontSize: "0.8rem", padding: "0 2px" }}
            title="Entfernen"
          >
            ✕
          </button>
        </td>
      </tr>
      {expanded && (
        <tr style={{ background: "#13181f" }}>
          <td colSpan={8} style={{ padding: "0.5rem 0.75rem 0.6rem 2rem", borderLeft: `3px solid ${color}` }}>
            <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", marginBottom: "0.4rem", fontSize: "0.78rem", color: "#8b949e" }}>
              {rule.voteCount > 0 && (
                <>
                  <span><b style={{ color: "#c9d1d9" }}>{rule.voteCount}</b> Votes</span>
                  <span><b style={{ color: "#c9d1d9" }}>{rule.sharePct}%</b> Anteil</span>
                  <span>⌀ <b style={{ color: "#c9d1d9" }}>{rule.avgWeightPct}%</b> Gewicht</span>
                  <span>Letzter Vote: <b style={{ color: "#c9d1d9" }}>{lastVoteLabel}</b></span>
                </>
              )}
              {rule.voteCount === 0 && <span style={{ fontStyle: "italic" }}>Kein Vote-DNA-Datensatz — manuell hinzugefügt</span>}
            </div>
            {rule.selectionReasons.length > 0 && (
              <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap" }}>
                {rule.selectionReasons.map(r => (
                  <span key={r} style={{
                    background: "#1f6feb22", color: "#58a6ff", border: "1px solid #1f6feb40",
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
    { label: "⭐ Liebling",    color: "#f0a500", rules: byCategory("lieblingsautor") },
    { label: "🟦 Bevorzugt",  color: "#58a6ff", rules: byCategory("bevorzugt")      },
    { label: "⚪ Normal",      color: "#3fb950", rules: byCategory("normal")         },
    { label: "⬇ Niedrig",    color: "#8b949e", rules: byCategory("niedrig")         },
  ].filter(g => g.rules.length > 0);

  const equilibriumVp = netBps >= 0 ? 100 : Math.max(0, Math.round(100 - (dailySpendBps - regenBps) / 20));
  const status: "sustainable" | "aggressive" | "critical" =
    netBps >= 200 ? "sustainable" : netBps >= -300 ? "aggressive" : "critical";
  const statusConfig = {
    sustainable: { icon: "✓", text: "Nachhaltig", color: "#3fb950" },
    aggressive:  { icon: "⚠", text: "Aggressiv — VP kann sinken", color: "#f0a500" },
    critical:    { icon: "🔴", text: "Kritisch — VP entleert sich", color: "#f85149" },
  }[status];

  return (
    <div style={{ margin: "0.75rem 0", padding: "0.75rem 1rem", background: "#161b22", borderRadius: "6px", border: "1px solid #30363d" }}>
      <p style={{ color: "#8b949e", fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.5px", margin: "0 0 0.6rem", fontWeight: 600 }}>
        Strategie-Simulation
      </p>

      {/* Dust warning */}
      {belowDust > 0 && (
        <div style={{ background: "#2d2a0e", border: "1px solid #f0a50055", borderRadius: "4px", padding: "0.3rem 0.6rem", marginBottom: "0.5rem", fontSize: "0.77rem", color: "#f0a500" }}>
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
                <span style={{ color: "#8b949e" }}>{g.rules.length} Autor{g.rules.length > 1 ? "en" : ""}</span>
                <span style={{ color: "#e6edf3" }}>Ø {avgPct}% pro Vote</span>
              </div>
            );
          })}
        </div>
      )}

      {/* VP stats */}
      <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", fontSize: "0.79rem", color: "#8b949e", marginBottom: "0.4rem" }}>
        <span>Sinnvolle Autoren: <b style={{ color: "#e6edf3" }}>{aboveDust.length}</b></span>
        <span>Ø Gewicht: <b style={{ color: "#e6edf3" }}>{Math.round(avgWeightBps / 100 * 10) / 10}%</b></span>
        <span>VP/Tag (est.): <b style={{ color: "#e6edf3" }}>{Math.round(dailySpendBps / 100 * 10) / 10}%</b></span>
        <span>Bilanz/Tag: <b style={{ color: netBps >= 0 ? "#3fb950" : "#f85149" }}>{netBps >= 0 ? "+" : ""}{Math.round(netBps / 100 * 10) / 10}%</b></span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
        <span style={{ color: statusConfig.color, fontSize: "0.82rem", fontWeight: 600 }}>
          {statusConfig.icon} {statusConfig.text}
        </span>
        <span style={{ color: "#8b949e", fontSize: "0.77rem" }}>
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
    <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", background: "#161b22", borderRadius: "6px", border: "1px solid #30363d" }}>
      <p style={{ color: "#8b949e", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.5px", margin: "0 0 0.6rem", fontWeight: 600 }}>
        Geplante Auto-Vote-Autoren · {active.length} aktiv
      </p>
      {active.length === 0 ? (
        <p style={{ color: "#484f58", fontSize: "0.82rem", margin: 0 }}>Keine aktiven Autoren in der Strategie.</p>
      ) : (
        (["lieblingsautor", "bevorzugt", "normal", "niedrig"] as StrategyCategory[]).map(cat => {
          const authors = byCategory(cat);
          if (authors.length === 0) return null;
          return (
            <div key={cat} style={{ marginBottom: "0.4rem", display: "flex", alignItems: "flex-start", gap: "0.5rem", flexWrap: "wrap" }}>
              <span style={{ color: categoryColor[cat], fontSize: "0.75rem", fontWeight: 600, minWidth: "120px" }}>
                {categoryLabel[cat]}
              </span>
              <span style={{ color: "#8b949e", fontSize: "0.8rem" }}>
                {authors.map(r => `@${r.username} (max ${r.maxWeightPct}%)`).join(" · ")}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Open Vote Opportunities ───────────────────────────────────────────────

interface VoteTarget {
  author: string;
  permlink: string;
  title: string;
  ageMinutes: number;
  weightBps: number;
  category: StrategyCategory;
}

function formatAge(minutes: number): string {
  if (minutes < 60)   return `vor ${minutes} Min.`;
  if (minutes < 1440) return `vor ${Math.round(minutes / 60)} Std.`;
  return `vor ${Math.round(minutes / 1440)} Tag(en)`;
}

// ── VotePlanSection — Plan → Preview → Confirm → Execute (sequential) ─────────

function ConstraintBadge(props: { report: ConstraintReport }) {
  const r = props.report;
  const stopColor = r.stoppedBy === "none" ? "#3fb950" : r.stoppedBy === "min_vp" ? "#f85149" : "#f0a500";
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", fontSize: "0.73rem", marginBottom: "0.6rem" }}>
      <span style={{ background: "#21262d", border: "1px solid #30363d", borderRadius: "4px", color: "#8b949e", padding: "0.15rem 0.5rem" }}>
        VP-Floor: <b style={{ color: "#e6edf3" }}>{r.minVpPct}%</b>
      </span>
      <span style={{ background: "#21262d", border: "1px solid #30363d", borderRadius: "4px", color: "#8b949e", padding: "0.15rem 0.5rem" }}>
        Max Votes: <b style={{ color: "#e6edf3" }}>{r.maxVotesPerRun}</b>
      </span>
      <span style={{ background: "#21262d", border: "1px solid #30363d", borderRadius: "4px", color: "#8b949e", padding: "0.15rem 0.5rem" }}>
        Max VP-Verbrauch: <b style={{ color: "#e6edf3" }}>{r.maxVpSpendPct}%</b>
      </span>
      <span style={{ background: "#21262d", border: "1px solid #30363d", borderRadius: "4px", color: "#8b949e", padding: "0.15rem 0.5rem" }}>
        Budget: <b style={{ color: "#e6edf3" }}>{r.effectiveBudgetPct}%</b>
      </span>
      {r.excludedVotes > 0 && (
        <span style={{ background: stopColor + "22", border: `1px solid ${stopColor}55`, borderRadius: "4px", color: stopColor, padding: "0.15rem 0.5rem", fontWeight: 600 }}>
          ⚠ {r.excludedVotes} übersprungen — {r.stoppedByLabel}
        </span>
      )}
      {r.stoppedBy === "none" && r.includedVotes > 0 && (
        <span style={{ background: "#1b4332", border: "1px solid #3fb95055", borderRadius: "4px", color: "#3fb950", padding: "0.15rem 0.5rem", fontWeight: 600 }}>
          ✓ {r.stoppedByLabel}
        </span>
      )}
    </div>
  );
}

const PLAN_CATEGORY_COLOR: Record<string, string> = {
  immer_voten: "#ff6b35", lieblingsautor: "#f0a500",
  bevorzugt:   "#58a6ff", normal:         "#3fb950", niedrig: "#8b949e",
};
const PLAN_CATEGORY_ICON: Record<string, string> = {
  immer_voten: "🔥", lieblingsautor: "⭐", bevorzugt: "🟦", normal: "⚪", niedrig: "⬇",
};

type PlanPhase = "idle" | "generated" | "confirming" | "executing" | "done";

interface VoteLogEntry {
  author: string; permlink: string; title: string;
  status: "sent" | "skipped" | "failed"; message: string;
}

function VotePlanSection(props: {
  plan: VotePlanResponse | null;
  loading: boolean;
  error: string | null;
  session: AuthSession;
  onGenerate: () => void;
  onExecuteSingle: (target: { author: string; permlink: string; weightBps: number }) => Promise<{ transactionId: string }>;
}) {
  const [phase, setPhase]           = useState<PlanPhase>("idle");
  const [confirmed, setConfirmed]   = useState(false);
  const [execLog, setExecLog]       = useState<VoteLogEntry[]>([]);
  const [execIndex, setExecIndex]   = useState(0);
  const [aborted, setAborted]       = useState(false);

  const chipBtn = {
    background: "#161b22", border: "1px solid #30363d", borderRadius: "5px",
    color: "#c9d1d9", cursor: "pointer" as const, fontSize: "0.78rem", padding: "0.3rem 0.65rem",
  };
  const sectionLabel = {
    color: "#8b949e", fontSize: "0.75rem", textTransform: "uppercase" as const,
    letterSpacing: "0.5px", margin: 0, fontWeight: 600,
  };

  const plan = props.plan;
  const entries = plan?.plan ?? [];
  const sustainColor = { sustainable: "#3fb950", aggressive: "#f0a500", critical: "#f85149" }[plan?.summary.sustainability ?? "sustainable"];

  // Transition to "generated" whenever a new plan arrives (reset confirms)
  useEffect(() => {
    if (plan !== null) {
      setPhase("generated");
      setConfirmed(false); setExecLog([]); setExecIndex(0); setAborted(false);
    }
  }, [plan]);

  function reset() {
    setPhase(plan ? "generated" : "idle");
    setConfirmed(false); setExecLog([]); setExecIndex(0); setAborted(false);
  }

  async function startExecution() {
    if (!confirmed || entries.length === 0) return;
    setPhase("executing");
    setExecLog([]);
    setAborted(false);
    const log: VoteLogEntry[] = [];

    for (let i = 0; i < entries.length; i++) {
      if (aborted) break;
      setExecIndex(i);
      const e = entries[i];
      try {
        // Direct call — throws VoteBroadcastError on any failure
        const result = await props.onExecuteSingle({
          author:    e.author,
          permlink:  e.permlink,
          weightBps: e.suggestedWeightBps,
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
        const isAlreadyVoted = msg.includes("already_voted") || msg.includes("already") || msg.includes("duplicate");
        const isPostMissing  = msg.includes("post_not_found") || msg.includes("nicht gefunden");
        const skipWithoutStop = isAlreadyVoted || isPostMissing;

        const entry: VoteLogEntry = {
          author: e.author, permlink: e.permlink, title: e.title,
          status: isAlreadyVoted ? "skipped" : "failed",
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
  }

  return (
    <div>
      {/* ── Header ─────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.75rem" }}>
        <p style={sectionLabel}>
          🗳 Vote-Plan
          {phase !== "idle" && plan && (
            <span style={{ color: "#484f58", fontWeight: 400, textTransform: "none", marginLeft: "0.5rem" }}>
              {plan.summary.totalPosts} Posts · VP {plan.summary.currentVpPct.toFixed(1)}% → <span style={{ color: sustainColor }}>{plan.summary.estimatedVpAfterPct.toFixed(1)}%</span>
            </span>
          )}
        </p>
        <div style={{ display: "flex", gap: "0.4rem" }}>
          {(phase === "generated" || phase === "idle") && (
            <button
              style={{ ...chipBtn, background: "#1f6feb22", borderColor: "#1f6feb", color: "#58a6ff", fontWeight: 600 }}
              type="button" disabled={props.loading} onClick={() => { props.onGenerate(); setPhase("idle"); }}
            >
              {props.loading ? "Generiere..." : plan ? "Plan aktualisieren" : "Vote-Plan generieren"}
            </button>
          )}
        </div>
      </div>

      {props.error && <p style={{ color: "#f85149", fontSize: "0.82rem", margin: "0 0 0.5rem" }}>{props.error}</p>}

      {/* ── Phase: idle ────────────────────────────── */}
      {phase === "idle" && !props.loading && (
        <p style={{ color: "#484f58", fontSize: "0.82rem", margin: 0 }}>
          Klicke "Vote-Plan generieren" — VoteBroker analysiert offene Posts deiner Strategie-Autoren und erstellt einen priorisierten, nachhaltigen Plan. Kein Vote wird ohne explizite Bestätigung gesendet.
        </p>
      )}

      {/* ── Phase: generated (plan view) ───────────── */}
      {phase === "generated" && (
        <>
          {entries.length === 0 ? (
            <p style={{ color: "#3fb950", fontSize: "0.82rem" }}>✓ Alles up-to-date — keine offenen Posts von Strategie-Autoren.</p>
          ) : (
            <>
              {/* Dry-run notice */}
              <div style={{ background: "#1b3a2e", border: "1px solid #3fb95055", borderRadius: "5px", padding: "0.5rem 0.75rem", marginBottom: "0.5rem", fontSize: "0.78rem", color: "#3fb950" }}>
                🔍 Dry-Run-Ansicht — noch keine Votes gesendet. Überprüfe den Plan und bestätige im nächsten Schritt.
              </div>

              {/* Constraint report */}
              {plan?.report && <ConstraintBadge report={plan.report} />}

              {/* Plan table */}
              <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", marginBottom: "0.75rem" }}>
                {entries.map(e => {
                  const color = PLAN_CATEGORY_COLOR[e.category] ?? "#8b949e";
                  const icon  = PLAN_CATEGORY_ICON[e.category] ?? "⚪";
                  return (
                    <div key={`${e.author}/${e.permlink}`} style={{
                      background: "#161b22",
                      border: `1px solid ${e.warning ? "#f0a50055" : "#30363d"}`,
                      borderLeft: `3px solid ${color}`,
                      borderRadius: "5px", padding: "0.5rem 0.75rem",
                      display: "flex", gap: "0.75rem", alignItems: "flex-start",
                    }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", flexWrap: "wrap" }}>
                          <span>{icon}</span>
                          <span style={{ color: "#58a6ff", fontWeight: 600, fontSize: "0.85rem" }}>@{e.author}</span>
                          <span style={{ color: "#8b949e", fontSize: "0.73rem" }}>· {formatAge(e.ageMinutes)}</span>
                          {/* Remaining reward window */}
                          <span style={{ color: e.remainingHours < 24 ? "#f0a500" : "#484f58", fontSize: "0.71rem" }}>
                            · {e.remainingHours.toFixed(0)}h verbleibend
                          </span>
                          {/* Post-score badge */}
                          <span style={{
                            background: e.postScore >= 80 ? "#1b4332" : e.postScore >= 50 ? "#2d2a0e" : "#21262d",
                            color:      e.postScore >= 80 ? "#3fb950" : e.postScore >= 50 ? "#f0a500" : "#8b949e",
                            border:     `1px solid ${e.postScore >= 80 ? "#3fb95055" : "#30363d"}`,
                            borderRadius: "3px", padding: "0 0.35rem", fontSize: "0.68rem", fontWeight: 600,
                          }}>
                            Score {e.postScore}
                          </span>
                        </div>
                        <p style={{ color: "#c9d1d9", fontSize: "0.79rem", margin: "0.15rem 0 0.1rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "400px" }}>
                          {e.title}
                        </p>
                        <p style={{ color: "#8b949e", fontSize: "0.71rem", margin: "0 0 0.1rem", fontFamily: "monospace" }}>
                          @{e.author}/{e.permlink}
                        </p>
                        <p style={{ color: "#8b949e", fontSize: "0.71rem", margin: 0 }}>{e.reasons.join(" · ")}</p>
                        {e.warning && (
                          <p style={{ color: "#f0a500", fontSize: "0.72rem", margin: "0.15rem 0 0", fontWeight: 600 }}>{e.warning}</p>
                        )}
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0, minWidth: "70px" }}>
                        <b style={{ color: "#e6edf3", fontSize: "1rem" }}>{e.suggestedWeightPct}%</b>
                        {e.expectedVoteUsd > 0 && <div style={{ color: "#8b949e", fontSize: "0.72rem" }}>~${e.expectedVoteUsd.toFixed(4)}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>

              {plan?.summary.skippedCategories && plan.summary.skippedCategories.length > 0 && (
                <p style={{ color: "#f0a500", fontSize: "0.78rem", margin: "0 0 0.5rem" }}>
                  ⚠ VP niedrig ({plan.summary.currentVpPct.toFixed(1)}%) — übersprungen: {plan.summary.skippedCategories.join(", ")}
                </p>
              )}

              <button
                style={{ ...chipBtn, background: "#f0a50022", borderColor: "#f0a500", color: "#f0a500", fontWeight: 600 }}
                type="button"
                onClick={() => { setPhase("confirming"); setConfirmed(false); }}
              >
                Weiter → Bestätigung ({entries.length} Votes)
              </button>
            </>
          )}
        </>
      )}

      {/* ── Phase: confirming ──────────────────────── */}
      {phase === "confirming" && plan && (
        <div style={{ background: "#0d1117", border: "1px solid #f0a500", borderRadius: "6px", padding: "1rem" }}>
          <p style={{ color: "#f0a500", fontWeight: 700, margin: "0 0 0.75rem", fontSize: "0.9rem" }}>
            ⚠ Bestätigung erforderlich — {entries.length} Votes werden sequenziell gesendet
          </p>

          <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", fontSize: "0.82rem", marginBottom: "0.75rem" }}>
            <span style={{ color: "#8b949e" }}>VP jetzt: <b style={{ color: "#e6edf3" }}>{plan.summary.currentVpPct.toFixed(1)}%</b></span>
            <span style={{ color: "#8b949e" }}>Verbrauch: <b style={{ color: "#e6edf3" }}>{plan.summary.estimatedVpSpendPct}%</b></span>
            <span style={{ color: "#8b949e" }}>VP danach: <b style={{ color: sustainColor }}>{plan.summary.estimatedVpAfterPct.toFixed(1)}%</b></span>
            <span style={{ color: sustainColor, fontWeight: 600 }}>
              {plan.summary.sustainability === "sustainable" ? "✓ Nachhaltig" : plan.summary.sustainability === "aggressive" ? "⚠ Aggressiv" : "🔴 Kritisch"}
            </span>
          </div>

          <div style={{ background: "#161b22", borderRadius: "4px", padding: "0.5rem 0.75rem", marginBottom: "0.75rem", fontSize: "0.77rem", color: "#8b949e" }}>
            <b style={{ color: "#c9d1d9" }}>Safeguards:</b> Bereits gevotete Posts werden übersprungen · Fehler stoppen die Ausführung · 1.5s Pause zwischen Votes
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem", cursor: "pointer", fontSize: "0.82rem", color: "#c9d1d9" }}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={e => setConfirmed(e.target.checked)}
              style={{ accentColor: "#f0a500" }}
            />
            Ich habe den Plan überprüft und bestätige, dass diese {entries.length} Votes gesendet werden sollen.
          </label>

          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              style={{ ...chipBtn, background: confirmed ? "#f0a50022" : "#21262d", borderColor: confirmed ? "#f0a500" : "#30363d", color: confirmed ? "#f0a500" : "#484f58", fontWeight: 600 }}
              type="button"
              disabled={!confirmed}
              onClick={() => void startExecution()}
            >
              Jetzt {entries.length} Votes senden
            </button>
            <button style={chipBtn} type="button" onClick={reset}>Zurück</button>
          </div>
        </div>
      )}

      {/* ── Phase: executing ───────────────────────── */}
      {phase === "executing" && (
        <div style={{ background: "#0d1117", border: "1px solid #30363d", borderRadius: "6px", padding: "0.75rem 1rem" }}>
          <p style={{ color: "#c9d1d9", fontWeight: 600, margin: "0 0 0.5rem" }}>
            Sende Votes... {execLog.length}/{entries.length}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem", fontFamily: "monospace", fontSize: "0.77rem" }}>
            {execLog.map((l, i) => (
              <div key={i} style={{ color: l.status === "sent" ? "#3fb950" : l.status === "skipped" ? "#8b949e" : "#f85149" }}>
                {l.status === "sent" ? "✓" : l.status === "skipped" ? "⊘" : "✗"} @{l.author}/{l.permlink.slice(0, 30)} — {l.message}
              </div>
            ))}
            {execLog.length < entries.length && !aborted && (
              <div style={{ color: "#8b949e" }}>⏳ @{entries[execIndex]?.author ?? "..."}...</div>
            )}
            {aborted && <div style={{ color: "#f85149" }}>⛔ Gestoppt wegen Fehler</div>}
          </div>
        </div>
      )}

      {/* ── Phase: done ────────────────────────────── */}
      {phase === "done" && (
        <div>
          <div style={{ padding: "0.6rem 0.75rem", background: "#161b22", borderRadius: "5px", border: "1px solid #30363d", fontSize: "0.82rem", marginBottom: "0.5rem" }}>
            <b style={{ color: "#c9d1d9" }}>Ergebnis:</b>
            {" "}<span style={{ color: "#3fb950" }}>{execLog.filter(l => l.status === "sent").length} gesendet</span>
            {execLog.filter(l => l.status === "skipped").length > 0 && <span style={{ color: "#8b949e", marginLeft: "0.75rem" }}>{execLog.filter(l => l.status === "skipped").length} übersprungen</span>}
            {execLog.filter(l => l.status === "failed").length > 0 && <span style={{ color: "#f85149", marginLeft: "0.75rem" }}>{execLog.filter(l => l.status === "failed").length} fehlgeschlagen</span>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem", fontFamily: "monospace", fontSize: "0.75rem", marginBottom: "0.5rem", maxHeight: "200px", overflowY: "auto" }}>
            {execLog.map((l, i) => (
              <div key={i} style={{ color: l.status === "sent" ? "#3fb950" : l.status === "skipped" ? "#8b949e" : "#f85149" }}>
                {l.status === "sent" ? "✓" : l.status === "skipped" ? "⊘" : "✗"} @{l.author} — {l.message}
              </div>
            ))}
          </div>
          <button style={chipBtn} type="button" onClick={() => { reset(); props.onGenerate(); }}>Plan neu generieren</button>
        </div>
      )}
    </div>
  );
}

function OpenVoteOpportunities(props: {
  opportunities: PostOpportunity[] | null;
  meta: import("../api").OpportunitiesMeta | null;
  loading: boolean;
  error: string | null;
  strategyRules: StrategyRule[];
  accountSnapshot: SteemAccountSnapshot | null;
  onRefresh: () => void;
  onExecuteVotes: (targets: VoteTarget[]) => Promise<VoteBatchResult>;
}) {
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
  const currentVpBps  = props.accountSnapshot?.votingPowerBps ?? 10000;
  const totalSpendBps = allEligible.reduce((s, t) => s + t.weightBps, 0);
  const vpAfterBps    = Math.max(0, currentVpBps - totalSpendBps);
  const vpAfterPct    = Math.round(vpAfterBps / 100 * 10) / 10;

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
    background: "#161b22", border: "1px solid #30363d", borderRadius: "5px",
    color: "#c9d1d9", cursor: "pointer" as const, fontSize: "0.78rem", padding: "0.3rem 0.65rem",
  };
  const sectionLabel = {
    color: "#8b949e", fontSize: "0.75rem", textTransform: "uppercase" as const,
    letterSpacing: "0.5px", margin: 0, fontWeight: 600,
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.75rem" }}>
        <div>
          <p style={sectionLabel}>
            Offene Votes
            {props.opportunities !== null && totalOpen > 0 && (
              <span style={{ color: "#f0a500", fontWeight: 400, textTransform: "none", marginLeft: "0.5rem" }}>
                {totalOpen} offen
              </span>
            )}
            {props.opportunities !== null && totalOpen === 0 && (
              <span style={{ color: "#3fb950", fontWeight: 400, textTransform: "none", marginLeft: "0.5rem" }}>
                ✓ Alles gevoted
              </span>
            )}
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
          {totalOpen > 0 && props.opportunities !== null && (
            <button
              style={{ ...chipBtn, background: "#1f6feb22", borderColor: "#1f6feb", color: "#58a6ff", fontWeight: 600 }}
              type="button"
              disabled={voting}
              onClick={() => { setPreview(allEligible); setVoteResult(null); }}
            >
              Vote alle {totalOpen} offenen Posts
            </button>
          )}
          <button
            style={chipBtn}
            type="button"
            disabled={props.loading}
            onClick={props.onRefresh}
          >
            {props.loading ? "Lädt..." : props.opportunities === null ? "Jetzt prüfen" : "Aktualisieren"}
          </button>
        </div>
      </div>

      {props.error && (
        <p style={{ color: "#f85149", fontSize: "0.82rem", margin: "0 0 0.75rem" }}>{props.error}</p>
      )}

      {props.opportunities === null && !props.loading && (
        <p style={{ color: "#484f58", fontSize: "0.82rem", margin: 0 }}>
          Klicke "Jetzt prüfen" — VoteBroker sucht nach offenen Posts deiner Strategie-Autoren.
        </p>
      )}

      {/* Scan Meta — author coverage overview */}
      {props.meta && !props.loading && (
        <div style={{ background: "#161b22", border: "1px solid #30363d", borderRadius: "5px", padding: "0.6rem 0.75rem", marginBottom: "0.6rem", fontSize: "0.77rem" }}>
          <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap", color: "#8b949e", marginBottom: "0.35rem" }}>
            <span>Autoren angefragt: <b style={{ color: "#e6edf3" }}>{props.meta.requestedAuthors}</b></span>
            <span>Gescannt: <b style={{ color: "#e6edf3" }}>{props.meta.scannedAuthors}</b></span>
            <span>Posts gefunden: <b style={{ color: "#e6edf3" }}>{props.meta.totalPosts}</b></span>
            <span>Davon wählbar: <b style={{ color: props.meta.eligiblePosts > 0 ? "#3fb950" : "#8b949e" }}>{props.meta.eligiblePosts}</b></span>
          </div>
          {/* Per-author breakdown — highlight authors with 0 posts */}
          {(() => {
            const noPost  = Object.entries(props.meta.perAuthor).filter(([, v]) => v.noRecentPosts).map(([k]) => k);
            const withPost = Object.entries(props.meta.perAuthor).filter(([, v]) => !v.noRecentPosts && v.eligible > 0).map(([k]) => k);
            return (
              <>
                {withPost.length > 0 && (
                  <div style={{ color: "#3fb950", fontSize: "0.72rem" }}>
                    ✓ Mit offenen Posts: {withPost.join(", ")}
                  </div>
                )}
                {noPost.length > 0 && (
                  <div style={{ color: "#484f58", fontSize: "0.72rem", marginTop: "0.15rem" }}>
                    Keine aktuellen Posts (inaktiv / bereits gevoted): {noPost.slice(0, 10).join(", ")}{noPost.length > 10 ? ` +${noPost.length - 10}` : ""}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* Per-author groups */}
      {props.opportunities !== null && authorGroups.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {authorGroups.map(group => {
            const authorTargets = group.eligible.map(p => ({
              author: p.author, permlink: p.permlink, title: p.title, ageMinutes: p.ageMinutes,
              weightBps: Math.round(group.rule.maxWeightPct * 100), category: group.rule.category,
            }));
            const color = categoryColor[group.rule.category];
            return (
              <div key={group.rule.username} style={{
                background: "#161b22", border: "1px solid #30363d",
                borderLeft: `3px solid ${group.eligible.length > 0 ? color : "#30363d"}`,
                borderRadius: "5px", padding: "0.6rem 0.75rem",
              }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.4rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                    <span style={{ color: "#58a6ff", fontWeight: 500, fontSize: "0.87rem" }}>@{group.rule.username}</span>
                    <span style={{ color: color, fontSize: "0.73rem" }}>{categoryLabel[group.rule.category]}</span>
                    <span style={{ color: "#8b949e", fontSize: "0.75rem" }}>
                      Posts: {group.posts.length} · Gevoted: {group.voted.length} · Offen: <b style={{ color: group.eligible.length > 0 ? "#f0a500" : "#3fb950" }}>{group.eligible.length}</b>
                    </span>
                    {group.posts.length > 0 && (
                      <span style={{ color: "#8b949e", fontSize: "0.75rem" }}>
                        Letzter: {formatAge(Math.min(...group.posts.map(p => p.ageMinutes)))}
                      </span>
                    )}
                  </div>
                  {group.eligible.length > 0 && (
                    <button
                      style={{ ...chipBtn, borderColor: color + "80", color, fontSize: "0.75rem", padding: "0.2rem 0.5rem" }}
                      type="button"
                      disabled={voting}
                      onClick={() => { setPreview(authorTargets); setVoteResult(null); }}
                    >
                      Vote {group.eligible.length} offen
                    </button>
                  )}
                </div>

                {/* Eligible posts */}
                {group.eligible.length > 0 && (
                  <div style={{ marginTop: "0.4rem", paddingLeft: "0.5rem", borderLeft: "2px solid #21262d" }}>
                    {group.eligible.map(p => (
                      <div key={p.permlink} style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.2rem 0", fontSize: "0.78rem" }}>
                        <span style={{ color: "#c9d1d9", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          ↳ {p.title || `${p.author}/${p.permlink}`}
                        </span>
                        <span style={{ color: "#8b949e", whiteSpace: "nowrap" }}>{formatAge(p.ageMinutes)}</span>
                        <span style={{ color: color, whiteSpace: "nowrap", fontWeight: 600 }}>{group.rule.maxWeightPct}%</span>
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
        <div style={{ marginTop: "0.75rem", padding: "0.75rem 1rem", background: "#0d1117", border: "1px solid #f0a500", borderRadius: "6px" }}>
          <p style={{ color: "#f0a500", fontWeight: 600, margin: "0 0 0.5rem", fontSize: "0.87rem" }}>
            Vote-Vorschau — {preview.length} {preview.length === 1 ? "Post" : "Posts"}
          </p>
          <div style={{ color: "#8b949e", fontSize: "0.8rem", marginBottom: "0.6rem", display: "flex", gap: "1.25rem", flexWrap: "wrap" }}>
            <span>Autoren: <b style={{ color: "#e6edf3" }}>{new Set(preview.map(t => t.author)).size}</b></span>
            <span>Ø Gewicht: <b style={{ color: "#e6edf3" }}>{avgWeightPct}%</b></span>
            <span>Aktuelle VP: <b style={{ color: "#e6edf3" }}>{Math.round(currentVpBps / 100 * 10) / 10}%</b></span>
            <span>VP danach: <b style={{ color: vpAfterPct < 75 ? "#f85149" : vpAfterPct < 85 ? "#f0a500" : "#3fb950" }}>{vpAfterPct}%</b></span>
          </div>
          <div style={{ marginBottom: "0.75rem", maxHeight: "160px", overflowY: "auto" }}>
            {preview.map(t => (
              <div key={`${t.author}/${t.permlink}`} style={{ display: "flex", gap: "0.75rem", fontSize: "0.77rem", padding: "0.15rem 0", color: "#8b949e" }}>
                <span style={{ color: "#58a6ff" }}>@{t.author}</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#c9d1d9" }}>{t.title || t.permlink}</span>
                <span style={{ whiteSpace: "nowrap", color: categoryColor[t.category], fontWeight: 600 }}>{(t.weightBps / 100).toFixed(1)}%</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              style={{ ...chipBtn, background: "#1f6feb22", borderColor: "#1f6feb", color: "#58a6ff", fontWeight: 600 }}
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
        <div style={{ marginTop: "0.6rem", background: "#161b22", border: "1px solid #30363d", borderRadius: "6px", padding: "0.6rem 0.75rem" }}>
          {/* Summary line */}
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "0.5rem", fontSize: "0.8rem" }}>
            {voteResult.ok > 0 && <span style={{ color: "#3fb950", fontWeight: 600 }}>✓ {voteResult.ok} gesendet</span>}
            {voteResult.skipped > 0 && <span style={{ color: "#8b949e", fontWeight: 600 }}>⊘ {voteResult.skipped} übersprungen</span>}
            {voteResult.failed > 0 && <span style={{ color: "#f85149", fontWeight: 600 }}>✗ {voteResult.failed} fehlgeschlagen</span>}
          </div>
          {/* Per-vote results */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
            {voteResult.results.map((r, i) => {
              const statusColor = r.status === "success" ? "#3fb950" : r.status === "skipped" ? "#8b949e" : "#f85149";
              const statusIcon  = r.status === "success" ? "✓" : r.status === "skipped" ? "⊘" : "✗";
              const txShort     = r.transactionId && r.transactionId.length >= 12
                ? r.transactionId.slice(0, 12) + "…"
                : r.transactionId;
              return (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", fontSize: "0.77rem" }}>
                  <span style={{ color: statusColor, fontWeight: 700, flexShrink: 0 }}>{statusIcon}</span>
                  <span style={{ color: "#58a6ff", flexShrink: 0 }}>@{r.author}</span>
                  <span style={{ color: "#484f58", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>/{r.permlink.slice(0, 40)}{r.permlink.length > 40 ? "…" : ""}</span>
                  {r.status === "success" && txShort && (
                    <span style={{ color: "#3fb950", flexShrink: 0, fontFamily: "monospace" }}>TX: {txShort}</span>
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

function AccountSnapshotPanel(props: {
  loading: boolean;
  snapshot: SteemAccountSnapshot | null;
  session: AuthSession | null;
}) {
  if (!props.session) return null;
  if (props.loading) {
    return (
      <section className="auth-bar">
        <div><span>Account-Daten</span><strong>Lade Steem-Daten...</strong></div>
      </section>
    );
  }
  if (!props.snapshot) return null;
  const vp = (props.snapshot.votingPowerBps / 100).toFixed(1);
  const sp = props.snapshot.steemPowerSp.toLocaleString("de-DE", { maximumFractionDigits: 0 });
  return (
    <section className="auth-bar" style={{ flexWrap: "wrap", gap: "0.75rem" }}>
      <div>
        <span>Steem Account — Live</span>
        <strong>@{props.snapshot.username}</strong>
      </div>
      <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", fontSize: "0.85rem" }}>
        <span><b>Voting Power:</b> {vp}%</span>
        <span><b>Steem Power:</b> {sp} SP</span>
        <span><b>100% Vote:</b> ~${props.snapshot.fullPowerVoteUsd.toFixed(3)}</span>
        <span><b>Aktueller Vote:</b> ~${props.snapshot.currentVoteUsd.toFixed(3)}</span>
        <span style={{ color: "#888" }}>STEEM/USD ${props.snapshot.steemPriceUsd.toFixed(4)} (Näherung)</span>
      </div>
    </section>
  );
}

function AuthorityPanel(props: {
  grantUrl: string;
  hasAuthority: boolean | null;
  session: AuthSession | null;
}) {
  if (!props.session) return null;

  return (
    <section className="auth-bar">
      <div>
        <span>Posting Authority</span>
        <strong>
          {props.hasAuthority === null && "Wird geprüft..."}
          {props.hasAuthority === true && "@votebroker kann serverseitig voten ✓"}
          {props.hasAuthority === false && "@votebroker hat noch keine Posting-Berechtigung"}
        </strong>
        {props.hasAuthority === false && (
          <small style={{ display: "block", marginTop: "0.25rem", color: "#888", fontSize: "0.78rem" }}>
            Einmalig nötig — bitte den <strong>Active Key</strong> (nicht Posting Key) bereithalten.
          </small>
        )}
      </div>
      {props.hasAuthority === false && props.grantUrl && (
        <a className="secondary-button" href={props.grantUrl}>
          <ShieldCheck size={16} />
          Posting Authority erteilen
        </a>
      )}
      {props.hasAuthority === true && (
        <div className="status-pill">
          <CheckCircle2 size={16} />
          Aktiv
        </div>
      )}
    </section>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function Dashboard(props: { communityError: string | null; overview: CommunityPoolOverview | null; snapshot: SteemAccountSnapshot | null }) {
  const maxCurated = Math.max(...curationSeries.map((entry) => entry.curated));
  const trendPoints = curationSeries
    .map((entry, index) => {
      const x = (index / (curationSeries.length - 1)) * 100;
      const y = 100 - (entry.power / 100) * 86;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <section className="dashboard">
      <div className="summary-grid">
        <SummaryCard
          icon={<TrendingUp size={19} />}
          label="Total Curated Value [Demo]"
          value={`$${dashboardStats.totalCuratedUsd.toFixed(2)}`}
          detail="Wert, der durch Votes bewegt wurde"
        />
        <SummaryCard
          icon={<WalletCards size={19} />}
          label="Active Vote Value [Demo]"
          value={`$${dashboardStats.activeVoteUsd.toFixed(2)}`}
          detail="aktuell geplante Curation"
        />
        <SummaryCard
          icon={<ShieldCheck size={19} />}
          label="Fee Coverage [Demo]"
          value={`${dashboardStats.feeCoverage}%`}
          detail={`$${(dashboardStats.feeUsd - dashboardStats.pendingFeesUsd).toFixed(2)} gedeckt`}
        />
        <SummaryCard
          icon={<BadgeDollarSign size={19} />}
          label="Pending Fees [Demo]"
          value={`$${dashboardStats.pendingFeesUsd.toFixed(2)}`}
          detail={`$${dashboardStats.feeUsd.toFixed(2)} total bei 3%`}
        />
        <SummaryCard
          icon={<Gauge size={19} />}
          label="Voting Power"
          value={props.snapshot
            ? `${(props.snapshot.votingPowerBps / 100).toFixed(1)}%`
            : `${dashboardStats.votingPowerHealth}% [Demo]`}
          detail={props.snapshot
            ? `${props.snapshot.steemPowerSp.toFixed(0)} SP — ca. $${props.snapshot.currentVoteUsd.toFixed(3)} aktuell`
            : "stark genug fuer Auto-Fee-Votes"}
        />
        <SummaryCard
          icon={<LineChart size={19} />}
          label="Curation Efficiency [Demo]"
          value={`${dashboardStats.curationEfficiency.toFixed(1)}x`}
          detail="$42.00 Nutzen zu $1.26 Gebuehr"
        />
      </div>

      <div className="analytics-grid">
        <section className="panel analytics-panel">
          <div className="panel-title compact-title">
            <BarChart3 size={20} />
            <h2>Curation Value vs. Fees</h2>
          </div>
          <div className="bar-chart" aria-label="Curation value compared with fee value">
            {curationSeries.map((entry) => (
              <div className="bar-column" key={entry.day}>
                <div className="bar-stack">
                  <span
                    className="bar curated"
                    style={{ height: `${Math.max(16, (entry.curated / maxCurated) * 100)}%` }}
                    title={`Curated $${entry.curated}`}
                  />
                  <span
                    className="bar fee"
                    style={{ height: `${Math.max(8, (entry.fees / maxCurated) * 100)}%` }}
                    title={`Fees $${entry.fees}`}
                  />
                </div>
                <strong>{entry.day}</strong>
              </div>
            ))}
          </div>
          <div className="chart-legend">
            <span><i className="legend curated" /> Curation</span>
            <span><i className="legend fee" /> Fee vote</span>
          </div>
        </section>

        <section className="panel analytics-panel">
          <div className="panel-title compact-title">
            <LineChart size={20} />
            <h2>Voting Power Verlauf</h2>
          </div>
          <div className="line-chart">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Voting power trend">
              <polyline points={trendPoints} />
            </svg>
            <div className="line-chart-overlay">
              <span>{dashboardStats.votingPowerHealth}%</span>
              <strong>Voting Power Health</strong>
            </div>
          </div>
          <div className="flow-list">
            {voteFlow.map((item) => (
              <div className="flow-row" key={item.label}>
                <span className={`flow-dot ${item.color}`} />
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="panel coverage-panel">
          <div>
            <div className="panel-title compact-title">
              <ShieldCheck size={20} />
              <h2>Fee Coverage</h2>
            </div>
            <p className="coverage-copy">
              Der Gebuehrenpost deckt fast alle offenen Rechnungen automatisch ab. Nur Accounts mit dauerhaft schwacher
              Voting Power landen in Warnung oder Pause.
            </p>
          </div>
          <div className="coverage-meter" style={{ "--coverage": `${dashboardStats.feeCoverage}%` } as React.CSSProperties}>
            <span>{dashboardStats.feeCoverage}%</span>
          </div>
        </section>
      </div>

      <CommunityPoolSection communityError={props.communityError} overview={props.overview} />
    </section>
  );
}

function CommunityPoolSection(props: {
  communityError: string | null;
  overview: CommunityPoolOverview | null;
  onAddToStrategy?: (username: string, category: StrategyCategory) => void;
}) {
  if (props.communityError) {
    return (
      <section className="panel pool-panel">
        <div className="notice danger">
          <AlertTriangle size={16} />
          {props.communityError}
        </div>
      </section>
    );
  }

  const overview = props.overview;
  if (!overview) {
    return (
      <section className="panel pool-panel">
        <div className="empty-state">Community Pool wird geladen.</div>
      </section>
    );
  }

  const feeRatio = overview.pool.stats.feesUsd30d / overview.pool.stats.curatedUsd30d;
  const healthTone = overview.health.status === "excellent" || overview.health.status === "healthy"
    ? "good"
    : overview.health.status === "watch"
      ? "watch"
      : "blocked";

  return (
    <section className="pool-grid">
      <section className="panel pool-panel">
        <div className="panel-title compact-title">
          <Users size={20} />
          <h2>Community Pool</h2>
        </div>
        <div className="pool-headline">
          <div>
            <span>{overview.pool.name}</span>
            <strong>{overview.pool.stats.poolPowerSp.toLocaleString("de-DE")} SP</strong>
            <p>{overview.pool.description}</p>
          </div>
          <div className="pool-badge">
            {overview.pool.stats.activeMembers}/{overview.pool.members.length} aktiv
          </div>
        </div>

        <div className="pool-metrics">
          <Metric label="Curated 30d" value={`$${overview.pool.stats.curatedUsd30d.toFixed(2)}`} />
          <Metric label="Fees 30d" value={`$${overview.pool.stats.feesUsd30d.toFixed(2)}`} />
          <Metric label="Scheduled Votes" value={`$${overview.pool.stats.scheduledVotesUsd.toFixed(2)}`} />
          <Metric label="Fee Ratio" value={`${(feeRatio * 100).toFixed(1)}%`} />
        </div>

        <div className="policy-strip">
          <span>Pool-Regeln</span>
          <strong>Max ${overview.pool.policy.maxVoteUsdPerPost.toFixed(2)} pro Post</strong>
          <strong>{overview.pool.policy.dailyVoteBudgetUsd.toFixed(2)} USD Tagesbudget</strong>
          <strong>{(overview.pool.policy.minVotingPowerBps / 100).toFixed(0)}% min. Voting Power</strong>
        </div>

        <div className="member-list">
          {overview.pool.members.map((member) => (
            <div className="member-row" key={member.username}>
              <div>
                <strong>@{member.username}</strong>
                <span>{member.role} - {member.delegatedSp.toLocaleString("de-DE")} SP</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <span className={`member-status ${member.status}`}>{member.status}</span>
                {props.onAddToStrategy && (
                  <button
                    type="button"
                    onClick={() => props.onAddToStrategy!(member.username, "bevorzugt")}
                    style={{ background: "#1f6feb22", border: "1px solid #1f6feb40", borderRadius: "4px", color: "#58a6ff", cursor: "pointer", fontSize: "0.7rem", padding: "0.1rem 0.4rem" }}
                    title="Zur Strategie hinzufügen"
                  >
                    + Strategie
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="panel health-panel">
        <div className="panel-title compact-title">
          <Network size={20} />
          <h2>Account Health Score</h2>
        </div>
        <div className={`health-score ${healthTone}`}>
          <span>{overview.health.score}</span>
          <strong>{overview.health.status}</strong>
        </div>
        <p className="health-summary">{overview.health.summary}</p>

        <div className="factor-list">
          {overview.health.factors.map((factor) => (
            <div className="factor-row" key={factor.key}>
              <div>
                <strong>{factor.label}</strong>
                <span>{factor.detail}</span>
              </div>
              <div className="factor-meter" style={{ "--score": `${factor.score}%` } as React.CSSProperties}>
                <i />
              </div>
              <b>{factor.score}</b>
            </div>
          ))}
        </div>

        <div className="recommendations">
          <span>Naechste sinnvolle Schritte</span>
          {overview.health.recommendations.length === 0 ? (
            <strong>Alles stabil. Pool-Automation kann konservativ laufen.</strong>
          ) : (
            overview.health.recommendations.map((recommendation) => (
              <strong key={recommendation}>{recommendation}</strong>
            ))
          )}
        </div>
      </section>
    </section>
  );
}

function SummaryCard(props: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <section className="summary-card">
      <div className="summary-icon">{props.icon}</div>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <p>{props.detail}</p>
    </section>
  );
}
