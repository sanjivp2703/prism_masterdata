-- Prism Native App setup script (docs/NATIVE_APP_PLAN.md N3 · §2.6/§2.7).
-- DRAFT 2026-08-13 — authored, not yet install-tested.
--
-- Runs at INSTALL and at EVERY UPGRADE, so it is written MIGRATION-STYLE
-- (§2.7): data tables are CREATE IF NOT EXISTS + version-aware ALTERs — never
-- CREATE OR REPLACE (which would wipe customer lookups on upgrade). Stateless
-- objects (UDF, procs) may use CREATE OR REPLACE in the versioned schema.
-- Framework guarantees upgrades are consecutive (N → N+1 only).
--
-- Translation of 01_internal_tables.sql (see §2.6 mapping table):
--   PRISM_SERVICE role        → the application itself (owner's rights)
--   PRISM_DATA_ADMIN          → application role app_data_admin
--   wizard Part D grant SQL   → manifest references (consumer-granted)
--   CREATE WAREHOUSE in 01    → manifest privilege + post-install proc here
--   dev-reset DROPs in 01     → not carried over (no dev resets in an app)
--
-- ⚠ App-side change required before install-testing: the app hardcodes
-- PRISM_DB.INTERNAL (internalTable()); inside the app the database is the
-- APPLICATION name. The container gets SNOWFLAKE_DATABASE=current_database()
-- via the service spec, and internalTable() must honor it in native mode.

-- ── Application roles ────────────────────────────────────────────────────────
CREATE APPLICATION ROLE IF NOT EXISTS app_user;        -- open the UI
CREATE APPLICATION ROLE IF NOT EXISTS app_data_admin;  -- human lookup maintenance (≈ PRISM_DATA_ADMIN)

-- ── Schemas ──────────────────────────────────────────────────────────────────
-- app_code: versioned (recreated per version) — procs, UDF, service.
-- internal_state: UNVERSIONED — the data plane; survives upgrades.
CREATE OR ALTER VERSIONED SCHEMA app_code;
CREATE SCHEMA IF NOT EXISTS internal_state;

-- ── PRISM_NORMALIZE (stateless; body mirrored by normalizeLiteral — keep in sync)
CREATE OR REPLACE FUNCTION app_code.PRISM_NORMALIZE(V STRING)
RETURNS STRING LANGUAGE JAVASCRIPT AS $$
  if (V === null || V === undefined) return null;
  var s = String(V).normalize('NFC');
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c <= 31 || c === 127 || (c >= 128 && c <= 159)) continue;
    out += s.charAt(i);
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.toLowerCase();
$$;

-- ── Data plane (internal_state; migration-style — IF NOT EXISTS only) ────────
CREATE TABLE IF NOT EXISTS internal_state.PIPELINE_QUEUE (
    queue_id         INTEGER AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    pipeline_id      INTEGER NOT NULL,
    literal_value    VARCHAR NOT NULL,
    source_frequency INTEGER NOT NULL DEFAULT 1,
    detected_at      TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    CONSTRAINT uq_pipeline_queue UNIQUE (pipeline_id, literal_value)
);
CREATE TABLE IF NOT EXISTS internal_state.APPROVED_ALIAS_NAMES (
    alias_id     INTEGER AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    alias_name   VARCHAR(1000) NOT NULL,
    domain_id    INTEGER,                    -- historical name: column_specs.spec_id
    usage_count  INTEGER NOT NULL DEFAULT 0,
    last_used_at TIMESTAMP_NTZ,
    CONSTRAINT uq_approved_alias_names UNIQUE (alias_name, domain_id)
);
CREATE TABLE IF NOT EXISTS internal_state.LITERAL_ALIAS_MATCHES (
    match_id         INTEGER AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    literal_value    VARCHAR NOT NULL,
    normalized_value VARCHAR,                -- PRISM_NORMALIZE(literal_value), set on every write
    alias_id         INTEGER NOT NULL REFERENCES internal_state.APPROVED_ALIAS_NAMES(alias_id) ON DELETE RESTRICT,
    domain_id        INTEGER,
    run_id           INTEGER NOT NULL,
    confirmed_at     TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
);
CREATE TABLE IF NOT EXISTS internal_state.ONE_TIME_FILE_ROWS (
    row_id        INTEGER AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    session_nonce VARCHAR NOT NULL,
    row_num       INTEGER NOT NULL,
    column_data   VARIANT NOT NULL,
    created_at    TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
);
CREATE TABLE IF NOT EXISTS internal_state.ONE_TIME_FILE_BLOBS (
    session_nonce VARCHAR NOT NULL,
    chunk_num     INTEGER NOT NULL,
    file_name     VARCHAR NOT NULL,
    file_kind     VARCHAR(10) NOT NULL,
    sheet_name    VARCHAR,
    header_row    INTEGER NOT NULL,
    data          VARCHAR NOT NULL,
    created_at    TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP(),
    PRIMARY KEY (session_nonce, chunk_num)
);
CREATE TABLE IF NOT EXISTS internal_state.RUN_STATE (
    run_id     INTEGER NOT NULL PRIMARY KEY,
    state      VARIANT,
    updated_at TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
);
CREATE TABLE IF NOT EXISTS internal_state.VALIDATION_LOG (
    id                  INTEGER AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    literal_value       VARCHAR NOT NULL,
    run_id              INTEGER,
    original_alias_name VARCHAR,
    user_changed_to     VARCHAR,
    llm_decision        VARCHAR,
    decided_at          TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
);
-- §2.8 billing meter: cumulative billable-unit count + append-only emission
-- ledger (effectively-once event emission; free tier enforced in-app).
CREATE TABLE IF NOT EXISTS internal_state.BILLING_METER (
    id            INTEGER AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    block_units   INTEGER NOT NULL,           -- units in this emitted block
    total_after   INTEGER NOT NULL,           -- cumulative total after this block
    emitted_at    TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

-- app_data_admin: manual lookup maintenance only (mirror of PRISM_DATA_ADMIN).
GRANT USAGE ON SCHEMA internal_state TO APPLICATION ROLE app_data_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE internal_state.LITERAL_ALIAS_MATCHES TO APPLICATION ROLE app_data_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE internal_state.APPROVED_ALIAS_NAMES  TO APPLICATION ROLE app_data_admin;
GRANT USAGE ON SCHEMA app_code TO APPLICATION ROLE app_data_admin;
GRANT USAGE ON FUNCTION app_code.PRISM_NORMALIZE(VARCHAR) TO APPLICATION ROLE app_data_admin;

-- ── Reference callback (manifest register_callback) ──────────────────────────
CREATE OR REPLACE PROCEDURE app_code.register_reference(ref_name STRING, operation STRING, ref_or_alias STRING)
RETURNS STRING LANGUAGE SQL AS
$$
BEGIN
  CASE (operation)
    WHEN 'ADD' THEN SELECT SYSTEM$SET_REFERENCE(:ref_name, :ref_or_alias);
    WHEN 'REMOVE' THEN SELECT SYSTEM$REMOVE_REFERENCE(:ref_name, :ref_or_alias);
    WHEN 'CLEAR' THEN SELECT SYSTEM$REMOVE_ALL_REFERENCES(:ref_name);
    ELSE RETURN 'unknown operation: ' || operation;
  END CASE;
  RETURN 'ok';
END;
$$;

-- ── Post-install activation: pool + warehouse + service ──────────────────────
-- Called by the consumer (or grant_callback) once privileges are granted.
CREATE OR REPLACE PROCEDURE app_code.start_app()
RETURNS STRING LANGUAGE SQL AS
$$
BEGIN
  CREATE COMPUTE POOL IF NOT EXISTS prism_pool
    MIN_NODES = 1 MAX_NODES = 1 INSTANCE_FAMILY = CPU_X64_XS AUTO_RESUME = TRUE;
  CREATE WAREHOUSE IF NOT EXISTS PRISM_WH
    WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 60 AUTO_RESUME = TRUE
    INITIALLY_SUSPENDED = TRUE STATEMENT_TIMEOUT_IN_SECONDS = 600
    COMMENT = 'Dedicated warehouse for the Prism standardization service';
  CREATE SERVICE IF NOT EXISTS app_code.prism_app
    IN COMPUTE POOL prism_pool
    FROM SPECIFICATION_FILE = '/service-spec.yaml'   -- packaged path finalized at packaging
    MIN_INSTANCES = 1 MAX_INSTANCES = 1;             -- single-node BY DESIGN (in-process poller/locks/SSE)
  GRANT SERVICE ROLE app_code.prism_app!ALL_ENDPOINTS_USAGE TO APPLICATION ROLE app_user;
  RETURN 'Prism started';
END;
$$;

-- Upgrade path: refresh the running service to this version's image/spec.
CREATE OR REPLACE PROCEDURE app_code.upgrade_app()
RETURNS STRING LANGUAGE SQL AS
$$
BEGIN
  ALTER SERVICE IF EXISTS app_code.prism_app FROM SPECIFICATION_FILE = '/service-spec.yaml';
  RETURN 'Prism service upgraded';
END;
$$;

GRANT USAGE ON PROCEDURE app_code.start_app() TO APPLICATION ROLE app_user;
