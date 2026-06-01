import { createOperatorOverview } from "@votebroker/domain";
import type { FastifyInstance } from "fastify";
import { operatorConfig } from "../config.js";
import { ensureDailyFeePost } from "../chain/steemFeePost.js";
import { accounts, invoices } from "../mockStore.js";

function readHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export async function registerOperatorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/operator/overview", async (request, reply) => {
    if (!operatorConfig.token) {
      return reply.code(503).send({
        error: "operator_dashboard_not_configured",
        detail: "Set VOTEBROKER_OPERATOR_TOKEN before enabling the internal operator dashboard."
      });
    }

    const token = readHeader(request.headers["x-operator-token"]);
    if (token !== operatorConfig.token) {
      return reply.code(401).send({ error: "unauthorized_operator" });
    }

    return createOperatorOverview({
      accounts: [...accounts.values()],
      invoices: [...invoices.values()]
    });
  });

  app.post("/api/operator/ensure-fee-post", async (request, reply) => {
    if (!operatorConfig.token) {
      return reply.code(503).send({ error: "operator_dashboard_not_configured" });
    }
    const token = readHeader(request.headers["x-operator-token"]);
    if (token !== operatorConfig.token) {
      return reply.code(401).send({ error: "unauthorized_operator" });
    }

    try {
      const result = await ensureDailyFeePost({ newUsers: [] });
      return {
        permlink: result.permlink,
        author: result.author,
        alreadyExisted: result.alreadyExisted,
        url: `https://steemit.com/@${result.author}/${result.permlink}`
      };
    } catch (err) {
      return reply.code(500).send({
        error: "fee_post_creation_failed",
        detail: err instanceof Error ? err.message : "unknown"
      });
    }
  });
}
