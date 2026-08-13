-- ============================================================================
-- Prism internal tables — MICROSOFT SQL SERVER install script
-- (T-SQL port of 00_bootstrap.sql + 01_internal_tables.sql; see
--  docs/MSSQL_PORT_PLAN.md Phase 3 and docs/WAREHOUSES.md.)
--
-- CUSTOMER INSTALL SCRIPT — everything Prism requires on the customer's SQL
-- Server. Contains NO demo or test data — that lives in 02_demo_data.mssql.sql
-- (dev/demo only, never run on a customer server).
--
-- Run as a sysadmin / db_owner-capable login:
--   sqlcmd -S <server> -U sa -i 01_internal_tables.mssql.sql
-- or via the dev runner (which also runs the demo-data file):
--   cd stand-ui && npm run mssql:install
--
-- Differences from the Snowflake script, by design:
--   * NO PRISM_NORMALIZE function — normalization is app-side only
--     (normalizeLiteral in TypeScript); SQL-side joins use exact-match staging
--     tables with BIN2 collation (plan decision 2.2).
--   * NO warehouse — SQL Server bills provisioned capacity, not wake-time.
--   * NO streams — change detection is Change Tracking / diff scans (Phase 4).
--   * String columns that participate in matching/uniqueness use
--     COLLATE Latin1_General_100_BIN2: SQL Server's default collations are
--     case-INsensitive, which would silently merge values Snowflake (and the
--     app) treat as distinct.
--   * Bounded NVARCHAR lengths on unique-indexed columns (SQL Server caps
--     nonclustered index keys at 1700 bytes): literal_value NVARCHAR(800),
--     alias_name NVARCHAR(450). The app caps alias names at 200 chars already;
--     800-char literals are far beyond any sane categorical value.
-- ============================================================================

-- ── Database ────────────────────────────────────────────────────────────────
IF DB_ID('PRISM_DB') IS NULL
  CREATE DATABASE PRISM_DB;
GO

USE PRISM_DB;
GO

-- ── Schemas ─────────────────────────────────────────────────────────────────
-- INTERNAL: Prism's data plane (mirrors PRISM_DB.INTERNAL on Snowflake).
-- EXPORTS:  default destination for lookup-table exports. (Snowflake used
--           PRISM_DB.PUBLIC; "public" collides with SQL Server's built-in
--           database role, so the mssql install uses EXPORTS.)
IF SCHEMA_ID('INTERNAL') IS NULL
  EXEC('CREATE SCHEMA INTERNAL');
IF SCHEMA_ID('EXPORTS') IS NULL
  EXEC('CREATE SCHEMA EXPORTS');
GO

-- ============================================================================
-- DATA-PLANE TABLES (dropped and recreated — dev-reset semantics, same as the
-- Snowflake script's CREATE OR REPLACE)
-- ============================================================================

DROP TABLE IF EXISTS INTERNAL.LITERAL_ALIAS_MATCHES;
DROP TABLE IF EXISTS INTERNAL.APPROVED_ALIAS_NAMES;
DROP TABLE IF EXISTS INTERNAL.PIPELINE_QUEUE;
DROP TABLE IF EXISTS INTERNAL.ONE_TIME_FILE_ROWS;
DROP TABLE IF EXISTS INTERNAL.ONE_TIME_FILE_BLOBS;
DROP TABLE IF EXISTS INTERNAL.RUN_STATE;
DROP TABLE IF EXISTS INTERNAL.VALIDATION_LOG;
GO

-- ----------------------------------------------------------------------------
-- PIPELINE_QUEUE — values detected by polling, waiting for the next
-- standardization tick. pipeline_id is a cross-store ref to SQLite.
-- ----------------------------------------------------------------------------
CREATE TABLE INTERNAL.PIPELINE_QUEUE (
    queue_id         INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    pipeline_id      INT               NOT NULL,
    literal_value    NVARCHAR(800) COLLATE Latin1_General_100_BIN2 NOT NULL,
    source_frequency INT               NOT NULL CONSTRAINT DF_PQ_freq DEFAULT 1,
    detected_at      DATETIME2(3)      NOT NULL CONSTRAINT DF_PQ_at   DEFAULT SYSUTCDATETIME(),
    CONSTRAINT uq_pipeline_queue UNIQUE (pipeline_id, literal_value)
);
GO

-- ----------------------------------------------------------------------------
-- APPROVED_ALIAS_NAMES — catalog of confirmed canonical names.
-- domain_id is a HISTORICAL name: it now holds a SQLite column_specs.spec_id
-- (the per-column lookup scope; domains were removed). UNIQUE(alias_name,
-- domain_id): note SQL Server treats NULLs as EQUAL in unique constraints
-- (Snowflake treats them as distinct) — at most ONE scopeless (NULL) row per
-- name, which matches app semantics (scopeless aliases are deduped by name
-- anyway).
-- ----------------------------------------------------------------------------
CREATE TABLE INTERNAL.APPROVED_ALIAS_NAMES (
    alias_id     INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    alias_name   NVARCHAR(450) COLLATE Latin1_General_100_BIN2 NOT NULL,
    domain_id    INT               NULL,      -- SQLite column_specs.spec_id (per-column scope; historical name)
    usage_count  INT               NOT NULL CONSTRAINT DF_AAN_usage DEFAULT 0,
    last_used_at DATETIME2(3)      NULL,
    CONSTRAINT uq_approved_alias_names UNIQUE (alias_name, domain_id)
);
GO

-- ----------------------------------------------------------------------------
-- LITERAL_ALIAS_MATCHES — confirmed literal → alias mappings.
-- normalized_value = normalizeLiteral(literal_value), computed in the APP at
-- write time (there is no SQL-side normalize function on this warehouse).
-- Every INSERT/MERGE must set it. Indexed for the staging-table joins.
-- ----------------------------------------------------------------------------
CREATE TABLE INTERNAL.LITERAL_ALIAS_MATCHES (
    match_id         INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    literal_value    NVARCHAR(800) COLLATE Latin1_General_100_BIN2 NOT NULL,
    normalized_value NVARCHAR(800) COLLATE Latin1_General_100_BIN2 NULL,
    alias_id         INT               NOT NULL
                     CONSTRAINT FK_LAM_alias REFERENCES INTERNAL.APPROVED_ALIAS_NAMES(alias_id),
    domain_id        INT               NULL,  -- SQLite column_specs.spec_id (per-column scope; denormalized from alias)
    run_id           INT               NOT NULL,  -- SQLite runs.run_id (0 = seed sentinel)
    confirmed_at     DATETIME2(3)      NOT NULL CONSTRAINT DF_LAM_at DEFAULT SYSUTCDATETIME()
);
CREATE NONCLUSTERED INDEX IX_LAM_normalized ON INTERNAL.LITERAL_ALIAS_MATCHES (normalized_value, domain_id);
GO


-- ----------------------------------------------------------------------------
-- ONE_TIME_FILE_ROWS — row snapshot for a ONE-TIME standardization sourced
-- from an uploaded file or a Google Sheet. Keyed by the session nonce (one-time
-- sessions have no pipeline_id).
--
-- A one-time session spans upload -> review -> export, so the rows must outlive
-- the upload request; the export reproduces every source row with the
-- standardized columns substituted. Held in the warehouse rather than SQLite
-- because these are customer VALUES (data-residency rule).
--
-- The index is NONCLUSTERED because the clustered index key limit is 900 bytes
-- and session_nonce is variable-width.
-- ----------------------------------------------------------------------------
CREATE TABLE INTERNAL.ONE_TIME_FILE_ROWS (
    row_id        INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    session_nonce NVARCHAR(100)     NOT NULL,
    row_num       INT               NOT NULL,
    column_data   NVARCHAR(MAX)     NOT NULL CONSTRAINT CK_OTFR_json CHECK (ISJSON(column_data) = 1),
    created_at    DATETIME2(3)      NOT NULL CONSTRAINT DF_OTFR_at DEFAULT SYSUTCDATETIME()
);
CREATE NONCLUSTERED INDEX IX_OTFR_session ON INTERNAL.ONE_TIME_FILE_ROWS (session_nonce, row_num);
GO

-- ----------------------------------------------------------------------------
-- RUN_STATE — the run review state blob (data residency).
-- One JSON blob per run holding the full grouping/review state, which
-- contains the customer's distinct column values. It lives warehouse-side so
-- no customer values rest in the app's local SQLite (which keeps only run
-- metadata). The optimistic-concurrency revision lives INSIDE the blob
-- ($.rev; missing = 0) — the app's rev-checked save compares it via
-- JSON_VALUE. run_id is a cross-store ref to SQLite runs.
-- ----------------------------------------------------------------------------
-- ----------------------------------------------------------------------------
-- ONE_TIME_FILE_BLOBS — original uploaded file bytes (base64, chunked) for
-- the edit-in-place round trip (see the Snowflake script's comment).
-- ----------------------------------------------------------------------------
CREATE TABLE INTERNAL.ONE_TIME_FILE_BLOBS (
    session_nonce NVARCHAR(100)  NOT NULL,
    chunk_num     INT            NOT NULL,
    file_name     NVARCHAR(400)  NOT NULL,
    file_kind     NVARCHAR(10)   NOT NULL,
    sheet_name    NVARCHAR(400)  NULL,
    header_row    INT            NOT NULL,
    data          NVARCHAR(MAX)  NOT NULL,
    created_at    DATETIME2(3)   NOT NULL CONSTRAINT DF_OTFB_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_OTFB PRIMARY KEY (session_nonce, chunk_num)
);
GO

CREATE TABLE INTERNAL.RUN_STATE (
    run_id      INT               NOT NULL PRIMARY KEY,
    state       NVARCHAR(MAX)     NULL CONSTRAINT CK_RS_json CHECK (state IS NULL OR ISJSON(state) = 1),
    updated_at  DATETIME2(3)      NOT NULL CONSTRAINT DF_RS_at DEFAULT SYSUTCDATETIME()
);
GO

-- ----------------------------------------------------------------------------
-- VALIDATION_LOG — append-only audit trail of export-referee decisions.
-- Contains literal source values, so it lives warehouse-side (data residency).
-- Column widths mirror LITERAL_ALIAS_MATCHES / APPROVED_ALIAS_NAMES bounds.
-- ----------------------------------------------------------------------------
CREATE TABLE INTERNAL.VALIDATION_LOG (
    id                  INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    literal_value       NVARCHAR(800)     NOT NULL,
    run_id              INT               NULL,
    original_alias_name NVARCHAR(450)     NULL,
    user_changed_to     NVARCHAR(450)     NULL,
    llm_decision        NVARCHAR(20)      NULL,  -- 'user' | 'original'
    decided_at          DATETIME2(3)      NOT NULL CONSTRAINT DF_VL_at DEFAULT SYSUTCDATETIME()
);
GO

-- ============================================================================
-- ROLES AND GRANTS
-- Database roles mirror the Snowflake roles. Schema-level grants cover future
-- tables automatically (no FUTURE TABLES construct needed).
-- ============================================================================

IF DATABASE_PRINCIPAL_ID('PRISM_SERVICE') IS NULL
  CREATE ROLE PRISM_SERVICE;
IF DATABASE_PRINCIPAL_ID('PRISM_DATA_ADMIN') IS NULL
  CREATE ROLE PRISM_DATA_ADMIN;
IF DATABASE_PRINCIPAL_ID('PRISM_READONLY') IS NULL
  CREATE ROLE PRISM_READONLY;
GO

-- Service role: full data access on INTERNAL, create/replace export tables in
-- EXPORTS. (Creating a table needs the db-level CREATE TABLE permission PLUS
-- ALTER on the target schema.)
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::INTERNAL TO PRISM_SERVICE;
GRANT ALTER                           ON SCHEMA::INTERNAL TO PRISM_SERVICE;  -- staging tables (Phase 5)
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::EXPORTS  TO PRISM_SERVICE;
GRANT ALTER                           ON SCHEMA::EXPORTS  TO PRISM_SERVICE;
GRANT CREATE TABLE TO PRISM_SERVICE;
GRANT CREATE VIEW  TO PRISM_SERVICE;

-- Human maintenance role: direct data access on INTERNAL only (break-glass).
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::INTERNAL TO PRISM_DATA_ADMIN;

-- Read-only tier (reserved).
GRANT SELECT ON SCHEMA::INTERNAL TO PRISM_READONLY;
GO

-- ── Service login (template — run with real values; never commit a password) ─
-- The Prism backend connects as a machine identity, never a person:
--
--   CREATE LOGIN prism_svc WITH PASSWORD = '<strong generated password>';
--   USE PRISM_DB;
--   CREATE USER prism_svc FOR LOGIN prism_svc;
--   ALTER ROLE PRISM_SERVICE ADD MEMBER prism_svc;
--
-- Kill switch (instant, customer-controlled):  ALTER LOGIN prism_svc DISABLE;
--
-- For each SOURCE database Prism should read (one block per DB):
--   USE <source_db>;
--   CREATE USER prism_svc FOR LOGIN prism_svc;
--   GRANT SELECT ON SCHEMA::<schema> TO prism_svc;
--
-- Change Tracking (fast-path detection — Phase 4; optional but recommended):
--   ALTER DATABASE <source_db> SET CHANGE_TRACKING = ON
--     (CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON);
--   ALTER TABLE <schema>.<table> ENABLE CHANGE_TRACKING;   -- requires a PK
--   GRANT VIEW CHANGE TRACKING ON <schema>.<table> TO prism_svc;
--
-- Cheap diff-scan heartbeat (optional, but recommended when Change Tracking
-- is NOT enabled above). Lets Prism read the table's last-write time from
-- server bookkeeping, so an idle table is skipped without reading it at all:
--   GRANT VIEW SERVER STATE TO prism_svc;   -- (server-level; on Azure SQL DB:
--                                           --  GRANT VIEW DATABASE STATE)
-- Without it Prism cannot tell an idle table from a changed one for free, and
-- falls back to scanning the watched column no more than once every 5 minutes
-- (instead of skipping the read entirely). Detection of new values is then up
-- to ~5 minutes slower, and because standardization runs on a fixed 10-minute
-- schedule, a new value can occasionally wait one extra cycle before it appears
-- in the standardized output. Nothing breaks either way — this is a load/latency
-- trade, and it only applies to tables using diff-scan detection.

-- (The TEST_DB demo source table is dev-only and lives in
--  02_demo_data.mssql.sql — never run that file on a customer server.)

-- ── Verification ─────────────────────────────────────────────────────────────
-- SELECT name FROM PRISM_DB.sys.tables;                       -- 6 tables
-- SELECT name, type_desc FROM PRISM_DB.sys.database_principals WHERE type = 'R' AND name LIKE 'PRISM%';
