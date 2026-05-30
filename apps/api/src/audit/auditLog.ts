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

export const auditEvents: AuditEvent[] = [];

export function writeAuditEvent(event: Omit<AuditEvent, "id" | "createdAt">): AuditEvent {
  const record: AuditEvent = {
    ...event,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString()
  };
  auditEvents.push(record);
  return record;
}
