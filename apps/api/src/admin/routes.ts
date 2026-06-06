import type { FastifyInstance, FastifyRequest } from "fastify";
import { getSession } from "../auth/sessionStore.js";
import { getDb } from "../db/index.js";
import { getAuditStats, getRecentAuditEvents } from "../audit/auditLog.js";
import { getRecentFeePostLog, getLastFeePostRun, runDailyFeePost } from "../jobs/dailyFeePost.js";
import { broadcastConfig, steemNetworkConfig } from "../config.js";
import { createSteemClient } from "../chain/steemBroadcaster.js";

// ── Owner-only access ─────────────────────────────────────────────────────────
const ADMIN_USERNAME = "jan-philippvieth";

function getSessionHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function requireAdmin(request: FastifyRequest): { username: string } | null {
  const session = getSession(getSessionHeader(request.headers.session));
  if (!session || session.user.username !== ADMIN_USERNAME) return null;
  return { username: session.user.username };
}

// ── DB helper types ───────────────────────────────────────────────────────────
type CountRow  = { n: number };
type ScalarRow = { v: string | number | null };

function count(sql: string, ...params: unknown[]): number {
  const row = getDb().prepare(sql).get(...(params as [])) as CountRow | undefined;
  return row?.n ?? 0;
}

// ── Platform overview ─────────────────────────────────────────────────────────
function getPlatformOverview() {
  const db = getDb();

  // All-time unique users across all tables
  const allUsers = db.prepare(`
    SELECT username FROM sessions
    UNION SELECT username FROM consents
    UNION SELECT username FROM strategy_rules
  `).all() as Array<{ username: string }>;
  const totalUsers = allUsers.length;

  const activeUsers7d  = count("SELECT COUNT(DISTINCT username) as n FROM sessions WHERE created_at >= datetime('now', '-7 days')");
  const activeUsers30d = count("SELECT COUNT(DISTINCT username) as n FROM sessions WHERE created_at >= datetime('now', '-30 days')");

  // New users: first session today
  const newUsersToday = count(`
    SELECT COUNT(DISTINCT s1.username) as n FROM sessions s1
    WHERE date(s1.created_at) = date('now')
    AND NOT EXISTS (
      SELECT 1 FROM sessions s2
      WHERE s2.username = s1.username AND date(s2.created_at) < date('now')
    )
  `);

  const newUsersMonth = count(`
    SELECT COUNT(DISTINCT s1.username) as n FROM sessions s1
    WHERE s1.created_at >= datetime('now', 'start of month')
    AND NOT EXISTS (
      SELECT 1 FROM sessions s2
      WHERE s2.username = s1.username AND s2.created_at < datetime('now', 'start of month')
    )
  `);

  const totalStrategies   = count("SELECT COUNT(*) as n FROM strategy_rules");
  const activeSessions    = count("SELECT COUNT(*) as n FROM sessions WHERE expiry > datetime('now')");
  const totalConsents     = count("SELECT COUNT(*) as n FROM consents WHERE status = 'granted'");
  const authorityCached   = count("SELECT COUNT(*) as n FROM authority_cache");
  const auditStats        = getAuditStats();

  return {
    users: { totalUsers, activeUsers7d, activeUsers30d, newUsersToday, newUsersMonth },
    platform: { totalStrategies, activeSessions, totalConsents, authorityCached },
    votes: { ...auditStats }
  };
}

// ── User analytics ────────────────────────────────────────────────────────────
function getUserAnalytics() {
  const db = getDb();

  type UserRow = { username: string; last_seen: string };
  type ConsentCountRow = { username: string; consent_count: number };
  type StrategyCountRow = { username: string; rule_count: number | null };
  type RulesRow = { username: string; rules_json: string };

  // All unique users with last seen
  const users = db.prepare(`
    SELECT username, MAX(expiry) as last_seen
    FROM sessions GROUP BY username ORDER BY last_seen DESC LIMIT 50
  `).all() as UserRow[];

  // Consent counts per user
  const consentCounts = db.prepare(`
    SELECT username, COUNT(*) as consent_count FROM consents WHERE status = 'granted' GROUP BY username
  `).all() as ConsentCountRow[];
  const consentMap = new Map(consentCounts.map(r => [r.username, r.consent_count]));

  // Strategy rule counts per user
  const strategyCounts = db.prepare(`
    SELECT username, json_array_length(rules_json) as rule_count FROM strategy_rules
  `).all() as StrategyCountRow[];
  const strategyMap = new Map(strategyCounts.map(r => [r.username, r.rule_count ?? 0]));

  const enriched = users.map(u => ({
    username: u.username,
    lastSeen: u.last_seen,
    consentsGranted: consentMap.get(u.username) ?? 0,
    strategyRules: strategyMap.get(u.username) ?? 0,
    hasStrategy: strategyMap.has(u.username),
    isAdmin: u.username === ADMIN_USERNAME
  }));

  return { users: enriched, total: enriched.length };
}

// ── System health ─────────────────────────────────────────────────────────────
function getSystemHealth() {
  const db = getDb();
  const start = Date.now();
  db.prepare("SELECT 1").get();
  const dbPingMs = Date.now() - start;

  const activeSessions = count("SELECT COUNT(*) as n FROM sessions WHERE expiry > datetime('now')");
  const expiredSessions = count("SELECT COUNT(*) as n FROM sessions WHERE expiry <= datetime('now')");
  const totalAuditEvents = count("SELECT COUNT(*) as n FROM audit_events");
  const failedBroadcasts = count("SELECT COUNT(*) as n FROM audit_events WHERE type LIKE '%_blocked'");
  const authorityCacheEntries = count("SELECT COUNT(*) as n FROM authority_cache");

  const mem = process.memoryUsage();

  // Fee post scheduler status
  const lastRun   = getLastFeePostRun();
  const nowMs     = Date.now();
  const nextRunUtc = (() => {
    const n = new Date();
    n.setUTCHours(1, 0, 0, 0);
    if (n.getTime() <= nowMs) n.setUTCDate(n.getUTCDate() + 1);
    return n.toISOString();
  })();
  const recentFeePostRuns = getRecentFeePostLog(5);
  const lastFeeOk  = lastRun?.status === "success" || lastRun?.status === "skipped";
  const feeWarning = lastRun?.status === "failed"
    ? `Daily fee post failed: ${lastRun.error}`
    : null;

  return {
    api: {
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      nodeVersion: process.version
    },
    database: {
      status: dbPingMs < 100 ? "ok" : "slow",
      pingMs: dbPingMs,
      activeSessions,
      expiredSessions,
      totalAuditEvents,
      authorityCacheEntries
    },
    votes: {
      failedBroadcasts,
      recentBlocked: count("SELECT COUNT(*) as n FROM audit_events WHERE type LIKE '%_blocked' AND created_at >= datetime('now', '-1 day')")
    },
    feePost: {
      schedulerActive: true,
      nextRunAt:       nextRunUtc,
      lastRun,
      lastStatus:      lastRun?.status ?? "never_run",
      lastOk:          lastFeeOk,
      recentRuns:      recentFeePostRuns,
    },
    warnings: [
      ...(dbPingMs > 50  ? [`Database slow: ${dbPingMs}ms`] : []),
      ...(failedBroadcasts > 10 ? [`${failedBroadcasts} failed vote broadcasts`] : []),
      ...(feeWarning ? [feeWarning] : []),
    ]
  };
}

// ── Manual fee post trigger (admin-only) ───────────────────────────────────────
// Pass an optional ISO date string (YYYY-MM-DD) to retroactively publish a missing post.
async function triggerFeePostNow(dateStr?: string, forceUpdate?: boolean): Promise<object> {
  const date = dateStr ? new Date(`${dateStr}T01:00:00Z`) : undefined;
  if (dateStr && isNaN(date!.getTime())) {
    throw new Error(`Invalid date: "${dateStr}" — expected YYYY-MM-DD`);
  }
  return runDailyFeePost(console, date, forceUpdate);
}

// ── VoteBroker insights ───────────────────────────────────────────────────────
function getPlatformInsights() {
  const db = getDb();

  type ConsentTypeRow = { type: string; granted_count: number };
  const consentBreakdown = db.prepare(`
    SELECT type, COUNT(*) as granted_count FROM consents WHERE status = 'granted' GROUP BY type
  `).all() as ConsentTypeRow[];

  type StrategyRow = { username: string; rules_json: string; updated_at: string };
  const strategies = db.prepare("SELECT username, rules_json, updated_at FROM strategy_rules").all() as StrategyRow[];

  // Extract all author mentions from strategy rules
  const authorCounts = new Map<string, number>();
  let totalRules = 0;
  let manualOverrides = 0;

  for (const s of strategies) {
    try {
      const rules = JSON.parse(s.rules_json) as Array<{ username: string; manuallyModified?: boolean; category?: string }>;
      totalRules += rules.length;
      for (const r of rules) {
        if (r.manuallyModified) manualOverrides++;
        if (r.username) authorCounts.set(r.username, (authorCounts.get(r.username) ?? 0) + 1);
      }
    } catch {}
  }

  const topAuthors = [...authorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([username, count]) => ({ username, strategiesCount: count }));

  const auditStats = getAuditStats();

  return {
    consents: {
      breakdown: Object.fromEntries(consentBreakdown.map(r => [r.type, r.granted_count])),
      totalActive: consentBreakdown.reduce((s, r) => s + r.granted_count, 0)
    },
    strategies: {
      total: strategies.length,
      totalRules,
      manualOverrides,
      avgRulesPerUser: strategies.length > 0 ? Math.round(totalRules / strategies.length * 10) / 10 : 0
    },
    votes: auditStats,
    topAuthors
  };
}

// ── KPIs ─────────────────────────────────────────────────────────────────────

function getKpis() {
  const db = getDb();

  // Users
  const totalUsers    = db.prepare("SELECT COUNT(DISTINCT username) as n FROM sessions UNION SELECT COUNT(DISTINCT username) FROM consents UNION SELECT COUNT(DISTINCT username) FROM strategy_rules").all().length;
  const uniqueUsers   = (db.prepare("SELECT username FROM sessions UNION SELECT username FROM consents UNION SELECT username FROM strategy_rules").all() as Array<{username:string}>);
  const allUsers      = [...new Set(uniqueUsers.map(r => r.username))].length;
  const active24h     = count("SELECT COUNT(DISTINCT username) as n FROM sessions WHERE created_at >= datetime('now', '-1 day')");
  const active7d      = count("SELECT COUNT(DISTINCT username) as n FROM sessions WHERE created_at >= datetime('now', '-7 days')");
  const newUsers24h   = count("SELECT COUNT(DISTINCT s.username) as n FROM (SELECT username, MIN(created_at) as first FROM sessions GROUP BY username) s WHERE s.first >= datetime('now', '-1 day')");
  const newUsers7d    = count("SELECT COUNT(DISTINCT s.username) as n FROM (SELECT username, MIN(created_at) as first FROM sessions GROUP BY username) s WHERE s.first >= datetime('now', '-7 days')");

  // Votes
  const votesToday     = count("SELECT COUNT(*) as n FROM audit_events WHERE type='vote_broadcast_attempt' AND created_at >= datetime('now','start of day')");
  const votesSuccess   = count("SELECT COUNT(*) as n FROM audit_events WHERE type='vote_broadcast_success' AND created_at >= datetime('now','start of day')");
  const votesBlocked   = count("SELECT COUNT(*) as n FROM audit_events WHERE type='vote_broadcast_blocked' AND created_at >= datetime('now','start of day')");
  const totalVotesAll  = count("SELECT COUNT(*) as n FROM audit_events WHERE type='vote_broadcast_success'");
  const totalBlockedAll= count("SELECT COUNT(*) as n FROM audit_events WHERE type='vote_broadcast_blocked'");

  // Content
  const publishedPosts = count("SELECT COUNT(*) as n FROM content_drafts WHERE status='published'");
  const openDrafts     = count("SELECT COUNT(*) as n FROM content_drafts WHERE status IN ('draft','reviewed','approved','scheduled')");
  const failedDrafts   = count("SELECT COUNT(*) as n FROM content_drafts WHERE status='failed'");

  // Last fee post
  const lastFeePost = getLastFeePostRun();

  // System status
  const hasWif         = Boolean(broadcastConfig.postingWif);
  const dbOk           = (() => { try { db.prepare("SELECT 1").get(); return true; } catch { return false; } })();
  const systemStatus   = dbOk && hasWif ? "ok" : "degraded";

  return {
    users: { total: allUsers, active24h, active7d, newUsers24h, newUsers7d },
    votes: { today: votesToday, successToday: votesSuccess, blockedToday: votesBlocked, totalSuccess: totalVotesAll, totalBlocked: totalBlockedAll },
    content: { published: publishedPosts, openDrafts, failed: failedDrafts },
    feePost: { lastStatus: lastFeePost?.status ?? "never_run", lastDate: lastFeePost?.dateStr ?? null },
    system: { status: systemStatus, hasWif, dbOk }
  };
}

// ── Analytics (14-day time series) ───────────────────────────────────────────

function getAnalytics() {
  const db = getDb();

  type DayVoteRow  = { day: string; total: number; success: number; blocked: number };
  type DayUserRow  = { day: string; new_users: number };
  type DayFeeRow   = { day: string; status: string };

  const votesByDay = db.prepare(`
    SELECT date(created_at) as day,
           COUNT(*) as total,
           SUM(CASE WHEN type LIKE '%_success' THEN 1 ELSE 0 END) as success,
           SUM(CASE WHEN type LIKE '%_blocked' THEN 1 ELSE 0 END) as blocked
    FROM audit_events
    WHERE created_at >= datetime('now', '-14 days')
    GROUP BY day ORDER BY day ASC
  `).all() as DayVoteRow[];

  const usersByDay = db.prepare(`
    SELECT date(first_seen) as day, COUNT(*) as new_users
    FROM (SELECT username, MIN(created_at) as first_seen FROM sessions GROUP BY username)
    WHERE first_seen >= datetime('now', '-14 days')
    GROUP BY day ORDER BY day ASC
  `).all() as DayUserRow[];

  const feePostByDay = db.prepare(`
    SELECT date_str as day, status FROM fee_post_log
    WHERE executed_at >= datetime('now', '-14 days')
    ORDER BY executed_at ASC
  `).all() as DayFeeRow[];

  return { votesByDay, usersByDay, feePostByDay };
}

// ── Recent broadcasts ─────────────────────────────────────────────────────────

function getRecentBroadcasts(limit = 30) {
  type BroadcastRow = {
    id: string; type: string; username: string; author: string | null;
    permlink: string | null; weight_bps: number | null; detail: string | null;
    transaction_id: string | null; created_at: string;
  };
  const rows = getDb().prepare(`
    SELECT * FROM audit_events
    WHERE type LIKE 'vote_broadcast%'
    ORDER BY created_at DESC LIMIT ?
  `).all(limit) as BroadcastRow[];

  return rows.map(r => ({
    id:            r.id,
    type:          r.type,
    username:      r.username,
    author:        r.author,
    permlink:      r.permlink,
    weightBps:     r.weight_bps,
    detail:        r.detail,
    transactionId: r.transaction_id,
    createdAt:     r.created_at,
    status:        r.type.endsWith("_success") ? "success"
                 : r.type.endsWith("_blocked") ? "blocked"
                 : "attempt",
  }));
}

// ── Steem node health ─────────────────────────────────────────────────────────

async function checkSteemNode(): Promise<{ status: "ok" | "slow" | "down"; pingMs: number; block?: number }> {
  const start = Date.now();
  try {
    const client = createSteemClient();
    const props = await client.database.getDynamicGlobalProperties();
    const pingMs = Date.now() - start;
    return { status: pingMs < 2000 ? "ok" : "slow", pingMs, block: props.head_block_number };
  } catch {
    return { status: "down", pingMs: -1 };
  }
}

// ── Notifications ─────────────────────────────────────────────────────────────
function getNotifications() {
  const db = getDb();

  type RecentSessionRow = { username: string; created_at: string };
  const recentLogins = db.prepare(`
    SELECT username, created_at FROM sessions
    WHERE created_at >= datetime('now', '-24 hours')
    ORDER BY created_at DESC LIMIT 20
  `).all() as RecentSessionRow[];

  type RecentConsentRow = { username: string; type: string; status: string; created_at: string };
  const recentConsents = db.prepare(`
    SELECT username, type, status, created_at FROM consents
    WHERE created_at >= datetime('now', '-24 hours')
    ORDER BY created_at DESC LIMIT 20
  `).all() as RecentConsentRow[];

  const recentEvents = getRecentAuditEvents(20);
  const failedEvents = recentEvents.filter(e => e.type.includes("_blocked"));

  const notifications = [
    ...recentLogins.map(r => ({
      type: "login" as const,
      message: `@${r.username} logged in`,
      timestamp: r.created_at,
      severity: "info" as const
    })),
    ...recentConsents.map(r => ({
      type: "consent" as const,
      message: `@${r.username} ${r.status === "granted" ? "granted" : "revoked"} ${r.type}`,
      timestamp: r.created_at,
      severity: "info" as const
    })),
    ...failedEvents.map(e => ({
      type: "vote_blocked" as const,
      message: `Vote blocked for @${e.username}: ${e.detail}`,
      timestamp: e.createdAt,
      severity: "warning" as const
    }))
  ].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 30);

  return { notifications, count: notifications.length };
}

// ── Route registration ────────────────────────────────────────────────────────
export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {

  // All admin routes require owner session
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/admin")) return;
    const admin = requireAdmin(request);
    if (!admin) {
      await reply.code(403).send({ error: "admin_access_required" });
    }
  });

  app.get("/api/admin/overview",      { schema: { tags: ["Admin"] } }, async () => getPlatformOverview());
  app.get("/api/admin/users",         { schema: { tags: ["Admin"] } }, async () => getUserAnalytics());
  app.get("/api/admin/health",        { schema: { tags: ["Admin"] } }, async () => getSystemHealth());
  app.get("/api/admin/insights",      { schema: { tags: ["Admin"] } }, async () => getPlatformInsights());
  app.get("/api/admin/notifications", { schema: { tags: ["Admin"] } }, async () => getNotifications());
  app.get("/api/admin/kpis",          { schema: { tags: ["Admin"] } }, async () => getKpis());
  app.get("/api/admin/analytics",     { schema: { tags: ["Admin"] } }, async () => getAnalytics());
  app.get("/api/admin/broadcasts",    { schema: { tags: ["Admin"] } }, async () => ({ broadcasts: getRecentBroadcasts() }));

  // Manual fee post trigger — optional body: { date: "YYYY-MM-DD", forceUpdate: true }
  app.post("/api/admin/fee-post/trigger", { schema: { tags: ["Admin"], summary: "Fee-Post manuell triggern" } }, async (request, reply) => {
    try {
      const body  = (request.body ?? {}) as { date?: string; forceUpdate?: boolean };
      const dateStr = typeof body.date === "string" && body.date.length > 0 ? body.date : undefined;
      const forceUpdate = body.forceUpdate === true;
      return await triggerFeePostNow(dateStr, forceUpdate);
    }
    catch (err) { return reply.code(500).send({ error: "trigger_failed", detail: err instanceof Error ? err.message : String(err) }); }
  });

  // Full cockpit — one call loads everything for the dashboard
  app.get("/api/admin/cockpit", { schema: { tags: ["Admin"], summary: "Vollständiges Admin-Cockpit (ein Call)" } }, async () => {
    const [steemNode] = await Promise.allSettled([checkSteemNode()]);
    const steemStatus = steemNode.status === "fulfilled" ? steemNode.value : { status: "down" as const, pingMs: -1 };
    return {
      kpis:          getKpis(),
      health:        { ...getSystemHealth(), steemNode: steemStatus, hasWif: Boolean(broadcastConfig.postingWif), nodeUrl: steemNetworkConfig.nodeUrl },
      users:         getUserAnalytics(),
      broadcasts:    getRecentBroadcasts(20),
      analytics:     getAnalytics(),
      feePostLog:    getRecentFeePostLog(10),
      notifications: getNotifications(),
      contentQueue:  (() => {
        type DraftRow2 = { filename: string; status: string; title: string | null; publish_tx_id: string | null; published_permlink: string | null; scheduled_for: string | null; updated_at: string; failed_reason: string | null };
        return (getDb().prepare("SELECT filename, status, title, publish_tx_id, published_permlink, scheduled_for, updated_at, failed_reason FROM content_drafts ORDER BY updated_at DESC").all() as DraftRow2[]);
      })(),
    };
  });

  // Aggregate: legacy all call
  app.get("/api/admin/all", { schema: { tags: ["Admin"], summary: "Alle Admin-Daten aggregiert (legacy)" } }, async () => ({
    overview:      getPlatformOverview(),
    health:        getSystemHealth(),
    users:         getUserAnalytics(),
    insights:      getPlatformInsights(),
    notifications: getNotifications()
  }));
}
