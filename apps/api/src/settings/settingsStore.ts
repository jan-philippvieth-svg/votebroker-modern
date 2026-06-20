import { getDb } from "../db/index.js";
import { DEFAULT_TIMEZONE } from "../utils/timezone.js";

// Curation reward estimation model.
//   "weight"  — share = my_weight / sum_weight. Matches how the chain distributes
//               curation rewards; validated as the lower-error model (DevLog 2026-06-20).
//   "rshares" — share = my_rshares / sum_rshares. Legacy/research option, kept for
//               side-by-side comparison until more outcomes accumulate.
export type CurationModel = "weight" | "rshares";
export const DEFAULT_CURATION_MODEL: CurationModel = "weight";

export interface UserSettings {
  timezone:      string;
  curationModel: CurationModel;
}

/** Validates that a value is a supported curation model. */
export function isValidCurationModel(m: unknown): m is CurationModel {
  return m === "weight" || m === "rshares";
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
    "SELECT timezone, curation_model FROM user_settings WHERE username = ?"
  ).get(username) as { timezone: string; curation_model: string | null } | undefined;
  return {
    timezone:      row?.timezone ?? DEFAULT_TIMEZONE,
    // New users (no row) and rows predating the column default to weight.
    curationModel: isValidCurationModel(row?.curation_model) ? row!.curation_model as CurationModel : DEFAULT_CURATION_MODEL,
  };
}

export function getUserTimezone(username: string): string {
  return getUserSettings(username).timezone;
}

export function getUserCurationModel(username: string): CurationModel {
  return getUserSettings(username).curationModel;
}

export function saveUserSettings(username: string, settings: Partial<UserSettings>): UserSettings {
  const db = getDb();
  const current = getUserSettings(username);
  const next: UserSettings = {
    timezone:      settings.timezone      ?? current.timezone,
    curationModel: settings.curationModel ?? current.curationModel,
  };
  db.prepare(`
    INSERT INTO user_settings (username, timezone, curation_model, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(username) DO UPDATE SET
      timezone       = excluded.timezone,
      curation_model = excluded.curation_model,
      updated_at     = excluded.updated_at
  `).run(username, next.timezone, next.curationModel);
  return next;
}
