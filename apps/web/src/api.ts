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
  };
  feeInvoice: {
    id: string;
    amountUsd: number;
    feePostAuthor: string;
    feePostPermlink: string;
    requiredVoteWeightBps: number;
    status: "open" | "settled" | "underfunded";
  };
  feePolicy: {
    feeBps: number;
    minFeeUsd: number;
  };
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:3000";

export interface AuthSession {
  token: string;
  expiry: string;
  user: {
    username: string;
    provider: "steemconnect";
  };
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

export async function completeSteemConnectLogin(code: string): Promise<AuthSession> {
  const response = await fetch(`${API_BASE}/api/auth/steemconnect/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code })
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
