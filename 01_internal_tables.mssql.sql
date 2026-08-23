-- ============================================================================
-- Prism install script — MICROSOFT SQL SERVER
--
-- Everything Prism requires inside your SQL Server: one new database
-- (PRISM_DB) with Prism's internal tables and roles. It creates nothing
-- outside PRISM_DB and does not touch any of your own databases or data.
--
-- Run as a sysadmin / db_owner-capable login, e.g.:
--   sqlcmd -S <server> -U <admin_login> -i 01_internal_tables.mssql.sql
-- (or paste it into SQL Server Management Studio / Azure Data Studio).
--
-- ⚠️ Re-running this script RESETS Prism's internal tables (confirmed
-- mappings, queued values). Run it once at install time; re-run only if you
-- intend to start Prism over from scratch.
--
-- Two choices you may notice in the table definitions:
--   * Columns that participate in matching use COLLATE
--     Latin1_General_100_BIN2 — SQL Server's default collations are
--     case-INsensitive, which would silently merge raw values Prism must
--     keep distinct.
--   * NVARCHAR lengths on unique-indexed columns are bounded (SQL Server
--     caps nonclustered index keys at 1700 bytes): literal_value
--     NVARCHAR(800), alias_name NVARCHAR(450).
-- ============================================================================

-- ── Database ────────────────────────────────────────────────────────────────
IF DB_ID('PRISM_DB') IS NULL
  CREATE DATABASE PRISM_DB;
GO

USE PRISM_DB;
GO

-- ── Schemas ─────────────────────────────────────────────────────────────────
-- INTERNAL: Prism's data plane (lookup tables, queue, run state).
-- EXPORTS:  default destination for lookup-table exports.
IF SCHEMA_ID('INTERNAL') IS NULL
  EXEC('CREATE SCHEMA INTERNAL');
IF SCHEMA_ID('EXPORTS') IS NULL
  EXEC('CREATE SCHEMA EXPORTS');
GO

-- ============================================================================
-- DATA-PLANE TABLES (dropped and recreated — this is what makes a re-run a
-- full reset of Prism's internal data)
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
-- standardization tick. pipeline_id references Prism's app-side pipeline
-- record.
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
-- domain_id is a historical column name: it holds the per-column spec id
-- that scopes each column's lookup. UNIQUE(alias_name, domain_id): SQL
-- Server treats NULLs as EQUAL in unique constraints, so there is at most
-- ONE scopeless (NULL) row per name — which matches Prism's semantics.
-- ----------------------------------------------------------------------------
CREATE TABLE INTERNAL.APPROVED_ALIAS_NAMES (
    alias_id     INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    alias_name   NVARCHAR(450) COLLATE Latin1_General_100_BIN2 NOT NULL,
    domain_id    INT               NULL,      -- Prism's per-column spec id (lookup scope; historical name)
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
    domain_id        INT               NULL,  -- Prism's per-column spec id (denormalized from alias)
    run_id           INT               NOT NULL,  -- Prism's app-side run id (0 = seed sentinel)
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
-- standardized columns substituted. Held here, in your SQL Server, because
-- the rows contain your data values (data residency).
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
-- contains your distinct column values. It lives here, in YOUR SQL Server,
-- so no data values ever rest in the Prism application's own storage (which
-- keeps only run metadata). The optimistic-concurrency revision lives INSIDE
-- the blob ($.rev; missing = 0). run_id references Prism's app-side run
-- record.
-- ----------------------------------------------------------------------------
-- ----------------------------------------------------------------------------
-- ONE_TIME_FILE_BLOBS — original uploaded file bytes (base64, chunked), so a
-- one-time standardization can hand back your own file with only the
-- standardized cells changed. Stored here, in your SQL Server, for the same
-- data-residency reason as RUN_STATE.
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
-- Prism's least-privilege access model. Schema-level grants cover future
-- tables automatically.
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
GRANT ALTER                           ON SCHEMA::INTERNAL TO PRISM_SERVICE;  -- staging tables
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
-- Change Tracking (fast-path detection; optional but recommended):
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

-- ── Verification ─────────────────────────────────────────────────────────────
-- SELECT name FROM PRISM_DB.sys.tables;                       -- 7 tables
-- SELECT name, type_desc FROM PRISM_DB.sys.database_principals WHERE type = 'R' AND name LIKE 'PRISM%';
