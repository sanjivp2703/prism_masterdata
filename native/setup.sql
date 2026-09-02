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
--   wizard Part D grant SQL   → caller-grants opt-in + direct GRANT SELECT
--                               + the source_table reference (permission UI,
--                               reinstated 2026-09-01)
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
-- services: UNVERSIONED — SPCS services are not supported in versioned schemas
-- (install-test finding 2026-08-13).
CREATE SCHEMA IF NOT EXISTS services;

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
-- Prism is free on the Marketplace: no usage metering. Earlier versions kept
-- two billing ledgers here; upgrades from those versions drop them.
DROP TABLE IF EXISTS internal_state.BILLING_METER;
DROP TABLE IF EXISTS internal_state.BILLING_EVENTS;

-- app_user needs the normalization UDF: caller's-rights one-time exports
-- (§2.9) run the standardized CTAS as the CALLING USER, and its join calls
-- app_code.PRISM_NORMALIZE on the source side. Pure string function — no
-- data exposure. (Live-found 2026-08-13 alongside the warehouse grant.)
GRANT USAGE ON SCHEMA app_code TO APPLICATION ROLE app_user;
GRANT USAGE ON FUNCTION app_code.PRISM_NORMALIZE(VARCHAR) TO APPLICATION ROLE app_user;

-- app_data_admin: manual lookup maintenance only (mirror of PRISM_DATA_ADMIN).
GRANT USAGE ON SCHEMA internal_state TO APPLICATION ROLE app_data_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE internal_state.LITERAL_ALIAS_MATCHES TO APPLICATION ROLE app_data_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE internal_state.APPROVED_ALIAS_NAMES  TO APPLICATION ROLE app_data_admin;
GRANT USAGE ON SCHEMA app_code TO APPLICATION ROLE app_data_admin;
GRANT USAGE ON FUNCTION app_code.PRISM_NORMALIZE(VARCHAR) TO APPLICATION ROLE app_data_admin;

-- ── Reference callback (manifest references.source_table) ────────────────────
-- Reinstated 2026-09-01 (removed 2026-08-31): the permission UI calls this as
-- the consumer binds/unbinds pipeline source tables in Snowsight's Security
-- tab. `source_table` is MULTI-VALUED, so ADD uses SYSTEM$ADD_REFERENCE (the
-- single-valued form would be SYSTEM$SET_REFERENCE). The direct
-- GRANT SELECT ... TO APPLICATION path continues to work alongside; the app's
-- source reads resolve a bound reference first and fall back to the FQN.
CREATE OR REPLACE PROCEDURE app_code.register_reference(
  ref_name STRING, operation STRING, ref_or_alias STRING)
RETURNS STRING LANGUAGE SQL AS
$$
BEGIN
  CASE (operation)
    WHEN 'ADD' THEN
      SELECT SYSTEM$ADD_REFERENCE(:ref_name, :ref_or_alias);
    WHEN 'REMOVE' THEN
      SELECT SYSTEM$REMOVE_REFERENCE(:ref_name, :ref_or_alias);
    WHEN 'CLEAR' THEN
      SELECT SYSTEM$REMOVE_ALL_REFERENCES(:ref_name);
    ELSE
      RETURN 'unknown operation: ' || operation;
  END CASE;
  RETURN 'operation ' || operation || ' complete';
END;
$$;
-- Callable by the consumer's permission UI (same requirement as
-- grant_callback — install warning 2026-08-13 when such a grant was missing).
GRANT USAGE ON PROCEDURE app_code.register_reference(STRING, STRING, STRING) TO APPLICATION ROLE app_user;

-- ── Post-install activation: pool + warehouse + service ──────────────────────
-- Called by the consumer (or grant_callback) once privileges are granted.
CREATE OR REPLACE PROCEDURE app_code.start_app()
RETURNS STRING LANGUAGE SQL AS
$$
BEGIN
  CREATE COMPUTE POOL IF NOT EXISTS prism_app_pool  -- app-namespaced: pool names are ACCOUNT-global (collided with the N2 dev pool, 2026-08-13)
    MIN_NODES = 1 MAX_NODES = 1 INSTANCE_FAMILY = CPU_X64_XS AUTO_RESUME = TRUE;
  CREATE WAREHOUSE IF NOT EXISTS PRISM_APP_WH  -- app-namespaced (warehouse names are account-global; PRISM_WH collides with a standard install)
    WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 60 AUTO_RESUME = TRUE
    INITIALLY_SUSPENDED = TRUE STATEMENT_TIMEOUT_IN_SECONDS = 600
    COMMENT = 'Dedicated warehouse for the Prism standardization service';
  CREATE SERVICE IF NOT EXISTS services.prism_app
    IN COMPUTE POOL prism_app_pool
    FROM SPECIFICATION_FILE = '/service-spec.yaml'   -- packaged path finalized at packaging
    MIN_INSTANCES = 1 MAX_INSTANCES = 1;             -- single-node BY DESIGN (in-process poller/locks/SSE)
  ALTER SERVICE IF EXISTS services.prism_app RESUME;  -- start = resume when suspended (stop_app pairs with this)
  GRANT SERVICE ROLE services.prism_app!ALL_ENDPOINTS_USAGE TO APPLICATION ROLE app_user;
  -- Caller's-rights sessions (§2.9) run as the CALLING USER with privileges =
  -- (user's own ∩ caller grants). Nobody outside the app has USAGE on the
  -- app-owned warehouse, so without this grant every caller session dies with
  -- "No active warehouse selected" (live-found 2026-08-13). The app owns the
  -- warehouse, so it grants usage to its own users.
  GRANT USAGE ON WAREHOUSE PRISM_APP_WH TO APPLICATION ROLE app_user;
  -- Visibility for consumer admins (and provider dev tooling): without these,
  -- SHOW ENDPOINTS/SERVICE CONTAINERS is impossible outside the app.
  GRANT USAGE ON SCHEMA services TO APPLICATION ROLE app_user;
  GRANT MONITOR ON SERVICE services.prism_app TO APPLICATION ROLE app_user;
  RETURN 'Prism started';
END;
$$;

-- Upgrade path: refresh the running service to this version's image/spec.
CREATE OR REPLACE PROCEDURE app_code.upgrade_app()
RETURNS STRING LANGUAGE SQL AS
$$
BEGIN
  ALTER SERVICE IF EXISTS services.prism_app FROM SPECIFICATION_FILE = '/service-spec.yaml';
  -- Same caller's-rights warehouse grant as start_app() — existing installs
  -- upgraded to this version pick it up here (the warehouse already exists).
  GRANT USAGE ON WAREHOUSE PRISM_APP_WH TO APPLICATION ROLE app_user;
  RETURN 'Prism service upgraded';
END;
$$;

GRANT USAGE ON PROCEDURE app_code.start_app() TO APPLICATION ROLE app_user;
GRANT USAGE ON PROCEDURE app_code.upgrade_app() TO APPLICATION ROLE app_user;

-- ── Grant callback (manifest configuration.grant_callback) ───────────────────
-- Snowsight calls this during the permission step as privileges are granted.
-- It starts the app once (and only once) all three account privileges are
-- held, so a listing install reaches Activation with the service already
-- coming up — no worksheet step. start_app() is idempotent (IF NOT EXISTS /
-- RESUME), so out-of-order or repeated callback invocations are harmless.
-- Without this, Snowsight's activation found no default_web_endpoint service
-- and failed with "SPCS Activation Error" (first listing install, 2026-08-31).
CREATE OR REPLACE PROCEDURE app_code.grant_callback(privileges ARRAY)
RETURNS STRING LANGUAGE SQL AS
$$
DECLARE
  ok BOOLEAN;
BEGIN
  SELECT SYSTEM$HOLD_PRIVILEGE_ON_ACCOUNT('CREATE COMPUTE POOL')
     AND SYSTEM$HOLD_PRIVILEGE_ON_ACCOUNT('CREATE WAREHOUSE')
     AND SYSTEM$HOLD_PRIVILEGE_ON_ACCOUNT('BIND SERVICE ENDPOINT')
    INTO :ok;
  IF (:ok) THEN
    CALL app_code.start_app();
    RETURN 'Prism starting';
  END IF;
  RETURN 'waiting for remaining privileges';
END;
$$;
-- Callable by the consumer's permission UI (same requirement the reference
-- callback had — install warning 2026-08-13 when such a grant was missing).
GRANT USAGE ON PROCEDURE app_code.grant_callback(ARRAY) TO APPLICATION ROLE app_user;

-- ── Auto-upgrade hook (manifest: lifecycle_callbacks.version_initializer) ────
-- Snowflake runs this automatically on every install and upgrade — including
-- the background auto-upgrade after a release-directive move — so the running
-- service rolls onto this version's image and spec with no action needed from
-- your account. On a first install (before privileges are granted, before the
-- service exists) it quietly does nothing; the first start is start_app().
-- A thrown error here would fail the upgrade itself, so every path is guarded.
CREATE OR REPLACE PROCEDURE app_code.version_init()
RETURNS STRING LANGUAGE SQL AS
$$
BEGIN
  ALTER SERVICE IF EXISTS services.prism_app FROM SPECIFICATION_FILE = '/service-spec.yaml';
  GRANT USAGE ON WAREHOUSE PRISM_APP_WH TO APPLICATION ROLE app_user;
  RETURN 'service refreshed';
EXCEPTION
  WHEN OTHER THEN
    RETURN 'nothing to refresh yet';  -- first install: no service/warehouse exists
END;
$$;

-- (The install-test diag() proc lived here through patch 19 — removed
-- 2026-08-14, a pre-distribution requirement. app_code is versioned, so the
-- next upgrade drops it from installs automatically.)

-- Cost control: suspend the app without uninstalling (consumer-facing need).
CREATE OR REPLACE PROCEDURE app_code.stop_app()
RETURNS STRING LANGUAGE SQL AS
$$
BEGIN
  ALTER SERVICE IF EXISTS services.prism_app SUSPEND;
  ALTER COMPUTE POOL IF EXISTS prism_app_pool SUSPEND;
  RETURN 'Prism suspended (start_app() to resume)';
END;
$$;
GRANT USAGE ON PROCEDURE app_code.stop_app() TO APPLICATION ROLE app_user;
