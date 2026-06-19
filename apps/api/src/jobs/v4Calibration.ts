/**
 * v4 Calibration Hook
 * ===================
 * Re-fits the Opportunity Score v4 logit weights from REALIZED outcomes in
 * vb_global_vote_outcomes. v4 ships with hand-reasoned priors (see
 * opportunityScoreV4.ts); this turns priors into data once enough outcomes accrue.
 *
 * Deliberately conservative and NON-applying: it returns a *suggested* calibration
 * (or an "insufficient data" result) and logs it. Nothing auto-overwrites the live
 * weights — a human promotes a suggestion by pasting it into V4_CALIBRATION, or a
 * future job wires it in once the suggestions are stable. This keeps a noisy early
 * fit from silently steering the shadow model.
 *
 * Method: each feature's point-biserial correlation with the binary label
 * "post settled to a worthwhile payout" (post_final_payout_sbd >= GOOD_PAYOUT_SBD),
 * scaled into logit space. Correlation signs/magnitudes — not a full MLE — because
 * with early, thin data a regularised correlation map is more robust than an
 * unstable logistic fit, and it stays interpretable for review.
 *
 * On the current data snapshot vb_global_vote_outcomes is EMPTY, so this returns
 * { ok: false, reason: 'insufficient_outcomes' } and v4 keeps running on priors.
 */

import type { V4Calibration } from "../chain/opportunityScoreV4.js";
import { V4_CALIBRATION } from "../chain/opportunityScoreV4.js";

// A vote is "good" if the post it backed settles at/above this payout (SBD).
// Matches the shadow-precision label used elsewhere (≥1 SBD = worthwhile).
const GOOD_PAYOUT_SBD = 1.0;

// Below this many resolved outcomes a fit is noise — keep priors.
export const MIN_CALIBRATION_SAMPLE = 500;

// Maps a feature↔label correlation into a logit weight. Chosen so a strong
// correlation (|r|≈0.3, realistic ceiling for this domain) yields a weight near
// the prior magnitudes (~2–3), keeping suggestions on the same scale as priors.
const CORR_TO_WEIGHT = 9;

export interface CalibrationCorrelations {
  authorQuality: number;
  whaleConfirm:  number;
  timing:        number;
  pool:          number;
}

export type CalibrationResult =
  | { ok: true;  sampleN: number; suggested: V4Calibration; priors: V4Calibration; correlations: CalibrationCorrelations }
  | { ok: false; sampleN: number; reason: "insufficient_outcomes" };

interface DbLike {
  prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
}

/** Pearson correlation; returns 0 for degenerate (zero-variance) inputs. */
function corr(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    sxy += a * b; sx += a * a; sy += b * b;
  }
  if (sx === 0 || sy === 0) return 0;
  return sxy / Math.sqrt(sx * sy);
}

// Same saturating/bell shapes the live scorer uses, so the fit speaks its language.
const whaleSat   = (c: number) => Math.min(c, 5) / 5;
const log1pNorm  = (v: number, ref: number) => Math.log1p(Math.max(0, v)) / Math.log1p(ref);
function timingShape(delayMin: number): number {
  const a = delayMin;
  if (a < 5)   return 0.2;
  if (a < 10)  return 0.6;
  if (a < 20)  return 1.0;
  if (a < 40)  return 0.7;
  if (a < 90)  return 0.4;
  if (a < 240) return 0.2;
  return 0.1;
}

export function deriveV4Calibration(db: DbLike): CalibrationResult {
  // Join realized outcomes with author quality priors. Each row = one resolved vote.
  const rows = db.prepare(`
    SELECT o.post_final_payout_sbd      AS finalPayout,
           o.post_pending_payout_sbd    AS pending,
           o.vote_delay_minutes         AS delay,
           COALESCE(a.median_payout_sbd, a.avg_payout_sbd) AS authorPayout,
           a.whale_count                AS whaleCount
    FROM vb_global_vote_outcomes o
    LEFT JOIN vb_signal_author a ON a.author = o.author
    WHERE o.post_final_payout_sbd IS NOT NULL
  `).all() as Array<{
    finalPayout: number; pending: number | null; delay: number | null;
    authorPayout: number | null; whaleCount: number | null;
  }>;

  if (rows.length < MIN_CALIBRATION_SAMPLE) {
    return { ok: false, sampleN: rows.length, reason: "insufficient_outcomes" };
  }

  const label: number[] = [];
  const fAuthor: number[] = [], fWhale: number[] = [], fTiming: number[] = [], fPool: number[] = [];
  for (const r of rows) {
    label.push(r.finalPayout >= GOOD_PAYOUT_SBD ? 1 : 0);
    fAuthor.push(r.authorPayout != null ? log1pNorm(r.authorPayout, 5) : 0.5);
    fWhale.push(whaleSat(r.whaleCount ?? 0));
    fTiming.push(r.delay != null ? timingShape(r.delay) : 0.5);
    fPool.push(r.pending != null ? log1pNorm(r.pending, 20) : 0.5);
  }

  const correlations: CalibrationCorrelations = {
    authorQuality: round4(corr(fAuthor, label)),
    whaleConfirm:  round4(corr(fWhale,  label)),
    timing:        round4(corr(fTiming, label)),
    pool:          round4(corr(fPool,   label)),
  };

  // Build a suggested calibration from the empirical correlations. Mechanism terms
  // (reverse-auction, freshness) and the deliberate pool-neutrality are NOT re-fit
  // from correlation here — they encode causal/structural choices, not associations.
  const suggested: V4Calibration = {
    ...V4_CALIBRATION,
    wAuthorQuality:  round4(correlations.authorQuality * CORR_TO_WEIGHT),
    wWhaleConfirm:   round4(Math.max(0, correlations.whaleConfirm) * CORR_TO_WEIGHT),
    wTiming:         round4(correlations.timing * CORR_TO_WEIGHT),
  };

  return { ok: true, sampleN: rows.length, suggested, priors: V4_CALIBRATION, correlations };
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;
