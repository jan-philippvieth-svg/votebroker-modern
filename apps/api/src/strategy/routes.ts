import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSession } from "../auth/sessionStore.js";
import { deleteStrategy, loadStrategy, saveStrategy } from "./strategyStore.js";

function getSessionHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function registerStrategyRoutes(app: FastifyInstance): Promise<void> {

  // GET /api/strategy — load user's persisted strategy
  app.get("/api/strategy", async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers.session));
    if (!session) {
      return reply.code(401).send({ error: "authorized_session_required" });
    }
    const rules = loadStrategy(session.user.username);
    return { username: session.user.username, rules };
  });

  // POST /api/strategy — save user's strategy
  app.post("/api/strategy", async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers.session));
    if (!session) {
      return reply.code(401).send({ error: "authorized_session_required" });
    }

    const body = z.object({
      rules: z.array(z.record(z.unknown())).max(200)
    }).safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", detail: body.error.flatten() });
    }

    saveStrategy(session.user.username, body.data.rules);
    return { ok: true, savedRules: body.data.rules.length };
  });

  // DELETE /api/strategy — clear user's strategy
  app.delete("/api/strategy", async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers.session));
    if (!session) {
      return reply.code(401).send({ error: "authorized_session_required" });
    }
    deleteStrategy(session.user.username);
    return { ok: true };
  });
}
