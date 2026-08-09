import 'server-only';

/**
 * Local app-state database (SQLite via better-sqlite3).
 *
 * Holds Prism's own bookkeeping — tables that are never joined against
 * customer data inside Snowflake SQL. The customer's Snowflake keeps the
 * data-plane tables (LITERAL_ALIAS_MATCHES, APPROVED_ALIAS_NAMES,
 * PIPELINE_QUEUE, PIPELINE_FILE_ROWS, streams, export tables).
 *
 * File location: PRISM_SQLITE_PATH (default ./data/prism.db, relative to the
 * stand-ui working directory). Must live on persistent storage — losing it
 * loses accounts and history, though never confirmed mappings (those are in
 * the customer's Snowflake).
 *
 * Migrations: append-only array below; PRAGMA user_version tracks the last
 * applied index. Never edit an existing migration — add a new one. This keeps
 * existing installs upgradeable without a reset.
 *
 * better-sqlite3 is synchronous — no await needed on statements. WAL mode
 * keeps the poller's writes from blocking route reads.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const MIGRATIONS: string[] = [
  // 001 — initial app-state tables (moved out of Snowflake PRISM_DB.INTERNAL).
  // Timestamps are ISO-8601 UTC TEXT. JSON payloads are TEXT.
  `
  CREATE TABLE accounts (
    account_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id       TEXT    NOT NULL UNIQUE,
    email           TEXT    NOT NULL UNIQUE,
    name            TEXT,
    picture_url     TEXT,
    role            TEXT    NOT NULL DEFAULT 'user',
    session_version INTEGER NOT NULL DEFAULT 1,
    creation_nonce  TEXT,
    sf_account      TEXT,
    sf_user         TEXT,
    sf_warehouse    TEXT,
    sf_role         TEXT,
    sf_password     TEXT,
    sf_private_key  TEXT,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_login_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE invitations (
    invitation_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    invited_email   TEXT    NOT NULL,
    invited_by      INTEGER NOT NULL REFERENCES accounts(account_id),
    invited_role    TEXT    NOT NULL DEFAULT 'user',
    token           TEXT    NOT NULL UNIQUE,
    status          TEXT    NOT NULL DEFAULT 'pending',
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    accepted_at     TEXT,
    expires_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now','+7 days'))
  );

  CREATE TABLE domains (
    domain_id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL UNIQUE,
    description           TEXT,
    standardization_rules TEXT,
    convention_type       TEXT,
    convention_value      TEXT,
    convention_rules      TEXT,
    usage_count           INTEGER NOT NULL DEFAULT 0,
    last_used_at          TEXT,
    created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE validation_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    literal_value       TEXT    NOT NULL,
    run_id              INTEGER NOT NULL,
    original_alias_name TEXT    NOT NULL,
    user_changed_to     TEXT,
    llm_decision        TEXT    NOT NULL,
    decided_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE one_time_standardizations (
    ots_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_by      INTEGER,
    session_nonce   TEXT,
    source_relation TEXT    NOT NULL,
    columns         TEXT,
    export_target   TEXT    NOT NULL,
    export_mode     TEXT    NOT NULL,
    convention      TEXT,
    mappings        TEXT,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    exported_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE INDEX idx_invitations_email  ON invitations(invited_email, status);
  CREATE INDEX idx_ots_created_by     ON one_time_standardizations(created_by, exported_at);
  CREATE INDEX idx_validation_run     ON validation_log(run_id);

  INSERT INTO domains (name) VALUES ('Mobile Carriers'), ('Company Names');
  `,

  // 002 — hot app-state tables (Phase 3): RUNS + PIPELINES move out of
  // Snowflake. state / stats_snapshot / file_*_meta are TEXT holding JSON.
  // Booleans are INTEGER 0/1 (export_unmapped_rows).
  `
  CREATE TABLE runs (
    run_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    concept_key     TEXT    NOT NULL DEFAULT 'mobile_carrier',
    source_relation TEXT    NOT NULL DEFAULT '__unknown__',
    source_column   TEXT    NOT NULL DEFAULT '__unknown__',
    domain_id       INTEGER,
    mode            TEXT    NOT NULL DEFAULT 'review',
    run_type        TEXT    NOT NULL DEFAULT 'normal',
    created_by      INTEGER,
    run_status      TEXT    NOT NULL DEFAULT 'created',
    state           TEXT,
    stats_snapshot  TEXT,
    creation_nonce  TEXT,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE pipelines (
    pipeline_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name                 TEXT,
    table_fqn            TEXT    NOT NULL,
    column_name          TEXT    NOT NULL,
    export_table_fqn     TEXT,
    export_kind          TEXT    NOT NULL DEFAULT 'table',
    domain_id            INTEGER NOT NULL,
    source_type          TEXT    NOT NULL DEFAULT 'snowflake',
    file_source_meta     TEXT,
    file_export_meta     TEXT,
    status               TEXT    NOT NULL DEFAULT 'active',
    status_message       TEXT,
    mode                 TEXT    NOT NULL DEFAULT 'auto',
    export_unmapped_rows INTEGER NOT NULL DEFAULT 1,
    queue_size           INTEGER NOT NULL DEFAULT 0,
    total_new_values     INTEGER NOT NULL DEFAULT 0,
    total_mapped         INTEGER NOT NULL DEFAULT 0,
    total_source_values  INTEGER NOT NULL DEFAULT 0,
    last_polled_at       TEXT,
    last_queue_empty_at  TEXT,
    created_by           INTEGER,
    created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT uq_pipelines UNIQUE (table_fqn, column_name, domain_id)
  );

  CREATE INDEX idx_runs_nonce       ON runs(creation_nonce);
  CREATE INDEX idx_runs_one_time    ON runs(run_type, created_by);
  CREATE INDEX idx_pipelines_status ON pipelines(status);
  `,

  // 003 — workspace-level Snowflake service credentials, saved from the /setup
  // onboarding flow by an admin. Single row (id = 1). Secrets are stored
  // app-level encrypted (enc:v1:). When present, these take precedence over the
  // SNOWFLAKE_* env vars for the service connection; env stays as the fallback
  // and operator escape hatch.
  `
  CREATE TABLE workspace_config (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    sf_account     TEXT NOT NULL,
    sf_user        TEXT NOT NULL,
    sf_warehouse   TEXT NOT NULL,
    sf_role        TEXT,
    sf_password    TEXT,
    sf_private_key TEXT,
    configured_by  INTEGER,
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `,

  // 004 — workspace Anthropic API key (the client company's own Anthropic
  // subscription; all LLM grouping/validation calls bill to it). Its own
  // single-row table, deliberately NOT a column on workspace_config: the key
  // can be saved before/without Snowflake credentials (e.g. env-configured
  // Snowflake + UI-configured key). Encrypted at rest (enc:v1:). When present,
  // takes precedence over the ANTHROPIC_API_KEY env var.
  `
  CREATE TABLE workspace_llm_config (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    anthropic_api_key TEXT NOT NULL,
    configured_by     INTEGER,
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `,

  // 005 — multi-provider AI config. `provider` selects the AI provider
  // ('anthropic' | 'openai' | 'gemini'); `anthropic_api_key` (legacy name,
  // kept to avoid a table rebuild) holds the ENCRYPTED credential for
  // whichever provider is active. `model` is the provider-specific model
  // override; NULL = the provider's built-in default.
  `
  ALTER TABLE workspace_llm_config ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic';
  ALTER TABLE workspace_llm_config ADD COLUMN model TEXT;
  `,

  // 006 — update time windows replace the auto/manual pipeline mode.
  // update_schedule is JSON TEXT (see _lib/update-schedule.ts):
  //   {"type":"window","days":[1..5],"start_hour":9,"end_hour":17,"timezone":"…"}
  //   {"type":"always"} | {"type":"manual"}
  // Existing rows keep their old behavior: mode 'manual' → manual, everything
  // else was effectively 24/7 → always. New pipelines default to the 9–5
  // Mon–Fri window at creation (set by the routes, not a column default).
  // The legacy `mode` column stays physically (append-only migrations) but is
  // no longer read or written anywhere; its DEFAULT 'auto' keeps inserts valid.
  `
  ALTER TABLE pipelines ADD COLUMN update_schedule TEXT;
  UPDATE pipelines SET update_schedule =
    CASE WHEN mode = 'manual' THEN '{"type":"manual"}' ELSE '{"type":"always"}' END;
  `,

  // 007 — when the pipeline's standardized output (export table / view /
  // Sheets output tab) was last rebuilt. Stamped by refreshExportTable and
  // syncSheetsColumn; shown on the pipeline cards as "Table updated X ago".
  // NULL until the first rebuild after this migration.
  `
  ALTER TABLE pipelines ADD COLUMN export_updated_at TEXT;
  `,

  // 008 — the ONE customer-facing freshness timestamp: the last time the
  // standardized table was verified FULLY up to date with the source. Advances
  // when (a) a poll checks the source and finds nothing new with an empty
  // queue, or (b) a standardization pass (10-minute tick / manual "Update
  // Standardizations") exports everything and drains the queue. Freezes while
  // values sit queued — an honest "current as of" marker. Replaces the two
  // separate "Last updated" / "Last standardized" displays (export_updated_at
  // stays stamped for ops/debugging but is no longer shown).
  `
  ALTER TABLE pipelines ADD COLUMN fully_synced_at TEXT;
  UPDATE pipelines SET fully_synced_at = COALESCE(export_updated_at, last_queue_empty_at);
  `,

  // 009 — per-pipeline change-detection bookkeeping for the SQL Server port
  // (docs/MSSQL_PORT_PLAN.md Phase 4). detection_mode: 'stream' (Snowflake),
  // 'ct' (SQL Server Change Tracking) or 'diff' (tiered diff scan).
  // detection_state is adapter-owned JSON (CT sync version, diff-scan tier,
  // heartbeat marker, …). Existing rows are Snowflake pipelines → 'stream';
  // file-based pipelines have no detection (poller re-reads them) → NULL.
  `
  ALTER TABLE pipelines ADD COLUMN detection_mode TEXT;
  ALTER TABLE pipelines ADD COLUMN detection_state TEXT;
  UPDATE pipelines SET detection_mode = 'stream'
    WHERE COALESCE(source_type, 'snowflake') = 'snowflake';
  `,

  // 010 — the installation's warehouse choice + SQL Server credentials
  // (SQL Server port Phase 6). warehouse_type on workspace_config is the
  // setup-wizard choice ('snowflake' | 'mssql'; NULL = snowflake, or the
  // PRISM_WAREHOUSE_TYPE env dev switch). ms_* columns hold the SQL Server
  // service connection (ms_password enc:v1: encrypted) on workspace_config,
  // and per-account PERSONAL SQL Server credentials on accounts (one-time
  // flow fallback — the mssql analog of accounts.sf_*).
  `
  ALTER TABLE workspace_config ADD COLUMN warehouse_type TEXT;
  ALTER TABLE workspace_config ADD COLUMN ms_server TEXT;
  ALTER TABLE workspace_config ADD COLUMN ms_port INTEGER;
  ALTER TABLE workspace_config ADD COLUMN ms_database TEXT;
  ALTER TABLE workspace_config ADD COLUMN ms_user TEXT;
  ALTER TABLE workspace_config ADD COLUMN ms_password TEXT;
  ALTER TABLE workspace_config ADD COLUMN ms_encrypt INTEGER;
  ALTER TABLE workspace_config ADD COLUMN ms_trust_server_cert INTEGER;
  ALTER TABLE accounts ADD COLUMN ms_server TEXT;
  ALTER TABLE accounts ADD COLUMN ms_port INTEGER;
  ALTER TABLE accounts ADD COLUMN ms_database TEXT;
  ALTER TABLE accounts ADD COLUMN ms_user TEXT;
  ALTER TABLE accounts ADD COLUMN ms_password TEXT;
  `,

  // 011 — per-column standardization specs replace the shared "domains" concept.
  // Every pipeline column authors its OWN spec: a mandatory description (the LLM
  // concept DEFINITION; the concept NAME comes from the column name), plus the
  // same optional free-text standardization_rules and structured/regex/examples/
  // natural naming convention that domains used to carry — same JSON formats.
  //
  // spec_id becomes the per-column LOOKUP SCOPE: it is stored into the existing
  // integer slots (pipelines.domain_id, runs.domain_id,
  // file_source_meta.columns[].domain_id, and Snowflake
  // APPROVED_ALIAS_NAMES.domain_id / LITERAL_ALIAS_MATCHES.domain_id) — those
  // columns keep the historical name `domain_id` but now hold a spec_id, so the
  // ubiquitous scope-filter SQL is unchanged. pipeline_id/table_fqn/column_name
  // are denormalized for the editor GET and lifecycle cleanup. One spec per
  // (pipeline_id, column_name) is enforced in the routes, not by a hard UNIQUE
  // (the pending_baseline recreate flow deletes+reinserts pipeline rows).
  //
  // The old `domains` table is left in place until migration 012 drops it, so the
  // app stays buildable while the readers are repointed. No row migration: this
  // is pre-launch and the DB is reset via 01_internal_tables.sql + reset-app-state.
  `
  CREATE TABLE column_specs (
    spec_id               INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline_id           INTEGER,
    table_fqn             TEXT,
    column_name           TEXT    NOT NULL,
    description           TEXT    NOT NULL,
    standardization_rules TEXT,
    convention_type       TEXT,
    convention_value      TEXT,
    convention_rules      TEXT,
    created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE INDEX idx_column_specs_pipeline ON column_specs(pipeline_id);
  `,

  // 012 — drop the obsolete `domains` table. All readers were repointed to
  // `column_specs` (migration 011) and the /api/domains routes deleted, so
  // nothing references it anymore. The migration-001 CREATE/seed remains in the
  // append-only history (it ran once); this removes the now-dead table.
  `
  DROP TABLE IF EXISTS domains;
  `,

  // 013 — explicit per-pipeline consent before Prism attempts to enable SQL
  // Server Change Tracking automatically. ALTER DATABASE / ALTER TABLE are
  // schema-modifying DDL, so — mirroring the Column output mode's consent
  // gate — Prism must never run them (via the service login OR the creator's
  // personal credentials) without the customer opting in for that table.
  // Default 0: pre-existing pipelines keep the safe (never auto-escalate)
  // behavior until the creator explicitly re-consents from the UI.
  `
  ALTER TABLE pipelines ADD COLUMN change_tracking_consent INTEGER NOT NULL DEFAULT 0;
  `,

  // 014 — machine-readable code alongside status_message, so the UI can offer
  // a specific fix action (e.g. "grant this automatically") instead of just
  // displaying text. NULL for ordinary pauses/flags; a known code only when
  // there's a real recovery action attached to it. Currently used for
  // 'table_mode_access' (mssql table-export CREATE TABLE/ALTER ON SCHEMA
  // missing) — see provisionTableModeAccess.
  `
  ALTER TABLE pipelines ADD COLUMN status_reason TEXT;
  `,

  // 015 — data residency: customer VALUES no longer rest in SQLite.
  // The run review state blob moved to the warehouse (INTERNAL.RUN_STATE);
  // the export-referee audit trail moved to warehouse VALIDATION_LOG; the
  // one-time archive no longer stores its mappings JSON (reconstructed on
  // demand from RUN_STATE). runs.state and one_time_standardizations.mappings
  // stay as physically-present-but-dead columns (append-only migrations);
  // this migration scrubs any values already written by earlier builds.
  // Pre-launch installs typically reset via 01_internal_tables.sql anyway —
  // this makes the guarantee true for long-lived dev databases too.
  `
  UPDATE runs SET state = NULL;
  UPDATE one_time_standardizations SET mappings = NULL;
  DROP TABLE IF EXISTS validation_log;
  `,

  // 016 — pipelines are warehouse-only.
  //
  // Files, Google Sheets and pasted lists moved to the ONE-TIME flow: a
  // pipeline exists to keep a LIVE source standardized on a schedule, and a
  // spreadsheet had to be polled every 60 seconds to pretend it was one.
  // With the file-pipeline path deleted, these three columns have no reader
  // and no writer left.
  //
  // Genuinely DROPPED rather than left dead (unlike runs.state above, which is
  // referenced by older code paths): nothing reads them, and leaving a
  // `source_type` on a table where every row is the same source invites future
  // code to branch on a distinction that no longer exists.
  //
  // Migration 002 still CREATEs these and 009 still reads source_type: the
  // array is APPEND-ONLY, so historical migrations are left exactly as they
  // ran. A fresh database therefore creates the three columns and drops them
  // here, which costs nothing and keeps the migration history truthful —
  // rewriting 002 would make it disagree with every database it has already
  // built.
  //
  // ALTER TABLE ... DROP COLUMN needs SQLite 3.35+ (2021); better-sqlite3
  // bundles far newer.
  `
  ALTER TABLE pipelines DROP COLUMN source_type;
  ALTER TABLE pipelines DROP COLUMN file_source_meta;
  ALTER TABLE pipelines DROP COLUMN file_export_meta;
  `,
];

let _db: Database.Database | null = null;

function resolveDbPath(): string {
  const p = process.env.PRISM_SQLITE_PATH?.trim() || path.join(process.cwd(), 'data', 'prism.db');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

function applyPendingMigrations(db: Database.Database): void {
  const applied = Number(db.pragma('user_version', { simple: true }));
  for (let i = applied; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

/** Singleton handle. Survives Next.js hot-reloads via a global, like the poller. */
export function getDb(): Database.Database {
  if (_db) return _db;
  const g = globalThis as any;
  if (g.__prismSqlite) {
    _db = g.__prismSqlite;
    // Hot-reload path: the handle survives via the global, but this module was
    // re-evaluated — possibly with NEW migrations appended to the array. Without
    // this, a dev server running since before a migration was written would
    // execute new query code against the old schema ("no such column" — this
    // happened). One pragma read per module reload; no-op when up to date.
    applyPendingMigrations(_db!);
    return _db!;
  }

  const db = new Database(resolveDbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  applyPendingMigrations(db);

  g.__prismSqlite = db;
  _db = db;
  return db;
}

/** Current UTC timestamp in the same ISO format the schema defaults use. */
export function sqliteNow(): string {
  return new Date().toISOString();
}
