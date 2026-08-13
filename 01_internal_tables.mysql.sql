-- ============================================================================
-- Prism internal tables — MYSQL install script
-- (MySQL port of 00_bootstrap.sql + 01_internal_tables.sql; see
--  docs/MYSQL_PORT_PLAN.md Phase M1 and docs/WAREHOUSES.md.)
--
-- CUSTOMER INSTALL SCRIPT — everything Prism requires on the customer's MySQL
-- server. Contains NO demo or test data — that lives in 02_demo_data.mysql.sql
-- (dev/demo only, never run on a customer server).
--
-- Run as root / an admin account:
--   mysql -h <host> -u root -p < 01_internal_tables.mysql.sql
-- or via the dev runner (which also runs the demo-data file):
--   cd stand-ui && npm run mysql:install
--
-- Requires MySQL 8.0.13+ (functional key parts — see the uniqueness notes).
--
-- Differences from the Snowflake script, by design:
--   * MySQL has NO schema level inside a database (CREATE SCHEMA is an alias
--     for CREATE DATABASE), and cross-database queries work freely — so Prism
--     gets two sibling DATABASES: prism_internal (data plane) and
--     prism_exports (default export destination). Lowercase names throughout:
--     table-name case sensitivity is OS-dependent (lower_case_table_names).
--   * NO PRISM_NORMALIZE function — normalization is app-side only
--     (normalizeLiteral in TypeScript); SQL-side joins use exact-match staging
--     tables under utf8mb4_bin (plan decision 2.3).
--   * NO warehouse — MySQL bills provisioned capacity, not wake-time.
--   * String columns that participate in matching/uniqueness use
--     CHARACTER SET utf8mb4 COLLATE utf8mb4_bin (byte-wise): MySQL's default
--     collations are case-INsensitive (utf8mb4_0900_ai_ci), which would
--     silently merge values the app treats as distinct.
--   * Scopeless-row uniqueness (NULL domain_id) uses FUNCTIONAL KEY PARTS
--     with a COALESCE(-1) sentinel: MySQL has no partial indexes, and plain
--     UNIQUE treats NULLs as always-distinct (unlimited NULL duplicates).
--     -1 is unreachable (spec_ids are positive SQLite autoincrements).
-- ============================================================================

-- ── Databases ───────────────────────────────────────────────────────────────
CREATE DATABASE IF NOT EXISTS prism_internal
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS prism_exports
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

USE prism_internal;

-- ============================================================================
-- DATA-PLANE TABLES (dropped and recreated — dev-reset semantics, same as the
-- Snowflake script's CREATE OR REPLACE)
-- ============================================================================

DROP TABLE IF EXISTS prism_internal.literal_alias_matches;
DROP TABLE IF EXISTS prism_internal.approved_alias_names;
DROP TABLE IF EXISTS prism_internal.pipeline_queue;
DROP TABLE IF EXISTS prism_internal.one_time_file_rows;
DROP TABLE IF EXISTS prism_internal.one_time_file_blobs;
DROP TABLE IF EXISTS prism_internal.run_state;
DROP TABLE IF EXISTS prism_internal.validation_log;

-- ----------------------------------------------------------------------------
-- pipeline_queue — values detected by polling, waiting for the next
-- standardization tick. pipeline_id is a cross-store ref to SQLite.
-- ----------------------------------------------------------------------------
CREATE TABLE prism_internal.pipeline_queue (
    queue_id         INT AUTO_INCREMENT PRIMARY KEY,
    pipeline_id      INT          NOT NULL,
    literal_value    VARCHAR(800) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    source_frequency INT          NOT NULL DEFAULT 1,
    detected_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    -- 800-char utf8mb4 key = 3200 bytes, within InnoDB's 3072-byte limit? NO —
    -- so the unique key uses a 750-char prefix... deliberately NOT: prefix
    -- uniqueness would silently merge long values. Instead the key is on a
    -- functional SHA hash of the literal (deterministic, collision-safe for
    -- dedup purposes, and well under the key limit).
    UNIQUE KEY uq_pipeline_queue (pipeline_id, (SHA2(literal_value, 256)))
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- approved_alias_names — catalog of confirmed canonical names.
-- domain_id is a HISTORICAL name: it holds a SQLite column_specs.spec_id (the
-- per-column lookup scope; domains were removed).
-- Functional key: COALESCE(-1) sentinel makes NULL scopes collide like values
-- (at most ONE scopeless row per name — the app invariant), and gives
-- INSERT … ON DUPLICATE KEY UPDATE its target.
-- ----------------------------------------------------------------------------
CREATE TABLE prism_internal.approved_alias_names (
    alias_id     INT AUTO_INCREMENT PRIMARY KEY,
    alias_name   VARCHAR(450) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    domain_id    INT          NULL,      -- SQLite column_specs.spec_id (per-column scope; historical name)
    usage_count  INT          NOT NULL DEFAULT 0,
    last_used_at DATETIME(3)  NULL,
    UNIQUE KEY uq_approved_alias_names ((COALESCE(domain_id, -1)), alias_name)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- literal_alias_matches — confirmed literal → alias mappings.
-- normalized_value = normalizeLiteral(literal_value), computed in the APP at
-- write time. Every INSERT/upsert must set it. The functional unique key both
-- serves ON DUPLICATE KEY UPDATE and mechanically ENFORCES the documented
-- "at most one row per (normalized_value, spec)" invariant (hash form for the
-- same InnoDB key-length reason as pipeline_queue).
-- ----------------------------------------------------------------------------
CREATE TABLE prism_internal.literal_alias_matches (
    match_id         INT AUTO_INCREMENT PRIMARY KEY,
    literal_value    VARCHAR(800) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    normalized_value VARCHAR(800) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    alias_id         INT          NOT NULL,
    domain_id        INT          NULL,  -- SQLite column_specs.spec_id (per-column scope; denormalized from alias)
    run_id           INT          NOT NULL,  -- SQLite runs.run_id (0 = seed sentinel)
    confirmed_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_lam_norm ((COALESCE(domain_id, -1)), (SHA2(normalized_value, 256))),
    KEY ix_lam_normalized (normalized_value(191), domain_id),
    CONSTRAINT fk_lam_alias FOREIGN KEY (alias_id)
      REFERENCES prism_internal.approved_alias_names (alias_id)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- one_time_file_rows — row snapshot for a ONE-TIME standardization sourced
-- from an uploaded file or a Google Sheet. Keyed by the session nonce.
-- Held in the warehouse rather than SQLite because these are customer VALUES
-- (data-residency rule). column_data is native JSON — validates on write.
-- ----------------------------------------------------------------------------
CREATE TABLE prism_internal.one_time_file_rows (
    row_id        INT AUTO_INCREMENT PRIMARY KEY,
    session_nonce VARCHAR(100) NOT NULL,
    row_num       INT          NOT NULL,
    column_data   JSON         NOT NULL,
    created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY ix_otfr_session (session_nonce, row_num)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- one_time_file_blobs — original uploaded file bytes (base64, chunked) for
-- the edit-in-place round trip (see the Snowflake script's comment).
-- LONGTEXT: TEXT caps at 64 KB; chunks are ~6 MB.
-- ----------------------------------------------------------------------------
CREATE TABLE prism_internal.one_time_file_blobs (
    session_nonce VARCHAR(100)  NOT NULL,
    chunk_num     INT           NOT NULL,
    file_name     VARCHAR(400)  NOT NULL,
    file_kind     VARCHAR(10)   NOT NULL,
    sheet_name    VARCHAR(400)  NULL,
    header_row    INT           NOT NULL,
    data          LONGTEXT      NOT NULL,
    created_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (session_nonce, chunk_num)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- run_state — the run review state blob (data residency).
-- One JSON blob per run holding the full grouping/review state (the
-- customer's distinct column values). The optimistic-concurrency revision
-- lives INSIDE the blob ($.rev; missing = 0) — the app's rev-checked save
-- compares COALESCE(CAST(state->>'$.rev' AS SIGNED), 0).
-- ----------------------------------------------------------------------------
CREATE TABLE prism_internal.run_state (
    run_id      INT          NOT NULL PRIMARY KEY,
    state       JSON         NULL,
    updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- validation_log — append-only audit trail of export-referee decisions.
-- Contains literal source values, so it lives warehouse-side (data residency).
-- ----------------------------------------------------------------------------
CREATE TABLE prism_internal.validation_log (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    literal_value       VARCHAR(800) NOT NULL,
    run_id              INT          NULL,
    original_alias_name VARCHAR(450) NULL,
    user_changed_to     VARCHAR(450) NULL,
    llm_decision        VARCHAR(20)  NULL,  -- 'user' | 'original'
    decided_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

-- ============================================================================
-- ROLES AND GRANTS (MySQL 8.0 roles)
-- ============================================================================

CREATE ROLE IF NOT EXISTS 'prism_service', 'prism_data_admin', 'prism_readonly';

-- Service role: full data access on prism_internal, create/replace export
-- tables and views in prism_exports (CREATE/DROP cover the rebuild swap;
-- CREATE VIEW for the view export kind).
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, CREATE VIEW ON prism_internal.* TO 'prism_service';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, CREATE VIEW ON prism_exports.*  TO 'prism_service';

-- Human maintenance role: direct data access on prism_internal only
-- (break-glass; grant to a person when a concrete need appears, revoke after).
GRANT SELECT, INSERT, UPDATE, DELETE ON prism_internal.* TO 'prism_data_admin';

-- Read-only tier (reserved).
GRANT SELECT ON prism_internal.* TO 'prism_readonly';

-- ── Service account (template — run with real values; never commit a password) ─
-- The Prism backend connects as a machine identity, never a person:
--
--   CREATE USER 'prism_svc'@'%' IDENTIFIED BY '<strong generated password>';
--   GRANT 'prism_service' TO 'prism_svc'@'%';
--   SET DEFAULT ROLE 'prism_service' TO 'prism_svc'@'%';
--
-- Kill switch (instant, customer-controlled):
--   ALTER USER 'prism_svc'@'%' ACCOUNT LOCK;
--
-- For each SOURCE database Prism should read (database-wide SELECT is the
-- FUTURE-TABLES analog — it covers new tables automatically):
--   GRANT SELECT ON <source_db>.* TO 'prism_svc'@'%';
--
-- Change detection needs NO extra grants or setup — Prism uses scheduled
-- scans gated by information_schema write timestamps (readable with SELECT).

-- (The test_sources demo database is dev-only and lives in
--  02_demo_data.mysql.sql — never run that file on a customer server.)

-- ── Verification ─────────────────────────────────────────────────────────────
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'prism_internal';  -- 6 tables
-- SELECT DISTINCT from_user FROM mysql.role_edges;  -- role grants
