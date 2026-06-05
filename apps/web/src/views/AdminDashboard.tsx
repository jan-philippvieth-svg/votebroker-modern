import { useEffect, useRef, useState } from "react";
import {
  captureScreenshots, ContentValidationError, deleteDraft, editDraftContent, fixScreenshotUrls,
  generateDevlogContent, generatePromoPost, getAdminCockpit, getContentDrafts, getContentPreview,
  injectScreenshots, listScreenshots, publishDraft, triggerFeePost, updateDraftStatus,
  type AdminCockpit, type AuthSession, type BroadcastEntry,
  type ContentDraft, type ContentListResponse, type ContentQueueItem,
  type DraftStatus, type FeePostLogEntry, type PromoLocale, type PublishResult, type ScreenshotFile,
  PROMO_LOCALES,
} from "../api";

export const ADMIN_USERNAME = "jan-philippvieth";
export function isAdmin(session: AuthSession | null): boolean {
  return session?.user.username === ADMIN_USERNAME;
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = { ok: "#16a34a", warn: "#d97706", err: "#dc2626", info: "#2563eb", purple: "#7c3aed", dim: "#607078", bg1: "#f4f7f8", bg2: "#ffffff", border: "#dde8ed", text: "#17202a" };
const card: React.CSSProperties = { background: C.bg2, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "1rem 1.25rem", boxShadow: "0 2px 8px rgba(17,37,45,0.06)" };
const lbl: React.CSSProperties  = { color: C.dim, fontSize: "0.71rem", textTransform: "uppercase" as const, letterSpacing: "0.5px", fontWeight: 600 };
const tagStyle = (col: string): React.CSSProperties => ({ background: col + "22", color: col, border: `1px solid ${col}55`, borderRadius: "4px", padding: "0.05rem 0.4rem", fontSize: "0.68rem", fontWeight: 600, whiteSpace: "nowrap" as const });
const btnStyle = (col = C.border): React.CSSProperties => ({ background: col + "22", border: `1px solid ${col}`, borderRadius: "5px", color: col === C.border ? C.dim : col, cursor: "pointer" as const, fontSize: "0.77rem", padding: "0.25rem 0.6rem", fontWeight: 500 });

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtAge(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60)   return `${m}m ago`;
  if (m < 1440) return `${Math.round(m/60)}h ago`;
  return `${Math.round(m/1440)}d ago`;
}
function fmtUptime(s: number): string {
  const h = Math.floor(s/3600), mi = Math.floor((s%3600)/60);
  return h > 0 ? `${h}h ${mi}m` : `${mi}m`;
}
function shortTx(tx: string | null): string { return tx ? tx.slice(0,8)+"…"+tx.slice(-4) : "—"; }
function steemitUrl(author: string, permlink: string): string { return `https://steemit.com/@${author}/${permlink}`; }

// ── Sparkline SVG ─────────────────────────────────────────────────────────────
function Sparkline({ data, color = C.info, height = 28, width = 72 }: { data: number[]; color?: string; height?: number; width?: number }) {
  if (!data || data.length < 2) return <span style={{ color: C.border, fontSize: "0.7rem" }}>—</span>;
  const max = Math.max(...data, 1), min = Math.min(...data, 0), range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <svg width={width} height={height} style={{ overflow: "visible", display: "block" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────
function Badge({ status }: { status: string }) {
  const col = status === "success" || status === "published" || status === "ok" ? C.ok
    : status === "blocked" || status === "failed" || status === "down" ? C.err
    : status === "skipped" || status === "scheduled" || status === "slow" ? C.warn
    : status === "reviewed" || status === "approved" ? C.info
    : C.dim;
  return <span style={tagStyle(col)}>{status}</span>;
}

// ── KPI Card ──────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, color = C.info, trend, onClick }: {
  label: string; value: string | number; sub?: string; color?: string; trend?: number[]; onClick?: () => void;
}) {
  return (
    <div style={{ ...card, cursor: onClick ? "pointer" : "default", minWidth: "130px", flex: 1 }} onClick={onClick}>
      <p style={{ ...lbl, margin: "0 0 0.25rem" }}>{label}</p>
      <div style={{ color: C.text, fontSize: "1.5rem", fontWeight: 700, lineHeight: 1, marginBottom: "0.2rem" }}>{value}</div>
      {sub && <p style={{ color: C.dim, fontSize: "0.72rem", margin: 0 }}>{sub}</p>}
      {trend && trend.length > 1 && <div style={{ marginTop: "0.4rem" }}><Sparkline data={trend} color={color} height={24} /></div>}
    </div>
  );
}

// ── Broadcasts table ──────────────────────────────────────────────────────────
function BroadcastsTable({ rows }: { rows: BroadcastEntry[] }) {
  if (!rows.length) return <p style={{ color: C.border, fontSize: "0.82rem" }}>No broadcasts recorded yet.</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.77rem" }}>
        <thead>
          <tr style={{ color: C.dim, fontSize: "0.68rem", textTransform: "uppercase" as const }}>
            {["Status","Account","Author","Permlink","Weight","TX","Time"].map(h => (
              <th key={h} style={{ textAlign: "left", padding: "0.25rem 0.5rem", fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 25).map(r => (
            <tr key={r.id} style={{ borderTop: `1px solid ${C.border}` }}>
              <td style={{ padding: "0.3rem 0.5rem" }}><Badge status={r.status} /></td>
              <td style={{ padding: "0.3rem 0.5rem", color: C.info }}>@{r.username}</td>
              <td style={{ padding: "0.3rem 0.5rem", color: C.dim }}>{r.author ? `@${r.author}` : "—"}</td>
              <td style={{ padding: "0.3rem 0.5rem", maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                {r.author && r.permlink ? (
                  <a href={steemitUrl(r.author, r.permlink)} target="_blank" rel="noreferrer" style={{ color: C.info }}>{r.permlink.slice(0,30)}…</a>
                ) : <span style={{ color: C.border }}>—</span>}
              </td>
              <td style={{ padding: "0.3rem 0.5rem", color: C.text }}>{r.weightBps ? `${(r.weightBps/100).toFixed(1)}%` : "—"}</td>
              <td style={{ padding: "0.3rem 0.5rem", fontFamily: "monospace" }}>
                {r.transactionId ? (
                  <a href={`https://steemd.com/tx/${r.transactionId}`} target="_blank" rel="noreferrer" style={{ color: C.ok }}>{shortTx(r.transactionId)}</a>
                ) : r.status === "blocked" && r.detail ? (
                  <span style={{ color: C.err, maxWidth: "120px", display: "inline-block", overflow: "hidden", textOverflow: "ellipsis" }} title={r.detail}>
                    {r.detail.slice(0, 30)}…
                  </span>
                ) : <span style={{ color: C.border }}>—</span>}
              </td>
              <td style={{ padding: "0.3rem 0.5rem", color: C.dim, whiteSpace: "nowrap" as const }}>{fmtAge(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Content queue table ───────────────────────────────────────────────────────
function ContentQueueTable({ rows }: { rows: ContentQueueItem[] }) {
  if (!rows.length) return <p style={{ color: C.border, fontSize: "0.82rem" }}>No drafts yet. Run <code>npm run devlog:today</code>.</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.77rem" }}>
        <thead>
          <tr style={{ color: C.dim, fontSize: "0.68rem", textTransform: "uppercase" as const }}>
            {["Status","File","Title","Updated","TX / Notes"].map(h => (
              <th key={h} style={{ textAlign: "left", padding: "0.25rem 0.5rem", fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.filename} style={{ borderTop: `1px solid ${C.border}` }}>
              <td style={{ padding: "0.3rem 0.5rem" }}><Badge status={r.status} /></td>
              <td style={{ padding: "0.3rem 0.5rem", color: C.dim, fontSize: "0.7rem" }}>{r.filename.replace("2026-05-31-","")}</td>
              <td style={{ padding: "0.3rem 0.5rem", color: C.text, maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{r.title || "—"}</td>
              <td style={{ padding: "0.3rem 0.5rem", color: C.dim, whiteSpace: "nowrap" as const }}>{fmtAge(r.updated_at)}</td>
              <td style={{ padding: "0.3rem 0.5rem", fontSize: "0.7rem" }}>
                {r.publish_tx_id && r.published_permlink ? (
                  <a href={steemitUrl("votebroker", r.published_permlink)} target="_blank" rel="noreferrer" style={{ color: C.ok, fontFamily: "monospace" }}>{shortTx(r.publish_tx_id)}</a>
                ) : r.scheduled_for ? (
                  <span style={{ color: C.purple }}>📅 {new Date(r.scheduled_for).toLocaleString("en-GB", { timeZone: "UTC", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                ) : r.failed_reason ? (
                  <span style={{ color: C.err }} title={r.failed_reason}>✗ {r.failed_reason.slice(0,40)}</span>
                ) : <span style={{ color: C.border }}>—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Fee post log table ────────────────────────────────────────────────────────
function FeePostLogTable({ rows }: { rows: FeePostLogEntry[] }) {
  if (!rows.length) return <p style={{ color: C.border, fontSize: "0.82rem" }}>Scheduler started — first run at 01:00 UTC.</p>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.2rem" }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: "0.75rem", fontSize: "0.77rem" }}>
          <Badge status={r.status} />
          <span style={{ color: C.dim }}>{r.dateStr}</span>
          {r.permlink ? (
            <a href={steemitUrl("votebroker", r.permlink)} target="_blank" rel="noreferrer" style={{ color: C.info }}>@votebroker/{r.permlink.slice(-12)}</a>
          ) : <span style={{ color: C.border }}>—</span>}
          {r.error && <span style={{ color: C.err, fontSize: "0.7rem" }} title={r.error}>✗ {r.error.slice(0,50)}</span>}
          <span style={{ color: C.dim, marginLeft: "auto" }}>{fmtAge(r.executedAt)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Health card ───────────────────────────────────────────────────────────────
function HealthCard({ label, status, detail }: { label: string; status: "ok" | "warn" | "err" | "info"; detail: string }) {
  const col = { ok: C.ok, warn: C.warn, err: C.err, info: C.info }[status];
  const icon = { ok: "✓", warn: "⚠", err: "✗", info: "●" }[status];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.4rem 0.6rem", background: col + "11", border: `1px solid ${col}33`, borderRadius: "5px", fontSize: "0.78rem" }}>
      <span style={{ color: col, fontWeight: 700, fontSize: "0.85rem" }}>{icon}</span>
      <span style={{ color: C.text, fontWeight: 600, minWidth: "110px" }}>{label}</span>
      <span style={{ color: C.dim }}>{detail}</span>
    </div>
  );
}

// ── Mini bar chart (SVG) ──────────────────────────────────────────────────────
function BarChart({ data, colorFn, keyFn, valFn, label }: {
  data: unknown[]; colorFn: (d: unknown) => string; keyFn: (d: unknown) => string; valFn: (d: unknown) => number; label: string;
}) {
  if (!data.length) return <p style={{ color: C.border, fontSize: "0.77rem" }}>No data yet.</p>;
  const maxVal = Math.max(...data.map(d => valFn(d)), 1);
  return (
    <div>
      <p style={{ ...lbl, margin: "0 0 0.4rem" }}>{label}</p>
      <div style={{ display: "flex", alignItems: "flex-end", gap: "2px", height: "48px" }}>
        {data.slice(-14).map(d => {
          const h = Math.max(2, Math.round((valFn(d) / maxVal) * 44));
          return (
            <div key={keyFn(d)} title={`${keyFn(d)}: ${valFn(d)}`} style={{
              flex: 1, height: `${h}px`, background: colorFn(d), borderRadius: "2px 2px 0 0", minWidth: "4px"
            }} />
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: "2px", fontSize: "0.65rem", color: C.border }}>
        <span>{data.length > 0 ? keyFn(data[0]).slice(5) : ""}</span>
        <span>{data.length > 0 ? keyFn(data[data.length-1]).slice(5) : ""}</span>
      </div>
    </div>
  );
}

// ── Users table ───────────────────────────────────────────────────────────────
function UsersTable({ users }: { users: AdminCockpit["users"]["users"] }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.77rem" }}>
        <thead>
          <tr style={{ color: C.dim, fontSize: "0.68rem", textTransform: "uppercase" as const }}>
            {["User","Last seen","Consents","Strategy","Role"].map(h => (
              <th key={h} style={{ textAlign: "left", padding: "0.25rem 0.5rem", fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.map(u => (
            <tr key={u.username} style={{ borderTop: `1px solid ${C.border}` }}>
              <td style={{ padding: "0.3rem 0.5rem" }}>
                <span style={{ color: u.isAdmin ? C.warn : C.info, fontWeight: u.isAdmin ? 700 : 400 }}>@{u.username}</span>
              </td>
              <td style={{ padding: "0.3rem 0.5rem", color: C.dim, whiteSpace: "nowrap" as const }}>{fmtAge(u.lastSeen)}</td>
              <td style={{ padding: "0.3rem 0.5rem", color: C.text }}>{u.consentsGranted}</td>
              <td style={{ padding: "0.3rem 0.5rem" }}>
                {u.hasStrategy ? <span style={tagStyle(C.ok)}>✓ {u.strategyRules} rules</span> : <span style={{ color: C.border }}>—</span>}
              </td>
              <td style={{ padding: "0.3rem 0.5rem" }}>
                {u.isAdmin ? <span style={tagStyle(C.warn)}>Owner</span> : <span style={{ color: C.border }}>User</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Section panels ────────────────────────────────────────────────────────────

function OverviewSection({ d, session }: { d: AdminCockpit; session: AuthSession }) {
  const { kpis, analytics } = d;
  const voteSparkline = analytics.votesByDay.map(v => v.total);
  const successSparkline = analytics.votesByDay.map(v => v.success);
  const userSparkline = analytics.usersByDay.map(u => u.new_users);
  const successRate = kpis.votes.today > 0 ? Math.round(kpis.votes.successToday / kpis.votes.today * 100) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* KPI Row 1: Users */}
      <div>
        <p style={{ ...lbl, margin: "0 0 0.5rem" }}>Users</p>
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          <KpiCard label="Total Users" value={kpis.users.total} color={C.info} />
          <KpiCard label="Active 24h" value={kpis.users.active24h} color={C.ok} />
          <KpiCard label="Active 7d" value={kpis.users.active7d} color={C.ok} />
          <KpiCard label="New 24h" value={kpis.users.newUsers24h} trend={userSparkline} color={C.purple} />
          <KpiCard label="New 7d" value={kpis.users.newUsers7d} color={C.purple} />
        </div>
      </div>

      {/* KPI Row 2: Votes */}
      <div>
        <p style={{ ...lbl, margin: "0 0 0.5rem" }}>Votes Today</p>
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          <KpiCard label="Attempts" value={kpis.votes.today} trend={voteSparkline} color={C.info} />
          <KpiCard label="Success" value={kpis.votes.successToday} sub={`${successRate}% rate`} trend={successSparkline} color={C.ok} />
          <KpiCard label="Blocked" value={kpis.votes.blockedToday} color={kpis.votes.blockedToday > 0 ? C.err : C.dim} />
          <KpiCard label="All-Time Votes" value={kpis.votes.totalSuccess} sub={`${kpis.votes.totalBlocked} blocked total`} color={C.info} />
        </div>
      </div>

      {/* KPI Row 3: Content + System */}
      <div>
        <p style={{ ...lbl, margin: "0 0 0.5rem" }}>Content & System</p>
        <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
          <KpiCard label="Published Posts" value={kpis.content.published} color={C.ok} />
          <KpiCard label="Open Drafts" value={kpis.content.openDrafts} color={kpis.content.openDrafts > 0 ? C.warn : C.dim} />
          <KpiCard label="Last Fee Post" value={kpis.feePost.lastDate ?? "—"} sub={kpis.feePost.lastStatus} color={kpis.feePost.lastStatus === "failed" ? C.err : C.ok} />
          <KpiCard label="System" value={kpis.system.status.toUpperCase()} color={kpis.system.status === "ok" ? C.ok : C.err} />
        </div>
      </div>

      {/* Charts row */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.75rem" }}>
        <div style={card}>
          <BarChart
            data={analytics.votesByDay}
            label="Votes per day (14d)"
            keyFn={d => (d as {day:string}).day}
            valFn={d => (d as {total:number}).total}
            colorFn={d => (d as {total:number}).total > 0 ? C.info + "aa" : C.border}
          />
        </div>
        <div style={card}>
          <BarChart
            data={analytics.votesByDay}
            label="Success vs Blocked"
            keyFn={d => (d as {day:string}).day}
            valFn={d => (d as {success:number}).success}
            colorFn={d => (d as {blocked:number}).blocked > (d as {success:number}).success ? C.err + "aa" : C.ok + "aa"}
          />
        </div>
        <div style={card}>
          <BarChart
            data={analytics.usersByDay}
            label="New users per day"
            keyFn={d => (d as {day:string}).day}
            valFn={d => (d as {new_users:number}).new_users}
            colorFn={() => C.purple + "aa"}
          />
        </div>
      </div>
    </div>
  );
}

function VotesSection({ broadcasts }: { broadcasts: BroadcastEntry[] }) {
  const successCount  = broadcasts.filter(b => b.status === "success").length;
  const blockedCount  = broadcasts.filter(b => b.status === "blocked").length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <div style={{ display: "flex", gap: "0.6rem" }}>
        <div style={{ ...card, flex: 1 }}>
          <p style={{ ...lbl, margin: "0 0 0.1rem" }}>Last {broadcasts.length} broadcasts</p>
          <p style={{ color: C.dim, fontSize: "0.77rem", margin: 0 }}>
            <span style={{ color: C.ok }}>{successCount} success</span> · <span style={{ color: C.err }}>{blockedCount} blocked</span>
          </p>
        </div>
      </div>
      <div style={card}><BroadcastsTable rows={broadcasts} /></div>
    </div>
  );
}

function SystemSection({ d, session }: { d: AdminCockpit; session: AuthSession }) {
  const { health, feePostLog } = d;
  const [triggering, setTriggering]     = useState(false);
  const [triggerMsg, setTriggerMsg]     = useState<string | null>(null);
  const [retroDate, setRetroDate]       = useState("");   // YYYY-MM-DD for retroactive publish

  async function doTrigger(dateStr?: string, forceUpdate?: boolean) {
    setTriggering(true); setTriggerMsg(null);
    try {
      const r = await triggerFeePost(session.token, dateStr, forceUpdate);
      setTriggerMsg(forceUpdate
        ? `✓ Updated: @votebroker/${r.permlink} (title fixed)`
        : r.alreadyExisted
          ? `✓ Already exists: @votebroker/${r.permlink}`
          : `✓ Published: @votebroker/${r.permlink}${dateStr ? ` (retroactive ${dateStr})` : ""}`);
      if (dateStr) setRetroDate("");
    } catch (e) { setTriggerMsg(`✗ ${e instanceof Error ? e.message : "failed"}`); }
    finally { setTriggering(false); }
  }

  const fp = (health as AdminCockpit["health"]).feePost;
  const steemNode = (health as AdminCockpit["health"]).steemNode;
  const hasWif = (health as AdminCockpit["health"]).hasWif;
  const nodeUrl = (health as AdminCockpit["health"]).nodeUrl;
  const nextRunUtc = fp ? new Date(fp.nextRunAt) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      {/* Health checks */}
      <div style={card}>
        <p style={{ ...lbl, margin: "0 0 0.6rem" }}>System Health</p>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
          <HealthCard label="API Server" status="ok" detail={`up ${fmtUptime(health.api.uptimeSeconds)} · ${health.api.memoryMb}MB RSS · ${health.api.nodeVersion}`} />
          <HealthCard label="SQLite DB" status={health.database.pingMs < 50 ? "ok" : "warn"} detail={`${health.database.pingMs}ms ping · ${health.database.activeSessions} active sessions`} />
          <HealthCard label="Posting WIF" status={hasWif ? "ok" : "err"} detail={hasWif ? "Configured — server-side voting enabled" : "MISSING — server-side voting disabled"} />
          <HealthCard label="Steem Node" status={steemNode?.status === "ok" ? "ok" : steemNode?.status === "slow" ? "warn" : "err"} detail={steemNode ? `${nodeUrl} · ${steemNode.pingMs < 0 ? "unreachable" : steemNode.pingMs + "ms"}${steemNode.block ? ` · block #${steemNode.block}` : ""}` : "not checked"} />
          <HealthCard label="Fee Scheduler" status="ok" detail={`Runs daily at 01:00 UTC${nextRunUtc ? ` · next: ${nextRunUtc.toLocaleString("en-GB",{timeZone:"UTC",month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit"})}` : ""}`} />
          <HealthCard label="Authority Cache" status="info" detail={`${health.database.authorityCacheEntries} entries cached`} />
          {health.warnings.map(w => <HealthCard key={w} label="Warning" status="warn" detail={w} />)}
        </div>
      </div>

      {/* Fee Post Scheduler */}
      <div style={card}>
        <div style={{ marginBottom: "0.75rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
            <div>
              <p style={{ ...lbl, margin: "0 0 0.15rem" }}>Daily Fee Settlement Post</p>
              <p style={{ color: C.dim, fontSize: "0.71rem", margin: 0 }}>
                Automated at 01:00 UTC · generates <code style={{ fontSize: "0.69rem" }}>daily-fees-YYYY-MM-DD</code> · title: "VoteBroker Fee Settlement — …"
              </p>
            </div>
            <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              {triggerMsg && <span style={{ color: triggerMsg.startsWith("✓") ? C.ok : C.err, fontSize: "0.77rem", maxWidth: "280px" }}>{triggerMsg}</span>}
              <button style={btnStyle(C.info)} type="button" disabled={triggering} onClick={() => void doTrigger()}>
                {triggering ? "Running…" : "Run today"}
              </button>
              <button style={{ ...btnStyle(C.warn), fontSize: "0.72rem" }} type="button" disabled={triggering} onClick={() => void doTrigger(undefined, true)} title="Re-broadcasts today's post with the correct title (VoteBroker Fee Settlement)">
                Fix title
              </button>
            </div>
          </div>
          {/* Retroactive publish row */}
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", paddingTop: "0.4rem", borderTop: `1px solid ${C.border}` }}>
            <span style={{ color: C.dim, fontSize: "0.71rem", whiteSpace: "nowrap" as const }}>Retroactive publish:</span>
            <input
              type="date"
              value={retroDate}
              onChange={e => setRetroDate(e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
              style={{ background: C.bg2, border: `1px solid ${C.border}`, borderRadius: "4px", color: C.text, fontSize: "0.75rem", padding: "0.2rem 0.4rem" }}
            />
            <button
              type="button"
              disabled={!retroDate || triggering}
              onClick={() => void doTrigger(retroDate)}
              style={{ ...btnStyle(C.warn), opacity: retroDate ? 1 : 0.4 }}
            >
              Publish for {retroDate || "…"}
            </button>
            <button
              type="button"
              disabled={!retroDate || triggering}
              onClick={() => void doTrigger(retroDate, true)}
              style={{ ...btnStyle(C.err), opacity: retroDate ? 1 : 0.4, fontSize: "0.72rem" }}
              title="Re-broadcasts the post for the selected date with the correct title"
            >
              Fix title for {retroDate || "…"}
            </button>
            <span style={{ color: C.dim, fontSize: "0.68rem" }}>Use this if the scheduler missed a day or published with wrong title</span>
          </div>
        </div>
        <FeePostLogTable rows={feePostLog} />
      </div>
    </div>
  );
}

// ── Authenticated image — fetches with session header, renders as blob URL ─────
function AuthenticatedImage({ url, token, alt, style, onClick }: {
  url: string; token: string; alt?: string;
  style?: React.CSSProperties; onClick?: () => void;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error,   setError]   = useState(false);
  const blobRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBlobUrl(null); setError(false);
    fetch(url, { headers: { session: token } })
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.blob(); })
      .then(blob => {
        if (cancelled) return;
        const obj = URL.createObjectURL(blob);
        blobRef.current = obj;
        setBlobUrl(obj);
      })
      .catch(() => { if (!cancelled) setError(true); });

    return () => {
      cancelled = true;
      if (blobRef.current) { URL.revokeObjectURL(blobRef.current); blobRef.current = null; }
    };
  }, [url, token]);

  if (error) {
    // Neutral placeholder — not a red error block. Shows filename for easy debugging.
    const filename = url.split("/").pop() ?? url;
    return (
      <div style={{ ...style, background: "#f8f9fa", border: "1px dashed #ced4da", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "0.25rem", padding: "0.5rem" }}>
        <span style={{ fontSize: "1.2rem" }}>🖼</span>
        <span style={{ fontSize: "0.68rem", color: "#6c757d", textAlign: "center" }}>Bild nicht verfügbar</span>
        <span style={{ fontSize: "0.6rem", color: "#adb5bd", textAlign: "center", wordBreak: "break-all" }}>{filename}</span>
      </div>
    );
  }
  if (!blobUrl) return <div style={{ ...style, background:"#f0f4f8", display:"flex", alignItems:"center", justifyContent:"center", fontSize:"0.7rem", color:"#aaa" }}>Lädt…</div>;
  return <img src={blobUrl} alt={alt ?? ""} style={style} onClick={onClick} />;
}

// ── Content section (reuses existing ContentSection logic) ────────────────────
function ContentSection({ session, queueItems }: { session: AuthSession; queueItems: ContentQueueItem[] }) {
  const [data, setData]       = useState<ContentListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ content: string; meta: Record<string, string> } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [screenshots, setScreenshots] = useState<ScreenshotFile[]>([]);
  const [showScreenshots, setShowScreenshots] = useState(false);
  const [promoLocale, setPromoLocale] = useState<PromoLocale>("en");
  const [promoStatus, setPromoStatus] = useState<string | null>(null);
  const [promoSnapSkipped, setPromoSnapSkipped] = useState<string | null>(null); // locale when snap was skipped

  const { getContentDrafts: gcd, getContentPreview: gcp, updateDraftStatus: uds, editDraftContent: edc, publishDraft: pd } = { getContentDrafts, getContentPreview, updateDraftStatus: updateDraftStatus, editDraftContent, publishDraft };

  async function load() { setLoading(true); try { setData(await gcd(session.token)); } finally { setLoading(false); } }

  useEffect(() => {
    void load();
    // Auto-refresh when window regains focus (user returns to tab)
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Today's date string YYYY-MM-DD (UTC)
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayDevlog  = data?.drafts.find(d => d.dateStr === todayStr && d.type === "devlog-post");
  const hasTodayDraft = !!todayDevlog;

  async function loadScreenshots() {
    const res = await listScreenshots(session.token);
    setScreenshots(res.files);
    return res;
  }

  async function doInjectScreenshots() {
    if (!selected) return;
    setSaving(true);
    setActionMsg("⏳ Binde Screenshots ein…");
    try {
      const res = await injectScreenshots(session.token, selected);
      if (res.replaced === 0) {
        setActionMsg(`ℹ ${res.hint ?? "Keine Platzhalter gefunden"}`);
      } else {
        setActionMsg(`✓ ${res.replaced} Screenshot-Platzhalter ersetzt`);
        await openPreview(selected);   // Vorschau neu laden
      }
    } catch (e) {
      setActionMsg(`✗ ${e instanceof Error ? e.message : "Fehler"}`);
    } finally { setSaving(false); }
  }

  async function doPromoGenerate() {
    setSaving(true);
    setPromoStatus(`⏳ Scanne Blockchain für ${PROMO_LOCALES.find(l => l.code === promoLocale)?.nativeName ?? promoLocale}…`);
    setPromoSnapSkipped(null);
    setActionMsg(null);
    try {
      const result = await generatePromoPost(session.token, promoLocale);
      if (result.screenshotSnap) {
        setPromoStatus(`✓ Draft erstellt: ${result.filename} · Screenshots: ${result.screenshotSnap}`);
        setPromoSnapSkipped(null);
      } else {
        setPromoStatus(`✓ Draft erstellt: ${result.filename}`);
        setPromoSnapSkipped(result.analysis.locale);
      }
      await load();
      setSelected(result.filename);
      await openPreview(result.filename);
    } catch (e) {
      setPromoStatus(`✗ ${e instanceof Error ? e.message : "Fehler"}`);
    } finally { setSaving(false); }
  }

  async function doGenerate(force: boolean, withScreenshots: boolean) {
    setSaving(true);
    setActionMsg(withScreenshots ? "⏳ Generiere Inhalt…" : "⏳ Generiere…");
    try {
      const dateStr = selected
        ? (data?.drafts.find(d => d.filename === selected)?.dateStr ?? undefined)
        : undefined;
      const result = await generateDevlogContent(session.token, { date: dateStr, force });
      setActionMsg(`✓ ${result.status === "updated" ? "Aktualisiert" : result.status === "created" ? "Erstellt" : "Übersprungen"}: ${result.filename}`);
      await load();
      // Refresh preview if same file was just generated/updated
      if (result.filename && (selected === result.filename || !selected)) {
        setSelected(result.filename);
        await openPreview(result.filename);
      }
      if (withScreenshots) {
        setActionMsg("⏳ Erstelle Screenshots…");
        const cap = await captureScreenshots(session.token);
        if (cap.status === "ok") {
          setActionMsg("⏳ Binde Screenshots ein…");
          if (result.filename) {
            try {
              const inj = await injectScreenshots(session.token, result.filename);
              setActionMsg(`✓ ${inj.replaced} Screenshots eingebunden`);
              await openPreview(result.filename);
            } catch { setActionMsg("✓ Screenshots erstellt · ⚠ Platzhalter-Ersatz fehlgeschlagen"); }
          }
        } else if (cap.status === "unavailable") {
          setActionMsg(`✓ Inhalt generiert · ℹ Screenshots: ${cap.message}`);
        } else {
          setActionMsg(`✓ Inhalt generiert · ✗ Screenshots: ${cap.message}`);
        }
      }
    } catch (e) {
      setActionMsg(`✗ ${e instanceof Error ? e.message : "Fehler"}`);
    } finally { setSaving(false); }
  }

  async function openPreview(fn: string) {
    setSelected(fn); setPreviewLoading(true); setEditMode(false); setActionMsg(null); setPublishResult(null);
    try { const p = await gcp(session.token, fn); setPreview(p); setEditContent(p.content); }
    catch { setPreview(null); } finally { setPreviewLoading(false); }
  }

  async function setStatus(fn: string, status: DraftStatus, opts?: { scheduledFor?: string; failedReason?: string }) {
    setSaving(true);
    try { await uds(session.token, fn, status, opts); setActionMsg(`✓ ${status}`); await load(); }
    catch (e) { setActionMsg(`✗ ${e instanceof Error ? e.message : "error"}`); }
    finally { setSaving(false); }
  }

  async function saveEdit() {
    if (!selected) return; setSaving(true);
    try { await edc(session.token, selected, editContent); setEditMode(false); setActionMsg("✓ Saved"); }
    catch { setActionMsg("✗ Save failed"); } finally { setSaving(false); }
  }

  async function doPublish(fn: string) {
    if (!window.confirm(`Publish "${fn}" as @votebroker on Steem?\n\nValidation + blockchain broadcast will run.`)) return;
    setSaving(true); setActionMsg("⏳ Publishing…"); setPublishResult(null);
    try {
      const r = await pd(session.token, fn);
      setPublishResult(r); setActionMsg(`✓ Published as @${r.author} — TX: ${r.transactionId.slice(0,12)}…`);
      await load();
    } catch (e) {
      if (e instanceof ContentValidationError) setActionMsg(`🚫 Blocked: ${e.violations.join(", ")}`);
      else setActionMsg(`✗ ${e instanceof Error ? e.message : "failed"}`);
      await load();
    } finally { setSaving(false); }
  }

  const drafts = data?.drafts ?? [];
  const selectedDraft = drafts.find(d => d.filename === selected) ?? null;

  const PLACEHOLDER_MARKER = "Keine Commit-Daten";
  const hasPlaceholder = !!(preview?.content && preview.content.includes(PLACEHOLDER_MARKER));

  const STATUS_COLORS: Record<DraftStatus, string> = {
    draft: C.dim, reviewed: C.info, approved: C.ok, scheduled: C.purple, publishing: C.warn, published: C.ok, failed: C.err
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: "0.75rem", minHeight: "500px" }}>
      {/* Left: list */}
      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
          <p style={{ ...lbl, margin: 0 }}>Content Queue</p>
          <div style={{ display: "flex", gap: "0.3rem" }}>
            <button
              style={{ ...btnStyle(C.info), fontSize: "0.68rem", padding: "0.2rem 0.55rem" }}
              type="button" disabled={saving}
              onClick={() => void doGenerate(false, false)}
              title="Generiert heutigen Devlog-Draft"
            >+ Devlog</button>
            <button
              style={{ ...btnStyle(C.purple), fontSize: "0.68rem", padding: "0.2rem 0.55rem" }}
              type="button" disabled={saving}
              onClick={() => {
                const el = document.getElementById("promo-section");
                el?.scrollIntoView({ behavior: "smooth" });
              }}
              title="Neuen Promo-Post generieren"
            >🌍 Promo</button>
          </div>
        </div>

        {/* Promo Post Generator */}
        <div id="promo-section" style={{
          background: C.purple + "08", border: `1px solid ${C.purple}30`,
          borderRadius: "8px", padding: "0.6rem 0.75rem", marginBottom: "0.5rem",
        }}>
          <p style={{ color: C.purple, fontSize: "0.72rem", fontWeight: 700, margin: "0 0 0.4rem", textTransform: "uppercase" as const }}>
            🌍 Internationaler Promo Post
          </p>
          <select
            value={promoLocale}
            onChange={e => setPromoLocale(e.target.value as PromoLocale)}
            disabled={saving}
            style={{ width: "100%", fontSize: "0.75rem", padding: "0.25rem 0.4rem", marginBottom: "0.35rem",
              background: "#fff", border: `1px solid ${C.border}`, borderRadius: "5px", color: C.text }}
          >
            {PROMO_LOCALES.map(l => (
              <option key={l.code} value={l.code}>{l.label} — {l.nativeName}</option>
            ))}
          </select>
          <button
            style={{ ...btnStyle(C.purple), fontSize: "0.72rem", width: "100%", fontWeight: 700 }}
            type="button" disabled={saving}
            onClick={() => void doPromoGenerate()}
          >
            {saving ? "⏳ Analysiere…" : "Promo Draft generieren"}
          </button>
          {promoStatus && (
            <p style={{ fontSize: "0.68rem", color: promoStatus.startsWith("✓") ? C.ok : promoStatus.startsWith("✗") ? C.err : C.warn, margin: "0.3rem 0 0" }}>
              {promoStatus}
            </p>
          )}
          {promoSnapSkipped && (
            <div style={{ marginTop: "0.4rem", padding: "0.35rem 0.5rem", background: C.warn + "12", border: `1px solid ${C.warn}40`, borderRadius: "5px" }}>
              <p style={{ fontSize: "0.67rem", color: C.warn, fontWeight: 600, margin: "0 0 0.2rem" }}>
                Screenshots übersprungen
              </p>
              <p style={{ fontSize: "0.63rem", color: C.dim, margin: "0 0 0.2rem" }}>
                Playwright läuft nicht im API-Container. Manuell vom Host:
              </p>
              <code style={{ display: "block", fontSize: "0.6rem", background: "#f4f4f4", padding: "0.25rem 0.4rem", borderRadius: "3px", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "#333" }}>
                {`SESSION_TOKEN=<token> PROMO_LOCALE=${promoSnapSkipped} \\\n  VOTEBROKER_SCREENSHOTS_DIR=/var/lib/docker/volumes/votebroker_data/_data/screenshots \\\n  python3 tools/showcase/capture.py`}
              </code>
            </div>
          )}
        </div>

        {/* Banner: today's devlog missing */}
        {!loading && !hasTodayDraft && (
          <div style={{
            background: C.warn + "18", border: `1px solid ${C.warn}55`,
            borderRadius: "6px", padding: "0.5rem 0.65rem", marginBottom: "0.5rem",
          }}>
            <p style={{ color: C.warn, fontSize: "0.75rem", fontWeight: 700, margin: "0 0 0.3rem" }}>
              📋 Heutiger Devlog fehlt
            </p>
            <button
              style={{ ...btnStyle(C.warn), fontSize: "0.7rem", width: "100%" }}
              type="button" disabled={saving}
              onClick={() => void doGenerate(false, false)}
            >
              Jetzt generieren
            </button>
          </div>
        )}

        {loading ? <p style={{ color: C.dim }}>Loading…</p> : drafts.length === 0 ? (
          <div>
            <p style={{ color: C.dim, fontSize: "0.8rem", marginBottom: "0.6rem" }}>Keine Drafts vorhanden.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
              <button style={btnStyle(C.info)} type="button" disabled={saving} onClick={() => void doGenerate(false, false)}>Devlog generieren</button>
              <button style={{ ...btnStyle(C.info), opacity: 0.8 }} type="button" disabled={saving} onClick={() => void doGenerate(false, true)}>Devlog + Screenshots</button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            {drafts.map(draft => {
              const isToday = draft.dateStr === todayStr;
              return (
                <div key={draft.filename} onClick={() => void openPreview(draft.filename)}
                  style={{
                    padding: "0.5rem 0.6rem", borderRadius: "5px", cursor: "pointer",
                    background: selected === draft.filename ? C.info + "22"
                      : isToday ? C.ok + "11" : "transparent",
                    border: `1px solid ${selected === draft.filename ? C.info
                      : isToday ? C.ok + "55" : C.border}`,
                    transition: "all 0.1s",
                  }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.15rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
                      {isToday && <span style={{ color: C.ok, fontSize: "0.62rem", fontWeight: 700 }}>HEUTE</span>}
                      <span style={{ color: C.text, fontSize: "0.78rem", fontWeight: 500 }}>{draft.type}</span>
                    </div>
                    <span style={tagStyle(STATUS_COLORS[draft.status])}>{draft.status}</span>
                  </div>
                  <p style={{ color: C.dim, fontSize: "0.7rem", margin: 0 }}>{draft.dateStr} · {draft.wordCount ?? 0}w</p>
                  {draft.scheduledFor && <p style={{ color: C.purple, fontSize: "0.68rem", margin: "0.1rem 0 0" }}>📅 {new Date(draft.scheduledFor).toLocaleDateString("en-GB")}</p>}
                  {draft.publishTxId && <p style={{ color: C.ok, fontSize: "0.68rem", margin: "0.1rem 0 0" }}>✓ TX: {draft.publishTxId.slice(0,10)}…</p>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Right: preview/edit */}
      <div style={{ ...card, display: "flex", flexDirection: "column", minHeight: "500px" }}>
        {!selected ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <p style={{ color: C.border }}>Select a draft to preview or publish</p>
          </div>
        ) : previewLoading ? (
          <p style={{ color: C.dim }}>Loading…</p>
        ) : (
          <>
            {/* Toolbar */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "0.6rem", borderBottom: `1px solid ${C.border}`, paddingBottom: "0.6rem" }}>
              <span style={{ color: C.text, fontWeight: 600, flex: 1 }}>{selectedDraft?.type}</span>
              {selectedDraft && <span style={tagStyle(STATUS_COLORS[selectedDraft.status])}>{selectedDraft.status}</span>}
              {editMode ? (
                <>
                  <button style={btnStyle(C.ok)} type="button" disabled={saving} onClick={saveEdit}>{saving ? "…" : "Save"}</button>
                  <button style={btnStyle(C.err)} type="button" onClick={() => { setEditMode(false); setEditContent(preview?.content ?? ""); }}>Cancel</button>
                </>
              ) : (
                <>
                  {/* Generate / Regenerate — only for devlog/product types in draft/failed state */}
                  {(selectedDraft?.status === "draft" || selectedDraft?.status === "failed") && (
                    <>
                      {(selectedDraft?.wordCount ?? 0) < 30
                        ? (
                          // Empty draft — prominent Generate buttons
                          <>
                            <button style={{ ...btnStyle(C.ok), fontWeight: 700 }} type="button" disabled={saving} onClick={() => void doGenerate(false, false)} title="Inhalt aus git-Commits und Community-Aktivität generieren">Generieren</button>
                            <button style={{ ...btnStyle(C.ok), opacity: 0.8 }} type="button" disabled={saving} onClick={() => void doGenerate(false, true)} title="Generieren + Screenshots aufnehmen">+ Screenshots</button>
                          </>
                        ) : (
                          // Draft has content — Regenerate buttons (destructive, secondary)
                          <>
                            <button style={{ ...btnStyle(C.warn), fontSize: "0.73rem" }} type="button" disabled={saving} onClick={() => void doGenerate(true, false)} title="Inhalt neu generieren (vorherigen überschreiben)">Neu generieren</button>
                            <button style={{ ...btnStyle(C.warn), fontSize: "0.73rem", opacity: 0.85 }} type="button" disabled={saving} onClick={() => void doGenerate(true, true)} title="Neu generieren + Screenshots">+ Screenshots</button>
                          </>
                        )
                      }
                    </>
                  )}
                  <button
                    style={{ ...btnStyle(C.purple), fontSize: "0.73rem" }}
                    type="button" disabled={saving}
                    onClick={() => { void loadScreenshots().then(() => setShowScreenshots(s => !s)); }}
                    title="Screenshots einbinden / anzeigen"
                  >📸 Screenshots</button>
                  {preview?.content?.includes("PLACEHOLDER_") && (
                    <button
                      style={{ ...btnStyle(C.ok), fontSize: "0.73rem", fontWeight: 700 }}
                      type="button" disabled={saving}
                      onClick={() => void doInjectScreenshots()}
                      title="Platzhalter im Draft durch Screenshot-URLs ersetzen"
                    >⬇ Einbetten</button>
                  )}
                  {/* URLs reparieren — immer sichtbar, nicht nur wenn interne URLs erkannt */}
                  <button
                    style={{ ...btnStyle(C.warn), fontSize: "0.73rem" }}
                    type="button" disabled={saving}
                    onClick={async () => {
                      if (!selected) return;
                      setSaving(true);
                      setActionMsg("⏳ Repariere Screenshot-URLs…");
                      try {
                        const r = await fixScreenshotUrls(session.token, selected);
                        setActionMsg(r.hint);
                        if (r.changed) await openPreview(selected);
                      } catch (e) {
                        setActionMsg(`✗ ${e instanceof Error ? e.message : "Fehler"}`);
                      } finally { setSaving(false); }
                    }}
                    title="Interne /api/admin/screenshots/ → öffentliche /api/screenshots/ URLs"
                  >🔧 URLs fix</button>

                  <button style={btnStyle(C.info)} type="button" onClick={() => setEditMode(true)}>Bearbeiten</button>
                  {selectedDraft?.status === "draft" && (
                    <button
                      style={{ ...btnStyle(C.info), opacity: hasPlaceholder ? 0.45 : 1 }}
                      type="button"
                      disabled={saving || hasPlaceholder}
                      title={hasPlaceholder ? "Draft enthält ungefüllte Commit-Daten — bitte Inhalt zuerst manuell ergänzen oder neu generieren" : undefined}
                      onClick={() => void setStatus(selected, "reviewed")}
                    >Review ✓</button>
                  )}
                  {selectedDraft?.status === "reviewed" && <button style={btnStyle(C.ok)} type="button" disabled={saving} onClick={() => void setStatus(selected, "approved")}>Freigeben</button>}
                  {selectedDraft?.status === "approved" && <button style={btnStyle(C.purple)} type="button" disabled={saving} onClick={() => void setStatus(selected, "scheduled")}>Einplanen →</button>}
                  {selectedDraft?.status === "scheduled" && <button style={{ ...btnStyle(C.ok), fontWeight: 700 }} type="button" disabled={saving} onClick={() => void doPublish(selected)}>🚀 Publizieren</button>}

                  {/* Neu publizieren für bereits veröffentlichte Posts (aktualisiert Steemit-Post) */}
                  {selectedDraft?.status === "published" && selectedDraft?.publishedPermlink && (
                    <button
                      style={{ ...btnStyle(C.ok), fontWeight: 700, fontSize: "0.73rem" }}
                      type="button" disabled={saving}
                      title="Aktualisiert den Steemit-Post mit dem korrigierten Inhalt (gleicher Permlink)"
                      onClick={async () => {
                        if (!window.confirm(
                          `"${selectedDraft.publishedPermlink}" auf Steemit aktualisieren?\n\nDer veröffentlichte Post wird mit dem aktuellen Draft-Inhalt überschrieben.`
                        )) return;
                        setSaving(true);
                        setActionMsg("⏳ Bereite Neu-Veröffentlichung vor…");
                        try {
                          // Reset to scheduled so publish endpoint accepts it
                          await uds(session.token, selected, "scheduled");
                          setActionMsg("⏳ Veröffentliche auf Steem…");
                          await doPublish(selected);
                        } catch (e) {
                          setActionMsg(`✗ ${e instanceof Error ? e.message : "Fehler"}`);
                          // Restore published status on error
                          await uds(session.token, selected, "published").catch(() => {});
                        } finally { setSaving(false); }
                      }}
                    >🔄 Neu veröffentlichen</button>
                  )}

                  {selectedDraft?.status !== "published" && selectedDraft?.status !== "failed" && (
                    <button style={btnStyle(C.err)} type="button" disabled={saving} onClick={() => void setStatus(selected, "failed", { failedReason: "Manually rejected" })}>Ablehnen</button>
                  )}

                  {selectedDraft && !["published", "scheduled"].includes(selectedDraft.status) && (
                    <button
                      style={{ ...btnStyle(C.err), opacity: 0.7 }}
                      type="button"
                      disabled={saving}
                      onClick={async () => {
                        if (!confirm(`Draft "${selected}" dauerhaft löschen?`)) return;
                        setSaving(true);
                        try {
                          await deleteDraft(session.token, selected);
                          setActionMsg("✓ Gelöscht");
                          setSelected(null);
                          setPreview(null);
                          await load();
                        } catch (e) {
                          setActionMsg(`✗ ${e instanceof Error ? e.message : "Fehler"}`);
                        } finally { setSaving(false); }
                      }}
                    >🗑 Löschen</button>
                  )}
                </>
              )}
            </div>
            {actionMsg && <div style={{ color: actionMsg.startsWith("✓") ? C.ok : actionMsg.startsWith("⏳") ? C.warn : C.err, fontSize: "0.78rem", marginBottom: "0.4rem" }}>{actionMsg}</div>}
            {selectedDraft?.publishTxId && (
              <div style={{ background: C.ok + "11", border: `1px solid ${C.ok}33`, borderRadius: "4px", padding: "0.3rem 0.6rem", marginBottom: "0.4rem", fontSize: "0.75rem" }}>
                <span style={{ color: C.ok }}>✓ On-chain</span>
                <span style={{ color: C.dim, marginLeft: "0.5rem" }}>TX: <code style={{ color: C.ok }}>{selectedDraft.publishTxId.slice(0,16)}…</code></span>
                {selectedDraft.publishedPermlink && <a href={steemitUrl("votebroker", selectedDraft.publishedPermlink)} target="_blank" rel="noreferrer" style={{ color: C.info, marginLeft: "0.5rem" }}>→ Steemit</a>}
              </div>
            )}
            {selectedDraft?.failedReason && <div style={{ color: C.err, fontSize: "0.75rem", marginBottom: "0.4rem" }}>✗ {selectedDraft.failedReason}</div>}
            {showScreenshots && screenshots.length > 0 && (
              <div style={{ marginBottom: "0.6rem", padding: "0.6rem 0.8rem", background: C.bg1, border: `1px solid ${C.border}`, borderRadius: "6px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
                  <p style={{ ...lbl, margin: 0 }}>Verfügbare Screenshots ({screenshots.length})</p>
                  <button style={{ ...btnStyle(C.dim), fontSize: "0.68rem" }} type="button" onClick={() => setShowScreenshots(false)}>Schließen</button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.4rem" }}>
                  {screenshots.map(s => (
                    <div key={s.filename} style={{ textAlign: "center" }}>
                      <AuthenticatedImage
                        url={s.url} token={session.token} alt={s.filename}
                        style={{ width: "100%", borderRadius: "4px", border: `1px solid ${C.border}`, cursor: "zoom-in", minHeight: "80px", display: "block" }}
                        onClick={() => {
                          // fetch blob → open in new tab (session auth required)
                          fetch(s.url, { headers: { session: session.token } })
                            .then(r => r.blob())
                            .then(b => window.open(URL.createObjectURL(b), "_blank"));
                        }}
                      />
                      <p style={{ color: C.dim, fontSize: "0.62rem", margin: "0.1rem 0 0" }}>{s.filename} · {s.sizekb} KB</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {showScreenshots && screenshots.length === 0 && (
              <div style={{ marginBottom: "0.6rem", padding: "0.5rem 0.75rem", background: C.bg1, border: `1px solid ${C.border}`, borderRadius: "6px", fontSize: "0.78rem", color: C.dim }}>
                Keine Screenshots vorhanden.
                Führe <code>python3 tools/showcase/capture.py</code> aus oder nutze "+ Screenshots" beim Generieren.
              </div>
            )}
            {hasPlaceholder && !editMode && (
              <div style={{ background: "#fff7ed", border: `1px solid ${C.warn}`, borderRadius: "6px", padding: "0.6rem 0.9rem", marginBottom: "0.5rem", display: "flex", alignItems: "flex-start", gap: "0.5rem" }}>
                <span style={{ fontSize: "1.1rem", lineHeight: 1.3 }}>⚠</span>
                <div>
                  <div style={{ fontWeight: 700, color: C.warn, fontSize: "0.82rem" }}>Draft enthält ungefüllte Commit-Daten</div>
                  <div style={{ color: "#92400e", fontSize: "0.78rem", marginTop: "0.2rem" }}>
                    Der Abschnitt „Was wurde umgesetzt" ist leer. Bitte Inhalt manuell ergänzen oder den Draft neu generieren — Review ist bis dahin gesperrt.
                  </div>
                </div>
              </div>
            )}
            {editMode ? (
              <textarea value={editContent} onChange={e => setEditContent(e.target.value)}
                style={{ flex: 1, background: "#1e2733", border: `1px solid ${C.border}`, borderRadius: "4px", color: "#e2eaf4", fontFamily: "monospace", fontSize: "0.77rem", lineHeight: 1.5, padding: "0.75rem", resize: "none" as const, outline: "none" }} />
            ) : preview?.content && (preview.content.trim().split(/\s+/).length > 20) ? (
              <div style={{ flex: 1, overflow: "auto", maxHeight: "480px" }}>
                {/* Render images inline if content has /api/admin/screenshots/ references */}
                {preview.content.includes("/api/admin/screenshots/") ? (
                  <div style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: "4px", padding: "0.75rem" }}>
                    {preview.content.split("\n").map((line, i) => {
                      const imgMatch = line.match(/!\[([^\]]*)\]\((\/api\/admin\/screenshots\/[^)]+)\)/);
                      if (imgMatch) {
                        return (
                          <div key={i} style={{ margin: "0.5rem 0", textAlign: "center" }}>
                            <AuthenticatedImage
                              url={imgMatch[2]} token={session.token} alt={imgMatch[1]}
                              style={{ maxWidth: "100%", borderRadius: "6px", border: `1px solid ${C.border}`, display: "block", margin: "0 auto", minHeight: "100px" }}
                            />
                            {imgMatch[1] && <p style={{ color: C.dim, fontSize: "0.7rem", margin: "0.2rem 0 0" }}>{imgMatch[1]}</p>}
                          </div>
                        );
                      }
                      return <div key={i} style={{ color: "#2d3a42", fontFamily: "monospace", fontSize: "0.74rem", lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{line || " "}</div>;
                    })}
                  </div>
                ) : (
                  <pre style={{ background: C.bg1, border: `1px solid ${C.border}`, borderRadius: "4px", color: "#2d3a42", fontFamily: "monospace", fontSize: "0.74rem", lineHeight: 1.5, margin: 0, padding: "0.75rem", whiteSpace: "pre-wrap" as const, wordBreak: "break-word" as const }}>
                    {preview.content}
                  </pre>
                )}
              </div>
            ) : (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "0.75rem", padding: "2rem", background: C.bg1, border: `1px solid ${C.border}`, borderRadius: "4px" }}>
                <p style={{ color: C.dim, fontSize: "0.85rem", margin: 0, textAlign: "center" }}>
                  Dieser Draft enthält noch keinen generierten Inhalt.
                </p>
                <p style={{ color: C.dim, fontSize: "0.75rem", margin: 0, textAlign: "center" }}>
                  Der Generator verwendet Änderungen seit dem letzten veröffentlichten Devlog<br />
                  und die aktuelle Community-Aktivität aus audit_events.
                </p>
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "center" }}>
                  <button style={{ ...btnStyle(C.ok), fontWeight: 700 }} type="button" disabled={saving} onClick={() => void doGenerate(false, false)}>
                    Inhalt generieren
                  </button>
                  <button style={{ ...btnStyle(C.ok), opacity: 0.8 }} type="button" disabled={saving} onClick={() => void doGenerate(false, true)}>
                    Mit Screenshots generieren
                  </button>
                </div>
                {actionMsg && <p style={{ color: actionMsg.startsWith("✓") ? C.ok : C.warn, fontSize: "0.78rem", margin: 0 }}>{actionMsg}</p>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main AdminDashboard ───────────────────────────────────────────────────────

type Tab = "overview" | "votes" | "users" | "content" | "system" | "alerts";

export function AdminDashboard(props: { session: AuthSession }) {
  const [data, setData]       = useState<AdminCockpit | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [tab, setTab]         = useState<Tab>("overview");
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try { const d = await getAdminCockpit(props.session.token); setData(d); setLastRefresh(new Date()); }
    catch (e) { setError(e instanceof Error ? e.message : "load failed"); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  const tabs: Array<{ id: Tab; label: string; badge?: number }> = [
    { id: "overview", label: "📊 Overview" },
    { id: "votes",    label: "🗳 Votes",   badge: data?.broadcasts.filter(b => b.status === "blocked").length },
    { id: "users",    label: "👥 Users",   badge: data?.users.total },
    { id: "content",  label: "📝 Content", badge: data?.kpis.content.openDrafts },
    { id: "system",   label: "⚙ System" },
    { id: "alerts",   label: "🔔 Alerts",  badge: data?.health.warnings.length },
  ];

  const warnings = data?.health.warnings ?? [];

  return (
    <div style={{ padding: "1rem 1.5rem" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem", flexWrap: "wrap", gap: "0.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span style={{ color: C.warn, fontWeight: 700, fontSize: "1.05rem" }}>🛡 Admin Cockpit</span>
          <span style={tagStyle(C.warn)}>Owner</span>
          {lastRefresh && <span style={{ color: C.border, fontSize: "0.72rem" }}>Updated {fmtAge(lastRefresh.toISOString())}</span>}
        </div>
        <button onClick={() => void load()} disabled={loading} style={btnStyle(C.info)}>
          {loading ? "Loading…" : "↺ Refresh"}
        </button>
      </div>

      {/* Warnings banner */}
      {warnings.length > 0 && (
        <div style={{ background: "#2d2a0e", border: `1px solid ${C.warn}55`, borderRadius: "6px", padding: "0.5rem 0.75rem", marginBottom: "0.75rem", display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
          <span style={{ color: C.warn, fontWeight: 600, fontSize: "0.78rem" }}>⚠</span>
          {warnings.map(w => <span key={w} style={{ color: C.warn, fontSize: "0.77rem" }}>{w}</span>)}
        </div>
      )}

      {error && <div style={{ background: C.err + "22", border: `1px solid ${C.err}`, borderRadius: "6px", padding: "0.5rem 0.75rem", marginBottom: "0.75rem", color: C.err, fontSize: "0.82rem" }}>{error}</div>}

      {/* Tab nav */}
      <nav style={{ display: "flex", borderBottom: `1px solid ${C.border}`, marginBottom: "1rem", gap: 0 }}>
        {tabs.map(t => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)} style={{
            background: "none", border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", gap: "0.3rem",
            padding: "0.5rem 1rem", fontSize: "0.8rem", fontWeight: 500,
            color: tab === t.id ? C.warn : C.dim,
            borderBottom: tab === t.id ? `2px solid ${C.warn}` : "2px solid transparent",
            marginBottom: "-1px"
          }}>
            {t.label}
            {t.badge !== undefined && t.badge > 0 && (
              <span style={{ background: C.warn + "33", color: C.warn, borderRadius: "10px", padding: "0 0.3rem", fontSize: "0.65rem", fontWeight: 700 }}>{t.badge}</span>
            )}
          </button>
        ))}
      </nav>

      {/* Tab content */}
      {loading && !data ? (
        <p style={{ color: C.dim, textAlign: "center", padding: "3rem" }}>Loading cockpit data…</p>
      ) : data ? (
        <>
          {tab === "overview" && <OverviewSection d={data} session={props.session} />}
          {tab === "votes"    && <VotesSection broadcasts={data.broadcasts} />}
          {tab === "users"    && <div style={card}><UsersTable users={data.users.users} /></div>}
          {tab === "content"  && <ContentSection session={props.session} queueItems={data.contentQueue} />}
          {tab === "system"   && <SystemSection d={data} session={props.session} />}
          {tab === "alerts"   && (
            <div style={card}>
              <p style={{ ...lbl, margin: "0 0 0.6rem" }}>Recent Notifications</p>
              {data.notifications.notifications.length === 0 ? (
                <p style={{ color: C.border, fontSize: "0.82rem" }}>No notifications in the last 24h.</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                  {data.notifications.notifications.map((n, i) => (
                    <div key={i} style={{ display: "flex", gap: "0.75rem", fontSize: "0.77rem", padding: "0.3rem 0" }}>
                      <span style={{ color: C.dim, whiteSpace: "nowrap" as const }}>{fmtAge(n.timestamp)}</span>
                      <Badge status={n.severity === "warning" ? "warn" : n.severity === "error" ? "failed" : "ok"} />
                      <span style={{ color: C.text }}>{n.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
