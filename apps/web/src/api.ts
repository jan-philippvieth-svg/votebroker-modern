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

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

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

export type ConsentType = "login" | "target_vote" | "fee_post_vote" | "auto_vote";

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

export async function grantConsent(token: string, type: ConsentType): Promise<ConsentState> {
  const response = await fetch(`${API_BASE}/api/consents/grant`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      session: token
    },
    body: JSON.stringify({ type })
  });
  if (!response.ok) {
    throw new Error("Consent konnte nicht gespeichert werden.");
  }

  const data = (await response.json()) as { state: ConsentState };
  return data.state;
}

export async function revokeConsent(token: string, type: ConsentType): Promise<ConsentState> {
  const response = await fetch(`${API_BASE}/api/consents/revoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      session: token
    },
    body: JSON.stringify({ type })
  });
  if (!response.ok) {
    throw new Error("Consent konnte nicht widerrufen werden.");
  }

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

export async function executeVote(token: string, payload: {
  author: string;
  permlink: string;
  weightBps: number;
}): Promise<VoteExecutionResponse> {
  const response = await fetch(`${API_BASE}/api/votes/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      session: token
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(response.status === 403
      ? "Vote-Consent fehlt oder wurde widerrufen."
      : "Vote konnte nicht an SteemConnect/HiveSigner gesendet werden.");
  }

  return response.json();
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
