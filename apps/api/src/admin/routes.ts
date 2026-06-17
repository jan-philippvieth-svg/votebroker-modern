import os from "os";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getSession } from "../auth/sessionStore.js";
import { getDb } from "../db/index.js";
import { getAuditStats, getRecentAuditEvents } from "../audit/auditLog.js";
import { getRecentFeePostLog, getLastFeePostRun, runDailyFeePost } from "../jobs/dailyFeePost.js";
import { broadcastConfig, steemNetworkConfig } from "../config.js";
import { todayBoundsUtc } from "../utils/timezone.js";
import { createSteemClient } from "../chain/steemBroadcaster.js";
import { getPostCacheMetrics, resetPostCacheMetrics } from "../chain/postCache.js";
import { getPostScannerStats } from "../jobs/postScannerJob.js";
import { getShadowScannerStats } from "../jobs/copilotShadowJob.js";
import { getOpportunityScannerStats } from "../jobs/opportunityRefreshJob.js";

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

  // New users: first session today (Europe/Berlin calendar day)
  const { startIso: todayStart, endIso: todayEnd } = todayBoundsUtc();
  const newUsersToday = count(`
    SELECT COUNT(DISTINCT s1.username) as n FROM sessions s1
    WHERE s1.created_at >= ? AND s1.created_at < ?
    AND NOT EXISTS (
      SELECT 1 FROM sessions s2
      WHERE s2.username = s1.username AND s2.created_at < ?
    )
  `, todayStart, todayEnd, todayStart);

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
    SELECT username, MAX(created_at) as last_seen
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

  // Votes (Europe/Berlin calendar day)
  const { startIso: voteStart, endIso: voteEnd } = todayBoundsUtc();
  const votesToday     = count("SELECT COUNT(*) as n FROM audit_events WHERE type='vote_broadcast_attempt' AND created_at >= ? AND created_at < ?", voteStart, voteEnd);
  const votesSuccess   = count("SELECT COUNT(*) as n FROM audit_events WHERE type='vote_broadcast_success' AND created_at >= ? AND created_at < ?", voteStart, voteEnd);
  const votesBlocked   = count("SELECT COUNT(*) as n FROM audit_events WHERE type='vote_broadcast_blocked' AND created_at >= ? AND created_at < ?", voteStart, voteEnd);
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

// ── Shadow Outcome Analysis ───────────────────────────────────────────────────

function getShadowOutcomes(goodPayoutThreshold: number, goodVoteThreshold: number) {
  const db = getDb();

  // Overall resolution status
  type StatusRow = { outcome_status: string; n: number };
  const statusRows = db.prepare(`
    SELECT outcome_status, COUNT(*) as n
    FROM vb_copilot_shadow_runs
    WHERE decision IN ('would_vote', 'skip_score', 'skip_budget')
      AND author IS NOT NULL AND permlink IS NOT NULL
    GROUP BY outcome_status
  `).all() as StatusRow[];

  const statusMap = Object.fromEntries(statusRows.map(r => [r.outcome_status, r.n]));
  const totalResolved   = statusMap["resolved"]         ?? 0;
  const totalMissing    = statusMap["content_missing"]  ?? 0;
  const totalError      = statusMap["error"]            ?? 0;
  const totalUnresolved = statusMap["unresolved"]       ?? 0;

  // Confusion matrix — only for resolved rows
  // A post is "good" when its payout >= threshold OR its vote count >= threshold
  type MatrixRow = {
    decision: string;
    good_payout: number; // 1 if payout >= threshold, else 0
    n: number;
  };
  const matrixRows = db.prepare(`
    SELECT
      decision,
      CASE WHEN resolved_payout_sbd >= @payout THEN 1 ELSE 0 END AS good_payout,
      COUNT(*) AS n
    FROM vb_copilot_shadow_runs
    WHERE outcome_status = 'resolved'
      AND decision IN ('would_vote', 'skip_score', 'skip_budget')
      AND author IS NOT NULL AND permlink IS NOT NULL
    GROUP BY decision, good_payout
  `).all({ payout: goodPayoutThreshold }) as MatrixRow[];

  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of matrixRows) {
    const isGood     = r.good_payout === 1;
    const isVote     = r.decision === "would_vote";
    const isSkip     = r.decision === "skip_score" || r.decision === "skip_budget";
    if (isVote && isGood)  tp += r.n;
    if (isVote && !isGood) fp += r.n;
    if (isSkip && isGood)  fn += r.n;
    if (isSkip && !isGood) tn += r.n;
  }

  const precision = (tp + fp) > 0 ? Math.round((tp / (tp + fp)) * 10000) / 100 : null;
  const recall    = (tp + fn) > 0 ? Math.round((tp / (tp + fn)) * 10000) / 100 : null;
  const f1        = precision !== null && recall !== null && (precision + recall) > 0
    ? Math.round((2 * precision * recall / (precision + recall)) * 100) / 100
    : null;

  // Best missed posts (False Negatives: skip + good payout)
  type MissedRow = {
    author: string; permlink: string; title: string | null;
    decision: string; category: string | null;
    run_at: string; post_score: number | null;
    resolved_payout_sbd: number; resolved_vote_count: number | null;
  };
  const bestMissed = db.prepare(`
    SELECT author, permlink, title, decision, category, run_at, post_score,
           resolved_payout_sbd, resolved_vote_count
    FROM vb_copilot_shadow_runs
    WHERE outcome_status = 'resolved'
      AND decision IN ('skip_score', 'skip_budget')
      AND resolved_payout_sbd >= @payout
    ORDER BY resolved_payout_sbd DESC
    LIMIT 10
  `).all({ payout: goodPayoutThreshold }) as MissedRow[];

  // Average payouts by decision type (for calibration insight)
  type AvgRow = { decision: string; avg_payout: number | null; median_payout: number | null; n: number };
  const avgByDecision = db.prepare(`
    SELECT decision,
           AVG(resolved_payout_sbd) as avg_payout,
           COUNT(*) as n
    FROM vb_copilot_shadow_runs
    WHERE outcome_status = 'resolved'
      AND decision IN ('would_vote', 'skip_score', 'skip_budget')
    GROUP BY decision
  `).all() as AvgRow[];

  return {
    thresholds: { goodPayoutThreshold, goodVoteThreshold },
    resolution: {
      resolved:  totalResolved,
      missing:   totalMissing,
      error:     totalError,
      unresolved: totalUnresolved,
    },
    confusionMatrix: { tp, fp, fn, tn },
    metrics: { precision, recall, f1 },
    missedOpportunities: fn,
    bestMissed: bestMissed.map(r => ({
      author:            r.author,
      permlink:          r.permlink,
      title:             r.title,
      decision:          r.decision,
      category:          r.category,
      runAt:             r.run_at,
      postScore:         r.post_score,
      resolvedPayoutSbd: r.resolved_payout_sbd,
      resolvedVoteCount: r.resolved_vote_count,
      steemitUrl:        `https://steemit.com/@${r.author}/${r.permlink}`,
    })),
    avgByDecision: Object.fromEntries(
      avgByDecision.map(r => [r.decision, { avgPayout: r.avg_payout !== null ? Math.round(r.avg_payout * 1000) / 1000 : null, n: r.n }])
    ),
  };
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

  // ── Signal Layer admin endpoints ────────────────────────────────────────────

  app.get("/api/admin/signal-status", { schema: { tags: ["Admin"], summary: "Signal Layer Datenstatus" } }, async (request, reply) => {
    if (!requireAdmin(request)) return reply.code(403).send({ error: "forbidden" });
    const db = getDb();
    const wvd = db.prepare(`
      SELECT
        COUNT(*)                                              AS total,
        SUM(CASE WHEN enriched_at IS NOT NULL THEN 1 ELSE 0 END) AS enriched,
        SUM(CASE WHEN enriched_at IS NULL     THEN 1 ELSE 0 END) AS pending,
        MIN(voted_at) AS oldest_vote,
        MAX(voted_at) AS newest_vote
      FROM vb_whale_vote_details
    `).get() as { total: number; enriched: number; pending: number; oldest_vote: string; newest_vote: string };

    const authors    = (db.prepare("SELECT COUNT(*) AS n FROM vb_signal_author").get()    as { n: number })?.n ?? 0;
    const communities = (db.prepare("SELECT COUNT(*) AS n FROM vb_signal_community").get() as { n: number })?.n ?? 0;
    const lastComputed = (db.prepare("SELECT MAX(computed_at) AS v FROM vb_signal_author").get() as { v: string | null })?.v;

    return {
      whale_vote_details: {
        total:       wvd.total,
        enriched:    wvd.enriched,
        pending:     wvd.pending,
        oldest_vote: wvd.oldest_vote,
        newest_vote: wvd.newest_vote,
        enrichment_rate: wvd.total > 0 ? Math.round((wvd.enriched / wvd.total) * 1000) / 10 : 0,
      },
      signals: {
        authors,
        communities,
        last_computed: lastComputed ?? null,
      },
    };
  });

  app.post("/api/admin/signal-scan", { schema: { tags: ["Admin"], summary: "Whale History Scan + Enrichment + Signal Compute triggern" } }, async (request, reply) => {
    if (!requireAdmin(request)) return reply.code(403).send({ error: "forbidden" });

    // Fire-and-forget — returns immediately, jobs run in background
    import("../chain/whaleHistoryScanner.js").then(({ scanWhaleHistory }) =>
      scanWhaleHistory(console).catch(e => console.warn("[WhaleHistory] triggered scan error:", e))
    ).catch(() => {});

    import("../jobs/whaleEnrichment.js").then(({ runWhaleEnrichment }) =>
      runWhaleEnrichment(500, console).catch(e => console.warn("[WhaleEnrich] triggered error:", e))
    ).catch(() => {});

    import("../jobs/signalCompute.js").then(({ runSignalCompute }) =>
      runSignalCompute(console).catch(e => console.warn("[SignalCompute] triggered error:", e))
    ).catch(() => {});

    import("../jobs/opportunityRefreshJob.js").then(({ runOpportunityRefresh }) =>
      runOpportunityRefresh(console).catch(e => console.warn("[OpportunityRefresh] triggered error:", e))
    ).catch(() => {});

    return { status: "started", message: "Whale scan + enrichment + signal compute + opportunity refresh running in background" };
  });

  app.post("/api/admin/opportunity-refresh", { schema: { tags: ["Admin"], summary: "Opportunity Cache manuell neu befüllen" } }, async (request, reply) => {
    if (!requireAdmin(request)) return reply.code(403).send({ error: "forbidden" });
    import("../jobs/opportunityRefreshJob.js").then(({ runOpportunityRefresh }) =>
      runOpportunityRefresh(console)
        .then(r => console.info("[OpportunityRefresh] manual run result:", r))
        .catch(e => console.warn("[OpportunityRefresh] manual error:", e))
    ).catch(() => {});
    return { status: "started", message: "Opportunity refresh running in background" };
  });

  app.get("/api/admin/signal-authors", { schema: { tags: ["Admin"], summary: "Top Autoren nach Signal Layer Score" } }, async (request, reply) => {
    if (!requireAdmin(request)) return reply.code(403).send({ error: "forbidden" });
    const db  = getDb();
    const rows = db.prepare(`
      SELECT author, whale_count, whale_follow_rate, avg_payout_sbd, median_payout_sbd,
             p25_delay_min, p50_delay_min, p75_delay_min, optimal_window,
             sample_posts, top_whales, computed_at
      FROM vb_signal_author
      ORDER BY whale_count DESC, avg_payout_sbd DESC
      LIMIT 100
    `).all();
    return { authors: rows };
  });

  app.get("/api/admin/signal-communities", { schema: { tags: ["Admin"], summary: "Communities nach Signal Layer Score" } }, async (request, reply) => {
    if (!requireAdmin(request)) return reply.code(403).send({ error: "forbidden" });
    const db   = getDb();
    const rows = db.prepare(`
      SELECT community, avg_payout_sbd, median_payout_sbd, avg_curator_sbd,
             whale_activity, posts_sampled, computed_at
      FROM vb_signal_community
      ORDER BY avg_payout_sbd DESC
      LIMIT 100
    `).all();
    return { communities: rows };
  });

  // ── Shadow Outcome Analysis ─────────────────────────────────────────────────

  app.get("/api/admin/shadow-outcomes", {
    schema: { tags: ["Admin"], summary: "CoPilot Shadow-Entscheidungsqualität (Confusion Matrix)" }
  }, async (request, reply) => {
    if (!requireAdmin(request)) return reply.code(403).send({ error: "forbidden" });

    const query = (request.query ?? {}) as Record<string, string>;
    const goodPayoutThreshold = parseFloat(query.good_payout_threshold_sbd ?? "1.0") || 1.0;
    const goodVoteThreshold   = parseInt(query.good_vote_count_threshold    ?? "5",  10) || 5;

    return getShadowOutcomes(goodPayoutThreshold, goodVoteThreshold);
  });

  app.post("/api/admin/shadow-outcomes/resolve-now", {
    schema: { tags: ["Admin"], summary: "Shadow Outcome Resolver manuell triggern" }
  }, async (request, reply) => {
    if (!requireAdmin(request)) return reply.code(403).send({ error: "forbidden" });
    import("../jobs/shadowOutcomeResolverJob.js").then(({ runShadowOutcomeResolver }) =>
      runShadowOutcomeResolver(console).catch(e => console.warn("[ShadowResolver] triggered error:", e))
    ).catch(() => {});
    return { status: "started", message: "Shadow outcome resolver running in background" };
  });

  // ── Post cache metrics ────────────────────────────────────────────────────────

  app.get("/api/admin/post-cache-metrics", {
    schema: { tags: ["Admin"], summary: "Shared post-cache hit/miss/age Metriken seit Start" }
  }, async (request, reply) => {
    if (!requireAdmin(request)) return reply.code(403).send({ error: "forbidden" });
    return getPostCacheMetrics();
  });

  app.post("/api/admin/post-cache-metrics/reset", {
    schema: { tags: ["Admin"], summary: "Post-cache Metriken zurücksetzen (Cache-Einträge bleiben)" }
  }, async (request, reply) => {
    if (!requireAdmin(request)) return reply.code(403).send({ error: "forbidden" });
    resetPostCacheMetrics();
    return { status: "reset", metrics: getPostCacheMetrics() };
  });

  // ── System resource metrics ─────────────────────────────────────────────────

  app.get("/api/admin/system-metrics", {
    schema: { tags: ["Admin"], summary: "CPU, RAM, Scanner-Laufzeiten, RPC-Metriken, Daten-Zähler" }
  }, async (request, reply) => {
    if (!requireAdmin(request)) return reply.code(403).send({ error: "forbidden" });

    const mem      = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem  = os.freemem();
    const load     = os.loadavg();
    const cpus     = os.cpus();
    const db       = getDb();
    const cm       = getPostCacheMetrics();

    // Data counters from SQLite
    const authorCount = (db.prepare("SELECT COUNT(*) AS n FROM vb_post_scan_log").get() as { n: number })?.n ?? 0;
    const postCount   = (db.prepare("SELECT COUNT(*) AS n FROM vb_posts").get() as { n: number })?.n ?? 0;
    const eligibleCount = (db.prepare("SELECT COUNT(*) AS n FROM vb_opportunity_cache WHERE cached_at >= datetime('now', '-2 hours')").get() as { n: number })?.n ?? 0;
    const wouldVoteToday = (db.prepare(`
      SELECT COUNT(*) AS n FROM vb_copilot_shadow_runs
      WHERE decision = 'would_vote' AND run_at >= datetime('now', '-24 hours')
    `).get() as { n: number })?.n ?? 0;

    // RPC calls/min: postCache misses / uptime in minutes
    const uptimeMin = process.uptime() / 60;
    const rpcCallsPerMin = uptimeMin > 0
      ? Math.round((cm.misses / uptimeMin) * 10) / 10
      : 0;

    return {
      system: {
        cpu: {
          loadAvg1:  Math.round(load[0] * 100) / 100,
          loadAvg5:  Math.round(load[1] * 100) / 100,
          loadAvg15: Math.round(load[2] * 100) / 100,
          cpuCount:  cpus.length,
          loadPct1:  Math.round((load[0] / cpus.length) * 1000) / 10,
        },
        memory: {
          rssMb:       Math.round(mem.rss         / 1024 / 1024),
          heapUsedMb:  Math.round(mem.heapUsed    / 1024 / 1024),
          heapTotalMb: Math.round(mem.heapTotal   / 1024 / 1024),
          totalMb:     Math.round(totalMem        / 1024 / 1024),
          freeMb:      Math.round(freeMem         / 1024 / 1024),
          usedPct:     Math.round((1 - freeMem / totalMem) * 1000) / 10,
        },
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion:   process.version,
      },
      scanner: {
        postScanner:        getPostScannerStats(),
        shadowScanner:      getShadowScannerStats(),
        opportunityScanner: getOpportunityScannerStats(),
      },
      blockchain: {
        rpcCallsPerMin,
        cacheHitRate:  cm.hitRatePct,
        cacheMissRate: cm.hits + cm.misses > 0
          ? Math.round((cm.misses / (cm.hits + cm.misses)) * 1000) / 10
          : 0,
        cacheHits:     cm.hits,
        cacheMisses:   cm.misses,
        avgCacheAgeMs: cm.avgHitAgeMs,
      },
      data: {
        authorCount,
        postCount,
        eligibleCount,
        wouldVoteToday,
      },
    };
  });
}
