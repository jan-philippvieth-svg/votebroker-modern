/**
 * Opportunity Score v4 — Research / Shadow Model
 * ==============================================
 *
 * v4 is an INDEPENDENT experimental curation model. It is NOT a re-tuning of v3.
 * It runs ONLY in shadow mode (copilotShadowJob), never broadcasts a vote, and is
 * logged side-by-side with v3 on the same candidate (vb_copilot_shadow_runs:
 * v4_score / v4_decision / v4_components / v4_version).
 *
 * Design goal: estimate the *true quality* of an opportunity — P(this post settles
 * to a worthwhile curation outcome) — while deliberately separating correlation
 * from causation. The four confounds we explicitly defuse:
 *
 *   1. Growth factor distorted by our own timing.
 *      → v4 does NOT use growth factor at all. GF's denominator is pending payout
 *        at our vote time, which is a function of how early WE vote, not of post
 *        quality (see signalCompute.ts caveat). A timing-confounded feature cannot
 *        measure quality, so it is excluded rather than "corrected".
 *
 *   2. Author quality confused with whale effects.
 *      → Author quality is taken from the author's MEDIAN realized payout, which is
 *        robust to a few whale-inflated outliers. Whales enter only as a separate,
 *        SATURATING confirmation term — they raise confidence a little, they do not
 *        define quality. (EDA on 3,262 enriched posts: corr(whaleCount, log payout)
 *        = 0.286 — real but modest; v3's own history notes the effect inverts past ~5.)
 *
 *   3. Pool size confused with post quality.
 *      → Pending payout (pool size) gets ~zero weight. v3 paid up to 25 pts purely
 *        for a *small* pool ("cheap"); analysis showed that single feature produced
 *        73% of v3's false positives. A small pool usually just means a small/new
 *        post, not a good one. v4 leans on author/whale quality instead.
 *
 *   4. VP spend equated with success.
 *      → v4 scores opportunity QUALITY only. It is weight/VP-agnostic; budget and
 *        weight are handled downstream by the planner. A score is never inflated
 *        because a bigger vote would be cast.
 *
 * Output is a probability in [0,1] (`pGood`), surfaced as a 0–100 `score` for easy
 * side-by-side reading against v3. Decisioning is probabilistic with a per-category
 * threshold (soft), not v3's hard point-gates — the only hard skips are mechanical
 * truths (expired payout window) or explicit user intent (category "ignorieren").
 *
 * Weights are PRIORS, seeded from production correlations + the March EDA. They are
 * meant to be re-fit from vb_global_vote_outcomes once enough realized outcomes
 * accrue — see deriveV4Calibration(). On the current data snapshot that table is
 * empty, so v4 runs on priors and says so.
 */

export const V4_VERSION = "v4.1-priors";

export type StrategyCategory =
  | "immer_voten" | "lieblingsautor" | "bevorzugt"
  | "normal"      | "niedrig"        | "ignorieren";

export interface V4Params {
  // Post-level (live, from get_content)
  ageMinutes:            number;
  remainingHours:        number;   // hours left in 7-day payout window
  pendingPayoutSbd?:     number;   // pool size at vote time — intentionally low-weight
  activeVotesCount?:     number;
  isSelfPost?:           boolean;
  category:              StrategyCategory | string;

  // Author signals (vb_signal_author) — quality priors, whale-independent where possible
  authorMedianPayoutSbd?: number;  // robust author quality (preferred over mean)
  authorAvgPayoutSbd?:    number;  // fallback if median missing
  whaleCount?:            number;  // distinct whale curators — confirmation only
  whaleFollowRate?:       number;  // fraction of author posts with ≥1 whale (0–1)
  spPerVpCv?:             number;  // realized-reward consistency (lower = steadier)

  // Community signals (vb_signal_community) — weak prior
  communityAvgPayoutSbd?: number;
}

export interface V4Components {
  authorQuality:    number;  // logit contribution
  whaleConfirm:     number;
  consistency:      number;
  communityYield:   number;
  timingFit:        number;
  reverseAuction:   number;  // ≤0
  freshnessDecay:   number;  // ≤0
  poolNeutral:      number;  // ~0 by design
  bias:             number;
  // raw normalized feature values (0–1 unless noted) for analysis
  features: {
    authorQ:        number;
    whaleC:         number;
    consist:        number;
    commY:          number;
    timing:         number;
    reverse:        number;  // 1 if <5min reverse-auction zone
    freshness:      number;  // 1 = fully fresh, 0 = expiring
    pool:           number;
  };
}

export interface V4Result {
  version:     string;
  pGood:       number;   // [0,1] estimated probability of a worthwhile outcome
  score:       number;   // round(pGood * 100) — for side-by-side display vs v3
  threshold:   number;   // category-specific decision threshold on pGood
  wouldAct:    boolean;
  hardSkip:    string | null;  // non-null = mechanical/intent skip, overrides pGood
  components:  V4Components;
  authorHistoryAvailable: boolean;      // was reconstructable author payout history present?
  authorPriorUsed:        number | null; // unknownAuthorPrior applied (null when real history used)
}

// ── Calibration (PRIORS) ────────────────────────────────────────────────────
// Logit weights. Magnitudes reflect: author quality is the primary driver; whales
// confirm; timing is weak (EDA corr ≈ 0 with curator payout) so it only nudges;
// the reverse-auction <5min penalty is a real mechanism, not a correlation; pool
// size is intentionally inert. bias sets the baseline P at neutral features ≈ 0.5.
export interface V4Calibration {
  bias:            number;
  wAuthorQuality:  number;
  wWhaleConfirm:   number;
  wConsistency:    number;
  wCommunityYield: number;
  wTiming:         number;
  wReverseAuction: number;  // applied to penalty (negative effect)
  wFreshnessDecay: number;  // applied to penalty (negative effect)
  wPoolNeutral:    number;  // ~0 by design
  unknownAuthorPrior: number; // authorQuality feature value for an unknown author [0,1]
}

export const V4_CALIBRATION: V4Calibration = {
  bias:            -0.4,
  wAuthorQuality:   2.8,   // strongest; from median realized payout
  wWhaleConfirm:    1.1,   // modest, saturating (EDA corr 0.286)
  wConsistency:     0.6,   // steadier authors are slightly safer bets
  wCommunityYield:  0.4,   // weak community prior
  wTiming:          0.5,   // small — timing showed ~0 causal lift in EDA
  wReverseAuction: -1.6,   // hard mechanism: <5min curator reward returns to pool
  wFreshnessDecay: -2.0,   // expiring posts can't realize curation
  wPoolNeutral:     0.0,   // pool size deliberately carries no weight
  // Unknown authors were the single biggest *cheap* recall loss in the point-in-time
  // backtest: a strict-neutral 0.5 over-skipped good authors with no reconstructable
  // history (2026-06 backtest: recovering them was the top single lever — raising this
  // toward 0.80 recovered ~144 FNs at precision 0.982, vs only +17 for a threshold shift).
  // Default 0.65 is a moderate setting; the full opportunity universe has more bad
  // unknowns than the pre-filtered backtest set, so we stay below the 0.80 optimum and
  // let live calibration tune it. Runtime-overridable via env V4_UNKNOWN_AUTHOR_PRIOR.
  // See DevLog 2026-06-19.
  unknownAuthorPrior: resolveUnknownAuthorPrior(),
};

/** Default unknown-author prior, overridable at runtime via V4_UNKNOWN_AUTHOR_PRIOR (clamped [0,1]). */
export function resolveUnknownAuthorPrior(): number {
  const raw = process.env.V4_UNKNOWN_AUTHOR_PRIOR;
  if (raw == null || raw === "") return 0.65;
  const v = Number(raw);
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0.65; // inline clamp (clamp01 not yet initialised here)
}

// Decision thresholds on pGood by category. Higher-trust categories vote on lower
// confidence (user already vouched for the author); "niedrig" demands strong signal.
const CATEGORY_THRESHOLD: Record<string, number> = {
  immer_voten:   0.35,
  lieblingsautor: 0.40,
  bevorzugt:     0.45,
  normal:        0.50,
  niedrig:       0.62,
  ignorieren:    1.01,   // never acts
};

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Reference scales for normalization (SBD). ~5 SBD ≈ enriched-sample mean payout.
const AUTHOR_PAYOUT_REF = 5;
const COMMUNITY_PAYOUT_REF = 5;

/**
 * Bell-shaped timing fit, peak 15–20 min, in [0,1]. Kept gentle on purpose: the
 * March EDA found corr(whaleDelay, log curatorPayout) ≈ 0.06, i.e. timing barely
 * moves realized reward once author/whale quality is accounted for. The sharp,
 * causal part of timing (the <5 min reverse-auction loss) is modelled separately.
 */
function timingFit(ageMinutes: number, isSelfPost: boolean): number {
  if (isSelfPost) return 0.5;          // visibility vote — timing largely irrelevant
  const a = ageMinutes;
  if (a < 5)   return 0.2;
  if (a < 10)  return 0.6;
  if (a < 20)  return 1.0;             // peak
  if (a < 40)  return 0.7;
  if (a < 90)  return 0.4;
  if (a < 240) return 0.2;
  return 0.1;
}

/** Author quality from realized payout — median preferred (whale-robust). */
function authorQualityFeature(p: V4Params, cal: V4Calibration): number {
  const median = p.authorMedianPayoutSbd;
  const mean   = p.authorAvgPayoutSbd;
  // Prefer median; fall back to a discounted mean (mean is whale-inflated, hence ×0.7).
  const basis = median != null ? median : mean != null ? mean * 0.7 : null;
  if (basis == null) return cal.unknownAuthorPrior; // unknown author → tunable prior, not a penalty
  return clamp01(Math.log1p(Math.max(0, basis)) / Math.log1p(AUTHOR_PAYOUT_REF));
}

/** Whale CONFIRMATION — saturating, capped at 5 (effect inverts beyond per v3 history). */
function whaleConfirmFeature(p: V4Params): number {
  const count = Math.min(p.whaleCount ?? 0, 5) / 5;          // 0..1, saturates at 5
  const follow = p.whaleFollowRate != null ? clamp01(p.whaleFollowRate) : 0.5;
  // Geometric blend: needs BOTH some whales AND a real follow propensity to count.
  return Math.sqrt(count * follow);
}

/** Consistency from realized-reward CV: lower CV → steadier → safer. */
function consistencyFeature(p: V4Params): number {
  if (p.spPerVpCv == null) return 0.5;                       // unknown → neutral
  return clamp01(1 / (1 + p.spPerVpCv));                     // cv=0 →1, cv=1 →0.5, cv→∞ →0
}

function communityYieldFeature(p: V4Params): number {
  if (p.communityAvgPayoutSbd == null) return 0.5;
  return clamp01(Math.log1p(Math.max(0, p.communityAvgPayoutSbd)) / Math.log1p(COMMUNITY_PAYOUT_REF));
}

/** Freshness penalty ramp: 0 when comfortably fresh, →1 as the window closes. */
function freshnessPenalty(remainingHours: number): number {
  if (remainingHours >= 24) return 0;
  if (remainingHours <= 0)  return 1;
  return clamp01((24 - remainingHours) / 24);
}

export function calcOpportunityScoreV4(
  params: V4Params,
  cal: V4Calibration = V4_CALIBRATION,
): V4Result {
  const category = String(params.category);
  const threshold = CATEGORY_THRESHOLD[category] ?? 0.5;

  // Hard skips — mechanical truth / explicit user intent. These override pGood.
  let hardSkip: string | null = null;
  if (params.remainingHours <= 0)   hardSkip = "Payout-Fenster abgelaufen";
  else if (category === "ignorieren") hardSkip = "Kategorie ignorieren";

  // Features (normalized)
  const authorHistoryAvailable = params.authorMedianPayoutSbd != null || params.authorAvgPayoutSbd != null;
  const fAuthorQ  = authorQualityFeature(params, cal);
  const fWhaleC   = whaleConfirmFeature(params);
  const fConsist  = consistencyFeature(params);
  const fCommY    = communityYieldFeature(params);
  const fTiming   = timingFit(params.ageMinutes, params.isSelfPost ?? false);
  const fReverse  = !params.isSelfPost && params.ageMinutes < 5 ? 1 : 0;
  const fFresh    = freshnessPenalty(params.remainingHours);
  const fPool     = params.pendingPayoutSbd != null
    ? clamp01(Math.log1p(params.pendingPayoutSbd) / Math.log1p(20)) : 0.5;

  // Logit contributions (centre each [0,1] feature at 0 so bias sets the baseline).
  const cAuthorQ  = cal.wAuthorQuality  * (fAuthorQ - 0.5);
  const cWhaleC   = cal.wWhaleConfirm   * fWhaleC;            // pure positive confirmation
  const cConsist  = cal.wConsistency    * (fConsist - 0.5);
  const cCommY    = cal.wCommunityYield * (fCommY - 0.5);
  const cTiming   = cal.wTiming         * (fTiming - 0.5);
  const cReverse  = cal.wReverseAuction * fReverse;          // ≤0
  const cFresh    = cal.wFreshnessDecay * fFresh;            // ≤0
  const cPool     = cal.wPoolNeutral    * (fPool - 0.5);     // ~0

  const logit = cal.bias + cAuthorQ + cWhaleC + cConsist + cCommY
              + cTiming + cReverse + cFresh + cPool;
  const pGood = sigmoid(logit);

  const wouldAct = hardSkip == null && pGood >= threshold;

  return {
    version:   V4_VERSION,
    pGood:     Math.round(pGood * 10000) / 10000,
    score:     Math.round(pGood * 100),
    threshold,
    wouldAct,
    hardSkip,
    authorHistoryAvailable,
    authorPriorUsed: authorHistoryAvailable ? null : cal.unknownAuthorPrior,
    components: {
      authorQuality:  round4(cAuthorQ),
      whaleConfirm:   round4(cWhaleC),
      consistency:    round4(cConsist),
      communityYield: round4(cCommY),
      timingFit:      round4(cTiming),
      reverseAuction: round4(cReverse),
      freshnessDecay: round4(cFresh),
      poolNeutral:    round4(cPool),
      bias:           cal.bias,
      features: {
        authorQ: round4(fAuthorQ), whaleC: round4(fWhaleC), consist: round4(fConsist),
        commY: round4(fCommY), timing: round4(fTiming), reverse: fReverse,
        freshness: round4(fFresh), pool: round4(fPool),
      },
    },
  };
}

const round4 = (x: number) => { const r = Math.round(x * 10000) / 10000; return r === 0 ? 0 : r; }; // normalise -0
