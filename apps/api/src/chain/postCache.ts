/**
 * Shared in-memory post cache for get_discussions_by_blog results.
 *
 * Both the Shadow Scan and the Opportunity Scan call fetchRecentPostsWithVotes
 * for the same set of authors. Without a shared cache, each subsystem makes an
 * independent RPC call to api.steemit.com — doubling the rate-limit pressure.
 *
 * Cache stores raw chain data (RawPost[]) before voter-specific mapping, so it
 * is safe to share across multiple voters: alreadyVoted / eligible are computed
 * fresh on each cache hit by the caller.
 *
 * TTL: 90 seconds — short enough that eligibility signals stay fresh, long
 * enough to absorb the 30-min shadow scan + continuous opportunity poll.
 */

const CACHE_TTL_MS = 90_000;

interface CacheEntry<T> {
  data:       T[];
  fetchedAt:  number;  // Date.now() at write time
}

const cache = new Map<string, CacheEntry<unknown>>();

// ── Lifetime counters ─────────────────────────────────────────────────────────

let _hits       = 0;
let _misses     = 0;
let _evictions  = 0;   // TTL-expired entries replaced on next read
let _cumAgeMs   = 0;   // sum of cache-entry ages at hit time (for avg computation)
let _startedAt  = Date.now();

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns cached posts for `author` if the entry exists and is within TTL. */
export function getPostCache<T>(author: string): T[] | null {
  const entry = cache.get(author) as CacheEntry<T> | undefined;
  if (!entry) {
    _misses++;
    return null;
  }
  const age = Date.now() - entry.fetchedAt;
  if (age > CACHE_TTL_MS) {
    _misses++;
    _evictions++;
    cache.delete(author);
    return null;
  }
  _hits++;
  _cumAgeMs += age;
  return entry.data;
}

/** Stores raw posts for `author` with the current timestamp. */
export function setPostCache<T>(author: string, posts: T[]): void {
  cache.set(author, { data: posts as unknown[], fetchedAt: Date.now() });
}

export interface PostCacheMetrics {
  hits:              number;
  misses:            number;
  evictions:         number;
  savedCalls:        number;   // == hits: each hit avoids one RPC call
  hitRatePct:        number;
  avgHitAgeMs:       number;   // how stale cached data was on average at hit time
  entriesInCache:    number;
  uptimeSeconds:     number;
}

export function getPostCacheMetrics(): PostCacheMetrics {
  const total = _hits + _misses;
  return {
    hits:           _hits,
    misses:         _misses,
    evictions:      _evictions,
    savedCalls:     _hits,
    hitRatePct:     total > 0 ? Math.round((_hits / total) * 1000) / 10 : 0,
    avgHitAgeMs:    _hits > 0 ? Math.round(_cumAgeMs / _hits) : 0,
    entriesInCache: cache.size,
    uptimeSeconds:  Math.round((Date.now() - _startedAt) / 1000),
  };
}

/** Resets lifetime counters (e.g. for test isolation). Does not clear entries. */
export function resetPostCacheMetrics(): void {
  _hits = 0; _misses = 0; _evictions = 0; _cumAgeMs = 0;
  _startedAt = Date.now();
}
