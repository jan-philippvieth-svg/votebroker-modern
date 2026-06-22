/**
 * Model-prediction layer (Refactoring Phase 2)
 * ============================================
 * Long-format predictions: one row per (decision_id, model). New models become
 * INSERTs, never ALTER TABLE. Two families share the table (context_kind):
 *
 *   'decision' — CoPilot shadow verdict. decision_id = vb_copilot_shadow_runs.id;
 *                v3 and v4 share the same decision_id, one row each.
 *   'estimate' — curation-model SP estimate for an ACTUAL vote.
 *                decision_id = 'est:'||voter||'/'||author||'/'||permlink.
 *
 * Strictly additive (ADR-007): the legacy columns (v4_*, post_score in
 * vb_copilot_shadow_runs; estimated_sp_* in vb_global_vote_outcomes) stay the source
 * of truth for existing readers. This table is a parallel write target, backfilled
 * once from those columns with NO chain re-scan, then kept fresh by dual-writes.
 */

import { getDb } from "../db/index.js";

type Db = ReturnType<typeof getDb>;

export interface ModelPredictionRow {
  decisionId: string;
  model: string;
  modelVersion?: string | null;
  contextKind: "decision" | "estimate";
  voter: string;
  author: string;
  permlink: string;
  decisionType?: string | null;
  wouldVote?: number | null;
  predictedSp?: number | null;
  predictedRshares?: number | null;
  score?: number | null;
  confidence?: number | null;
  suggestedWeightBps?: number | null;
  expectedValueSbd?: number | null;
  rawJson?: string | null;
  predictedAt: string;
}

/**
 * Canonical writer. Upsert one model prediction.
 * Merge semantics: mutable verdict/score fields take the newest value; raw_json keeps
 * the latest non-null. predicted_at is preserved from the first write (COALESCE existing).
 */
export function upsertModelPrediction(db: Db, p: ModelPredictionRow): void {
  db.prepare(`
    INSERT INTO vb_model_predictions
      (decision_id, model, model_version, context_kind, voter, author, permlink,
       decision_type, would_vote, predicted_sp, predicted_rshares, score, confidence,
       suggested_weight_bps, expected_value_sbd, raw_json, predicted_at, recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
    ON CONFLICT(decision_id, model) DO UPDATE SET
      model_version        = COALESCE(excluded.model_version, model_version),
      decision_type        = COALESCE(excluded.decision_type, decision_type),
      would_vote           = COALESCE(excluded.would_vote, would_vote),
      predicted_sp         = COALESCE(excluded.predicted_sp, predicted_sp),
      predicted_rshares    = COALESCE(excluded.predicted_rshares, predicted_rshares),
      score                = COALESCE(excluded.score, score),
      confidence           = COALESCE(excluded.confidence, confidence),
      suggested_weight_bps = COALESCE(excluded.suggested_weight_bps, suggested_weight_bps),
      expected_value_sbd   = COALESCE(excluded.expected_value_sbd, expected_value_sbd),
      raw_json             = COALESCE(excluded.raw_json, raw_json),
      predicted_at         = COALESCE(vb_model_predictions.predicted_at, excluded.predicted_at),
      recorded_at          = datetime('now')
  `).run(
    p.decisionId, p.model, p.modelVersion ?? null, p.contextKind,
    p.voter, p.author, p.permlink,
    p.decisionType ?? null, p.wouldVote ?? null,
    p.predictedSp ?? null, p.predictedRshares ?? null,
    p.score ?? null, p.confidence ?? null,
    p.suggestedWeightBps ?? null, p.expectedValueSbd ?? null,
    p.rawJson ?? null, p.predictedAt,
  );
}

/**
 * One-time backfill + idempotent reconcile from the legacy prediction columns.
 * Pure SQL, no blockchain calls. Safe to run at startup and after each enrichment cycle.
 *
 * Sources:
 *   v3        ← vb_copilot_shadow_runs (all candidate-bearing rows — skips included,
 *               needed for recall / false-negative analysis)
 *   v4        ← vb_copilot_shadow_runs WHERE v4_decision IS NOT NULL (shares decision_id)
 *   weight    ← vb_global_vote_outcomes.estimated_sp_weight
 *   rshares   ← vb_global_vote_outcomes.estimated_sp_rshares
 *   steemworld← vb_global_vote_outcomes.steemworld_estimate_sp
 */
export function backfillModelPredictions(db: Db, log: typeof console = console): { rows: number } {
  // ── v3 (decision): every candidate-bearing shadow row, skips included ──────────
  db.prepare(`
    INSERT INTO vb_model_predictions
      (decision_id, model, model_version, context_kind, voter, author, permlink,
       decision_type, would_vote, predicted_sp, predicted_rshares, score, confidence,
       suggested_weight_bps, expected_value_sbd, raw_json, predicted_at, recorded_at)
    SELECT
      id, 'v3', NULL, 'decision', username, author, permlink,
      decision,
      CASE WHEN decision = 'would_vote' THEN 1 ELSE 0 END,
      NULL, NULL, post_score, NULL,
      suggested_weight_bps, expected_vote_usd, signals_json, run_at, datetime('now')
    FROM vb_copilot_shadow_runs
    WHERE author IS NOT NULL AND permlink IS NOT NULL
    ON CONFLICT(decision_id, model) DO UPDATE SET
      decision_type        = excluded.decision_type,
      would_vote           = excluded.would_vote,
      score                = excluded.score,
      suggested_weight_bps = excluded.suggested_weight_bps,
      expected_value_sbd   = excluded.expected_value_sbd,
      raw_json             = COALESCE(excluded.raw_json, vb_model_predictions.raw_json),
      recorded_at          = datetime('now')
  `).run();

  // ── v4 (decision): research model, shares decision_id with v3 ──────────────────
  // suggested_weight_bps / expected_value_sbd intentionally NULL — v4 produces only a
  // score + verdict on the candidate; the weight is v3's suggestion, not v4's.
  db.prepare(`
    INSERT INTO vb_model_predictions
      (decision_id, model, model_version, context_kind, voter, author, permlink,
       decision_type, would_vote, predicted_sp, predicted_rshares, score, confidence,
       suggested_weight_bps, expected_value_sbd, raw_json, predicted_at, recorded_at)
    SELECT
      id, 'v4', v4_version, 'decision', username, author, permlink,
      v4_decision,
      CASE WHEN v4_decision = 'would_vote' THEN 1 ELSE 0 END,
      NULL, NULL, v4_score, NULL,
      NULL, NULL, v4_components, run_at, datetime('now')
    FROM vb_copilot_shadow_runs
    WHERE v4_decision IS NOT NULL AND author IS NOT NULL AND permlink IS NOT NULL
    ON CONFLICT(decision_id, model) DO UPDATE SET
      model_version = excluded.model_version,
      decision_type = excluded.decision_type,
      would_vote    = excluded.would_vote,
      score         = excluded.score,
      raw_json      = COALESCE(excluded.raw_json, vb_model_predictions.raw_json),
      recorded_at   = datetime('now')
  `).run();

  // ── estimate family (weight / rshares / steemworld) ────────────────────────────
  const estimateBackfill = (model: string, col: string) => db.prepare(`
    INSERT INTO vb_model_predictions
      (decision_id, model, model_version, context_kind, voter, author, permlink,
       decision_type, would_vote, predicted_sp, predicted_rshares, score, confidence,
       suggested_weight_bps, expected_value_sbd, raw_json, predicted_at, recorded_at)
    SELECT
      'est:' || voter || '/' || author || '/' || permlink, '${model}', NULL, 'estimate',
      voter, author, permlink,
      NULL, NULL, ${col}, NULL, NULL, NULL,
      NULL, NULL, NULL, COALESCE(estimated_at, recorded_at), datetime('now')
    FROM vb_global_vote_outcomes
    WHERE ${col} IS NOT NULL
    ON CONFLICT(decision_id, model) DO UPDATE SET
      predicted_sp = excluded.predicted_sp,
      predicted_at = COALESCE(vb_model_predictions.predicted_at, excluded.predicted_at),
      recorded_at  = datetime('now')
  `).run();

  estimateBackfill("weight",     "estimated_sp_weight");
  estimateBackfill("rshares",    "estimated_sp_rshares");
  estimateBackfill("steemworld", "steemworld_estimate_sp");

  const rows = (db.prepare("SELECT COUNT(*) AS n FROM vb_model_predictions").get() as { n: number }).n;
  log.info(`[ModelPredictions] backfilled/reconciled — ${rows} prediction rows`);
  return { rows };
}
