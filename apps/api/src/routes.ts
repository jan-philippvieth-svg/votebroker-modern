import {
  assessFeeVote,
  summarizeCommunityPool,
} from "@votebroker/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
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
import { fetchVBEarnings } from "./chain/voteBrokerEarnings.js";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { hasConsent } from "./consent/consentStore.js";
import { getDb } from "./db/index.js";
import { fetchPendingCuration } from "./chain/steemPendingCuration.js";
import { getAccount, getCommunityPool, saveAccount } from "./mockStore.js";
import { getInvoice, listInvoices, saveInvoice, saveBillingAccount, loadBillingAccount } from "./billing/billingStore.js";
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
  broadcastMode: z.enum(["server", "token", "keychain"]).optional(),
  transactionId: z.string().optional()  // provided by client when broadcastMode === "keychain"
});

// Screenshots dir (same logic as contentRoutes.ts)
const PUBLIC_SCREENSHOTS_DIR = (() => {
  if (process.env.VOTEBROKER_SCREENSHOTS_DIR) return process.env.VOTEBROKER_SCREENSHOTS_DIR;
  if (existsSync("/app/data")) return "/app/data/screenshots";
  return "docs/screenshots";
})();

// Public landing-page images — only explicitly promoted screenshots live here.
// No admin, session or private data is ever written to this directory.
const PUBLIC_IMAGES_DIR = (() => {
  const base = existsSync("/app/data") ? "/app/data" : ".";
  return pathResolve(base, "public-screenshots");
})();

// Safe filename: lowercase letters, digits, dash, underscore; .png only for now.
// No slashes, no dots in the name part → path traversal impossible.
// Extend to jpg/webp when needed — each extension requires a correct Content-Type mapping.
const PUBLIC_IMG_RE = /^[a-z0-9_-]+\.png$/;

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", {
    schema: { tags: ["System"], summary: "Health-Check" }
  }, async () => ({
    status: "ok",
    service: "votebroker-api"
  }));

  // ── GET /api/public/screenshots/:file — landing page images ─────────────────
  // Only serves from PUBLIC_IMAGES_DIR (/app/data/public-screenshots/).
  // Files must be explicitly copied there — no admin/session screenshots.
  // Filename is whitelisted: [a-z0-9_-]+.(png|jpg|webp), no path components.
  app.get("/api/public/screenshots/:file", {
    schema: { tags: ["Assets"], summary: "Öffentliche Landing-Page-Screenshots" }
  }, async (request, reply) => {
    const { file } = request.params as { file: string };
    if (!PUBLIC_IMG_RE.test(file)) return reply.code(400).send({ error: "invalid_filename" });
    const filePath = pathResolve(PUBLIC_IMAGES_DIR, file);
    // Extra guard: resolved path must stay inside PUBLIC_IMAGES_DIR
    if (!filePath.startsWith(PUBLIC_IMAGES_DIR + "/")) {
      return reply.code(400).send({ error: "invalid_path" });
    }
    if (!existsSync(filePath)) return reply.code(404).send({ error: "not_found" });
    reply.header("Cache-Control", "public, max-age=86400");
    reply.type("image/png");
    return reply.send(createReadStream(filePath));
  });

  // ── GET /api/screenshots/:snap/:filename — PUBLIC, no auth ───────────────────
  // Serves annotated PNGs for Steemit/external use (devlog + product posts).
  // These are UI screenshots with secret guard applied — no auth/session data.
  // Two variants:
  //   /api/screenshots/snap-20260602/01_find_votes_annotated.png  ← devlog snapshot
  //   /api/screenshots/01_find_votes_annotated.png                ← current (product post)
  app.get("/api/screenshots/:snap/:filename", {
    schema: { tags: ["Assets"], summary: "Screenshot eines bestimmten Snapshots" }
  }, async (request, reply) => {
    const { snap, filename } = request.params as { snap: string; filename: string };
    if (!/^snap-[\d]+$/.test(snap))        return reply.code(400).send("invalid snap");
    if (!/^[\w\-]+\.png$/.test(filename))  return reply.code(400).send("invalid file");
    const snapDir  = pathResolve(PUBLIC_SCREENSHOTS_DIR, snap);
    const filePath = pathResolve(snapDir, filename);
    if (!existsSync(filePath)) return reply.code(404).send("not found");
    reply.header("Cache-Control", "public, max-age=31536000, immutable"); // snapshots never change
    reply.type("image/png");
    return reply.send(createReadStream(filePath));
  });

  app.get("/api/screenshots/:filename", {
    schema: { tags: ["Assets"], summary: "Aktueller Screenshot (latest)" }
  }, async (request, reply) => {
    const { filename } = request.params as { filename: string };
    if (!/^[\w\-]+\.png$/.test(filename)) return reply.code(400).send("invalid");
    const annotated = pathResolve(PUBLIC_SCREENSHOTS_DIR, "annotated", filename);
    const raw       = pathResolve(PUBLIC_SCREENSHOTS_DIR, filename);
    const filePath  = existsSync(annotated) ? annotated : existsSync(raw) ? raw : null;
    if (!filePath) return reply.code(404).send("not found");
    reply.header("Cache-Control", "public, max-age=86400");
    reply.type("image/png");
    return reply.send(createReadStream(filePath));
  });

  // ── GET /api/devlog/published-features — clusters already communicated ─────
  app.get("/api/devlog/published-features", {
    schema: { tags: ["Devlog"], summary: "Bereits kommunizierte Feature-Cluster (operator)" }
  }, async (request, reply) => {
    const token = (request.headers["x-operator-token"] as string | undefined) ?? "";
    if (!token || token !== operatorConfig.token || !operatorConfig.token) {
      return reply.code(403).send({ error: "operator_token_required" });
    }
    const contextType = (request.query as Record<string, string>)["context"] ?? "devlog";
    const rows = getDb().prepare(`
      SELECT story_key, cluster, summary, since_date, until_date, context_type, draft_filename, published_at
      FROM published_features
      WHERE context_type = ?
      ORDER BY published_at DESC
    `).all(contextType) as Array<{
      story_key: string; cluster: string; summary: string;
      since_date: string; until_date: string; context_type: string;
      draft_filename: string; published_at: string;
    }>;
    return { features: rows };
  });

  // ── GET /api/devlog/recent-stories — new stories for fee-report/short notices ─
  app.get("/api/devlog/recent-stories", {
    schema: { tags: ["Devlog"], summary: "Neue Storys seit letztem Fee-Report (operator)" }
  }, async (request, reply) => {
    const token = (request.headers["x-operator-token"] as string | undefined) ?? "";
    if (!token || token !== operatorConfig.token || !operatorConfig.token) {
      return reply.code(403).send({ error: "operator_token_required" });
    }
    const since = (request.query as Record<string, string>)["since"] ?? "";
    // Returns stories published in devlog context but NOT yet in fee-report context
    const rows = getDb().prepare(`
      SELECT pf.story_key, pf.cluster, pf.summary, pf.published_at
      FROM published_features pf
      WHERE pf.context_type = 'devlog'
        AND (? = '' OR pf.published_at >= ?)
        AND NOT EXISTS (
          SELECT 1 FROM published_features pf2
          WHERE pf2.story_key = pf.story_key AND pf2.context_type = 'fee-report'
        )
      ORDER BY pf.published_at DESC
    `).all(since, since) as Array<{ story_key: string; cluster: string; summary: string; published_at: string }>;
    return { stories: rows };
  });

  // ── POST /api/devlog/record-stories — records cluster-stories as communicated ─
  app.post("/api/devlog/record-stories", {
    schema: { tags: ["Devlog"], summary: "Storys als kommuniziert markieren (operator)" }
  }, async (request, reply) => {
    const token = (request.headers["x-operator-token"] as string | undefined) ?? "";
    if (!token || token !== operatorConfig.token || !operatorConfig.token) {
      return reply.code(403).send({ error: "operator_token_required" });
    }
    const body = z.object({
      draftFilename: z.string().min(1),
      contextType:   z.enum(["devlog", "product-post", "fee-report"]),
      stories: z.array(z.object({
        storyKey:  z.string().min(1),
        cluster:   z.string().min(1),
        summary:   z.string().min(1).max(300),
        sinceDate: z.string().min(1),
        untilDate: z.string().min(1),
      })).min(1).max(20),
    }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    const { draftFilename, contextType, stories } = body.data;
    const stmt = getDb().prepare(`
      INSERT OR IGNORE INTO published_features
        (story_key, cluster, summary, since_date, until_date, context_type, draft_filename)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insert = getDb().transaction(() => {
      for (const s of stories) {
        stmt.run(s.storyKey, s.cluster, s.summary, s.sinceDate, s.untilDate, contextType, draftFilename);
      }
    });
    insert();
    return { ok: true, recorded: stories.length };
  });

  // ── POST /api/devlog/generate — operator-token auth (for CI/tools) ─────────
  app.post("/api/devlog/generate", {
    schema: { tags: ["Devlog"], summary: "Devlog-Entwurf generieren (operator)" }
  }, async (request, reply) => {
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

  // ── POST /api/promo/generate — International Promo Post Pipeline ─────────────
  app.post("/api/promo/generate", {
    schema: { tags: ["Admin"], summary: "Internationalen Promo-Post generieren (operator/admin)" }
  }, async (request, reply) => {
    // Accept operator token OR admin session
    const opToken = (request.headers["x-operator-token"] as string | undefined) ?? "";
    const sessionToken = getSessionHeader(request.headers["session"]);
    const session = sessionToken ? getSession(sessionToken) : null;
    const isOperator = opToken && opToken === operatorConfig.token && !!operatorConfig.token;
    const isAdminSession = session?.user.username === "jan-philippvieth"; // admin only
    if (!isOperator && !isAdminSession) {
      return reply.code(403).send({ error: "operator_or_admin_required" });
    }

    const body = z.object({
      locale: z.enum(["en","de","es","pt","id","ru","ko","zh","ja","hi","bn","tr","pl","pcm"]),
    }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request", detail: body.error.flatten() });

    const { locale } = body.data;
    const contentDir = process.env.VOTEBROKER_CONTENT_DIR ?? "/app/data/content";

    try {
      const { generatePromoPost } = await import("./jobs/promoPost.js");
      const result = await generatePromoPost(
        locale as import("./jobs/promoPost.js").PromoLocale,
        contentDir,
        request.log as unknown as typeof console,
      );
      return result;
    } catch (err) {
      request.log.error({ err }, "promo post generation failed");
      return reply.code(500).send({
        error:  "promo_generation_failed",
        detail: err instanceof Error ? err.message : "unknown",
      });
    }
  });

  app.get("/api/account/snapshot", {
    schema: { tags: ["Account"], summary: "Steem-Account-Snapshot (VP, SP, Vote-Wert)", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
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
  app.get("/api/account/pending-curation", {
    schema: { tags: ["Account"], summary: "Offene Curation-Rewards (7-Tage-Fenster)", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
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

  app.post("/api/votes/quote", {
    schema: { tags: ["Votes"], summary: "Vote-Quote berechnen (Fee + Gewicht)", body: zodToJsonSchema(quoteSchema) }
  }, async (request, reply) => {
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

  app.post("/api/votes/execute", {
    schema: { tags: ["Votes"], summary: "Vote auf Chain broadcasten", body: zodToJsonSchema(executeVoteSchema), security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
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
    if (broadcastMode === "keychain") {
      // Vote was already signed and broadcast by Steem Keychain on the client.
      // Backend only logs the audit event — no server-side broadcast, no authority check.
      transactionId = input.data.transactionId ?? "keychain_client";
      writeAuditEvent({
        type: "vote_broadcast_success",
        username: session.user.username,
        author: input.data.author,
        permlink: input.data.permlink,
        weightBps: input.data.weightBps,
        transactionId,
        detail: `keychain_signed | txId=${transactionId}`
      });
      import("./chain/globalVoteOutcomes.js").then(({ recordVoteAtBroadcast }) =>
        recordVoteAtBroadcast({
          voter: session.user.username,
          author: input.data.author,
          permlink: input.data.permlink,
          weightBps: input.data.weightBps,
          transactionId,
        }).catch(() => {})
      ).catch(() => {});
      return { transactionId };
    } else if (broadcastMode === "token") {
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
        const isAuthority    = /unknown key|missing authority|not_valid_key|no_active_key/i.test(chainMsg);
        const isDuplicate    = /duplicate|already voted|already_voted/i.test(chainMsg);
        const isPostMissing  = /unknown key|invalid_post/i.test(chainMsg) && !isAuthority;
        // Post-specific rejections: chain rejects this particular post, not a systemic error
        const isPostSpecific = /Invalid cast|object_type|cashout_time|cannot_vote/i.test(chainMsg) && !isAuthority;
        return reply.code(400).send({
          error:  isDuplicate    ? "already_voted"
                : isAuthority   ? "missing_posting_authority"
                : isPostMissing ? "post_not_found"
                : isPostSpecific? "post_rejected"
                : "chain_rejected",
          hint:   isDuplicate    ? "Du hast diesen Post bereits gevoted."
                : isAuthority   ? "Posting Authority für @votebroker fehlt. Bitte in den Einstellungen erteilen."
                : isPostMissing ? "Post nicht gefunden — Author/Permlink ungültig oder Post existiert nicht."
                : isPostSpecific? `Post vom Node abgelehnt (übersprungen): ${chainMsg}`
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

    // Capture copilot training data: VP, post state, competition — fire and forget
    import("./chain/globalVoteOutcomes.js").then(({ recordVoteAtBroadcast }) =>
      recordVoteAtBroadcast({
        voter:         session.user.username,
        author:        input.data.author,
        permlink:      input.data.permlink,
        weightBps:     input.data.weightBps,
        transactionId: transactionId ?? null,
      }).catch(err => request.log.warn({ err }, "recordVoteAtBroadcast failed (non-critical)"))
    ).catch(() => {/* import failed — non-critical */});

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
  app.get("/api/community/discovery", {
    schema: { tags: ["Community"], summary: "Community-Autoren-Discovery (cross-strategy)", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
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
    // notice is now generated client-side via t() for proper i18n
    const notice = null;

    return {
      communityAuthors,
      discoveries,
      meta: { totalCurators, myAuthorCount: myAuthors.size, dataQuality, notice },
      computedAt: new Date().toISOString(),
    };
  });

  // ── GET /api/community/whale-signals — read cached whale discovery ───────────
  app.get("/api/community/whale-signals", {
    schema: { tags: ["Community"], summary: "Whale-Signal-Cache abrufen", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const token   = (request.headers as Record<string, string>)["session"];
    const session = token ? getSession(token) : null;
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const rulesRow = getDb().prepare(
      "SELECT rules_json FROM strategy_rules WHERE username = ?"
    ).get(session.user.username) as { rules_json: string } | undefined;
    const myAuthors = new Set<string>(
      rulesRow ? (JSON.parse(rulesRow.rules_json) as Array<{ username: string; category: string }>)
        .filter(r => r.category !== "ignorieren").map(r => r.username) : []
    );

    const { getWhaleSignals } = await import("./chain/whaleSignals.js");
    const result = getWhaleSignals(myAuthors);

    // Annotate with inMyStrategy
    return {
      ...result,
      signals: result.signals.map(s => ({
        ...s,
        inMyStrategy: myAuthors.has(s.author),
      })),
    };
  });

  // ── POST /api/community/whale-signals/refresh — operator-triggered rebuild ───
  app.post("/api/community/whale-signals/refresh", {
    schema: { tags: ["Community"], summary: "Whale-Signals neu aufbauen (operator)" }
  }, async (request, reply) => {
    const opToken = (request.headers as Record<string, string>)["x-operator-token"];
    if (!opToken || opToken !== operatorConfig.token) {
      return reply.code(403).send({ error: "operator_token_required" });
    }
    try {
      const { rebuildWhaleSignals, SEED_WHALES } = await import("./chain/whaleSignals.js");
      const result = await rebuildWhaleSignals(
        SEED_WHALES, 30,
        request.log as unknown as typeof console,
      );
      return { ...result, refreshedAt: new Date().toISOString() };
    } catch (err) {
      return reply.code(502).send({
        error: "whale_signals_refresh_failed",
        detail: err instanceof Error ? err.message : "unknown",
      });
    }
  });

  app.get("/api/community/overview", {
    schema: { tags: ["Community"], summary: "Community-Pool-Übersicht" }
  }, async (request, reply) => {
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

  app.post("/api/fees/settle", {
    schema: { tags: ["Votes"], summary: "Fee-Rechnung begleichen (Fee-Post-Vote)", body: zodToJsonSchema(settleSchema), security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers.session));
    if (!session) {
      return reply.code(401).send({ error: "authorized_session_required" });
    }

    const input = settleSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({ error: "invalid_request", detail: input.error.flatten() });
    }

    const invoice = getInvoice(input.data.invoiceId);   // reads from SQLite, survives restarts
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
    saveInvoice(assessment.invoice);   // persist updated invoice status (settled/underfunded)
    const updatedAccount = {
      ...account,
      status: assessment.accountStatus,
      consecutiveUnderfundedFees:
        assessment.invoice.status === "settled" ? 0 : account.consecutiveUnderfundedFees + 1
    };
    saveAccount(updatedAccount);
    saveBillingAccount(updatedAccount);   // persist account billing state

    return assessment;
  });
}

function getSessionHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// ── Today's votes — for dashboard (persisted, survives tab switch / reload) ──
export function registerTodayVotesRoute(app: FastifyInstance): void {
  app.get("/api/votes/today", {
    schema: { tags: ["Votes"], summary: "Heutige Votes gruppiert nach Runs", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
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
