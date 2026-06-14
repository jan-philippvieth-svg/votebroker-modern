/**
 * CoPilot Opportunity Score v2
 *
 * Empirically derived from vb_global_vote_outcomes correlation analysis (2026-06-14).
 * See ADR-005 for full findings and weight rationale.
 *
 * Score components (0–100 total):
 *
 *   payoutSweetspot  (0–35): Is pending payout low at vote time? (<2 SBD = best)
 *                            Low pending = we're early, minimal pool competition.
 *                            r(pending_payout, sp_per_vp) = −0.27
 *
 *   timing           (0–25): How early is the vote? <2h = significantly better.
 *                            r(log_delay, sp_per_vp) = −0.37
 *                            Also absorbs the window-remaining signal (same metric).
 *
 *   signalCurators   (0–20): How many whale curators vote this author?
 *                            Sweetspot: 1–5. More = more pool competition.
 *                            r(whale_count, sp_per_vp) = −0.32 (inverted!)
 *
 *   discovery        (0–10): Category importance in the user's strategy.
 *
 *   authorHistory    (0–10): Historical avg sp/vp for this author.
 *                            Author-level consistency is the strongest predictor
 *                            but requires ≥3 data points to be reliable.
 *
 * Hard gates (override score):
 *   - remainingHours <= 0: post expired → score 0, don't act
 *   - category "ignorieren": don't act
 *
 * Roadmap (Score → Expected SP/VP):
 *   This score is an intermediate step. The CoPilot's long-term target is not
 *   "this post has 92 points" but "this post has expected 0.14 SP/VP".
 *   With that, vote weight allocation becomes a real optimization problem:
 *   maximize expected total SP from available VP budget.
 *   Prerequisite: ≥10 data points per author (~August/September 2026).
 */

export type StrategyCategory =
  | "immer_voten" | "lieblingsautor" | "bevorzugt"
  | "normal"      | "niedrig"        | "ignorieren";

export interface OpportunityParams {
  ageMinutes:        number;
  remainingHours:    number;    // hours left in 7-day payout window — hard gate at 0
  category:          StrategyCategory | string;
  pendingPayoutSbd?: number;    // pending payout at vote time (from get_content)
  whaleCount?:       number;    // distinct whale curators for this author (vb_signal_author)
  authorAvgSpPerVp?: number;    // historical avg sp_per_vp for this author (vb_global_vote_outcomes)
  isSelfPost?:       boolean;
}

export interface OpportunityResult {
  score:    number;   // 0–100 composite
  gate:     number;   // minimum to act
  wouldAct: boolean;  // score >= gate AND not expired AND not ignorieren
  components: {
    payoutSweetspot: number;  // 0–35
    timing:          number;  // 0–25
    signalCurators:  number;  // 0–20
    discovery:       number;  // 0–10
    authorHistory:   number;  // 0–10
  };
  skipReason?: string;
}

// ── Component: payout sweetspot ───────────────────────────────────────────────
// Low pending payout at vote time = we're early, pool competition minimal.
// r = −0.27 (our correlation analysis). Non-linear: <0.5 SBD is 2× better than >20 SBD.

function payoutSweetspotScore(pendingPayoutSbd: number | undefined): number {
  if (pendingPayoutSbd === undefined || pendingPayoutSbd === null) return 15; // neutral
  if (pendingPayoutSbd <  0.5)  return 35; // best: early mover, no pool competition
  if (pendingPayoutSbd <  2.0)  return 28;
  if (pendingPayoutSbd <  5.0)  return 20;
  if (pendingPayoutSbd < 10.0)  return 13;
  if (pendingPayoutSbd < 20.0)  return 7;
  return 3; // >20 SBD: heavy competition, pool dilution guaranteed
}

// ── Component: timing ─────────────────────────────────────────────────────────
// r(log_delay, sp_per_vp) = −0.37. Early votes get a larger pool share.
// Also absorbs window-remaining signal (they're the same metric: age = 7d - remaining).
// Self-posts: curation timing irrelevant — goal is social visibility.

function timingScore(ageMinutes: number, isSelfPost = false): number {
  if (isSelfPost) return 18; // fixed moderate — visibility vote, not curation timing
  if (ageMinutes <=   15) return 25;
  if (ageMinutes <=   30) return 22;
  if (ageMinutes <=   60) return 19;
  if (ageMinutes <=  120) return 16;  // 2h: still good curation window
  if (ageMinutes <=  360) return 11;  // 6h
  if (ageMinutes <= 1440) return 7;   // 24h: decent
  if (ageMinutes <= 4320) return 4;   // 3d
  return 1;                            // >3d: minimal
}

// ── Component: signal curators ────────────────────────────────────────────────
// Whale curators are a signal — but only if count is low (1–5).
// Too many whales = too many other curators competing = lower individual pool share.
// r(whale_count, sp_per_vp) = −0.32. Inverted: more is NOT better beyond 5.

function signalCuratorsScore(whaleCount: number | undefined): number {
  if (!whaleCount || whaleCount === 0) return 0;
  if (whaleCount === 1)    return 12;
  if (whaleCount <= 3)     return 18;
  if (whaleCount <= 5)     return 20; // sweetspot
  if (whaleCount <= 8)     return 12; // competition penalty starts
  if (whaleCount <= 12)    return 6;
  return 2; // >12 whales: very competitive author
}

// ── Component: discovery / category ──────────────────────────────────────────
// How important is this author in the user's strategy?
// immer_voten / lieblingsautor = always high priority.
// niedrig = lowest priority, needs strong other signals.

const DISCOVERY_BONUS: Record<string, number> = {
  immer_voten:    10,
  lieblingsautor: 9,
  bevorzugt:      7,
  normal:         5,
  niedrig:        2,
  ignorieren:     0,
};

// ── Component: author history ─────────────────────────────────────────────────
// Historical avg sp/vp for this specific author — strongest predictor we have.
// Requires ≥3 votes to be reliable. Defaults to neutral (5) when unknown.
// Reference: @ruthjoe=0.199, @realrobinhood=0.099, @rme=0.046 (from ADR-005)

function authorHistoryScore(avgSpPerVp: number | undefined): number {
  if (avgSpPerVp === undefined || avgSpPerVp === null) return 5; // neutral: no data yet
  if (avgSpPerVp < 0.04) return 0;   // consistently poor
  if (avgSpPerVp < 0.07) return 2;   // below average
  if (avgSpPerVp < 0.10) return 5;   // around dataset average
  if (avgSpPerVp < 0.15) return 7;
  if (avgSpPerVp < 0.20) return 9;
  return 10;                          // top tier (>0.20 sp/vp consistently)
}

// ── Gate ──────────────────────────────────────────────────────────────────────
export const OPPORTUNITY_GATE = 15;

// ── Main function ─────────────────────────────────────────────────────────────

export function calcOpportunityScore(p: OpportunityParams): OpportunityResult {
  const components = {
    payoutSweetspot: payoutSweetspotScore(p.pendingPayoutSbd),
    timing:          timingScore(p.ageMinutes, p.isSelfPost),
    signalCurators:  signalCuratorsScore(p.whaleCount),
    discovery:       DISCOVERY_BONUS[p.category] ?? 5,
    authorHistory:   authorHistoryScore(p.authorAvgSpPerVp),
  };

  const score = Math.min(100,
    components.payoutSweetspot +
    components.timing          +
    components.signalCurators  +
    components.discovery       +
    components.authorHistory
  );

  const expired  = p.remainingHours <= 0;
  const ignored  = p.category === "ignorieren";
  const wouldAct = !expired && !ignored && score >= OPPORTUNITY_GATE;

  let skipReason: string | undefined;
  if (expired) {
    skipReason = "Payout-Fenster abgelaufen";
  } else if (ignored) {
    skipReason = "Kategorie ignorieren";
  } else if (!wouldAct) {
    skipReason = `Opportunity-Score ${score} < Gate ${OPPORTUNITY_GATE}`;
  }

  return { score, gate: OPPORTUNITY_GATE, wouldAct, components, skipReason };
}
