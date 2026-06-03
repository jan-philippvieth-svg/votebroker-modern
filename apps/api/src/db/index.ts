import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import type DatabaseConstructor from "better-sqlite3";

// ESM-safe require for CJS native module
const _require = createRequire(import.meta.url);
const Database = _require("better-sqlite3") as typeof DatabaseConstructor;
type Database = InstanceType<typeof DatabaseConstructor>;

const DB_PATH = process.env.VOTEBROKER_DB_PATH ?? resolve("data", "votebroker.db");

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  mkdirSync(dirname(resolve(DB_PATH)), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("synchronous = NORMAL");

  initSchema(_db);
  runMigrations(_db);
  pruneExpiredSessions(_db);

  return _db;
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      username    TEXT NOT NULL,
      provider    TEXT NOT NULL DEFAULT 'steemconnect',
      access_token TEXT,
      expiry      TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS consents (
      id          TEXT PRIMARY KEY,
      username    TEXT NOT NULL,
      type        TEXT NOT NULL,
      status      TEXT NOT NULL CHECK(status IN ('granted','revoked')),
      created_at  TEXT NOT NULL,
      revoked_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_consents_username ON consents(username);

    CREATE TABLE IF NOT EXISTS strategy_rules (
      username    TEXT PRIMARY KEY,
      rules_json  TEXT NOT NULL,
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS authority_cache (
      username      TEXT PRIMARY KEY,
      has_authority INTEGER NOT NULL,
      checked_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS content_drafts (
      filename          TEXT PRIMARY KEY,
      date_str          TEXT NOT NULL,
      type              TEXT NOT NULL,
      title             TEXT,
      status            TEXT NOT NULL DEFAULT 'draft',
      notes             TEXT,
      reviewed_at       TEXT,
      approved_at       TEXT,
      scheduled_at      TEXT,
      scheduled_for     TEXT,
      published_at      TEXT,
      failed_at         TEXT,
      failed_reason     TEXT,
      screenshot_snap   TEXT,         -- devlog only: snapshot dir name (e.g. "snap-20260602")
      created_at        TEXT DEFAULT (datetime('now')),
      updated_at        TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_status  ON content_drafts(status);
    CREATE INDEX IF NOT EXISTS idx_drafts_date    ON content_drafts(date_str);

    CREATE TABLE IF NOT EXISTS fee_post_log (
      id           TEXT PRIMARY KEY,
      date_str     TEXT NOT NULL,        -- YYYY-MM-DD
      status       TEXT NOT NULL,        -- success | failed | skipped
      permlink     TEXT,
      already_existed INTEGER DEFAULT 0,
      error        TEXT,
      executed_at  TEXT DEFAULT (datetime('now')),
      next_run_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fee_log_date ON fee_post_log(date_str);

    CREATE TABLE IF NOT EXISTS audit_events (
      id            TEXT PRIMARY KEY,
      type          TEXT NOT NULL,
      username      TEXT NOT NULL,
      author        TEXT,
      permlink      TEXT,
      weight_bps    INTEGER,
      detail        TEXT,
      transaction_id TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_username   ON audit_events(username);
    CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_type       ON audit_events(type);

    -- Per-vote ROI tracking: local index over Steem blockchain operations.
    -- This table is a CACHE — the chain is the truth.
    -- Can be deleted and rebuilt from get_account_history at any time.
    -- Herkunftsfelder (trx_id, block_num) allow verification against chain.
    CREATE TABLE IF NOT EXISTS vb_vote_outcomes (
      vote_key        TEXT PRIMARY KEY,     -- "{username}/{author}/{permlink}"
      username        TEXT NOT NULL,
      author          TEXT NOT NULL,
      permlink        TEXT NOT NULL,
      voted_at        TEXT NOT NULL,
      weight_bps      INTEGER NOT NULL,
      vote_value_sbd  REAL,                -- estimated vote value at cast time
      realized_sp     REAL,               -- actual curation_reward received (SP)
      realized_at     TEXT,               -- when the post paid out
      category        TEXT,               -- strategy category at vote time
      -- Chain provenance — enables rebuild verification and debugging at the right layer
      vote_trx_id     TEXT,               -- transaction_id of the vote operation
      reward_trx_id   TEXT,               -- transaction_id of the curation_reward op
      reward_block_num INTEGER,            -- block number of the curation_reward op
      recorded_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_vb_outcomes_user   ON vb_vote_outcomes(username);
    CREATE INDEX IF NOT EXISTS idx_vb_outcomes_date   ON vb_vote_outcomes(voted_at);
    CREATE INDEX IF NOT EXISTS idx_vb_outcomes_author ON vb_vote_outcomes(author);

    -- Feature knowledge base: tracks which cluster-stories were communicated
    -- and in which context. This is the shared truth for devlogs, product posts
    -- and fee reports — cluster (not commit) is the unit.
    CREATE TABLE IF NOT EXISTS published_features (
      story_key      TEXT NOT NULL,   -- "{cluster}-{since_date}" slug
      cluster        TEXT NOT NULL,
      summary        TEXT NOT NULL,   -- human-readable one-liner for this story
      since_date     TEXT NOT NULL,   -- earliest commit date in this story
      until_date     TEXT NOT NULL,   -- latest commit date in this story
      context_type   TEXT NOT NULL,   -- "devlog" | "product-post" | "fee-report"
      draft_filename TEXT NOT NULL,
      published_at   TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (story_key, context_type)
    );
    CREATE INDEX IF NOT EXISTS idx_pub_features_cluster  ON published_features(cluster);
    CREATE INDEX IF NOT EXISTS idx_pub_features_draft    ON published_features(draft_filename);
    CREATE INDEX IF NOT EXISTS idx_pub_features_published ON published_features(published_at);

    -- Persistent billing: replaces in-memory Map in mockStore.ts
    CREATE TABLE IF NOT EXISTS fee_invoices (
      id                       TEXT PRIMARY KEY,
      username                 TEXT NOT NULL,
      source_author            TEXT NOT NULL,
      source_permlink          TEXT NOT NULL,
      source_expected_vote_usd REAL NOT NULL,
      nominal_fee_usd          REAL NOT NULL,
      amount_usd               REAL NOT NULL,
      fee_post_author          TEXT NOT NULL,
      fee_post_permlink        TEXT NOT NULL,
      required_vote_weight_bps INTEGER NOT NULL,
      status                   TEXT NOT NULL,
      billing_mode             TEXT NOT NULL,
      transparency_json        TEXT NOT NULL,
      created_at               TEXT NOT NULL,
      updated_at               TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fee_invoices_user ON fee_invoices(username);

    CREATE TABLE IF NOT EXISTS billing_accounts (
      username                     TEXT PRIMARY KEY,
      status                       TEXT NOT NULL DEFAULT 'active',
      consecutive_underfunded_fees INTEGER NOT NULL DEFAULT 0,
      updated_at                   TEXT DEFAULT (datetime('now'))
    );

    -- Global vote outcome analytics index.
    -- Source of truth: Steem blockchain. This table is a reconstructable cache.
    -- Purpose: learn optimal vote timing from real curation reward outcomes.
    -- Primary key: voter + author + permlink (one vote per post per voter).
    CREATE TABLE IF NOT EXISTS vb_global_vote_outcomes (
      -- Identity
      voter                   TEXT NOT NULL,
      author                  TEXT NOT NULL,
      permlink                TEXT NOT NULL,
      -- Post timing
      post_created_at         TEXT,          -- ISO, from get_content.created
      voted_at                TEXT NOT NULL, -- ISO, when VoteBroker broadcast the vote
      vote_delay_minutes      REAL,          -- voted_at - post_created_at in minutes
      -- Vote parameters at cast time
      weight_bps              INTEGER NOT NULL,
      vp_at_vote_bps          INTEGER,       -- voting power % × 100 at cast time
      estimated_vote_value_sbd REAL,         -- estimated USD/SBD value at cast time
      -- Curation outcome (filled when post pays out)
      realized_curation_sp    REAL,          -- actual SP from curation_reward op
      realized_at             TEXT,          -- ISO, when the payout occurred
      -- Strategy context
      strategy_category       TEXT,          -- immer_voten|lieblingsautor|bevorzugt|...
      is_self_post            INTEGER,       -- 0/1 — author == voter
      -- Chain provenance (allows verification + rebuild from chain)
      source_vote_trx_id      TEXT,          -- transaction_id of the vote op
      source_reward_trx_id    TEXT,          -- transaction_id of curation_reward op
      -- Metadata
      recorded_at             TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (voter, author, permlink)
    );
    CREATE INDEX IF NOT EXISTS idx_gvo_voter       ON vb_global_vote_outcomes(voter);
    CREATE INDEX IF NOT EXISTS idx_gvo_voted_at    ON vb_global_vote_outcomes(voted_at);
    CREATE INDEX IF NOT EXISTS idx_gvo_delay       ON vb_global_vote_outcomes(vote_delay_minutes);
    CREATE INDEX IF NOT EXISTS idx_gvo_category    ON vb_global_vote_outcomes(strategy_category);
    CREATE INDEX IF NOT EXISTS idx_gvo_realized    ON vb_global_vote_outcomes(realized_at);
  `);
}

function pruneExpiredSessions(db: Database): void {
  db.prepare("DELETE FROM sessions WHERE expiry <= datetime('now')").run();
}

function runMigrations(db: Database): void {
  // Add new columns to content_drafts if they don't exist (safe ALTER TABLE)
  const columns = (db.prepare("PRAGMA table_info(content_drafts)").all() as Array<{ name: string }>).map(c => c.name);
  const addIfMissing = (col: string, type: string) => {
    if (!columns.includes(col)) {
      db.exec(`ALTER TABLE content_drafts ADD COLUMN ${col} ${type}`);
    }
  };
  if (columns.length > 0) { // only if table exists
    addIfMissing("scheduled_at",  "TEXT");
    addIfMissing("scheduled_for", "TEXT");
    addIfMissing("failed_at",     "TEXT");
    addIfMissing("failed_reason", "TEXT");
    addIfMissing("publish_tx_id", "TEXT");
    addIfMissing("published_permlink", "TEXT");
    addIfMissing("screenshot_snap",   "TEXT");   // devlog snapshot dir, e.g. "snap-20260602"
    // vb_vote_outcomes provenance fields (added after initial schema)
    const outcomesCols = (db.prepare("PRAGMA table_info(vb_vote_outcomes)").all() as Array<{name:string}>).map(c=>c.name);
    if (outcomesCols.length > 0) {
      if (!outcomesCols.includes("vote_trx_id"))     db.exec("ALTER TABLE vb_vote_outcomes ADD COLUMN vote_trx_id TEXT");
      if (!outcomesCols.includes("reward_trx_id"))   db.exec("ALTER TABLE vb_vote_outcomes ADD COLUMN reward_trx_id TEXT");
      if (!outcomesCols.includes("reward_block_num")) db.exec("ALTER TABLE vb_vote_outcomes ADD COLUMN reward_block_num INTEGER");
    }
    // vb_global_vote_outcomes: post-context columns for copilot training data
    const gvoCols = (db.prepare("PRAGMA table_info(vb_global_vote_outcomes)").all() as Array<{name:string}>).map(c=>c.name);
    if (gvoCols.length > 0) {
      if (!gvoCols.includes("post_pending_payout_sbd"))    db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN post_pending_payout_sbd REAL");
      if (!gvoCols.includes("post_active_votes_count"))    db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN post_active_votes_count INTEGER");
      if (!gvoCols.includes("post_net_votes"))             db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN post_net_votes INTEGER");
      if (!gvoCols.includes("post_author_reputation"))     db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN post_author_reputation REAL");
      if (!gvoCols.includes("post_final_payout_sbd"))      db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN post_final_payout_sbd REAL");
    }
  }
}
