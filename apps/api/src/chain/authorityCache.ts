import { getDb } from "../db/index.js";

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

type CacheRow = { has_authority: number; checked_at: string };

export function getCachedAuthority(username: string): boolean | null {
  const row = getDb().prepare(`
    SELECT has_authority, checked_at FROM authority_cache WHERE username = ?
  `).get(username) as CacheRow | undefined;

  if (!row) return null;
  if (Date.now() - Date.parse(row.checked_at + "Z") > CACHE_TTL_MS) return null;
  return row.has_authority !== 0;
}

export function setCachedAuthority(username: string, hasAuthority: boolean): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO authority_cache (username, has_authority, checked_at)
    VALUES (?, ?, datetime('now'))
  `).run(username, hasAuthority ? 1 : 0);
}
