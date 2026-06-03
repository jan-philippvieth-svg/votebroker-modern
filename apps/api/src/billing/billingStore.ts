/**
 * Persistent Billing Store
 * =========================
 * Replaces the in-memory Map<string, FeeInvoice> in mockStore.ts.
 * Invoices and account billing state now survive server restarts.
 *
 * Strategy: SQLite is the source of truth.
 * A small in-process cache (Map) avoids re-reading the same invoice
 * multiple times within a single request/session — not for persistence.
 */

import type { FeeInvoice, VotingAccountSnapshot } from "@votebroker/domain";
import { getDb } from "../db/index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface InvoiceRow {
  id:                       string;
  username:                 string;
  source_author:            string;
  source_permlink:          string;
  source_expected_vote_usd: number;
  nominal_fee_usd:          number;
  amount_usd:               number;
  fee_post_author:          string;
  fee_post_permlink:        string;
  required_vote_weight_bps: number;
  status:                   string;
  billing_mode:             string;
  transparency_json:        string;
  created_at:               string;
}

interface BillingAccountRow {
  username:                     string;
  status:                       string;
  consecutive_underfunded_fees: number;
}

// ── Serialisation ─────────────────────────────────────────────────────────────

function invoiceToRow(inv: FeeInvoice): Omit<InvoiceRow, "updated_at"> {
  return {
    id:                       inv.id,
    username:                 inv.username,
    source_author:            inv.sourceAuthor,
    source_permlink:          inv.sourcePermlink,
    source_expected_vote_usd: inv.sourceExpectedVoteUsd,
    nominal_fee_usd:          inv.nominalFeeUsd,
    amount_usd:               inv.amountUsd,
    fee_post_author:          inv.feePostAuthor,
    fee_post_permlink:        inv.feePostPermlink,
    required_vote_weight_bps: inv.requiredVoteWeightBps,
    status:                   inv.status,
    billing_mode:             inv.billingMode,
    transparency_json:        JSON.stringify(inv.transparency),
    created_at:               inv.createdAt,
  };
}

function rowToInvoice(row: InvoiceRow): FeeInvoice {
  return {
    id:                    row.id,
    username:              row.username,
    sourceAuthor:          row.source_author,
    sourcePermlink:        row.source_permlink,
    sourceExpectedVoteUsd: row.source_expected_vote_usd,
    nominalFeeUsd:         row.nominal_fee_usd,
    amountUsd:             row.amount_usd,
    feePostAuthor:         row.fee_post_author,
    feePostPermlink:       row.fee_post_permlink,
    requiredVoteWeightBps: row.required_vote_weight_bps,
    status:                row.status as FeeInvoice["status"],
    billingMode:           row.billing_mode as FeeInvoice["billingMode"],
    transparency:          JSON.parse(row.transparency_json),
    createdAt:             row.created_at,
  };
}

// ── Invoice Store ─────────────────────────────────────────────────────────────

// Short-lived process cache — avoids redundant DB reads within a request
const _cache = new Map<string, FeeInvoice>();

const _upsertInvoice = () => getDb().prepare(`
  INSERT INTO fee_invoices
    (id, username, source_author, source_permlink, source_expected_vote_usd,
     nominal_fee_usd, amount_usd, fee_post_author, fee_post_permlink,
     required_vote_weight_bps, status, billing_mode, transparency_json, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    status             = excluded.status,
    amount_usd         = excluded.amount_usd,
    billing_mode       = excluded.billing_mode,
    transparency_json  = excluded.transparency_json,
    updated_at         = datetime('now')
`);

export function saveInvoice(inv: FeeInvoice): void {
  _cache.set(inv.id, inv);
  const r = invoiceToRow(inv);
  _upsertInvoice().run(
    r.id, r.username, r.source_author, r.source_permlink, r.source_expected_vote_usd,
    r.nominal_fee_usd, r.amount_usd, r.fee_post_author, r.fee_post_permlink,
    r.required_vote_weight_bps, r.status, r.billing_mode, r.transparency_json, r.created_at
  );
}

export function getInvoice(id: string): FeeInvoice | undefined {
  // 1. process cache
  const cached = _cache.get(id);
  if (cached) return cached;
  // 2. SQLite — survives restarts
  const row = getDb().prepare("SELECT * FROM fee_invoices WHERE id = ?")
    .get(id) as InvoiceRow | undefined;
  if (!row) return undefined;
  const inv = rowToInvoice(row);
  _cache.set(id, inv);
  return inv;
}

export function listInvoices(): FeeInvoice[] {
  return (getDb().prepare("SELECT * FROM fee_invoices ORDER BY created_at DESC").all() as InvoiceRow[])
    .map(rowToInvoice);
}

// ── Billing Account Store ─────────────────────────────────────────────────────

export function saveBillingAccount(account: Pick<VotingAccountSnapshot,
  "username" | "status" | "consecutiveUnderfundedFees">
): void {
  getDb().prepare(`
    INSERT INTO billing_accounts (username, status, consecutive_underfunded_fees)
    VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET
      status                       = excluded.status,
      consecutive_underfunded_fees = excluded.consecutive_underfunded_fees,
      updated_at                   = datetime('now')
  `).run(account.username, account.status, account.consecutiveUnderfundedFees);
}

export function loadBillingAccount(username: string): {
  status: VotingAccountSnapshot["status"];
  consecutiveUnderfundedFees: number;
} | null {
  const row = getDb().prepare(
    "SELECT status, consecutive_underfunded_fees FROM billing_accounts WHERE username = ?"
  ).get(username) as BillingAccountRow | undefined;
  if (!row) return null;
  return {
    status:                     row.status as VotingAccountSnapshot["status"],
    consecutiveUnderfundedFees: row.consecutive_underfunded_fees,
  };
}
