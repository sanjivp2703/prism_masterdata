-- Phase N2 — bare SPCS hosting in the DEV account (run as ACCOUNTADMIN or a
-- role with CREATE COMPUTE POOL / CREATE INTEGRATION). This is scaffolding for
-- the N2 exit test only; N3 replaces it with the application package's
-- manifest + setup script. Assumes 00_bootstrap.sql + 01_internal_tables.sql
-- are already installed (PRISM_DB, PRISM_WH, roles).

-- ── Image repository (docker push target — see native/push.sh) ───────────────
CREATE IMAGE REPOSITORY IF NOT EXISTS PRISM_DB.INTERNAL.PRISM_IMAGES;
SHOW IMAGE REPOSITORIES IN SCHEMA PRISM_DB.INTERNAL;  -- copy repository_url for push.sh

-- ── Stage for the service spec ───────────────────────────────────────────────
CREATE STAGE IF NOT EXISTS PRISM_DB.INTERNAL.NATIVE_ARTIFACTS
  DIRECTORY = (ENABLE = TRUE);
-- Upload the spec (snowsql):  PUT file://native/service-spec.yaml @PRISM_DB.INTERNAL.NATIVE_ARTIFACTS AUTO_COMPRESS=FALSE OVERWRITE=TRUE;

-- ── Compute pool ─────────────────────────────────────────────────────────────
-- Smallest instance family; single node (Prism is single-instance by design —
-- in-process poller/locks/SSE). AUTO_SUSPEND does NOT apply mid-N2: the poller
-- must keep running, so the pool stays up — this is the accepted cost of a
-- live pipeline watcher (same as the standard edition's always-on Node
-- process). AUTO_RESUME covers restarts.
CREATE COMPUTE POOL IF NOT EXISTS PRISM_POOL
  MIN_NODES = 1
  MAX_NODES = 1
  INSTANCE_FAMILY = CPU_X64_XS
  AUTO_RESUME = TRUE;

-- ── The service ──────────────────────────────────────────────────────────────
-- Runs AS the owning role: grant that role what the app needs (PRISM_SERVICE's
-- grants from 01_internal_tables.sql; the service's ambient token acts with
-- this role's privileges).
CREATE SERVICE IF NOT EXISTS PRISM_DB.INTERNAL.PRISM_APP
  IN COMPUTE POOL PRISM_POOL
  FROM @PRISM_DB.INTERNAL.NATIVE_ARTIFACTS
  SPECIFICATION_FILE = 'service-spec.yaml'
  MIN_INSTANCES = 1
  MAX_INSTANCES = 1;

-- Status / logs / endpoint URL:
--   SELECT SYSTEM$GET_SERVICE_STATUS('PRISM_DB.INTERNAL.PRISM_APP');
--   CALL SYSTEM$GET_SERVICE_LOGS('PRISM_DB.INTERNAL.PRISM_APP', '0', 'prism', 200);
--   SHOW ENDPOINTS IN SERVICE PRISM_DB.INTERNAL.PRISM_APP;  -- ingress_url once provisioned
--
-- Who can open the app: grant the endpoint's usage to the humans testing it —
--   GRANT SERVICE ROLE PRISM_DB.INTERNAL.PRISM_APP!ALL_ENDPOINTS_USAGE TO ROLE PRISM_DATA_ADMIN;
-- Browser users hit the ingress URL, authenticate to Snowflake, and arrive
-- with Sf-Context-Current-User set → /api/auth/spcs bootstraps their session.
--
-- Restart drill (N2 exit criteria — state must survive via the block volume):
--   ALTER SERVICE PRISM_DB.INTERNAL.PRISM_APP SUSPEND;
--   ALTER SERVICE PRISM_DB.INTERNAL.PRISM_APP RESUME;
