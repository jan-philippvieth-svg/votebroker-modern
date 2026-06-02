/**
 * VoteBroker-attributed Earnings
 * ================================
 * Matches on-chain curation_reward events against VoteBroker's vote history
 * in audit_events to produce earnings that are actually attributable to
 * VoteBroker votes — not all account curation rewards.
 *
 * Attribution: a curation_reward is VoteBroker-attributed if the post's
 * author+permlink was voted by VoteBroker (vote_broadcast_success in audit_events).
 */

import { createSteemClient } from "./steemBroadcaster.js";
import { getDb } from "../db/index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DailyEarnings {
  date:          string;   // YYYY-MM-DD
  realizedSp:    number;   // matched curation_reward ops
  votes:         number;   // VoteBroker votes that day
  cumRealizedSp: number;   // running total
}

export interface VBEarningsResult {
  period:            string;
  attributionStart:  string | null;   // first VB vote date
  dailyData:         DailyEarnings[];
  totals: {
    realizedSp:      number;
    voteCount:       number;          // VB votes in period
    realizedCount:   number;          // matched curation_reward ops
  };
  notice:            string | null;
  computedAt:        string;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map<string, { result: VBEarningsResult; expiresAt: number }>();

function parseAmount(v: unknown): number {
  return parseFloat(String(v).split(" ")[0]) || 0;
}

// ── Core ──────────────────────────────────────────────────────────────────────

export async function fetchVBEarnings(
  username: string,
  period: "7d" | "30d" | "90d" | "all",
): Promise<VBEarningsResult> {
  const cacheKey = `${username}:${period}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.result;

  const db     = getDb();
  const client = createSteemClient();
  const nowMs  = Date.now();

  // ── 1. Build VoteBroker vote set from audit_events ─────────────────────────
  //    Use vote_broadcast_success as ground truth — these are confirmed on-chain.
  //    Fall back to vote_broadcast_attempt if no successes exist yet.
  const successRows = db.prepare(`
    SELECT author, permlink, weight_bps, created_at
    FROM audit_events
    WHERE username = ? AND type = 'vote_broadcast_success' AND author IS NOT NULL
    ORDER BY created_at ASC
  `).all(username) as Array<{ author: string; permlink: string; weight_bps: number; created_at: string }>;

  const useAttempts = successRows.length === 0;
  const vbVoteRows = useAttempts
    ? db.prepare(`
        SELECT author, permlink, weight_bps, created_at
        FROM audit_events
        WHERE username = ? AND type = 'vote_broadcast_attempt' AND author IS NOT NULL
        ORDER BY created_at ASC
      `).all(username) as typeof successRows
    : successRows;

  // Set of "author/permlink" keys voted by VoteBroker
  const vbVoteSet = new Map<string, { date: string; weightBps: number }>();
  for (const r of vbVoteRows) {
    vbVoteSet.set(`${r.author}/${r.permlink}`, {
      date:      r.created_at.slice(0, 10),
      weightBps: r.weight_bps,
    });
  }

  const attributionStart = vbVoteRows.length > 0 ? vbVoteRows[0].created_at.slice(0, 10) : null;

  // Period cutoff
  const days: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };
  const cutoffMs = period === "all" ? 0 : nowMs - (days[period] ?? 30) * 24 * 3600 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  // ── 2. Read curation_reward history from chain ─────────────────────────────
  type HistoryEntry = [number, { timestamp: string; op: [string, Record<string, unknown>] }];

  const rewardsByPost = new Map<string, { rewarded_vests: number; date: string }>();
  let   from       = -1;
  let   reachedEnd = false;
  const PAGE_SIZE  = 100;
  const MAX_PAGES  = period === "all" ? 50 : 30;

  for (let page = 0; page < MAX_PAGES && !reachedEnd; page++) {
    const batch = await client.database.call(
      "get_account_history", [username, from, PAGE_SIZE]
    ) as HistoryEntry[];

    if (!batch || batch.length === 0) break;

    for (const entry of [...batch].reverse()) {
      const ts = new Date(entry[1].timestamp + "Z").getTime();
      if (ts < cutoffMs) { reachedEnd = true; break; }

      const [opType, opData] = entry[1].op;
      if (opType === "curation_reward" && opData["curator"] === username) {
        const postKey = `${opData["comment_author"]}/${opData["comment_permlink"]}`;
        rewardsByPost.set(postKey, {
          rewarded_vests: parseAmount(opData["reward"]),
          date:           entry[1].timestamp.slice(0, 10),
        });
      }
    }

    const oldestSeq = batch[0][0];
    if (oldestSeq <= 0) break;
    from = oldestSeq - 1;
  }

  // ── 3. Get VESTS → SP conversion ──────────────────────────────────────────
  const globalProps    = await client.database.getDynamicGlobalProperties();
  const totalFundSteem = parseAmount(globalProps.total_vesting_fund_steem);
  const totalVests     = parseAmount(globalProps.total_vesting_shares);
  const vestsPerSp     = totalVests > 0 ? totalVests / totalFundSteem : 20_000;

  // ── 4. Match rewards to VoteBroker votes ──────────────────────────────────
  //    Per-day: realizedSp + vote count
  const perDay = new Map<string, { sp: number; votes: number }>();

  for (const [postKey, reward] of rewardsByPost) {
    if (!vbVoteSet.has(postKey)) continue;   // not a VoteBroker vote

    const sp = Math.round((reward.rewarded_vests / vestsPerSp) * 10_000) / 10_000;
    const day = reward.date;
    const existing = perDay.get(day) ?? { sp: 0, votes: 0 };
    perDay.set(day, { sp: existing.sp + sp, votes: existing.votes });
  }

  // Add vote counts per day (from vbVoteSet)
  for (const [, vote] of vbVoteSet) {
    if (vote.date < cutoffIso.slice(0, 10)) continue;
    const existing = perDay.get(vote.date) ?? { sp: 0, votes: 0 };
    perDay.set(vote.date, { sp: existing.sp, votes: existing.votes + 1 });
  }

  // ── 5. Build ordered daily array with cumulative SP ───────────────────────
  const allDates = [...new Set([
    ...Array.from(perDay.keys()),
    // Fill in zero-vote days if period ≤ 30d
    ...(period === "7d" || period === "30d"
      ? Array.from({ length: days[period] }, (_, i) => {
          const d = new Date(nowMs - (days[period] - 1 - i) * 24 * 3600 * 1000);
          return d.toISOString().slice(0, 10);
        })
      : []),
  ])].sort();

  let cum = 0;
  const dailyData: DailyEarnings[] = allDates.map(date => {
    const d = perDay.get(date) ?? { sp: 0, votes: 0 };
    cum += d.sp;
    return { date, realizedSp: d.sp, votes: d.votes, cumRealizedSp: Math.round(cum * 10_000) / 10_000 };
  });

  // ── 6. Totals ─────────────────────────────────────────────────────────────
  const totalRealized = dailyData.reduce((s, d) => s + d.realizedSp, 0);
  const totalVotes    = dailyData.reduce((s, d) => s + d.votes, 0);
  const matchedCount  = [...rewardsByPost.keys()].filter(k => vbVoteSet.has(k)).length;

  // ── 7. Notice ─────────────────────────────────────────────────────────────
  let notice: string | null = null;
  if (useAttempts) {
    notice = "Attribution basiert auf Vote-Versuchen — Broadcast-Bestätigungen noch nicht verfügbar.";
  } else if (!attributionStart) {
    notice = "Noch keine VoteBroker-Votes aufgezeichnet. Attribution ab dem ersten VoteBroker-Run verfügbar.";
  } else if (totalRealized === 0 && totalVotes > 0) {
    notice = `Attribution aktiv seit ${attributionStart}. Noch keine zugeordneten Curation-Rewards in diesem Zeitraum.`;
  }

  const result: VBEarningsResult = {
    period,
    attributionStart,
    dailyData,
    totals: {
      realizedSp:   Math.round(totalRealized * 10_000) / 10_000,
      voteCount:    totalVotes,
      realizedCount: matchedCount,
    },
    notice,
    computedAt: new Date().toISOString(),
  };

  cache.set(cacheKey, { result, expiresAt: nowMs + CACHE_TTL_MS });
  return result;
}
