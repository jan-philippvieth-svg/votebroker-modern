import assert from "node:assert/strict";
import test from "node:test";
import { buildSteemConnectLoginUrl, requireCodeFlowSecret } from "./steemConnectConfig.js";

test("builds SteemDunk-style code flow login URL", () => {
  const url = new URL(buildSteemConnectLoginUrl({
    authHost: "https://v2.steemconnect.com",
    clientId: "votebroker",
    redirectUri: "https://votebroker.org/auth/callback",
    responseType: "code",
    scopes: "offline,vote"
  }, "state-123"));

  assert.equal(url.origin, "https://v2.steemconnect.com");
  assert.equal(url.pathname, "/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), "votebroker");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "offline,vote");
  assert.equal(url.searchParams.get("redirect_uri"), "https://votebroker.org/auth/callback");
  assert.equal(url.searchParams.get("state"), "state-123");
});

test("rejects code flow without client secret", () => {
  assert.throws(() => requireCodeFlowSecret(""), /STEEMCONNECT_CLIENT_SECRET/);
});
