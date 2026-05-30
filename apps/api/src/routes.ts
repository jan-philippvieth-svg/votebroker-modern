import {
  assessFeeVote,
  summarizeCommunityPool,
} from "@votebroker/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSession } from "./auth/sessionStore.js";
import { broadcastSteemConnectVote } from "./auth/steemConnect.js";
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
  postCreatedAt: z.string().datetime().optional(),
  plannedVotesToday: z.number().int().min(1).max(200).optional(),
  targetVotingPowerBps: z.number().int().min(0).max(10_000).optional()
});

const settleSchema = z.object({
  invoiceId: z.string().min(1)
});

const executeVoteSchema = z.object({
  author: z.string().min(1),
  permlink: z.string().min(1),
  weightBps: z.number().int().min(1).max(10_000)
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

  app.post("/api/votes/execute", async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers.session));
    if (!session?.user.accessToken) {
      return reply.code(401).send({ error: "authorized_steemconnect_session_required" });
    }

    if (!hasConsent(session.user.username, "target_vote")) {
      return reply.code(403).send({
        error: "target_vote_consent_required",
        detail: "Der Nutzer muss Zielvotes explizit bestaetigen, bevor VoteBroker einen Vote broadcastet."
      });
    }

    const input = executeVoteSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "invalid_request", detail: input.error.flatten() });
    }

    const result = await broadcastSteemConnectVote({
      accessToken: session.user.accessToken,
      voter: session.user.username,
      author: input.data.author,
      permlink: input.data.permlink,
      weightBps: input.data.weightBps
    });

    return {
      status: "broadcast",
      voter: session.user.username,
      author: input.data.author,
      permlink: input.data.permlink,
      weightBps: input.data.weightBps,
      transactionId: result.transactionId
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
    const session = getSession(getSessionHeader(request.headers.session));
    if (!session?.user.accessToken) {
      return reply.code(401).send({ error: "authorized_steemconnect_session_required" });
    }

    const input = settleSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "invalid_request", detail: input.error.flatten() });
    }

    const invoice = invoices.get(input.data.invoiceId);
    if (!invoice) {
      return reply.code(404).send({ error: "invoice_not_found" });
    }

    const account = getAccount(invoice.username);
    if (session.user.username !== account.username) {
      return reply.code(403).send({ error: "invoice_user_mismatch" });
    }

    if (!hasConsent(account.username, "fee_post_vote")) {
      return reply.code(403).send({
        error: "fee_post_consent_required",
        detail: "Der Nutzer muss Fee-Post-Votes explizit bestaetigen, bevor VoteBroker Gebuehrenpost-Votes ausfuehrt."
      });
    }

    if (invoice.requiredVoteWeightBps > 0) {
      await broadcastSteemConnectVote({
        accessToken: session.user.accessToken,
        voter: session.user.username,
        author: invoice.feePostAuthor,
        permlink: invoice.feePostPermlink,
        weightBps: invoice.requiredVoteWeightBps
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

function getSessionHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
