import { getDb } from "../db/index.js";
import { createSteemClient } from "../chain/steemBroadcaster.js";

// Run once per day; jitter by a few seconds to avoid predictable load
const INTERVAL_MS = 24 * 60 * 60 * 1_000;

let _timer: ReturnType<typeof setTimeout> | null = null;
let _started = false;

interface PriceResult {
  steem_usd: number;
  sbd_usd:   number;
  source:    "coingecko" | "steem_feed";
}

async function fetchCoingecko(): Promise<PriceResult> {
  const url = "https://api.coingecko.com/api/v3/simple/price?ids=steem,steem-dollars&vs_currencies=usd";
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = await res.json() as {
    steem?:          { usd?: number };
    "steem-dollars"?: { usd?: number };
  };
  const steemUsd = data?.steem?.usd;
  const sbdUsd   = data?.["steem-dollars"]?.usd;
  if (!steemUsd || !sbdUsd) throw new Error("CoinGecko: incomplete price data");
  return { steem_usd: steemUsd, sbd_usd: sbdUsd, source: "coingecko" };
}

async function fetchSteemFeed(): Promise<PriceResult> {
  const client  = createSteemClient();
  const feed    = await client.database.call("get_feed_history", []) as {
    price_history: Array<{ base: string; quote: string }>;
  };
  const prices  = (feed.price_history ?? [])
    .map(p => parseFloat(String(p.base).split(" ")[0]) / parseFloat(String(p.quote).split(" ")[0]))
    .filter(v => isFinite(v) && v > 0);
  if (prices.length === 0) throw new Error("Steem feed: no price history");
  prices.sort((a, b) => a - b);
  const steemUsd = prices[Math.floor(prices.length / 2)];
  // SBD is pegged to 1 USD; chain feed doesn't give real market SBD/USD
  return { steem_usd: steemUsd, sbd_usd: 1.0, source: "steem_feed" };
}

export async function runPriceSampler(log: typeof console = console): Promise<void> {
  const db      = getDb();
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Skip if we already have a coingecko entry for today
  const existing = db.prepare(
    "SELECT source FROM vb_price_history WHERE date_str = ?"
  ).get(dateStr) as { source: string } | undefined;
  if (existing?.source === "coingecko") {
    log.info(`[PriceSampler] Already have CoinGecko data for ${dateStr} — skipping`);
    return;
  }

  let result: PriceResult;
  try {
    result = await fetchCoingecko();
    log.info(`[PriceSampler] CoinGecko: STEEM=${result.steem_usd} USD, SBD=${result.sbd_usd} USD`);
  } catch (err) {
    log.warn("[PriceSampler] CoinGecko failed, falling back to Steem feed:", err);
    try {
      result = await fetchSteemFeed();
      log.info(`[PriceSampler] Steem feed: STEEM≈${result.steem_usd} USD (SBD=1.0 assumed)`);
    } catch (err2) {
      log.warn("[PriceSampler] Both sources failed:", err2);
      return;
    }
  }

  db.prepare(`
    INSERT OR REPLACE INTO vb_price_history (date_str, steem_usd, sbd_usd, source, sampled_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(dateStr, result.steem_usd, result.sbd_usd, result.source);

  log.info(`[PriceSampler] Stored price for ${dateStr} (source: ${result.source})`);
}

export function startPriceSampler(log: typeof console = console): void {
  if (_started) return;
  _started = true;

  function schedule(): void {
    // Schedule next run 24h from now
    _timer = setTimeout(async () => {
      try { await runPriceSampler(log); } catch (err) { log.warn("[PriceSampler] error:", err); }
      schedule();
    }, INTERVAL_MS);
  }

  // Run immediately on startup, then daily
  runPriceSampler(log).catch(err => log.warn("[PriceSampler] initial run error:", err));
  schedule();
  log.info("[PriceSampler] Started — sampling once per day");
}

export function stopPriceSampler(): void {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _started = false;
}
