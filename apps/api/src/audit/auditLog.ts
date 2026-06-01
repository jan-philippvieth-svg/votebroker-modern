import { randomUUID } from "node:crypto";
import { getDb } from "../db/index.js";

export type AuditEventType =
  | "vote_broadcast_attempt"
  | "vote_broadcast_success"
  | "vote_broadcast_blocked"
  | "fee_vote_broadcast_attempt"
  | "fee_vote_broadcast_success"
  | "fee_vote_broadcast_blocked";

export interface AuditEvent {
  id: string;
  type: AuditEventType;
  username: string;
  author: string;
  permlink: string;
  weightBps: number;
  detail: string;
  transactionId?: string;
  createdAt: string;
}

type AuditRow = {
  id: string;
  type: AuditEventType;
  username: string;
  author: string | null;
  permlink: string | null;
  weight_bps: number | null;
  detail: string | null;
  transaction_id: string | null;
  created_at: string;
};

function rowToEvent(row: AuditRow): AuditEvent {
  return {
    id: row.id,
    type: row.type,
    username: row.username,
    author: row.author ?? "",
    permlink: row.permlink ?? "",
    weightBps: row.weight_bps ?? 0,
    detail: row.detail ?? "",
    transactionId: row.transaction_id ?? undefined,
    createdAt: row.created_at
  };
}

export function writeAuditEvent(event: Omit<AuditEvent, "id" | "createdAt">): AuditEvent {
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  getDb().prepare(`
    INSERT INTO audit_events (id, type, username, author, permlink, weight_bps, detail, transaction_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, event.type, event.username, event.author, event.permlink, event.weightBps, event.detail, event.transactionId ?? null, createdAt);

  return { ...event, id, createdAt };
}

export function getRecentAuditEvents(limit = 50): AuditEvent[] {
  const rows = getDb().prepare(`
    SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?
  `).all(limit) as AuditRow[];
  return rows.map(rowToEvent);
}

export function getAuditStats(): {
  totalAttempts: number;
  totalSuccess: number;
  totalBlocked: number;
  last24h: number;
} {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) as n FROM audit_events").get() as { n: number };
  const success = db.prepare("SELECT COUNT(*) as n FROM audit_events WHERE type LIKE '%_success'").get() as { n: number };
  const blocked = db.prepare("SELECT COUNT(*) as n FROM audit_events WHERE type LIKE '%_blocked'").get() as { n: number };
  const last24h = db.prepare("SELECT COUNT(*) as n FROM audit_events WHERE created_at >= datetime('now', '-1 day')").get() as { n: number };
  return {
    totalAttempts: total.n,
    totalSuccess: success.n,
    totalBlocked: blocked.n,
    last24h: last24h.n
  };
}

// Keep backward-compat export
export const auditEvents: AuditEvent[] = [];
