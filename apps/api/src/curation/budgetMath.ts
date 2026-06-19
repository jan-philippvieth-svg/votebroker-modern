/**
 * Pure VP-budget math — extracted so it is unit-testable in isolation from the
 * Fastify/SQLite plumbing in routes.ts and the shadow job.
 *
 * Steem VP mechanics:
 *   - A 100% vote (10 000 weight BPS) costs 2% of voting power.
 *   - VP regenerates 20 percentage points per day (full recharge in 5 days).
 *
 * Two unit conventions are used across the codebase; both are provided here so
 * call sites stop re-deriving the constant:
 *   - vpCostBps:  VP cost expressed in basis points of VP   (full vote = 200 bps)
 *   - vpCostPct:  VP cost expressed in percentage points     (full vote = 2.0 pp)
 */

export const DAILY_REGEN_PCT = 20;     // percentage points of VP per day
export const FULL_VOTE_VP_PCT = 2;     // a 100% vote costs 2 percentage points of VP

/** VP cost of a vote in basis points of VP (weight 10 000 → 200). */
export function vpCostBps(weightBps: number): number {
  return Math.round(weightBps / 50);
}

/** VP cost of a vote in percentage points of VP (weight 10 000 → 2.0). */
export function vpCostPct(weightBps: number): number {
  return weightBps / 5_000;
}

/**
 * How much VP (in percentage points) can be spent today while keeping
 * tomorrow's VP at or above the target floor, accounting for daily regen.
 * Never negative.
 */
export function dynamicBudgetPct(
  currentVpPct: number,
  targetTomorrowPct: number,
  regenPct: number = DAILY_REGEN_PCT,
): number {
  const vpTomorrow = Math.min(100, currentVpPct + regenPct);
  return Math.max(0, vpTomorrow - targetTomorrowPct);
}
