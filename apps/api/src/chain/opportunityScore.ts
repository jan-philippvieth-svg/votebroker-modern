/**
 * CoPilot Opportunity Score
 *
 * Replaces the age-only postScore with a composite curation-opportunity signal.
 * Age is one factor — not the deciding one. The question is not "is the post fresh?"
 * but "does voting this post still yield meaningful curation?"
 *
 * Score components (0–100 total):
 *
 *   windowScore   (0–40): How much of the 7-day payout window is left?
 *                         More remaining time = more opportunity. Hard floor at 0h.
 *
 *   timingBonus   (0–20): How close to the optimal curation window is the post?
 *                         Soft bonus — older posts still contribute, just less.
 *
 *   whaleSignal   (0–25): Does this author attract whale votes?
 *                         Whales arriving after you = higher curation share for you.
 *
 *   categoryBonus (0–15): How important is this author in the user's strategy?
 *                         immer_voten always matters; niedrig needs other signals to justify VP.
 *
 * Gate: minimum opportunityScore to act. Uniform across categories — the category
 * influence is already embedded in categoryBonus. Gate is set low (15) because the
 * score itself encodes opportunity quality; we only hard-skip truly hopeless cases
 * (expired post, no signal at all).
 */

export type StrategyCategory =
  | "immer_voten" | "lieblingsautor" | "bevorzugt"
  | "normal"      | "niedrig"        | "ignorieren";

export interface OpportunityParams {
  ageMinutes:      number;
  remainingHours:  number;   // hours left in 7-day payout window
  category:        StrategyCategory | string;
  whaleFollowRate?: number;  // 0–1 (from vb_signal_author.whale_follow_rate)
  isSelfPost?:     boolean;
}

export interface OpportunityResult {
  score:           number;    // 0–100 composite opportunity score
  gate:            number;    // minimum score to act (currently flat at 15)
  wouldAct:        boolean;   // score >= gate AND remainingHours > 0
  components: {
    windowScore:   number;   // 0–40
    timingBonus:   number;   // 0–20
    whaleSignal:   number;   // 0–25
    categoryBonus: number;   // 0–15
  };
  skipReason?: string;       // set when wouldAct = false
}

// ── Component: payout window remaining ───────────────────────────────────────
// How much of the 7-day window is left? More window = more chance of curation.
// This is the most important component: a post with 0h left has ZERO opportunity.

function windowScore(remainingHours: number): number {
  if (remainingHours <= 0)  return 0;
  if (remainingHours >= 48) return 40;
  if (remainingHours >= 24) return 32;
  if (remainingHours >= 6)  return 20;
  if (remainingHours >= 1)  return 10;
  return 3; // < 1h: technically possible but marginal
}

// ── Component: timing bonus ───────────────────────────────────────────────────
// Early votes get a larger share of the curation pool. But this is a BONUS,
// not a gate — a 3-day-old post still gets 4 points, not 0.

function timingBonus(ageMinutes: number, isSelfPost = false): number {
  if (isSelfPost) return 10; // self-posts: timing is for visibility, not curation
  if (ageMinutes <= 15)   return 20; // optimal curation window
  if (ageMinutes <= 30)   return 18;
  if (ageMinutes <= 60)   return 14;
  if (ageMinutes <= 360)  return 10; // 6h: still good
  if (ageMinutes <= 1440) return 7;  // 24h: decent
  if (ageMinutes <= 4320) return 4;  // 3d: late but not worthless
  return 2;                           // 3d+: minimal timing value
}

// ── Component: whale signal ───────────────────────────────────────────────────
// If whales regularly vote this author, voting before them yields higher curation.
// whale_follow_rate = fraction of recent posts with ≥1 whale vote (0–1).

function whaleSignalScore(whaleFollowRate: number | undefined): number {
  if (!whaleFollowRate || whaleFollowRate <= 0) return 0;
  return Math.round(whaleFollowRate * 25);
}

// ── Component: category bonus ─────────────────────────────────────────────────
// Important authors should be voted even with weaker timing/whale signals.
// niedrig authors need other components to justify spending VP.

const CATEGORY_BONUS: Record<string, number> = {
  immer_voten:    15,
  lieblingsautor: 12,
  bevorzugt:       9,
  normal:          5,
  niedrig:         3,
  ignorieren:      0,
};

// ── Gate ──────────────────────────────────────────────────────────────────────
// A single low threshold — the score itself encodes opportunity quality.
// The only hard exclusions are: expired window, ignorieren category.
export const OPPORTUNITY_GATE = 15;

// ── Main function ─────────────────────────────────────────────────────────────

export function calcOpportunityScore(p: OpportunityParams): OpportunityResult {
  const components = {
    windowScore:   windowScore(p.remainingHours),
    timingBonus:   timingBonus(p.ageMinutes, p.isSelfPost),
    whaleSignal:   whaleSignalScore(p.whaleFollowRate),
    categoryBonus: CATEGORY_BONUS[p.category] ?? 5,
  };

  const score = Math.min(100,
    components.windowScore +
    components.timingBonus +
    components.whaleSignal +
    components.categoryBonus
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
    skipReason = `Opportunity-Score ${score} < Gate ${OPPORTUNITY_GATE} — zu wenig Curation-Potenzial`;
  }

  return { score, gate: OPPORTUNITY_GATE, wouldAct, components, skipReason };
}
