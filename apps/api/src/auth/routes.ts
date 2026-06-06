import { createHash, randomBytes } from "crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { grantConsent } from "../consent/consentStore.js";
import { createSession, deleteSession, getSession } from "./sessionStore.js";
import { consumeAuthState, createAuthState } from "./stateStore.js";
import { completeSteemConnectAccessToken, exchangeSteemConnectCode, getSteemConnectLoginUrl } from "./steemConnect.js";
import { buildAuthorityGrantUrl } from "./steemConnectConfig.js";
import { createSteemClient } from "../chain/steemBroadcaster.js";

// ── Keychain challenge store (in-memory, TTL 5 min) ──────────────────────────
const keychainChallenges = new Map<string, { nonce: string; expiresAt: number }>();

function createKeychainChallenge(): { nonce: string; expiresAt: number } {
  const nonce = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 5 * 60 * 1000;
  keychainChallenges.set(nonce, { nonce, expiresAt });
  // Clean up expired challenges
  for (const [key, val] of keychainChallenges) {
    if (val.expiresAt < Date.now()) keychainChallenges.delete(key);
  }
  return { nonce, expiresAt };
}

function consumeKeychainChallenge(nonce: string): boolean {
  const entry = keychainChallenges.get(nonce);
  if (!entry || entry.expiresAt < Date.now()) return false;
  keychainChallenges.delete(nonce);
  return true;
}

async function verifyKeychainSignature(
  username: string,
  nonce: string,
  signature: string,
  publicKey?: string
): Promise<boolean> {
  try {
    const { Signature } = await import("dsteem");
    const client = createSteemClient();
    const [account] = await client.database.getAccounts([username]);
    if (!account) return false;

    const postingKeys: string[] = account.posting.key_auths.map(([key]) => String(key));

    // Primary: Keychain returns publicKey directly — just check it's in posting.key_auths
    if (publicKey && postingKeys.includes(publicKey)) {
      // Also verify the signature is valid for this key (prevents spoofing)
      const hash = createHash("sha256").update(nonce).digest();
      const sig = Signature.fromString(signature);
      const recoveredKey = sig.recover(hash).toString();
      return recoveredKey === publicKey;
    }

    // Fallback: recover public key from signature and check against posting.key_auths
    const hash = createHash("sha256").update(nonce).digest();
    const sig = Signature.fromString(signature);
    const recoveredKey = sig.recover(hash).toString();
    return postingKeys.includes(recoveredKey);
  } catch {
    return false;
  }
}

const callbackSchema = z.object({
  code: z.string().min(1).optional(),
  accessToken: z.string().min(1).optional(),
  access_token: z.string().min(1).optional(),
  expiresIn: z.number().positive().optional(),
  expires_in: z.number().positive().optional(),
  state: z.string().min(1)
}).refine((input) => Boolean(input.code || input.accessToken || input.access_token), {
  message: "Either code or access_token is required"
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/auth/steemconnect/url", {
    schema: { tags: ["Auth"], summary: "SteemConnect login URL erzeugen" }
  }, async () => {
    const state = createAuthState();
    return {
      url: getSteemConnectLoginUrl(state),
      state
    };
  });

  app.get("/api/auth/authority-grant-url", {
    schema: { tags: ["Auth"], summary: "Posting-Authority-Grant-URL" }
  }, async () => ({
    url: buildAuthorityGrantUrl()
  }));

  app.post("/api/auth/steemconnect/callback", {
    schema: {
      tags: ["Auth"],
      summary: "SteemConnect OAuth-Callback abschließen",
      body: zodToJsonSchema(callbackSchema),
    }
  }, async (request, reply) => {
    const input = callbackSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "invalid_request", detail: input.error.flatten() });
    }

    try {
      if (!consumeAuthState(input.data.state)) {
        return reply.code(403).send({
          error: "invalid_oauth_state",
          detail: "OAuth state is missing, expired, or already used."
        });
      }

      const accessToken = input.data.accessToken ?? input.data.access_token;
      const expiresIn = input.data.expiresIn ?? input.data.expires_in;
      const tokenData = accessToken
        ? await completeSteemConnectAccessToken(accessToken, expiresIn)
        : await exchangeSteemConnectCode(input.data.code as string);
      const session = createSession({
        username: tokenData.username,
        provider: "steemconnect",
        accessToken: tokenData.access_token
      }, tokenData.expires_in);
      grantConsent(tokenData.username, "login");

      return {
        token: session.token,
        expiry: session.expiry,
        user: {
          username: session.user.username,
          provider: session.user.provider
        }
      };
    } catch (error) {
      return reply.code(401).send({
        error: "steemconnect_auth_failed",
        detail: error instanceof Error ? error.message : "Unknown auth error"
      });
    }
  });

  app.get("/api/auth/me", {
    schema: { tags: ["Auth"], summary: "Aktuelle Session prüfen", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers.session));
    if (!session) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    return {
      user: {
        username: session.user.username,
        provider: session.user.provider
      },
      expiry: session.expiry
    };
  });

  app.post("/api/auth/signout", {
    schema: { tags: ["Auth"], summary: "Session beenden", security: [{ sessionToken: [] }] }
  }, async (request) => {
    deleteSession(getSessionHeader(request.headers.session));
    return { ok: true };
  });

  // ── Keychain Login — Phase 3 ─────────────────────────────────────────────

  app.get("/api/auth/keychain/challenge", {
    schema: { tags: ["Auth"], summary: "Keychain-Login-Challenge erzeugen" }
  }, async () => {
    return createKeychainChallenge();
  });

  const keychainVerifySchema = z.object({
    username:  z.string().min(1).max(64),
    nonce:     z.string().min(64).max(64),
    signature: z.string().min(1),
    publicKey: z.string().optional()  // returned by Keychain directly — faster than recovery
  });

  app.post("/api/auth/keychain/verify", {
    schema: {
      tags: ["Auth"],
      summary: "Keychain-Signatur verifizieren und Session erstellen",
      body: zodToJsonSchema(keychainVerifySchema),
    }
  }, async (request, reply) => {
    const input = keychainVerifySchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "invalid_request", detail: input.error.flatten() });
    }

    const { username, nonce, signature, publicKey } = input.data;

    if (!consumeKeychainChallenge(nonce)) {
      return reply.code(403).send({ error: "invalid_or_expired_challenge" });
    }

    const valid = await verifyKeychainSignature(username, nonce, signature, publicKey);
    if (!valid) {
      return reply.code(401).send({ error: "invalid_signature" });
    }

    const session = createSession({ username, provider: "keychain" });
    grantConsent(username, "login");

    return {
      token: session.token,
      expiry: session.expiry,
      user: { username: session.user.username, provider: session.user.provider }
    };
  });
}

function getSessionHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
