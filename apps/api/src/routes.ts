import {
  assessFeeVote,
  summarizeCommunityPool,
} from "@votebroker/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeAuditEvent } from "./audit/auditLog.js";
import { getSession } from "./auth/sessionStore.js";
import { broadcastSteemConnectVote } from "./auth/steemConnect.js";
import {
  broadcastServerSideVote,
  createSteemClient,
  evaluateVoteBroadcastPolicy,
  getPostingAuthority
} from "./chain/steemBroadcaster.js";
import { broadcastConfig, feePolicy } from "./config.js";
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
  weightBps: z.number().int().min(1).max(10_000),
  broadcastMode: z.enum(["server", "token"]).optional()
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
    if (!session) {
      return reply.code(401).send({ error: "authorized_session_required" });
    }

    if (!hasConsent(session.user.username, "target_vote")) {
      const body = executeVoteSchema.partial().safeParse(request.body);
      writeAuditEvent({
        type: "vote_broadcast_blocked",
        username: session.user.username,
        author: body.success ? body.data.author ?? "unknown" : "unknown",
        permlink: body.success ? body.data.permlink ?? "unknown" : "unknown",
        weightBps: body.success ? body.data.weightBps ?? 0 : 0,
        detail: "missing_consent"
      });
      return reply.code(403).send({
        error: "target_vote_consent_required",
        detail: "Der Nutzer muss Zielvotes explizit bestaetigen, bevor VoteBroker einen Vote broadcastet."
      });
    }

    const input = executeVoteSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "invalid_request", detail: input.error.flatten() });
    }

    const account = getAccount(session.user.username);
    const broadcastMode = input.data.broadcastMode ?? "server";
    writeAuditEvent({
      type: "vote_broadcast_attempt",
      username: session.user.username,
      author: input.data.author,
      permlink: input.data.permlink,
      weightBps: input.data.weightBps,
      detail: `Attempting ${broadcastMode} vote broadcast`
    });

    let transactionId: string;
    if (broadcastMode === "token") {
      if (!broadcastConfig.manualTokenFallback) {
        return reply.code(403).send({ error: "manual_token_fallback_disabled" });
      }
      if (!session.user.accessToken) {
        return reply.code(401).send({ error: "authorized_steemconnect_token_required" });
      }
      const result = await broadcastSteemConnectVote({
        accessToken: session.user.accessToken,
        voter: session.user.username,
        author: input.data.author,
        permlink: input.data.permlink,
        weightBps: input.data.weightBps
      });
      transactionId = result.transactionId;
    } else {
      const client = createSteemClient();
      const hasAuthority = await getPostingAuthority({
        client,
        username: session.user.username
      });
      const policy = evaluateVoteBroadcastPolicy({
        hasConsent: true,
        hasPostingAuthority: hasAuthority,
        hasPostingWif: Boolean(broadcastConfig.postingWif),
        accountStatus: account.status,
        fullPowerVoteUsd: account.fullPowerVoteUsd,
        weightBps: input.data.weightBps
      });
      if (!policy.allowed) {
        writeAuditEvent({
          type: "vote_broadcast_blocked",
          username: session.user.username,
          author: input.data.author,
          permlink: input.data.permlink,
          weightBps: input.data.weightBps,
          detail: policy.reason ?? "unknown"
        });
        return reply.code(policy.reason === "missing_posting_authority" ? 403 : 400).send({
          error: policy.reason
        });
      }
      const result = await broadcastServerSideVote({
        client,
        voter: session.user.username,
        author: input.data.author,
        permlink: input.data.permlink,
        weightBps: input.data.weightBps
      });
      transactionId = result.transactionId;
    }

    writeAuditEvent({
      type: "vote_broadcast_success",
      username: session.user.username,
      author: input.data.author,
      permlink: input.data.permlink,
      weightBps: input.data.weightBps,
      transactionId,
      detail: "Vote broadcast accepted"
    });

    return {
      status: "broadcast",
      voter: session.user.username,
      author: input.data.author,
      permlink: input.data.permlink,
      weightBps: input.data.weightBps,
      transactionId
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
    if (!session) {
      return reply.code(401).send({ error: "authorized_session_required" });
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
      writeAuditEvent({
        type: "fee_vote_broadcast_blocked",
        username: session.user.username,
        author: invoice.feePostAuthor,
        permlink: invoice.feePostPermlink,
        weightBps: invoice.requiredVoteWeightBps,
        detail: "missing_consent"
      });
      return reply.code(403).send({
        error: "fee_post_consent_required",
        detail: "Der Nutzer muss Fee-Post-Votes explizit bestaetigen, bevor VoteBroker Gebuehrenpost-Votes ausfuehrt."
      });
    }

    if (invoice.requiredVoteWeightBps > 0) {
      writeAuditEvent({
        type: "fee_vote_broadcast_attempt",
        username: session.user.username,
        author: invoice.feePostAuthor,
        permlink: invoice.feePostPermlink,
        weightBps: invoice.requiredVoteWeightBps,
        detail: `Attempting fee vote settlement for invoice ${invoice.id}`
      });
      const client = createSteemClient();
      const hasAuthority = await getPostingAuthority({
        client,
        username: session.user.username
      });
      const policy = evaluateVoteBroadcastPolicy({
        hasConsent: true,
        hasPostingAuthority: hasAuthority,
        hasPostingWif: Boolean(broadcastConfig.postingWif),
        accountStatus: account.status,
        fullPowerVoteUsd: account.fullPowerVoteUsd,
        weightBps: invoice.requiredVoteWeightBps
      });
      if (!policy.allowed) {
        writeAuditEvent({
          type: "fee_vote_broadcast_blocked",
          username: session.user.username,
          author: invoice.feePostAuthor,
          permlink: invoice.feePostPermlink,
          weightBps: invoice.requiredVoteWeightBps,
          detail: policy.reason ?? "unknown"
        });
        return reply.code(policy.reason === "missing_posting_authority" ? 403 : 400).send({
          error: policy.reason
        });
      }
      const result = await broadcastServerSideVote({
        client,
        voter: session.user.username,
        author: invoice.feePostAuthor,
        permlink: invoice.feePostPermlink,
        weightBps: invoice.requiredVoteWeightBps
      });
      writeAuditEvent({
        type: "fee_vote_broadcast_success",
        username: session.user.username,
        author: invoice.feePostAuthor,
        permlink: invoice.feePostPermlink,
        weightBps: invoice.requiredVoteWeightBps,
        transactionId: result.transactionId,
        detail: `Fee vote settlement accepted for invoice ${invoice.id}`
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
