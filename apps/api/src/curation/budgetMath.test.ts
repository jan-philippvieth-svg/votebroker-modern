import assert from "node:assert/strict";
import test from "node:test";
import { vpCostBps, vpCostPct, dynamicBudgetPct } from "./budgetMath.js";

test("vpCostBps: a full 100% vote costs 200 bps of VP", () => {
  assert.equal(vpCostBps(10_000), 200);
  assert.equal(vpCostBps(5_000), 100);
  assert.equal(vpCostBps(0), 0);
});

test("vpCostPct: a full 100% vote costs 2 percentage points of VP", () => {
  assert.equal(vpCostPct(10_000), 2);
  assert.equal(vpCostPct(2_500), 0.5);
});

test("vpCostBps and vpCostPct stay consistent (bps = pct × 100)", () => {
  for (const w of [1_000, 3_000, 7_500, 10_000]) {
    assert.equal(vpCostBps(w), Math.round(vpCostPct(w) * 100));
  }
});

test("dynamicBudgetPct: spendable VP keeps tomorrow at the floor", () => {
  // VP 90% + 20 regen → tomorrow caps at 100, floor 80 → 20 spendable today
  assert.equal(dynamicBudgetPct(90, 80), 20);
  // VP 70% + 20 regen → tomorrow 90, floor 80 → 10 spendable today
  assert.equal(dynamicBudgetPct(70, 80), 10);
});

test("dynamicBudgetPct: never negative in recovery mode", () => {
  // VP 50% + 20 regen → tomorrow 70, below floor 80 → clamped to 0
  assert.equal(dynamicBudgetPct(50, 80), 0);
});

test("dynamicBudgetPct: tomorrow's VP is capped at 100%", () => {
  // VP 95% + 20 regen → tomorrow capped at 100 (not 115), floor 80 → 20
  assert.equal(dynamicBudgetPct(95, 80), 20);
});

test("dynamicBudgetPct: custom regen rate is honoured", () => {
  assert.equal(dynamicBudgetPct(80, 80, 10), 10);
});
