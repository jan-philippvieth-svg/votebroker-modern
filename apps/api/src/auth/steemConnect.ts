export interface SteemConnectTokenResponse {
  username: string;
  access_token: string;
  expires_in?: number;
}

export interface BroadcastVoteResult {
  transactionId: string;
  raw: unknown;
}

const host = process.env.STEEMCONNECT_HOST ?? process.env.HIVESIGNER_HOST ?? "https://hivesigner.com";
const clientId = process.env.STEEMCONNECT_CLIENT_ID ?? "votebroker";
const redirectUri = process.env.STEEMCONNECT_REDIRECT_URI ?? "http://localhost:5173/auth/callback";
const clientSecret = process.env.STEEMCONNECT_CLIENT_SECRET ?? "";
const scopes = process.env.STEEMCONNECT_SCOPES ?? "login,vote";
const responseType = process.env.STEEMCONNECT_RESPONSE_TYPE ?? (scopes.split(",").includes("offline") ? "code" : "token");

export function getSteemConnectLoginUrl(state?: string): string {
  const url = new URL("/oauth2/authorize", host);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes);
  if (responseType === "code") {
    url.searchParams.set("response_type", "code");
  }
  if (state) {
    url.searchParams.set("state", state);
  }
  return url.toString();
}

export async function exchangeSteemConnectCode(code: string): Promise<SteemConnectTokenResponse> {
  if (!clientSecret) {
    throw new Error("STEEMCONNECT_CLIENT_SECRET is not configured");
  }

  const url = new URL("/api/oauth2/token", host);
  const body = new URLSearchParams({
    code,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
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
  const response = await fetch(new URL("/api/me", host), {
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
  const response = await fetch(new URL("/api/broadcast", host), {
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
