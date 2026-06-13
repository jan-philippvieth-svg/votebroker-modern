import { getDb } from "../db/index.js";
import { DEFAULT_TIMEZONE } from "../utils/timezone.js";

export interface UserSettings {
  timezone: string;
}

/** Validates that a string is a supported IANA timezone. */
export function isValidTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function getUserSettings(username: string): UserSettings {
  const db = getDb();
  const row = db.prepare(
    "SELECT timezone FROM user_settings WHERE username = ?"
  ).get(username) as { timezone: string } | undefined;
  return { timezone: row?.timezone ?? DEFAULT_TIMEZONE };
}

export function getUserTimezone(username: string): string {
  return getUserSettings(username).timezone;
}

export function saveUserSettings(username: string, settings: Partial<UserSettings>): UserSettings {
  const db = getDb();
  const current = getUserSettings(username);
  const next: UserSettings = {
    timezone: settings.timezone ?? current.timezone,
  };
  db.prepare(`
    INSERT INTO user_settings (username, timezone, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(username) DO UPDATE SET
      timezone   = excluded.timezone,
      updated_at = excluded.updated_at
  `).run(username, next.timezone);
  return next;
}
