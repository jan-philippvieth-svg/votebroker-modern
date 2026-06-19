/**
 * Lightweight in-process rate limiter (fixed window, per-IP).
 *
 * Used as a Fastify `preHandler` on expensive endpoints that fan out to the
 * Steem RPC node (opportunity scan, vote-plan generation, DNA analysis).
 * Without it, a single client could amplify load against this server AND the
 * shared Steem node — whose rate limit, once tripped, blocks real votes too.
 *
 * Keyed by `request.ip`. Behind Caddy this requires `trustProxy: true` on the
 * Fastify instance so `request.ip` reflects X-Forwarded-For, not the proxy.
 *
 * No external dependency (@fastify/rate-limit is not installed). The bucket Map
 * is swept on each call so it cannot grow unbounded.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

interface Bucket {
  count:   number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs:   number;  // window length
  max:        number;  // max requests per window per key
  keyPrefix?: string;  // namespace so multiple limiters don't share buckets
}

export function createRateLimiter(opts: RateLimitOptions) {
  const buckets  = new Map<string, Bucket>();
  let   lastSweep = Date.now();

  function sweep(now: number): void {
    // Drop expired buckets at most once per window — keeps the Map bounded by
    // the number of distinct active IPs, never by total historical requests.
    if (now - lastSweep < opts.windowMs) return;
    lastSweep = now;
    for (const [k, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(k);
    }
  }

  return async function rateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const now = Date.now();
    sweep(now);

    const key = `${opts.keyPrefix ?? ""}${request.ip || "unknown"}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;

    reply.header("x-ratelimit-limit", String(opts.max));
    reply.header("x-ratelimit-remaining", String(Math.max(0, opts.max - bucket.count)));

    if (bucket.count > opts.max) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      reply.header("retry-after", String(retryAfterSec));
      // Returning a reply from a preHandler short-circuits the route handler.
      await reply.code(429).send({
        error: "rate_limited",
        hint:  `Zu viele Anfragen. Bitte in ${retryAfterSec}s erneut versuchen.`,
      });
    }
  };
}
