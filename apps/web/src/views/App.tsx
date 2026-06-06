// ── Steem Keychain type declaration ──────────────────────────────────────────
type KeychainResponse = { success: boolean; result?: string; error?: string; message?: string; publicKey?: string };
type KeychainBroadcastResponse = { success: boolean; result?: { id: string }; error?: string; message?: string };

declare global {
  interface Window {
    steem_keychain?: {
      requestHandshake: (callback: () => void) => void;
      requestBroadcast: (
        username: string,
        operations: unknown[],
        authority: "Posting" | "Active",
        callback: (response: KeychainBroadcastResponse) => void
      ) => void;
      requestAddAccountAuthority: (
        username: string,
        authorizedUsername: string,
        role: "Posting" | "Active" | "Memo",
        weight: number,
        callback: (response: KeychainResponse) => void
      ) => void;
      requestSignBuffer: (
        username: string | null,
        message: string,
        method: "Posting" | "Active" | "Memo",
        callback: (response: KeychainResponse) => void,
        rpc?: string | null,
        title?: string | null
      ) => void;
    };
  }
}

import { AdminDashboard, isAdmin } from "./AdminDashboard";
import { UserDashboard, type RecentVote } from "./UserDashboard";
import {
  AlertTriangle,
  BadgeDollarSign,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  Circle,
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
import React, { FormEvent, useEffect, useMemo, useRef, useState } from "react";
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
  getKeychainChallenge,
  verifyKeychainLogin,
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
  type WhaleSignalsData,
  type WhaleSignalEntry,
  fetchWhaleSignals,
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
import { createTranslator, locales, type Locale, type TranslationKey } from "../i18n";
import {
  type StrategyCategory,
  type StrategyRule,
  categoryLabel,
  categoryColor,
  dnaEmoji,
  computeDynamicWeights,
  generateStrategyFromProfile,
} from "./strategyTypes";
import {
  ConsentPanel,
  AuthBar,
  TimezoneSettings,
  AuthorityPanel,
} from "./SettingsView";
import {
  AuthorCard,
  WhaleSignalSection,
  CommunityDiscoverySection,
  SummaryCard,
} from "./CommunityView";
import {
  type VoteBatchResult,
  type VoteTarget,
  type LivePlanMetrics,
  VotePlanSection,
  OpenVoteOpportunities,
} from "./VotePlanView";

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

function voteErrorMessage(err: unknown, locale?: import("../i18n").Locale): { message: string; code: string; hint?: string } {
  const t = createTranslator(locale ?? "de");
  if (err instanceof VoteBroadcastError) {
    const hints: Record<string, string> = {
      session_expired:              "Bitte oben rechts abmelden und erneut mit SteemConnect einloggen.",
      target_vote_consent_required: t("hintOpenSettings"),
      missing_posting_authority:    t("hintGrantAuthority"),
      missing_posting_wif:          "Serverseitiges Voting nicht verfügbar. Bitte Betreiber kontaktieren.",
      account_paused:               t("hintAccountPaused"),
      keychain_rejected:            "Keychain hat den Vote abgelehnt oder der Dialog wurde geschlossen.",
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
  const [whaleSignals, setWhaleSignals] = useState<WhaleSignalsData | null>(null);
  const [whaleSignalsLoading, setWhaleSignalsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [consentLoading, setConsentLoading] = useState<ConsentType | null>(null);
  const [hasAuthority, setHasAuthority] = useState<boolean | null>(null);
  const [authorityGrantUrl, setAuthorityGrantUrl] = useState("");
  const [keychainAvailable, setKeychainAvailable] = useState<boolean | null>(null);
  const [keychainUsername, setKeychainUsername] = useState("");
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
  const [voteExecutionCount, setVoteExecutionCount] = useState(0); // uncapped, increments per vote
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

  // ── Steem Keychain detection (once on mount) ────────────────────────────
  useEffect(() => {
    const kc = window.steem_keychain;
    // Require requestBroadcast to exist — filters out outdated versions (steempro pattern)
    if (!kc || typeof kc !== "object" || typeof kc.requestBroadcast !== "function") {
      setKeychainAvailable(false);
      return;
    }
    const timeout = setTimeout(() => setKeychainAvailable(false), 2000);
    kc.requestHandshake(() => {
      clearTimeout(timeout);
      setKeychainAvailable(true);
    });
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

  // Lazy-load community discovery + whale signals when community tab opens
  useEffect(() => {
    if (activeTab !== "community" || !session) return;
    if (!communityDiscovery && !communityDiscoveryLoading) {
      setCommunityDiscoveryLoading(true);
      fetchCommunityDiscovery(session.token)
        .then(setCommunityDiscovery)
        .catch(() => setCommunityDiscovery(null))
        .finally(() => setCommunityDiscoveryLoading(false));
    }
    if (!whaleSignals && !whaleSignalsLoading) {
      setWhaleSignalsLoading(true);
      fetchWhaleSignals(session.token)
        .then(setWhaleSignals)
        .catch(() => setWhaleSignals(null))
        .finally(() => setWhaleSignalsLoading(false));
    }
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

  function refreshAuthority() {
    if (!session) return;
    setHasAuthority(null);
    checkPostingAuthority(session.user.username)
      .then(setHasAuthority)
      .catch(() => setHasAuthority(false));
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
    // Dust floors per category — must match server-side CATEGORY_DUST_BPS
    const dustFloor: Record<StrategyCategory, number> = {
      immer_voten: 50, lieblingsautor: 30, bevorzugt: 15,
      normal: 10, niedrig: 5, ignorieren: 0,
    };
    const maxFor: Record<StrategyCategory, number> = {
      immer_voten:    Math.min(100, Math.max(dustFloor.immer_voten,    Math.round(base * 3))),
      lieblingsautor: Math.min(100, Math.max(dustFloor.lieblingsautor, Math.round(base * 2.5))),
      bevorzugt:      Math.min(100, Math.max(dustFloor.bevorzugt,      Math.round(base * 1.5))),
      normal:         Math.min(100, Math.max(dustFloor.normal,         Math.round(base))),
      niedrig:        Math.min(100, Math.max(dustFloor.niedrig,        Math.round(base * 0.4))),
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

  // ── Single vote: Keychain if available, server as fallback ─────────────────
  async function doVote(target: { author: string; permlink: string; weightBps: number }): Promise<{ transactionId: string }> {
    if (!session) throw new VoteBroadcastError("session_expired", "Session abgelaufen.");

    if (keychainAvailable && window.steem_keychain) {
      const voteOp = ["vote", {
        voter:    session.user.username,
        author:   target.author,
        permlink: target.permlink,
        weight:   target.weightBps
      }];
      return new Promise((resolve, reject) => {
        window.steem_keychain!.requestBroadcast(
          session!.user.username,
          [voteOp],
          "Posting",
          (response) => {
            if (!response.success) {
              reject(new VoteBroadcastError("keychain_rejected",
                response.error ?? response.message ?? "Keychain hat den Vote abgelehnt."));
              return;
            }
            const txId = response.result?.id ?? "keychain_tx";
            // Audit log via backend — fire and forget
            executeVote(session!.token, {
              author: target.author, permlink: target.permlink,
              weightBps: target.weightBps, broadcastMode: "keychain", transactionId: txId
            }).catch(() => {});
            resolve({ transactionId: txId });
          }
        );
      });
    }

    // Fallback: server-side vote
    const res = await executeVote(session.token, {
      author: target.author, permlink: target.permlink, weightBps: target.weightBps
    });
    return { transactionId: res.transactionId };
  }

  async function executeStrategyVotes(
    targets: Array<{ author: string; permlink: string; weightBps: number }>
  ): Promise<VoteBatchResult> {
    if (!session) return { ok: 0, failed: 0, skipped: 0, results: [] };
    let ok = 0, failed = 0, skipped = 0;
    const results: VoteBatchResult["results"] = [];

    for (const target of targets) {
      try {
        const res = await doVote(target);
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
        setVoteExecutionCount(n => n + 1);
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
    const result = await doVote(target); // Keychain if available, server fallback
    // Track in dashboard recent votes
    setRecentVotes(prev => [{
      author:    target.author,
      permlink:  target.permlink,
      title:     "",
      weightPct: Math.round(target.weightBps / 100 * 10) / 10,
      votedAt:   new Date().toISOString(),
    }, ...prev].slice(0, 20));
    setVoteExecutionCount(n => n + 1);
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

  async function connectKeychain() {
    const username = keychainUsername.replace(/^@/, "").toLowerCase().trim();
    if (!username || !window.steem_keychain) return;
    setAuthLoading(true);
    setAuthError(null);
    try {
      const { nonce } = await getKeychainChallenge();
      const { signature, publicKey } = await new Promise<{ signature: string; publicKey: string }>((resolve, reject) => {
        window.steem_keychain!.requestSignBuffer(
          username,
          nonce,
          "Posting",
          (resp) => {
            if (resp.success && resp.result)
              resolve({ signature: resp.result, publicKey: resp.publicKey ?? "" });
            else
              reject(new Error(resp.error ?? resp.message ?? "Keychain signing abgebrochen."));
          },
          null,
          "VoteBroker Login"
        );
      });
      const nextSession = await verifyKeychainLogin({ username, nonce, signature, publicKey });
      setSession(nextSession);
      setUsername(nextSession.user.username);
      window.localStorage.setItem("votebroker.session", JSON.stringify(nextSession));
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Keychain-Login fehlgeschlagen.");
    } finally {
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
      const parsed = voteErrorMessage(err, locale);
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
        title: t("featureAuthorsTitle"),
        desc: t("featureDesc"),
      },
      {
        icon: "⚡",
        title: t("featureVpTitle"),
        desc: t("featureDesc"),
      },
      {
        icon: "🔒",
        title: t("featureControlTitle"),
        desc: t("featureDesc"),
      },
    ];
    return (
      <main className="shell" style={{ minHeight: "100vh", background: "#ffffff" }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "1rem 1.5rem", borderBottom: "1px solid #21262d" }}>
          <img src="/assets/branding/logo/logo-light.svg" alt="VoteBroker" height={40} style={{ display: "block", maxWidth: 160 }} />
          <label className="language-select">
            <span>{t("language")}</span>
            <select value={locale} onChange={(event) => changeLocale(event.target.value as Locale)}>
              {(() => {
                const groups: Array<{ label: string; items: typeof locales }> = [];
                let current: typeof locales = [];
                let gLabel = "🌍 Europa / América / Africa";
                for (const l of locales) {
                  if (l.separator && current.length > 0) {
                    groups.push({ label: gLabel, items: current });
                    current = [l];
                    gLabel = groups.length === 1 ? "🌏 Asia" : "🌐 Europa Wschodnia / СНГ";
                  } else {
                    current.push(l);
                  }
                }
                if (current.length > 0) groups.push({ label: gLabel, items: current });
                return groups.map(g => (
                  <optgroup key={g.label} label={g.label}>
                    {g.items.map(item => (
                      <option key={item.code} value={item.code}>{item.label}</option>
                    ))}
                  </optgroup>
                ));
              })()}
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

          {/* CTA — Keychain if available, SteemLogin as fallback */}
          {keychainAvailable && (
            <div style={{ marginBottom: "0.75rem" }}>
              <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
                <input
                  type="text"
                  placeholder={t("loginUsernamePlaceholder")}
                  value={keychainUsername}
                  onChange={e => setKeychainUsername(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && connectKeychain()}
                  disabled={authLoading}
                  style={{ flex: 1, background: "#f8fbfc", border: "1px solid #dde8ed", borderRadius: "8px", color: "#17202a", fontSize: "0.95rem", padding: "0.75rem 1rem" }}
                />
                <button
                  className="secondary-button"
                  disabled={authLoading || !keychainUsername.trim()}
                  type="button"
                  onClick={connectKeychain}
                  style={{ padding: "0.75rem 1.25rem", fontSize: "0.95rem", fontWeight: 700, borderRadius: "8px", whiteSpace: "nowrap" }}
                >
                  <ShieldCheck size={18} />
                  {authLoading ? t("loginKeychainSigning") : t("loginWithKeychain")}
                </button>
              </div>
              <p style={{ color: "#16a34a", fontSize: "0.73rem", margin: 0, textAlign: "center" }}>
                ✓ {t("loginKeychainHint")}
              </p>
            </div>
          )}

          {keychainAvailable && (
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", margin: "0.75rem 0" }}>
              <hr style={{ flex: 1, border: "none", borderTop: "1px solid #dde8ed" }} />
              <span style={{ color: "#8fa4b0", fontSize: "0.75rem" }}>{t("loginOrSeparator")}</span>
              <hr style={{ flex: 1, border: "none", borderTop: "1px solid #dde8ed" }} />
            </div>
          )}

          <button
            className="secondary-button"
            disabled={authLoading}
            style={{ width: "100%", justifyContent: "center", padding: "0.85rem 1.5rem", fontSize: keychainAvailable ? "0.9rem" : "1rem", fontWeight: 700, borderRadius: "8px", opacity: keychainAvailable ? 0.8 : 1 }}
            type="button"
            onClick={connectSteem}
          >
            <ShieldCheck size={18} />
            {authLoading ? t("connecting") : t("loginWithSteemLogin")}
          </button>

          <p style={{ color: "#8fa4b0", fontSize: "0.73rem", marginTop: "0.85rem", textAlign: "center", lineHeight: 1.6 }}>
            {t("loginSteemLoginHint")}
          </p>
        </div>
      </main>
    );
  }

  // ── POST-LOGIN: Tabbed layout ─────────────────────────────────────────────
  return (
    <main className="shell">

      {/* Compact topbar */}
      <header data-testid="app-ready" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.75rem 1.5rem", borderBottom: "1px solid #21262d", background: "#ffffff", flexWrap: "wrap", gap: "0.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <img src="/assets/branding/logo/logo-light.svg" alt="VoteBroker" height={36} style={{ display: "block", maxWidth: 148 }} />
          {accountSnapshot ? (
            <span style={{ color: "#607078", fontSize: "0.82rem" }}>
              @{accountSnapshot.username} · <b style={{ color: "#17202a" }}>{accountSnapshot.steemPowerSp.toFixed(0)} SP</b> · <b style={{ color: "#17202a" }}>{(accountSnapshot.votingPowerBps / 100).toFixed(1)}%</b> VP · ~<b style={{ color: "#17202a" }}>${accountSnapshot.currentVoteUsd.toFixed(4)}</b>
            </span>
          ) : (
            <span style={{ color: "#607078", fontSize: "0.82rem" }}>@{session.user.username}</span>
          )}
          {hasAuthority === false && (
            keychainAvailable
              ? <button
                  type="button"
                  onClick={() => {
                    window.steem_keychain!.requestAddAccountAuthority(
                      session.user.username, "votebroker", "Posting", 1,
                      (resp) => { if (resp.success) refreshAuthority(); }
                    );
                  }}
                  style={{ background: "none", cursor: "pointer", color: "#f0883e", fontSize: "0.78rem", textDecoration: "none", border: "1px solid #f0883e", padding: "0.15rem 0.5rem", borderRadius: "4px" }}
                >
                  ⚡ {t("consentGrantAuthority")}
                </button>
              : <a href={authorityGrantUrl} style={{ color: "#f0883e", fontSize: "0.78rem", textDecoration: "none", border: "1px solid #f0883e", padding: "0.15rem 0.5rem", borderRadius: "4px" }}>
              ⚠ {t("consentGrantAuthority")}
            </a>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <label className="language-select">
            <span>{t("language")}</span>
            <select value={locale} onChange={(event) => changeLocale(event.target.value as Locale)}>
              {(() => {
                const groups: Array<{ label: string; items: typeof locales }> = [];
                let current: typeof locales = [];
                let gLabel = "🌍 Europa / América / Africa";
                for (const l of locales) {
                  if (l.separator && current.length > 0) {
                    groups.push({ label: gLabel, items: current });
                    current = [l];
                    gLabel = groups.length === 1 ? "🌏 Asia" : "🌐 Europa Wschodnia / СНГ";
                  } else {
                    current.push(l);
                  }
                }
                if (current.length > 0) groups.push({ label: gLabel, items: current });
                return groups.map(g => (
                  <optgroup key={g.label} label={g.label}>
                    {g.items.map(item => (
                      <option key={item.code} value={item.code}>{item.label}</option>
                    ))}
                  </optgroup>
                ));
              })()}
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
            dna: t("tabDna"),
            dashboard: t("tabDashboard"),
            community: t("tabCommunity"),
            billing: t("tabSettings"),
          };
          return (
            <button
              key={tab}
              type="button"
              data-testid={`tab-${tab}`}
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
            locale={locale}
            onNavigate={setActiveTab}
          />
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
          voteExecutionCount={voteExecutionCount}
          onTabChange={setActiveTab}
          onGenerateVotes={generateVotes}
          onLoadOpportunities={loadOpportunities}
          onRefreshSnapshot={refreshSnapshot}
        />
      )}

      {/* Tab: Community — Zwei-Spalten-Layout */}
      {activeTab === "community" && (
        <div style={{ padding: "1.25rem 1.5rem" }}>
          <div style={{ display: "grid", gridTemplateColumns: "3fr 2fr", gap: "2rem", alignItems: "start" }}>
            {/* Linke Spalte: Whale Discovery */}
            <WhaleSignalSection
              data={whaleSignals}
              loading={whaleSignalsLoading}
              onAddToStrategy={addAuthorToStrategy}
              t={t}
            />
            {/* Rechte Spalte: Community Discovery */}
            <CommunityDiscoverySection
              discovery={communityDiscovery}
              loading={communityDiscoveryLoading}
              onAddToStrategy={addAuthorToStrategy}
              locale={locale}
            />
          </div>
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
          <AuthorityPanel
            grantUrl={authorityGrantUrl}
            hasAuthority={hasAuthority}
            session={session}
            locale={locale}
            keychainAvailable={keychainAvailable}
            onKeychainGrant={refreshAuthority}
          />
          <ConsentPanel
            catalog={consentCatalog}
            consentError={consentError}
            loadingType={consentLoading}
            onGrant={(type) => updateConsent(type, "grant")}
            onRevoke={(type) => updateConsent(type, "revoke")}
            session={session}
            state={consentState}
            t={t}
            locale={locale}
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
  locale?: import("../i18n").Locale;
}) {
  const t = createTranslator(props.locale ?? "de");
  const errorActionLink: Record<string, { label: string; tab: string }> = {
    target_vote_consent_required: { label: t("consentOpenSettings"), tab: "billing" },
    missing_posting_authority:    { label: t("consentGrantAuthority"), tab: "billing" },
  };

  return (
    <section className="execution-panel">
      <div>
        <span>Live Vote Broadcast</span>
        <strong>{props.hasSession ? t("consentReadyRequired") : t("consentLoginRequired")}</strong>
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
              {t("hintGoToSettings")}
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
      <div style={{ maxWidth: "860px", margin: "0 auto" }}>
        {/* Onboarding Start-Box */}
        <div style={{ background: "linear-gradient(135deg, #f0f9ff 0%, #f8fbfc 100%)", border: "1px solid #bae6fd", borderRadius: "12px", padding: "1.5rem", marginBottom: "1.5rem" }}>
          <div style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>👋</div>
          <strong style={{ color: "#0369a1", fontSize: "1rem", display: "block", marginBottom: "0.4rem" }}>
            Willkommen bei VoteBroker
          </strong>
          <p style={{ color: "#607078", fontSize: "0.85rem", margin: "0 0 1rem", lineHeight: 1.6 }}>
            Noch keine Vote-Historie gefunden. Füge Autoren hinzu, die du regelmäßig unterstützen möchtest — VoteBroker erstellt daraus deine Strategie.
          </p>
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" as const }}>
            {props.onNavigate && (
              <button
                type="button"
                onClick={() => props.onNavigate!("community")}
                style={{ background: "#0369a1", border: "none", borderRadius: "8px", color: "#fff", cursor: "pointer", fontSize: "0.85rem", fontWeight: 700, padding: "0.55rem 1.1rem" }}
              >
                🔍 Community-Tab: Autoren entdecken →
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

  // Map DNA descriptions from English (domain package) → current locale
  const dnaDescMap: Record<string, TranslationKey> = {
    "A significant portion of votes go to own posts":         "dnaDescSelfVoter",
    "Strong loyalty to a small group":                        "dnaDescLoyalInner",
    "Regular support for a core set":                         "dnaDescRegular",
    "Wide discovery across many authors":                     "dnaDescBroad",
    "Varied vote weights suggest deliberate":                  "dnaDescStrategic",
    "Active curator with high daily vote frequency":           "dnaDescHighFreq",
    "Focused on a small niche":                               "dnaDescNiche",
    "Balanced curation pattern":                              "dnaDescBalanced",
    "No votes found in the analyzed period":                  "dnaDescNone",
  };
  const dnaDescKey = Object.keys(dnaDescMap).find(k => p.dnaDescription?.startsWith(k));
  const translatedDesc = dnaDescKey ? t(dnaDescMap[dnaDescKey]) : p.dnaDescription;

  const heroStats = [
    { val: p.votesAnalyzed.toLocaleString(), lbl: t("kpiVotesCast")  },
    { val: p.uniqueAuthors,                  lbl: t("kpiAuthors")    },
    ...(vpPct !== null ? [{ val: `${vpPct.toFixed(1)}%`, lbl: "VP" }] : []),
    { val: p.periodDays,                     lbl: t("growthActiveDays") },
  ];

  return (
    <section style={{ padding: "1.5rem 2rem", display: "flex", flexDirection: "column" as const, gap: "1.25rem" }}>

      {/* ── 1. Hero ── */}
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", padding: "1rem 1.25rem", background: "linear-gradient(135deg, #f5f0ff 0%, #ffffff 60%, #edfbf9 100%)", borderRadius: "12px", border: "1px solid #e0d4fc", marginBottom: "1.25rem", flexWrap: "wrap" as const }}>
        <span style={{ fontSize: "2rem", lineHeight: 1, flexShrink: 0 }}>{emoji}</span>
        <div style={{ flex: 1, minWidth: "200px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.15rem" }}>
            <span style={{ color: "#7c3aed", fontWeight: 800, fontSize: "1rem" }}>
                {(() => {
                  const labelKeyMap: Record<string, TranslationKey> = {
                    "Regular Curator": "dnaRegularCurator", "Broad Explorer": "dnaBroadExplorer",
                    "Loyal Community Curator": "dnaLoyalCommunity", "Loyal Inner Circle": "dnaLoyalInner",
                    "High-Frequency Curator": "dnaHighFreq", "Niche Specialist": "dnaNiche",
                    "Self-Focused Voter": "dnaLabelSelfVoter", "Strategic Weight Voter": "dnaStrategicWeight",
                  };
                  const key = labelKeyMap[p.dnaLabel];
                  return key ? t(key) : p.dnaLabel;
                })()}
              </span>
            <span style={{ color: "#8fa4b0", fontSize: "0.72rem" }}>· {t("dnaCuratorType")}</span>
          </div>
          <p style={{ color: "#607078", fontSize: "0.78rem", margin: 0, lineHeight: 1.45, maxWidth: "520px" }}>{translatedDesc}</p>
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
                  <p style={{ color: "#0369a1", fontSize: "0.68rem", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "1.2px", margin: "0 0 0.3rem" }}>{t("dnaCuratorType")}</p>
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

