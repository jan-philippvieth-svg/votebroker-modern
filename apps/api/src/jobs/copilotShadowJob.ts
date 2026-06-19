/**
 * CoPilot Shadow Job — Dry-Run Vote Intelligence
 *
 * Runs every 30 minutes. For each user who has granted `auto_vote` consent
 * and has a strategy configured, this job evaluates which posts the CoPilot
 * *would* vote and why — but sends no broadcasts.
 *
 * Each decision is written to `vb_copilot_shadow_runs` with full signal context
 * so decisions can be reviewed manually before autonomous execution is ever enabled.
 *
 * Scoring gate: candidates below the per-category minimum postScore are rejected.
 * This prevents spending VP on stale posts when a fresher post may appear soon.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";
import { hasConsent } from "../consent/consentStore.js";
import { loadStrategy } from "../strategy/strategyStore.js";
import { fetchRecentPostsWithVotes, type PostOpportunity } from "../chain/recentPosts.js";
import { calcOpportunityScore, OPPORTUNITY_GATE } from "../chain/opportunityScore.js";
import { calcOpportunityScoreV4, V4_VERSION, type V4Result, type V4Params } from "../chain/opportunityScoreV4.js";
import { MIN_GROWTH_FACTOR_SAMPLE } from "./signalCompute.js";
import { getPostCacheMetrics } from "../chain/postCache.js";
import { vpCostBps, dynamicBudgetPct } from "../curation/budgetMath.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type StrategyCategory = "immer_voten" | "lieblingsautor" | "bevorzugt" | "normal" | "niedrig" | "ignorieren";

interface StrategyRule {
  username:         string;
  category:         StrategyCategory;
  maxWeightPct:     number;
  minWeightPct:     number;
  enabled:          boolean;
  selectionReasons: string[];
}

type ShadowDecision = "would_vote" | "skip_score" | "skip_no_posts" | "skip_already_voted" | "skip_budget";

interface ShadowRow {
  id:                   string;
  run_id:               string;
  username:             string;
  run_at:               string;
  decision:             ShadowDecision;
  author:               string | null;
  permlink:             string | null;
  title:                string | null;
  category:             string | null;
  post_score:           number | null;
  score_gate:           number | null;
  suggested_weight_bps: number | null;
  vp_cost_bps:          number | null;
  expected_vote_usd:    number | null;
  reasons_json:         string | null;
  skip_reason:          string | null;
  vp_bps_at_run:        number;
  vp_budget_bps:        number;
  signals_json:         string | null;
  // Shadow model v4 — side-by-side verdict on the same candidate. Optional here:
  // candidate-bearing rows set them via v4Fields(); the rest default to null at insert.
  v4_score?:                 number | null;
  v4_decision?:              string | null;
  v4_components?:            string | null;
  v4_version?:               string | null;
  author_prior_used?:        number | null;
  author_history_available?: number | null;
}

// VP cost (vp_cost_bps = weight_bps / 50) is shared with the planner — see
// curation/budgetMath.ts. Steem regenerates 20 pp of VP per day.
const DAILY_REGEN_BPS = 2_000;

// ── VP helpers ────────────────────────────────────────────────────────────────

interface VpContext {
  vpBps:       number;   // current VP (0–10 000)
  budgetBps:   number;   // VP available to spend today while keeping tomorrow at target
  voteUsd:     number;   // value of a 100% vote in USD
}

function getVpContext(username: string): VpContext | null {
  const db = getDb();

  // Latest sampled VP snapshot
  const snap = db.prepare(`
    SELECT vp_bps, sp_approx FROM vb_vp_snapshots
    WHERE username = ? ORDER BY sampled_at DESC LIMIT 1
  `).get(username) as { vp_bps: number; sp_approx: number } | undefined;

  if (!snap) return null;

  const vpBps      = snap.vp_bps;
  const vpPct      = vpBps / 100;
  const targetPct  = 80;                              // floor: keep tomorrow at 80%
  const budgetPct   = dynamicBudgetPct(vpPct, targetPct, DAILY_REGEN_BPS / 100);
  const budgetBps   = Math.round(budgetPct * 100);

  // Approximate full-power vote value: SP × 0.02 × (current VP / 100) × SBD price ≈ USD
  // We use SP as a rough proxy (1 SP ≈ 1 SBD for this estimate).
  const voteUsd = Math.round(snap.sp_approx * 0.02 * (vpPct / 100) * 10_000) / 10_000;

  return { vpBps, budgetBps, voteUsd };
}

// ── Recently voted buffer (audit_events catches lag before chain sync) ────────

function getRecentlyVotedKeys(voter: string): Set<string> {
  const since = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  const rows = getDb().prepare(`
    SELECT author, permlink FROM audit_events
    WHERE username = ? AND type IN ('vote_broadcast_success', 'vote_broadcast_attempt')
      AND author IS NOT NULL AND created_at >= ?
  `).all(voter, since) as Array<{ author: string; permlink: string }>;
  return new Set(rows.map(r => `${r.author}/${r.permlink}`));
}

// ── Whale signal lookup (optional enrichment) ─────────────────────────────────

interface WhaleSignal {
  whaleCount:       number;
  avgPayoutSbd:     number;
  avgGrowthFactor:  number | null;
  // Extra fields v4 consumes (v3 ignores these) — quality priors, whale-robust.
  medianPayoutSbd:  number | null;
  whaleFollowRate:  number | null;
  spPerVpCv:        number | null;
}

function getWhaleSignal(author: string): WhaleSignal | null {
  const row = getDb().prepare(`
    SELECT whale_count, avg_payout_sbd, median_payout_sbd, whale_follow_rate,
           sp_per_vp_cv, avg_growth_factor, gf_sample_n
    FROM vb_signal_author WHERE author = ?
  `).get(author) as {
    whale_count: number; avg_payout_sbd: number; median_payout_sbd: number | null;
    whale_follow_rate: number | null; sp_per_vp_cv: number | null;
    avg_growth_factor: number | null; gf_sample_n: number | null;
  } | undefined;
  if (!row) return null;
  // Only expose growth factor when sample is large enough to be reliable
  const reliableGf = (row.gf_sample_n ?? 0) >= MIN_GROWTH_FACTOR_SAMPLE ? row.avg_growth_factor : null;
  return {
    whaleCount:      row.whale_count ?? 0,
    avgPayoutSbd:    row.avg_payout_sbd ?? 0,
    avgGrowthFactor: reliableGf,
    medianPayoutSbd: row.median_payout_sbd,
    whaleFollowRate: row.whale_follow_rate,
    spPerVpCv:       row.sp_per_vp_cv,
  };
}

// ── Community signal lookup (vb_signal_community) — weak prior for v4 ──────────

function getCommunityAvgPayout(community: string | null): number | undefined {
  if (!community) return undefined;
  const row = getDb().prepare(
    `SELECT avg_payout_sbd FROM vb_signal_community WHERE community = ?`
  ).get(community) as { avg_payout_sbd: number | null } | undefined;
  return row?.avg_payout_sbd ?? undefined;
}

// ── v4 shadow model glue ──────────────────────────────────────────────────────
// v4 is scored on the SAME candidate v3 logs (true per-candidate side-by-side).
// It never broadcasts; these fields land in the existing shadow row next to v3's.

interface V4RowFields {
  v4_score:                 number | null;
  v4_decision:              string | null;
  v4_components:            string | null;
  v4_version:               string | null;
  author_prior_used:        number | null;   // unknownAuthorPrior applied (null = real history used)
  author_history_available: number | null;   // 1 = author history present, 0 = prior used, null = no candidate
}

const V4_NULL: V4RowFields = {
  v4_score: null, v4_decision: null, v4_components: null, v4_version: null,
  author_prior_used: null, author_history_available: null,
};

function buildV4Params(category: string, post: PostOpportunity, whale: WhaleSignal | null): V4Params {
  return {
    ageMinutes:            post.ageMinutes,
    remainingHours:        post.remainingHours,
    pendingPayoutSbd:      post.pendingPayoutSbd,
    activeVotesCount:      post.activeVotesCount,
    isSelfPost:            post.isSelfPost,
    category,
    authorMedianPayoutSbd: whale?.medianPayoutSbd ?? undefined,
    authorAvgPayoutSbd:    whale?.avgPayoutSbd ?? undefined,
    whaleCount:            whale?.whaleCount ?? undefined,
    whaleFollowRate:       whale?.whaleFollowRate ?? undefined,
    spPerVpCv:             whale?.spPerVpCv ?? undefined,
    communityAvgPayoutSbd: getCommunityAvgPayout(post.community),
  };
}

// Map a V4Result (+ optional independent-pick divergence note) to row columns.
function v4Fields(
  v4: V4Result,
  independentBest?: { permlink: string; score: number; diverges: boolean },
): V4RowFields {
  const decision = v4.hardSkip != null ? "skip_hard" : v4.wouldAct ? "would_vote" : "skip_score";
  return {
    v4_score:                 v4.score,
    v4_decision:              decision,
    v4_components:            JSON.stringify({ ...v4.components, pGood: v4.pGood, threshold: v4.threshold, hardSkip: v4.hardSkip, independentBest }),
    v4_version:               V4_VERSION,
    author_prior_used:        v4.authorPriorUsed,
    author_history_available: v4.authorHistoryAvailable ? 1 : 0,
  };
}

// ── Author history lookup (sp_per_vp from realized votes) ─────────────────────

function getAuthorAvgSpPerVp(voter: string, author: string): number | undefined {
  const row = getDb().prepare(`
    SELECT AVG(realized_curation_sp / (weight_bps / 10000.0)) as avg_sp_per_vp,
           COUNT(*) as n
    FROM vb_global_vote_outcomes
    WHERE voter = ? AND author = ? AND realized_curation_sp IS NOT NULL AND weight_bps > 0
  `).get(voter, author) as { avg_sp_per_vp: number | null; n: number } | undefined;
  if (!row || row.n < 3 || row.avg_sp_per_vp === null) return undefined; // need ≥3 data points
  return row.avg_sp_per_vp;
}

// ── Author shadow precision (fraction of resolved would_vote that paid ≥1 SBD) ──
// Minimum 5 resolved votes required for reliability. Used as Gate-3 exception:
// authors with proven shadow quality bypass the "niedrig + no whale" skip.

function getAuthorShadowPrecision(
  username: string,
  author: string,
): { precision: number; n: number } | null {
  const row = getDb().prepare(`
    SELECT COUNT(*) as n,
           SUM(CASE WHEN resolved_payout_sbd >= 1.0 THEN 1.0 ELSE 0.0 END) as tp_count
    FROM vb_copilot_shadow_runs
    WHERE username = ? AND author = ?
      AND decision = 'would_vote'
      AND outcome_status = 'resolved'
  `).get(username, author) as { n: number; tp_count: number } | undefined;

  if (!row || row.n < 5) return null;
  return { precision: row.tp_count / row.n, n: row.n };
}

// ── Core shadow evaluation ────────────────────────────────────────────────────

async function runShadowEval(username: string, log: typeof console): Promise<void> {
  const runId  = randomUUID();
  const runAt  = new Date().toISOString();

  // 1. Load VP context
  const vpCtx = getVpContext(username);
  if (!vpCtx) {
    log.info(`[CoPilotShadow] ${username}: no VP snapshot — skipping`);
    return;
  }

  // 2. Load strategy
  const rawRules = loadStrategy(username);
  if (!rawRules || rawRules.length === 0) {
    log.info(`[CoPilotShadow] ${username}: no strategy — skipping`);
    return;
  }

  const rules = rawRules as StrategyRule[];
  const activeRules = rules.filter(r => r.enabled && r.category !== "ignorieren");
  if (activeRules.length === 0) return;

  // 3. Build local recently-voted buffer
  const recentlyVoted = getRecentlyVotedKeys(username);

  // 4. Fetch posts for all authors (batched, 5 concurrent)
  const authors  = [...new Set(activeRules.map(r => r.username))];
  const postMap  = new Map<string, PostOpportunity[]>();
  const BATCH    = 5;

  for (let i = 0; i < authors.length; i += BATCH) {
    const batch   = authors.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(a => fetchRecentPostsWithVotes(a, username))
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") {
        // Apply local audit buffer
        const posts = r.value.map(p => {
          const key = `${p.author}/${p.permlink}`;
          if (!p.alreadyVoted && recentlyVoted.has(key)) {
            return { ...p, alreadyVoted: true, eligible: false };
          }
          return p;
        });
        postMap.set(batch[j], posts);
      }
    }
  }

  // 5. Evaluate each rule → build shadow decisions
  const rows: ShadowRow[] = [];
  let remainingBudgetBps  = vpCtx.budgetBps;

  // Sort rules by priority (mirrors buildVotePlan sort)
  const PRIORITY: Record<StrategyCategory, number> = {
    immer_voten: 50, lieblingsautor: 40, bevorzugt: 30, normal: 20, niedrig: 10, ignorieren: 0,
  };
  const sortedRules = [...activeRules].sort(
    (a, b) => PRIORITY[b.category] - PRIORITY[a.category]
  );

  for (const rule of sortedRules) {
    const posts      = postMap.get(rule.username) ?? [];
    const weightBps  = Math.round(rule.maxWeightPct * 100);
    const costBps    = vpCostBps(weightBps);
    const whale      = getWhaleSignal(rule.username);

    const baseSignals = {
      vpBpsAtRun:        vpCtx.vpBps,
      vpBudgetBps:       vpCtx.budgetBps,
      remainingBudgetBps,
      opportunityGate:   OPPORTUNITY_GATE,
      whaleSignal:       whale,
    };

    if (posts.length === 0) {
      rows.push({
        id: randomUUID(), run_id: runId, username, run_at: runAt,
        decision:             "skip_no_posts",
        author:               rule.username,
        permlink:             null, title: null,
        category:             rule.category,
        post_score:           null,
        score_gate:           OPPORTUNITY_GATE,
        suggested_weight_bps: weightBps,
        vp_cost_bps:          costBps,
        expected_vote_usd:    null,
        reasons_json:         null,
        skip_reason:          "No recent posts found for author",
        vp_bps_at_run:        vpCtx.vpBps,
        vp_budget_bps:        vpCtx.budgetBps,
        signals_json:         JSON.stringify({ ...baseSignals, score_version: 'v3' }),
      });
      continue;
    }

    // Check if best post is already voted
    const alreadyVotedPosts = posts.filter(p => p.alreadyVoted);
    const eligible = posts.filter(p => p.eligible && !p.alreadyVoted);

    if (eligible.length === 0 && alreadyVotedPosts.length > 0) {
      const p = alreadyVotedPosts[0];
      rows.push({
        id: randomUUID(), run_id: runId, username, run_at: runAt,
        decision:             "skip_already_voted",
        author:               rule.username,
        permlink:             p.permlink,
        title:                p.title,
        category:             rule.category,
        post_score:           p.postScore,
        score_gate:           OPPORTUNITY_GATE,
        suggested_weight_bps: weightBps,
        vp_cost_bps:          costBps,
        expected_vote_usd:    null,
        reasons_json:         null,
        skip_reason:          "Best post already voted",
        vp_bps_at_run:        vpCtx.vpBps,
        vp_budget_bps:        vpCtx.budgetBps,
        signals_json:         JSON.stringify({ ...baseSignals, ageMinutes: p.ageMinutes, remainingHours: p.remainingHours, score_version: 'v3' }),
      });
      continue;
    }

    if (eligible.length === 0) {
      rows.push({
        id: randomUUID(), run_id: runId, username, run_at: runAt,
        decision:             "skip_no_posts",
        author:               rule.username,
        permlink:             null, title: null,
        category:             rule.category,
        post_score:           null,
        score_gate:           OPPORTUNITY_GATE,
        suggested_weight_bps: weightBps,
        vp_cost_bps:          costBps,
        expected_vote_usd:    null,
        reasons_json:         null,
        skip_reason:          "No eligible posts (all expired or self-posts below min age)",
        vp_bps_at_run:        vpCtx.vpBps,
        vp_budget_bps:        vpCtx.budgetBps,
        signals_json:         JSON.stringify({ ...baseSignals, score_version: 'v3' }),
      });
      continue;
    }

    // Score all eligible posts with composite opportunity score v3, pick best
    const authorAvgSpPerVp  = getAuthorAvgSpPerVp(username, rule.username);
    const shadowPrec        = getAuthorShadowPrecision(username, rule.username);
    const scored = eligible.map(p => ({
      post: p,
      opp:  calcOpportunityScore({
        ageMinutes:            p.ageMinutes,
        remainingHours:        p.remainingHours,
        category:              rule.category,
        pendingPayoutSbd:      p.pendingPayoutSbd,
        whaleCount:            whale?.whaleCount ?? undefined,
        authorAvgSpPerVp,
        authorShadowPrecision: shadowPrec?.precision,
        authorShadowN:         shadowPrec?.n,
        isSelfPost:            p.isSelfPost,
      }),
    })).sort((a, b) => b.opp.finalScore - a.opp.finalScore);

    const best    = scored[0].post;
    const oppResult = scored[0].opp;

    // ── Shadow model v4 (research) — scored independently on the SAME candidate set.
    // v3 logs its best post; v4 scores THAT post for a true per-candidate side-by-side,
    // and also ranks all eligible itself so divergent picks are visible (analysis only —
    // the resolved outcome on the row belongs to v3's pick). v4 never broadcasts.
    const v4Scored = eligible
      .map(p => ({ p, v4: calcOpportunityScoreV4(buildV4Params(rule.category, p, whale)) }))
      .sort((a, b) => b.v4.pGood - a.v4.pGood);
    const v4OnBest  = v4Scored.find(s => s.p.permlink === best.permlink)!.v4;
    const v4Pick    = v4Scored[0];
    const v4Row     = v4Fields(v4OnBest, {
      permlink: v4Pick.p.permlink,
      score:    v4Pick.v4.score,
      diverges: v4Pick.p.permlink !== best.permlink,
    });

    // Opportunity gate check (composite score, not age-only)
    if (!oppResult.wouldAct) {
      rows.push({
        id: randomUUID(), run_id: runId, username, run_at: runAt,
        decision:             "skip_score",
        ...v4Row,
        author:               rule.username,
        permlink:             best.permlink,
        title:                best.title,
        category:             rule.category,
        post_score:           oppResult.finalScore,
        score_gate:           OPPORTUNITY_GATE,
        suggested_weight_bps: weightBps,
        vp_cost_bps:          costBps,
        expected_vote_usd:    Math.round((weightBps / 10_000) * vpCtx.voteUsd * 10_000) / 10_000,
        reasons_json:         null,
        skip_reason:          oppResult.skipReason ?? `opportunityScore ${oppResult.finalScore} < gate ${OPPORTUNITY_GATE}`,
        vp_bps_at_run:        vpCtx.vpBps,
        vp_budget_bps:        vpCtx.budgetBps,
        signals_json:         JSON.stringify({
          ...baseSignals,
          score_version:         'v3',
          ageMinutes:            best.ageMinutes,
          remainingHours:        best.remainingHours,
          pendingPayoutSbd:      best.pendingPayoutSbd,
          authorAvgSpPerVp,
          opportunityScore:      oppResult.finalScore,
          opportunityScoreRaw:   oppResult.score,
          opportunityComponents: oppResult.components,
          authorShadowPrecision: shadowPrec,
          activeVotesCount:      best.activeVotesCount,
          community:             best.community,
          isSelfPost:            best.isSelfPost,
        }),
      });
      continue;
    }

    // Budget check
    if (costBps > remainingBudgetBps) {
      rows.push({
        id: randomUUID(), run_id: runId, username, run_at: runAt,
        decision:             "skip_budget",
        ...v4Row,
        author:               rule.username,
        permlink:             best.permlink,
        title:                best.title,
        category:             rule.category,
        post_score:           oppResult.finalScore,
        score_gate:           OPPORTUNITY_GATE,
        suggested_weight_bps: weightBps,
        vp_cost_bps:          costBps,
        expected_vote_usd:    Math.round((weightBps / 10_000) * vpCtx.voteUsd * 10_000) / 10_000,
        reasons_json:         null,
        skip_reason:          `VP budget exhausted — need ${costBps} BPS, only ${remainingBudgetBps} BPS remaining`,
        vp_bps_at_run:        vpCtx.vpBps,
        vp_budget_bps:        vpCtx.budgetBps,
        signals_json:         JSON.stringify({
          ...baseSignals,
          score_version:         'v3',
          ageMinutes:            best.ageMinutes,
          remainingHours:        best.remainingHours,
          pendingPayoutSbd:      best.pendingPayoutSbd,
          authorAvgSpPerVp,
          opportunityScore:      oppResult.finalScore,
          opportunityScoreRaw:   oppResult.score,
          opportunityComponents: oppResult.components,
          activeVotesCount:      best.activeVotesCount,
          community:             best.community,
        }),
      });
      continue;
    }

    // ✓ Would vote
    const expectedVoteUsd = Math.round((weightBps / 10_000) * vpCtx.voteUsd * 10_000) / 10_000;
    const reasons: string[] = [];
    if (rule.selectionReasons?.length) reasons.push(...rule.selectionReasons.slice(0, 2));
    reasons.push(`Kategorie: ${rule.category} — opportunityScore ${oppResult.finalScore}`);
    if (oppResult.components.timing >= 8) reasons.push("Optimales Curation-Fenster (10–30 min)");
    if (oppResult.components.signalCurators > 0) reasons.push(`Signal-Kuratoren: +${oppResult.components.signalCurators} Pts`);
    if (oppResult.components.payoutSweetspot >= 20) reasons.push("Payout-Sweetspot: frühzeitig im Pool");
    if (shadowPrec && shadowPrec.precision >= 0.70) reasons.push(`Autor-Qualität nachgewiesen: ${Math.round(shadowPrec.precision * 100)}% (n=${shadowPrec.n})`);
    if (best.community) reasons.push(`Community: ${best.community}`);
    if (best.warning) reasons.push(best.warning);

    remainingBudgetBps -= costBps;

    rows.push({
      id: randomUUID(), run_id: runId, username, run_at: runAt,
      decision:             "would_vote",
      ...v4Row,
      author:               rule.username,
      permlink:             best.permlink,
      title:                best.title,
      category:             rule.category,
      post_score:           oppResult.finalScore,
      score_gate:           OPPORTUNITY_GATE,
      suggested_weight_bps: weightBps,
      vp_cost_bps:          costBps,
      expected_vote_usd:    expectedVoteUsd,
      reasons_json:         JSON.stringify(reasons),
      skip_reason:          null,
      vp_bps_at_run:        vpCtx.vpBps,
      vp_budget_bps:        vpCtx.budgetBps,
      signals_json:         JSON.stringify({
        ...baseSignals,
        score_version:         'v3',
        ageMinutes:            best.ageMinutes,
        remainingHours:        best.remainingHours,
        pendingPayoutSbd:      best.pendingPayoutSbd,
        authorAvgSpPerVp,
        opportunityScore:      oppResult.finalScore,
        opportunityScoreRaw:   oppResult.score,
        opportunityComponents: oppResult.components,
        authorShadowPrecision: shadowPrec,
        activeVotesCount:      best.activeVotesCount,
        community:             best.community,
        isSelfPost:            best.isSelfPost,
        whaleSignal:           whale,
      }),
    });
  }

  // 6. Persist all rows in one transaction
  if (rows.length === 0) return;

  const insert = getDb().prepare(`
    INSERT INTO vb_copilot_shadow_runs (
      id, run_id, username, run_at, decision,
      author, permlink, title, category,
      post_score, score_gate, suggested_weight_bps, vp_cost_bps, expected_vote_usd,
      reasons_json, skip_reason, vp_bps_at_run, vp_budget_bps, signals_json,
      v4_score, v4_decision, v4_components, v4_version,
      author_prior_used, author_history_available
    ) VALUES (
      @id, @run_id, @username, @run_at, @decision,
      @author, @permlink, @title, @category,
      @post_score, @score_gate, @suggested_weight_bps, @vp_cost_bps, @expected_vote_usd,
      @reasons_json, @skip_reason, @vp_bps_at_run, @vp_budget_bps, @signals_json,
      @v4_score, @v4_decision, @v4_components, @v4_version,
      @author_prior_used, @author_history_available
    )
  `);

  // V4_NULL first so rows without a candidate still bind the v4 params (never undefined).
  getDb().transaction(() => { for (const row of rows) insert.run({ ...V4_NULL, ...row }); })();

  const wouldVote = rows.filter(r => r.decision === "would_vote").length;
  const skipped   = rows.length - wouldVote;
  const cm = getPostCacheMetrics();
  log.info(
    `[CoPilotShadow] ${username}: run ${runId.slice(0, 8)} — ` +
    `${wouldVote} would-vote, ${skipped} skipped, VP=${(vpCtx.vpBps / 100).toFixed(1)}% ` +
    `budget=${(vpCtx.budgetBps / 100).toFixed(1)}% | ` +
    `postCache hits=${cm.hits} misses=${cm.misses} hitRate=${cm.hitRatePct}% avgAge=${cm.avgHitAgeMs}ms`
  );
}

// ── Users to evaluate: those with auto_vote consent + strategy ────────────────

function getEligibleUsers(): string[] {
  const db = getDb();
  // Users with granted auto_vote consent
  const rows = db.prepare(`
    SELECT DISTINCT username FROM consents
    WHERE type = 'auto_vote' AND status = 'granted' AND revoked_at IS NULL
  `).all() as Array<{ username: string }>;

  // Filter to those who also have a strategy configured
  return rows
    .map(r => r.username)
    .filter(u => {
      const row = db.prepare("SELECT 1 FROM strategy_rules WHERE username = ?").get(u);
      return Boolean(row);
    });
}

// ── Run stats ─────────────────────────────────────────────────────────────────

export interface ShadowScannerStats {
  lastRunAt:         string | null;
  lastRunDurationMs: number | null;
  lastUserCount:     number | null;
  lastWouldVote:     number | null;
  lastSkipped:       number | null;
  totalRuns:         number;
}

const _shadowStats: ShadowScannerStats = {
  lastRunAt: null, lastRunDurationMs: null, lastUserCount: null,
  lastWouldVote: null, lastSkipped: null, totalRuns: 0,
};

export function getShadowScannerStats(): ShadowScannerStats { return { ..._shadowStats }; }

// ── Job runner ────────────────────────────────────────────────────────────────

const INTERVAL_MS = 30 * 60 * 1_000; // 30 minutes

let _timer: ReturnType<typeof setTimeout> | null = null;
let _started = false;

export async function runCopilotShadow(log: typeof console = console): Promise<void> {
  const runStart = Date.now();
  const users    = getEligibleUsers();
  if (users.length === 0) {
    log.info("[CoPilotShadow] No eligible users (auto_vote consent + strategy required)");
    return;
  }

  log.info(`[CoPilotShadow] Starting shadow run for ${users.length} user(s): ${users.join(", ")}`);

  let totalWouldVote = 0;
  let totalSkipped   = 0;

  for (const username of users) {
    try {
      await runShadowEval(username, log);
      // tally from last vb_copilot_shadow_runs entries for this run
      const db = getDb();
      const recent = db.prepare(`
        SELECT decision FROM vb_copilot_shadow_runs
        WHERE username = ? AND run_at >= datetime('now', '-2 minutes')
      `).all(username) as Array<{ decision: string }>;
      totalWouldVote += recent.filter(r => r.decision === "would_vote").length;
      totalSkipped   += recent.filter(r => r.decision !== "would_vote").length;
    } catch (err) {
      log.warn(`[CoPilotShadow] Error evaluating ${username}:`, err);
    }
  }

  _shadowStats.lastRunAt         = new Date().toISOString();
  _shadowStats.lastRunDurationMs = Date.now() - runStart;
  _shadowStats.lastUserCount     = users.length;
  _shadowStats.lastWouldVote     = totalWouldVote;
  _shadowStats.lastSkipped       = totalSkipped;
  _shadowStats.totalRuns++;
}

export function startCopilotShadow(log: typeof console = console): void {
  if (_started) return;
  _started = true;

  function schedule(): void {
    _timer = setTimeout(async () => {
      try { await runCopilotShadow(log); } catch (err) { log.warn("[CoPilotShadow] run error:", err); }
      schedule();
    }, INTERVAL_MS);
  }

  // First run offset by 5 min so VpSampler has data before we try to read it
  setTimeout(() => {
    runCopilotShadow(log).catch(err => log.warn("[CoPilotShadow] initial run error:", err));
    schedule();
  }, 5 * 60 * 1_000);

  log.info("[CoPilotShadow] Started — shadow runs every 30 min (first in 5 min)");
}

export function stopCopilotShadow(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _started = false;
}
