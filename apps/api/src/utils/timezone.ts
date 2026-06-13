/**
 * Timezone utilities.
 * All "today" and daily window logic uses this module so that
 * the timezone is configured in one place and can later become a per-user setting.
 *
 * Internal timestamps stay UTC throughout the system.
 * Only day-boundary computation happens here, using the IANA timezone database
 * via Node.js built-in Intl — no third-party library required.
 */

export const DEFAULT_TIMEZONE = "Europe/Berlin";

/**
 * Returns "YYYY-MM-DD" for `date` in the given IANA timezone.
 * Swedish locale produces ISO-format date strings natively.
 */
export function localDateString(date: Date = new Date(), tz: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(date);
}

/**
 * Returns the UTC instant that corresponds to 00:00:00.000 of the current
 * calendar day in `tz`. Handles DST transitions correctly because Intl uses
 * the full IANA timezone database.
 */
export function startOfLocalDay(date: Date = new Date(), tz: string = DEFAULT_TIMEZONE): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric", minute: "numeric", second: "numeric",
    hour12: false,
  }).formatToParts(date);
  const h  = parseInt(parts.find(p => p.type === "hour")?.value   ?? "0") % 24;
  const m  = parseInt(parts.find(p => p.type === "minute")?.value ?? "0");
  const s  = parseInt(parts.find(p => p.type === "second")?.value ?? "0");
  const elapsed = ((h * 60 + m) * 60 + s) * 1000 + date.getMilliseconds();
  return new Date(date.getTime() - elapsed);
}

/** Returns "YYYY-MM-DD" for today in `tz`. */
export function todayString(tz: string = DEFAULT_TIMEZONE): string {
  return localDateString(new Date(), tz);
}

/** Returns "YYYY-MM-DD" for yesterday in `tz`. */
export function yesterdayString(tz: string = DEFAULT_TIMEZONE): string {
  const sol = startOfLocalDay(new Date(), tz);
  return localDateString(new Date(sol.getTime() - 1), tz);
}

/**
 * Returns UTC ISO strings bracketing the current calendar day in `tz`,
 * suitable for SQLite comparisons:
 *   WHERE created_at >= ? AND created_at < ?
 *
 * Example for Europe/Berlin in summer (UTC+2):
 *   startIso = "2026-06-12T22:00:00.000Z"  (Berlin 00:00)
 *   endIso   = "2026-06-13T22:00:00.000Z"  (Berlin 00:00 next day)
 *   dateStr  = "2026-06-13"
 */
export function todayBoundsUtc(tz: string = DEFAULT_TIMEZONE): {
  startIso: string;
  endIso:   string;
  dateStr:  string;
} {
  const start = startOfLocalDay(new Date(), tz);
  const end   = new Date(start.getTime() + 24 * 3600 * 1000);
  return {
    startIso: start.toISOString(),
    endIso:   end.toISOString(),
    dateStr:  localDateString(start, tz),
  };
}

/**
 * Returns the current UTC offset in minutes for `tz`.
 * e.g., Europe/Berlin winter → 60, summer → 120.
 * Used to adjust SQLite DATE() grouping for daily aggregations.
 */
export function utcOffsetMinutes(tz: string = DEFAULT_TIMEZONE, date: Date = new Date()): number {
  const sol = startOfLocalDay(date, tz);
  const h = sol.getUTCHours();
  const m = sol.getUTCMinutes();
  return h >= 12
    ? (24 - h) * 60 - m   // positive offset (e.g., UTC+1 → 60, UTC+2 → 120)
    : -(h * 60 + m);       // zero or negative offset
}
