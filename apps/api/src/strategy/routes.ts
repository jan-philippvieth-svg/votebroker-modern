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
      whale_count: number | null;
      post_pending_payout_sbd: number | null;
    };

    const votes = db.prepare(`
      SELECT gvo.author, gvo.permlink, gvo.voted_at, gvo.vote_delay_minutes, gvo.weight_bps,
             gvo.strategy_category, gvo.vp_at_vote_bps, gvo.estimated_vote_value_sbd,
             gvo.realized_curation_sp, gvo.is_self_post,
             gvo.post_pending_payout_sbd,
             sa.whale_count
      FROM vb_global_vote_outcomes gvo
      LEFT JOIN vb_signal_author sa ON gvo.author = sa.author
      WHERE gvo.voter = ? AND gvo.voted_at >= ? AND gvo.strategy_category IS NOT NULL
        AND gvo.vote_delay_minutes IS NOT NULL
      ORDER BY gvo.voted_at DESC
    `).all(username, since) as VoteRow[];

    // Author historical avg sp/vp — computed once for all authors in the window
    const authorSpPerVp = new Map<string, number>();
    const spRows = db.prepare(`
      SELECT author,
             AVG(realized_curation_sp / (weight_bps / 10000.0)) as avg_sp_per_vp,
             COUNT(*) as n
      FROM vb_global_vote_outcomes
      WHERE voter = ? AND realized_curation_sp IS NOT NULL AND weight_bps > 0
      GROUP BY author
      HAVING COUNT(*) >= 3
    `).all(username) as Array<{ author: string; avg_sp_per_vp: number; n: number }>;
    for (const r of spRows) authorSpPerVp.set(r.author, r.avg_sp_per_vp);

    const PAYOUT_WINDOW_HOURS = 7 * 24;

    const entries = votes.map(v => {
      const delay         = v.vote_delay_minutes!;
      const remainingHours = Math.max(0, PAYOUT_WINDOW_HOURS - delay / 60);
      const rule          = strategyMap.get(v.author);
      const copilotWeightBps = rule ? Math.round(rule.maxWeightPct * 100) : null;

      const opp = calcOpportunityScore({
        ageMinutes:       delay,
        remainingHours,
        category:         v.strategy_category,
        pendingPayoutSbd: v.post_pending_payout_sbd ?? undefined,
        whaleCount:       v.whale_count ?? undefined,
        authorAvgSpPerVp: authorSpPerVp.get(v.author),
        isSelfPost:       v.is_self_post === 1,
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
        whaleCount:           v.whale_count,
        pendingPayoutSbd:     v.post_pending_payout_sbd,

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

  // GET /api/me/copilot/outcome-analysis — learning foundation for CoPilot optimization
  app.get("/api/me/copilot/outcome-analysis", {
    schema: {
      tags: ["Strategy"],
      summary: "CoPilot Outcome-Analyse — SP-Effizienz nach Signal-Dimensionen (Lernbasis)",
      security: [{ sessionToken: [] }],
      querystring: zodToJsonSchema(z.object({
        days: z.coerce.number().int().min(1).max(90).default(30),
      })),
    }
  }, async (request, reply) => {
    const session = getSession(getSessionHeader(request.headers.session));
    if (!session) return reply.code(401).send({ error: "authorized_session_required" });

    const query = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_request" });

    const username = session.user.username;
    const since    = new Date(Date.now() - query.data.days * 24 * 3600 * 1000).toISOString();
    const db       = getDb();

    // ── Types ────────────────────────────────────────────────────────────────

    interface OutcomeBucket {
      label:        string;
      n:            number;     // sample count
      avgSp:        number;     // average realized curation SP per vote
      avgSpPerVp:   number;     // SP per 100%-vote-equivalent (normalized for weight)
      stddev:       number;     // standard deviation of spPerVp across samples
      confidence:   number;     // 0–1: how much to trust this bucket's data
      totalSp:      number;     // sum — useful for understanding absolute contribution
    }

    // Confidence: reaches 1.0 at 30 samples (Steem payout cycle ~7 days, realistic data rate)
    function confidence(n: number): number {
      return Math.round(Math.min(1, n / 30) * 100) / 100;
    }

    function makeBucket(label: string, values: number[], spValues: number[]): OutcomeBucket {
      const n = values.length;
      if (n === 0) return { label, n: 0, avgSp: 0, avgSpPerVp: 0, stddev: 0, confidence: 0, totalSp: 0 };
      const avgSpPerVp = values.reduce((a, b) => a + b, 0) / n;
      const avgSp      = spValues.reduce((a, b) => a + b, 0) / n;
      const totalSp    = spValues.reduce((a, b) => a + b, 0);
      const variance   = values.reduce((a, v) => a + (v - avgSpPerVp) ** 2, 0) / n;
      return {
        label,
        n,
        avgSp:      Math.round(avgSp      * 100_000) / 100_000,
        avgSpPerVp: Math.round(avgSpPerVp * 100_000) / 100_000,
        stddev:     Math.round(Math.sqrt(variance) * 100_000) / 100_000,
        confidence: confidence(n),
        totalSp:    Math.round(totalSp * 10_000) / 10_000,
      };
    }

    // ── Fetch realized votes with whale signal ────────────────────────────────

    type RealizedRow = {
      author:                  string;
      voted_at:                string;
      vote_delay_minutes:      number;
      weight_bps:              number;
      vp_at_vote_bps:          number | null;
      realized_curation_sp:    number;
      strategy_category:       string;
      is_self_post:            number;
      whale_count:             number | null;
      post_pending_payout_sbd: number | null;
    };

    const rows = db.prepare(`
      SELECT gvo.author, gvo.voted_at, gvo.vote_delay_minutes, gvo.weight_bps,
             gvo.vp_at_vote_bps, gvo.realized_curation_sp, gvo.strategy_category,
             gvo.is_self_post, gvo.post_pending_payout_sbd,
             sa.whale_count
      FROM vb_global_vote_outcomes gvo
      LEFT JOIN vb_signal_author sa ON gvo.author = sa.author
      WHERE gvo.voter = ?
        AND gvo.voted_at >= ?
        AND gvo.realized_curation_sp IS NOT NULL
        AND gvo.strategy_category IS NOT NULL
        AND gvo.vote_delay_minutes IS NOT NULL
      ORDER BY gvo.voted_at DESC
    `).all(username, since) as RealizedRow[];

    // Author avg sp/vp across all time (for authorHistory score component)
    const analyticsSpPerVp = new Map<string, number>();
    const analyticsSpRows = db.prepare(`
      SELECT author,
             AVG(realized_curation_sp / (weight_bps / 10000.0)) as avg_sp_per_vp
      FROM vb_global_vote_outcomes
      WHERE voter = ? AND realized_curation_sp IS NOT NULL AND weight_bps > 0
      GROUP BY author HAVING COUNT(*) >= 3
    `).all(username) as Array<{ author: string; avg_sp_per_vp: number }>;
    for (const r of analyticsSpRows) analyticsSpPerVp.set(r.author, r.avg_sp_per_vp);

    if (rows.length === 0) {
      return {
        username,
        period:         { days: query.data.days, since },
        dataNote:       "Keine realisierten Votes mit vollständigem Kontext gefunden. Erfordert strategy_category + vote_delay_minutes (ab 2026-06-03).",
        meta:           { totalRealized: 0, totalSp: 0, avgSpPerVp: 0, computedAt: new Date().toISOString() },
        byDelay:        {},
        byCategory:     {},
        byOpportunityScore: {},
        byVpLevel:      {},
        topAuthors:     [],
        findings:       [],
      };
    }

    // ── SP/VP normalization ───────────────────────────────────────────────────
    // sp_per_vp = realized_sp / (weight_bps / 10_000)
    // → "how much SP did a full 100% vote worth of power earn?"

    type Enriched = RealizedRow & {
      spPerVp:     number;
      oppScore:    number;
      delayBucket: string;
      oppBucket:   string;
      vpBucket:    string;
    };

    const DELAY_BUCKETS: Array<[string, string, number, number]> = [
      // [key, label, minMin, maxMin]
      ["0_30min",  "0–30 min",   0,    30],
      ["30_120min","30–120 min",  30,   120],
      ["2h_6h",    "2–6 h",      120,  360],
      ["6h_24h",   "6–24 h",     360,  1440],
      ["1d_3d",    "1–3 Tage",   1440, 4320],
      ["3d_7d",    "3–7 Tage",   4320, 10080],
    ];

    const OPP_BUCKETS: Array<[string, string, number, number]> = [
      ["0_20",  "Score 0–20",  0,  20],
      ["20_40", "Score 20–40", 20, 40],
      ["40_60", "Score 40–60", 40, 60],
      ["60_80", "Score 60–80", 60, 80],
      ["80_100","Score 80–100",80, 101],
    ];

    const VP_BUCKETS: Array<[string, string, number, number]> = [
      ["lt70",   "VP < 70%",     0,    7000],
      ["70_80",  "VP 70–80%",    7000, 8000],
      ["80_90",  "VP 80–90%",    8000, 9000],
      ["90_100", "VP 90–100%",   9000, 10001],
    ];

    function bucketKey<T extends [string, string, number, number]>(
      buckets: T[], value: number
    ): string {
      for (const [key, , min, max] of buckets) {
        if (value >= min && value < max) return key;
      }
      return buckets[buckets.length - 1][0];
    }

    const enriched: Enriched[] = rows.map(r => {
      const spPerVp = r.realized_curation_sp / (r.weight_bps / 10_000);
      const opp = calcOpportunityScore({
        ageMinutes:       r.vote_delay_minutes,
        remainingHours:   Math.max(0, (7 * 24 * 60 - r.vote_delay_minutes) / 60),
        category:         r.strategy_category,
        pendingPayoutSbd: r.post_pending_payout_sbd ?? undefined,
        whaleCount:       r.whale_count ?? undefined,
        authorAvgSpPerVp: analyticsSpPerVp.get(r.author),
        isSelfPost:       r.is_self_post === 1,
      });
      return {
        ...r,
        spPerVp,
        oppScore:    opp.score,
        delayBucket: bucketKey(DELAY_BUCKETS, r.vote_delay_minutes),
        oppBucket:   bucketKey(OPP_BUCKETS, opp.score),
        vpBucket:    r.vp_at_vote_bps != null ? bucketKey(VP_BUCKETS, r.vp_at_vote_bps) : "unknown",
      };
    });

    // ── Build buckets ─────────────────────────────────────────────────────────

    function groupBy(key: keyof Enriched, bucketDefs: Array<[string, string, number, number]>): Record<string, OutcomeBucket> {
      const result: Record<string, OutcomeBucket> = {};
      for (const [bKey, label] of bucketDefs) {
        const subset = enriched.filter(e => e[key] === bKey);
        result[bKey] = makeBucket(label, subset.map(e => e.spPerVp), subset.map(e => e.realized_curation_sp));
      }
      return result;
    }

    const byDelay    = groupBy("delayBucket", DELAY_BUCKETS);
    const byOppScore = groupBy("oppBucket",   OPP_BUCKETS);
    const byVpLevel  = groupBy("vpBucket",    VP_BUCKETS);

    // By category (not predefined ranges — use actual categories)
    const categories = [...new Set(enriched.map(e => e.strategy_category))];
    const byCategory: Record<string, OutcomeBucket> = {};
    for (const cat of categories) {
      const subset = enriched.filter(e => e.strategy_category === cat);
      byCategory[cat] = makeBucket(cat, subset.map(e => e.spPerVp), subset.map(e => e.realized_curation_sp));
    }

    // Top authors by SP/VP efficiency (min 2 samples)
    const authorMap = new Map<string, number[]>();
    for (const e of enriched) {
      if (!authorMap.has(e.author)) authorMap.set(e.author, []);
      authorMap.get(e.author)!.push(e.spPerVp);
    }
    const topAuthors = [...authorMap.entries()]
      .filter(([, v]) => v.length >= 2)
      .map(([author, vals]) => ({
        author,
        n:          vals.length,
        avgSpPerVp: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 100_000) / 100_000,
        totalSp:    Math.round(vals.reduce((a, b) => a + b, 0) * 10_000) / 10_000,
        confidence: confidence(vals.length),
      }))
      .sort((a, b) => b.avgSpPerVp - a.avgSpPerVp)
      .slice(0, 20);

    // ── Meta ──────────────────────────────────────────────────────────────────

    const allSpPerVp = enriched.map(e => e.spPerVp);
    const totalSp    = enriched.reduce((a, e) => a + e.realized_curation_sp, 0);
    const avgSpPerVp = allSpPerVp.reduce((a, b) => a + b, 0) / allSpPerVp.length;

    // ── Findings: auto-generated insights (machine-readable) ─────────────────
    // Each finding maps a signal dimension to an observed effect with confidence.
    // These are the raw observations — not recommendations. The CoPilot uses them later.

    interface Finding {
      dimension:  string;
      signal:     string;
      label:      string;
      avgSpPerVp: number;
      vsBaseline: number;  // % difference vs overall avgSpPerVp
      n:          number;
      confidence: number;
    }

    const findings: Finding[] = [];
    const baseline = avgSpPerVp;

    function addFindings(buckets: Record<string, OutcomeBucket>, dimension: string) {
      for (const [signal, b] of Object.entries(buckets)) {
        if (b.n === 0) continue;
        const vsBaseline = baseline > 0
          ? Math.round((b.avgSpPerVp / baseline - 1) * 1000) / 10  // % with 1 decimal
          : 0;
        findings.push({ dimension, signal, label: b.label, avgSpPerVp: b.avgSpPerVp, vsBaseline, n: b.n, confidence: b.confidence });
      }
    }

    addFindings(byDelay,    "delay");
    addFindings(byCategory, "category");
    addFindings(byOppScore, "opportunity_score");
    addFindings(byVpLevel,  "vp_level");

    // Sort by effect size descending (most impactful signals first)
    findings.sort((a, b) => Math.abs(b.vsBaseline) - Math.abs(a.vsBaseline));

    return {
      username,
      period:      { days: query.data.days, since },
      dataNote:    `${enriched.length} realisierte Votes mit vollständigem Kontext. Konfidenz steigt ab 30 Samples pro Bucket.`,
      meta: {
        totalRealized: enriched.length,
        totalSp:       Math.round(totalSp * 10_000) / 10_000,
        avgSpPerVp:    Math.round(avgSpPerVp * 100_000) / 100_000,
        computedAt:    new Date().toISOString(),
      },
      byDelay,
      byCategory,
      byOpportunityScore: byOppScore,
      byVpLevel,
      topAuthors,
      findings,
    };
  });
}
