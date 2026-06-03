import { analyzeCurationHistory } from "@votebroker/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fetchVoteHistory } from "../chain/voteHistory.js";
import { fetchRecentPostsWithVotes, fetchRecentPostsDebug, type PostOpportunity } from "../chain/recentPosts.js";
import { getSession } from "../auth/sessionStore.js";
import { getGrowthData } from "./growthService.js";
import { getDb } from "../db/index.js";

// ── Shared schemas ────────────────────────────────────────────────────────────

const dnaQuerySchema = z.object({
  username: z.string().min(1).max(64),
  maxVotes: z.coerce.number().int().min(50).max(2000).optional()
});

const opportunitiesSchema = z.object({
  authors:       z.array(z.string().min(1).max(64)).min(1).max(200),
  voterUsername: z.string().min(1).max(64)
});

const strategyRuleSchema = z.object({
  username:          z.string().min(1).max(64),
  category:          z.enum(["immer_voten", "lieblingsautor", "bevorzugt", "normal", "niedrig", "ignorieren"]),
  maxWeightPct:      z.number().min(0).max(100),
  minWeightPct:      z.number().min(0).max(100).default(0),
  enabled:           z.boolean(),
  selectionReasons:  z.array(z.string()).optional().default([]),
});

const constraintsSchema = z.object({
  minVpPct:       z.number().min(0).max(100).default(70),   // VP floor — never go below this
  maxVotesPerRun: z.number().int().min(1).max(50).default(10), // cap on votes per plan execution
  maxVpSpendPct:  z.number().min(0).max(100).default(10),   // max VP spend in one run (percentage points)
});

const generateSchema = z.object({
  voterUsername:       z.string().min(1).max(64),
  currentVpBps:        z.number().int().min(0).max(10_000),
  currentVoteUsd:      z.number().min(0).max(100),
  targetVpPct:         z.number().min(50).max(100).optional(),
  targetTomorrowVpPct: z.number().min(50).max(100).optional(), // VP floor target for next day
  constraints:         constraintsSchema.optional(),
  rules:               z.array(strategyRuleSchema).max(100),
});

// ── Vote plan types ───────────────────────────────────────────────────────────

type StrategyCategory = "immer_voten" | "lieblingsautor" | "bevorzugt" | "normal" | "niedrig" | "ignorieren";

const PRIORITY_SCORE: Record<StrategyCategory, number> = {
  immer_voten:    50,
  lieblingsautor: 40,
  bevorzugt:      30,
  normal:         20,
  niedrig:        10,
  ignorieren:     0,
};

const CATEGORY_REASON: Record<StrategyCategory, string> = {
  immer_voten:    "Immer-Vote-Autor — jeder neue Post wird gevoted",
  lieblingsautor: "Lieblingsautor — höchste verfügbare Priorität",
  bevorzugt:      "Bevorzugt — reguläre Curation-Priorität",
  normal:         "Normal — Standardgewicht",
  niedrig:        "Niedrige Priorität — Restbudget verfügbar",
  ignorieren:     "Ignoriert",
};

interface VotePlanEntry {
  author: string;
  permlink: string;
  title: string;
  ageMinutes: number;
  remainingHours: number;
  postScore: number;        // 0–100 curation timing quality
  category: StrategyCategory;
  priority: number;
  suggestedWeightPct: number;
  suggestedWeightBps: number;
  expectedVoteUsd: number;
  reason: string;
  reasons: string[];
  warning: string | null;  // expiry warning
}

// Minimum meaningful vote — below this, skip rather than sending a dust vote
const DUST_THRESHOLD_BPS = 1_000; // 10% minimum
const DAILY_REGEN_PCT = 20;       // Steem VP regenerates 20 percentage-points per day

// Minimum meaningful vote weight per category (in BPS)
const CATEGORY_DUST_BPS: Record<string, number> = {
  immer_voten:    5_000,  // 50%
  lieblingsautor: 3_000,  // 30%
  bevorzugt:      1_500,  // 15%
  normal:         1_000,  // 10%
  niedrig:          500,  // 5%
};

// Reduction order: lowest priority gets cut first
const REDUCTION_ORDER: StrategyCategory[] = ["niedrig", "normal", "bevorzugt", "lieblingsautor", "immer_voten"];

type StopReason = "max_votes" | "budget" | "none";

interface ConstraintReport {
  maxVotesPerRun:         number;
  dynamicBudgetPct:       number;   // max spend while keeping tomorrow's VP at target
  effectiveBudgetPct:     number;   // alias for backward-compat
  maxVpSpendPct:          number;   // kept for backward-compat display
  minVpPct:               number;   // kept for backward-compat display
  includedVotes:          number;
  excludedVotes:          number;
  stoppedBy:              StopReason;
  stoppedByLabel:         string;
  vpAfterPlanPct:         number;
  expectedTomorrowVpPct:  number;
  recoveryMode:           boolean;  // true when currentVp < targetTomorrowVp
  weightReductionPct:     number;   // % reduction applied to included votes (0 = none)
}

// ── Vote plan generation ──────────────────────────────────────────────────────

function buildVotePlan(params: {
  rules:               z.infer<typeof strategyRuleSchema>[];
  posts:               Map<string, PostOpportunity[]>;
  currentVpBps:        number;
  targetVpPct:         number;   // legacy, kept for vpDelta context hints
  targetTomorrowVpPct: number;   // VP floor target for tomorrow (default 80%)
  currentVoteUsd:      number;
  constraints: {
    maxVotesPerRun: number;
    minVpPct:       number;  // kept for compat
    maxVpSpendPct:  number;  // kept for compat
  };
}): { entries: VotePlanEntry[]; report: ConstraintReport } {
  const currentVpPct = params.currentVpBps / 100;
  const { maxVotesPerRun } = params.constraints;
  const targetTomorrow = params.targetTomorrowVpPct;

  // Dynamic budget: how much VP can be spent today while keeping tomorrow's VP at target.
  // Steem regenerates 20 percentage-points per day.
  const vpTomorrow       = Math.min(100, currentVpPct + DAILY_REGEN_PCT);
  const dynamicBudgetPct = Math.max(0, vpTomorrow - targetTomorrow);
  const recoveryMode     = currentVpPct < targetTomorrow;
  const vpDelta          = currentVpPct - params.targetVpPct;

  function fullWeightBps(rule: z.infer<typeof strategyRuleSchema>): number {
    const base = Math.round(rule.maxWeightPct * 100);
    // immer_voten always gets at least 50%
    if (rule.category === "immer_voten") return Math.max(5_000, base);
    // Slight boost when VP is very high
    if (vpDelta > 10 && rule.category === "niedrig") return Math.min(10_000, Math.round(base * 1.15));
    return Math.max(CATEGORY_DUST_BPS[rule.category] ?? DUST_THRESHOLD_BPS, base);
  }

  function buildReasons(rule: z.infer<typeof strategyRuleSchema>, post: PostOpportunity, reduced: boolean): string[] {
    const r: string[] = [CATEGORY_REASON[rule.category]];
    if (rule.selectionReasons && rule.selectionReasons.length > 0) r.push(...rule.selectionReasons.slice(0, 2));
    if (post.postScore >= 90) r.push("Optimales Curation-Fenster (< 30 Min.)");
    else if (post.postScore >= 70) r.push(`Post ${post.ageMinutes < 1440 ? Math.round(post.ageMinutes / 60) + "h" : Math.round(post.ageMinutes / 1440) + "d"} alt — gutes Curation-Fenster`);
    if (post.remainingHours < 24 && post.remainingHours > 0) r.push(`⚠ Nur noch ${post.remainingHours.toFixed(0)}h bis Auszahlung`);
    if (reduced) r.push(`VP ${currentVpPct.toFixed(1)}% — Recovery-Modus, Gewicht reduziert`);
    else if (vpDelta > 10) r.push("VP-Überschuss — volles Gewicht verfügbar");
    return r;
  }

  // ── 1. Build all candidates at full weight ─────────────────────────────────
  const allCandidates: VotePlanEntry[] = [];

  for (const rule of params.rules) {
    if (!rule.enabled || rule.category === "ignorieren") continue;
    const posts    = params.posts.get(rule.username) ?? [];
    const eligible = posts.filter(p => p.eligible).sort((a, b) => {
      if (b.postScore !== a.postScore) return b.postScore - a.postScore;
      if (b.remainingHours !== a.remainingHours) return b.remainingHours - a.remainingHours;
      return a.ageMinutes - b.ageMinutes;
    });
    const maxPosts  = (rule.category === "immer_voten" || rule.category === "lieblingsautor") ? 3 : 1;
    const selected  = eligible.slice(0, maxPosts);
    if (selected.length === 0) continue;

    const weightBps = fullWeightBps(rule);
    // Drop if even the full weight is below the dust floor for this category
    if (weightBps < (CATEGORY_DUST_BPS[rule.category] ?? DUST_THRESHOLD_BPS)) continue;

    for (const post of selected) {
      const reasons = buildReasons(rule, post, false);
      allCandidates.push({
        author:             post.author,
        permlink:           post.permlink,
        title:              post.title || `${post.author}/${post.permlink}`,
        ageMinutes:         post.ageMinutes,
        remainingHours:     post.remainingHours,
        postScore:          post.postScore,
        category:           rule.category as StrategyCategory,
        priority:           PRIORITY_SCORE[rule.category as StrategyCategory],
        suggestedWeightPct: Math.round(weightBps / 100 * 10) / 10,
        suggestedWeightBps: weightBps,
        expectedVoteUsd:    Math.round((weightBps / 10_000) * params.currentVoteUsd * 10_000) / 10_000,
        reason:             reasons[0],
        reasons,
        warning:            post.warning,
      });
    }
  }

  // ── 2. Sort: priority desc → postScore desc → age asc ─────────────────────
  allCandidates.sort((a, b) => {
    if (b.priority !== a.priority)   return b.priority   - a.priority;
    if (b.postScore !== a.postScore) return b.postScore  - a.postScore;
    return a.ageMinutes - b.ageMinutes;
  });

  // ── 3. Progressive weight reduction to fit within dynamic budget ───────────
  //  Phase A: reduce lowest-priority categories first (to dust minimum)
  //  Phase B: remove categories entirely if reduction alone isn't enough
  let working = allCandidates.map(e => ({ ...e }));

  // Steem VP cost: a 100% vote consumes 100/50 = 2% VP (full regen = 5 days × 10 votes/day = 50 votes)
  function totalSpend(entries: VotePlanEntry[]) {
    return entries.reduce((s, e) => s + e.suggestedWeightBps / 5_000, 0);
  }

  // Phase A — weight reduction
  for (const cat of REDUCTION_ORDER) {
    if (totalSpend(working) <= dynamicBudgetPct) break;

    const dustBps    = CATEGORY_DUST_BPS[cat] ?? DUST_THRESHOLD_BPS;
    const catEntries = working.filter(e => e.category === cat);
    if (catEntries.length === 0) continue;

    const catFullSpend = catEntries.reduce((s, e) => s + e.suggestedWeightBps / 5_000, 0);
    const catMinSpend  = catEntries.length * (dustBps / 5_000);
    const excess       = totalSpend(working) - dynamicBudgetPct;
    const savingsAvail = catFullSpend - catMinSpend;

    if (savingsAvail >= excess) {
      // Proportional reduction to exactly hit budget
      const reductionRatio = excess / catFullSpend;
      working = working.map(e => {
        if (e.category !== cat) return e;
        const newBps = Math.max(dustBps, Math.round(e.suggestedWeightBps * (1 - reductionRatio)));
        return { ...e,
          suggestedWeightBps: newBps,
          suggestedWeightPct: Math.round(newBps / 100 * 10) / 10,
          expectedVoteUsd:    Math.round((newBps / 10_000) * params.currentVoteUsd * 10_000) / 10_000,
          reasons: buildReasons({ username: e.author, category: cat, maxWeightPct: 0, minWeightPct: 0, enabled: true, selectionReasons: [] }, { author: e.author, permlink: e.permlink, title: e.title, ageMinutes: e.ageMinutes, remainingHours: e.remainingHours, postScore: e.postScore, eligible: true, alreadyVoted: false, isSelfPost: false, warning: e.warning }, true),
        };
      });
    } else {
      // Reduce entire category to dust minimum
      working = working.map(e => {
        if (e.category !== cat) return e;
        return { ...e,
          suggestedWeightBps: dustBps,
          suggestedWeightPct: Math.round(dustBps / 100 * 10) / 10,
          expectedVoteUsd:    Math.round((dustBps / 10_000) * params.currentVoteUsd * 10_000) / 10_000,
          reasons: buildReasons({ username: e.author, category: cat, maxWeightPct: 0, minWeightPct: 0, enabled: true, selectionReasons: [] }, { author: e.author, permlink: e.permlink, title: e.title, ageMinutes: e.ageMinutes, remainingHours: e.remainingHours, postScore: e.postScore, eligible: true, alreadyVoted: false, isSelfPost: false, warning: e.warning }, true),
        };
      });
    }
  }

  // Phase B — remove categories if still over budget
  for (const cat of REDUCTION_ORDER) {
    if (totalSpend(working) <= dynamicBudgetPct) break;
    working = working.filter(e => e.category !== cat);
  }

  // ── 4. Apply vote count cap ────────────────────────────────────────────────
  const included = working.slice(0, maxVotesPerRun);
  const excluded  = allCandidates.length - included.length;

  // ── 5. Calculate weight reduction % ───────────────────────────────────────
  const originalBpsForIncluded = allCandidates
    .filter(orig => included.some(inc => inc.author === orig.author && inc.permlink === orig.permlink))
    .reduce((s, e) => s + e.suggestedWeightBps, 0);
  const finalBps = included.reduce((s, e) => s + e.suggestedWeightBps, 0);
  const weightReductionPct = originalBpsForIncluded > 0
    ? Math.max(0, Math.round((1 - finalBps / originalBpsForIncluded) * 100))
    : 0;

  const spentPct           = totalSpend(included);
  const expectedTomorrow   = Math.round((vpTomorrow - spentPct) * 10) / 10;
  const stoppedBy: StopReason = included.length < allCandidates.length
    ? (working.length >= maxVotesPerRun ? "max_votes" : "budget")
    : "none";

  const STOP_LABELS: Record<StopReason, string> = {
    max_votes: `Limit erreicht: max. ${maxVotesPerRun} Votes pro Run`,
    budget:    recoveryMode
      ? `Recovery-Modus: Budget ${dynamicBudgetPct.toFixed(1)}% (VP ${currentVpPct.toFixed(1)}% → ${targetTomorrow}% morgen)`
      : `Tages-Budget ${dynamicBudgetPct.toFixed(1)}% ausgeschöpft`,
    none:      weightReductionPct > 0
      ? `Alle Posts eingeschlossen (Gewichte um ${weightReductionPct}% reduziert)`
      : "Alle verfügbaren Posts eingeschlossen",
  };

  const report: ConstraintReport = {
    maxVotesPerRun,
    dynamicBudgetPct:      Math.round(dynamicBudgetPct * 10) / 10,
    effectiveBudgetPct:    Math.round(dynamicBudgetPct * 10) / 10,
    maxVpSpendPct:         Math.round(dynamicBudgetPct * 10) / 10,
    minVpPct:              Math.round((vpTomorrow - dynamicBudgetPct) * 10) / 10,
    includedVotes:         included.length,
    excludedVotes:         excluded,
    stoppedBy,
    stoppedByLabel:        STOP_LABELS[stoppedBy],
    vpAfterPlanPct:        Math.round((currentVpPct - spentPct) * 10) / 10,
    expectedTomorrowVpPct: expectedTomorrow,
    recoveryMode,
    weightReductionPct,
  };

  return { entries: included, report };
}

// ── Recent VoteBroker votes from audit_events (chain timing buffer) ───────────
// The Steem node may not reflect a vote in active_votes immediately after
// broadcast. We read audit_events as a local buffer so the plan generator
// never re-suggests a post that VoteBroker already voted, even before chain sync.

function getRecentlyVotedKeys(voter: string, windowMs = 2 * 24 * 3600 * 1000): Set<string> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const rows = getDb().prepare(`
    SELECT author, permlink FROM audit_events
    WHERE username = ? AND type IN ('vote_broadcast_success', 'vote_broadcast_attempt')
      AND author IS NOT NULL AND created_at >= ?
  `).all(voter, since) as Array<{ author: string; permlink: string }>;
  return new Set(rows.map(r => `${r.author}/${r.permlink}`));
}

// ── Batch fetch helper ────────────────────────────────────────────────────────

async function fetchAllPosts(authors: string[], voter: string): Promise<Map<string, PostOpportunity[]>> {
  // Build local voted-key set to catch votes not yet visible on-chain
  const recentlyVoted = getRecentlyVotedKeys(voter);

  const map = new Map<string, PostOpportunity[]>();
  const BATCH = 5;
  for (let i = 0; i < authors.length; i += BATCH) {
    const batch = authors.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(a => fetchRecentPostsWithVotes(a, voter))
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") {
        // Apply local buffer: mark as alreadyVoted if in audit_events even if
        // the chain hasn't synced yet
        const posts = r.value.map(p => {
          const key = `${p.author}/${p.permlink}`;
          if (!p.alreadyVoted && recentlyVoted.has(key)) {
            return { ...p, alreadyVoted: true, eligible: false };
          }
          return p;
        });
        map.set(batch[j], posts);
      }
    }
  }
  return map;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerCurationRoutes(app: FastifyInstance): Promise<void> {

  app.get("/api/curation/dna", async (request, reply) => {
    const query = dnaQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request", detail: query.error.flatten() });
    }
    const { username, maxVotes = 500 } = query.data;
    try {
      const votes   = await fetchVoteHistory(username, maxVotes);
      const profile = analyzeCurationHistory({ username, votes });
      return profile;
    } catch (err) {
      return reply.code(502).send({
        error: "steem_api_error",
        detail: err instanceof Error ? err.message : "Failed to fetch vote history"
      });
    }
  });

  app.post("/api/curation/opportunities", async (request, reply) => {
    const body = opportunitiesSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", detail: body.error.flatten() });
    }
    const { authors, voterUsername } = body.data;

    // Log the full author list for traceability
    request.log.info({
      voterUsername,
      authorCount: authors.length,
      authors,
    }, "opportunity-scan: received authors");

    const allPosts = await fetchAllPosts(authors, voterUsername);

    // Build per-author summary for the response
    const perAuthor: Record<string, { scanned: number; eligible: number; alreadyVoted: number; noRecentPosts: boolean }> = {};
    for (const [author, posts] of allPosts.entries()) {
      perAuthor[author] = {
        scanned:       posts.length,
        eligible:      posts.filter(p => p.eligible).length,
        alreadyVoted:  posts.filter(p => p.alreadyVoted).length,
        noRecentPosts: posts.length === 0,
      };
    }
    // Authors where fetch failed (not in map at all)
    for (const a of authors) {
      if (!perAuthor[a]) perAuthor[a] = { scanned: 0, eligible: 0, alreadyVoted: 0, noRecentPosts: true };
    }

    const all = [...allPosts.values()].flat();
    const eligibleCount = all.filter(p => p.eligible).length;

    request.log.info({
      voterUsername,
      authorCount: authors.length,
      eligiblePosts: eligibleCount,
      totalPosts: all.length,
    }, "opportunity-scan: results");

    return {
      opportunities: all,
      meta: {
        requestedAuthors: authors.length,
        scannedAuthors:   Object.keys(perAuthor).length,
        totalPosts:       all.length,
        eligiblePosts:    eligibleCount,
        perAuthor,
      },
    };
  });

  // Debug endpoint — shows every post and why it was accepted or rejected
  app.post("/api/curation/opportunities/debug", async (request, reply) => {
    const body = opportunitiesSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    const { authors, voterUsername } = body.data;
    const results: Record<string, Awaited<ReturnType<typeof fetchRecentPostsDebug>>> = {};
    const BATCH = 3;
    for (let i = 0; i < authors.length; i += BATCH) {
      const batch = authors.slice(i, i + BATCH);
      const settled = await Promise.allSettled(
        batch.map(a => fetchRecentPostsDebug(a, voterUsername))
      );
      for (let j = 0; j < settled.length; j++) {
        const r = settled[j];
        results[batch[j]] = r.status === "fulfilled" ? r.value : { raw: 0, debug: [], eligible: [] };
      }
    }
    // Summary
    const summary = Object.entries(results).map(([author, r]) => ({
      author,
      rawCount: r.raw,
      eligibleCount: r.eligible.filter(p => p.eligible && !p.alreadyVoted).length,
      alreadyVotedCount: r.eligible.filter(p => p.alreadyVoted).length,
      rejectedCount: r.debug.filter(d => d.rejectedBy !== null).length,
      rejectedReasons: [...new Set(r.debug.filter(d => d.rejectedBy).map(d => d.rejectedBy!))],
    }));
    return { voterUsername, now: new Date().toISOString(), summary, details: results };
  });

  // ── POST /api/curation/generate ───────────────────────────────────────────
  // Generates an intelligent, ordered vote plan from strategy rules + live posts
  app.post("/api/curation/generate", async (request, reply) => {
    const body = generateSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", detail: body.error.flatten() });
    }

    const { voterUsername, currentVpBps, currentVoteUsd, rules } = body.data;
    const targetVpPct        = body.data.targetVpPct ?? 85;
    const targetTomorrowVpPct = body.data.targetTomorrowVpPct ?? 80;
    const constraints = {
      minVpPct:       body.data.constraints?.minVpPct       ?? 70,
      maxVotesPerRun: body.data.constraints?.maxVotesPerRun ?? 20,
      maxVpSpendPct:  body.data.constraints?.maxVpSpendPct  ?? 80,
    };

    const activeAuthors = [...new Set(
      rules
        .filter(r => r.enabled && r.category !== "ignorieren")
        .map(r => r.username)
    )];

    const currentVpPct = currentVpBps / 100;

    if (activeAuthors.length === 0) {
      return {
        plan: [], constraints, report: { minVpPct: constraints.minVpPct, maxVotesPerRun: constraints.maxVotesPerRun, maxVpSpendPct: constraints.maxVpSpendPct, effectiveBudgetPct: 0, includedVotes: 0, excludedVotes: 0, stoppedBy: "none", stoppedByLabel: "Keine aktiven Autoren", vpAfterPlanPct: currentVpPct },
        summary: { totalPosts: 0, currentVpPct, estimatedVpSpendPct: 0, estimatedVpAfterPct: currentVpPct, sustainability: "sustainable", skippedCategories: [] },
        generatedAt: new Date().toISOString()
      };
    }

    const postMap        = await fetchAllPosts(activeAuthors, voterUsername);
    const { entries, report } = buildVotePlan({ rules, posts: postMap, currentVpBps, targetVpPct, targetTomorrowVpPct, currentVoteUsd, constraints });

    // VP cost = weightBps / 5000 (100% vote = 2% VP in Steem)
    const spendPct = Math.round(entries.reduce((s, e) => s + e.suggestedWeightBps / 5_000, 0) * 10) / 10;
    const sustainability: "sustainable" | "aggressive" | "critical" =
      spendPct <= 5  ? "sustainable" :   // ≤5% VP consumed = well within daily regen
      spendPct <= 12 ? "aggressive"  :   // 5–12% VP = moderate spend
      "critical";                         // >12% VP = approaching or exceeding daily regen

    const vpDelta = currentVpPct - targetVpPct;
    const skippedCategories: string[] = [];
    if (vpDelta < -20) skippedCategories.push("normal", "bevorzugt", "niedrig");
    else if (vpDelta < -10) skippedCategories.push("niedrig");

    return {
      plan: entries,
      constraints,
      report,
      summary: {
        totalPosts: entries.length,
        currentVpPct,
        estimatedVpSpendPct: spendPct,
        estimatedVpAfterPct: report.vpAfterPlanPct,
        sustainability,
        skippedCategories,
      },
      generatedAt: new Date().toISOString()
    };
  });

  // ── POST /api/me/votebroker-earnings/rebuild — rebuild cache from chain ──────
  // The vb_vote_outcomes table is a cache. This rebuilds it from get_account_history.
  // Safe to run at any time — upserts, never deletes matched data.
  app.post("/api/me/votebroker-earnings/rebuild", async (request, reply) => {
    const token   = (request.headers as Record<string, string>)["session"];
    const session = token ? getSession(token) : null;
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    try {
      const { rebuildVoteOutcomes } = await import("../chain/rebuildVoteOutcomes.js");
      const report = await rebuildVoteOutcomes(
        session.user.username,
        request.log as unknown as typeof console,
      );
      return report;
    } catch (err) {
      return reply.code(502).send({
        error:  "rebuild_failed",
        detail: err instanceof Error ? err.message : "unknown",
      });
    }
  });

  // ── GET /api/me/votebroker-earnings — VoteBroker-attributed curation ────────
  app.get("/api/me/votebroker-earnings", async (request, reply) => {
    const token   = (request.headers as Record<string, string>)["session"];
    const session = token ? getSession(token) : null;
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const rawPeriod = (request.query as Record<string, string>)["period"] ?? "30d";
    const period    = (["7d", "30d", "90d", "all"] as const).find(p => p === rawPeriod) ?? "30d";

    try {
      const { fetchVBEarnings } = await import("../chain/voteBrokerEarnings.js");
      return await fetchVBEarnings(session.user.username, period);
    } catch (err) {
      return reply.code(502).send({ error: "earnings_fetch_failed",
        detail: err instanceof Error ? err.message : "unknown" });
    }
  });

  // ── GET /api/me/growth — curator growth time series ──────────────────────
  // Returns daily vote + author data derived from audit_events.
  // No USD impact: historical SP/price not stored — won't fake it.
  app.get("/api/me/growth", async (request, reply) => {
    const token   = (request.headers as Record<string, string>)["session"];
    const session = token ? getSession(token) : null;
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const rawPeriod = (request.query as Record<string, string>)["period"] ?? "30d";
    const period    = (["30d", "90d", "all"] as const).includes(rawPeriod as "30d" | "90d" | "all")
      ? rawPeriod as "30d" | "90d" | "all"
      : "30d";

    return getGrowthData(session.user.username, period);
  });
}
