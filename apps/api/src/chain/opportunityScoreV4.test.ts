import assert from "node:assert/strict";
import test from "node:test";
import { calcOpportunityScoreV4, V4_VERSION, type V4Params } from "./opportunityScoreV4.js";
import { deriveV4Calibration, MIN_CALIBRATION_SAMPLE } from "../jobs/v4Calibration.js";

// A neutral, healthy baseline candidate: fresh, on-peak timing, average author.
const base: V4Params = {
  ageMinutes:     18,
  remainingHours: 160,
  category:       "normal",
  pendingPayoutSbd: 2,
  authorMedianPayoutSbd: 3,
  whaleCount: 2,
  whaleFollowRate: 0.5,
  spPerVpCv: 0.5,
};

test("score is round(pGood*100) and bounded 0..100", () => {
  const r = calcOpportunityScoreV4(base);
  assert.equal(r.score, Math.round(r.pGood * 100));
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.equal(r.version, V4_VERSION);
});

test("author quality dominates: a strong author scores well above a weak one", () => {
  const strong = calcOpportunityScoreV4({ ...base, authorMedianPayoutSbd: 20 });
  const weak   = calcOpportunityScoreV4({ ...base, authorMedianPayoutSbd: 0.1 });
  assert.ok(strong.pGood > weak.pGood + 0.2, `strong ${strong.pGood} vs weak ${weak.pGood}`);
});

test("pool size (pending payout) is de-confounded: it does NOT move the score", () => {
  // The whole point of v4 vs v3: cheapness alone must not change the verdict.
  const cheap = calcOpportunityScoreV4({ ...base, pendingPayoutSbd: 0.01 });
  const rich  = calcOpportunityScoreV4({ ...base, pendingPayoutSbd: 50 });
  assert.equal(cheap.pGood, rich.pGood);
});

test("whale confirmation saturates: 5 vs 50 whales barely differ (capped)", () => {
  const five  = calcOpportunityScoreV4({ ...base, whaleCount: 5 });
  const fifty = calcOpportunityScoreV4({ ...base, whaleCount: 50 });
  assert.equal(five.pGood, fifty.pGood);
});

test("reverse-auction: a <5min vote scores below an on-peak vote", () => {
  const early = calcOpportunityScoreV4({ ...base, ageMinutes: 2 });
  const peak  = calcOpportunityScoreV4({ ...base, ageMinutes: 18 });
  assert.ok(early.pGood < peak.pGood, `early ${early.pGood} vs peak ${peak.pGood}`);
  assert.equal(early.components.features.reverse, 1);
});

test("self-posts are exempt from the reverse-auction penalty even when very early", () => {
  const r = calcOpportunityScoreV4({ ...base, ageMinutes: 1, isSelfPost: true });
  assert.equal(r.components.features.reverse, 0);
  assert.equal(r.components.reverseAuction, 0);
});

test("expired payout window is a hard skip regardless of pGood", () => {
  const r = calcOpportunityScoreV4({ ...base, authorMedianPayoutSbd: 100, remainingHours: 0 });
  assert.equal(r.hardSkip, "Payout-Fenster abgelaufen");
  assert.equal(r.wouldAct, false);
});

test("category 'ignorieren' never acts", () => {
  const r = calcOpportunityScoreV4({ ...base, authorMedianPayoutSbd: 100, category: "ignorieren" });
  assert.equal(r.wouldAct, false);
  assert.equal(r.hardSkip, "Kategorie ignorieren");
});

test("trusted categories act on lower confidence than 'niedrig'", () => {
  const always = calcOpportunityScoreV4({ ...base, category: "immer_voten" });
  const low    = calcOpportunityScoreV4({ ...base, category: "niedrig" });
  assert.ok(always.threshold < low.threshold);
});

test("unknown author yields a neutral (non-penalising) prior, not a zero", () => {
  const r = calcOpportunityScoreV4({
    ageMinutes: 18, remainingHours: 160, category: "normal",
  });
  assert.equal(r.components.features.authorQ, 0.5);
  assert.ok(r.pGood > 0.1 && r.pGood < 0.9);
});

// ── Calibration hook ──────────────────────────────────────────────────────────

test("deriveV4Calibration returns insufficient_outcomes on a small/empty sample", () => {
  // Fake db: pretends the outcome table has fewer than MIN_CALIBRATION_SAMPLE rows.
  const fakeDb = {
    prepare: () => ({
      get: () => undefined,
      all: () => [] as unknown[],
    }),
  };
  const res = deriveV4Calibration(fakeDb);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.reason, "insufficient_outcomes");
    assert.ok(res.sampleN < MIN_CALIBRATION_SAMPLE);
  }
});

test("deriveV4Calibration fits weights from a sufficient sample, label-correlated", () => {
  // Synthesise rows where high author payout → good outcome (positive correlation).
  const rows = Array.from({ length: 600 }, (_, i) => {
    const good = i % 2 === 0;
    return {
      finalPayout:  good ? 5 : 0.2,
      pending:      1,
      delay:        18,
      authorPayout: good ? 10 : 0.1,
      whaleCount:   good ? 4 : 0,
    };
  });
  const fakeDb = { prepare: () => ({ get: () => undefined, all: () => rows }) };
  const res = deriveV4Calibration(fakeDb);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.sampleN, 600);
    assert.ok(res.correlations.authorQuality > 0, "author quality should correlate with good outcomes");
    assert.ok(res.suggested.wAuthorQuality > 0);
  }
});
