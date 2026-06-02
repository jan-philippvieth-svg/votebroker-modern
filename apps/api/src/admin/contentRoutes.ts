import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { getSession } from "../auth/sessionStore.js";
import { broadcastConfig, steemNetworkConfig } from "../config.js";
import { createSteemClient } from "../chain/steemBroadcaster.js";
import { PrivateKey } from "dsteem";
import { generateDevlogDraft } from "../jobs/dailyDevlog.js";

const execFileAsync = promisify(execFile);
const SCREENSHOT_SCRIPT = process.env.VOTEBROKER_SCREENSHOT_SCRIPT ?? "";
const SCREENSHOT_TOKEN  = process.env.SESSION_TOKEN ?? "";

// Resolve content dir: explicit env → DB_PATH sibling → /app/data/content (if exists) → docs/content
const CONTENT_DIR = (() => {
  if (process.env.VOTEBROKER_CONTENT_DIR) return process.env.VOTEBROKER_CONTENT_DIR;
  const dbPath = process.env.VOTEBROKER_DB_PATH;
  if (dbPath) return resolve(dbPath, "..", "content");
  if (existsSync("/app/data")) return "/app/data/content";
  return resolve("docs/content");
})();
const DRAFT_PATTERN = /^(\d{4}-\d{2}-\d{2})-(product-post|tech-post|devlog-post)\.md$/;

// Hours between scheduled posts
const SCHEDULE_SPACING_HOURS = 8;

// ── Types ─────────────────────────────────────────────────────────────────────

export type DraftStatus =
  | "draft"
  | "reviewed"
  | "approved"
  | "scheduled"
  | "publishing"   // broadcast in progress
  | "published"    // confirmed on-chain
  | "failed";      // broadcast failed

export interface ContentDraft {
  filename: string;
  dateStr: string;
  type: "product-post" | "tech-post" | "devlog-post";
  title: string;
  status: DraftStatus;
  notes: string | null;
  reviewedAt:         string | null;
  approvedAt:         string | null;
  scheduledAt:        string | null;
  scheduledFor:       string | null;
  publishedAt:        string | null;
  publishTxId:        string | null;   // blockchain transactionId
  publishedPermlink:  string | null;   // on-chain permlink for verification
  failedAt:           string | null;
  failedReason:       string | null;
  createdAt: string;
  updatedAt: string;
  wordCount?: number;
}

type DraftRow = {
  filename: string; date_str: string; type: string; title: string | null;
  status: string; notes: string | null; reviewed_at: string | null;
  approved_at: string | null; scheduled_at: string | null; scheduled_for: string | null;
  published_at: string | null; publish_tx_id: string | null; published_permlink: string | null;
  failed_at: string | null; failed_reason: string | null;
  created_at: string; updated_at: string;
};

// ── Frontmatter parser ────────────────────────────────────────────────────────

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  if (!content.startsWith("---\n")) return { meta: {}, body: content };
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return { meta: {}, body: content };
  const meta: Record<string, string> = {};
  for (const line of content.slice(4, end).split("\n")) {
    const m = line.match(/^([a-zA-Z_-]+):\s*"?(.*?)"?\s*$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body: content.slice(end + 5) };
}

// ── Content validation ────────────────────────────────────────────────────────

const PLACEHOLDER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /bitte manuell ausfüllen/i,      label: '"bitte manuell ausfüllen"' },
  { pattern: /\bTODO\b/,                       label: 'TODO' },
  { pattern: /\bTBD\b/,                        label: 'TBD' },
  { pattern: /\bPLACEHOLDER\b/i,              label: 'PLACEHOLDER' },
  { pattern: /interner Hinweis/i,              label: '"interner Hinweis"' },
  { pattern: /vor der Veröffentlichung.*entfernen/i, label: '"vor Veröffentlichung entfernen"' },
  { pattern: /vor Veröffentlichung.*prüfen/i,  label: '"vor Veröffentlichung prüfen"' },
  { pattern: /DRAFT.*REVIEW BEFORE PUBLISHING/i, label: 'DRAFT warning in body' },
  { pattern: /✏ (EDIT|MANUAL EDIT NEEDED)/,   label: 'unresolved edit marker (✏ EDIT)' },
  { pattern: /<!--.*?(EDIT|TODO|REVIEW).*?-->/is, label: 'HTML comment with EDIT/TODO/REVIEW' },
];

interface ValidationResult {
  valid: boolean;
  violations: string[];
}

function validateContent(body: string): ValidationResult {
  const violations: string[] = [];
  for (const { pattern, label } of PLACEHOLDER_PATTERNS) {
    if (pattern.test(body)) violations.push(label);
  }
  return { valid: violations.length === 0, violations };
}

// ── Scheduling helper ─────────────────────────────────────────────────────────

function nextScheduleSlot(): string {
  const db = getDb();
  const lastScheduled = db.prepare(`
    SELECT scheduled_for FROM content_drafts
    WHERE status IN ('scheduled') AND scheduled_for IS NOT NULL
    ORDER BY scheduled_for DESC LIMIT 1
  `).get() as { scheduled_for: string } | undefined;

  const baseMs = lastScheduled
    ? Math.max(Date.now(), Date.parse(lastScheduled.scheduled_for))
    : Date.now();

  return new Date(baseMs + SCHEDULE_SPACING_HOURS * 3600_000).toISOString();
}

// ── Auto-discovery ────────────────────────────────────────────────────────────

function discoverAndSync(): void {
  if (!existsSync(CONTENT_DIR)) return;
  const db   = getDb();
  const files = readdirSync(CONTENT_DIR).filter(f => DRAFT_PATTERN.test(f));
  for (const filename of files) {
    if (db.prepare("SELECT filename FROM content_drafts WHERE filename = ?").get(filename)) continue;
    const m = DRAFT_PATTERN.exec(filename)!;
    let title = filename;
    try {
      const { meta } = parseFrontmatter(readFileSync(resolve(CONTENT_DIR, filename), "utf8"));
      if (meta.title) title = meta.title;
    } catch {}
    db.prepare(`
      INSERT OR IGNORE INTO content_drafts (filename, date_str, type, title, status)
      VALUES (?, ?, ?, ?, 'draft')
    `).run(filename, m[1], m[2], title);
  }
}

function rowToDraft(row: DraftRow): ContentDraft {
  return {
    filename: row.filename,
    dateStr:  row.date_str,
    type:     row.type as ContentDraft["type"],
    title:    row.title ?? row.filename,
    status:   row.status as DraftStatus,
    notes:           row.notes,
    reviewedAt:      row.reviewed_at,
    approvedAt:      row.approved_at,
    scheduledAt:     row.scheduled_at,
    scheduledFor:    row.scheduled_for,
    publishedAt:     row.published_at,
    publishTxId:     row.publish_tx_id,
    publishedPermlink: row.published_permlink,
    failedAt:        row.failed_at,
    failedReason:    row.failed_reason,
    createdAt:       row.created_at,
    updatedAt:       row.updated_at,
  };
}

// ── Publish helpers ───────────────────────────────────────────────────────────

function generatePermlink(title: string, date: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[äöüß]/g, c => ({ ä:"ae", ö:"oe", ü:"ue", ß:"ss" }[c] ?? c))
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${slug}-${date.replace(/-/g, "")}`;
}

const TYPE_TAGS: Record<string, string[]> = {
  "product-post": ["votebroker", "steem", "update", "curation"],
  "tech-post":    ["votebroker", "steem", "development", "technology"],
  "devlog-post":  ["votebroker", "devlog", "building", "blockchain"],
};

function getSessionHeader2(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerContentRoutes(app: FastifyInstance): Promise<void> {

  // ── POST /api/admin/content/generate-devlog ────────────────────────────────
  // Trigger devlog draft generation (admin session required — see routes.ts for
  // operator-token variant at /api/devlog/generate).
  app.post("/api/admin/content/generate-devlog", async (request, reply) => {
    const changeSchema = z.object({
      type:        z.enum(["feat", "fix", "ux", "perf", "refactor", "other"]),
      description: z.string().min(1).max(500),
    });
    const body = z.object({
      date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      changes:     z.array(changeSchema).max(50).optional(),
      nextItems:   z.array(z.string().min(1).max(300)).max(10).optional(),
      screenshots: z.array(z.string().min(1).max(200)).max(10).optional(),
      sinceDate:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      force:       z.boolean().optional(),
    }).safeParse(request.body);

    if (!body.success) return reply.code(400).send({ error: "invalid_request", detail: body.error.flatten() });

    const { date, changes, nextItems, screenshots, sinceDate, force } = body.data;
    const opts = {
      date:        date ? new Date(date + "T12:00:00Z") : new Date(),
      changes,
      nextItems,
      screenshots,
      sinceDate,
      force,
    };
    const result = await generateDevlogDraft(request.log as unknown as typeof console, opts);

    if (result.status === "failed") {
      return reply.code(500).send({ error: "generation_failed", reason: result.reason });
    }
    return result;
  });

  // ── POST /api/admin/capture-screenshots ──────────────────────────────────
  // Runs the Python capture + annotate pipeline if VOTEBROKER_SCREENSHOT_SCRIPT is set.
  // Returns {status:"unavailable"} gracefully if not configured.
  app.post("/api/admin/capture-screenshots", async (request, reply) => {
    if (!SCREENSHOT_SCRIPT || !existsSync(SCREENSHOT_SCRIPT)) {
      return {
        status:  "unavailable",
        message: "Screenshot-Pipeline nicht konfiguriert. Setze VOTEBROKER_SCREENSHOT_SCRIPT=/pfad/zu/capture.py",
      };
    }

    const scriptDir = resolve(SCREENSHOT_SCRIPT, "..");
    const annotate  = resolve(scriptDir, "annotate.py");
    const env = { ...process.env };
    if (SCREENSHOT_TOKEN) env.SESSION_TOKEN = SCREENSHOT_TOKEN;

    try {
      await execFileAsync("python3", [SCREENSHOT_SCRIPT], { env, timeout: 120_000 });
      if (existsSync(annotate)) {
        await execFileAsync("python3", [annotate], { env, timeout: 60_000 });
      }

      const outDir = resolve(scriptDir, "output", "annotated");
      let files: string[] = [];
      if (existsSync(outDir)) {
        files = readdirSync(outDir)
          .filter(f => f.endsWith(".png"))
          .map(f => resolve(outDir, f));
      }
      request.log.info({ files }, "Screenshots captured");
      return { status: "ok", files };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      request.log.error({ msg }, "Screenshot capture failed");
      return reply.code(500).send({ status: "failed", message: msg });
    }
  });

  // List all drafts
  app.get("/api/admin/content", async () => {
    discoverAndSync();
    const rows = getDb().prepare(
      "SELECT * FROM content_drafts ORDER BY date_str DESC, filename ASC"
    ).all() as DraftRow[];

    const drafts = rows.map(r => {
      const d = rowToDraft(r);
      try {
        const text = readFileSync(resolve(CONTENT_DIR, r.filename), "utf8");
        d.wordCount = text.split(/\s+/).length;
      } catch { d.wordCount = 0; }
      return d;
    });

    const counts: Record<string, number> = { total: drafts.length };
    for (const d of drafts) counts[d.status] = (counts[d.status] ?? 0) + 1;

    // Next scheduled publish
    const nextUp = drafts.find(d => d.status === "scheduled" && d.scheduledFor);

    return { drafts, counts, contentDir: CONTENT_DIR, nextScheduled: nextUp ?? null };
  });

  // Get draft content
  app.get("/api/admin/content/preview", async (request, reply) => {
    const q = z.object({ file: z.string().min(1).max(200) }).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_request" });
    const filename = q.data.file;
    if (!DRAFT_PATTERN.test(filename)) return reply.code(400).send({ error: "invalid_filename" });
    const path = resolve(CONTENT_DIR, filename);
    if (!existsSync(path)) return reply.code(404).send({ error: "not_found" });
    const content = readFileSync(path, "utf8");
    const { meta } = parseFrontmatter(content);
    return { filename, content, meta };
  });

  // Update draft status
  app.post("/api/admin/content/status", async (request, reply) => {
    const body = z.object({
      filename:     z.string().min(1).max(200),
      status:       z.enum(["draft", "reviewed", "approved", "scheduled", "published", "failed"]),
      notes:        z.string().max(1000).optional(),
      scheduledFor: z.string().datetime().optional(),  // explicit schedule time
      failedReason: z.string().max(500).optional(),
    }).safeParse(request.body);

    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    if (!DRAFT_PATTERN.test(body.data.filename)) return reply.code(400).send({ error: "invalid_filename" });

    const { filename, status, notes, scheduledFor, failedReason } = body.data;
    const now = new Date().toISOString();

    const existing = getDb().prepare("SELECT filename FROM content_drafts WHERE filename = ?").get(filename);
    if (!existing) discoverAndSync();

    // Workflow enforcement: must pass through scheduled before published
    if (status === "published") {
      const row = getDb().prepare("SELECT status FROM content_drafts WHERE filename = ?").get(filename) as { status: string } | undefined;
      if (row && row.status !== "scheduled") {
        return reply.code(400).send({
          error: "publish_requires_scheduled",
          hint: "A post must be in 'scheduled' status before it can be published. Workflow: approved → scheduled → published."
        });
      }
    }

    // Auto-compute schedule time for 'scheduled' status
    const resolvedScheduledFor = status === "scheduled"
      ? (scheduledFor ?? nextScheduleSlot())
      : undefined;

    const update: Record<string, string | null> = {
      status, updated_at: now,
      notes: notes ?? null,
    };
    if (status === "reviewed")   update.reviewed_at   = now;
    if (status === "approved")   update.approved_at   = now;
    if (status === "scheduled") {
      update.scheduled_at  = now;
      update.scheduled_for = resolvedScheduledFor ?? null;
    }
    if (status === "published")  update.published_at  = now;
    if (status === "failed") {
      update.failed_at     = now;
      update.failed_reason = failedReason ?? null;
    }

    const setCols = Object.keys(update).map(k => `${k} = ?`).join(", ");
    getDb().prepare(`UPDATE content_drafts SET ${setCols} WHERE filename = ?`)
      .run(...Object.values(update), filename);

    const row = getDb().prepare("SELECT * FROM content_drafts WHERE filename = ?").get(filename) as DraftRow;
    return { ok: true, draft: rowToDraft(row) };
  });

  // Edit draft content
  app.put("/api/admin/content/edit", async (request, reply) => {
    const body = z.object({
      filename: z.string().min(1).max(200),
      content:  z.string().min(1).max(500_000)
    }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });
    if (!DRAFT_PATTERN.test(body.data.filename)) return reply.code(400).send({ error: "invalid_filename" });
    const path = resolve(CONTENT_DIR, body.data.filename);
    if (!existsSync(path)) return reply.code(404).send({ error: "not_found" });
    writeFileSync(path, body.data.content, "utf8");
    getDb().prepare("UPDATE content_drafts SET updated_at = ? WHERE filename = ?")
      .run(new Date().toISOString(), body.data.filename);
    return { ok: true, filename: body.data.filename, bytes: body.data.content.length };
  });

  // Get schedule overview
  app.get("/api/admin/content/schedule", async () => {
    const rows = getDb().prepare(`
      SELECT * FROM content_drafts
      WHERE status IN ('approved', 'scheduled')
      ORDER BY scheduled_for ASC NULLS LAST
    `).all() as DraftRow[];
    return {
      queue: rows.map(rowToDraft),
      spacingHours: SCHEDULE_SPACING_HOURS,
      nextSlot: nextScheduleSlot()
    };
  });

  // ── POST /api/admin/content/publish ─────────────────────────────────────────
  // Performs the actual blockchain broadcast of a content draft as a Steem post.
  // PUBLISHED is only set after a confirmed on-chain transaction.
  app.post("/api/admin/content/publish", async (request, reply) => {
    const body = z.object({ filename: z.string().min(1).max(200) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    const { filename } = body.data;
    if (!DRAFT_PATTERN.test(filename)) return reply.code(400).send({ error: "invalid_filename" });

    // Require the post to be in 'scheduled' status
    const existing = getDb().prepare("SELECT * FROM content_drafts WHERE filename = ?").get(filename) as DraftRow | undefined;
    if (!existing) return reply.code(404).send({ error: "draft_not_found" });
    if (existing.status !== "scheduled") {
      return reply.code(400).send({
        error: "publish_requires_scheduled",
        hint: `Status is '${existing.status}'. Must be 'scheduled' before publishing.`
      });
    }

    // Read and parse the draft file
    const filePath = resolve(CONTENT_DIR, filename);
    if (!existsSync(filePath)) return reply.code(404).send({ error: "file_not_found" });

    const rawContent = readFileSync(filePath, "utf8");
    const { meta, body: postBody } = parseFrontmatter(rawContent);
    const title    = meta.title?.replace(/^["']|["']$/g, "") || existing.title || filename;
    const type     = existing.type;
    const permlink = existing.published_permlink || generatePermlink(title, existing.date_str);
    const tags     = TYPE_TAGS[type] ?? ["votebroker", "steem"];

    // ── Content validation — block publishing of unfinished drafts ────────────
    const validation = validateContent(postBody);
    if (!validation.valid) {
      // Mark as needing review rather than silently blocking
      getDb().prepare(
        "UPDATE content_drafts SET status='draft', notes=?, updated_at=? WHERE filename=?"
      ).run(`Content validation failed: ${validation.violations.join(", ")}`, new Date().toISOString(), filename);

      return reply.code(422).send({
        error:      "content_validation_failed",
        violations: validation.violations,
        hint:       "Remove all placeholder markers before publishing. Status reset to 'draft'.",
        draft:      rowToDraft(getDb().prepare("SELECT * FROM content_drafts WHERE filename=?").get(filename) as DraftRow),
      });
    }

    // Author is always the configured VoteBroker publishing account, not the logged-in admin
    const _session = getSession(getSessionHeader2(request.headers.session)); // available if needed
    const author   = broadcastConfig.account;

    // Require posting WIF to be configured
    if (!broadcastConfig.postingWif) {
      return reply.code(503).send({
        error: "posting_wif_not_configured",
        hint: "VOTEBROKER_POSTING_WIF must be set to broadcast posts."
      });
    }

    // Set status → publishing (intermediate state)
    const now = new Date().toISOString();
    getDb().prepare(
      "UPDATE content_drafts SET status='publishing', updated_at=? WHERE filename=?"
    ).run(now, filename);

    // ── Blockchain broadcast ────────────────────────────────────────────────
    let transactionId = "";
    let broadcastError: string | null = null;

    try {
      const client = createSteemClient();
      const key    = PrivateKey.fromString(broadcastConfig.postingWif);

      const result = await (client.broadcast as unknown as {
        comment(op: {
          parent_author: string; parent_permlink: string;
          author: string; permlink: string; title: string;
          body: string; json_metadata: string;
        }, key: PrivateKey): Promise<{ id: string }>;
      }).comment({
        parent_author:  "",
        parent_permlink: tags[0] ?? "votebroker",
        author,
        permlink,
        title,
        body:          postBody.trim(),
        json_metadata: JSON.stringify({ tags, app: "votebroker/1.0", type }),
      }, key);

      transactionId = result?.id ?? "";

      if (!transactionId || !/^[0-9a-f]{40}$/i.test(transactionId)) {
        throw new Error(`Broadcast returned non-hash transactionId: "${transactionId}"`);
      }
    } catch (err) {
      broadcastError = err instanceof Error ? err.message : String(err);
    }

    // ── On-chain verification ───────────────────────────────────────────────
    if (!broadcastError) {
      try {
        await new Promise(r => setTimeout(r, 3000)); // wait for block confirmation
        const client = createSteemClient();
        const db2 = client.database as unknown as { call(m: string, p: unknown[]): Promise<{ author: string }> };
        const onChain = await db2.call("get_content", [author, permlink]);
        if (!onChain?.author) {
          broadcastError = `On-chain verification failed: post @${author}/${permlink} not found after broadcast`;
        }
      } catch (e) {
        broadcastError = `On-chain verification error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    // ── Update DB based on result ───────────────────────────────────────────
    if (broadcastError) {
      getDb().prepare(`
        UPDATE content_drafts
        SET status='failed', failed_at=?, failed_reason=?, updated_at=?
        WHERE filename=?
      `).run(now, broadcastError, now, filename);
      return reply.code(502).send({
        error:        "broadcast_failed",
        failedReason: broadcastError,
        draft:        rowToDraft(getDb().prepare("SELECT * FROM content_drafts WHERE filename=?").get(filename) as DraftRow),
      });
    }

    getDb().prepare(`
      UPDATE content_drafts
      SET status='published', published_at=?, publish_tx_id=?, published_permlink=?, updated_at=?
      WHERE filename=?
    `).run(now, transactionId!, permlink, now, filename);

    request.log.info({ filename, author, permlink, transactionId, title }, "content draft published on-chain");

    return {
      ok:          true,
      transactionId: transactionId!,
      author,
      permlink,
      url:         `https://steemit.com/@${author}/${permlink}`,
      draft:       rowToDraft(getDb().prepare("SELECT * FROM content_drafts WHERE filename=?").get(filename) as DraftRow),
    };
  });
}
