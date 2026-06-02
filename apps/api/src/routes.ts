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
import { getCachedAuthority, setCachedAuthority } from "./chain/authorityCache.js";
import { fetchSteemAccountSnapshot } from "./chain/steemAccount.js";
import { broadcastConfig, feePolicy, operatorConfig } from "./config.js";
import { generateDevlogDraft } from "./jobs/dailyDevlog.js";
import { hasConsent } from "./consent/consentStore.js";
import { getDb } from "./db/index.js";
import { fetchPendingCuration } from "./chain/steemPendingCuration.js";
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

  // ── POST /api/devlog/generate — operator-token auth (for CI/tools) ─────────
  app.post("/api/devlog/generate", async (request, reply) => {
    const token = (request.headers["x-operator-token"] as string | undefined) ?? "";
    if (!token || token !== operatorConfig.token || !operatorConfig.token) {
      return reply.code(403).send({ error: "operator_token_required" });
    }
    const changeSchema = z.object({
      type:        z.enum(["feat", "fix", "ux", "perf", "refactor", "other"]),
      description: z.string().min(1).max(500),
    });
    const body = z.object({
      date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      changes:     z.array(changeSchema).max(50).optional(),
      nextItems:   z.array(z.string().min(1).max(300)).max(10).optional(),
      screenshots: z.array(z.string().min(1).max(200)).max(10).optional(),
      sinceDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      force:       z.boolean().optional(),
    }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request", detail: body.error.flatten() });

    const { date, ...opts } = body.data;
    const result = await generateDevlogDraft(request.log as unknown as typeof console, {
      ...opts,
      date: date ? new Date(date + "T12:00:00Z") : new Date(),
    });
    if (result.status === "failed") return reply.code(500).send({ error: "generation_failed", reason: result.reason });
    return result;
  });

  app.get("/api/account/snapshot", async (request, reply) => {
    const query = z.object({ username: z.string().min(1) }).safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request", detail: "username is required" });
    }
    try {
      return await fetchSteemAccountSnapshot(query.data.username);
    } catch (err) {
      return reply.code(404).send({
        error: "account_not_found",
        detail: err instanceof Error ? err.message : "unknown"
      });
    }
  });

  // Pending curation (7-day window) — authenticated, per-user
  app.get("/api/account/pending-curation", async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers["session"]));
    if (!session) return reply.code(401).send({ error: "unauthorized" });
    const query = z.object({ steemPriceUsd: z.coerce.number().positive().optional() }).safeParse(request.query);
    const sbdPerSteem = query.success && query.data.steemPriceUsd ? query.data.steemPriceUsd : 0.05;
    try {
      return await fetchPendingCuration(session.user.username, sbdPerSteem);
    } catch (err) {
      return reply.code(500).send({ error: "pending_curation_failed", detail: err instanceof Error ? err.message : "unknown" });
    }
  });

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
      return reply.code(401).send({
        error: "authorized_session_required",
        hint: "Session expired or missing. Please log in again via SteemConnect."
      });
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
        hint: "Grant Vote-Consent under Settings tab before broadcasting votes."
      });
    }

    const input = executeVoteSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "invalid_request", detail: input.error.flatten() });
    }

    // Use real Steem account data for policy checks — NOT the mockStore
    // (mockStore returns fullPowerVoteUsd=0 for unknown users, blocking legitimate votes)
    let liveFullPowerVoteUsd = 0;
    let liveStatus: "active" | "warning" | "paused" | "payment_required" = "active";
    try {
      const liveSnap = await fetchSteemAccountSnapshot(session.user.username);
      liveFullPowerVoteUsd = liveSnap.fullPowerVoteUsd;
    } catch {
      // Fall back to mockStore if Steem API unreachable
      const cached = getAccount(session.user.username);
      liveFullPowerVoteUsd = cached.fullPowerVoteUsd;
      liveStatus = cached.status;
    }

    const broadcastMode = input.data.broadcastMode ?? "server";
    writeAuditEvent({
      type: "vote_broadcast_attempt",
      username: session.user.username,
      author: input.data.author,
      permlink: input.data.permlink,
      weightBps: input.data.weightBps,
      detail: `Attempting ${broadcastMode} broadcast | fullPowerVoteUsd=${liveFullPowerVoteUsd.toFixed(4)}`
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
      const cached = getCachedAuthority(session.user.username);
      const hasAuthority = cached !== null ? cached : await getPostingAuthority({ client, username: session.user.username });
      if (cached === null) setCachedAuthority(session.user.username, hasAuthority);

      const policy = evaluateVoteBroadcastPolicy({
        hasConsent:          true,
        hasPostingAuthority: hasAuthority,
        hasPostingWif:       Boolean(broadcastConfig.postingWif),
        accountStatus:       liveStatus,
        fullPowerVoteUsd:    liveFullPowerVoteUsd,
        weightBps:           input.data.weightBps
      });

      if (!policy.allowed) {
        writeAuditEvent({
          type: "vote_broadcast_blocked",
          username: session.user.username,
          author: input.data.author,
          permlink: input.data.permlink,
          weightBps: input.data.weightBps,
          detail: `blocked: ${policy.reason} | hasAuthority=${hasAuthority} | hasWif=${Boolean(broadcastConfig.postingWif)} | fullPowerVoteUsd=${liveFullPowerVoteUsd}`
        });
        const hintMap: Record<string, string> = {
          missing_posting_wif:       "Server is not configured with a posting key. Contact the operator.",
          missing_posting_authority: "Grant posting authority to @votebroker via SteemConnect (Settings tab).",
          account_paused:            "Account is paused. Settle outstanding fees.",
          implausible_quote:         `Vote value is zero — account ${session.user.username} has no Steem Power or the Steem API was unreachable.`,
          invalid_weight:            "Vote weight is out of range (1–10000 BPS).",
        };
        return reply.code(policy.reason === "missing_posting_authority" ? 403 : 400).send({
          error: policy.reason,
          hint: hintMap[policy.reason ?? ""] ?? "Check account status.",
          debug: { hasAuthority, hasWif: Boolean(broadcastConfig.postingWif), fullPowerVoteUsd: liveFullPowerVoteUsd }
        });
      }

      // Broadcast — catch chain-level errors explicitly
      let result: { transactionId: string; confirmed: boolean };
      try {
        result = await broadcastServerSideVote({
          client,
          voter:     session.user.username,
          author:    input.data.author,
          permlink:  input.data.permlink,
          weightBps: input.data.weightBps
        });
      } catch (err) {
        const chainMsg = err instanceof Error ? err.message : String(err);
        writeAuditEvent({
          type: "vote_broadcast_blocked",
          username: session.user.username,
          author:   input.data.author,
          permlink: input.data.permlink,
          weightBps: input.data.weightBps,
          detail:   `chain rejection: ${chainMsg}`
        });
        // Map known Steem chain errors to actionable messages
        const isAuthority   = /unknown key|missing authority|not_valid_key|no_active_key/i.test(chainMsg);
        const isDuplicate   = /duplicate|already voted|already_voted/i.test(chainMsg);
        const isPostMissing = /unknown key|invalid_post/i.test(chainMsg) && !isAuthority;
        return reply.code(400).send({
          error:  isDuplicate   ? "already_voted"
                : isAuthority  ? "missing_posting_authority"
                : isPostMissing? "post_not_found"
                : "chain_rejected",
          hint:   isDuplicate   ? "Du hast diesen Post bereits gevoted."
                : isAuthority  ? "Posting Authority für @votebroker fehlt. Bitte in den Einstellungen erteilen."
                : isPostMissing? "Post nicht gefunden — Author/Permlink ungültig oder Post existiert nicht."
                : `Blockchain-Fehler: ${chainMsg}`,
          detail: chainMsg
        });
      }

      transactionId = result.transactionId;
      if (!result.confirmed) {
        request.log.warn({ transactionId, voter: session.user.username, author: input.data.author },
          "Broadcast returned non-hash txId — possible silent failure");
      }
    }

    writeAuditEvent({
      type: "vote_broadcast_success",
      username: session.user.username,
      author: input.data.author,
      permlink: input.data.permlink,
      weightBps: input.data.weightBps,
      transactionId,
      detail: `broadcast accepted | txId=${transactionId}`
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

  // ── Community Discovery — real data from strategy_rules + audit_events ────
  app.get("/api/community/discovery", async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers["session"]));
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const me = session.user.username;
    const db = getDb();

    const allRows = db.prepare(
      "SELECT username, rules_json FROM strategy_rules"
    ).all() as Array<{ username: string; rules_json: string }>;

    const myRow = allRows.find(r => r.username === me);
    const myRules: Array<{ username: string; category: string }> =
      myRow ? JSON.parse(myRow.rules_json) : [];
    const myAuthors = new Set(
      myRules.filter(r => r.category !== "ignorieren").map(r => r.username)
    );

    // Aggregate author presence across all OTHER strategies
    const authorMap = new Map<string, { curators: string[]; categories: string[] }>();
    for (const row of allRows) {
      if (row.username === me) continue;
      const rules: Array<{ username: string; category: string }> = JSON.parse(row.rules_json);
      for (const rule of rules) {
        if (rule.category === "ignorieren") continue;
        if (!authorMap.has(rule.username)) authorMap.set(rule.username, { curators: [], categories: [] });
        const e = authorMap.get(rule.username)!;
        e.curators.push(row.username);
        e.categories.push(rule.category);
      }
    }

    // Vote activity from audit_events (last 30 days)
    const since30d = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const activity = db.prepare(`
      SELECT author, COUNT(*) as cnt, MAX(created_at) as last_at
      FROM audit_events
      WHERE type = 'vote_broadcast_attempt' AND author IS NOT NULL AND created_at >= ?
      GROUP BY author
    `).all(since30d) as Array<{ author: string; cnt: number; last_at: string }>;
    const actMap = new Map(activity.map(a => [a.author, { votes: a.cnt, lastAt: a.last_at }]));

    const catLabels: Record<string, string> = {
      immer_voten: "Immer voten", lieblingsautor: "Lieblingsautor",
      bevorzugt: "Bevorzugt", normal: "Normal", niedrig: "Niedrig",
    };

    const buildCard = (username: string, entry: { curators: string[]; categories: string[] }) => {
      const act = actMap.get(username);
      const catCounts = new Map<string, number>();
      for (const c of entry.categories) catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
      const topCategory = [...catCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "normal";
      const reasons: string[] = [];
      if (entry.curators.length === 1) reasons.push("1 weiterer Kurator unterstützt diesen Autor");
      else reasons.push(`${entry.curators.length} Kuratoren unterstützen diesen Autor`);
      if (act && act.votes > 0) reasons.push(`${act.votes} Votes in den letzten 30 Tagen`);
      return {
        username,
        curatorCount: entry.curators.length,
        topCategory,
        topCategoryLabel: catLabels[topCategory] ?? topCategory,
        recentVotes: act?.votes ?? 0,
        lastVotedAt: act?.lastAt ?? null,
        reasons,
        inMyStrategy: myAuthors.has(username),
      };
    };

    const communityAuthors = [...authorMap.entries()]
      .filter(([u, e]) => e.curators.length >= 2 && !myAuthors.has(u))
      .map(([u, e]) => buildCard(u, e))
      .sort((a, b) => b.curatorCount - a.curatorCount);

    const discoveries = [...authorMap.entries()]
      .filter(([u]) => !myAuthors.has(u))
      .map(([u, e]) => buildCard(u, e))
      .sort((a, b) => b.curatorCount - a.curatorCount || b.recentVotes - a.recentVotes)
      .slice(0, 20);

    const totalCurators = allRows.length;
    const dataQuality: "rich" | "sparse" | "empty" =
      totalCurators >= 5 ? "rich" : totalCurators >= 2 ? "sparse" : "empty";
    const notice =
      dataQuality === "empty"
        ? "Noch keine anderen Kuratoren in der Community."
        : dataQuality === "sparse"
        ? `${totalCurators} aktive Kuratoren — Empfehlungen werden aussagekräftiger, je mehr Nutzer VoteBroker einsetzen.`
        : null;

    return {
      communityAuthors,
      discoveries,
      meta: { totalCurators, myAuthorCount: myAuthors.size, dataQuality, notice },
      computedAt: new Date().toISOString(),
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
      const cached = getCachedAuthority(session.user.username);
      const hasAuthority = cached !== null ? cached : await getPostingAuthority({ client, username: session.user.username });
      if (cached === null) setCachedAuthority(session.user.username, hasAuthority);
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

// ── Today's votes — for dashboard (persisted, survives tab switch / reload) ──
export function registerTodayVotesRoute(app: FastifyInstance): void {
  app.get("/api/votes/today", async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers["session"]));
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const db = getDb();
    type VoteRow = { author: string; permlink: string; weight_bps: number; transaction_id: string; created_at: string };
    const rows = db.prepare(`
      SELECT author, permlink, weight_bps, transaction_id, created_at
      FROM audit_events
      WHERE type = 'vote_broadcast_success'
        AND username = ?
        AND date(created_at) = date('now')
      ORDER BY created_at ASC
    `).all(session.user.username) as VoteRow[];

    // Group votes into runs (gap > 120s = new run)
    type Run = { votes: VoteRow[]; startedAt: string; endedAt: string };
    const runs: Run[] = [];
    let cur: VoteRow[] = [];
    let lastMs = 0;
    for (const v of rows) {
      const ms = new Date(v.created_at).getTime();
      if (cur.length === 0 || ms - lastMs <= 120_000) {
        cur.push(v);
      } else {
        runs.push({ votes: cur, startedAt: cur[0].created_at, endedAt: cur[cur.length - 1].created_at });
        cur = [v];
      }
      lastMs = ms;
    }
    if (cur.length > 0) runs.push({ votes: cur, startedAt: cur[0].created_at, endedAt: cur[cur.length - 1].created_at });

    const uniqueAuthors  = new Set(rows.map(v => v.author)).size;
    const totalWeightBps = rows.reduce((s, v) => s + (v.weight_bps ?? 0), 0);

    const allRuns = runs.map(r => ({
      startedAt: r.startedAt,
      endedAt:   r.endedAt,
      voteCount: r.votes.length,
      authors:   [...new Set(r.votes.map(v => v.author))],
      weightBps: r.votes.reduce((s, v) => s + (v.weight_bps ?? 0), 0),
    }));

    return {
      totalVotes:    rows.length,
      runsCount:     runs.length,
      uniqueAuthors,
      totalWeightBps,
      runs:          allRuns,
      lastRun:       allRuns.length > 0 ? allRuns[allRuns.length - 1] : null,
      votes: rows.map(v => ({
        author:        v.author,
        permlink:      v.permlink,
        weightBps:     v.weight_bps ?? 0,
        transactionId: v.transaction_id,
        votedAt:       v.created_at,
      })),
    };
  });
}
