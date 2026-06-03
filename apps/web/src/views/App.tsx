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
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
  type CommunityDiscovery,
  type AuthorDiscoveryCard,
  fetchCommunityDiscovery,
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
  const [timezone, setTimezoneRaw] = useState<string>(() =>
    window.localStorage.getItem("votebroker.timezone") ??
    Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const setTimezone = (tz: string) => {
    window.localStorage.setItem("votebroker.timezone", tz);
    setTimezoneRaw(tz);
  };
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
  const [communityDiscovery, setCommunityDiscovery] = useState<CommunityDiscovery | null>(null);
  const [communityDiscoveryLoading, setCommunityDiscoveryLoading] = useState(false);
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
  // Keys of posts voted successfully this session — prevents server re-scan from un-doing local state
  const recentlyVotedKeysRef = useRef<Set<string>>(new Set());
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
      .then((overview) => { setCommunityOverview(overview); setCommunityError(null); })
      .catch((err) => setCommunityError(err instanceof Error ? err.message : "Community pool could not be loaded"));
  }, [username]);

  // Lazy-load community discovery only when tab is opened
  useEffect(() => {
    if (activeTab !== "community" || !session || communityDiscovery || communityDiscoveryLoading) return;
    setCommunityDiscoveryLoading(true);
    fetchCommunityDiscovery(session.token)
      .then(setCommunityDiscovery)
      .catch(() => setCommunityDiscovery(null))
      .finally(() => setCommunityDiscoveryLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, session]);

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

  // Immediately refresh snapshot when switching to dashboard tab, then poll every 60s
  useEffect(() => {
    if (!session || activeTab !== "dashboard") return;
    refreshSnapshot(); // immediate fetch on tab switch
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

  async function generateVotes(targetOverride?: number) {
    if (!session || !strategyRules || !accountSnapshot) return;
    const effectiveTarget = targetOverride ?? targetVotingPowerPct;
    if (targetOverride !== undefined) setTargetVotingPowerPct(targetOverride);
    setPlanLoading(true);
    setPlanError(null);
    try {
      const plan = await generateVotePlan({
        voterUsername:       session.user.username,
        currentVpBps:        accountSnapshot.votingPowerBps,
        currentVoteUsd:      accountSnapshot.currentVoteUsd,
        targetVpPct:         effectiveTarget,
        targetTomorrowVpPct: effectiveTarget,
        constraints:         DEFAULT_CONSTRAINTS,
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
      // Apply recentlyVoted filter — prevents server scan from un-doing a successful local vote
      const voted = recentlyVotedKeysRef.current;
      const filtered = voted.size === 0
        ? result.opportunities
        : result.opportunities.map(p =>
            voted.has(`${p.author}/${p.permlink}`)
              ? { ...p, alreadyVoted: true, eligible: false }
              : p
          );
      setOpportunities(filtered);
      setOpportunitiesMeta(result.meta);
      // Always refresh VP after a scan — user is about to vote
      refreshSnapshot();

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
        const key = `${target.author}/${target.permlink}`;
        recentlyVotedKeysRef.current.add(key);
        setTimeout(() => recentlyVotedKeysRef.current.delete(key), 90_000);
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
      setTimeout(() => refreshSnapshot(), 5_000);
      setTimeout(() => refreshSnapshot(), 12_000); // second pass for slow nodes
      if (opportunities !== null) setTimeout(() => loadOpportunities(), 9_000);
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
    // Mark as voted in opportunities + recentlyVoted guard
    const key = `${target.author}/${target.permlink}`;
    recentlyVotedKeysRef.current.add(key);
    setTimeout(() => recentlyVotedKeysRef.current.delete(key), 90_000);
    setOpportunities(prev => prev?.map(p =>
      p.author === target.author && p.permlink === target.permlink
        ? { ...p, alreadyVoted: true, eligible: false }
        : p
    ) ?? null);
    // Refresh VP after the Steem node has processed the transaction (two passes for slow nodes)
    setTimeout(() => refreshSnapshot(), 5_000);
    setTimeout(() => refreshSnapshot(), 12_000);
    if (opportunities !== null) setTimeout(() => loadOpportunities(), 9_000);
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
      <main className="shell" style={{ minHeight: "100vh", background: "#ffffff" }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "1rem 1.5rem", borderBottom: "1px solid #21262d" }}>
          <span style={{ fontWeight: 700, color: "#2563eb", fontSize: "1rem", letterSpacing: "-0.3px" }}>VoteBroker</span>
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
            <p style={{ color: "#607078", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "1px", fontWeight: 600, marginBottom: "0.75rem" }}>
              Community Support für Steem
            </p>
            <h1 style={{ color: "#17202a", fontSize: "1.75rem", fontWeight: 800, lineHeight: 1.25, margin: "0 0 1rem", letterSpacing: "-0.5px" }}>
              Unterstütze die Autoren,<br />die dir wichtig sind
            </h1>
            <p style={{ color: "#607078", fontSize: "0.95rem", lineHeight: 1.6, margin: 0, maxWidth: "460px", marginInline: "auto" }}>
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
                background: "#f0f5f7", border: "1px solid #21262d", borderRadius: "10px",
                padding: "0.85rem 1rem",
              }}>
                <span style={{ fontSize: "1.35rem", lineHeight: 1, marginTop: "0.05rem", flexShrink: 0 }}>{f.icon}</span>
                <div>
                  <p style={{ color: "#17202a", fontSize: "0.88rem", fontWeight: 600, margin: "0 0 0.2rem" }}>{f.title}</p>
                  <p style={{ color: "#607078", fontSize: "0.8rem", lineHeight: 1.5, margin: 0 }}>{f.desc}</p>
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

          <p style={{ color: "#8fa4b0", fontSize: "0.73rem", marginTop: "0.85rem", textAlign: "center", lineHeight: 1.6 }}>
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
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.75rem 1.5rem", borderBottom: "1px solid #21262d", background: "#ffffff", flexWrap: "wrap", gap: "0.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <span style={{ fontWeight: 700, color: "#2563eb", fontSize: "0.95rem" }}>VoteBroker</span>
          {accountSnapshot ? (
            <span style={{ color: "#607078", fontSize: "0.82rem" }}>
              @{accountSnapshot.username} · <b style={{ color: "#17202a" }}>{accountSnapshot.steemPowerSp.toFixed(0)} SP</b> · <b style={{ color: "#17202a" }}>{(accountSnapshot.votingPowerBps / 100).toFixed(1)}%</b> VP · ~<b style={{ color: "#17202a" }}>${accountSnapshot.currentVoteUsd.toFixed(4)}</b>
            </span>
          ) : (
            <span style={{ color: "#607078", fontSize: "0.82rem" }}>@{session.user.username}</span>
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
      <nav style={{ display: "flex", borderBottom: "1px solid #21262d", background: "#ffffff", padding: "0 1.5rem" }}>
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
                color: activeTab === tab ? "#17202a" : "#607078",
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
              color: activeTab === "admin" ? "#d97706" : "#607078",
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
            onGenerateWithTarget={generateVotes}
            targetVotingPowerPct={targetVotingPowerPct}
          />
        </div>
      )}

      {/* Tab: Dashboard */}
      {activeTab === "dashboard" && (
        <UserDashboard
          session={session}
          locale={locale}
          timezone={timezone}
          snapshot={accountSnapshot}
          snapshotLoading={snapshotLoading}
          snapshotRefreshedAt={snapshotRefreshedAt ?? undefined}
          strategyRules={strategyRules}
          opportunities={opportunities}
          opportunitiesLoading={opportunitiesLoading}
          opportunitiesMeta={opportunitiesMeta}
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
          <CommunityDiscoverySection
            discovery={communityDiscovery}
            loading={communityDiscoveryLoading}
            onAddToStrategy={addAuthorToStrategy}
          />
        </div>
      )}

      {/* Tab: Billing / Einstellungen */}
      {activeTab === "billing" && (
        <div>
          <TimezoneSettings
            locale={locale} timezone={timezone}
            onLocaleChange={changeLocale} onTimezoneChange={setTimezone}
            t={t}
          />
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
            <p style={{ color: "#607078", fontSize: "0.78rem", margin: "0.2rem 0 0" }}>
              → {props.error.hint}
            </p>
          )}
          {errorActionLink[props.error.code] && (
            <p style={{ color: "#2563eb", fontSize: "0.78rem", margin: "0.2rem 0 0" }}>
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
    background: "#ffffff", border: "1px solid #21262d", borderRadius: "8px", padding: "1.25rem 1.5rem",
    marginBottom: "1rem"
  };

  return (
    <div>
      {/* Header */}
      <div style={{ ...panelStyle, marginBottom: "0.75rem" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.25rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <ShieldCheck size={18} style={{ color: "#2563eb" }} />
            <span style={{ color: "#17202a", fontWeight: 700, fontSize: "1rem" }}>Berechtigungen</span>
          </div>
          <span style={{ color: "#607078", fontSize: "0.78rem" }}>
            {activeTypes.size} von {CONSENT_ORDER.length} aktiv
          </span>
        </div>
        <p style={{ color: "#607078", fontSize: "0.82rem", margin: 0 }}>
          Du behältst die vollständige Kontrolle. Jede Berechtigung kann jederzeit widerrufen werden.
        </p>
      </div>

      {props.consentError && (
        <div style={{ background: "#3d0e0e", border: "1px solid #f85149", borderRadius: "6px", padding: "0.6rem 0.75rem", marginBottom: "0.75rem", color: "#dc2626", fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
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
                background: "#f0f5f7",
                border: `1px solid ${active ? "#dde8ed" : "#dde8ed"}`,
                borderLeft: `3px solid ${active ? "#16a34a" : "#c5d3da"}`,
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
                  <span style={{ color: "#17202a", fontWeight: 600, fontSize: "0.9rem" }}>{meta.label}</span>
                  {meta.required && (
                    <span style={{ background: "#1b4332", color: "#16a34a", border: "1px solid #3fb95055", borderRadius: "4px", padding: "0.05rem 0.4rem", fontSize: "0.68rem", fontWeight: 600 }}>
                      Erforderlich
                    </span>
                  )}
                  {!active && !meta.required && (
                    <span style={{ color: "#8fa4b0", fontSize: "0.72rem" }}>Nicht aktiv</span>
                  )}
                </div>
                <p style={{ color: "#607078", fontSize: "0.8rem", margin: "0 0 0.2rem", lineHeight: 1.4 }}>
                  {meta.description}
                </p>
                <p style={{ color: "#8fa4b0", fontSize: "0.73rem", margin: 0, fontStyle: "italic" }}>
                  {meta.note}
                </p>
              </div>

              {/* Toggle */}
              <div style={{ flexShrink: 0 }}>
                {meta.required ? (
                  <span style={{ color: "#16a34a", fontSize: "0.78rem", fontWeight: 600 }}>Immer aktiv</span>
                ) : active ? (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => props.onRevoke(type)}
                    style={{
                      background: "#dde8ed", border: "1px solid #f8514955", borderRadius: "5px",
                      color: "#dc2626", cursor: disabled ? "default" : "pointer",
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
                      background: "#2563eb14", border: "1px solid #1f6feb", borderRadius: "5px",
                      color: "#2563eb", cursor: disabled ? "default" : "pointer",
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
        <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", background: "#ffffff", border: "1px solid #21262d", borderRadius: "6px" }}>
          <p style={{ color: "#607078", fontSize: "0.73rem", textTransform: "uppercase", letterSpacing: "0.5px", margin: "0 0 0.5rem", fontWeight: 600 }}>
            Letzte Änderungen
          </p>
          {history.map(record => (
            <div key={record.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.78rem", color: "#607078", marginBottom: "0.2rem" }}>
              <span style={{ color: record.status === "granted" ? "#16a34a" : "#dc2626" }}>
                {record.status === "granted" ? "✓ Aktiviert" : "✗ Deaktiviert"}
              </span>
              <span>{CONSENT_META[record.type as ConsentType]?.label ?? record.title}</span>
              <span style={{ color: "#8fa4b0" }}>
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
  lieblingsautor: "#d97706",
  bevorzugt:      "#2563eb",
  normal:         "#16a34a",
  niedrig:        "#607078",
  ignorieren:     "#dc2626",
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
  onGenerateWithTarget: (targetPct: number) => void;
  targetVotingPowerPct: number;
}) {
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
          <strong style={{ color: "#dc2626" }}>Fehler beim Laden der Vote-Historie</strong>
          <p style={{ color: "#607078", fontSize: "0.82rem", margin: "0.25rem 0 0" }}>{props.error}</p>
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
          <p style={{ color: "#607078", fontSize: "0.82rem", margin: "0.25rem 0 0" }}>
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

  const vpPct = props.accountSnapshot ? props.accountSnapshot.votingPowerBps / 100 : null;

  const heroStats = [
    { val: p.votesAnalyzed.toLocaleString(), lbl: "Votes"   },
    { val: p.uniqueAuthors,                  lbl: "Autoren" },
    ...(vpPct !== null ? [{ val: `${vpPct.toFixed(1)}%`, lbl: "VP" }] : []),
    { val: p.periodDays,                     lbl: "Akt. Tage" },
  ];

  return (
    <section style={{ background: "#ffffff", border: "1px solid #dde8ed", borderRadius: "14px", padding: "1.5rem 1.75rem", boxShadow: "0 2px 8px rgba(17,37,45,0.06)" }}>

      {/* ── 1. Hero ── */}
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", padding: "1rem 1.25rem", background: "linear-gradient(135deg, #f5f0ff 0%, #ffffff 60%, #edfbf9 100%)", borderRadius: "12px", border: "1px solid #e0d4fc", marginBottom: "1.25rem", flexWrap: "wrap" as const }}>
        <span style={{ fontSize: "2rem", lineHeight: 1, flexShrink: 0 }}>{emoji}</span>
        <div style={{ flex: 1, minWidth: "200px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.15rem" }}>
            <span style={{ color: "#7c3aed", fontWeight: 800, fontSize: "1rem" }}>{p.dnaLabel}</span>
            <span style={{ color: "#8fa4b0", fontSize: "0.72rem" }}>· Dein Kurator-Typ</span>
          </div>
          <p style={{ color: "#607078", fontSize: "0.78rem", margin: 0, lineHeight: 1.45, maxWidth: "520px" }}>{p.dnaDescription}</p>
        </div>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" as const }}>
          {heroStats.map(s => (
            <div key={s.lbl} style={{ textAlign: "center" as const }}>
              <div style={{ color: "#17202a", fontWeight: 800, fontSize: "1.15rem", lineHeight: 1 }}>{s.val}</div>
              <div style={{ color: "#8fa4b0", fontSize: "0.67rem", marginTop: "3px" }}>{s.lbl}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── 2. Handlungsempfehlung ── */}
      {!strategyRules ? (
        <div style={{ border: "1px dashed #2563eb44", borderRadius: "12px", padding: "1.75rem", background: "#f0f5ff", textAlign: "center" as const, marginBottom: "1.25rem" }}>
          <div style={{ fontSize: "2rem", marginBottom: "0.6rem" }}>🧬</div>
          <p style={{ color: "#17202a", fontSize: "0.95rem", fontWeight: 700, margin: "0 0 0.4rem" }}>Strategie noch nicht eingerichtet</p>
          <p style={{ color: "#607078", fontSize: "0.82rem", margin: "0 0 1rem", lineHeight: 1.55, maxWidth: "400px", marginLeft: "auto", marginRight: "auto" }}>
            VoteBroker analysiert deine Vote-Historie und generiert eine nachhaltige Curation-Strategie.
          </p>
          <button style={{ background: "#2563eb", border: "none", borderRadius: "8px", color: "#fff", cursor: "pointer", fontSize: "0.9rem", fontWeight: 700, padding: "0.65rem 1.4rem" }} type="button" onClick={generateStrategy}>
            Strategie aus Vote-DNA generieren →
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
            let msgTitle = "Was empfiehlt VoteBroker?";
            let msgBody = "Klicke auf «Votes scannen», um zu sehen was heute zu voten ist.";

            if (props.opportunitiesLoading || props.planLoading) {
              msgIcon = "⏳"; msgTitle = "Analysiere…"; msgBody = "VoteBroker prüft deine Autoren auf neue Posts.";
            } else if (openCount > 0 && vpMorgen !== null) {
              const sustainTxt = vpMorgen >= 80 ? `bist morgen wieder bei ${vpMorgen.toFixed(1)} % VP` : `VP morgen ca. ${vpMorgen.toFixed(1)} %`;
              const planLine = planVotes > 0 && planVotes < openCount
                ? ` · ${planVotes} davon im Plan` : "";
              if (recovery && reduction > 0) {
                msgIcon = "⚡"; msgTitle = `${openCount} offene Votes gefunden${planLine}`;
                msgBody = `Recovery-Modus: VoteBroker hat die Gewichte um ${reduction} % reduziert. Du ${sustainTxt}. Gewichte anpassen um mehr Votes aufzunehmen.`;
              } else {
                msgIcon = "✅"; msgTitle = `${openCount} offene Votes gefunden${planLine}`;
                msgBody = `Plan ausführen: ${planVotes} Votes · ${sustainTxt}.`;
              }
            } else if (hasOpps && openCount === 0) {
              msgIcon = "✓"; msgTitle = "Alles gevoted";
              msgBody = "Alle Posts deiner Autoren sind aktuell gevoted. Schau später nochmal vorbei.";
            } else if (planVotes > 0 && !hasOpps) {
              msgIcon = "🗳"; msgTitle = `${planVotes} Votes im Plan`;
              msgBody = "Scanne offene Votes, um zu sehen welche Posts jetzt verfügbar sind.";
            }

            // ── KPI-Werte ──────────────────────────────────────────────────────
            const hasEdits = liveMetrics?.hasEdits ?? false;
            const kpis = [
              { value: vpNow    !== null ? `${vpNow.toFixed(1)}%`    : "—", label: "VP jetzt",   sub: snap ? `${snap.steemPowerSp.toFixed(0)} SP` : "…",                                            color: vpColor(vpNow)    },
              { value: vpPlan   !== null ? `${vpPlan.toFixed(1)}%`   : "—", label: "nach Plan",  sub: planVotes > 0 ? `${planVotes} Vote${planVotes !== 1 ? "s" : ""}${hasEdits ? " (angepasst)" : ""}` : "kein Plan", color: vpColor(vpPlan)   },
              { value: vpMorgen !== null ? `${vpMorgen.toFixed(1)}%` : "—", label: "VP morgen",  sub: freeBudget !== null && freeBudget > 0 ? `${freeBudget.toFixed(2)}% VP frei` : vpMorgen !== null && vpMorgen >= 80 ? "Ziel ✓" : "+20% Regen", color: vpColor(vpMorgen) },
            ];

            return (
              <>
                {/* ── Botschaft ── */}
                <div style={{ marginBottom: "1.5rem" }}>
                  <p style={{ color: "#0369a1", fontSize: "0.68rem", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "1.2px", margin: "0 0 0.3rem" }}>Curator-Assistent</p>
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
                      <span style={{ color: "#92400e", fontSize: "1.15rem", fontWeight: 900 }}>⚡ {openCount} offene Votes gefunden</span>
                      <span style={{ color: "#78350f", fontSize: "0.8rem" }}>→ Details unten</span>
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
                      {props.opportunitiesLoading ? "Scannt…" : hasOpps ? "↻ Neu scannen" : "Offene Posts suchen →"}
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
                    {props.planLoading ? "Generiere…" : plan ? "↻ Plan aktualisieren" : "Vote-Plan generieren"}
                  </button>
                </div>

                {/* ── Strategie-Modus ── */}
                <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.25rem", alignItems: "center", flexWrap: "wrap" as const }}>
                  <span style={{ color: "#94a3b8", fontSize: "0.72rem", fontWeight: 600, whiteSpace: "nowrap" as const }}>Strategie:</span>
                  {([
                    { label: "Maximale Reichweite", pct: 70, icon: "🌐", sub: "mehr Votes, VP sinkt etwas" },
                    { label: "Ausgewogen",           pct: 80, icon: "⚖️", sub: "Standard" },
                    { label: "VP-Erholung",          pct: 90, icon: "🔋", sub: "weniger Votes, VP erholt sich schnell" },
                  ] as const).map(m => {
                    const active = props.targetVotingPowerPct === m.pct;
                    return (
                      <button
                        key={m.pct}
                        type="button"
                        title={m.sub}
                        onClick={() => props.onGenerateWithTarget(m.pct)}
                        disabled={props.planLoading}
                        style={{
                          background: active ? "#0ea5e9" : "#f1f5f9",
                          border: active ? "none" : "1.5px solid #e2e8f0",
                          borderRadius: "20px", color: active ? "#fff" : "#475569",
                          cursor: "pointer", fontSize: "0.78rem",
                          fontWeight: active ? 800 : 600,
                          padding: "0.35rem 0.85rem",
                          display: "flex", alignItems: "center", gap: "0.3rem",
                        }}
                      >
                        <span>{m.icon}</span> {m.label}
                      </button>
                    );
                  })}
                </div>

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
            <p style={{ ...sectionLabel, marginBottom: "0.65rem" }}>Beziehungen</p>
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
            <p style={{ ...sectionLabel, marginBottom: "0.65rem" }}>Aktivitätsmuster (UTC)</p>
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
            <p style={{ ...sectionLabel, marginBottom: "0.4rem" }}>Nachhaltigkeit</p>
            <p style={{ color: "#17202a", fontSize: "0.83rem", fontWeight: 700, margin: "0 0 0.2rem" }}>
              {p.powerStable.relevantAuthors} Autoren regelmäßig
            </p>
            <p style={{ color: "#607078", fontSize: "0.73rem", margin: 0, lineHeight: 1.5 }}>
              Empfohlen: ⌀ <b style={{ color: "#17202a" }}>{p.powerStable.maxAvgWeightPct}%</b>/Vote<br/>
              VP-Ziel: <b style={{ color: "#17202a" }}>80–95%</b>
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
              <span style={{ color: "#17202a", fontWeight: 700, fontSize: "0.9rem" }}>Autoren-Strategie</span>
              {strategyRules && (
                <span style={{ color: "#8fa4b0", fontSize: "0.73rem", marginLeft: "0.6rem" }}>
                  {strategyRules.filter(r => r.enabled).length} aktiv
                  {strategyRules.filter(r => r.manuallyModified).length > 0
                    ? ` · ${strategyRules.filter(r => r.manuallyModified).length} manuell`
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
              <StrategyEditor rules={strategyRules} votesPerDay={p.votesPerDay} currentVoteUsd={props.accountSnapshot?.currentVoteUsd ?? 0} onUpdate={updateRule} onRemove={removeRule} />
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
              <StrategyRuleRow key={rule.username} rule={rule} currentVoteUsd={props.currentVoteUsd} onUpdate={props.onUpdate} onRemove={props.onRemove} />
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
}) {
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
              {rule.voteCount === 0 && <span style={{ fontStyle: "italic" }}>Kein Vote-DNA-Datensatz — manuell hinzugefügt</span>}
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

function RecoveryBanner({ report }: { report: ConstraintReport }) {
  if (!report.recoveryMode && report.weightReductionPct === 0) return null;

  const isRecovery = report.recoveryMode;
  const reduced    = report.weightReductionPct;
  const tomorrow   = report.expectedTomorrowVpPct;

  if (!isRecovery && reduced === 0) return null;

  let title = "";
  let body  = "";

  if (isRecovery && reduced > 0) {
    title = "⚡ Recovery-Modus aktiv";
    body  = `VoteBroker reduziert die Gewichte automatisch um ${reduced} %, damit deine Voting Power morgen wieder auf ca. ${tomorrow} % steigt.`;
  } else if (isRecovery) {
    title = "⚡ Recovery-Modus aktiv";
    body  = `Die Voting Power ist unter dem Zielbereich. VoteBroker wählt nur Votes aus, die morgen eine VP von ca. ${tomorrow} % ermöglichen.`;
  } else {
    title = "ℹ Gewichte angepasst";
    body  = `Vote-Gewichte wurden um ${reduced} % reduziert, damit dein VP-Ziel morgen (${tomorrow} %) erhalten bleibt.`;
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

interface LivePlanMetrics {
  vpAfterPct: number;
  vpMorgenPct: number;
  vpCostPct: number;
  entryCount: number;
  hasEdits: boolean;
  freeBudgetPct: number;
}

type VoteDisplayMode = "pct" | "usd" | "sp";

function VotePlanSection(props: {
  plan: VotePlanResponse | null;
  loading: boolean;
  error: string | null;
  session: AuthSession;
  currentVoteUsd?: number; // dollar value of a 100% vote at current VP — for override recalc
  sbdPerSteem?: number;    // SBD/STEEM — for SP conversion: expectedVoteUsd / sbdPerSteem ≈ SP
  onGenerate: () => void;
  onExecuteSingle: (target: { author: string; permlink: string; weightBps: number }) => Promise<{ transactionId: string }>;
  onMetricsChange?: (m: LivePlanMetrics) => void;
  additionalCandidates?: VotePlanEntry[];
}) {
  const [phase, setPhase]           = useState<PlanPhase>("idle");
  const [confirmed, setConfirmed]   = useState(false);
  const [execLog, setExecLog]       = useState<VoteLogEntry[]>([]);
  const [execIndex, setExecIndex]   = useState(0);
  const [aborted, setAborted]       = useState(false);
  const [overrides, setOverrides]   = useState<Map<string, number>>(new Map());
  const [additions, setAdditions]   = useState<VotePlanEntry[]>([]);  // manuell hinzugefügte Kandidaten

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
  const allPlanEntries = [...effectiveEntries, ...additionEntries];

  const vpNowPct     = plan?.summary.currentVpPct ?? 0;
  const origVpCost   = entries.reduce((s, e) => s + e.suggestedWeightBps / MANA_DIV, 0);
  const effVpCost    = allPlanEntries.reduce((s, e) => s + e.suggestedWeightBps / MANA_DIV, 0);
  const origVpMorgen = Math.min(100, Math.round((vpNowPct - origVpCost + 20) * 10) / 10);
  const effVpMorgen  = Math.min(100, Math.round((vpNowPct - effVpCost  + 20) * 10) / 10);
  const savedVpPct   = Math.round((origVpCost - effVpCost) * 100) / 100;
  const hasEdits     = overrides.size > 0 || additions.length > 0;

  // Which additional candidates actually fit in the remaining budget?
  const dynamicBudget  = plan?.report.dynamicBudgetPct ?? 0;
  const addedKeys      = new Set(additions.map(e => `${e.author}/${e.permlink}`));
  let remainBudget     = Math.max(0, dynamicBudget - effVpCost);
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

  // Transition to "generated" whenever a new plan arrives (reset confirms + overrides)
  useEffect(() => {
    if (plan !== null) {
      setPhase("generated");
      setConfirmed(false); setExecLog([]); setExecIndex(0); setAborted(false);
      setOverrides(new Map());
      setAdditions([]);
    }
  }, [plan]);

  // Report live metrics upward — only when a plan exists (avoid showing 0%/20% before first plan)
  useEffect(() => {
    if (!props.onMetricsChange || !plan) return;
    const freeBudget = Math.max(0, Math.round((plan.report.dynamicBudgetPct - effVpCost) * 100) / 100);
    props.onMetricsChange({
      vpAfterPct:    Math.max(0, Math.round((vpNowPct - effVpCost) * 10) / 10),
      vpMorgenPct:   effVpMorgen,
      vpCostPct:     Math.round(effVpCost * 100) / 100,
      entryCount:    effectiveEntries.length,
      hasEdits,
      freeBudgetPct: freeBudget,
    });
  }, [overrides, plan]);

  function reset() {
    setPhase(plan ? "generated" : "idle");
    setConfirmed(false); setExecLog([]); setExecIndex(0); setAborted(false);
  }

  async function startExecution() {
    if (!confirmed || allPlanEntries.length === 0) return;
    setPhase("executing");
    setExecLog([]);
    setAborted(false);
    const log: VoteLogEntry[] = [];

    for (let i = 0; i < allPlanEntries.length; i++) {
      if (aborted) break;
      setExecIndex(i);
      const e = allPlanEntries[i];
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
              {plan?.report && <RecoveryBanner report={plan.report} />}

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
                    {addlPossible > 0 ? (
                      <button
                        type="button"
                        onClick={() => setAdditions(prev => {
                          const alreadyKeys = new Set([...prev, ...entries].map(x => `${x.author}/${x.permlink}`));
                          const toAdd = fittingCandidates.filter(c => !alreadyKeys.has(`${c.author}/${c.permlink}`));
                          return [...prev, ...toAdd];
                        })}
                        style={{ background: "#dbeafe", border: "1.5px solid #3b82f6", borderRadius: "8px", color: "#1d4ed8", cursor: "pointer", fontSize: "0.82rem", fontWeight: 700, padding: "0.25rem 0.75rem" }}
                      >
                        + {addlPossible} weitere Vote{addlPossible !== 1 ? "s" : ""} hinzufügen
                      </button>
                    ) : additions.length > 0 || props.additionalCandidates?.length === 0 ? null : (
                      <span style={{ color: "#94a3b8", fontSize: "0.78rem" }}>Keine weiteren passenden Kandidaten</span>
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
                  return (
                    <div key={key} style={{
                      background: isAdded ? "#f0fdf4" : isEdited ? "#f8faff" : "#ffffff",
                      border: `1px solid ${isAdded ? "#86efac" : isEdited ? "#93c5fd" : e.warning ? "#fde68a" : "#e5e7eb"}`,
                      borderLeft: `4px solid ${isAdded ? "#16a34a" : color}`,
                      borderRadius: "10px", padding: "0.65rem 0.85rem",
                      display: "flex", gap: "0.75rem", alignItems: "center",
                    }}>
                      {/* Score-Badge (hinzugefügte: grünes +) */}
                      <div style={{ flexShrink: 0, width: "40px", height: "40px", borderRadius: "9px", background: isAdded ? "#dcfce7" : scoreBg, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column" as const, position: "relative" as const }}>
                        {isAdded && <span style={{ position: "absolute" as const, top: "-5px", right: "-5px", background: "#16a34a", color: "#fff", borderRadius: "50%", width: "14px", height: "14px", fontSize: "0.65rem", fontWeight: 900, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>+</span>}
                        <span style={{ color: isAdded ? "#15803d" : scoreColor, fontSize: "0.95rem", fontWeight: 900, lineHeight: 1 }}>{e.postScore}</span>
                        <span style={{ color: isAdded ? "#15803d" : scoreColor, fontSize: "0.52rem", fontWeight: 700, opacity: 0.6 }}>score</span>
                      </div>

                      {/* Titel + Metadaten */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ color: "#111827", fontSize: "0.91rem", fontWeight: 700, margin: "0 0 0.18rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                          {e.title || `${e.author}/${e.permlink}`}
                          {isAdded && <span style={{ marginLeft: "0.5rem", background: "#dcfce7", color: "#15803d", borderRadius: "4px", padding: "0.05rem 0.35rem", fontSize: "0.65rem", fontWeight: 700 }}>hinzugefügt</span>}
                        </p>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.73rem", color: "#9ca3af" }}>
                          <span style={{ color: "#2563eb", fontWeight: 600 }}>@{e.author}</span>
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
                    </div>
                  );
                })}
              </div>

              <button
                style={{ background: "#d97706", border: "none", borderRadius: "10px", color: "#fff", cursor: "pointer", fontSize: "0.92rem", fontWeight: 800, padding: "0.65rem 1.4rem" }}
                type="button"
                onClick={() => { setPhase("confirming"); setConfirmed(false); }}
              >
                {allPlanEntries.length} Votes bestätigen →
              </button>
            </>
          )}
        </>
      )}

      {/* ── Phase: confirming ──────────────────────── */}
      {phase === "confirming" && plan && (
        <div style={{ background: "#ffffff", border: "1px solid #f0a500", borderRadius: "6px", padding: "1rem" }}>
          <p style={{ color: "#d97706", fontWeight: 700, margin: "0 0 0.75rem", fontSize: "0.9rem" }}>
            ⚠ Bestätigung erforderlich — {allPlanEntries.length} Votes werden sequenziell gesendet
          </p>

          <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", fontSize: "0.82rem", marginBottom: "0.75rem" }}>
            <span style={{ color: "#607078" }}>VP jetzt: <b style={{ color: "#17202a" }}>{plan.summary.currentVpPct.toFixed(1)}%</b></span>
            <span style={{ color: "#607078" }}>Verbrauch: <b style={{ color: "#17202a" }}>{plan.summary.estimatedVpSpendPct}%</b></span>
            <span style={{ color: "#607078" }}>VP danach: <b style={{ color: sustainColor }}>{plan.summary.estimatedVpAfterPct.toFixed(1)}%</b></span>
            <span style={{ color: sustainColor, fontWeight: 600 }}>
              {plan.summary.sustainability === "sustainable" ? "✓ Nachhaltig" : plan.summary.sustainability === "aggressive" ? "⚠ Aggressiv" : "🔴 Kritisch"}
            </span>
          </div>

          <div style={{ background: "#f0f5f7", borderRadius: "4px", padding: "0.5rem 0.75rem", marginBottom: "0.75rem", fontSize: "0.77rem", color: "#607078" }}>
            <b style={{ color: "#2d3a42" }}>Safeguards:</b> Bereits gevotete Posts werden übersprungen · Fehler stoppen die Ausführung · 1.5s Pause zwischen Votes
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.75rem", cursor: "pointer", fontSize: "0.82rem", color: "#2d3a42" }}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={e => setConfirmed(e.target.checked)}
              style={{ accentColor: "#d97706" }}
            />
            Ich habe den Plan überprüft und bestätige, dass diese {entries.length} Votes gesendet werden sollen.
          </label>

          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              style={{ ...chipBtn, background: confirmed ? "#f0a50022" : "#dde8ed", borderColor: confirmed ? "#d97706" : "#c5d3da", color: confirmed ? "#d97706" : "#8fa4b0", fontWeight: 600 }}
              type="button"
              disabled={!confirmed}
              onClick={() => void startExecution()}
            >
              Jetzt {allPlanEntries.length} Votes senden
            </button>
            <button style={chipBtn} type="button" onClick={reset}>Zurück</button>
          </div>
        </div>
      )}

      {/* ── Phase: executing ───────────────────────── */}
      {phase === "executing" && (
        <div style={{ background: "#ffffff", border: "1px solid #30363d", borderRadius: "6px", padding: "0.75rem 1rem" }}>
          <p style={{ color: "#2d3a42", fontWeight: 600, margin: "0 0 0.5rem" }}>
            Sende Votes... {execLog.length}/{entries.length}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem", fontFamily: "monospace", fontSize: "0.77rem" }}>
            {execLog.map((l, i) => (
              <div key={i} style={{ color: l.status === "sent" ? "#16a34a" : l.status === "skipped" ? "#607078" : "#dc2626" }}>
                {l.status === "sent" ? "✓" : l.status === "skipped" ? "⊘" : "✗"} @{l.author}/{l.permlink.slice(0, 30)} — {l.message}
              </div>
            ))}
            {execLog.length < entries.length && !aborted && (
              <div style={{ color: "#607078" }}>⏳ @{entries[execIndex]?.author ?? "..."}...</div>
            )}
            {aborted && <div style={{ color: "#dc2626" }}>⛔ Gestoppt wegen Fehler</div>}
          </div>
        </div>
      )}

      {/* ── Phase: done ────────────────────────────── */}
      {phase === "done" && (
        <div>
          <div style={{ padding: "0.6rem 0.75rem", background: "#f0f5f7", borderRadius: "5px", border: "1px solid #30363d", fontSize: "0.82rem", marginBottom: "0.5rem" }}>
            <b style={{ color: "#2d3a42" }}>Ergebnis:</b>
            {" "}<span style={{ color: "#16a34a" }}>{execLog.filter(l => l.status === "sent").length} gesendet</span>
            {execLog.filter(l => l.status === "skipped").length > 0 && <span style={{ color: "#607078", marginLeft: "0.75rem" }}>{execLog.filter(l => l.status === "skipped").length} übersprungen</span>}
            {execLog.filter(l => l.status === "failed").length > 0 && <span style={{ color: "#dc2626", marginLeft: "0.75rem" }}>{execLog.filter(l => l.status === "failed").length} fehlgeschlagen</span>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem", fontFamily: "monospace", fontSize: "0.75rem", marginBottom: "0.5rem", maxHeight: "200px", overflowY: "auto" }}>
            {execLog.map((l, i) => (
              <div key={i} style={{ color: l.status === "sent" ? "#16a34a" : l.status === "skipped" ? "#607078" : "#dc2626" }}>
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

  return (
    <div>
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
              {totalOpen === 1 ? "offener Vote" : totalOpen === 0 ? "✓ Alles gevoted" : "offene Votes"}
            </span>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginLeft: "auto" }}>
            <button
              style={{ background: "#f0f5f7", border: "1px solid #dde8ed", borderRadius: "7px", color: "#607078", cursor: "pointer", fontSize: "0.82rem", padding: "0.45rem 0.9rem", fontWeight: 600 }}
              type="button"
              disabled={props.loading}
              onClick={props.onRefresh}
            >
              {props.loading ? "Scannt..." : "↻ Aktualisieren"}
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
            <span>{props.meta.scannedAuthors}/{props.meta.requestedAuthors} Autoren · {props.meta.totalPosts} Posts · <b style={{ color: props.meta.eligiblePosts > 0 ? "#16a34a" : "#8fa4b0" }}>{props.meta.eligiblePosts} wählbar</b></span>
          </div>
          {/* Per-author breakdown — highlight authors with 0 posts */}
          {(() => {
            const noPost  = Object.entries(props.meta.perAuthor).filter(([, v]) => v.noRecentPosts).map(([k]) => k);
            const withPost = Object.entries(props.meta.perAuthor).filter(([, v]) => !v.noRecentPosts && v.eligible > 0).map(([k]) => k);
            return (
              <>
                {withPost.length > 0 && (
                  <div style={{ color: "#16a34a", fontSize: "0.72rem" }}>
                    ✓ Mit offenen Posts: {withPost.join(", ")}
                  </div>
                )}
                {noPost.length > 0 && (
                  <div style={{ color: "#8fa4b0", fontSize: "0.72rem", marginTop: "0.15rem" }}>
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
        <span style={{ color: "#888" }}>STEEM {props.snapshot.sbdPerSteem.toFixed(4)} SBD (Chain-Median)</span>
      </div>
    </section>
  );
}

// ── Timezone list — curated IANA names with friendly labels ──────────────────

const TIMEZONES: Array<{ value: string; label: string }> = [
  { value: "Europe/Berlin",     label: "Europa/Berlin (MEZ/MESZ)" },
  { value: "Europe/London",     label: "Europa/London (GMT/BST)" },
  { value: "Europe/Paris",      label: "Europa/Paris" },
  { value: "Europe/Vienna",     label: "Europa/Wien" },
  { value: "Europe/Zurich",     label: "Europa/Zürich" },
  { value: "Europe/Amsterdam",  label: "Europa/Amsterdam" },
  { value: "Europe/Warsaw",     label: "Europa/Warschau" },
  { value: "Europe/Stockholm",  label: "Europa/Stockholm" },
  { value: "Europe/Moscow",     label: "Europa/Moskau" },
  { value: "Asia/Dubai",        label: "Asien/Dubai (GST)" },
  { value: "Asia/Kolkata",      label: "Asien/Kolkata (IST)" },
  { value: "Asia/Singapore",    label: "Asien/Singapur (SGT)" },
  { value: "Asia/Tokyo",        label: "Asien/Tokio (JST)" },
  { value: "Asia/Seoul",        label: "Asien/Seoul (KST)" },
  { value: "Asia/Shanghai",     label: "Asien/Shanghai (CST)" },
  { value: "Australia/Sydney",  label: "Australien/Sydney (AEDT)" },
  { value: "Pacific/Auckland",  label: "Pazifik/Auckland (NZST)" },
  { value: "UTC",               label: "UTC / Greenwich" },
  { value: "America/Sao_Paulo", label: "Amerika/São Paulo (BRT)" },
  { value: "America/New_York",  label: "Amerika/New York (ET)" },
  { value: "America/Chicago",   label: "Amerika/Chicago (CT)" },
  { value: "America/Denver",    label: "Amerika/Denver (MT)" },
  { value: "America/Los_Angeles", label: "Amerika/Los Angeles (PT)" },
];

function TimezoneSettings({ locale, timezone, onLocaleChange, onTimezoneChange, t }: {
  locale: Locale;
  timezone: string;
  onLocaleChange: (l: Locale) => void;
  onTimezoneChange: (tz: string) => void;
  t: ReturnType<typeof createTranslator>;
}) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const localTime = now.toLocaleTimeString(locale === "de" ? "de-DE" : "en-GB", {
    timeZone: timezone, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const localDate = now.toLocaleDateString(locale === "de" ? "de-DE" : "en-GB", {
    timeZone: timezone, weekday: "long", day: "numeric", month: "long",
  });

  // Ensure selected timezone is in the list; add it if not
  const inList = TIMEZONES.some(z => z.value === timezone);
  const options = inList
    ? TIMEZONES
    : [{ value: timezone, label: `${timezone} (Browser)` }, ...TIMEZONES];

  const panelStyle: React.CSSProperties = {
    background: "#ffffff", border: "1px solid #e5e7eb", borderRadius: "12px",
    padding: "1.25rem 1.5rem", marginBottom: "1rem",
  };
  const lbl: React.CSSProperties = {
    fontSize: "0.75rem", fontWeight: 600, color: "#6b7280",
    textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "0.5rem",
  };
  const sel: React.CSSProperties = {
    background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: "8px",
    color: "#111827", cursor: "pointer", fontSize: "0.88rem",
    padding: "0.5rem 0.75rem", width: "100%",
  };

  return (
    <div style={{ maxWidth: "520px", padding: "1.25rem 1.5rem" }}>
      <h2 style={{ fontSize: "1rem", fontWeight: 700, color: "#111827", margin: "0 0 1.25rem" }}>
        ⚙ Einstellungen
      </h2>

      {/* Sprache */}
      <div style={panelStyle}>
        <p style={lbl}>Sprache</p>
        <select style={sel} value={locale}
          onChange={e => onLocaleChange(e.target.value as Locale)}>
          {locales.map(l => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
      </div>

      {/* Zeitzone */}
      <div style={panelStyle}>
        <p style={lbl}>Zeitzone</p>
        <select style={sel} value={timezone}
          onChange={e => onTimezoneChange(e.target.value)}>
          {options.map(z => (
            <option key={z.value} value={z.value}>{z.label}</option>
          ))}
        </select>

        {/* Live-Uhr */}
        <div style={{
          marginTop: "0.85rem", background: "#f0fdf4", border: "1px solid #bbf7d0",
          borderRadius: "8px", padding: "0.65rem 0.9rem",
          display: "flex", alignItems: "center", gap: "0.75rem",
        }}>
          <span style={{ fontSize: "1.2rem" }}>🕒</span>
          <div>
            <div style={{ fontSize: "1.4rem", fontWeight: 800, color: "#15803d",
              letterSpacing: "-0.5px", fontVariantNumeric: "tabular-nums" }}>
              {localTime}
            </div>
            <div style={{ fontSize: "0.73rem", color: "#6b7280", marginTop: "0.1rem" }}>
              {localDate} · {timezone}
            </div>
          </div>
        </div>

        <p style={{ fontSize: "0.72rem", color: "#9ca3af", margin: "0.6rem 0 0" }}>
          Alle Daten werden intern in UTC gespeichert. Die Zeitzone beeinflusst nur die Darstellung.
        </p>
      </div>
    </div>
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

    </section>
  );
}

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

function AuthorCard({ card, onAdd }: {
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
          <div key={i} style={{ fontSize: "0.73rem", color: CD.dim, display: "flex", alignItems: "center", gap: "0.3rem" }}>
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

function CommunityDiscoverySection({ discovery, loading, onAddToStrategy }: {
  discovery: CommunityDiscovery | null;
  loading: boolean;
  onAddToStrategy: (username: string, category: StrategyCategory) => void;
}) {
  const hdr: React.CSSProperties = {
    fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase",
    letterSpacing: "0.06em", color: CD.dim, marginBottom: "0.6rem",
  };

  if (loading) {
    return (
      <div style={{ padding: "3rem", textAlign: "center", color: CD.dim, fontSize: "0.88rem" }}>
        Autor-Radar wird geladen…
      </div>
    );
  }

  if (!discovery) {
    return (
      <div style={{ padding: "3rem", textAlign: "center", color: CD.dim, fontSize: "0.88rem" }}>
        Community-Daten konnten nicht geladen werden.
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
            Entdecken · Autor-Radar
          </h2>
          <span style={{ fontSize: "0.75rem", color: CD.dim }}>
            {meta.totalCurators} {meta.totalCurators === 1 ? "Kurator" : "Kuratoren"} aktiv · {meta.myAuthorCount} in deiner Strategie
          </span>
        </div>
        {meta.notice && (
          <div style={{
            marginTop: "0.6rem", padding: "0.5rem 0.75rem",
            background: "#fef9c3", border: "1px solid #fde047",
            borderRadius: "8px", fontSize: "0.78rem", color: "#713f12",
          }}>
            {meta.notice}
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
          Noch nicht genug Community-Daten vorhanden.<br />
          <span style={{ fontSize: "0.78rem" }}>
            Sobald weitere Nutzer ihre Strategie in VoteBroker pflegen, erscheinen hier gemeinsam unterstützte Autoren.
          </span>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", alignItems: "start" }}>

          {/* Left: Community Authors (≥2 strategies) */}
          <div>
            <div style={hdr}>
              VoteBroker-Gemeinschaft
              {communityAuthors.length > 0 && (
                <span style={{ color: CD.ok, marginLeft: "0.4rem" }}>· {communityAuthors.length}</span>
              )}
            </div>
            <p style={{ fontSize: "0.75rem", color: CD.faint, marginBottom: "0.75rem", marginTop: 0 }}>
              Autoren, die mehrere Kuratoren gemeinsam unterstützen.
            </p>
            {communityAuthors.length === 0 ? (
              <div style={{ padding: "1.5rem", background: CD.tag, borderRadius: "10px", textAlign: "center", color: CD.dim, fontSize: "0.8rem" }}>
                Noch keine Autoren von mehreren Kuratoren gleichzeitig unterstützt.
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
              Entdeckungen für dich
              {discoveries.length > 0 && (
                <span style={{ color: CD.info, marginLeft: "0.4rem" }}>· {discoveries.length}</span>
              )}
            </div>
            <p style={{ fontSize: "0.75rem", color: CD.faint, marginBottom: "0.75rem", marginTop: 0 }}>
              Autoren aus anderen Strategien, die noch nicht in deiner Strategie sind.
            </p>
            {discoveries.length === 0 ? (
              <div style={{ padding: "1.5rem", background: CD.tag, borderRadius: "10px", textAlign: "center", color: CD.dim, fontSize: "0.8rem" }}>
                Alle bekannten Autoren sind bereits in deiner Strategie.
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
        Stand: {new Date(discovery.computedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr
        {" · "}Ähnliche Autoren (basierend auf Tags/Communities) — in Entwicklung
      </div>
    </div>
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
