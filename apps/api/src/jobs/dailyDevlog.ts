import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getDb } from "../db/index.js";

const CONTENT_DIR = process.env.VOTEBROKER_CONTENT_DIR ?? resolve("docs/content");
const RUN_HOUR_UTC   = 22;   // 22:00 UTC — end-of-day summary
const RUN_MINUTE_UTC = 0;

function nextRunTime(): Date {
  const now  = new Date();
  const next = new Date(now);
  next.setUTCHours(RUN_HOUR_UTC, RUN_MINUTE_UTC, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function msUntilNextRun(): number {
  return nextRunTime().getTime() - Date.now();
}

// ── Activity snapshot from audit_events ──────────────────────────────────────

interface DayStats {
  voteAttempts: number;
  uniqueAuthors: string[];
  activeUsers: string[];
  errors: number;
}

function getDayStats(dateStr: string): DayStats {
  const db = getDb();
  const since = `${dateStr}T00:00:00.000Z`;
  const until = `${dateStr}T23:59:59.999Z`;

  const rows = db.prepare(`
    SELECT type, username, author
    FROM audit_events
    WHERE created_at >= ? AND created_at <= ?
  `).all(since, until) as Array<{ type: string; username: string; author: string | null }>;

  const voteAttempts = rows.filter(r => r.type === "vote_broadcast_attempt").length;
  const uniqueAuthors = [...new Set(rows.filter(r => r.author).map(r => r.author!))];
  const activeUsers   = [...new Set(rows.map(r => r.username))];
  const errors        = rows.filter(r => r.type.includes("error") || r.type.includes("fail")).length;

  return { voteAttempts, uniqueAuthors, activeUsers, errors };
}

// ── Markdown template ─────────────────────────────────────────────────────────

function buildDraftMarkdown(dateStr: string, stats: DayStats): string {
  const displayDate = new Date(dateStr + "T12:00:00Z").toLocaleDateString("de-DE", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });

  const authorList = stats.uniqueAuthors.length > 0
    ? stats.uniqueAuthors.slice(0, 8).map(a => `@${a}`).join(", ")
    : "keine Votes";
  const moreSuffix = stats.uniqueAuthors.length > 8
    ? ` und ${stats.uniqueAuthors.length - 8} weitere` : "";

  return `---
title: "VoteBroker Devlog — ${displayDate}"
date: ${dateStr}
type: devlog-post
---

# VoteBroker Devlog — ${displayDate}

Täglicher Überblick über Entwicklungsfortschritt und Community-Aktivität bei VoteBroker.

## Was wurde gebaut oder verbessert

*Dieser Abschnitt wird manuell ausgefüllt — bitte vor der Planung ergänzen.*

---

## Community-Aktivität

In den letzten 24 Stunden (${dateStr}):

- **${stats.voteAttempts}** Vote-Versuche ausgeführt
- **${stats.uniqueAuthors.length}** Autoren unterstützt: ${authorList}${moreSuffix}
- **${stats.activeUsers.length}** aktive Kuratoren
${stats.errors > 0 ? `- **${stats.errors}** Fehler protokolliert — Details im Admin-Log` : "- Keine Fehler protokolliert"}

---

## Was als Nächstes kommt

*Hier bitte offene Punkte, nächste Features oder geplante Verbesserungen eintragen.*

---

*VoteBroker — Community Curation auf Steem · [votebroker.org](https://votebroker.org)*
`;
}

// ── Core job ──────────────────────────────────────────────────────────────────

export interface DevlogDraftResult {
  dateStr:  string;
  filename: string;
  status:   "created" | "skipped" | "failed";
  reason?:  string;
}

export async function generateDevlogDraft(
  log: typeof console = console,
  date?: Date,
): Promise<DevlogDraftResult> {
  const now     = date ?? new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const filename = `${dateStr}-devlog-post.md`;
  const filePath = resolve(CONTENT_DIR, filename);
  const db = getDb();

  log.info(`[DailyDevlog] Generating draft for ${dateStr}`);

  // Skip if draft already registered in DB (regardless of file)
  const existing = db.prepare("SELECT filename FROM content_drafts WHERE filename = ?").get(filename);
  if (existing) {
    log.info(`[DailyDevlog] Draft already exists: ${filename}`);
    return { dateStr, filename, status: "skipped", reason: "already registered" };
  }

  try {
    mkdirSync(CONTENT_DIR, { recursive: true });

    const stats   = getDayStats(dateStr);
    const content = buildDraftMarkdown(dateStr, stats);

    writeFileSync(filePath, content, "utf8");

    db.prepare(`
      INSERT OR IGNORE INTO content_drafts (filename, date_str, type, title, status)
      VALUES (?, ?, 'devlog-post', ?, 'draft')
    `).run(filename, dateStr, `VoteBroker Devlog — ${dateStr}`);

    log.info(`[DailyDevlog] Draft created: ${filename} (${stats.voteAttempts} votes, ${stats.uniqueAuthors.length} authors)`);
    return { dateStr, filename, status: "created" };

  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error(`[DailyDevlog] Failed to generate draft: ${reason}`);
    return { dateStr, filename, status: "failed", reason };
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export function startDailyDevlogScheduler(log: typeof console = console): void {
  const nextRun = nextRunTime();
  const delay   = msUntilNextRun();

  log.info(`[DailyDevlog] Scheduler started — next run at ${nextRun.toISOString()} (in ${(delay / 3_600_000).toFixed(1)}h)`);

  setTimeout(function schedule() {
    generateDevlogDraft(log).catch(err =>
      log.error("[DailyDevlog] Unhandled error:", err)
    );
    // Schedule next run ~24h from now
    setTimeout(schedule, msUntilNextRun());
  }, delay);
}
