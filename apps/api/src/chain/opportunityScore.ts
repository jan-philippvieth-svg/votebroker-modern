/**
 * CoPilot Opportunity Score v3
 *
 * Updated 2026-06-17 based on Shadow-Mode FP analysis (TP=1971 FP=1027 FN=40).
 * Root cause: payoutSweetspot (35 pts max) alone cleared the gate without any
 * whale or author confirmation. 73% of FPs were in score 40–49.
 *
 * Score components (max ~77 total):
 *
 *   payoutSweetspot  (0–25): Capped from 35. "Cheap" is necessary but not sufficient.
 *                            r(pending_payout, sp_per_vp) = −0.27
 *
 *   timing           (0–12): Bell-curve, peak at 15–20 min.
 *                            0–5 min = 0 (Steem reverse-auction: curator reward near zero).
 *                            >120 min = 0 (no timing contribution).
 *                            r(log_delay, sp_per_vp) = −0.37
 *
 *   signalCurators   (0–20): Whale curators for this author. Sweetspot 1–5.
 *                            r(whale_count, sp_per_vp) = −0.32 (inverted beyond 5)
 *
 *   discovery        (0–10): Category importance in user's strategy.
 *
 *   authorHistory    (0–10): Historical avg sp/vp. Requires ≥3 data points.
 *
 * Hard gates (checked after score calculation, override wouldAct):
 *   1. remainingHours <= 0: expired → skip
 *   2. category "ignorieren" → skip
 *   3. category "niedrig" AND whaleCount = 0 → skip
 *      Low-priority authors need external whale confirmation. Cheapness alone ≠ curation value.
 *      Note: "age > 60 min + no whale" is a timing-curve concern, not a hard gate —
 *      the bell-curve already gives 0 pts at >120 min, and the gate is evaluated per-run,
 *      not per-post-lifetime. A late post with good author/category still gets voted.
 */

export type StrategyCategory =
  | "immer_voten" | "lieblingsautor" | "bevorzugt"
  | "normal"      | "niedrig"        | "ignorieren";

export interface OpportunityParams {
  ageMinutes:           number;
  remainingHours:       number;    // hours left in 7-day payout window — hard gate at 0
  category:             StrategyCategory | string;
  pendingPayoutSbd?:    number;    // pending payout at vote time (from get_content)
  whaleCount?:          number;    // distinct whale curators for this author (vb_signal_author)
  authorAvgSpPerVp?:    number;    // historical avg sp_per_vp for this author (vb_global_vote_outcomes)
  authorShadowPrecision?: number;  // fraction of resolved shadow votes that were good (0–1)
  authorShadowN?:       number;    // number of resolved shadow votes used for above
  isSelfPost?:          boolean;
}

export interface OpportunityResult {
  score:      number;   // composite before age malus (max ~77 in v3)
  finalScore: number;   // score after age malus (used for gate check)
  gate:       number;   // minimum finalScore to act
  wouldAct:   boolean;  // finalScore >= gate AND no hard gate triggered
  components: {
    payoutSweetspot: number;  // 0–25
    timing:          number;  // 0–12
    signalCurators:  number;  // 0–20
    discovery:       number;  // 0–10
    authorHistory:   number;  // 0–10
    ageMalus:        number;  // 0 or −15 (old post without quality anchor)
  };
  skipReason?: string;
}

// ── Component: payout sweetspot ───────────────────────────────────────────────
// Capped at 25 (was 35) so "cheap post" alone cannot clear the gate.

function payoutSweetspotScore(pendingPayoutSbd: number | undefined): number {
  if (pendingPayoutSbd === undefined || pendingPayoutSbd === null) return 12; // neutral
  if (pendingPayoutSbd <  0.5)  return 25;
  if (pendingPayoutSbd <  2.0)  return 20;
  if (pendingPayoutSbd <  5.0)  return 15;
  if (pendingPayoutSbd < 10.0)  return 10;
  if (pendingPayoutSbd < 20.0)  return 5;
  return 2; // >20 SBD: heavy pool competition
}

// ── Component: timing ─────────────────────────────────────────────────────────
// Bell-curve peaking at 15–20 min. Reflects Steem curation mechanics:
// <5 min = reverse-auction (curator reward returned to pool) → 0 pts.
// >120 min = timing bonus exhausted; hard gate handles late posts separately.

function timingScore(ageMinutes: number, isSelfPost = false): number {
  if (isSelfPost) return 8; // fixed moderate — visibility vote, curation timing irrelevant
  if (ageMinutes <=   5) return 0;   // reverse-auction window: no curation benefit
  if (ageMinutes <=  10) return 4;
  if (ageMinutes <=  15) return 8;
  if (ageMinutes <=  20) return 12;  // peak: optimal curation window
  if (ageMinutes <=  30) return 8;
  if (ageMinutes <=  60) return 4;
  if (ageMinutes <= 120) return 1;
  return 0;                           // >2h: no timing contribution
}

// ── Component: signal curators ────────────────────────────────────────────────
// Unchanged from v2. Sweetspot 1–5 whale curators for this author.

function signalCuratorsScore(whaleCount: number | undefined): number {
  if (!whaleCount || whaleCount === 0) return 0;
  if (whaleCount === 1)    return 12;
  if (whaleCount <= 3)     return 18;
  if (whaleCount <= 5)     return 20; // sweetspot
  if (whaleCount <= 8)     return 12; // competition penalty starts
  if (whaleCount <= 12)    return 6;
  return 2; // >12 whales: high competition
}

// ── Component: discovery / category ──────────────────────────────────────────

const DISCOVERY_BONUS: Record<string, number> = {
  immer_voten:    10,
  lieblingsautor: 9,
  bevorzugt:      7,
  normal:         5,
  niedrig:        2,
  ignorieren:     0,
};

// ── Component: author history ─────────────────────────────────────────────────
// Unchanged from v2. Requires ≥3 data points to be reliable.

function authorHistoryScore(avgSpPerVp: number | undefined): number {
  if (avgSpPerVp === undefined || avgSpPerVp === null) return 5; // neutral: no data yet
  if (avgSpPerVp < 0.04) return 0;
  if (avgSpPerVp < 0.07) return 2;
  if (avgSpPerVp < 0.10) return 5;
  if (avgSpPerVp < 0.15) return 7;
  if (avgSpPerVp < 0.20) return 9;
  return 10; // top tier (>0.20 sp/vp consistently)
}

// ── Gate ──────────────────────────────────────────────────────────────────────
export const OPPORTUNITY_GATE = 15;

// ── Main function ─────────────────────────────────────────────────────────────

export function calcOpportunityScore(p: OpportunityParams): OpportunityResult {
  const rawComponents = {
    payoutSweetspot: payoutSweetspotScore(p.pendingPayoutSbd),
    timing:          timingScore(p.ageMinutes, p.isSelfPost),
    signalCurators:  signalCuratorsScore(p.whaleCount),
    discovery:       DISCOVERY_BONUS[p.category] ?? 5,
    authorHistory:   authorHistoryScore(p.authorAvgSpPerVp),
  };

  const score = Math.min(100,
    rawComponents.payoutSweetspot +
    rawComponents.timing          +
    rawComponents.signalCurators  +
    rawComponents.discovery       +
    rawComponents.authorHistory
  );

  // ── Age malus: old posts without quality anchor get penalized ─────────────
  // Not a hard gate — they can still pass if other signals are strong enough.
  // Quality anchors: any whale curator OR above-average author history OR top-2 category.
  const isOldPost    = p.ageMinutes > 60;
  const hasWhale     = (p.whaleCount ?? 0) >= 1;
  const hasAuthor    = (p.authorAvgSpPerVp ?? 0) >= 0.10;
  const hasTopCat    = p.category === "immer_voten" || p.category === "lieblingsautor";
  const ageMalus     = (isOldPost && !hasWhale && !hasAuthor && !hasTopCat) ? 15 : 0;

  const components = { ...rawComponents, ageMalus: -ageMalus };
  const finalScore  = Math.max(0, score - ageMalus);

  // ── Hard gate evaluation ────────────────────────────────────────────────────

  if (p.remainingHours <= 0) {
    return { score, finalScore, gate: OPPORTUNITY_GATE, wouldAct: false, components,
      skipReason: "Payout-Fenster abgelaufen" };
  }

  if (p.category === "ignorieren") {
    return { score, finalScore, gate: OPPORTUNITY_GATE, wouldAct: false, components,
      skipReason: "Kategorie ignorieren" };
  }

  // Gate 3: niedrig-Kategorie ohne Whale-Signal → kein Vote, außer der Autor
  // hat nachgewiesene Qualität in Shadow-Daten oder starker SP/VP-Historie.
  //
  // Ausnahmen (beide überschreiben das Gate):
  //   a) Shadow-Precision: ≥5 resolved runs mit ≥70% Trefferquote → Autor hat sich bewährt.
  //   b) authorAvgSpPerVp ≥ 0.15 → überdurchschnittliche realisierte Curation-Historie (≥3 Votes).
  //
  // Kalibrierung (2026-06-17): Trennlinie im Shadow-Datensatz ist perfekt —
  // alle TP-Autoren (inspiracion, blaze.apps …) haben 100% Shadow-Precision,
  // alle FP-Autoren (janasilver, kafio …) haben 0%. Kein Überlapp.
  if (p.category === "niedrig" && (p.whaleCount ?? 0) === 0) {
    const hasProvenShadowQuality =
      (p.authorShadowN ?? 0) >= 5 && (p.authorShadowPrecision ?? 0) >= 0.70;
    const hasSpHistory = (p.authorAvgSpPerVp ?? 0) >= 0.15;

    if (!hasProvenShadowQuality && !hasSpHistory) {
      return { score, finalScore, gate: OPPORTUNITY_GATE, wouldAct: false, components,
        skipReason: "Kategorie niedrig: kein Whale-Signal, keine nachgewiesene Autor-Qualität" };
    }
  }

  const wouldAct = finalScore >= OPPORTUNITY_GATE;

  return {
    score,
    finalScore,
    gate: OPPORTUNITY_GATE,
    wouldAct,
    components,
    skipReason: wouldAct ? undefined : `Opportunity-Score ${finalScore} < Gate ${OPPORTUNITY_GATE}`,
  };
}
