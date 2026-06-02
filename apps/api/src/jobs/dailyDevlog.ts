import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb } from "../db/index.js";
const CONTENT_DIR = (() => {
  if (process.env.VOTEBROKER_CONTENT_DIR) return process.env.VOTEBROKER_CONTENT_DIR;
  const dbPath = process.env.VOTEBROKER_DB_PATH;
  if (dbPath) return resolve(dbPath, "..", "content");
  if (existsSync("/app/data")) return "/app/data/content";
  return resolve("docs/content");
})();
const RUN_HOUR_UTC   = 22;
const RUN_MINUTE_UTC = 0;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DevlogChange {
  type:        "feat" | "fix" | "ux" | "perf" | "refactor" | "other";
  description: string;
}

export interface DevlogDraftOptions {
  date?:             Date;
  changes?:          DevlogChange[];    // provided by host-side git reader
  nextItems?:        string[];          // roadmap items to mention
  screenshots?:      string[];          // list of image filenames to embed
  sinceDate?:        string;            // ISO date of last devlog (for context header)
  force?:            boolean;           // overwrite if draft exists for this date
}

export interface DevlogDraftResult {
  dateStr:   string;
  filename:  string;
  status:    "created" | "skipped" | "failed" | "updated";
  reason?:   string;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

interface DayStats {
  voteAttempts:  number;
  uniqueAuthors: string[];
  activeUsers:   string[];
  errors:        number;
}

function getDayStats(dateStr: string): DayStats {
  const db    = getDb();
  const since = `${dateStr}T00:00:00.000Z`;
  const until = `${dateStr}T23:59:59.999Z`;

  const rows = db.prepare(`
    SELECT type, username, author
    FROM audit_events
    WHERE created_at >= ? AND created_at <= ?
  `).all(since, until) as Array<{ type: string; username: string; author: string | null }>;

  return {
    voteAttempts:  rows.filter(r => r.type === "vote_broadcast_attempt").length,
    uniqueAuthors: [...new Set(rows.filter(r => r.author).map(r => r.author!))],
    activeUsers:   [...new Set(rows.map(r => r.username))],
    errors:        rows.filter(r => r.type.includes("error") || r.type.includes("fail")).length,
  };
}

/** Returns the date_str of the most recent devlog-post draft (any status). */
export function getLastDevlogDate(): string | null {
  const db  = getDb();
  const row = db.prepare(`
    SELECT date_str FROM content_drafts
    WHERE type = 'devlog-post'
    ORDER BY date_str DESC LIMIT 1
  `).get() as { date_str: string } | undefined;
  return row?.date_str ?? null;
}

// ── Markdown builder ───────────────────────────────────────────────────────────

const TYPE_LABEL: Record<DevlogChange["type"], string> = {
  feat:     "Neu",
  fix:      "Fix",
  ux:       "UX",
  perf:     "Performance",
  refactor: "Refactoring",
  other:    "Sonstiges",
};

function buildChangesSection(changes: DevlogChange[]): string {
  if (changes.length === 0) return "";

  // Group by type
  const grouped = new Map<DevlogChange["type"], string[]>();
  for (const c of changes) {
    if (!grouped.has(c.type)) grouped.set(c.type, []);
    grouped.get(c.type)!.push(c.description);
  }

  const order: DevlogChange["type"][] = ["feat", "fix", "ux", "perf", "refactor", "other"];
  let out = "";
  for (const t of order) {
    const items = grouped.get(t);
    if (!items || items.length === 0) continue;
    out += `\n**${TYPE_LABEL[t]}:**\n`;
    for (const item of items) out += `- ${item}\n`;
  }
  return out.trim();
}

function buildScreenshotsSection(screenshots: string[]): string {
  if (screenshots.length === 0) return "";
  const lines = screenshots.map(s => `![Screenshot](${s})`).join("\n\n");
  return `## Screenshots\n\n${lines}\n`;
}

function buildDraftMarkdown(
  dateStr: string,
  stats: DayStats,
  opts: DevlogDraftOptions,
): string {
  const displayDate = new Date(dateStr + "T12:00:00Z").toLocaleDateString("de-DE", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });

  const sinceNote = opts.sinceDate && opts.sinceDate !== dateStr
    ? `\n*Änderungen seit: ${opts.sinceDate}*\n`
    : "";

  const authorList = stats.uniqueAuthors.length > 0
    ? stats.uniqueAuthors.slice(0, 8).map(a => `@${a}`).join(", ")
      + (stats.uniqueAuthors.length > 8 ? ` und ${stats.uniqueAuthors.length - 8} weitere` : "")
    : "keine Votes";

  const changesSection = opts.changes && opts.changes.length > 0
    ? buildChangesSection(opts.changes)
    : "*Keine Commit-Daten — bitte manuell ergänzen oder via generate.py mit git-Integration generieren.*";

  const nextSection = opts.nextItems && opts.nextItems.length > 0
    ? opts.nextItems.map(i => `- ${i}`).join("\n")
    : "*Nächste geplante Schritte hier eintragen.*";

  const screenshotsSection = opts.screenshots && opts.screenshots.length > 0
    ? "\n" + buildScreenshotsSection(opts.screenshots) + "\n"
    : "";

  return `---
title: "VoteBroker Devlog — ${displayDate}"
date: ${dateStr}
type: devlog-post
---

# VoteBroker Devlog — ${displayDate}
${sinceNote}
---

## Änderungen seit dem letzten Devlog
${screenshotsSection}
${changesSection}

---

## Community-Aktivität

Heute (${dateStr}):

- **${stats.voteAttempts}** Vote-Versuche ausgeführt
- **${stats.uniqueAuthors.length}** Autoren unterstützt: ${authorList}
- **${stats.activeUsers.length}** aktive Kuratoren
${stats.errors > 0 ? `- **${stats.errors}** Fehler protokolliert — Details im Admin-Log\n` : ""}
---

## Was als Nächstes kommt

${nextSection}

---

*VoteBroker — Community Curation auf Steem · [votebroker.org](https://votebroker.org)*
`;
}

// ── Core job ──────────────────────────────────────────────────────────────────

export async function generateDevlogDraft(
  log: typeof console = console,
  opts: DevlogDraftOptions = {},
): Promise<DevlogDraftResult> {
  const now     = opts.date ?? new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const filename = `${dateStr}-devlog-post.md`;
  const filePath = resolve(CONTENT_DIR, filename);
  const db = getDb();

  log.info(`[DailyDevlog] Generating draft for ${dateStr}`);

  const existing = db.prepare("SELECT filename, status FROM content_drafts WHERE filename = ?")
    .get(filename) as { filename: string; status: string } | undefined;

  if (existing && !opts.force) {
    log.info(`[DailyDevlog] Draft already exists: ${filename} (use force:true to overwrite)`);
    return { dateStr, filename, status: "skipped", reason: "already registered" };
  }

  try {
    mkdirSync(CONTENT_DIR, { recursive: true });

    const stats   = getDayStats(dateStr);
    const content = buildDraftMarkdown(dateStr, stats, {
      ...opts,
      sinceDate: opts.sinceDate ?? getLastDevlogDate() ?? undefined,
    });

    writeFileSync(filePath, content, "utf8");

    if (existing) {
      // Force-update: reset to draft
      db.prepare(`
        UPDATE content_drafts
        SET status='draft', title=?, updated_at=datetime('now')
        WHERE filename=?
      `).run(`VoteBroker Devlog — ${dateStr}`, filename);
      log.info(`[DailyDevlog] Draft updated (force): ${filename}`);
      return { dateStr, filename, status: "updated" };
    } else {
      db.prepare(`
        INSERT OR IGNORE INTO content_drafts (filename, date_str, type, title, status)
        VALUES (?, ?, 'devlog-post', ?, 'draft')
      `).run(filename, dateStr, `VoteBroker Devlog — ${dateStr}`);
      log.info(`[DailyDevlog] Draft created: ${filename} (${stats.voteAttempts} votes, ${stats.uniqueAuthors.length} authors, ${opts.changes?.length ?? 0} changes)`);
      return { dateStr, filename, status: "created" };
    }

  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error(`[DailyDevlog] Failed: ${reason}`);
    return { dateStr, filename, status: "failed", reason };
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

function nextRunTime(): Date {
  const now  = new Date();
  const next = new Date(now);
  next.setUTCHours(RUN_HOUR_UTC, RUN_MINUTE_UTC, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export function startDailyDevlogScheduler(log: typeof console = console): void {
  const nextRun = nextRunTime();
  const delay   = nextRun.getTime() - Date.now();

  log.info(`[DailyDevlog] Scheduler started — next run at ${nextRun.toISOString()} (in ${(delay / 3_600_000).toFixed(1)}h)`);

  setTimeout(function schedule() {
    // Automatic runs: text-only, no force (skip if already exists for today)
    generateDevlogDraft(log, {}).catch(err =>
      log.error("[DailyDevlog] Unhandled error:", err)
    );
    setTimeout(schedule, nextRunTime().getTime() - Date.now());
  }, delay);
}
