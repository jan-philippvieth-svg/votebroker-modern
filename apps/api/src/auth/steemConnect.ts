export interface SteemConnectTokenResponse {
  username: string;
  access_token: string;
  expires_in?: number;
}

export interface BroadcastVoteResult {
  transactionId: string;
  raw: unknown;
}

import { buildSteemConnectLoginUrl, getSteemConnectConfig, requireCodeFlowSecret } from "./steemConnectConfig.js";

export function getSteemConnectLoginUrl(state?: string): string {
  return buildSteemConnectLoginUrl(getSteemConnectConfig(), state);
}

export async function exchangeSteemConnectCode(code: string): Promise<SteemConnectTokenResponse> {
  const config = getSteemConnectConfig();
  requireCodeFlowSecret(config.clientSecret);

  const url = new URL("/api/oauth2/token", config.apiHost);
  const body = new URLSearchParams({
    code,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code"
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    throw new Error(`SteemConnect token exchange failed with ${response.status}`);
  }

  const data = (await response.json()) as Partial<SteemConnectTokenResponse>;
  if (!data.access_token) {
    throw new Error("SteemConnect token response is incomplete");
  }

  const username = data.username ?? await verifySteemConnectAccessToken(data.access_token);

  return {
    username,
    access_token: data.access_token,
    expires_in: data.expires_in
  };
}

export async function completeSteemConnectAccessToken(accessToken: string, expiresIn?: number): Promise<SteemConnectTokenResponse> {
  const username = await verifySteemConnectAccessToken(accessToken);
  return {
    username,
    access_token: accessToken,
    expires_in: expiresIn
  };
}

export async function verifySteemConnectAccessToken(accessToken: string): Promise<string> {
  const response = await fetch(new URL("/api/me", getSteemConnectConfig().apiHost), {
    headers: {
      Authorization: accessToken,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`SteemConnect token verification failed with ${response.status}`);
  }

  const data = await response.json() as {
    user?: string;
    username?: string;
    name?: string;
    account?: { name?: string };
  };
  const username = data.user ?? data.username ?? data.name ?? data.account?.name;
  if (!username) {
    throw new Error("SteemConnect identity response is incomplete");
  }

  return username;
}

export async function broadcastSteemConnectVote(params: {
  accessToken: string;
  voter: string;
  author: string;
  permlink: string;
  weightBps: number;
}): Promise<BroadcastVoteResult> {
  const response = await fetch(new URL("/api/broadcast", getSteemConnectConfig().apiHost), {
    method: "POST",
    headers: {
      Authorization: params.accessToken,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      operations: [
        [
          "vote",
          {
            voter: params.voter,
            author: params.author,
            permlink: params.permlink,
            weight: params.weightBps
          }
        ]
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`SteemConnect vote broadcast failed with ${response.status}`);
  }

  const data = await response.json() as {
    errors?: unknown;
    error?: unknown;
    result?: {
      id?: string;
      signatures?: string[];
    };
  };

  if (data.errors || data.error) {
    throw new Error("SteemConnect vote broadcast returned an error");
  }

  return {
    transactionId: data.result?.id ?? data.result?.signatures?.[0] ?? "broadcast_accepted",
    raw: data
  };
}
