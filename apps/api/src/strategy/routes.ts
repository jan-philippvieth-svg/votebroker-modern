import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getSession } from "../auth/sessionStore.js";
import { deleteStrategy, loadStrategy, saveStrategy } from "./strategyStore.js";
import { getDb } from "../db/index.js";
import { calcOpportunityScore, OPPORTUNITY_GATE } from "../chain/opportunityScore.js";

function getSessionHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const saveStrategySchema = z.object({
  rules: z.array(z.record(z.unknown())).max(200)
});

export async function registerStrategyRoutes(app: FastifyInstance): Promise<void> {

  // GET /api/strategy — load user's persisted strategy
  app.get("/api/strategy", {
    schema: { tags: ["Strategy"], summary: "Gespeicherte Strategie laden", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers.session));
    if (!session) {
      return reply.code(401).send({ error: "authorized_session_required" });
    }
    const rules = loadStrategy(session.user.username);
    return { username: session.user.username, rules };
  });

  // POST /api/strategy — save user's strategy
  app.post("/api/strategy", {
    schema: { tags: ["Strategy"], summary: "Strategie speichern", body: zodToJsonSchema(saveStrategySchema), security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers.session));
    if (!session) {
      return reply.code(401).send({ error: "authorized_session_required" });
    }

    const body = saveStrategySchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", detail: body.error.flatten() });
    }

    saveStrategy(session.user.username, body.data.rules);
    return { ok: true, savedRules: body.data.rules.length };
  });

  // DELETE /api/strategy — clear user's strategy
  app.delete("/api/strategy", {
    schema: { tags: ["Strategy"], summary: "Strategie löschen", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers.session));
    if (!session) {
      return reply.code(401).send({ error: "authorized_session_required" });
    }
    deleteStrategy(session.user.username);
    return { ok: true };
  });

  // GET /api/me/copilot/shadow-log — review CoPilot shadow-run decisions
  app.get("/api/me/copilot/shadow-log", {
    schema: {
      tags: ["Strategy"],
      summary: "CoPilot Shadow-Log — hypothetische Voting-Entscheidungen der letzten Dry-Runs",
      security: [{ sessionToken: [] }],
      querystring: zodToJsonSchema(z.object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        decision: z.enum(["would_vote", "skip_score", "skip_no_posts", "skip_already_voted", "skip_budget", "all"]).default("all"),
      })),
    }
  }, async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers.session));
    if (!session) return reply.code(401).send({ error: "authorized_session_required" });

    const query = z.object({
      limit:    z.coerce.number().int().min(1).max(500).default(100),
      decision: z.enum(["would_vote", "skip_score", "skip_no_posts", "skip_already_voted", "skip_budget", "all"]).default("all"),
    }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_request" });

    const { limit, decision } = query.data;
    const username = session.user.username;
    const db = getDb();

    const rows = decision === "all"
      ? db.prepare(`
          SELECT * FROM vb_copilot_shadow_runs
          WHERE username = ?
          ORDER BY run_at DESC, created_at DESC
          LIMIT ?
        `).all(username, limit)
      : db.prepare(`
          SELECT * FROM vb_copilot_shadow_runs
          WHERE username = ? AND decision = ?
          ORDER BY run_at DESC, created_at DESC
          LIMIT ?
        `).all(username, decision, limit);

    // Group by run_id for easier review
    type RawRow = {
      run_id: string; run_at: string; decision: string;
      author: string | null; permlink: string | null; title: string | null;
      category: string | null; post_score: number | null; score_gate: number | null;
      suggested_weight_bps: number | null; vp_cost_bps: number | null;
      expected_vote_usd: number | null; reasons_json: string | null;
      skip_reason: string | null; vp_bps_at_run: number; vp_budget_bps: number;
      signals_json: string | null; created_at: string;
    };

    const typed = rows as RawRow[];
    const runMap = new Map<string, { run_id: string; run_at: string; vp_bps: number; vp_budget_bps: number; entries: object[] }>();

    for (const row of typed) {
      if (!runMap.has(row.run_id)) {
        runMap.set(row.run_id, {
          run_id:       row.run_id,
          run_at:       row.run_at,
          vp_bps:       row.vp_bps_at_run,
          vp_budget_bps: row.vp_budget_bps,
          entries:      [],
        });
      }
      runMap.get(row.run_id)!.entries.push({
        decision:             row.decision,
        author:               row.author,
        permlink:             row.permlink,
        title:                row.title,
        category:             row.category,
        postScore:            row.post_score,
        scoreGate:            row.score_gate,
        suggestedWeightBps:   row.suggested_weight_bps,
        vpCostBps:            row.vp_cost_bps,
        expectedVoteUsd:      row.expected_vote_usd,
        reasons:              row.reasons_json ? JSON.parse(row.reasons_json) : [],
        skipReason:           row.skip_reason,
        signals:              row.signals_json ? JSON.parse(row.signals_json) : {},
      });
    }

    const runs = [...runMap.values()];
    const summary = {
      totalRuns:       runs.length,
      totalDecisions:  typed.length,
      wouldVoteCount:  typed.filter(r => r.decision === "would_vote").length,
      skipScoreCount:  typed.filter(r => r.decision === "skip_score").length,
      skipBudgetCount: typed.filter(r => r.decision === "skip_budget").length,
      skipNoPostsCount: typed.filter(r => r.decision === "skip_no_posts").length,
      skipAlreadyVotedCount: typed.filter(r => r.decision === "skip_already_voted").length,
    };

    return { username, summary, runs };
  });

  // GET /api/me/copilot/retrospective — simulate CoPilot decisions on historical votes
  app.get("/api/me/copilot/retrospective", {
    schema: {
      tags: ["Strategy"],
      summary: "CoPilot Retrospektive — hätte der CoPilot meine Votes so getroffen?",
      security: [{ sessionToken: [] }],
      querystring: zodToJsonSchema(z.object({
        days: z.coerce.number().int().min(1).max(30).default(7),
      })),
    }
  }, async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers.session));
    if (!session) return reply.code(401).send({ error: "authorized_session_required" });

    const query = z.object({ days: z.coerce.number().int().min(1).max(30).default(7) })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_request" });

    const username = session.user.username;
    const since    = new Date(Date.now() - query.data.days * 24 * 3600 * 1000).toISOString();
    const db       = getDb();

    // Load current strategy to get maxWeightPct per author
    const rawRules = (loadStrategy(username) ?? []) as Array<{
      username: string; category: string; maxWeightPct: number; enabled: boolean;
    }>;
    const strategyMap = new Map(rawRules.map(r => [r.username, r]));

    // Fetch votes with strategy_category, delay data, and whale signal (LEFT JOIN)
    type VoteRow = {
      author: string; permlink: string; voted_at: string;
      vote_delay_minutes: number | null; weight_bps: number;
      strategy_category: string; vp_at_vote_bps: number | null;
      estimated_vote_value_sbd: number | null; realized_curation_sp: number | null;
      is_self_post: number;
      whale_follow_rate: number | null; whale_count: number | null;
    };

    const votes = db.prepare(`
      SELECT gvo.author, gvo.permlink, gvo.voted_at, gvo.vote_delay_minutes, gvo.weight_bps,
             gvo.strategy_category, gvo.vp_at_vote_bps, gvo.estimated_vote_value_sbd,
             gvo.realized_curation_sp, gvo.is_self_post,
             sa.whale_follow_rate, sa.whale_count
      FROM vb_global_vote_outcomes gvo
      LEFT JOIN vb_signal_author sa ON gvo.author = sa.author
      WHERE gvo.voter = ? AND gvo.voted_at >= ? AND gvo.strategy_category IS NOT NULL
        AND gvo.vote_delay_minutes IS NOT NULL
      ORDER BY gvo.voted_at DESC
    `).all(username, since) as VoteRow[];

    const PAYOUT_WINDOW_HOURS = 7 * 24;

    const entries = votes.map(v => {
      const delay         = v.vote_delay_minutes!;
      const remainingHours = Math.max(0, PAYOUT_WINDOW_HOURS - delay / 60);
      const rule          = strategyMap.get(v.author);
      const copilotWeightBps = rule ? Math.round(rule.maxWeightPct * 100) : null;

      // Composite opportunity score — same logic as shadow job
      const whaleFollowRate = v.whale_follow_rate != null
        ? Math.min(1, (v.whale_count ?? 0) / 10)
        : undefined;

      const opp = calcOpportunityScore({
        ageMinutes:      delay,
        remainingHours,
        category:        v.strategy_category,
        whaleFollowRate,
        isSelfPost:      v.is_self_post === 1,
      });

      const wouldCopilotVote = opp.wouldAct && rule !== undefined;

      // Timing: CoPilot fires every 30 min, earliest after 5 min post age
      const copilotFirstTickMin = v.is_self_post ? 0 : 30;
      const timingDeltaMin = Math.round(delay - copilotFirstTickMin);

      let skipReason: string | null = null;
      if (!opp.wouldAct) {
        skipReason = opp.skipReason ?? `opportunityScore ${opp.score} < gate ${OPPORTUNITY_GATE}`;
      } else if (!rule) {
        skipReason = "Autor nicht (mehr) in aktueller Strategie";
      }

      const verdict: "same" | "would_skip" | "different_weight" | "not_in_strategy" =
        !opp.wouldAct               ? "would_skip" :
        !rule                       ? "not_in_strategy" :
        copilotWeightBps === v.weight_bps ? "same" :
        "different_weight";

      return {
        author:               v.author,
        permlink:             v.permlink,
        votedAt:              v.voted_at,
        category:             v.strategy_category,
        isSelfPost:           v.is_self_post === 1,

        // Opportunity score (composite)
        opportunityScore:     opp.score,
        opportunityGate:      OPPORTUNITY_GATE,
        opportunityComponents: opp.components,
        wouldCopilotVote,

        // Weight analysis
        actualWeightBps:      v.weight_bps,
        actualWeightPct:      Math.round(v.weight_bps / 100 * 10) / 10,
        copilotWeightBps,
        copilotWeightPct:     copilotWeightBps !== null ? Math.round(copilotWeightBps / 100 * 10) / 10 : null,
        weightDeltaBps:       copilotWeightBps !== null ? copilotWeightBps - v.weight_bps : null,

        // Timing analysis
        actualDelayMin:       Math.round(delay),
        copilotFirstTickMin,
        timingDeltaMin,

        // Context
        remainingHoursAtVote: Math.round(remainingHours * 10) / 10,
        whaleFollowRate:      v.whale_follow_rate,

        // Outcome
        vpAtVote:             v.vp_at_vote_bps,
        estimatedVoteUsd:     v.estimated_vote_value_sbd,
        realizedCurationSp:   v.realized_curation_sp,

        // Verdict
        verdict,
        skipReason,
      };
    });

    // Summary
    const total          = entries.length;
    const wouldVote      = entries.filter(e => e.wouldCopilotVote).length;
    const wouldSkip      = entries.filter(e => !e.wouldCopilotVote).length;
    const sameWeight     = entries.filter(e => e.verdict === "same").length;
    const diffWeight     = entries.filter(e => e.verdict === "different_weight").length;
    const notInStrategy  = entries.filter(e => e.verdict === "not_in_strategy").length;

    // By category
    type CatSummary = { total: number; wouldVote: number; wouldSkip: number; avgActualWeightPct: number; avgCopilotWeightPct: number | null; avgDelayMin: number };
    const byCategory: Record<string, CatSummary> = {};
    for (const e of entries) {
      if (!byCategory[e.category]) {
        byCategory[e.category] = { total: 0, wouldVote: 0, wouldSkip: 0, avgActualWeightPct: 0, avgCopilotWeightPct: null, avgDelayMin: 0 };
      }
      const cat = byCategory[e.category];
      cat.total++;
      if (e.wouldCopilotVote) cat.wouldVote++; else cat.wouldSkip++;
      cat.avgActualWeightPct  += e.actualWeightPct;
      cat.avgDelayMin         += e.actualDelayMin;
      if (e.copilotWeightPct !== null) {
        cat.avgCopilotWeightPct = (cat.avgCopilotWeightPct ?? 0) + e.copilotWeightPct;
      }
    }
    for (const cat of Object.values(byCategory)) {
      if (cat.total > 0) {
        cat.avgActualWeightPct  = Math.round(cat.avgActualWeightPct  / cat.total * 10) / 10;
        cat.avgDelayMin         = Math.round(cat.avgDelayMin         / cat.total);
        if (cat.avgCopilotWeightPct !== null) {
          cat.avgCopilotWeightPct = Math.round(cat.avgCopilotWeightPct / cat.total * 10) / 10;
        }
      }
    }

    // Skipped votes sorted by score gap (how far below gate they were)
    const skippedByGap = [...entries]
      .filter(e => !e.wouldCopilotVote)
      .sort((a, b) => (b.opportunityGate - b.opportunityScore) - (a.opportunityGate - a.opportunityScore));

    return {
      username,
      period:        { days: query.data.days, since },
      dataNote:      "Nur Votes mit strategy_category und vote_delay_minutes (recordVoteAtBroadcast ab 2026-06-03)",
      summary: {
        total,
        wouldVote,
        wouldSkip,
        wouldVotePct:  total > 0 ? Math.round(wouldVote / total * 100) : 0,
        sameWeight,
        differentWeight: diffWeight,
        notInStrategy,
      },
      byCategory,
      topSkipped:    skippedByGap.slice(0, 10),
      entries,
    };
  });
}
