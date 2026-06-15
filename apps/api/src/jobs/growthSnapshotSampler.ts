import { getDb } from "../db/index.js";
import { createSteemClient } from "../chain/steemBroadcaster.js";

const INTERVAL_MS = 30 * 60 * 1_000;
const BATCH_SIZE  = 25;

interface SnapshotDef {
  type:            string;
  targetMinutes:   number;
  maxDelayMinutes: number;  // snapshot is skipped if voted_at + maxDelayMinutes has passed
}

// Capture window per type: [targetMinutes, maxDelayMinutes] after voted_at.
// If the job missed the window (e.g. downtime), the snapshot is silently skipped —
// stale chain data labeled as T+0 would be worse than no data.
const TIMED_SNAPSHOTS: SnapshotDef[] = [
  { type: "vote_time", targetMinutes: 0,    maxDelayMinutes: 60    },
  { type: "t5m",       targetMinutes: 5,    maxDelayMinutes: 60    },
  { type: "t10m",      targetMinutes: 10,   maxDelayMinutes: 90    },
  { type: "t15m",      targetMinutes: 15,   maxDelayMinutes: 240   },
  { type: "t1h",       targetMinutes: 60,   maxDelayMinutes: 360   },
  { type: "t6h",       targetMinutes: 360,  maxDelayMinutes: 720   },
  { type: "t24h",      targetMinutes: 1440, maxDelayMinutes: 2160  },
  { type: "t72h",      targetMinutes: 4320, maxDelayMinutes: 7200  },
];

function parseSbd(value: string | null | undefined): number {
  if (!value) return 0;
  return parseFloat(String(value).split(" ")[0]) || 0;
}

function toUtcMs(iso: string): number {
  return new Date(iso.endsWith("Z") ? iso : iso + "Z").getTime();
}

interface ActiveVoteRaw {
  voter:   string;
  rshares: string | number;
  time?:   string;
}

function processActiveVotes(
  activeVotes: unknown[],
  whaleSet: Set<string>,
  postCreatedMs: number,
  nowMs: number,
): {
  whaleCount:           number;
  topVoterAccount:      string | null;
  topVoterRshares:      number | null;
  totalRsharesSum:      number | null;
  medianRshares:        number | null;
  firstWhaleDelayMin:   number | null;
  timeSinceLastVoteMin: number | null;
} {
  let whaleCount        = 0;
  let topVoterAccount:  string | null = null;
  let topVoterRshares:  number | null = null;
  let totalRsharesSum   = 0;
  let firstWhaleTimeMs: number | null = null;
  let lastVoteTimeMs:   number | null = null;
  const allRshares:     number[]      = [];

  for (const v of activeVotes as ActiveVoteRaw[]) {
    if (!v?.voter) continue;

    const voteTimeMs = v.time ? toUtcMs(v.time) : null;
    const rshares    = typeof v.rshares === "string" ? parseFloat(v.rshares) : (v.rshares ?? 0);

    totalRsharesSum += rshares;
    allRshares.push(rshares);

    if (whaleSet.has(v.voter)) {
      whaleCount++;
      if (voteTimeMs !== null && (firstWhaleTimeMs === null || voteTimeMs < firstWhaleTimeMs)) {
        firstWhaleTimeMs = voteTimeMs;
      }
    }

    if (voteTimeMs !== null && (lastVoteTimeMs === null || voteTimeMs > lastVoteTimeMs)) {
      lastVoteTimeMs = voteTimeMs;
    }

    if (rshares > (topVoterRshares ?? -Infinity)) {
      topVoterRshares = rshares;
      topVoterAccount = v.voter;
    }
  }

  let medianRshares: number | null = null;
  if (allRshares.length > 0) {
    allRshares.sort((a, b) => a - b);
    const mid = Math.floor(allRshares.length / 2);
    medianRshares = allRshares.length % 2 === 0
      ? (allRshares[mid - 1] + allRshares[mid]) / 2
      : allRshares[mid];
  }

  const firstWhaleDelayMin   = firstWhaleTimeMs !== null
    ? (firstWhaleTimeMs - postCreatedMs) / 60_000
    : null;
  const timeSinceLastVoteMin = lastVoteTimeMs !== null
    ? (nowMs - lastVoteTimeMs) / 60_000
    : null;

  return {
    whaleCount, topVoterAccount, topVoterRshares,
    totalRsharesSum: allRshares.length > 0 ? totalRsharesSum : null,
    medianRshares,
    firstWhaleDelayMin, timeSinceLastVoteMin,
  };
}

let _timer: ReturnType<typeof setTimeout> | null = null;
let _started = false;

export async function runGrowthSnapshotSampler(log: typeof console = console): Promise<void> {
  const db  = getDb();
  const now = Date.now();

  // Load known whale accounts once per run for whale signal enrichment.
  const whaleSet = new Set(
    (db.prepare("SELECT DISTINCT whale FROM vb_whale_author_signals").all() as Array<{ whale: string }>)
      .map(r => r.whale),
  );

  // Collect all due timed snapshots, grouped by (voter, author, permlink) to minimise chain calls.
  const dueMap = new Map<string, {
    voter: string; author: string; permlink: string; voted_at: string; types: string[];
  }>();

  for (const snap of TIMED_SNAPSHOTS) {
    const rows = db.prepare(`
      SELECT o.voter, o.author, o.permlink, o.voted_at
      FROM vb_global_vote_outcomes o
      WHERE datetime(o.voted_at, '+' || ? || ' minutes') <= datetime('now')
        AND datetime(o.voted_at, '+' || ? || ' minutes') >  datetime('now')
        AND NOT EXISTS (
          SELECT 1 FROM vote_growth_snapshots vgs
          WHERE vgs.voter    = o.voter
            AND vgs.author   = o.author
            AND vgs.permlink = o.permlink
            AND vgs.snapshot_type = ?
        )
      LIMIT ?
    `).all(snap.targetMinutes, snap.maxDelayMinutes, snap.type, BATCH_SIZE) as Array<{
      voter: string; author: string; permlink: string; voted_at: string;
    }>;

    for (const row of rows) {
      const key = `${row.voter}||${row.author}||${row.permlink}`;
      if (!dueMap.has(key)) dueMap.set(key, { ...row, types: [] });
      dueMap.get(key)!.types.push(snap.type);
    }
  }

  // Fetch get_content for each unique post and insert all due snapshots in one transaction.
  const client = createSteemClient();

  const prevWhaleStmt = db.prepare(`
    SELECT whale_count FROM vote_growth_snapshots
    WHERE voter=? AND author=? AND permlink=? AND whale_count IS NOT NULL
    ORDER BY measured_at DESC LIMIT 1
  `);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO vote_growth_snapshots
      (voter, author, permlink, snapshot_type, target_minutes, pending_payout_sbd,
       active_votes_count, measured_at, actual_delta_min, source, collocated,
       whale_count, new_whale_votes, top_voter_account, top_voter_rshares,
       first_whale_delay_min, time_since_last_vote_min, total_rshares_sum, median_rshares)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let liveFetched = 0;

  for (const [, entry] of dueMap) {
    try {
      const content = await client.database.call("get_content", [entry.author, entry.permlink]) as {
        pending_payout_value?: string;
        active_votes?:         unknown[];
        created?:              string;
      };

      const pendingSbd  = parseSbd(content.pending_payout_value);
      const activeVotes = Array.isArray(content.active_votes) ? content.active_votes : [];
      const voteCount   = activeVotes.length || null;

      // Post already paid out — pending_payout_value is "0.000 SBD".
      // Don't store zeros as timed snapshots; the 'final' snapshot handles post-payout state.
      if (pendingSbd <= 0) continue;

      const postCreatedMs = content.created ? toUtcMs(content.created) : toUtcMs(entry.voted_at);
      const { whaleCount, topVoterAccount, topVoterRshares, totalRsharesSum, medianRshares, firstWhaleDelayMin, timeSinceLastVoteMin } =
        processActiveVotes(activeVotes, whaleSet, postCreatedMs, now);

      // Delta vs most recent prior snapshot to reveal whale arrival timing.
      const prevRow = prevWhaleStmt.get(entry.voter, entry.author, entry.permlink) as
        { whale_count: number } | undefined;
      const newWhaleVotes = prevRow != null ? Math.max(0, whaleCount - prevRow.whale_count) : null;

      const votedMs = toUtcMs(entry.voted_at);

      db.transaction(() => {
        const actualDelta = (now - votedMs) / 60_000;
        const collocated  = entry.types.length > 1 ? 1 : 0;
        for (const snapType of entry.types) {
          const def    = TIMED_SNAPSHOTS.find(s => s.type === snapType)!;
          const source = actualDelta <= def.targetMinutes + 45 ? "native" : "historical_backfill";
          insertStmt.run(
            entry.voter, entry.author, entry.permlink,
            snapType, def.targetMinutes,
            pendingSbd, voteCount,
            actualDelta, source, collocated,
            whaleCount, newWhaleVotes, topVoterAccount, topVoterRshares,
            firstWhaleDelayMin, timeSinceLastVoteMin, totalRsharesSum, medianRshares,
          );
        }
      })();

      liveFetched++;
    } catch (err) {
      log.warn(`[GrowthSnapshot] get_content failed for ${entry.author}/${entry.permlink}:`, err);
    }

    // Gentle rate-limit between Steem API calls
    await new Promise(r => setTimeout(r, 120));
  }

  // Final snapshots — use post_final_payout_sbd already in vb_global_vote_outcomes.
  // No chain call required; payoutSync keeps this column up to date.
  // active_votes is empty after payout, so whale fields are stored as NULL.
  const finalDue = db.prepare(`
    SELECT o.voter, o.author, o.permlink, o.voted_at, o.realized_at,
           o.post_final_payout_sbd, o.post_active_votes_count
    FROM vb_global_vote_outcomes o
    WHERE o.realized_at IS NOT NULL
      AND o.post_final_payout_sbd IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM vote_growth_snapshots vgs
        WHERE vgs.voter    = o.voter
          AND vgs.author   = o.author
          AND vgs.permlink = o.permlink
          AND vgs.snapshot_type = 'final'
      )
    LIMIT ?
  `).all(BATCH_SIZE) as Array<{
    voter: string; author: string; permlink: string; voted_at: string;
    realized_at: string; post_final_payout_sbd: number; post_active_votes_count: number | null;
  }>;

  db.transaction(() => {
    for (const row of finalDue) {
      const votedMs    = toUtcMs(row.voted_at);
      const realizedMs = toUtcMs(row.realized_at);
      insertStmt.run(
        row.voter, row.author, row.permlink,
        "final", null,
        row.post_final_payout_sbd, row.post_active_votes_count,
        (realizedMs - votedMs) / 60_000,
        "native", 0,  // final: always accurate, never collocated with timed checkpoints
        null, null, null, null,
        null, null, null, null,
      );
    }
  })();

  const total = liveFetched + finalDue.length;
  if (total > 0) {
    log.info(`[GrowthSnapshot] Captured ${liveFetched} live + ${finalDue.length} final snapshots`);
  }
}

export function startGrowthSnapshotSampler(log: typeof console = console): void {
  if (_started) return;
  _started = true;

  function schedule(): void {
    _timer = setTimeout(async () => {
      try { await runGrowthSnapshotSampler(log); } catch (err) { log.warn("[GrowthSnapshot] error:", err); }
      schedule();
    }, INTERVAL_MS);
  }

  runGrowthSnapshotSampler(log).catch(err => log.warn("[GrowthSnapshot] initial run error:", err));
  schedule();
  log.info("[GrowthSnapshot] Started — sampling every 30 min");
}

export function stopGrowthSnapshotSampler(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _started = false;
}
