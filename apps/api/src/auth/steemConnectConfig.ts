export interface SteemConnectLoginConfig {
  authHost: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  responseType: "code" | "token";
}

export function getSteemConnectConfig(): SteemConnectLoginConfig & {
  apiHost: string;
  clientSecret: string;
} {
  const legacyHost = process.env.STEEMCONNECT_HOST;
  return {
    authHost: process.env.STEEMCONNECT_AUTH_HOST ?? legacyHost ?? "https://v2.steemconnect.com",
    apiHost: process.env.STEEMCONNECT_API_HOST ?? legacyHost ?? "https://api.steemconnect.com",
    clientId: process.env.STEEMCONNECT_CLIENT_ID ?? "votebroker",
    clientSecret: process.env.STEEMCONNECT_CLIENT_SECRET ?? "",
    redirectUri: process.env.STEEMCONNECT_REDIRECT_URI ?? "http://localhost:5173/auth/callback",
    scopes: process.env.STEEMCONNECT_SCOPES ?? "offline,vote",
    responseType: process.env.STEEMCONNECT_RESPONSE_TYPE === "token" ? "token" : "code"
  };
}

export function buildSteemConnectLoginUrl(config: SteemConnectLoginConfig, state?: string): string {
  const url = new URL("/oauth2/authorize", config.authHost);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("response_type", config.responseType);
  if (state) {
    url.searchParams.set("state", state);
  }
  return url.toString();
}

export function requireCodeFlowSecret(clientSecret: string): void {
  if (!clientSecret) {
    throw new Error("STEEMCONNECT_CLIENT_SECRET is not configured");
  }
}
