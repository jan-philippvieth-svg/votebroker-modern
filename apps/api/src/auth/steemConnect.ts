export interface SteemConnectTokenResponse {
  username: string;
  access_token: string;
  expires_in: number;
}

const host = process.env.STEEMCONNECT_HOST ?? "https://api.steemconnect.com";
const clientId = process.env.STEEMCONNECT_CLIENT_ID ?? "votebroker";
const redirectUri = process.env.STEEMCONNECT_REDIRECT_URI ?? "http://localhost:5173/auth/callback";
const clientSecret = process.env.STEEMCONNECT_CLIENT_SECRET ?? "";
const scopes = process.env.STEEMCONNECT_SCOPES ?? "login,vote";

export function getSteemConnectLoginUrl(state?: string): string {
  const url = new URL("/oauth2/authorize", host);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes);
  url.searchParams.set("response_type", "code");
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
  url.searchParams.set("code", code);
  url.searchParams.set("client_secret", clientSecret);

  const response = await fetch(url, {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`SteemConnect token exchange failed with ${response.status}`);
  }

  const data = (await response.json()) as Partial<SteemConnectTokenResponse>;
  if (!data.username || !data.access_token || !data.expires_in) {
    throw new Error("SteemConnect token response is incomplete");
  }

  return {
    username: data.username,
    access_token: data.access_token,
    expires_in: data.expires_in
  };
}
