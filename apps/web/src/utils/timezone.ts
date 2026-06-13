export const DEFAULT_TIMEZONE = "Europe/Berlin";

/** Returns "YYYY-MM-DD" for `date` in `tz`. */
export function localDateString(date: Date = new Date(), tz: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(date);
}

/** Returns "YYYY-MM-DD" for today in `tz`. */
export function todayString(tz: string = DEFAULT_TIMEZONE): string {
  return localDateString(new Date(), tz);
}

/**
 * Returns the UTC instant that is 00:00:00.000 of `date`'s calendar day in `tz`.
 * Handles DST correctly via the IANA timezone database built into Intl.
 */
export function startOfLocalDay(date: Date = new Date(), tz: string = DEFAULT_TIMEZONE): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric", minute: "numeric", second: "numeric",
    hour12: false,
  }).formatToParts(date);
  const h = parseInt(parts.find(p => p.type === "hour")?.value   ?? "0") % 24;
  const m = parseInt(parts.find(p => p.type === "minute")?.value ?? "0");
  const s = parseInt(parts.find(p => p.type === "second")?.value ?? "0");
  const elapsed = ((h * 60 + m) * 60 + s) * 1000 + date.getMilliseconds();
  return new Date(date.getTime() - elapsed);
}

/** Returns "YYYY-MM-DD" for yesterday in `tz`. */
export function yesterdayString(tz: string = DEFAULT_TIMEZONE): string {
  const sol = startOfLocalDay(new Date(), tz);
  return localDateString(new Date(sol.getTime() - 1), tz);
}
