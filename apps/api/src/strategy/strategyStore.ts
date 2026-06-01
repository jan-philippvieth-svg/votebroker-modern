import { getDb } from "../db/index.js";

type RuleRow = { rules_json: string; updated_at: string };

export function loadStrategy(username: string): unknown[] | null {
  const row = getDb().prepare(`
    SELECT rules_json FROM strategy_rules WHERE username = ?
  `).get(username) as RuleRow | undefined;

  if (!row) return null;
  try { return JSON.parse(row.rules_json) as unknown[]; }
  catch { return null; }
}

export function saveStrategy(username: string, rules: unknown[]): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO strategy_rules (username, rules_json, updated_at)
    VALUES (?, ?, datetime('now'))
  `).run(username, JSON.stringify(rules));
}

export function deleteStrategy(username: string): void {
  getDb().prepare("DELETE FROM strategy_rules WHERE username = ?").run(username);
}
