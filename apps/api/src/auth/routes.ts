import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { grantConsent } from "../consent/consentStore.js";
import { createSession, deleteSession, getSession } from "./sessionStore.js";
import { consumeAuthState, createAuthState } from "./stateStore.js";
import { completeSteemConnectAccessToken, exchangeSteemConnectCode, getSteemConnectLoginUrl } from "./steemConnect.js";
import { buildAuthorityGrantUrl } from "./steemConnectConfig.js";

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
  app.get("/api/auth/steemconnect/url", async () => {
    const state = createAuthState();
    return {
      url: getSteemConnectLoginUrl(state),
      state
    };
  });

  app.get("/api/auth/authority-grant-url", async () => ({
    url: buildAuthorityGrantUrl()
  }));

  app.post("/api/auth/steemconnect/callback", async (request, reply) => {
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

  app.get("/api/auth/me", async (request, reply) => {
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

  app.post("/api/auth/signout", async (request) => {
    deleteSession(getSessionHeader(request.headers.session));
    return { ok: true };
  });
}

function getSessionHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
