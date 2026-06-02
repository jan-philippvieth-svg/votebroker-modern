/**
 * Pending & Historical Curation Rewards
 *
 * No single Steem RPC endpoint returns "pending curation" directly.
 * We derive it from two official condenser_api calls:
 *
 *   get_account_history  →  vote ops (last 7d) + curation_reward ops (last 30d)
 *   get_content          →  pending_payout_value + active_votes per post
 *
 * Formula per post:
 *   user_curation_usd = pending_payout_value_sbd * 0.25 * (user_rshares / sum_rshares)
 *
 * Results are cached per user for 10 minutes.
 */

import { createSteemClient } from "./steemBroadcaster.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingPost {
  author:       string;
  permlink:     string;
  cashoutTime:  string;   // ISO
  estimatedSp:  number;
  estimatedUsd: number;
}

export interface PendingDebugPost {
  author:           string;
  permlink:         string;
  cashoutTime:      string;
  pendingPayoutSbd: number;  // raw pending_payout_value in SBD

  // Primary method: curation weight (what the blockchain uses for reward distribution)
  myWeight:         number;
  sumWeight:        number;
  sharePctWeight:   number;  // myWeight/sumWeight * 100
  estimatedSp:      number;  // main estimate (weight-based)

  // Comparison: rshares (used for post reward size, not curation distribution)
  myRshares:        number;
  sumRshares:       number;
  sharePctRshares:  number;  // myRshares/sumRshares * 100
  estimatedSpRshares: number;
}

export interface PendingCurationResult {
  // 7-day pending window
  pendingUsd:   number;
  pendingSp:    number;
  postCount:    number;
  voteCount:    number;
  nextPayout:   { cashoutTime: string; estimatedSp: number; estimatedUsd: number } | null;
  topPending:   PendingPost[];   // sorted by value desc, max 5

  // 30-day earned (already paid out)
  earned30dSp:  number;
  earned30dUsd: number;
  earned30dCount: number;       // number of curation_reward ops

  sbdPerSteemUsed: number;      // SBD/STEEM price used for SP conversion (NOT USD/STEEM)

  debug: {
    uniqueTotal:    number;     // unique vote targets found in history
    fetched:        number;     // posts actually fetched from chain
    totalPayoutUsd: number;     // sum of pending_payout_value across all counted posts
    skipped: {
      alreadyPaidOut: number;
      payoutZero:     number;
      noVoteFound:    number;
      weightZero:     number;  // weight=0 (early vote fully penalised or neutral vote)
      limitReached:   number;
    };
    top10:   PendingDebugPost[];  // top 10 by estimatedSp, full calculation breakdown
    method:  "weight";            // curation estimation method in use
  };

  computedAt:   string;         // ISO — so UI can show "as of …"
}

// ── In-memory cache ───────────────────────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60 * 1000;   // 10 minutes

interface CacheEntry {
  result:    PendingCurationResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function clearPendingCurationCache(username: string): void {
  cache.delete(username);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseAmount(value: unknown): number {
  return parseFloat(String(value).split(" ")[0]) || 0;
}

type HistoryEntry = [number, { timestamp: string; op: [string, Record<string, unknown>] }];

type PostContent = {
  cashout_time:          string;
  pending_payout_value:  string;
  active_votes:          Array<{ voter: string; rshares: string | number; weight: string | number }>;
};

// ── Main export ───────────────────────────────────────────────────────────────

export async function fetchPendingCuration(
  username:    string,
  sbdPerSteem: number,   // SBD per STEEM from witness median price feed
): Promise<PendingCurationResult> {
  // ── Cache check ────────────────────────────────────────────────────────────
  const cached = cache.get(username);
  if (cached && Date.now() < cached.expiresAt) return cached.result;

  const client  = createSteemClient();
  const nowMs   = Date.now();
  const cutoff7d  = nowMs - 7  * 24 * 3600 * 1000;
  const cutoff30d = nowMs - 30 * 24 * 3600 * 1000;

  // ── 1. Single history traversal covering 30 days ───────────────────────────
  //    Collect: vote ops ≤7d  AND  curation_reward ops ≤30d
  //    Page backwards (200 entries/page, up to 15 pages = 3 000 entries).

  const voteOps: Array<{ author: string; permlink: string }> = [];
  let   earned30dVests = 0;
  let   earned30dCount = 0;

  let from      = -1;
  let reachedEnd = false;

  // api.steemit.com hard limit = 100 per page
  const PAGE_SIZE = 100;

  for (let page = 0; page < 30 && !reachedEnd; page++) {
    const batch = await client.database.call(
      "get_account_history", [username, from, PAGE_SIZE]
    ) as HistoryEntry[];

    if (!batch || batch.length === 0) break;

    for (const entry of [...batch].reverse()) {
      const ts = new Date(entry[1].timestamp + "Z").getTime();
      if (ts < cutoff30d) { reachedEnd = true; break; }

      const [opType, opData] = entry[1].op;

      if (opType === "vote" && opData["voter"] === username && ts >= cutoff7d) {
        voteOps.push({
          author:   String(opData["author"]   ?? ""),
          permlink: String(opData["permlink"] ?? ""),
        });
      }

      if (opType === "curation_reward" && opData["curator"] === username) {
        earned30dVests += parseAmount(opData["reward"]);
        earned30dCount++;
      }
    }

    const oldestSeq = batch[0][0];
    if (oldestSeq <= 0) break;
    from = oldestSeq - 1;
  }

  // ── 2. VESTS → SP for 30d earned ─────────────────────────────────────────
  //    Fetch global props once (needed for VESTS/STEEM ratio).
  const globalProps = await client.database.getDynamicGlobalProperties();
  const totalFundSteem  = parseAmount(globalProps.total_vesting_fund_steem);
  const totalVestShares = parseAmount(globalProps.total_vesting_shares);
  const vestsPerSp = totalVestShares > 0 ? totalVestShares / totalFundSteem : 20_000;

  const earned30dSp  = Math.round((earned30dVests / vestsPerSp) * 1_000) / 1_000;
  const earned30dUsd = Math.round(earned30dSp * sbdPerSteem * 10_000) / 10_000;

  // ── 3. Deduplicate vote ops ────────────────────────────────────────────────
  const seen = new Set<string>();
  const unique = voteOps.filter(v => {
    const k = `${v.author}/${v.permlink}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const skipped = { alreadyPaidOut: 0, payoutZero: 0, noVoteFound: 0, weightZero: 0, limitReached: 0 };

  if (unique.length === 0) {
    const empty: PendingCurationResult = {
      pendingUsd: 0, pendingSp: 0, postCount: 0,
      voteCount: voteOps.length, nextPayout: null, topPending: [],
      earned30dSp, earned30dUsd, earned30dCount,
      sbdPerSteemUsed: sbdPerSteem,
      debug: { uniqueTotal: 0, fetched: 0, totalPayoutUsd: 0, skipped, top10: [], method: "weight" },
      computedAt: new Date().toISOString(),
    };
    cache.set(username, { result: empty, expiresAt: nowMs + CACHE_TTL_MS });
    return empty;
  }

  // ── 4. Fetch all posts with concurrency limit ──────────────────────────────
  //    No hard cap on post count — fetch everything, but max 15 in-flight at once
  //    to avoid flooding the RPC node.
  const CONCURRENCY = 15;

  type IndexedResult = { index: number; result: PromiseSettledResult<PostContent> };
  const allResults: IndexedResult[] = [];

  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(v =>
        client.database.call("get_content", [v.author, v.permlink]) as Promise<PostContent>
      )
    );
    for (let j = 0; j < settled.length; j++) {
      allResults.push({ index: i + j, result: settled[j] });
    }
  }

  // ── 5. Calculate per-post curation share ──────────────────────────────────
  const pendingPosts: PendingPost[] = [];
  const debugPosts:   PendingDebugPost[] = [];
  let totalPayoutUsd = 0;

  for (const { index, result: res } of allResults) {
    if (res.status !== "fulfilled") continue;

    const post = res.value;

    if (new Date(post.cashout_time + "Z").getTime() <= nowMs) {
      skipped.alreadyPaidOut++;
      continue;
    }

    const payout = parseAmount(post.pending_payout_value);
    if (payout <= 0) {
      skipped.payoutZero++;
      continue;
    }

    const votes     = post.active_votes ?? [];
    const myVote    = votes.find(v => v.voter === username);
    if (!myVote) {
      skipped.noVoteFound++;
      continue;
    }

    // ── Primary: curation weight (what the blockchain uses for reward distribution) ──
    const sumWeight = votes.reduce((s, v) => s + Math.max(0, Number(v.weight)), 0);
    const myWeight  = Math.max(0, Number(myVote.weight));
    if (myWeight <= 0 || sumWeight <= 0) {
      skipped.weightZero++;
      continue;
    }

    // ── Comparison: rshares (kept for debug transparency) ──
    const sumRshares = votes.reduce((s, v) => s + Math.max(0, Number(v.rshares)), 0);
    const myRshares  = Math.max(0, Number(myVote.rshares));

    totalPayoutUsd += payout;

    const shareW        = myWeight  / sumWeight;
    const shareR        = sumRshares > 0 ? myRshares / sumRshares : 0;
    const estimatedSp   = Math.round(payout * 0.25 * shareW / sbdPerSteem * 1_000) / 1_000;
    const estimatedSpR  = Math.round(payout * 0.25 * shareR / sbdPerSteem * 1_000) / 1_000;
    const estimatedSbd  = Math.round(payout * 0.25 * shareW * 10_000) / 10_000;

    pendingPosts.push({
      author:      unique[index].author,
      permlink:    unique[index].permlink,
      cashoutTime: post.cashout_time,
      estimatedSp,
      estimatedUsd: estimatedSbd,
    });
    debugPosts.push({
      author:             unique[index].author,
      permlink:           unique[index].permlink,
      cashoutTime:        post.cashout_time,
      pendingPayoutSbd:   Math.round(payout * 10_000) / 10_000,
      myWeight:           Math.round(myWeight),
      sumWeight:          Math.round(sumWeight),
      sharePctWeight:     Math.round(shareW * 10_000) / 100,
      estimatedSp,
      myRshares:          Math.round(myRshares),
      sumRshares:         Math.round(sumRshares),
      sharePctRshares:    Math.round(shareR * 10_000) / 100,
      estimatedSpRshares: estimatedSpR,
    });
  }

  // Sort by estimated value desc
  pendingPosts.sort((a, b) => b.estimatedUsd - a.estimatedUsd);

  const pendingUsd = Math.round(pendingPosts.reduce((s, p) => s + p.estimatedUsd, 0) * 10_000) / 10_000;
  const pendingSp  = Math.round(pendingPosts.reduce((s, p) => s + p.estimatedSp,  0) * 1_000)  / 1_000;

  // Next payout = post with earliest cashout_time that still has value
  const byTime = [...pendingPosts].sort(
    (a, b) => new Date(a.cashoutTime).getTime() - new Date(b.cashoutTime).getTime()
  );
  const nextPayout = byTime.length > 0
    ? { cashoutTime: byTime[0].cashoutTime, estimatedSp: byTime[0].estimatedSp, estimatedUsd: byTime[0].estimatedUsd }
    : null;

  debugPosts.sort((a, b) => b.estimatedSp - a.estimatedSp);

  const result: PendingCurationResult = {
    pendingUsd, pendingSp,
    postCount:   pendingPosts.length,
    voteCount:   voteOps.length,
    nextPayout,
    topPending:  pendingPosts.slice(0, 5),
    earned30dSp, earned30dUsd, earned30dCount,
    sbdPerSteemUsed: sbdPerSteem,
    debug: {
      uniqueTotal:    unique.length,
      fetched:        allResults.length,
      totalPayoutUsd: Math.round(totalPayoutUsd * 10_000) / 10_000,
      skipped,
      top10: debugPosts.slice(0, 10),
      method: "weight",
    },
    computedAt:  new Date().toISOString(),
  };

  cache.set(username, { result, expiresAt: nowMs + CACHE_TTL_MS });
  return result;
}
