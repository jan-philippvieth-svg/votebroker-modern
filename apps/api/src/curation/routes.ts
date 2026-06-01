import { analyzeCurationHistory } from "@votebroker/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fetchVoteHistory } from "../chain/voteHistory.js";
import { fetchRecentPostsWithVotes, fetchRecentPostsDebug, type PostOpportunity } from "../chain/recentPosts.js";

// ── Shared schemas ────────────────────────────────────────────────────────────

const dnaQuerySchema = z.object({
  username: z.string().min(1).max(64),
  maxVotes: z.coerce.number().int().min(50).max(2000).optional()
});

const opportunitiesSchema = z.object({
  authors:       z.array(z.string().min(1).max(64)).min(1).max(50),
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
  voterUsername:  z.string().min(1).max(64),
  currentVpBps:   z.number().int().min(0).max(10_000),
  currentVoteUsd: z.number().min(0).max(100),
  targetVpPct:    z.number().min(50).max(100).optional(),
  constraints:    constraintsSchema.optional(),
  rules:          z.array(strategyRuleSchema).max(100),
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

type StopReason = "max_votes" | "max_spend" | "min_vp" | "none";

interface ConstraintReport {
  minVpPct:        number;
  maxVotesPerRun:  number;
  maxVpSpendPct:   number;
  effectiveBudgetPct: number;  // actual allowed spend = min(maxVpSpendPct, currentVp - minVp)
  includedVotes:   number;
  excludedVotes:   number;     // candidates that existed but were cut by constraints
  stoppedBy:       StopReason;
  stoppedByLabel:  string;
  vpAfterPlanPct:  number;
}

// ── Vote plan generation ──────────────────────────────────────────────────────

function buildVotePlan(params: {
  rules:          z.infer<typeof strategyRuleSchema>[];
  posts:          Map<string, PostOpportunity[]>;
  currentVpBps:   number;
  targetVpPct:    number;
  currentVoteUsd: number;
  constraints: {
    minVpPct:       number;
    maxVotesPerRun: number;
    maxVpSpendPct:  number;
  };
}): { entries: VotePlanEntry[]; report: ConstraintReport } {
  const currentVpPct    = params.currentVpBps / 100;
  const { minVpPct, maxVotesPerRun, maxVpSpendPct } = params.constraints;

  // Effective budget = most restrictive of: explicit spend cap OR floor gap
  const floorGap = Math.max(0, currentVpPct - minVpPct);
  const effectiveBudgetPct = Math.min(maxVpSpendPct, floorGap);

  const vpDelta = currentVpPct - params.targetVpPct;

  function adjustedWeightBps(rule: z.infer<typeof strategyRuleSchema>): number {
    const base = Math.round(rule.maxWeightPct * 100);
    const min  = Math.max(Math.round(rule.minWeightPct * 100), DUST_THRESHOLD_BPS);

    if (rule.category === "immer_voten") {
      // Never scale down below 50% for always-vote authors
      return Math.max(5_000, base);
    }
    if (vpDelta > 10 && rule.category === "niedrig") {
      return Math.min(10_000, Math.round(base * 1.15));
    }
    if (vpDelta < -15) {
      // VP significantly below target: scale down but never below dust threshold
      const scale = Math.max(0.6, 1 + vpDelta / 80);
      return Math.max(DUST_THRESHOLD_BPS, Math.round(base * scale));
    }
    return Math.max(DUST_THRESHOLD_BPS, base);
  }

  function isDustVote(weightBps: number, category: string): boolean {
    // Skip entirely if weight is below the meaningful minimum for this category
    const categoryMin: Record<string, number> = {
      immer_voten:    5_000,
      lieblingsautor: 3_000,
      bevorzugt:      1_500,
      normal:         1_000,
      niedrig:          500,
    };
    return weightBps < (categoryMin[category] ?? DUST_THRESHOLD_BPS);
  }

  function buildReasons(rule: z.infer<typeof strategyRuleSchema>, post: PostOpportunity): string[] {
    const r: string[] = [CATEGORY_REASON[rule.category]];

    // DNA-derived author reasons
    if (rule.selectionReasons && rule.selectionReasons.length > 0) {
      r.push(...rule.selectionReasons.slice(0, 2));
    }

    // Post-level curation context
    if (post.postScore >= 90) r.push("Optimales Curation-Fenster (< 30 Min.)");
    else if (post.postScore >= 70) r.push(`Post ${post.ageMinutes < 1440 ? Math.round(post.ageMinutes / 60) + "h" : Math.round(post.ageMinutes / 1440) + "d"} alt — gutes Curation-Fenster`);

    if (post.remainingHours < 24 && post.remainingHours > 0) {
      r.push(`⚠ Nur noch ${post.remainingHours.toFixed(0)}h bis Auszahlung`);
    }

    // VP context
    if (vpDelta > 10) r.push("VP-Überschuss — volles Gewicht verfügbar");
    if (vpDelta < -10) r.push(`VP ${currentVpPct.toFixed(1)}% — Gewicht reduziert`);

    return r;
  }

  // 1. Per author: select the BEST eligible post (not all)
  //    Ranking: postScore desc → remainingHours desc → ageMinutes asc
  const allCandidates: VotePlanEntry[] = [];

  for (const rule of params.rules) {
    if (!rule.enabled || rule.category === "ignorieren") continue;

    const posts   = params.posts.get(rule.username) ?? [];
    const eligible = posts
      .filter(p => p.eligible)
      .sort((a, b) => {
        // Primary: curation timing score (higher = better)
        if (b.postScore !== a.postScore) return b.postScore - a.postScore;
        // Secondary: more remaining time = better
        if (b.remainingHours !== a.remainingHours) return b.remainingHours - a.remainingHours;
        // Tertiary: newer post wins
        return a.ageMinutes - b.ageMinutes;
      });

    // Pick top posts per author (score-sorted), limit by category priority:
    // immer_voten/lieblingsautor: up to 3 posts · others: top 1
    const maxPosts = (rule.category === "immer_voten" || rule.category === "lieblingsautor") ? 3 : 1;
    const selected = eligible.slice(0, maxPosts);
    if (selected.length === 0) continue;

    const weightBps = adjustedWeightBps(rule);
    const weightPct = Math.round(weightBps / 100 * 10) / 10;

    // Skip dust votes — if weight is below meaningful minimum for this category, don't include
    if (isDustVote(weightBps, rule.category)) continue;

    for (const post of selected) {
      const reasons = buildReasons(rule, post);
      allCandidates.push({
        author:             post.author,
        permlink:           post.permlink,
        title:              post.title || `${post.author}/${post.permlink}`,
        ageMinutes:         post.ageMinutes,
        remainingHours:     post.remainingHours,
        postScore:          post.postScore,
        category:           rule.category as StrategyCategory,
        priority:           PRIORITY_SCORE[rule.category as StrategyCategory],
        suggestedWeightPct: weightPct,
        suggestedWeightBps: weightBps,
        expectedVoteUsd:    Math.round((weightBps / 10_000) * params.currentVoteUsd * 10_000) / 10_000,
        reason:             reasons[0],
        reasons,
        warning:            post.warning,
      });
    }
  }

  // 2. Sort: priority desc → postScore desc → age asc
  allCandidates.sort((a, b) => {
    if (b.priority !== a.priority)   return b.priority   - a.priority;
    if (b.postScore !== a.postScore) return b.postScore  - a.postScore;
    return a.ageMinutes - b.ageMinutes;
  });

  // 3. Apply constraints — greedy selection by priority.
  //    Heavy votes (e.g. 100% lieblingsautor) are SKIPPED if they don't fit,
  //    allowing smaller-weight votes later in the list to still be included.
  //    Only hard stops: max_votes reached, or remaining budget can't fit ANY candidate.
  const STOP_LABELS: Record<StopReason, string> = {
    max_votes: `Limit erreicht: max. ${maxVotesPerRun} Votes pro Run`,
    max_spend: `Budget erschöpft: max. ${maxVpSpendPct}% VP-Verbrauch erreicht`,
    min_vp:    `VP-Boden erreicht: unter ${minVpPct}% VP`,
    none:      "Alle verfügbaren Posts eingeschlossen",
  };

  const included: VotePlanEntry[] = [];
  let spentPct   = 0;
  let stoppedBy: StopReason = "none";

  for (const entry of allCandidates) {
    const entrySpendPct = entry.suggestedWeightBps / 100;

    // Hard stop: vote count cap reached
    if (included.length >= maxVotesPerRun) {
      stoppedBy = "max_votes"; break;
    }

    // Skip this individual entry if it doesn't fit — DON'T break, try next
    const wouldVpDrop = currentVpPct - spentPct - entrySpendPct < minVpPct;
    const wouldExceedBudget = spentPct + entrySpendPct > effectiveBudgetPct;

    if (wouldVpDrop || wouldExceedBudget) {
      // Track why entries are being skipped (for report), but keep going
      if (stoppedBy === "none") {
        stoppedBy = wouldVpDrop ? "min_vp" : "max_spend";
      }
      continue; // ← key fix: skip heavy vote, try next lighter candidate
    }

    included.push(entry);
    spentPct += entrySpendPct;
  }

  // If we included some votes but hit limits along the way, keep the stopReason for info
  // If ALL candidates were included successfully, mark as "none"
  if (included.length === allCandidates.length) stoppedBy = "none";

  const report: ConstraintReport = {
    minVpPct,
    maxVotesPerRun,
    maxVpSpendPct,
    effectiveBudgetPct:  Math.round(effectiveBudgetPct * 10) / 10,
    includedVotes:       included.length,
    excludedVotes:       allCandidates.length - included.length,
    stoppedBy,
    stoppedByLabel:      STOP_LABELS[stoppedBy],
    vpAfterPlanPct:      Math.round((currentVpPct - spentPct) * 10) / 10,
  };

  return { entries: included, report };
}

// ── Batch fetch helper ────────────────────────────────────────────────────────

async function fetchAllPosts(authors: string[], voter: string): Promise<Map<string, PostOpportunity[]>> {
  const map = new Map<string, PostOpportunity[]>();
  const BATCH = 5;
  for (let i = 0; i < authors.length; i += BATCH) {
    const batch = authors.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(a => fetchRecentPostsWithVotes(a, voter))
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") map.set(batch[j], r.value);
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
    const targetVpPct  = body.data.targetVpPct ?? 85;
    const constraints  = {
      minVpPct:       body.data.constraints?.minVpPct       ?? 70,
      maxVotesPerRun: body.data.constraints?.maxVotesPerRun ?? 10,
      maxVpSpendPct:  body.data.constraints?.maxVpSpendPct  ?? 10,
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
    const { entries, report } = buildVotePlan({ rules, posts: postMap, currentVpBps, targetVpPct, currentVoteUsd, constraints });

    const totalSpendBps  = entries.reduce((s, e) => s + e.suggestedWeightBps, 0);
    const spendPct       = Math.round(totalSpendBps / 100 * 10) / 10;
    const sustainability: "sustainable" | "aggressive" | "critical" =
      totalSpendBps <= 2000 ? "sustainable" :
      totalSpendBps <= 3000 ? "aggressive"  : "critical";

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
}
