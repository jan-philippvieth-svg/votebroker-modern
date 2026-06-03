import type { ConsentType } from "@votebroker/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSession } from "../auth/sessionStore.js";
import { consentCatalog, getConsentState, grantConsent, revokeConsent } from "./consentStore.js";

const consentTypeSchema = z.enum(["login", "target_vote", "fee_post_vote", "auto_vote", "ai_strategy", "community_intelligence"]);
const consentRequestSchema = z.object({
  type: consentTypeSchema
});

export async function registerConsentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/consents/catalog", async () => ({
    consents: Object.values(consentCatalog)
  }));

  app.get("/api/consents", async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers.session));
    if (!session) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    return getConsentState(session.user.username);
  });

  app.post("/api/consents/grant", async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers.session));
    if (!session) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const input = consentRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "invalid_request", detail: input.error.flatten() });
    }

    const record = grantConsent(session.user.username, input.data.type as ConsentType);
    return {
      record,
      state: getConsentState(session.user.username)
    };
  });

  app.post("/api/consents/revoke", async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers.session));
    if (!session) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const input = consentRequestSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "invalid_request", detail: input.error.flatten() });
    }

    const record = revokeConsent(session.user.username, input.data.type as ConsentType);
    return {
      record,
      state: getConsentState(session.user.username)
    };
  });
}

function getSessionHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
