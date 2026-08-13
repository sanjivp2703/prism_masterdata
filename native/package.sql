-- Prism — application PACKAGE creation + first private install (N3).
-- DRAFT 2026-08-13: the statement sequence for the first install test; expect
-- to debug manifest/setup.sql details live against it. Mixed privileges:
-- package + app creation need ACCOUNTADMIN (Snowsight paste); artifact
-- uploads can run as PRISM_SERVICE once the package grants allow.
--
-- Prereqs: the amd64 image pushed to PRISM_DB.INTERNAL.PRISM_IMAGES (push.sh)
-- — the manifest's image path references that repo and version creation
-- snapshots it.

-- ── 1. Provider side: the package (ACCOUNTADMIN) ─────────────────────────────
CREATE APPLICATION PACKAGE IF NOT EXISTS PRISM_PKG;
CREATE SCHEMA IF NOT EXISTS PRISM_PKG.CODE;
CREATE STAGE IF NOT EXISTS PRISM_PKG.CODE.ARTIFACTS DIRECTORY = (ENABLE = TRUE);
-- Let the dev tooling (PRISM_SVC) upload artifacts + iterate:
GRANT ALL ON SCHEMA PRISM_PKG.CODE TO ROLE PRISM_SERVICE;
GRANT WRITE, READ ON STAGE PRISM_PKG.CODE.ARTIFACTS TO ROLE PRISM_SERVICE;
GRANT MANAGE VERSIONS ON APPLICATION PACKAGE PRISM_PKG TO ROLE PRISM_SERVICE;

-- ── 2. Upload artifacts (PRISM_SERVICE, via snow CLI / driver PUT) ───────────
-- PUT file://native/manifest.yml      @PRISM_PKG.CODE.ARTIFACTS AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
-- PUT file://native/setup.sql         @PRISM_PKG.CODE.ARTIFACTS AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
-- PUT file://native/README.md         @PRISM_PKG.CODE.ARTIFACTS AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
-- PUT file://native/service-spec.yaml @PRISM_PKG.CODE.ARTIFACTS AUTO_COMPRESS=FALSE OVERWRITE=TRUE;
--   (packaged spec: image path + env reviewed at install test; the ambient
--    session database inside an app IS the app, so PRISM_INTERNAL_DB may stay
--    unset for database-relative resolution.)

-- ── 3. Cut a version ─────────────────────────────────────────────────────────
ALTER APPLICATION PACKAGE PRISM_PKG ADD VERSION v1_0 USING '@PRISM_PKG.CODE.ARTIFACTS';
-- Iterating on the same version during the test:
--   ALTER APPLICATION PACKAGE PRISM_PKG ADD PATCH FOR VERSION v1_0 USING '@PRISM_PKG.CODE.ARTIFACTS';
-- (DISTRIBUTION stays INTERNAL — no security scan — until N5.)

-- ── 4. First install, same account (ACCOUNTADMIN) ────────────────────────────
CREATE APPLICATION PRISM_APP_TEST FROM APPLICATION PACKAGE PRISM_PKG USING VERSION v1_0;

-- Consumer-side grants the manifest requests:
GRANT CREATE COMPUTE POOL      ON ACCOUNT TO APPLICATION PRISM_APP_TEST;
GRANT CREATE WAREHOUSE         ON ACCOUNT TO APPLICATION PRISM_APP_TEST;
GRANT BIND SERVICE ENDPOINT    ON ACCOUNT TO APPLICATION PRISM_APP_TEST;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION PRISM_APP_TEST;

-- References: grant via Snowsight → Apps → Prism → Security (the manifest's
-- reference definitions drive the UI), or programmatically for the demo table.

-- Start it (creates pool + PRISM_WH + service; grants endpoint to app_user):
CALL PRISM_APP_TEST.app_code.start_app();
GRANT APPLICATION ROLE PRISM_APP_TEST.app_user TO ROLE PRISM_DATA_ADMIN;
-- Then: SHOW ENDPOINTS IN SERVICE PRISM_APP_TEST.app_code.prism_app;

-- ── 5. Teardown between iterations ───────────────────────────────────────────
-- DROP APPLICATION PRISM_APP_TEST CASCADE;   -- drops its pool/service/objects
