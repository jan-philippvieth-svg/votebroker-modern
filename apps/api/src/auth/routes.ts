import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createSession, deleteSession, getSession } from "./sessionStore.js";
import { exchangeSteemConnectCode, getSteemConnectLoginUrl } from "./steemConnect.js";

const callbackSchema = z.object({
  code: z.string().min(1)
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/auth/steemconnect/url", async (request) => {
    const state = typeof request.query === "object" && request.query
      ? (request.query as { state?: string }).state
      : undefined;
    return {
      url: getSteemConnectLoginUrl(state)
    };
  });

  app.post("/api/auth/steemconnect/callback", async (request, reply) => {
    const input = callbackSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "invalid_request", detail: input.error.flatten() });
    }

    try {
      const tokenData = await exchangeSteemConnectCode(input.data.code);
      const session = createSession({
        username: tokenData.username,
        provider: "steemconnect",
        accessToken: tokenData.access_token
      });

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
