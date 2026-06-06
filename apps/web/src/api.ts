export interface VoteQuoteResponse {
  account: {
    username: string;
    votingPowerBps: number;
    fullPowerVoteUsd: number;
    status: "active" | "warning" | "paused" | "payment_required";
    consecutiveUnderfundedFees: number;
  };
  quote: {
    author: string;
    permlink: string;
    desiredVoteUsd: number;
    expectedVoteUsd: number;
    voteWeightBps: number;
    capped: boolean;
    warnings: string[];
    timing: {
      mode: "manual" | "auto";
      selectedDelayMinutes: number;
      scheduledAt: string | null;
      confidencePct: number;
      score: number;
      rationale: string[];
      options: Array<{
        delayMinutes: number;
        score: number;
        confidencePct: number;
        expectedCurationPct: number;
        riskPct: number;
        label: string;
      }>;
    };
    powerRecommendation: {
      plannedVotesToday: number;
      targetVotingPowerBps: number;
      estimatedRegenerationBps: number;
      dailyPowerBudgetBps: number;
      maxAverageVoteWeightBps: number;
      desiredVoteWeightBps: number;
      riskLevel: "low" | "medium" | "high" | "recovery";
      withinRecommendation: boolean;
      message: string;
      detail: string;
    };
  };
  feeInvoice: {
    id: string;
    amountUsd: number;
    feePostAuthor: string;
    feePostPermlink: string;
    requiredVoteWeightBps: number;
    status: "open" | "settled" | "underfunded" | "waived" | "donation_optional";
    billingMode: "free" | "donation" | "billable" | "grace" | "paused";
    transparency: {
      headline: string;
      detail: string;
      userMessage: string;
      donationAllowed: boolean;
      feeRequired: boolean;
      reasons: string[];
    };
  };
  feePolicy: {
    feeBps: number;
    minFeeUsd: number;
  };
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export type PoolRole = "owner" | "admin" | "curator" | "member";
export type PoolMembershipStatus = "active" | "limited" | "paused";

export interface CommunityPoolOverview {
  pool: {
    id: string;
    name: string;
    slug: string;
    description: string;
    members: Array<{
      username: string;
      role: PoolRole;
      delegatedSp: number;
      votingPowerBps: number;
      consentActive: boolean;
      feeReliabilityPct: number;
      executionReliabilityPct: number;
      status: PoolMembershipStatus;
    }>;
    policy: {
      maxVoteUsdPerPost: number;
      dailyVoteBudgetUsd: number;
      minVotingPowerBps: number;
      feeBps: number;
      requireFeePostConsent: boolean;
      requirePoolConsent: boolean;
      allowedTags: string[];
      blockedAuthors: string[];
    };
    stats: {
      poolPowerSp: number;
      activeMembers: number;
      curatedUsd30d: number;
      feesUsd30d: number;
      pendingFeesUsd: number;
      scheduledVotesUsd: number;
      executionRatePct: number;
      fairnessPct: number;
    };
  };
  health: {
    username: string;
    score: number;
    status: "excellent" | "healthy" | "watch" | "blocked";
    summary: string;
    factors: Array<{
      key: string;
      label: string;
      score: number;
      weight: number;
      detail: string;
    }>;
    recommendations: string[];
  };
}

export interface OperatorOverview {
  generatedAt: string;
  revenue: {
    settledFeeUsd: number;
    pendingFeeUsd: number;
    underfundedFeeUsd: number;
    waivedFeeUsd: number;
    donationValueUsd: number;
    donationOpportunityUsd: number;
    curationMovedUsd: number;
    feeCoveragePct: number;
  };
  invoices: {
    total: number;
    settled: number;
    open: number;
    underfunded: number;
    waived: number;
    donationOptional: number;
  };
  accounts: {
    total: number;
    active: number;
    warning: number;
    paused: number;
    paymentRequired: number;
  };
  billingModes: Record<"free" | "donation" | "billable" | "grace" | "paused", number>;
  topAccounts: Array<{
    username: string;
    settledFeeUsd: number;
    pendingFeeUsd: number;
    waivedFeeUsd: number;
    invoiceCount: number;
  }>;
  recentInvoices: Array<{
    id: string;
    username: string;
    sourceAuthor: string;
    sourcePermlink: string;
    sourceExpectedVoteUsd: number;
    nominalFeeUsd: number;
    amountUsd: number;
    requiredVoteWeightBps: number;
    status: "open" | "settled" | "underfunded" | "waived" | "donation_optional";
    billingMode: "free" | "donation" | "billable" | "grace" | "paused";
    createdAt: string;
  }>;
}

export interface AuthSession {
  token: string;
  expiry: string;
  user: {
    username: string;
    provider: "steemconnect";
  };
}

export interface VoteExecutionResponse {
  status: "broadcast";
  voter: string;
  author: string;
  permlink: string;
  weightBps: number;
  transactionId: string;
}

export type ConsentType = "login" | "target_vote" | "fee_post_vote" | "auto_vote" | "ai_strategy" | "community_intelligence";

export interface ConsentRecord {
  id?: string;
  username?: string;
  type: ConsentType;
  status?: "granted" | "revoked";
  title: string;
  description: string;
  scope: string[];
  createdAt?: string;
  revokedAt?: string;
}

export interface ConsentState {
  username: string;
  active: ConsentRecord[];
  history: ConsentRecord[];
}

export async function getSteemConnectUrl(): Promise<string> {
  const response = await fetch(`${API_BASE}/api/auth/steemconnect/url`);
  if (!response.ok) {
    throw new Error("SteemConnect Login konnte nicht vorbereitet werden.");
  }

  const data = (await response.json()) as { url: string };
  return data.url;
}

export async function completeSteemConnectCallback(payload: {
  code?: string;
  accessToken?: string;
  expiresIn?: number;
  state: string;
}): Promise<AuthSession> {
  const response = await fetch(`${API_BASE}/api/auth/steemconnect/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("SteemConnect Login konnte nicht abgeschlossen werden.");
  }

  return response.json();
}

export async function signOut(token: string): Promise<void> {
  await fetch(`${API_BASE}/api/auth/signout`, {
    method: "POST",
    headers: { session: token }
  });
}

export async function getKeychainChallenge(): Promise<{ nonce: string; expiresAt: number }> {
  const res = await fetch(`${API_BASE}/api/auth/keychain/challenge`);
  if (!res.ok) throw new Error("Challenge konnte nicht angefordert werden.");
  return res.json();
}

export async function verifyKeychainLogin(payload: {
  username: string;
  nonce: string;
  signature: string;
}): Promise<AuthSession> {
  const res = await fetch(`${API_BASE}/api/auth/keychain/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const code = (body as { error?: string }).error ?? "keychain_auth_failed";
    if (code === "invalid_signature") throw new Error("Signatur ungültig — falsches Konto oder Key?");
    if (code === "invalid_or_expired_challenge") throw new Error("Challenge abgelaufen. Bitte erneut versuchen.");
    throw new Error("Keychain-Login fehlgeschlagen.");
  }
  return res.json();
}

export async function getConsentCatalog(): Promise<ConsentRecord[]> {
  const response = await fetch(`${API_BASE}/api/consents/catalog`);
  if (!response.ok) {
    throw new Error("Consent-Katalog konnte nicht geladen werden.");
  }

  const data = (await response.json()) as { consents: ConsentRecord[] };
  return data.consents;
}

export async function getConsentState(token: string): Promise<ConsentState> {
  const response = await fetch(`${API_BASE}/api/consents`, {
    headers: { session: token }
  });
  if (!response.ok) {
    throw new Error("Consent-Status konnte nicht geladen werden.");
  }

  return response.json();
}

async function consentApiError(response: Response, fallback: string): Promise<never> {
  let detail = "";
  try {
    const body = (await response.json()) as { error?: string; detail?: { fieldErrors?: Record<string, string[]> } };
    const fieldErrors = body.detail?.fieldErrors;
    if (fieldErrors) {
      detail = Object.values(fieldErrors).flat().join(" ");
    } else if (body.error) {
      detail = body.error;
    }
  } catch {}
  throw new Error(detail ? `${fallback}: ${detail}` : fallback);
}

export async function grantConsent(token: string, type: ConsentType): Promise<ConsentState> {
  const response = await fetch(`${API_BASE}/api/consents/grant`, {
    method: "POST",
    headers: { "Content-Type": "application/json", session: token },
    body: JSON.stringify({ type })
  });
  if (!response.ok) await consentApiError(response, "Consent konnte nicht aktiviert werden");
  const data = (await response.json()) as { state: ConsentState };
  return data.state;
}

export async function revokeConsent(token: string, type: ConsentType): Promise<ConsentState> {
  const response = await fetch(`${API_BASE}/api/consents/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", session: token },
    body: JSON.stringify({ type })
  });
  if (!response.ok) await consentApiError(response, "Consent konnte nicht deaktiviert werden");
  const data = (await response.json()) as { state: ConsentState };
  return data.state;
}

export async function quoteVote(payload: {
  username: string;
  author: string;
  permlink: string;
  desiredVoteUsd: number;
  timingMode?: "manual" | "auto";
  voteDelayMinutes?: number;
  plannedVotesToday?: number;
  targetVotingPowerBps?: number;
}): Promise<VoteQuoteResponse> {
  const response = await fetch(`${API_BASE}/api/votes/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("Quote konnte nicht erstellt werden.");
  }

  return response.json();
}

export class VoteBroadcastError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "VoteBroadcastError";
  }
}

export async function executeVote(token: string, payload: {
  author: string;
  permlink: string;
  weightBps: number;
  broadcastMode?: "server" | "token" | "keychain";
  transactionId?: string;
}): Promise<VoteExecutionResponse> {
  const response = await fetch(`${API_BASE}/api/votes/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json", session: token },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    let code = "broadcast_failed";
    let errorBody: unknown = {};
    try {
      errorBody = await response.json();
      const data = errorBody as { error?: string };
      if (data.error) code = data.error;
    } catch {}

    if (response.status === 401) throw new VoteBroadcastError("session_expired",
      "Session abgelaufen. Bitte erneut einloggen.");
    if (code === "target_vote_consent_required") throw new VoteBroadcastError(code,
      "Vote-Consent fehlt. Bitte unter Einstellungen → Vote-Consent erteilen.");
    if (code === "missing_posting_authority") throw new VoteBroadcastError(code,
      "Posting Authority fehlt. Bitte @votebroker die Posting-Berechtigung erteilen.");
    if (code === "missing_posting_wif") throw new VoteBroadcastError(code,
      "Server-seitiges Voting nicht konfiguriert (Posting-Key fehlt).");
    if (code === "account_paused") throw new VoteBroadcastError(code,
      "Account ist pausiert. Bitte offene Gebühren begleichen.");
    if (code === "manual_token_fallback_disabled") throw new VoteBroadcastError(code,
      "Token-basiertes Voting ist serverseitig deaktiviert.");
    if (code === "authorized_session_required") throw new VoteBroadcastError("session_expired",
      "Session abgelaufen. Bitte erneut einloggen.");
    if (code === "already_voted") throw new VoteBroadcastError(code,
      "Dieser Post wurde bereits gevoted.");
    if (code === "post_not_found") throw new VoteBroadcastError(code,
      "Post nicht gefunden — Author oder Permlink ungültig.");
    if (code === "post_rejected") throw new VoteBroadcastError(code,
      (errorBody as { hint?: string }).hint ?? "Post vom Node abgelehnt.");
    if (code === "chain_rejected") {
      const detail = (errorBody as { detail?: string }).detail ?? "";
      throw new VoteBroadcastError(code,
        `Blockchain-Fehler: ${detail || "Transaktion abgelehnt."}`);
    }
    throw new VoteBroadcastError(code,
      `Vote fehlgeschlagen (${code}). Bitte prüfe die Browser-Konsole für Details.`);
  }

  return response.json();
}

export async function checkSessionValid(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { session: token }
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getCommunityOverview(username: string): Promise<CommunityPoolOverview> {
  const response = await fetch(`${API_BASE}/api/community/overview?username=${encodeURIComponent(username)}`);
  if (!response.ok) {
    throw new Error("Community Pool konnte nicht geladen werden.");
  }

  return response.json();
}

export async function getOperatorOverview(token: string): Promise<OperatorOverview> {
  const response = await fetch(`${API_BASE}/api/operator/overview`, {
    headers: {
      "x-operator-token": token
    }
  });
  if (!response.ok) {
    throw new Error(response.status === 503
      ? "Operator Dashboard ist serverseitig nicht konfiguriert."
      : "Operator Dashboard konnte nicht geladen werden.");
  }

  return response.json();
}

export interface SteemAccountSnapshot {
  username: string;
  votingPowerBps: number;
  steemPowerSp: number;
  fullPowerVoteUsd: number;
  currentVoteUsd: number;
  sbdPerSteem: number;  // SBD per STEEM (witness median price feed, not USD/STEEM)
}

export async function getAccountSnapshot(username: string): Promise<SteemAccountSnapshot> {
  const response = await fetch(`${API_BASE}/api/account/snapshot?username=${encodeURIComponent(username)}`);
  if (!response.ok) throw new Error("Account-Snapshot konnte nicht geladen werden.");
  return response.json();
}

export async function getAuthorityGrantUrl(): Promise<string> {
  const response = await fetch(`${API_BASE}/api/auth/authority-grant-url`);
  if (!response.ok) throw new Error("Authority-Grant-URL konnte nicht geladen werden.");
  const data = (await response.json()) as { url: string };
  return data.url;
}

export interface AuthorStats {
  username: string;
  voteCount: number;
  sharePct: number;
  avgWeightPct: number;
  compositeScore: number;
  lastVoteDaysAgo: number;
  selectionReasons: string[];
}

export interface HourStats {
  hour: number;
  voteCount: number;
  sharePct: number;
}

export interface SuggestedAuthorWeight {
  username: string;
  suggestedWeightBps: number;
  suggestedWeightPct: number;
  basedOnSharePct: number;
}

export interface CurationProfile {
  username: string;
  votesAnalyzed: number;
  periodDays: number;
  votesPerDay: number;
  uniqueAuthors: number;
  selfVotePct: number;
  avgWeightPct: number;
  fullWeightPct: number;
  topAuthors: AuthorStats[];
  peakHoursUtc: HourStats[];
  dnaLabel: string;
  dnaDescription: string;
  powerStable: {
    maxAvgWeightBps: number;
    maxAvgWeightPct: number;
    relevantAuthors: number;
    suggestedTopWeights: SuggestedAuthorWeight[];
  };
}

export interface PostOpportunity {
  author:           string;
  permlink:         string;
  title:            string;
  ageMinutes:       number;
  remainingHours:   number;
  postScore:        number;
  alreadyVoted:     boolean;
  eligible:         boolean;
  isSelfPost:       boolean;
  warning:          string | null;
  activeVotesCount: number;
  community:        string | null;
}

// ── Vote Plan (Generate Votes) ────────────────────────────────────────────────

export interface VotePlanEntry {
  author:             string;
  permlink:           string;
  title:              string;
  ageMinutes:         number;
  remainingHours:     number;
  postScore:          number;
  category:           string;
  priority:           number;
  suggestedWeightPct: number;
  suggestedWeightBps: number;
  expectedVoteUsd:    number;
  reason:             string;
  reasons:            string[];
  warning:            string | null;
}

export interface VotePlanSummary {
  totalPosts: number;
  currentVpPct: number;
  estimatedVpSpendPct: number;
  estimatedVpAfterPct: number;
  sustainability: "sustainable" | "aggressive" | "critical";
  skippedCategories: string[];
}

export type StopReason = "max_votes" | "budget" | "none";

export interface ConstraintReport {
  maxVotesPerRun:         number;
  dynamicBudgetPct:       number;
  effectiveBudgetPct:     number;
  maxVpSpendPct:          number;
  minVpPct:               number;
  includedVotes:          number;
  excludedVotes:          number;
  stoppedBy:              StopReason;
  stoppedByLabel:         string;
  vpAfterPlanPct:         number;
  expectedTomorrowVpPct:  number;
  recoveryMode:           boolean;
  weightReductionPct:     number;
}

export interface VotePlanConstraints {
  minVpPct:       number;
  maxVotesPerRun: number;
  maxVpSpendPct:  number;
}

export interface VotePlanResponse {
  plan:        VotePlanEntry[];
  summary:     VotePlanSummary;
  constraints: VotePlanConstraints;
  report:      ConstraintReport;
  generatedAt: string;
}

export const DEFAULT_CONSTRAINTS: VotePlanConstraints = {
  minVpPct:       70,
  maxVotesPerRun: 20,  // dynamic budget controls effective count, not this cap
  maxVpSpendPct:  80,
};

export async function generateVotePlan(payload: {
  voterUsername: string;
  currentVpBps: number;
  currentVoteUsd: number;
  targetVpPct?: number;
  targetTomorrowVpPct?: number;
  constraints?: VotePlanConstraints;
  rules: Array<{ username: string; category: string; maxWeightPct: number; minWeightPct: number; enabled: boolean; selectionReasons?: string[] }>;
}): Promise<VotePlanResponse> {
  const response = await fetch(`${API_BASE}/api/curation/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Vote-Plan konnte nicht generiert werden.");
  return response.json();
}

export interface OpportunitiesMeta {
  requestedAuthors: number;
  scannedAuthors:   number;
  totalPosts:       number;
  eligiblePosts:    number;
  perAuthor: Record<string, {
    scanned:       number;
    eligible:      number;
    alreadyVoted:  number;
    noRecentPosts: boolean;
  }>;
}

export interface OpportunitiesResponse {
  opportunities: PostOpportunity[];
  meta:          OpportunitiesMeta;
}

export async function getVoteOpportunities(
  authors: string[],
  voterUsername: string
): Promise<OpportunitiesResponse> {
  // Deduplicate authors before sending
  const unique = [...new Set(authors.map(a => a.toLowerCase().trim()))].filter(Boolean);

  console.log(`[VoteBroker] Opportunity scan — sending ${unique.length} authors (deduplicated from ${authors.length}):`, unique);

  const response = await fetch(`${API_BASE}/api/curation/opportunities`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authors: unique, voterUsername })
  });
  if (!response.ok) throw new Error("Offene Votes konnten nicht geladen werden.");
  return response.json() as Promise<OpportunitiesResponse>;
}

// ── Admin types & API (owner-only) ───────────────────────────────────────────

export interface AdminOverview {
  users: { totalUsers: number; activeUsers7d: number; activeUsers30d: number; newUsersToday: number; newUsersMonth: number };
  platform: { totalStrategies: number; activeSessions: number; totalConsents: number; authorityCached: number };
  votes: { totalAttempts: number; totalSuccess: number; totalBlocked: number; last24h: number };
}

export interface AdminUserRow {
  username: string;
  lastSeen: string;
  consentsGranted: number;
  strategyRules: number;
  hasStrategy: boolean;
  isAdmin: boolean;
}

export interface FeePostLogEntry {
  id: string; dateStr: string; status: "success" | "failed" | "skipped";
  permlink: string | null; alreadyExisted: boolean; error: string | null;
  executedAt: string; nextRunAt: string | null;
}

export interface AdminHealth {
  api: { status: string; uptimeSeconds: number; memoryMb: number; heapUsedMb: number; nodeVersion: string };
  database: { status: string; pingMs: number; activeSessions: number; expiredSessions: number; totalAuditEvents: number; authorityCacheEntries: number };
  votes: { failedBroadcasts: number; recentBlocked: number };
  feePost: {
    schedulerActive: boolean;
    nextRunAt: string;
    lastRun: FeePostLogEntry | null;
    lastStatus: string;
    lastOk: boolean;
    recentRuns: FeePostLogEntry[];
  };
  warnings: string[];
}

export interface AdminInsights {
  consents: { breakdown: Record<string, number>; totalActive: number };
  strategies: { total: number; totalRules: number; manualOverrides: number; avgRulesPerUser: number };
  votes: { totalAttempts: number; totalSuccess: number; totalBlocked: number; last24h: number };
  topAuthors: Array<{ username: string; strategiesCount: number }>;
}

export interface AdminNotification {
  type: "login" | "consent" | "vote_blocked";
  message: string;
  timestamp: string;
  severity: "info" | "warning" | "error";
}

export interface AdminDashboardData {
  overview:      AdminOverview;
  health:        AdminHealth;
  users:         { users: AdminUserRow[]; total: number };
  insights:      AdminInsights;
  notifications: { notifications: AdminNotification[]; count: number };
}

// ── Content draft types ────────────────────────────────────────────────────────

export type DraftStatus = "draft" | "reviewed" | "approved" | "scheduled" | "publishing" | "published" | "failed";

export interface ContentDraft {
  filename: string;
  dateStr: string;
  type: "product-post" | "tech-post" | "devlog-post";
  title: string;
  status: DraftStatus;
  notes: string | null;
  reviewedAt:         string | null;
  approvedAt:         string | null;
  scheduledAt:        string | null;
  scheduledFor:       string | null;
  publishedAt:        string | null;
  publishTxId:        string | null;
  publishedPermlink:  string | null;
  failedAt:           string | null;
  failedReason:       string | null;
  createdAt: string;
  updatedAt: string;
  wordCount?: number;
}

export interface PublishResult {
  ok:            boolean;
  transactionId: string;
  author:        string;
  permlink:      string;
  url:           string;
  draft:         ContentDraft;
}

export class ContentValidationError extends Error {
  constructor(public readonly violations: string[]) {
    super(`Unfertige Platzhalter gefunden: ${violations.join(", ")}`);
    this.name = "ContentValidationError";
  }
}

export async function publishDraft(token: string, filename: string): Promise<PublishResult> {
  const res = await fetch(`${API_BASE}/api/admin/content/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", session: token },
    body: JSON.stringify({ filename })
  });
  const data = await res.json() as PublishResult & { error?: string; failedReason?: string; violations?: string[] };
  if (!res.ok) {
    if (data.error === "content_validation_failed" && data.violations) {
      throw new ContentValidationError(data.violations);
    }
    throw new Error(data.failedReason ?? data.error ?? "publish_failed");
  }
  return data;
}

export interface ContentListResponse {
  drafts: ContentDraft[];
  counts: Record<string, number>;
  contentDir: string;
  nextScheduled: ContentDraft | null;
}

export async function getContentDrafts(token: string): Promise<ContentListResponse> {
  const res = await fetch(`${API_BASE}/api/admin/content`, { headers: { session: token } });
  if (!res.ok) throw new Error("content_load_failed");
  return res.json();
}

export async function getContentPreview(token: string, filename: string): Promise<{ filename: string; content: string; meta: Record<string, string> }> {
  const res = await fetch(`${API_BASE}/api/admin/content/preview?file=${encodeURIComponent(filename)}`, { headers: { session: token } });
  if (!res.ok) throw new Error("preview_load_failed");
  return res.json();
}

export async function updateDraftStatus(token: string, filename: string, status: DraftStatus, opts?: { notes?: string; scheduledFor?: string; failedReason?: string }): Promise<ContentDraft> {
  const res = await fetch(`${API_BASE}/api/admin/content/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", session: token },
    body: JSON.stringify({ filename, status, ...opts })
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
    throw new Error(data.hint ?? data.error ?? "status_update_failed");
  }
  const data = (await res.json()) as { draft: ContentDraft };
  return data.draft;
}

export async function editDraftContent(token: string, filename: string, content: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/admin/content/edit`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", session: token },
    body: JSON.stringify({ filename, content })
  });
  if (!res.ok) throw new Error("edit_failed");
}

export async function deleteDraft(token: string, filename: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/admin/content`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", session: token },
    body: JSON.stringify({ filename }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string; hint?: string };
    throw new Error(err.hint ?? err.error ?? `delete_failed (${res.status})`);
  }
}

/** Trigger a fee settlement post. Pass `date` (YYYY-MM-DD) to retroactively publish, `forceUpdate` to overwrite an existing post (fix wrong title). */
export async function triggerFeePost(token: string, date?: string, forceUpdate?: boolean): Promise<FeePostLogEntry> {
  const payload: Record<string, unknown> = {};
  if (date) payload.date = date;
  if (forceUpdate) payload.forceUpdate = true;
  const res = await fetch(`${API_BASE}/api/admin/fee-post/trigger`, {
    method: "POST",
    headers: { session: token, "content-type": "application/json" },
    body: Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new Error(data.detail ?? data.error ?? "trigger_failed");
  }
  return res.json();
}

// ── Today's votes (persisted, from audit log) ─────────────────────────────────

export interface TodayVote {
  author: string; permlink: string; weightBps: number;
  transactionId: string; votedAt: string;
}

export interface TodayLastRun {
  startedAt: string; endedAt: string;
  voteCount: number; authors: string[]; weightBps: number;
}

export interface TodayStats {
  totalVotes: number; runsCount: number;
  uniqueAuthors: number; totalWeightBps: number;
  runs: TodayLastRun[];
  lastRun: TodayLastRun | null;
  votes: TodayVote[];
}

export interface PendingDebugPost {
  author:             string;
  permlink:           string;
  cashoutTime:        string;
  pendingPayoutSbd:   number;
  // Primary: curation weight
  myWeight:           number;
  sumWeight:          number;
  sharePctWeight:     number;
  estimatedSp:        number;
  // Comparison: rshares
  myRshares:          number;
  sumRshares:         number;
  sharePctRshares:    number;
  estimatedSpRshares: number;
}

export interface PendingCuration {
  pendingUsd:   number;
  pendingSp:    number;
  postCount:    number;
  voteCount:    number;
  nextPayout:   { cashoutTime: string; estimatedSp: number; estimatedUsd: number } | null;
  topPending:   Array<{ author: string; permlink: string; cashoutTime: string; estimatedSp: number; estimatedUsd: number }>;
  earned30dSp:  number;
  earned30dUsd: number;
  earned30dCount: number;
  sbdPerSteemUsed: number;  // SBD/STEEM price used for SP conversion
  debug: {
    uniqueTotal:    number;
    fetched:        number;
    totalPayoutUsd: number;
    skipped: {
      alreadyPaidOut: number;
      payoutZero:     number;
      noVoteFound:    number;
      weightZero:     number;
      limitReached:   number;
    };
    top10:   PendingDebugPost[];
    method:  string;
  };
  computedAt:   string;
}

export async function fetchPendingCuration(token: string, sbdPerSteem?: number): Promise<PendingCuration> {
  const qs = sbdPerSteem ? `?steemPriceUsd=${sbdPerSteem}` : "";  // query param stays for API compat
  const res = await fetch(`${API_BASE}/api/account/pending-curation${qs}`, {
    headers: { session: token },
  });
  if (!res.ok) throw new Error("Pending curation konnte nicht geladen werden.");
  return res.json();
}

export async function fetchTodayStats(token: string): Promise<TodayStats> {
  const res = await fetch(`${API_BASE}/api/votes/today`, {
    headers: { session: token },
  });
  if (!res.ok) throw new Error("Today stats konnten nicht geladen werden.");
  return res.json();
}

// ── Cockpit types ─────────────────────────────────────────────────────────────

export interface AdminKpis {
  users:   { total: number; active24h: number; active7d: number; newUsers24h: number; newUsers7d: number };
  votes:   { today: number; successToday: number; blockedToday: number; totalSuccess: number; totalBlocked: number };
  content: { published: number; openDrafts: number; failed: number };
  feePost: { lastStatus: string; lastDate: string | null };
  system:  { status: string; hasWif: boolean; dbOk: boolean };
}

export interface DayVotes  { day: string; total: number; success: number; blocked: number }
export interface DayUsers  { day: string; new_users: number }
export interface DayFeePost { day: string; status: string }
export interface AdminAnalytics { votesByDay: DayVotes[]; usersByDay: DayUsers[]; feePostByDay: DayFeePost[] }

export interface BroadcastEntry {
  id: string; type: string; username: string; author: string | null;
  permlink: string | null; weightBps: number | null; detail: string | null;
  transactionId: string | null; createdAt: string;
  status: "success" | "blocked" | "attempt";
}

export interface ContentQueueItem {
  filename: string; status: string; title: string | null;
  publish_tx_id: string | null; published_permlink: string | null;
  scheduled_for: string | null; updated_at: string; failed_reason: string | null;
}

export interface AdminCockpit {
  kpis:          AdminKpis;
  health:        AdminHealth & { steemNode: { status: string; pingMs: number; block?: number }; hasWif: boolean; nodeUrl: string };
  users:         { users: AdminUserRow[]; total: number };
  broadcasts:    BroadcastEntry[];
  analytics:     AdminAnalytics;
  feePostLog:    FeePostLogEntry[];
  notifications: { notifications: AdminNotification[]; count: number };
  contentQueue:  ContentQueueItem[];
}

export async function getAdminCockpit(token: string): Promise<AdminCockpit> {
  const res = await fetch(`${API_BASE}/api/admin/cockpit`, { headers: { session: token } });
  if (!res.ok) throw new Error(res.status === 403 ? "admin_access_denied" : "cockpit_load_failed");
  return res.json();
}

export async function getAdminDashboard(token: string): Promise<AdminDashboardData> {
  const response = await fetch(`${API_BASE}/api/admin/all`, {
    headers: { session: token }
  });
  if (!response.ok) throw new Error(response.status === 403 ? "admin_access_denied" : "admin_load_failed");
  return response.json();
}

export async function getPersistedStrategy(token: string): Promise<unknown[] | null> {
  const response = await fetch(`${API_BASE}/api/strategy`, {
    headers: { session: token }
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { rules: unknown[] | null };
  return data.rules;
}

export async function persistStrategy(token: string, rules: unknown[]): Promise<void> {
  await fetch(`${API_BASE}/api/strategy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", session: token },
    body: JSON.stringify({ rules })
  });
}

export async function getCurationDna(username: string, maxVotes = 500): Promise<CurationProfile> {
  const response = await fetch(
    `${API_BASE}/api/curation/dna?username=${encodeURIComponent(username)}&maxVotes=${maxVotes}`
  );
  if (!response.ok) throw new Error("Vote-DNA konnte nicht geladen werden.");
  return response.json();
}

export async function checkPostingAuthority(username: string, broadcastAccount = "votebroker"): Promise<boolean> {
  const response = await fetch("https://api.steemit.com", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "condenser_api.get_accounts",
      params: [[username]],
      id: 1
    })
  });
  if (!response.ok) return false;
  const data = (await response.json()) as {
    result?: Array<{ posting: { account_auths: Array<[string, number]> } }>
  };
  const account = data.result?.[0];
  if (!account) return false;
  return account.posting.account_auths.some(([name]) => name === broadcastAccount);
}

// ── Growth data ───────────────────────────────────────────────────────────────

export interface GrowthDataPoint {
  day:        string;
  votes:      number;
  cumVotes:   number;
  newAuthors: number;
  cumAuthors: number;
}

export interface GrowthSummary {
  totalVotes:         number;
  totalUniqueAuthors: number;
  activeDays:         number;
  currentStreak:      number;
  longestStreak:      number;
  firstVoteAt:        string | null;
  lastVoteAt:         string | null;
}

export interface GrowthData {
  period:     "30d" | "90d" | "all";
  dataPoints: GrowthDataPoint[];
  summary:    GrowthSummary;
}

export async function fetchGrowthData(token: string, period: "30d" | "90d" | "all"): Promise<GrowthData> {
  const res = await fetch(`${API_BASE}/api/me/growth?period=${period}`, {
    headers: { session: token },
  });
  if (!res.ok) throw new Error("growth_fetch_failed");
  return res.json();
}

// ── Community Discovery ───────────────────────────────────────────────────────

export interface AuthorDiscoveryCard {
  username:         string;
  curatorCount:     number;
  topCategory:      string;
  topCategoryLabel: string;
  recentVotes:      number;
  lastVotedAt:      string | null;
  reasons:          string[];
  inMyStrategy:     boolean;
}

export interface CommunityDiscovery {
  communityAuthors: AuthorDiscoveryCard[];
  discoveries:      AuthorDiscoveryCard[];
  meta: {
    totalCurators:  number;
    myAuthorCount:  number;
    dataQuality:    "rich" | "sparse" | "empty";
    notice:         string | null;
  };
  computedAt: string;
}

export async function fetchCommunityDiscovery(token: string): Promise<CommunityDiscovery> {
  const res = await fetch(`${API_BASE}/api/community/discovery`, {
    headers: { session: token },
  });
  if (!res.ok) throw new Error("Community Discovery konnte nicht geladen werden.");
  return res.json();
}

export interface WhaleSignalEntry {
  author:          string;
  whaleCount:      number;
  whales:          string[];
  totalWhaleVotes: number;
  lastWhaleVoteAt: string | null;
  inMyStrategy:    boolean;
}

export interface WhaleSignalsData {
  signals:       WhaleSignalEntry[];
  trackedWhales: string[];
  periodDays:    number;
  computedAt:    string | null;
  authorsFound:  number;
}

export async function fetchWhaleSignals(token: string): Promise<WhaleSignalsData> {
  const res = await fetch(`${API_BASE}/api/community/whale-signals`, {
    headers: { session: token },
  });
  if (!res.ok) throw new Error("Whale Signals konnten nicht geladen werden.");
  return res.json();
}

// ── Devlog generation (admin-session auth) ────────────────────────────────────

export interface DevlogGenerateResult {
  dateStr:  string;
  filename: string;
  status:   "created" | "skipped" | "failed" | "updated";
  reason?:  string;
}

export async function generateDevlogContent(
  token: string,
  opts: { date?: string; force?: boolean; screenshots?: boolean } = {},
): Promise<DevlogGenerateResult> {
  const res = await fetch(`${API_BASE}/api/admin/content/generate-devlog`, {
    method: "POST",
    headers: { "Content-Type": "application/json", session: token },
    body: JSON.stringify({ date: opts.date, force: opts.force ?? false }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { reason?: string };
    throw new Error(body.reason ?? `Generate failed (${res.status})`);
  }
  return res.json();
}

export interface CaptureScreenshotsResult {
  status:    "ok" | "unavailable" | "failed";
  files?:    string[];
  message?:  string;
}

export async function captureScreenshots(token: string): Promise<CaptureScreenshotsResult> {
  const res = await fetch(`${API_BASE}/api/admin/capture-screenshots`, {
    method: "POST",
    headers: { session: token },
  });
  return res.json();
}

// ── Screenshot management ─────────────────────────────────────────────────────

export interface ScreenshotFile {
  filename: string;
  url:      string;
  sizekb:   number;
}

export async function listScreenshots(token: string): Promise<{ available: boolean; files: ScreenshotFile[] }> {
  const res = await fetch(`${API_BASE}/api/admin/screenshots`, { headers: { session: token } });
  if (!res.ok) return { available: false, files: [] };
  return res.json();
}

export async function injectScreenshots(token: string, filename: string): Promise<{ ok: boolean; replaced: number; hint?: string }> {
  const res = await fetch(`${API_BASE}/api/admin/content/inject-screenshots`, {
    method: "POST",
    headers: { "Content-Type": "application/json", session: token },
    body: JSON.stringify({ filename }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; hint?: string };
    throw new Error(body.hint ?? body.error ?? `inject failed (${res.status})`);
  }
  return res.json();
}

// ── VoteBroker-attributed Earnings ───────────────────────────────────────────

export interface DailyEarnings {
  date:          string;
  realizedSp:    number;
  votes:         number;
  cumRealizedSp: number;
}

export interface VBEarningsResult {
  period:           string;
  attributionStart: string | null;
  dailyData:        DailyEarnings[];
  totals: {
    realizedSp:    number;
    voteCount:     number;
    realizedCount: number;
  };
  notice:    string | null;
  computedAt: string;
}

export async function fetchVBEarnings(
  token: string,
  period: "7d" | "30d" | "90d" | "all" = "30d",
): Promise<VBEarningsResult> {
  const res = await fetch(`${API_BASE}/api/me/votebroker-earnings?period=${period}`, {
    headers: { session: token },
  });
  if (!res.ok) throw new Error("VoteBroker Earnings konnten nicht geladen werden.");
  return res.json();
}

export async function fixScreenshotUrls(token: string, filename: string): Promise<{ ok: boolean; changed: boolean; replacements: number; hint: string }> {
  const res = await fetch(`${API_BASE}/api/admin/content/fix-screenshot-urls`, {
    method: "POST",
    headers: { "Content-Type": "application/json", session: token },
    body: JSON.stringify({ filename }),
  });
  if (!res.ok) throw new Error(`fix-urls failed (${res.status})`);
  return res.json();
}

export type PromoLocale = "en"|"de"|"es"|"pt"|"id"|"ru"|"ko"|"zh"|"ja"|"hi"|"bn"|"tr"|"pl"|"pcm";

export interface PromoAnalysis {
  locale: PromoLocale;
  communities: Array<{ name: string; postCount: number; topTag: string }>;
  topTags: string[];
  topAuthors: string[];
  trendingTopics: string[];
  styleProfile: { avgLength: string; tone: string; usesLists: boolean; usesImages: boolean };
  recommendation: { community: string; tags: string[]; postingHour: number; reasoning: string };
  scannedAt: string;
}

export interface PromoResult {
  filename: string;
  analysis: PromoAnalysis;
  screenshotSnap: string | null;
}

export const PROMO_LOCALES: Array<{ code: PromoLocale; label: string; nativeName: string }> = [
  { code: "en",  label: "EN",    nativeName: "English" },
  { code: "de",  label: "DE",    nativeName: "Deutsch" },
  { code: "es",  label: "ES",    nativeName: "Español" },
  { code: "pt",  label: "PT-BR", nativeName: "Português" },
  { code: "id",  label: "ID",    nativeName: "Bahasa Indonesia" },
  { code: "ru",  label: "RU",    nativeName: "Русский" },
  { code: "ko",  label: "KO",    nativeName: "한국어" },
  { code: "zh",  label: "ZH",    nativeName: "中文" },
  { code: "ja",  label: "JA",    nativeName: "日本語" },
  { code: "hi",  label: "HI",    nativeName: "हिन्दी" },
  { code: "bn",  label: "BN",    nativeName: "বাংলা" },
  { code: "tr",  label: "TR",    nativeName: "Türkçe" },
  { code: "pl",  label: "PL",    nativeName: "Polski" },
  { code: "pcm", label: "Naija", nativeName: "Naija (Nigerian Pidgin)" },
];

export async function generatePromoPost(sessionToken: string, locale: PromoLocale): Promise<PromoResult> {
  const res = await fetch(`${API_BASE}/api/promo/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", session: sessionToken },
    body: JSON.stringify({ locale }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string; detail?: string };
    throw new Error(err.detail ?? err.error ?? `Promo generation failed (${res.status})`);
  }
  return res.json();
}
