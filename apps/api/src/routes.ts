import {
  assessFeeVote,
  summarizeCommunityPool,
} from "@votebroker/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { feePolicy } from "./config.js";
import { hasConsent } from "./consent/consentStore.js";
import { getAccount, getCommunityPool, invoices, saveAccount } from "./mockStore.js";
import { voteBrokerWorkflow } from "./workflows.js";

const quoteSchema = z.object({
  username: z.string().min(1),
  author: z.string().min(1),
  permlink: z.string().min(1),
  desiredVoteUsd: z.number().positive(),
  timingMode: z.enum(["manual", "auto"]).optional(),
  voteDelayMinutes: z.number().int().min(5).max(30).optional(),
  postCreatedAt: z.string().datetime().optional()
});

const settleSchema = z.object({
  invoiceId: z.string().min(1)
});

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    status: "ok",
    service: "votebroker-api"
  }));

  app.post("/api/votes/quote", async (request, reply) => {
    const input = quoteSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "invalid_request", detail: input.error.flatten() });
    }

    const { account, quote, invoice } = await voteBrokerWorkflow.quotePostVote(input.data);

    return {
      account,
      quote,
      feeInvoice: invoice,
      feePolicy
    };
  });

  app.get("/api/community/overview", async (request, reply) => {
    const query = z.object({
      username: z.string().min(1).optional(),
      pool: z.string().min(1).optional()
    }).safeParse(request.query);

    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request", detail: query.error.flatten() });
    }

    const username = query.data.username ?? "demo";
    const pool = getCommunityPool(query.data.pool);
    const account = getAccount(username);

    return summarizeCommunityPool({ account, pool, username });
  });

  app.post("/api/fees/settle", async (request, reply) => {
    const input = settleSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "invalid_request", detail: input.error.flatten() });
    }

    const invoice = invoices.get(input.data.invoiceId);
    if (!invoice) {
      return reply.code(404).send({ error: "invoice_not_found" });
    }

    const account = getAccount(invoice.username);
    if (!hasConsent(account.username, "fee_post_vote")) {
      return reply.code(403).send({
        error: "fee_post_consent_required",
        detail: "Der Nutzer muss Fee-Post-Votes explizit bestaetigen, bevor VoteBroker Gebuehrenpost-Votes ausfuehrt."
      });
    }

    const assessment = assessFeeVote({ account, invoice, policy: feePolicy });
    invoices.set(invoice.id, assessment.invoice);
    saveAccount({
      ...account,
      status: assessment.accountStatus,
      consecutiveUnderfundedFees:
        assessment.invoice.status === "settled" ? 0 : account.consecutiveUnderfundedFees + 1
    });

    return assessment;
  });
}
