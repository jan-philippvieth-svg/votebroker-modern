import { getDb } from "../db/index.js";

export interface GrowthSnapshot {
  snapshot_type:      string;
  target_minutes:     number | null;
  pending_payout_sbd: number | null;
  active_votes_count: number | null;
  measured_at:        string;
  actual_delta_min:   number | null;
  source:             string;
  collocated:         number;
}

export interface GrowthFeatures {
  voter:            string;
  author:           string;
  permlink:         string;
  // Snapshot values (SBD) — null if that checkpoint hasn't been captured yet
  payout_t0:        number | null;
  payout_t15m:      number | null;
  payout_t1h:       number | null;
  payout_t6h:       number | null;
  payout_t24h:      number | null;
  payout_t72h:      number | null;
  payout_final:     number | null;
  // Derived features — null if required snapshots are missing
  early_momentum:   number | null;  // payout_t1h / payout_t0
  velocity_0_1h:    number | null;  // (payout_t1h - payout_t0) / 60  [SBD/min]
  velocity_6h_24h:  number | null;  // (payout_t24h - payout_t6h) / 1080  [SBD/min]
  acceleration:     number | null;  // velocity_0_1h / velocity_6h_24h ratio
  growth_factor:    number | null;  // payout_final / payout_t0
  trajectory_class: string | null;  // 'early_spike' | 'slow_burn' | 'flat' | 'unknown'
  population:       string;         // 'native_growth_tracking' | 'historical_backfill'
  has_collocated:   boolean;        // true if any timed snapshot was collocated (same job run as another)
  snapshot_count:   number;
}

function div(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  return a / b;
}

function classifyTrajectory(
  t0:    number | null,
  t1h:   number | null,
  tFinal: number | null
): string | null {
  if (tFinal === null || t0 === null || t0 === 0) return null;
  const gf = tFinal / t0;
  if (gf < 1.5) return "flat";
  if (t1h !== null) {
    const em = t1h / t0;
    if (em > 1.8 && gf < 4.0) return "early_spike";
    if (em < 1.3 && gf > 3.0) return "slow_burn";
  }
  return "unknown";
}

// Compute growth features for a single vote from its raw snapshots.
export function getGrowthFeatures(
  voter: string, author: string, permlink: string
): GrowthFeatures | null {
  const db = getDb();
  const rows = db.prepare(`
    SELECT snapshot_type, target_minutes, pending_payout_sbd, active_votes_count,
           measured_at, actual_delta_min, source
    FROM vote_growth_snapshots
    WHERE voter = ? AND author = ? AND permlink = ?
  `).all(voter, author, permlink) as GrowthSnapshot[];

  if (rows.length === 0) return null;

  const byType = new Map<string, number | null>(
    rows.map(r => [r.snapshot_type, r.pending_payout_sbd])
  );

  const t0    = byType.get("vote_time") ?? null;
  const t15m  = byType.get("t15m")      ?? null;
  const t1h   = byType.get("t1h")       ?? null;
  const t6h   = byType.get("t6h")       ?? null;
  const t24h  = byType.get("t24h")      ?? null;
  const t72h  = byType.get("t72h")      ?? null;
  const tFinal = byType.get("final")    ?? null;

  const velocity01h   = t0 !== null && t1h !== null ? (t1h - t0) / 60 : null;
  const velocity6h24h = t6h !== null && t24h !== null ? (t24h - t6h) / (18 * 60) : null;
  const timedRows    = rows.filter(r => r.snapshot_type !== "final");
  const population   = timedRows.length > 0 && timedRows.every(r => r.source === "native")
    ? "native_growth_tracking"
    : "historical_backfill";
  const hasCollocated = timedRows.some(r => r.collocated === 1);

  return {
    voter, author, permlink,
    payout_t0:    t0,
    payout_t15m:  t15m,
    payout_t1h:   t1h,
    payout_t6h:   t6h,
    payout_t24h:  t24h,
    payout_t72h:  t72h,
    payout_final: tFinal,
    early_momentum:   div(t1h, t0),
    velocity_0_1h:    velocity01h,
    velocity_6h_24h:  velocity6h24h,
    acceleration:     div(velocity01h, velocity6h24h),
    growth_factor:    div(tFinal, t0),
    trajectory_class: classifyTrajectory(t0, t1h, tFinal),
    population,
    has_collocated:   hasCollocated,
    snapshot_count:   rows.length,
  };
}

// Return all votes with at least one snapshot, ordered by most recent vote.
// Use vw_growth_features for full SQL-level feature access.
export function listGrowthFeaturesForVoter(
  voter: string,
  limit = 100
): GrowthFeatures[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT voter, author, permlink
    FROM vote_growth_snapshots
    WHERE voter = ?
    GROUP BY voter, author, permlink
    ORDER BY MAX(measured_at) DESC
    LIMIT ?
  `).all(voter, limit) as Array<{ voter: string; author: string; permlink: string }>;

  return rows
    .map(r => getGrowthFeatures(r.voter, r.author, r.permlink))
    .filter((f): f is GrowthFeatures => f !== null);
}
