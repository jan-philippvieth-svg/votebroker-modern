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

    CREATE TABLE IF NOT EXISTS vb_rebuild_checkpoint (
      voter          TEXT PRIMARY KEY,
      from_index     INTEGER NOT NULL,
      last_updated   TEXT    NOT NULL DEFAULT (datetime('now')),
      status         TEXT    NOT NULL DEFAULT 'in_progress'
    );

    -- Per-user preferences: timezone, locale, currency, date format
    -- All columns have safe defaults; add new columns via runMigrations.
    CREATE TABLE IF NOT EXISTS user_settings (
      username     TEXT PRIMARY KEY,
      timezone     TEXT NOT NULL DEFAULT 'Europe/Berlin',
      locale       TEXT,           -- future: 'de' | 'en' | ... (null = inherit from app)
      currency     TEXT,           -- future: 'USD' | 'EUR' | 'SBD' (null = USD)
      date_format  TEXT,           -- future: 'ISO' | 'EU' | 'US' (null = ISO)
      updated_at   TEXT DEFAULT (datetime('now'))
    );

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

    -- Whale vote signal cache: which authors do known whale accounts vote on regularly?
    -- Rebuilt by background job, not on every page load.
    CREATE TABLE IF NOT EXISTS vb_whale_author_signals (
      author               TEXT NOT NULL,
      whale                TEXT NOT NULL,
      -- Vote activity (from vote ops, available now)
      vote_count           INTEGER NOT NULL DEFAULT 1,
      distinct_posts       INTEGER,          -- unique permlinks voted
      avg_vote_weight_bps  INTEGER,          -- avg weight of whale's votes on this author
      first_voted_at       TEXT,             -- earliest whale vote on this author
      last_voted_at        TEXT NOT NULL,    -- most recent whale vote
      last_voted_permlink  TEXT,             -- permlink of most recent whale vote
      -- Timing stats (from enrichment pass via get_content, filled later)
      -- Key insight: when does the whale typically vote relative to post creation?
      -- VoteBroker should be in BEFORE the whale arrives.
      avg_vote_delay_min   REAL,            -- avg minutes after post creation
      median_vote_delay_min REAL,           -- median (more robust than avg)
      min_vote_delay_min   REAL,            -- earliest vote delay seen
      p25_vote_delay_min   REAL,            -- 25th percentile
      p75_vote_delay_min   REAL,            -- 75th percentile
      typical_vote_window  TEXT,            -- e.g. "5-30min" | "1-6h" | "6h+" (computed)
      timing_sample_size   INTEGER,         -- how many posts timing was computed from
      -- Vote value (from get_content enrichment, filled later)
      total_vote_value_sbd REAL,            -- sum of vote values in SBD
      avg_vote_value_sbd   REAL,            -- avg vote value per post
      avg_post_payout_sbd  REAL,            -- avg final post payout (post quality signal)
      -- Meta
      period_days          INTEGER NOT NULL DEFAULT 30,
      computed_at          TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (author, whale)
    );

    -- Raw vote-level detail for timing enrichment (populated during whale scan)
    -- Enrichment pass fetches get_content per permlink and computes vote_delay_min
    CREATE TABLE IF NOT EXISTS vb_whale_vote_details (
      whale                TEXT NOT NULL,
      author               TEXT NOT NULL,
      permlink             TEXT NOT NULL,
      voted_at             TEXT NOT NULL,
      vote_weight_bps      INTEGER,
      vote_delay_min       REAL,       -- NULL until enriched via get_content
      post_created_at      TEXT,       -- NULL until enriched
      total_payout_sbd     REAL,       -- NULL until enriched (total_payout_value)
      curator_payout_sbd   REAL,       -- NULL until enriched (curator_payout_value)
      pending_payout_sbd   REAL,       -- NULL until enriched (pending if not paid out yet)
      post_community       TEXT,       -- NULL until enriched (category / parent_permlink)
      enriched_at          TEXT,       -- NULL until enriched
      PRIMARY KEY (whale, author, permlink)
    );
    CREATE INDEX IF NOT EXISTS idx_whale_details_enrichment
      ON vb_whale_vote_details(whale, author) WHERE enriched_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_whale_details_voted_at
      ON vb_whale_vote_details(whale, voted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_whale_signals_author ON vb_whale_author_signals(author);
    CREATE INDEX IF NOT EXISTS idx_whale_signals_whale  ON vb_whale_author_signals(whale);

    -- Signal Layer — computed nightly from enriched whale data
    -- These tables are the foundation for DNA author suggestions and Autopilot decisions.
    CREATE TABLE IF NOT EXISTS vb_signal_author (
      author              TEXT PRIMARY KEY,
      -- Payout quality (from enriched whale_vote_details)
      avg_payout_sbd      REAL,
      median_payout_sbd   REAL,
      p75_payout_sbd      REAL,
      avg_curator_sbd     REAL,
      -- Whale activity
      whale_count         INTEGER,       -- distinct whales voting this author
      whale_follow_rate   REAL,          -- fraction of posts with ≥1 whale vote (0-1)
      top_whales          TEXT,          -- JSON array of top 3 whale names
      -- Optimal vote timing (when do whales arrive?)
      p25_delay_min       REAL,
      p50_delay_min       REAL,
      p75_delay_min       REAL,
      optimal_window      TEXT,          -- "5-30min" | "30-120min" | "2-6h" | "6h+" | "variabel"
      -- CoPilot training data (from vb_global_vote_outcomes, per voter)
      avg_sp_per_vp       REAL,          -- historical avg curation SP per full VP (realized votes)
      sp_per_vp_cv        REAL,          -- coefficient of variation — consistency measure
      avg_growth_factor   REAL,          -- avg post_final_payout / post_pending_payout_sbd
      gf_sample_n         INTEGER,       -- number of votes with computable growth factor
      -- Meta
      sample_posts        INTEGER,
      data_days           INTEGER,       -- days of data this was computed from
      computed_at         TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_signal_author_whale_rate ON vb_signal_author(whale_follow_rate DESC);
    CREATE INDEX IF NOT EXISTS idx_signal_author_payout     ON vb_signal_author(avg_payout_sbd DESC);

    CREATE TABLE IF NOT EXISTS vb_signal_community (
      community           TEXT PRIMARY KEY,
      avg_payout_sbd      REAL,
      median_payout_sbd   REAL,
      avg_curator_sbd     REAL,
      whale_activity      REAL,          -- avg distinct whales per post
      posts_sampled       INTEGER,
      computed_at         TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_signal_community_payout ON vb_signal_community(avg_payout_sbd DESC);

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
      -- Curation model estimates (filled by enrichCurationEstimates job)
      estimated_sp_weight      REAL,   -- pool × 0.20 × (my_weight/sum_weight) / sbd_per_steem
      estimated_sp_rshares     REAL,   -- pool × 0.20 × (my_rshares/sum_rshares) / sbd_per_steem
      steemworld_estimate_sp   REAL,   -- external reference (SteemWorld), populated manually
      estimation_sbd_per_steem REAL,   -- SBD/STEEM price used for the above estimates
      estimated_at             TEXT,   -- ISO — when the last estimate was computed
      -- Metadata
      recorded_at             TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (voter, author, permlink)
    );
    CREATE INDEX IF NOT EXISTS idx_gvo_voter       ON vb_global_vote_outcomes(voter);
    CREATE INDEX IF NOT EXISTS idx_gvo_voted_at    ON vb_global_vote_outcomes(voted_at);
    CREATE INDEX IF NOT EXISTS idx_gvo_delay       ON vb_global_vote_outcomes(vote_delay_minutes);
    CREATE INDEX IF NOT EXISTS idx_gvo_category    ON vb_global_vote_outcomes(strategy_category);
    CREATE INDEX IF NOT EXISTS idx_gvo_realized    ON vb_global_vote_outcomes(realized_at);

    -- Growth snapshot time series — raw payout measurements at fixed intervals after vote cast.
    -- Snapshot types: 'vote_time' | 't5m' | 't10m' | 't15m' | 't1h' | 't6h' | 't24h' | 't72h' | 'final'
    -- pending_payout_sbd: pending_payout_value from get_content (0 after payout; 'final' uses post_final_payout_sbd)
    -- actual_delta_min: real elapsed minutes since voted_at when the snapshot was captured
    CREATE TABLE IF NOT EXISTS vote_growth_snapshots (
      voter              TEXT    NOT NULL,
      author             TEXT    NOT NULL,
      permlink           TEXT    NOT NULL,
      snapshot_type      TEXT    NOT NULL,
      target_minutes     INTEGER,
      pending_payout_sbd REAL,
      active_votes_count INTEGER,
      measured_at        TEXT    NOT NULL,
      actual_delta_min   REAL,
      -- 'native': captured within one job interval of target_minutes (real growth curve point)
      -- 'historical_backfill': captured significantly later than target (reconstructed from existing data)
      source             TEXT    NOT NULL DEFAULT 'historical_backfill',
      -- 1 if this snapshot was captured in the same job run as another checkpoint for the same post
      -- (multiple due windows open simultaneously → values are identical, no real time-series between them)
      collocated         INTEGER NOT NULL DEFAULT 0,
      -- Whale/vote signal enrichment — causal chain data from active_votes[] in get_content
      -- NULL for 'final' snapshots (active_votes is empty after payout)
      whale_count           INTEGER,  -- known whales in active_votes at snapshot time
      new_whale_votes       INTEGER,  -- delta vs previous snapshot (NULL if first snapshot for this post)
      top_voter_account     TEXT,     -- voter with highest rshares at snapshot time
      top_voter_rshares     REAL,     -- their rshares value
      first_whale_delay_min REAL,     -- minutes between post creation and first whale vote (NULL until first whale)
      time_since_last_vote_min REAL,  -- minutes since most recent vote at snapshot time (momentum signal)
      total_rshares_sum     REAL,     -- sum of all rshares across active_votes (denominator for dominance_ratio)
      median_rshares        REAL,     -- median rshares per vote (distinguishes 1 whale + noise vs. broad mid-tier)
      PRIMARY KEY (voter, author, permlink, snapshot_type)
    );
    CREATE INDEX IF NOT EXISTS idx_vgs_vote ON vote_growth_snapshots(voter, author, permlink);
    CREATE INDEX IF NOT EXISTS idx_vgs_type ON vote_growth_snapshots(snapshot_type, measured_at);

    -- Feature extraction view — Layer 3 over raw snapshots.
    -- population: 'native_growth_tracking' if all timed (non-final) snapshots were captured on schedule;
    --             'historical_backfill' if any timed snapshot was a late reconstruction.
    CREATE VIEW IF NOT EXISTS vw_growth_features AS
    WITH pivoted AS (
      SELECT
        voter, author, permlink,
        MAX(CASE WHEN snapshot_type = 'vote_time' THEN pending_payout_sbd END) AS t0,
        MAX(CASE WHEN snapshot_type = 't5m'       THEN pending_payout_sbd END) AS t5m,
        MAX(CASE WHEN snapshot_type = 't10m'      THEN pending_payout_sbd END) AS t10m,
        MAX(CASE WHEN snapshot_type = 't15m'      THEN pending_payout_sbd END) AS t15m,
        MAX(CASE WHEN snapshot_type = 't1h'       THEN pending_payout_sbd END) AS t1h,
        MAX(CASE WHEN snapshot_type = 't6h'       THEN pending_payout_sbd END) AS t6h,
        MAX(CASE WHEN snapshot_type = 't24h'      THEN pending_payout_sbd END) AS t24h,
        MAX(CASE WHEN snapshot_type = 't72h'      THEN pending_payout_sbd END) AS t72h,
        MAX(CASE WHEN snapshot_type = 'final'     THEN pending_payout_sbd END) AS t_final,
        COUNT(*) AS snapshot_count,
        MIN(CASE WHEN snapshot_type != 'final' THEN source END) AS timed_source_min
      FROM vote_growth_snapshots
      GROUP BY voter, author, permlink
    )
    SELECT
      voter, author, permlink,
      t0, t5m, t10m, t15m, t1h, t6h, t24h, t72h, t_final,
      snapshot_count,
      CASE WHEN timed_source_min = 'native' THEN 'native_growth_tracking'
           ELSE 'historical_backfill'
      END AS population,
      CASE WHEN t0 > 0 THEN t1h / t0        END AS early_momentum,
      CASE WHEN t0 IS NOT NULL AND t1h IS NOT NULL
           THEN (t1h - t0) / 60.0           END AS velocity_0_1h,
      CASE WHEN t6h IS NOT NULL AND t24h IS NOT NULL
           THEN (t24h - t6h) / (18.0 * 60)  END AS velocity_6h_24h,
      CASE WHEN t0 > 0 THEN t_final / t0    END AS growth_factor,
      CASE
        WHEN t_final IS NULL OR t0 IS NULL OR t0 = 0 THEN 'unknown'
        WHEN t_final / t0 < 1.5                       THEN 'flat'
        WHEN t1h IS NOT NULL AND t1h / t0 > 1.8 AND t_final / t0 < 4.0 THEN 'early_spike'
        WHEN t1h IS NOT NULL AND t1h / t0 < 1.3 AND t_final / t0 > 3.0 THEN 'slow_burn'
        ELSE 'unknown'
      END AS trajectory_class
    FROM pivoted;

    -- Opportunity cache — top-N scored posts from blockchain, refreshed every 30 min.
    -- Source: top whale-signal authors; score computed without user context (category='normal').
    -- Endpoint enriches per-user (in_strategy, already_voted) at query time.
    CREATE TABLE IF NOT EXISTS vb_opportunity_cache (
      author              TEXT    NOT NULL,
      permlink            TEXT    NOT NULL,
      title               TEXT,
      age_minutes         REAL,
      remaining_hours     REAL,
      pending_payout_sbd  REAL,
      community           TEXT,
      whale_count         INTEGER,
      author_avg_gf       REAL,
      author_gf_sample_n  INTEGER,
      opportunity_score   INTEGER NOT NULL,
      score_payout        INTEGER,
      score_timing        INTEGER,
      score_signal        INTEGER,
      score_discovery     INTEGER,
      score_author        INTEGER,
      cached_at           TEXT    NOT NULL,
      PRIMARY KEY (author, permlink)
    );
    CREATE INDEX IF NOT EXISTS idx_opp_cache_score ON vb_opportunity_cache(opportunity_score DESC);

    -- ── Canonical post-outcome table (Phase 1, additive) ──────────────────────────
    -- One row per POST (author, permlink) — independent of who voted or what a model
    -- predicted. Holds only properties of the post itself. Backfilled once from
    -- vb_global_vote_outcomes (no chain re-scan) and kept fresh by existing enrichment.
    --
    -- This is the start of separating three concerns currently mixed in
    -- vb_global_vote_outcomes / vb_copilot_shadow_runs / vb_whale_vote_details:
    --   post-outcome (here) · vote-outcome (vb_vote_outcomes) · model-prediction (Phase 2).
    -- Legacy tables and their columns stay UNCHANGED; existing readers are untouched.
    CREATE TABLE IF NOT EXISTS vb_post_outcomes (
      author          TEXT NOT NULL,
      permlink        TEXT NOT NULL,
      post_created_at TEXT,            -- ISO, get_content.created
      community       TEXT,            -- json_metadata.community / parent_permlink
      final_payout    REAL,            -- total_payout_value + curator_payout_value (SBD) after settlement
      net_votes       INTEGER,         -- best available net_votes (Phase 1: vote-time snapshot; see Phase 2 notes)
      active_votes    INTEGER,         -- best available active_votes count (Phase 1: vote-time snapshot)
      paid_at         TEXT,            -- ISO, when the post paid out (proxy: earliest curation_reward op)
      resolved_at     TEXT,            -- ISO, when VoteBroker first resolved final_payout for this post
      recorded_at     TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (author, permlink)
    );
    CREATE INDEX IF NOT EXISTS idx_post_outcomes_resolved ON vb_post_outcomes(resolved_at);
    CREATE INDEX IF NOT EXISTS idx_post_outcomes_created  ON vb_post_outcomes(post_created_at);
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
    // user_settings: curation model preference (default 'weight' — validated research winner)
    const usCols = (db.prepare("PRAGMA table_info(user_settings)").all() as Array<{name:string}>).map(c=>c.name);
    if (usCols.length > 0 && !usCols.includes("curation_model")) {
      db.exec("ALTER TABLE user_settings ADD COLUMN curation_model TEXT");
    }
    // vb_vote_outcomes provenance fields (added after initial schema)
    const outcomesCols = (db.prepare("PRAGMA table_info(vb_vote_outcomes)").all() as Array<{name:string}>).map(c=>c.name);
    if (outcomesCols.length > 0) {
      if (!outcomesCols.includes("vote_trx_id"))     db.exec("ALTER TABLE vb_vote_outcomes ADD COLUMN vote_trx_id TEXT");
      if (!outcomesCols.includes("reward_trx_id"))   db.exec("ALTER TABLE vb_vote_outcomes ADD COLUMN reward_trx_id TEXT");
      if (!outcomesCols.includes("reward_block_num")) db.exec("ALTER TABLE vb_vote_outcomes ADD COLUMN reward_block_num INTEGER");
    }
    // vb_whale_vote_details: enrichment payout columns (added for Signal Layer)
    const wvdCols = (db.prepare("PRAGMA table_info(vb_whale_vote_details)").all() as Array<{name:string}>).map(c=>c.name);
    if (wvdCols.length > 0) {
      if (!wvdCols.includes("total_payout_sbd"))   db.exec("ALTER TABLE vb_whale_vote_details ADD COLUMN total_payout_sbd REAL");
      if (!wvdCols.includes("curator_payout_sbd")) db.exec("ALTER TABLE vb_whale_vote_details ADD COLUMN curator_payout_sbd REAL");
      if (!wvdCols.includes("pending_payout_sbd")) db.exec("ALTER TABLE vb_whale_vote_details ADD COLUMN pending_payout_sbd REAL");
      if (!wvdCols.includes("post_community"))     db.exec("ALTER TABLE vb_whale_vote_details ADD COLUMN post_community TEXT");

      // Indexes for signal compute queries on vb_whale_vote_details (456k+ rows):
      //
      //   (author, permlink) — CTE GROUP BY + LEFT JOIN in computeCommunitySignals;
      //     also covers any per-post lookup by author.
      //
      //   (enriched_at) full index — WHERE enriched_at IS NOT NULL scan in both
      //     computeAuthorSignals and computeCommunitySignals; full (not partial) so
      //     the planner can also use it for ORDER BY enriched_at and range queries.
      //
      //   (post_community) partial — covers the community IS NOT NULL filter in
      //     computeCommunitySignals without indexing the majority of NULL rows.
      //
      //   (whale) — standalone index for GROUP BY whale and per-whale lookups;
      //     the existing (whale, author) partial and (whale, voted_at) indexes are
      //     too narrow for community-level aggregations that group purely by whale.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_whale_details_author_permlink
          ON vb_whale_vote_details(author, permlink);
        CREATE INDEX IF NOT EXISTS idx_whale_details_enriched_at
          ON vb_whale_vote_details(enriched_at);
        CREATE INDEX IF NOT EXISTS idx_whale_details_community
          ON vb_whale_vote_details(post_community)
          WHERE enriched_at IS NOT NULL AND post_community IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_whale_details_whale
          ON vb_whale_vote_details(whale);
      `);
    }

    // vb_signal_author: CoPilot training columns (growth factor + sp/vp history)
    const vsaCols = (db.prepare("PRAGMA table_info(vb_signal_author)").all() as Array<{name:string}>).map(c=>c.name);
    if (vsaCols.length > 0) {
      if (!vsaCols.includes("avg_sp_per_vp"))     db.exec("ALTER TABLE vb_signal_author ADD COLUMN avg_sp_per_vp REAL");
      if (!vsaCols.includes("sp_per_vp_cv"))      db.exec("ALTER TABLE vb_signal_author ADD COLUMN sp_per_vp_cv REAL");
      if (!vsaCols.includes("avg_growth_factor")) db.exec("ALTER TABLE vb_signal_author ADD COLUMN avg_growth_factor REAL");
      if (!vsaCols.includes("gf_sample_n"))       db.exec("ALTER TABLE vb_signal_author ADD COLUMN gf_sample_n INTEGER");
    }

    // vb_global_vote_outcomes: post-context columns for copilot training data
    const gvoCols = (db.prepare("PRAGMA table_info(vb_global_vote_outcomes)").all() as Array<{name:string}>).map(c=>c.name);
    if (gvoCols.length > 0) {
      if (!gvoCols.includes("post_pending_payout_sbd"))    db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN post_pending_payout_sbd REAL");
      if (!gvoCols.includes("post_active_votes_count"))    db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN post_active_votes_count INTEGER");
      if (!gvoCols.includes("post_net_votes"))             db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN post_net_votes INTEGER");
      if (!gvoCols.includes("post_author_reputation"))     db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN post_author_reputation REAL");
      if (!gvoCols.includes("post_final_payout_sbd"))      db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN post_final_payout_sbd REAL");
      // Autopilot training data — VP split, vote value, community
      if (!gvoCols.includes("vp_before_vote_bps"))  db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN vp_before_vote_bps INTEGER");
      if (!gvoCols.includes("vp_after_vote_bps"))   db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN vp_after_vote_bps INTEGER");
      if (!gvoCols.includes("vote_value_sbd"))       db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN vote_value_sbd REAL");
      if (!gvoCols.includes("post_community"))       db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN post_community TEXT");
      // Model validation columns
      if (!gvoCols.includes("estimated_sp_weight"))      db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN estimated_sp_weight REAL");
      if (!gvoCols.includes("estimated_sp_rshares"))     db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN estimated_sp_rshares REAL");
      if (!gvoCols.includes("steemworld_estimate_sp"))   db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN steemworld_estimate_sp REAL");
      if (!gvoCols.includes("estimation_sbd_per_steem")) db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN estimation_sbd_per_steem REAL");
      if (!gvoCols.includes("estimated_at"))             db.exec("ALTER TABLE vb_global_vote_outcomes ADD COLUMN estimated_at TEXT");
    }

    // CoPilot shadow run log — dry-run decisions written every 30 min, no broadcast
    db.exec(`
      CREATE TABLE IF NOT EXISTS vb_copilot_shadow_runs (
        id                         TEXT PRIMARY KEY,
        run_id                     TEXT NOT NULL,       -- UUID grouping all rows from one 30-min tick
        username                   TEXT NOT NULL,
        run_at                     TEXT NOT NULL,       -- ISO timestamp of the run
        decision                   TEXT NOT NULL,       -- 'would_vote'|'skip_score'|'skip_no_posts'|'skip_already_voted'|'skip_budget'
        author                     TEXT,
        permlink                   TEXT,
        title                      TEXT,
        category                   TEXT,
        post_score                 INTEGER,
        score_gate                 INTEGER,             -- minimum postScore required for this category
        suggested_weight_bps       INTEGER,
        vp_cost_bps                INTEGER,             -- VP units this vote would consume (weight_bps/50)
        expected_vote_usd          REAL,
        reasons_json               TEXT,               -- JSON array of reason strings
        skip_reason                TEXT,               -- human-readable skip reason (null if would_vote)
        vp_bps_at_run              INTEGER,            -- VP at run start (0–10000)
        vp_budget_bps              INTEGER,            -- VP available for this run
        signals_json               TEXT,               -- JSON with all decision signals
        created_at                 TEXT DEFAULT (datetime('now')),
        -- Outcome resolution (filled after 7-day payout window by shadowOutcomeResolverJob)
        outcome_status             TEXT DEFAULT 'unresolved', -- 'unresolved'|'resolved'|'content_missing'|'error'
        resolved_payout_sbd        REAL,               -- total author + curator payout after settlement
        resolved_vote_count        INTEGER,            -- net_votes at resolution time
        resolved_active_votes_count INTEGER,           -- active_votes[] count at resolution time
        resolved_at                TEXT,              -- ISO timestamp of resolution
        -- Shadow model v4 (research) — scored side-by-side with v3 on the SAME candidate.
        -- v4 never broadcasts; the outcome columns above are shared, so v3-vs-v4 needs no join.
        v4_score                   REAL,              -- v4 pGood × 100 (0–100), comparable to post_score
        v4_decision                TEXT,              -- 'would_vote'|'skip_score'|'skip_hard' (null if no candidate)
        v4_components              TEXT,              -- JSON: logit contributions + raw features + pGood/threshold
        v4_version                 TEXT,              -- e.g. 'v4.1-priors'
        author_prior_used          REAL,              -- unknownAuthorPrior applied (NULL when real history used)
        author_history_available   INTEGER            -- 1 = reconstructable author payout history present, else 0
      );
      CREATE INDEX IF NOT EXISTS idx_shadow_username ON vb_copilot_shadow_runs(username, run_at DESC);
      CREATE INDEX IF NOT EXISTS idx_shadow_run_id   ON vb_copilot_shadow_runs(run_id);
      CREATE INDEX IF NOT EXISTS idx_shadow_decision ON vb_copilot_shadow_runs(decision);
    `);

    // Shadow run outcome columns — added after initial table creation, migrate if missing.
    // NOTE: The idx_shadow_outcome_status index is created AFTER the column is guaranteed
    //       to exist, since CREATE INDEX fails if the column is missing.
    const shadowCols = (db.prepare("PRAGMA table_info(vb_copilot_shadow_runs)").all() as Array<{name:string}>).map(c=>c.name);
    if (shadowCols.length > 0) {
      if (!shadowCols.includes("outcome_status"))               db.exec("ALTER TABLE vb_copilot_shadow_runs ADD COLUMN outcome_status TEXT DEFAULT 'unresolved'");
      if (!shadowCols.includes("resolved_payout_sbd"))         db.exec("ALTER TABLE vb_copilot_shadow_runs ADD COLUMN resolved_payout_sbd REAL");
      if (!shadowCols.includes("resolved_vote_count"))         db.exec("ALTER TABLE vb_copilot_shadow_runs ADD COLUMN resolved_vote_count INTEGER");
      if (!shadowCols.includes("resolved_active_votes_count")) db.exec("ALTER TABLE vb_copilot_shadow_runs ADD COLUMN resolved_active_votes_count INTEGER");
      if (!shadowCols.includes("resolved_at"))                 db.exec("ALTER TABLE vb_copilot_shadow_runs ADD COLUMN resolved_at TEXT");
      // Shadow model v4 columns (research) — side-by-side with v3 on the same row.
      if (!shadowCols.includes("v4_score"))                    db.exec("ALTER TABLE vb_copilot_shadow_runs ADD COLUMN v4_score REAL");
      if (!shadowCols.includes("v4_decision"))                 db.exec("ALTER TABLE vb_copilot_shadow_runs ADD COLUMN v4_decision TEXT");
      if (!shadowCols.includes("v4_components"))               db.exec("ALTER TABLE vb_copilot_shadow_runs ADD COLUMN v4_components TEXT");
      if (!shadowCols.includes("v4_version"))                  db.exec("ALTER TABLE vb_copilot_shadow_runs ADD COLUMN v4_version TEXT");
      if (!shadowCols.includes("author_prior_used"))           db.exec("ALTER TABLE vb_copilot_shadow_runs ADD COLUMN author_prior_used REAL");
      if (!shadowCols.includes("author_history_available"))    db.exec("ALTER TABLE vb_copilot_shadow_runs ADD COLUMN author_history_available INTEGER");
    }
    // Partial index on outcome_status — safe to run here because the column now exists
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_shadow_outcome_status ON vb_copilot_shadow_runs(outcome_status)
        WHERE author IS NOT NULL AND permlink IS NOT NULL
    `);

    // VP time-series for autopilot modeling — sampled every 15 min
    db.exec(`
      CREATE TABLE IF NOT EXISTS vb_vp_snapshots (
        username   TEXT NOT NULL,
        sampled_at TEXT NOT NULL,
        vp_bps     INTEGER NOT NULL,
        sp_approx  REAL,
        PRIMARY KEY (username, sampled_at)
      );
      CREATE INDEX IF NOT EXISTS idx_vp_snapshots_user ON vb_vp_snapshots(username, sampled_at);
    `);

    // Daily price history for autopilot backtesting (USD values per day)
    db.exec(`
      CREATE TABLE IF NOT EXISTS vb_price_history (
        date_str   TEXT PRIMARY KEY,   -- YYYY-MM-DD
        steem_usd  REAL,
        sbd_usd    REAL,
        source     TEXT,               -- 'coingecko' | 'steem_feed'
        sampled_at TEXT DEFAULT (datetime('now'))
      );
    `);

    // vote_growth_snapshots: add source + collocated columns if missing, backfill existing rows
    const vgsCols = (db.prepare("PRAGMA table_info(vote_growth_snapshots)").all() as Array<{ name: string }>).map(c => c.name);
    if (vgsCols.length > 0) {
      let viewNeedsRebuild = false;

      if (!vgsCols.includes("source")) {
        db.exec("ALTER TABLE vote_growth_snapshots ADD COLUMN source TEXT NOT NULL DEFAULT 'historical_backfill'");
        db.exec("UPDATE vote_growth_snapshots SET source = 'native' WHERE snapshot_type = 'final'");
        db.exec(`
          UPDATE vote_growth_snapshots
          SET source = 'native'
          WHERE snapshot_type != 'final'
            AND actual_delta_min IS NOT NULL
            AND actual_delta_min <= target_minutes + 45
        `);
        viewNeedsRebuild = true;
      }

      if (!vgsCols.includes("collocated")) {
        db.exec("ALTER TABLE vote_growth_snapshots ADD COLUMN collocated INTEGER NOT NULL DEFAULT 0");
        // Mark rows where multiple snapshot_types share the same (voter,author,permlink,measured_at)
        db.exec(`
          UPDATE vote_growth_snapshots
          SET collocated = 1
          WHERE rowid IN (
            SELECT s.rowid
            FROM vote_growth_snapshots s
            JOIN (
              SELECT voter, author, permlink, measured_at
              FROM vote_growth_snapshots
              GROUP BY voter, author, permlink, measured_at
              HAVING COUNT(*) > 1
            ) dup USING (voter, author, permlink, measured_at)
          )
        `);
        viewNeedsRebuild = true;
      }

      if (viewNeedsRebuild) {
        db.exec("DROP VIEW IF EXISTS vw_growth_features");
        db.exec(`
          CREATE VIEW vw_growth_features AS
          WITH pivoted AS (
            SELECT
              voter, author, permlink,
              MAX(CASE WHEN snapshot_type = 'vote_time' THEN pending_payout_sbd END) AS t0,
              MAX(CASE WHEN snapshot_type = 't5m'       THEN pending_payout_sbd END) AS t5m,
              MAX(CASE WHEN snapshot_type = 't10m'      THEN pending_payout_sbd END) AS t10m,
              MAX(CASE WHEN snapshot_type = 't15m'      THEN pending_payout_sbd END) AS t15m,
              MAX(CASE WHEN snapshot_type = 't1h'       THEN pending_payout_sbd END) AS t1h,
              MAX(CASE WHEN snapshot_type = 't6h'       THEN pending_payout_sbd END) AS t6h,
              MAX(CASE WHEN snapshot_type = 't24h'      THEN pending_payout_sbd END) AS t24h,
              MAX(CASE WHEN snapshot_type = 't72h'      THEN pending_payout_sbd END) AS t72h,
              MAX(CASE WHEN snapshot_type = 'final'     THEN pending_payout_sbd END) AS t_final,
              COUNT(*) AS snapshot_count,
              MIN(CASE WHEN snapshot_type != 'final' THEN source END)     AS timed_source_min,
              MAX(CASE WHEN snapshot_type != 'final' THEN collocated END) AS any_collocated
            FROM vote_growth_snapshots
            GROUP BY voter, author, permlink
          )
          SELECT
            voter, author, permlink,
            t0, t5m, t10m, t15m, t1h, t6h, t24h, t72h, t_final,
            snapshot_count,
            CASE WHEN timed_source_min = 'native' THEN 'native_growth_tracking'
                 ELSE 'historical_backfill'
            END AS population,
            COALESCE(any_collocated, 0) AS has_collocated,
            CASE WHEN t0 > 0 THEN t1h / t0        END AS early_momentum,
            CASE WHEN t0 IS NOT NULL AND t1h IS NOT NULL
                 THEN (t1h - t0) / 60.0           END AS velocity_0_1h,
            CASE WHEN t6h IS NOT NULL AND t24h IS NOT NULL
                 THEN (t24h - t6h) / (18.0 * 60)  END AS velocity_6h_24h,
            CASE WHEN t0 > 0 THEN t_final / t0    END AS growth_factor,
            CASE
              WHEN t_final IS NULL OR t0 IS NULL OR t0 = 0 THEN 'unknown'
              WHEN t_final / t0 < 1.5                       THEN 'flat'
              WHEN t1h IS NOT NULL AND t1h / t0 > 1.8 AND t_final / t0 < 4.0 THEN 'early_spike'
              WHEN t1h IS NOT NULL AND t1h / t0 < 1.3 AND t_final / t0 > 3.0 THEN 'slow_burn'
              ELSE 'unknown'
            END AS trajectory_class
          FROM pivoted
        `);
      }

      // Add whale signal columns if missing (existing DBs)
      if (!vgsCols.includes("whale_count"))              db.exec("ALTER TABLE vote_growth_snapshots ADD COLUMN whale_count INTEGER");
      if (!vgsCols.includes("new_whale_votes"))          db.exec("ALTER TABLE vote_growth_snapshots ADD COLUMN new_whale_votes INTEGER");
      if (!vgsCols.includes("top_voter_account"))        db.exec("ALTER TABLE vote_growth_snapshots ADD COLUMN top_voter_account TEXT");
      if (!vgsCols.includes("top_voter_rshares"))        db.exec("ALTER TABLE vote_growth_snapshots ADD COLUMN top_voter_rshares REAL");
      if (!vgsCols.includes("first_whale_delay_min"))    db.exec("ALTER TABLE vote_growth_snapshots ADD COLUMN first_whale_delay_min REAL");
      if (!vgsCols.includes("time_since_last_vote_min")) db.exec("ALTER TABLE vote_growth_snapshots ADD COLUMN time_since_last_vote_min REAL");
      if (!vgsCols.includes("total_rshares_sum"))        db.exec("ALTER TABLE vote_growth_snapshots ADD COLUMN total_rshares_sum REAL");
      if (!vgsCols.includes("median_rshares"))           db.exec("ALTER TABLE vote_growth_snapshots ADD COLUMN median_rshares REAL");
      if (!vgsCols.includes("whale_voters_json"))        db.exec("ALTER TABLE vote_growth_snapshots ADD COLUMN whale_voters_json TEXT");
      if (!vgsCols.includes("new_whale_voters_json"))    db.exec("ALTER TABLE vote_growth_snapshots ADD COLUMN new_whale_voters_json TEXT");

      // Add t5m/t10m to view if missing (existing DBs where source+collocated already present)
      const existingViewSql = (db.prepare(
        "SELECT sql FROM sqlite_master WHERE type='view' AND name='vw_growth_features'"
      ).get() as { sql: string } | undefined)?.sql ?? '';
      if (!existingViewSql.includes("t5m")) {
        db.exec("DROP VIEW IF EXISTS vw_growth_features");
        db.exec(`
          CREATE VIEW vw_growth_features AS
          WITH pivoted AS (
            SELECT
              voter, author, permlink,
              MAX(CASE WHEN snapshot_type = 'vote_time' THEN pending_payout_sbd END) AS t0,
              MAX(CASE WHEN snapshot_type = 't5m'       THEN pending_payout_sbd END) AS t5m,
              MAX(CASE WHEN snapshot_type = 't10m'      THEN pending_payout_sbd END) AS t10m,
              MAX(CASE WHEN snapshot_type = 't15m'      THEN pending_payout_sbd END) AS t15m,
              MAX(CASE WHEN snapshot_type = 't1h'       THEN pending_payout_sbd END) AS t1h,
              MAX(CASE WHEN snapshot_type = 't6h'       THEN pending_payout_sbd END) AS t6h,
              MAX(CASE WHEN snapshot_type = 't24h'      THEN pending_payout_sbd END) AS t24h,
              MAX(CASE WHEN snapshot_type = 't72h'      THEN pending_payout_sbd END) AS t72h,
              MAX(CASE WHEN snapshot_type = 'final'     THEN pending_payout_sbd END) AS t_final,
              COUNT(*) AS snapshot_count,
              MIN(CASE WHEN snapshot_type != 'final' THEN source END)     AS timed_source_min,
              MAX(CASE WHEN snapshot_type != 'final' THEN collocated END) AS any_collocated
            FROM vote_growth_snapshots
            GROUP BY voter, author, permlink
          )
          SELECT
            voter, author, permlink,
            t0, t5m, t10m, t15m, t1h, t6h, t24h, t72h, t_final,
            snapshot_count,
            CASE WHEN timed_source_min = 'native' THEN 'native_growth_tracking'
                 ELSE 'historical_backfill'
            END AS population,
            COALESCE(any_collocated, 0) AS has_collocated,
            CASE WHEN t0 > 0 THEN t1h / t0        END AS early_momentum,
            CASE WHEN t0 IS NOT NULL AND t1h IS NOT NULL
                 THEN (t1h - t0) / 60.0           END AS velocity_0_1h,
            CASE WHEN t6h IS NOT NULL AND t24h IS NOT NULL
                 THEN (t24h - t6h) / (18.0 * 60)  END AS velocity_6h_24h,
            CASE WHEN t0 > 0 THEN t_final / t0    END AS growth_factor,
            CASE
              WHEN t_final IS NULL OR t0 IS NULL OR t0 = 0 THEN 'unknown'
              WHEN t_final / t0 < 1.5                       THEN 'flat'
              WHEN t1h IS NOT NULL AND t1h / t0 > 1.8 AND t_final / t0 < 4.0 THEN 'early_spike'
              WHEN t1h IS NOT NULL AND t1h / t0 < 1.3 AND t_final / t0 > 3.0 THEN 'slow_burn'
              ELSE 'unknown'
            END AS trajectory_class
          FROM pivoted
        `);
      }
    }

    // ── vb_shadow_growth_snapshots ────────────────────────────────────────────
    // Growth snapshots for CoPilot shadow-mode posts (would_vote + skip_score).
    // Mirrors vote_growth_snapshots but keyed by (username, author, permlink, snapshot_type)
    // so shadow data never conflicts with actual VoteBroker vote snapshots.
    db.exec(`
      CREATE TABLE IF NOT EXISTS vb_shadow_growth_snapshots (
        username              TEXT    NOT NULL,
        author                TEXT    NOT NULL,
        permlink              TEXT    NOT NULL,
        snapshot_type         TEXT    NOT NULL,  -- eval_time, t1h, t6h, t24h, t72h, final
        decision              TEXT,              -- would_vote | skip_score
        target_minutes        INTEGER,
        pending_payout_sbd    REAL,
        active_votes_count    INTEGER,
        measured_at           TEXT    NOT NULL,
        actual_delta_min      REAL,             -- minutes since first_evaluated_at
        first_evaluated_at    TEXT,             -- MIN(run_at) for this username/post
        collocated            INTEGER NOT NULL DEFAULT 0,
        whale_count           INTEGER,
        new_whale_votes       INTEGER,
        whale_voters_json     TEXT,
        new_whale_voters_json TEXT,
        top_voter_account     TEXT,
        top_voter_rshares     REAL,
        first_whale_delay_min REAL,
        time_since_last_vote_min REAL,
        total_rshares_sum     REAL,
        median_rshares        REAL,
        PRIMARY KEY (username, author, permlink, snapshot_type)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sgs_post    ON vb_shadow_growth_snapshots(author, permlink)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sgs_user    ON vb_shadow_growth_snapshots(username)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sgs_type    ON vb_shadow_growth_snapshots(snapshot_type, measured_at)`);

    // ── vb_posts (Post Scanner store) ────────────────────────────────────────
    // Single source of truth for recent Steem posts across all tracked authors.
    // Written by postScannerJob every 90s; read by Opportunity/Shadow scanners
    // instead of making individual RPC calls per author.
    db.exec(`
      CREATE TABLE IF NOT EXISTS vb_posts (
        author              TEXT NOT NULL,
        permlink            TEXT NOT NULL,
        title               TEXT NOT NULL DEFAULT '',
        created             TEXT NOT NULL,
        pending_payout_sbd  REAL NOT NULL DEFAULT 0,
        active_votes_json   TEXT,           -- JSON [{voter,weight}]
        active_votes_count  INTEGER NOT NULL DEFAULT 0,
        parent_permlink     TEXT,
        fetched_at          TEXT NOT NULL,
        PRIMARY KEY (author, permlink)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_vb_posts_author    ON vb_posts(author)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_vb_posts_fetched   ON vb_posts(fetched_at)`);

    // Tracks the last time each author was scanned so readers can decide
    // whether DB data is fresh enough or fall back to a live RPC call.
    db.exec(`
      CREATE TABLE IF NOT EXISTS vb_post_scan_log (
        author      TEXT PRIMARY KEY,
        scanned_at  TEXT NOT NULL,
        post_count  INTEGER NOT NULL DEFAULT 0
      )
    `);

    // ── v_event_chain ─────────────────────────────────────────────────────────
    // Unified per-post event chain: actual VoteBroker votes + shadow-mode observations.
    // Primary research view for "how does growth happen on Steem?"
    db.exec(`DROP VIEW IF EXISTS v_event_chain`);
    db.exec(`
      CREATE VIEW v_event_chain AS
      SELECT
        'actual'            AS source_type,
        voter               AS username,
        author,
        permlink,
        snapshot_type,
        measured_at,
        pending_payout_sbd  AS pool_sbd,
        active_votes_count  AS curators,
        whale_count,
        new_whale_votes,
        whale_voters_json,
        new_whale_voters_json,
        first_whale_delay_min,
        time_since_last_vote_min,
        top_voter_account,
        top_voter_rshares,
        total_rshares_sum,
        median_rshares,
        NULL                AS decision,
        NULL                AS first_evaluated_at
      FROM vote_growth_snapshots

      UNION ALL

      SELECT
        'shadow'            AS source_type,
        username,
        author,
        permlink,
        snapshot_type,
        measured_at,
        pending_payout_sbd  AS pool_sbd,
        active_votes_count  AS curators,
        whale_count,
        new_whale_votes,
        whale_voters_json,
        new_whale_voters_json,
        first_whale_delay_min,
        time_since_last_vote_min,
        top_voter_account,
        top_voter_rshares,
        total_rshares_sum,
        median_rshares,
        decision,
        first_evaluated_at
      FROM vb_shadow_growth_snapshots
    `);
  }
}
