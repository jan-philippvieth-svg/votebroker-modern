import { analyzeCurationHistory } from "@votebroker/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { fetchVoteHistory } from "../chain/voteHistory.js";
import { fetchRecentPostsWithVotes, fetchRecentPostsDebug, type PostOpportunity } from "../chain/recentPosts.js";
import { getSession } from "../auth/sessionStore.js";
import { getGrowthData } from "./growthService.js";
import { getDb } from "../db/index.js";
import { operatorConfig } from "../config.js";
import { getUserSettings, saveUserSettings, isValidTimezone } from "../settings/settingsStore.js";
import { utcOffsetMinutes } from "../utils/timezone.js";
import { getPostCacheMetrics } from "../chain/postCache.js";

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
  maxWeightPct:      z.number().min(0).max(100).default(100),
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
  filteredByMinWeight:    number;   // votes removed because weight fell below category minimum
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
          reasons: buildReasons({ username: e.author, category: cat, maxWeightPct: 0, minWeightPct: 0, enabled: true, selectionReasons: [] }, { author: e.author, permlink: e.permlink, title: e.title, ageMinutes: e.ageMinutes, remainingHours: e.remainingHours, postScore: e.postScore, pendingPayoutSbd: 0, eligible: true, alreadyVoted: false, isSelfPost: false, warning: e.warning, activeVotesCount: 0, community: null }, true),
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
          reasons: buildReasons({ username: e.author, category: cat, maxWeightPct: 0, minWeightPct: 0, enabled: true, selectionReasons: [] }, { author: e.author, permlink: e.permlink, title: e.title, ageMinutes: e.ageMinutes, remainingHours: e.remainingHours, postScore: e.postScore, pendingPayoutSbd: 0, eligible: true, alreadyVoted: false, isSelfPost: false, warning: e.warning, activeVotesCount: 0, community: null }, true),
        };
      });
    }
  }

  // Phase B — remove categories if still over budget
  for (const cat of REDUCTION_ORDER) {
    if (totalSpend(working) <= dynamicBudgetPct) break;
    working = working.filter(e => e.category !== cat);
  }

  // Phase A.5 — Mindestvote-Filter: Votes unterhalb des konfigurierten Minimums entfernen
  // und frei werdende VP proportional auf verbleibende Votes verteilen
  const rulesMap = new Map(params.rules.map(r => [r.username, r]));
  let filteredByMinWeight = 0;
  const preMinFilter = working;

  working = working.filter(e => {
    const rule = rulesMap.get(e.author);
    const minBps = rule ? Math.round(rule.minWeightPct * 100) : 0;
    if (minBps > 0 && e.suggestedWeightBps < minBps) {
      filteredByMinWeight++;
      return false;
    }
    return true;
  });

  // Frei gewordene VP auf verbleibende Votes verteilen (bis zu deren maxWeightPct)
  if (filteredByMinWeight > 0 && working.length > 0) {
    const removedKeys = new Set(
      preMinFilter
        .filter(e => !working.some(w => w.author === e.author && w.permlink === e.permlink))
        .map(e => `${e.author}/${e.permlink}`)
    );
    const freedBps = preMinFilter
      .filter(e => removedKeys.has(`${e.author}/${e.permlink}`))
      .reduce((s, e) => s + e.suggestedWeightBps, 0);

    if (freedBps > 0) {
      const headrooms = working.map(e => {
        const rule = rulesMap.get(e.author);
        const maxBps = rule ? Math.round(rule.maxWeightPct * 100) : e.suggestedWeightBps;
        return Math.max(0, maxBps - e.suggestedWeightBps);
      });
      const totalHeadroom = headrooms.reduce((a, b) => a + b, 0);

      if (totalHeadroom > 0) {
        working = working.map((e, i) => {
          if (headrooms[i] === 0) return e;
          const addBps = Math.min(headrooms[i], Math.round(freedBps * headrooms[i] / totalHeadroom));
          if (addBps === 0) return e;
          const newBps = e.suggestedWeightBps + addBps;
          return {
            ...e,
            suggestedWeightBps: newBps,
            suggestedWeightPct: Math.round(newBps / 100 * 10) / 10,
            expectedVoteUsd:    Math.round((newBps / 10_000) * params.currentVoteUsd * 10_000) / 10_000,
          };
        });
      }
    }
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
    filteredByMinWeight,
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

// ── Per-user scan result cache (90s TTL) ──────────────────────────────────────
// Prevents blast when multiple tabs or background polls call simultaneously.
// Key: voterUsername — author list is strategy-specific per user.

interface ScanCacheEntry {
  result: {
    opportunities: PostOpportunity[];
    meta: {
      requestedAuthors: number; scannedAuthors: number;
      totalPosts: number; eligiblePosts: number;
      perAuthor: Record<string, { scanned: number; eligible: number; alreadyVoted: number; noRecentPosts: boolean }>;
    };
  };
  authorsKey: string; // sorted author list — invalidate if strategy changes
  cachedAt:   number;
}

const SCAN_CACHE_TTL_MS = 120_000;
const scanCache = new Map<string, ScanCacheEntry>();

function getScanCacheKey(authors: string[]): string {
  return [...authors].sort().join(",");
}

// ── Batch fetch helper ────────────────────────────────────────────────────────

async function fetchAllPosts(authors: string[], voter: string): Promise<Map<string, PostOpportunity[]>> {
  // Build local voted-key set to catch votes not yet visible on-chain
  const recentlyVoted = getRecentlyVotedKeys(voter);

  const map = new Map<string, PostOpportunity[]>();
  const BATCH = 10;
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

  app.get("/api/curation/constants", {
    schema: { tags: ["Curation"], summary: "Planner-Konstanten: Dust-Floors und Kategorie-Grenzen" }
  }, async () => ({
    categoryDustBps: CATEGORY_DUST_BPS,
  }));

  app.get("/api/curation/dna", {
    schema: { tags: ["Curation"], summary: "Curation-DNA eines Accounts analysieren", querystring: zodToJsonSchema(dnaQuerySchema) }
  }, async (request, reply) => {
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

  app.post("/api/curation/opportunities", {
    schema: { tags: ["Curation"], summary: "Vote-Opportunities für Autoren-Liste abrufen", body: zodToJsonSchema(opportunitiesSchema), security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const body = opportunitiesSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request", detail: body.error.flatten() });
    }
    const { authors, voterUsername } = body.data;

    // Cache check — serve without blockchain scan if result is fresh
    const authorsKey = getScanCacheKey(authors);
    const cached = scanCache.get(voterUsername);
    if (cached && cached.authorsKey === authorsKey && Date.now() - cached.cachedAt < SCAN_CACHE_TTL_MS) {
      request.log.info({ voterUsername, authorCount: authors.length, fromCache: true }, "opportunity-scan: cache hit");
      return cached.result;
    }

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

    const cm = getPostCacheMetrics();
    request.log.info({
      voterUsername,
      authorCount: authors.length,
      eligiblePosts: eligibleCount,
      totalPosts: all.length,
      cacheHits: cm.hits,
      cacheMisses: cm.misses,
      cacheHitRatePct: cm.hitRatePct,
      cacheAvgAgeMs: cm.avgHitAgeMs,
    }, "opportunity-scan: results");

    const result = {
      opportunities: all,
      meta: {
        requestedAuthors: authors.length,
        scannedAuthors:   Object.keys(perAuthor).length,
        totalPosts:       all.length,
        eligiblePosts:    eligibleCount,
        perAuthor,
      },
    };

    scanCache.set(voterUsername, { result, authorsKey, cachedAt: Date.now() });
    return result;
  });

  // Debug endpoint — shows every post and why it was accepted or rejected
  app.post("/api/curation/opportunities/debug", {
    schema: { tags: ["Curation"], summary: "Opportunities mit Debug-Infos (intern)", body: zodToJsonSchema(opportunitiesSchema) }
  }, async (request, reply) => {
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
  app.post("/api/curation/generate", {
    schema: { tags: ["Curation"], summary: "Vote-Plan generieren", body: zodToJsonSchema(generateSchema), security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
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
  app.post("/api/me/votebroker-earnings/rebuild", {
    schema: { tags: ["Account"], summary: "VoteBroker-Earnings-Cache aus Chain neu aufbauen", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
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

  // ── POST /api/me/vote-outcomes/rebuild — populate vb_global_vote_outcomes ────
  // Accepts either user session OR operator token (for cron jobs).
  // With operator token: rebuilds for all users that have audit_events.
  app.post("/api/me/vote-outcomes/rebuild", {
    schema: { tags: ["Account"], summary: "Globale Vote-Outcomes neu aufbauen", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const opToken = (request.headers as Record<string, string>)["x-operator-token"];
    const isOperator = opToken && opToken === operatorConfig.token && !!operatorConfig.token;

    const sessionToken = (request.headers as Record<string, string>)["session"];
    const session = sessionToken ? getSession(sessionToken) : null;

    if (!isOperator && !session) return reply.code(401).send({ error: "unauthorized" });

    try {
      const { populateGlobalVoteOutcomes, getVoteOutcomeSummary } =
        await import("../chain/globalVoteOutcomes.js");

      if (isOperator) {
        // Rebuild for all users with audit_events
        const users = getDb().prepare(
          "SELECT DISTINCT username FROM audit_events WHERE type='vote_broadcast_success'"
        ).all() as Array<{ username: string }>;

        const results = [];
        for (const { username } of users) {
          const result = await populateGlobalVoteOutcomes(username, request.log as unknown as typeof console);
          const summary = getVoteOutcomeSummary(username);
          results.push({ username, ...result, summary });
        }
        return { users: results.length, results };
      }

      const result  = await populateGlobalVoteOutcomes(
        session!.user.username,
        request.log as unknown as typeof console,
      );
      const summary = getVoteOutcomeSummary(session!.user.username);
      return { ...result, summary };
    } catch (err) {
      return reply.code(502).send({
        error:  "global_outcomes_rebuild_failed",
        detail: err instanceof Error ? err.message : "unknown",
      });
    }
  });

  // ── GET /api/me/vote-outcomes/summary — timing analytics summary ─────────────
  app.get("/api/me/vote-outcomes/summary", {
    schema: { tags: ["Account"], summary: "Vote-Outcomes Timing-Statistik", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const token   = (request.headers as Record<string, string>)["session"];
    const session = token ? getSession(token) : null;
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    try {
      const { getVoteOutcomeSummary } = await import("../chain/globalVoteOutcomes.js");
      return getVoteOutcomeSummary(session.user.username);
    } catch (err) {
      return reply.code(502).send({ error: "summary_failed" });
    }
  });

  // ── GET /api/me/vote-outcomes/live-report — first real analytics baseline ────
  // Filters to votes from LIVE_VOTES_SINCE onwards (post-recordVoteAtBroadcast).
  // Only realized entries are included in the 5 analysis dimensions.
  app.get("/api/me/vote-outcomes/live-report", {
    schema: { tags: ["Account"], summary: "Live-Vote-Report (ab Echtzeit-Erfassung)", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const token   = (request.headers as Record<string, string>)["session"];
    const session = token ? getSession(token) : null;
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    try {
      const { getLiveVoteReport } = await import("../chain/globalVoteOutcomes.js");
      return getLiveVoteReport(session.user.username);
    } catch (err) {
      return reply.code(502).send({ error: "live_report_failed",
        detail: err instanceof Error ? err.message : "unknown" });
    }
  });

  // ── GET /api/me/vote-outcomes/growth-analytics ───────────────────────────────
  app.get("/api/me/vote-outcomes/growth-analytics", {
    schema: { tags: ["Account"], summary: "Post-Growth-Analytics: final/pending Pool-Wachstum nach Dimension", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const token   = (request.headers as Record<string, string>)["session"];
    const session = token ? getSession(token) : null;
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    try {
      const { getGrowthAnalytics } = await import("../chain/globalVoteOutcomes.js");
      return getGrowthAnalytics(session.user.username);
    } catch (err) {
      return reply.code(502).send({ error: "growth_analytics_failed",
        detail: err instanceof Error ? err.message : "unknown" });
    }
  });

  // ── GET /api/me/vote-outcomes/growth-analytics/version ────────────────────────
  // Lightweight endpoint: returns only { dataVersion, n } — no computation.
  // Frontend polls this cheaply and triggers a full refetch only when dataVersion changed.
  app.get("/api/me/vote-outcomes/growth-analytics/version", {
    schema: { tags: ["Account"], summary: "Growth-Analytics Datenstand (cheap version check)", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const token   = (request.headers as Record<string, string>)["session"];
    const session = token ? getSession(token) : null;
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const db  = getDb();
    const row = db.prepare(`
      SELECT COUNT(*) as n, MAX(realized_at) as data_version
      FROM vb_global_vote_outcomes
      WHERE voter = ?
        AND post_final_payout_sbd IS NOT NULL
        AND post_pending_payout_sbd > 0.01
    `).get(session.user.username) as { n: number; data_version: string | null };

    return { dataVersion: row.data_version ?? null, n: row.n };
  });

  // ── GET /api/me/votebroker-earnings — VoteBroker-attributed curation ────────
  app.get("/api/me/votebroker-earnings", {
    schema: { tags: ["Account"], summary: "VoteBroker-zugerechnete Curation-Earnings", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const token   = (request.headers as Record<string, string>)["session"];
    const session = token ? getSession(token) : null;
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const rawPeriod = (request.query as Record<string, string>)["period"] ?? "30d";
    const period    = (["7d", "30d", "90d", "all"] as const).find(p => p === rawPeriod) ?? "30d";

    try {
      const tz = getUserSettings(session.user.username).timezone;
      const { fetchVBEarnings } = await import("../chain/voteBrokerEarnings.js");
      return await fetchVBEarnings(session.user.username, period, tz);
    } catch (err) {
      return reply.code(502).send({ error: "earnings_fetch_failed",
        detail: err instanceof Error ? err.message : "unknown" });
    }
  });

  // ── GET /api/me/growth — curator growth time series ──────────────────────
  // Returns daily vote + author data derived from audit_events.
  // No USD impact: historical SP/price not stored — won't fake it.
  app.get("/api/me/growth", {
    schema: { tags: ["Account"], summary: "Curator-Wachstums-Zeitreihe", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const token   = (request.headers as Record<string, string>)["session"];
    const session = token ? getSession(token) : null;
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const rawPeriod = (request.query as Record<string, string>)["period"] ?? "30d";
    const period    = (["30d", "90d", "all"] as const).includes(rawPeriod as "30d" | "90d" | "all")
      ? rawPeriod as "30d" | "90d" | "all"
      : "30d";

    const tz = getUserSettings(session.user.username).timezone;
    return getGrowthData(session.user.username, period, tz);
  });

  // ── GET /api/me/daily-history — last N days, votes + authors + weight ──────
  app.get("/api/me/daily-history", {
    schema: { tags: ["Account"], summary: "Tages-Verlauf (Votes, Autoren, Gewicht)", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const token   = (request.headers as Record<string, string>)["session"];
    const session = token ? getSession(token) : null;
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const rawDays = parseInt((request.query as Record<string, string>)["days"] ?? "7", 10);
    const days    = Math.min(Math.max(rawDays, 1), 30);

    const db = getDb();
    const since = days - 1;

    // Use user's timezone offset so DATE() groups by local calendar day, not UTC.
    const tz = getUserSettings(session.user.username).timezone;
    const offsetMin = utcOffsetMinutes(tz);

    const rows = db.prepare(`
      SELECT
        DATE(datetime(created_at, '+${offsetMin} minutes')) AS day,
        COUNT(*)                 AS votes,
        COUNT(DISTINCT author)   AS unique_authors,
        COALESCE(SUM(ABS(weight_bps)), 0) AS total_weight_bps
      FROM audit_events
      WHERE type = 'vote_broadcast_success'
        AND username = ?
        AND DATE(datetime(created_at, '+${offsetMin} minutes'))
              >= DATE(datetime('now', '+${offsetMin} minutes'), '-' || ? || ' days')
      GROUP BY day
      ORDER BY day DESC
    `).all(session.user.username, since) as Array<{
      day: string; votes: number; unique_authors: number; total_weight_bps: number;
    }>;

    const totals = db.prepare(`
      SELECT
        COUNT(*)                 AS total_votes,
        COUNT(DISTINCT author)   AS total_unique_authors,
        COALESCE(SUM(ABS(weight_bps)), 0) AS total_weight_bps
      FROM audit_events
      WHERE type = 'vote_broadcast_success'
        AND username = ?
        AND DATE(datetime(created_at, '+${offsetMin} minutes'))
              >= DATE(datetime('now', '+${offsetMin} minutes'), '-' || ? || ' days')
    `).get(session.user.username, since) as {
      total_votes: number; total_unique_authors: number; total_weight_bps: number;
    };

    const bestDay    = rows.reduce((a, b) => b.votes > a.votes ? b : a, rows[0] ?? null);
    const weakestDay = rows.filter(r => r.votes > 0)
                           .reduce((a, b) => b.votes < a.votes ? b : a, rows.filter(r => r.votes > 0)[0] ?? null);

    return {
      days: rows,
      summary: {
        totalVotes:        totals?.total_votes          ?? 0,
        totalUniqueAuthors: totals?.total_unique_authors ?? 0,
        totalWeightBps:    totals?.total_weight_bps     ?? 0,
        bestDay:           bestDay  ? { day: bestDay.day,    votes: bestDay.votes }    : null,
        weakestDay:        weakestDay ? { day: weakestDay.day, votes: weakestDay.votes } : null,
      },
    };
  });

  // ── GET /api/me/vp-budget — VP spend vs regen analysis ───────────────────
  app.get("/api/me/vp-budget", {
    schema: { tags: ["Account"], summary: "VP-Budget: täglicher Verbrauch vs. Regen", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const token   = (request.headers as Record<string, string>)["session"];
    const session = token ? getSession(token) : null;
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const db = getDb();
    const username = session.user.username;

    // Use user's timezone for all daily groupings
    const tz = getUserSettings(username).timezone;
    const offsetMin = utcOffsetMinutes(tz);

    // Last 7 days of votes: daily weight sum grouped by local calendar day
    const dailyVotes = db.prepare(`
      SELECT
        DATE(datetime(created_at, '+${offsetMin} minutes')) AS day,
        COUNT(*)                      AS votes,
        COALESCE(SUM(ABS(weight_bps)), 0) AS weight_bps
      FROM audit_events
      WHERE type = 'vote_broadcast_success'
        AND username = ?
        AND DATE(datetime(created_at, '+${offsetMin} minutes'))
              >= DATE(datetime('now', '+${offsetMin} minutes'), '-7 days')
      GROUP BY day
      ORDER BY day DESC
    `).all(username) as Array<{ day: string; votes: number; weight_bps: number }>;

    // Latest VP snapshot
    const vpSnap = db.prepare(
      "SELECT vp_bps FROM vb_vp_snapshots WHERE username = ? ORDER BY sampled_at DESC LIMIT 1"
    ).get(username) as { vp_bps: number } | undefined;

    // VP time-series: min vp_bps per day for last 7 days, grouped by local calendar day
    const vpTrend = db.prepare(`
      SELECT
        DATE(datetime(sampled_at, '+${offsetMin} minutes')) AS day,
        MIN(vp_bps) AS min_vp_bps,
        MAX(vp_bps) AS max_vp_bps
      FROM vb_vp_snapshots
      WHERE username = ?
        AND DATE(datetime(sampled_at, '+${offsetMin} minutes'))
              >= DATE(datetime('now', '+${offsetMin} minutes'), '-7 days')
      GROUP BY day
      ORDER BY day ASC
    `).all(username) as Array<{ day: string; min_vp_bps: number; max_vp_bps: number }>;

    // Compute averages over last 7 days
    const activeDays = dailyVotes.length;
    const totalVotes7d  = dailyVotes.reduce((s, r) => s + r.votes, 0);
    const totalWeight7d = dailyVotes.reduce((s, r) => s + r.weight_bps, 0);

    // VP cost per vote: weight_bps / 50 = cost in bps
    // Daily spend in bps (averaged over active days, or 7 if 0 active)
    const divisor          = Math.max(activeDays, 1);
    const avgDailyVotes    = Math.round((totalVotes7d  / divisor) * 10) / 10;
    const avgDailyWeightBps = Math.round(totalWeight7d / divisor);
    const avgDailySpendBps  = Math.round(avgDailyWeightBps / 50); // VP cost in bps
    const regenBps          = 2000; // 20%/day = 2000 bps
    const netDailyBps       = regenBps - avgDailySpendBps;

    // Avg weight per vote in bps (for sustainable votes calculation)
    const avgWeightPerVoteBps = totalVotes7d > 0
      ? Math.round(totalWeight7d / totalVotes7d)
      : 5000; // fallback: assume 50%

    // Sustainable votes/day = daily regen / cost per vote
    // cost per vote = avgWeightPerVoteBps / 50
    const sustainableVotesPerDay = avgWeightPerVoteBps > 0
      ? Math.round((regenBps / (avgWeightPerVoteBps / 50)) * 10) / 10
      : null;

    const status: "recovering" | "stable" | "depleting" =
      netDailyBps > 100  ? "recovering" :
      netDailyBps < -100 ? "depleting"  : "stable";

    return {
      currentVpBps:         vpSnap?.vp_bps ?? null,
      avgDailyVotes,
      avgDailySpendBps,
      avgDailyWeightBps,
      regenBps,
      netDailyBps,
      sustainableVotesPerDay,
      avgWeightPct:         Math.round(avgWeightPerVoteBps / 100),
      status,
      activeDaysIn7d:       activeDays,
      vpTrend,
    };
  });
}

// ── User Settings routes ───────────────────────────────────────────────────────

export function registerUserSettingsRoutes(app: FastifyInstance): void {
  // GET /api/me/settings
  app.get("/api/me/settings", {
    schema: { tags: ["Account"], summary: "User-Einstellungen (Zeitzone etc.)", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const token = (request.headers as Record<string, string>)["session"];
    const session = token ? getSession(token) : null;
    if (!session) return reply.code(401).send({ error: "unauthorized" });
    return getUserSettings(session.user.username);
  });

  // PATCH /api/me/settings
  app.patch("/api/me/settings", {
    schema: { tags: ["Account"], summary: "User-Einstellungen speichern", security: [{ sessionToken: [] }] }
  }, async (request, reply) => {
    const token = (request.headers as Record<string, string>)["session"];
    const session = token ? getSession(token) : null;
    if (!session) return reply.code(401).send({ error: "unauthorized" });

    const body = request.body as Record<string, unknown>;
    if (body.timezone !== undefined && !isValidTimezone(body.timezone)) {
      return reply.code(400).send({ error: "invalid_timezone", message: "Unbekannte IANA-Zeitzone" });
    }
    return saveUserSettings(session.user.username, {
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
    });
  });
}
