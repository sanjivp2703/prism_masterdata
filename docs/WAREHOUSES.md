# Warehouse Parity Matrix

How each warehouse implements each adapter operation, and the quirks that bite.
This is the companion to the `WarehouseAdapter` contract
(`stand-ui/app/api/_lib/warehouse/types.ts`) and the port plan
(`docs/MSSQL_PORT_PLAN.md`).

**When to update this file:** any change that touches SQL, change detection,
exports, grants, or normalization is an adapter-level change — update the
affected rows here in the same PR. A row that says one thing while the code
does another is worse than no row at all.

**Status legend:** ✅ implemented · 🔜 planned (phase noted) · — not applicable

---

> **Edition note (2026-08-12):** the native (Snowflake Marketplace) edition
> pins the adapter factory to Snowflake — `getWarehouseAdapter()` returns the
> Snowflake adapter unconditionally when `PRISM_EDITION=native`, ignoring
> `workspace_config.warehouse_type` and `PRISM_WAREHOUSE_TYPE`, and the
> warehouse-type API refuses non-Snowflake saves. The other adapters remain
> compiled in (standard edition unaffected); see `docs/NATIVE_APP_PLAN.md`.
> The Snowflake service connection also has a **tier 0 (N2)**: inside SPCS,
> the ambient platform token (`/snowflake/session/token` + `SNOWFLAKE_HOST`,
> `authenticator: OAUTH`, token read fresh per connection — it rotates) takes
> precedence over workspace/env credentials; `serviceConnectionSource()`
> reports `'spcs'`. Native-edition-gated, so standard resolution is untouched.

## Connection & errors

| Operation | Snowflake | SQL Server (planned) |
|---|---|---|
| Service connection | ✅ `withWarehouse` → workspace_config (SQLite, encrypted) → `SNOWFLAKE_*` env fallback. Fresh connection per call, destroyed in `finally`. Key-pair JWT preferred; password+MFA fallback (MFA error 394508 → "use key-pair"). | ✅ P3 — `warehouse/mssql/connection.ts` (`mssql` driver), env tier (`MSSQL_SERVER/USER/PASSWORD/DATABASE/ENCRYPT/TRUST_SERVER_CERT`); fresh size-1 pool per call, closed in finally; 600 s request timeout (parity with PRISM_WH). Workspace tier ✅ P6 (`workspace_config.ms_*`, encrypted, 10 s cache; saved from `/setup` step 3 via `/api/accounts/workspace-mssql`). Factory: workspace_config.warehouse_type → `PRISM_WAREHOUSE_TYPE` env → snowflake. Entra ID: future (SQL auth first). |
| Personal connection | ✅ `withUserWarehouse(accountId, fn)` — `accounts.sf_*`, encrypted. Used ONLY by one-time flow fallback + change-tracking auto-fix. **Native edition (§2.9, 2026-08-13): the "user connection" is instead an SPCS caller's-rights session** — service token + `.` + the request's `Sf-Context-Current-User-Token` header, OAUTH; executes as the calling user restricted to the consumer's opt-in `GRANT CALLER` grants; no stored secrets. Null outside a request scope (poller/tick can never use it). `hasUserWarehouseConfig` is **async facade-wide** for this (adapter contract `boolean \| Promise<boolean>`) — always await it. | ✅ P6/P7 — `accounts.ms_*` (migration 010, encrypted), `withUserMssql`; saved via `/api/accounts/mssql-config` (member-savable, no grants pass) + the non-admin `/setup` mssql variant. Same one-time-only rules. Live-tested. (Sync `hasUserConfig` — the union contract needs no change here.) |
| Ad-hoc (typed credentials) | ✅ `createAdHocSnowflakeConnection` — setup surfaces only. | ✅ P6 — `withAdHocMssql` (setup wizard test/save flows). |
| Query execution | ✅ `executeQuery(conn, sql, binds)` — binds are `?` positional; ~65k binds/statement ceiling. | ✅ P3 — `translateBinds` scanner (`?`→`@pN`, quote/bracket/comment-aware, parity-tested + live-tested); explicit type mapping (int→BigInt, float→Float, bool→Bit, Date→DateTime2, string/null→NVarChar). **~2,100 binds/statement ceiling** → bulk-write strategy decided in P5. |
| Error classification | ✅ `isWarehouseAccessError` (message sniffing: "not authorized", "does not exist"…); `classifyPollError` in the poller (infra vs per-table vs transient); `isChangeTrackingPrivilegeError`. | ✅ P3 — `isMssqlAccessError`: error numbers 208/229/230/262/297/300/916/4060/18456 + message fallbacks (live-tested on missing object). Poller-level `classifyPollError`: P4. |
| Error sanitization | ✅ `warehouseErrorResponse` — detail server-side only, never raw SQL to the browser. | ✅ P3 — `mssqlErrorResponse`, same contract (login-failed → 401 with guidance). |

## Change detection

| Operation | Snowflake | SQL Server (planned) |
|---|---|---|
| Mechanism | ✅ Standard (delete-aware) streams `PIPELINE_STREAM_<id>`, offsets on Prism's side; no source-table DDL beyond change tracking enable. | ✅ P4 — `warehouse/mssql/detection.ts` + `_lib/pipeline-poller-mssql.ts`: Change Tracking (`CHANGETABLE(CHANGES …)` joined to live rows on the PK; sync version in `pipelines.detection_state`; **requires PK + DB-level enable**) with automatic fallback to the tiered diff scan (`diff_reason` = no_pk \| ct_disabled). Mode chosen at first poll; consistent-snapshot semantics preserved in CT mode (known values queue too); diff mode queues unmapped only (known-value new rows surface via the hourly rebuild — accepted behavioral difference). Live-tested. |
| Cheap "anything new?" check | ✅ `SYSTEM$STREAM_HAS_DATA` — metadata layer, never wakes the warehouse. | ✅ P4 — `CHANGE_TRACKING_CURRENT_VERSION()` vs stored version (CT); `sys.dm_db_index_usage_stats.last_user_update` heartbeat (diff; without VIEW SERVER STATE it degrades to scans floored at one per 5 passes — the tier alone returns 1 for any table under 1M rows, so nothing else would defer them). Scan tiers by row count, retuned by measured duration; serverless multiplies intervals ×10 (cap 60). |
| Enablement prerequisite | ✅ Source table needs `CHANGE_TRACKING = TRUE`; auto-fix ladder: service conn → creator's personal creds → pause with fix SQL. | ✅ P4 — `enableCt` tried via the service connection at init; failure falls back to diff-scan (never pauses). Personal-credential rung joins in P6 when mssql personal creds exist. |
| Reset/gap recovery | ✅ `recoverAfterStreamReset` — reconcile (unmapped→queue) + export rebuild; never stamps `fully_synced_at` mid-recovery. | ✅ P4 — stored version < `CHANGE_TRACKING_MIN_VALID_VERSION()` → source reconcile (scan → queue unknown), re-baseline, `claimSynced: false`, export-refresh flagged (rebuild lands in P5). Live-tested. |
| Source health check | ✅ `SHOW COLUMNS IN TABLE` (metadata-only; never INFORMATION_SCHEMA in recurring paths — cost incident Jun/Jul 2026); masking via `POLICY_REFERENCES`. | ✅ P4 — `checkSourceHealthMssql`: OBJECT_ID + `sys.columns`/`sys.types` (missing table/column, non-text type → pause) + `sys.masked_columns` (DDM → flag + skip, auto-recovers). Runs on first poll / after errors / every 10th pass. `classifyMssqlPollError`: global (18456/4060/916/40613/ELOGIN) vs table (208/229/230/262/297/300) vs transient. Live-tested. |

## Reads & normalization

| Operation | Snowflake | SQL Server (planned) |
|---|---|---|
| Normalization for matching | ✅ `PRISM_NORMALIZE` JS UDF ≡ `normalizeLiteral()` TS — **kept in exact sync, enforced by `npm run test:parity`** (extracts the UDF body from `01_internal_tables.sql`). `normalized_value` materialized at write time. | — deliberately NO SQL implementation (no JS UDFs, no native NFC, no CLR on Azure SQL DB). App-side `normalizeLiteral` only + exact-match staging table for joins (✅ P5 — `warehouse/mssql/export.ts`). |
| Distinct scan | ✅ `GROUP BY PRISM_NORMALIZE(col)` + `ANY_VALUE(col)`, 5k cap per run. | ✅ P5 — `SELECT … GROUP BY col` + app-side normalize/dedup (detection `diffScan` for queue paths; `computeMappedCountsMssql` for metrics). Export staging caps at 100k distinct/column (loud error). |
| Exact-match joins | ✅ stored `normalized_value` vs `PRISM_DB.INTERNAL.PRISM_NORMALIZE(src)` — UDF on source side only, and **always fully qualified**: Snowflake resolves unqualified names in a stored view body against the *view's* schema, so a bare call broke every `CREATE VIEW` export outside `PRISM_DB.INTERNAL` (KI-149, fixed 2026-08-04). | ✅ P5 — per-rebuild staging table (`EXPORT_STG_*` in INTERNAL, BIN2, dropped in finally) joined on raw equality with an explicit `COLLATE Latin1_General_100_BIN2` cast on the source side. **The staging distinct read and the metrics GROUP BY must carry the SAME BIN2 collation** — SQL Server's default is case-insensitive, so an uncollated `SELECT DISTINCT` collapsed `ATT`/`att` to one representative that the BIN2 join could then no longer match: with `export_unmapped_rows=0` those rows were silently dropped from the export, with `=1` they appeared raw, and `computeMappedCountsMssql` counted them as mapped anyway so the pipeline reported fully-synced over a short table (KI-138/125 + KI-167; fixed and live-proven 2026-08-06 — a 7-row `VZW`/`vzw`/`ATT`/`att` fixture went from 5 distinct values and 2 dropped rows to 7 distinct and 7/7 matched). App-side `normalizeLiteral` still folds case for LOOKUP matching, which is correct and unaffected — that decides which alias a value maps to, not how many distinct source values exist. Values >800 chars can't be in the lookup and stay unmapped by construction. Live-tested. |
| Column listing / preview | ✅ INFORMATION_SCHEMA (one-shot user actions only — warehouse already awake). | ✅ P6 — INFORMATION_SCHEMA.COLUMNS works verbatim; text-type detection per dialect (VARCHAR/NVARCHAR/… vs Snowflake's 'TEXT'); preview drops TO_VARCHAR. |

## Writes & exports

| Operation | Snowflake | SQL Server (planned) |
|---|---|---|
| Bulk mapping upsert | ✅ MERGE, deduped on `normalizeLiteral` first (dup source keys error), batched at `EXPORT_MERGE_BATCH=5000`, idempotent. | ✅ P5 — `warehouse/mssql/mappings.ts`: `MERGE WITH (HOLDLOCK)` + T-SQL `(VALUES …) AS s(…)`, normalized_value computed app-side and used as the match key. Strategy decided: **smaller batches** (names 1500/stmt, matches 400/stmt @ 4 binds) — benchmarked fine at 6k entries; TVPs unnecessary. Live-tested. |
| Queue MERGE + drain | ✅ MERGE into `PIPELINE_QUEUE`, FIFO 5k installments. | ✅ P4/P5 — queue MERGE batched 500 rows/stmt (P4 detection); drain via `SELECT TOP (5000)` + NULL-safe CASE ordering; dequeue DELETE batched under the bind ceiling. 6k-value drain across two installments live-tested. |
| Export rebuild | ✅ `CREATE OR REPLACE TABLE … COPY GRANTS AS SELECT`; physically ORDER BY source PK → unique key → clustering key when one exists, else unordered (**no synthetic order column** — removed 2026-07). Views: created once, never ORDER BY. | ✅ P5 — `refreshExportTableMssql`: staging join → `SELECT … INTO _new` → capture grants (via the export DB's `sys.database_principals` — NOT `USER_NAME()`, which resolves in the current db) → `BEGIN TRAN; DROP old; sp_rename; COMMIT` → re-grant (best-effort, logged). **Grant SCOPE is preserved, not just the permission**: the capture reads `p.minor_id` and resolves it via `sys.columns`, so a COLUMN-scoped grant is re-issued as `GRANT <perm> ON <table>(<col>)`, not widened to the whole table (KI-118 — previously `minor_id` was ignored and a customer's deliberately column-limited grant silently became table-wide on the first rebuild; live-proven fixed 2026-08-06). A column grant whose column no longer resolves is SKIPPED with a warning, never re-granted at table scope. Order tiers: PK → unique constraint → clustered index (best-effort physical; guaranteed order = ORDER BY the key columns). **export_kind 'view' deliberately unsupported on mssql** (views can't reference per-rebuild staging) — loud error. Permission survival live-tested. **Snowflake has no equivalent risk**: `COPY GRANTS` preserves privileges natively and Snowflake has no column-level GRANT (column exposure is controlled by masking policies, which Prism does not manage). |
| Standardized-column sync (`export_kind` 'column') | ✅ `refreshStandardizedColumnsSnowflake` (export-table.ts): companion `<col>_STANDARDIZED` VARCHAR column ON THE SOURCE TABLE (name from the shared `standardizedColumnName()` helper — parity-tested). `SHOW COLUMNS` (metadata-layer) → `ALTER TABLE ADD COLUMN` if missing (needs table OWNERSHIP — failure throws the exact fix SQL) → two guarded `UPDATE`s per column (`EQUAL_NULL` change guard + NULL-out for unmapped) so steady state touches 0 rows and the pipeline's own stream settles after one echo cycle. Needs `GRANT UPDATE` on the source. `export_table_fqn` is pinned = `table_fqn`; table/view builders refuse a destination equal to the source (data-loss guard). **Not live-tested yet.** | ✅ implemented, `refreshStandardizedColumnsMssql` (warehouse/mssql/export.ts): `sys.columns` check → `ALTER TABLE ADD <std> NVARCHAR(450) NULL` (needs ALTER permission) → alias staging table (shared `materializeAliasStaging`, BIN2 exact-match) → guarded `UPDATE … FROM` join + NULL-out LEFT JOIN. Same change-guard rationale vs Change Tracking echo. Same source==destination refusal in the table path. **Not live-tested yet.** |
| Run state blob (`INTERNAL.RUN_STATE`) | ✅ Data residency (2026-07-28): the review state blob holds customer values, so it lives warehouse-side, never in SQLite (runs there is metadata only). `op-auto-group.ts` helpers: load = `SELECT state` (VARIANT comes back pre-parsed — `parseStateCell` tolerates string too); save = single-row `MERGE … USING (SELECT ?, PARSE_JSON(?))` (PARSE_JSON-in-USING is legal; the VALUES restriction doesn't apply); rev-checked save = `UPDATE … WHERE COALESCE(state:rev::NUMBER,0) = ?`, landed-count read from the DML result row (`{"number of rows updated": N}`), missing-row + rev-0 falls back to insert. COST RULE: callable from review/export/tick paths only — never from recurring list/poll surfaces. | ✅ same helpers, dialect-branched: `MERGE WITH (HOLDLOCK)`; rev check via `COALESCE(TRY_CAST(JSON_VALUE(state,'$.rev') AS INT),0)`; landed detection via `OUTPUT INSERTED.run_id` (mssql `executeQuery` returns recordset only, no rowsAffected). `state NVARCHAR(MAX)` + ISJSON constraint. Live-tested via `test:mssql-lifecycle` (standardization run writes/reads the blob). |
| Validation log (`INTERNAL.VALIDATION_LOG`) | ✅ Data residency (2026-07-28): export-referee audit rows contain literal values → warehouse-side (was SQLite). Written per-decision on the already-open export connection; insert failures are logged, never fail the export. | ✅ same insert on the export connection; `literal_value NVARCHAR(800)` (values sliced to 800 to match the mssql literal bound), aliases NVARCHAR(450). |
| Multi-statement atomicity | ✅ Explicit `BEGIN/COMMIT/ROLLBACK` (auto-commit per statement otherwise); `PARSE_JSON(?)` invalid in VALUES — use `SELECT … FROM VALUES`. | ✅ P3 — native transactions incl. DDL; JSON via `NVARCHAR(MAX)` + ISJSON check constraint + `OPENJSON`/`JSON_VALUE` (round-trip live-tested). |
| Identifier quoting | ✅ `"double quotes"`, `""` to escape; unquoted → UPPERCASE. Result columns come back UPPERCASE (`r.F ?? r.f` pattern). | ✅ P3 — `warehouse/mssql/dialect.ts` `quoteIdent`: `[brackets]`, `]]` to escape, control chars rejected (parity-tested); case preserved as written; comparison per collation. |

## Install, grants, cost

| Operation | Snowflake | SQL Server (planned) |
|---|---|---|
| Install script | ✅ `00_bootstrap.sql` + `01_internal_tables.sql` (tables, UDF, roles, grants, `PRISM_WH`). | ✅ P3 — `01_internal_tables.mssql.sql` (repo root; `npm run mssql:install` GO-batch runner): PRISM_DB + INTERNAL/**EXPORTS** schemas ("PUBLIC" collides with the built-in role, so exports default to EXPORTS), IDENTITY PKs, BIN2 collation, NVARCHAR caps (literal 800 / alias 450 — nonclustered index 1700-byte key limit), ISJSON-checked NVARCHAR(MAX), roles + login template, TEST_DB demo with CT enabled. Live-verified on Docker SQL Server 2022. |
| Grants | ✅ `grants.ts` — `PRISM_SERVICE` (machine) / `PRISM_DATA_ADMIN` (human, break-glass); pre-check SHOW ROLES/WAREHOUSES → "already in place" green. | ✅ P6 (by design: NO programmatic grants pass on mssql) — the install script + service-login template are run by the customer's sysadmin; `verify-install` validates the result. Prism's login can't grant, so there is nothing to apply. |
| Verify-install probes | ✅ metadata-layer SHOW commands only (never wakes warehouse). | ✅ P6 — catalog probes: login identity + PRISM_SERVICE membership, DB_ID, INTERNAL/EXPORTS schemas, 4 tables, roles; normalization check is an informational "app-side" note. |
| Kill switch (customer side) | ✅ `ALTER USER PRISM_SVC SET DISABLED = TRUE`. | 🔜 `ALTER LOGIN prism_svc DISABLE`. |
| Cost model | ✅ Bills warehouse-awake-time: 60s minimum per resume; idle cycles must touch metadata layer ONLY; dedicated `PRISM_WH` XSMALL `AUTO_SUSPEND=60`. | ✅/🔜 Bills provisioned capacity: protect server *load*, not a bill. Serverless detection implemented (P3): `isServerlessAzureTier` on the ServiceObjective (`_S_` marker), once-per-process warning on connect; cadence stretching wires into the poller in P4. CT adds small DML overhead + ~2-day retention storage (disclose in onboarding). |
| Version floor | n/a (SaaS) | SQL Server 2019+ — confirmed live (INS-M11, 2026-07-29): all four live suites pass cleanly on a genuine 2019 container. The dedup path never uses `ANY_VALUE` (always `SELECT DISTINCT` + app-side dedup), so there is no 2022+ version gate to work around. Azure SQL DB / MI supported, CLR assumed unavailable. |

---

## Parity tests (`npm run test:parity`)

`stand-ui/scripts/parity-tests.ts` — pure logic, no live database, runnable in
CI or pre-commit. Today: `normalizeLiteral` ⇄ `PRISM_NORMALIZE` UDF (body
extracted from the install script) over an NFC/NFD/control-char/whitespace
corpus, plus `sqlStringLiteral` escaping. As adapters gain dialect helpers
(quoting, FQN parsing, SQL text generation), their per-warehouse tests join
this file — every quirk called out in the matrix above should eventually have
a test line proving the code handles it.

## Later-phase additions (P6/P7, 2026-07)

| Operation | Snowflake | SQL Server |
|---|---|---|
| One-time create probe | ✅ dialect-branched `SELECT 1 … LIMIT 1` via the facade's `executeQuery` (2026-07-28 fix — the route previously used a raw snowflake-sdk `conn.execute`, which broke every mssql one-time create with a generic "Failed to read the source table") | ✅ `SELECT TOP (1) 1` — double-quoted identifiers are fine (driver runs QUOTED_IDENTIFIER ON); verified live as prism_svc |
| One-time export | ✅ temp map table + `PRISM_NORMALIZE` join, `CREATE OR REPLACE TABLE` (DELETE+INSERT permission fallback). **User-connection scratch relocation (2026-08-13, live-found in the native caller's-rights round):** when the export runs on the USER'S connection (`usedUserConnection`), scratch tables (`OTS_MAP_`/`OTS_FALLBACK_`) go to the TARGET schema (session-scoped TEMPORARY; that connection can't write the internal schema) and metering runs on a separate service connection (caller-path exports must never bypass the meter). ⚠ **Parity gap:** the mssql/pg/mysql one-time paths still put scratch in the internal schema unconditionally — their personal-credential exports share the original latent bug; fix + live-test per warehouse before advertising the user-connection fallback there. | ✅ P7 — raw-value map table (BIN2, `COLLATE DATABASE_DEFAULT` on COALESCE arms — collation-conflict fix), `SELECT INTO`; overwrite = stage → DELETE + INSERT (permission-preserving). Live-tested create+overwrite (service connection only — see parity gap in the Snowflake cell). |
| File pipelines (`PIPELINE_FILE_ROWS`) | ✅ VARIANT + `PARSE_JSON` via `SELECT FROM VALUES`; `column_data['x']::VARCHAR` reads; SQL-side normalize metrics | ✅ P7 — plain `VALUES` inserts (ISJSON check constraint), `JSON_VALUE` + escaped JSON paths, app-side normalized dedup/metrics (`mssqlFileColumnMetrics`). Live-tested. |
| Lookup-table export (warehouse format) | ✅ `CREATE OR REPLACE TABLE` default `PRISM_DB.PUBLIC.*` | ✅ P7 — `DROP IF EXISTS` + `SELECT INTO`, default `PRISM_DB.EXPORTS.*`. |
| Spec-value seeding / mapping edits | ✅ Snowflake MERGEs in the column-specs + global-standardizations routes (domains removed 2026-07-15 — `domain_id` params/columns carry a `column_specs.spec_id`) | ✅ P7 — routed through the mssql mappings writers (HOLDLOCK MERGEs). |
| Pipeline creation (baseline + detection setup) | ✅ stream pre-create + CT auto-fix ladder; `GROUP BY PRISM_NORMALIZE` baseline (5k) | ✅ P6 — `initDetection` w/ CT-enable ladder (service → creator's personal creds → diff fallback, never blocks); baseline via capped diff scan. |
| Setup wizard | ✅ 5-step Snowflake flow | ✅ P6 — platform picker persists `warehouse_type`; mssql install-script step (login + CT templates), credential form (test/save, blank-keeps-secret), verify checklist; non-admin personal mssql variant. |

## PostgreSQL adapter (2026-08-11 — docs/POSTGRES_PORT_PLAN.md)

Third warehouse. One compact matrix here rather than a third column above —
same operations, pg-specific facts only. Everything below is **live-tested**
via `npm run test:pg-live` / `test:pg-detection` / `test:pg-lifecycle` (Docker
postgres:16) unless marked otherwise.

| Operation | PostgreSQL (`warehouse/postgres/`) |
|---|---|
| Install scope | ⚠️ ONE DATABASE, not a server — pg cannot query across databases. `01_internal_tables.postgres.sql` creates `prism_internal` + `prism_exports` SCHEMAS in the customer's database (lowercase snake_case — unquoted pg identifiers fold to lowercase, the opposite of Snowflake). `npm run pg:install` dev runner; `docs/DEV_POSTGRES.md` container recipe. |
| Service/personal/ad-hoc connection | `connection.ts` (`pg` driver, lint-guarded): env tier `PG_HOST/PORT/DATABASE/USER/PASSWORD/SSLMODE[/SSL_CA_PATH]` → workspace tier `workspace_config.pg_*` (migration 018, encrypted, 10 s cache); personal `accounts.pg_*`; `withAdHocPostgres` for setup. Fresh Client per call, `SET statement_timeout = 600000` (PRISM_WH parity). int8 parsed to Number. |
| Query execution | `?`→`$n` scanner (quote/dollar-quote/E-string/comment-aware, parity-tested). Bind ceiling 65,535 → `bindLimit 60_000`; Snowflake-sized 5k batches fit. Bind-free calls use the simple protocol → multi-statement `BEGIN; …; COMMIT` works. |
| Errors | SQLSTATE-based: access = 42501/42P01/3F000/3D000/28P01/28000 (+message fallbacks); poll triage global/table/transient in `classifyPgPollError` (42703 = watched column dropped → table). Sanitized responses; 28P01 → 401. |
| Change detection | **Diff-scan only** (`detection.ts` + `pipeline-poller-postgres.ts`): no stream/CT analog usable under a plain service role (logical replication needs elevated setup; triggers need customer-table DDL — deferred, not rejected). `detection_mode='diff'`, `diff_reason='pg_diff'` (own UI tooltip, no upgrade nudge). |
| Cheap "anything new?" | `pg_stat_user_tables` write counters (`n_tup_ins/upd/del`) — NO special grant needed (beats mssql's VIEW SERVER STATE ask). Counter-reset tolerated (fail-open scan). **Delete detection is FREE**: the del-counter delta flags the hygiene export rebuild the same cycle — mssql diff mode can't see deletes at all. Idle poll = zero table reads (live-proven via seq/idx-scan counters). |
| Source health | `pg_class`/`information_schema.columns` (cheap catalog); masking analog = **Row-Level Security** (`relrowsecurity`) → flag `policy_blocked` + skip + auto-recover (live-tested). |
| Normalization | App-side only, mssql rule. pg 13+ HAS `normalize()` — deliberately unused (a third implementation would have to agree with `normalizeLiteral` forever). Staging joins use `COLLATE "C"` (byte-wise; guards nondeterministic ICU database collations). |
| Bulk upserts | `INSERT … ON CONFLICT` (MERGE needs pg 15; floor is 13) against unique indexes the install creates — which also mechanically ENFORCE the one-row-per-(normalized_value, spec) invariant other warehouses keep only by convention. NULL-scope (domain_id IS NULL) conflicts target partial unique indexes (pg unique treats NULLs as distinct). `RETURNING` collapses the upsert-then-select round trip. In-batch normalized dupes raise "cannot affect row a second time" — caller dedupe contract unchanged. |
| Export rebuild | `export.ts`: staging join → `CREATE TABLE _new AS … ORDER BY` (CTAS honours ORDER BY; no TOP trick needed) → **transactional swap** (`BEGIN; DROP; ALTER RENAME; COMMIT` — pg DDL is transactional) → ACL capture/re-apply from `information_schema.role_table_grants` + `column_privileges` (no COPY GRANTS; no DENY concept; table-level grants deduped out of the per-column expansion). Order tiers: PK → unique index (no clustering keys — two tiers). Grant survival live-tested. |
| `export_kind 'view'` | ✅ SUPPORTED (refused on mssql): view reads source LEFT JOIN **persistent** per-column mapping tables (`prism_internal.viewmap_<md5>`), whose content refreshes transactionally each rebuild — the view object is stable, and new rows of already-mapped values appear through it IMMEDIATELY, no rebuild (live-tested). Offboarding materialize-before-drop caveat applies (CLIENT_ONBOARDING §12). |
| Column mode | `refreshStandardizedColumnsPg`: `ADD COLUMN IF NOT EXISTS` (needs table OWNERSHIP; consent SQL via `columnModeSetupSqlPg` — one generator) + guarded UPDATEs (steady-state touches 0 rows — live-proven via `n_tup_upd` delta). ⚠️ Companion column is a QUOTED case-sensitive identifier on pg (`"carrier_STANDARDIZED"`) — a hand-created companion with different case will not match. Same PRELAUNCH §1 bar as the other warehouses before customer use. |
| Run state / validation log | `prism_internal.run_state` JSONB (`ON CONFLICT` save; rev check `COALESCE((state->>'rev')::int,0)` + `RETURNING` landed-detection); `validation_log` same insert contract. Shared SQL resolves table names via `_lib/warehouse-tables.ts` `internalTable()` — snowflake AND mssql keep `PRISM_DB.INTERNAL.*`, pg gets `prism_internal.*`. |
| One-time / file rows / lookup export | Ported P3 (mirroring the mssql P7 shapes): pg map table `COLLATE "C"`, overwrite = staged `BEGIN; DELETE; INSERT; COMMIT`; `one_time_file_rows` JSONB via `?::jsonb` binds + `->>` reads; lookup export default `prism_exports.<name>_lookup`; `prism_internal` targets refused. Code-verified + covered by the setup suite. |
| Setup / grants | No programmatic grants pass (mssql rule — the service role can't grant): install script + role templates run by the customer's admin; Part-D analog emits per-schema `GRANT USAGE/SELECT` + `ALTER DEFAULT PRIVILEGES` (⚠️ footgun: default privileges only cover tables created by the role that ran the statement — run FOR ROLE per owning role). Kill switch: `ALTER ROLE prism_svc NOLOGIN`. |
| Cost model | Provisioned capacity — protect load (heartbeat-gated tiered scans). ⚠️ Scale-to-zero providers (Neon; Aurora Serverless): steady polling holds them awake — best-effort host detection (`isScaleToZeroHost`, Neon only) warns once per process + cadence stretch ×10; disclose in onboarding regardless. |
| Version floor | PostgreSQL 13+ (ON CONFLICT/partial indexes/JSONB all present; MERGE and NULLS NOT DISTINCT deliberately avoided). Managed flavors (RDS, Cloud SQL, Azure, Supabase, Neon) are the same wire protocol — no per-cloud variants. |

## MySQL adapter (2026-08-12 — docs/MYSQL_PORT_PLAN.md)

Fourth warehouse. Same compact-matrix treatment as the PostgreSQL section.
Everything below is **live-tested** via `npm run test:mysql-live` /
`test:mysql-detection` / `test:mysql-lifecycle` / `test:mysql-setup` (Docker
mysql:8.0) unless marked otherwise.

| Operation | MySQL (`warehouse/mysql/`) |
|---|---|
| Install scope | Databases ARE schemas (no schema level; `CREATE SCHEMA` = `CREATE DATABASE`) and **cross-database joins work** — Prism gets sibling DATABASES `prism_internal` + `prism_exports`; sources may live in ANY database granted to the service account (no pg-style one-database limit). FQNs are TWO-part `database.table`; 3-part rejects loudly. `internalTable()` needs no new arm — the pg spelling `prism_internal.<table>` means database.table here. Lowercase names throughout (`lower_case_table_names` is OS-dependent). |
| Connection | `connection.ts` (`mysql2` driver, lint-guarded): env tier `MYSQL_HOST/PORT/DATABASE/USER/PASSWORD/SSL` → workspace `workspace_config.my_*` (migration 019, encrypted, 10 s cache); personal `accounts.my_*`; ad-hoc for setup. Per-connection session: `MAX_EXECUTION_TIME=600000` (⚠️ SELECT-only — writes are bounded by innodb_lock_wait_timeout, documented not pretended) **and `information_schema_stats_expiry = 0` — LOAD-BEARING**: the 24h default caches UPDATE_TIME/TABLE_ROWS and would blind the detection heartbeat for a day (live-proven fresh: writes detected the same minute). |
| Query execution | Placeholders are NATIVE `?` — translateBinds validates/counts only (quote/backtick/#-comment-aware, parity-tested). `bindLimit 60_000` for batching consistency (client-side interpolation has no protocol ceiling). DML resolves to `[OkPacket]` — `affectedRows` is the RETURNING/OUTPUT analog. |
| Errors | errno-based: access = 1044/1142/1143/1146/1045/1049; poll triage global (1045/1049) / table (1044/1142/1143/1146/1054) / transient (1213/1205/1040 + socket codes). 28P01-style login → 401. ⚠️ `READS` is a reserved word (stored-routine characteristics) — never use it as an alias. |
| Change detection | **Diff-scan only** (`detection.ts` + `pipeline-poller-mysql.ts`); binlog/CDC rejected (REPLICATION privileges + server config), triggers rejected (customer-table DDL). `diff_reason='mysql_diff'` (own nudge-free tooltip). Heartbeat = `information_schema.TABLES.UPDATE_TIME` (fresh via stats_expiry=0): second-granularity (fine at minute cadence), NULL after ANY server restart → fail-open scan, and ⚠️ **delete-blind** — unlike pg's counter heartbeat there is NO same-cycle delete flag; deletes surface via the hourly safety rebuild (the mssql diff-mode story). Idle poll = zero table reads (live-proven via performance_schema I/O counters). |
| Uniqueness / InnoDB key limits | **No partial indexes** + UNIQUE treats NULLs as always-distinct → functional key parts with a `COALESCE(domain_id,-1)` sentinel. **InnoDB caps index keys at 3072 bytes** (800-char utf8mb4 = 3200), so the queue/lookup unique keys are functional **SHA2-hash keys** (`(pipeline_id, SHA2(literal_value,256))`, `(COALESCE(domain_id,-1), SHA2(normalized_value,256))`) with a 191-prefix secondary index for lookups — collision-safe for dedup, serves ON DUPLICATE KEY, and mechanically ENFORCES the one-row-per-(normalized,scope) invariant (live-tested). This is why the **version floor is 8.0.13 → raised to 8.0.19**: the row-alias upsert form (`VALUES … AS new ON DUPLICATE KEY UPDATE col = new.col`) is the only spelling valid across the range — `VALUES()` is deprecated 8.0.20 and REMOVED in 8.4. |
| Normalization / byte-exact joins | App-side only (the standing rule). Staging columns `CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`; **source side must go through `binaryCompare(expr)` = `CONVERT(expr USING utf8mb4) COLLATE utf8mb4_bin`** — a bare COLLATE on a legacy latin1 column is error 1253 (live-proven both ways with the latin1 demo fixture). Distinct scans GROUP BY binaryCompare (the KI-138 rule); COALESCE arms in exports CONVERT both sides (illegal-mix-of-collations otherwise). Legacy charsets are mainline at target customers, not an edge case. |
| Bulk upserts | Row-alias ON DUPLICATE KEY (mappings.ts); alias-id maps via upsert-then-SELECT (no RETURNING). 5k batches. |
| Export rebuild | `export.ts`: staging join → ordered CTAS → **ATOMIC multi-`RENAME TABLE cur→old, new→cur`** (DDL is non-transactional but multi-RENAME is atomic) → DROP old; stale `__prism_old_*`/`__prism_new_*` swept at each rebuild start (crash-safety). ACLs from information_schema.TABLE_/COLUMN_PRIVILEGES (column grants deduped against table-level), grantees replayed **verbatim as `'user'@'host'`** — a bare-name re-grant implicitly means @'%' and can address a different account. No DENY concept. Order tiers: PK → unique key. Grant survival live-tested. |
| `export_kind 'view'` | ✅ SUPPORTED (pg design): `CREATE OR REPLACE VIEW` over persistent `prism_internal.viewmap_<md5>` mapping tables refreshed inside DML transactions — new rows of known values appear through the view with no rebuild (live-tested). Offboarding materialize-before-drop caveat applies. |
| Column mode | `refreshStandardizedColumnsMysql`: privilege-based (no ownership concept — ALTER + UPDATE per table); **no ADD COLUMN IF NOT EXISTS on MySQL 8.0** — catalog check first, errno 1060 (duplicate column) = already-provisioned. Guarded UPDATEs; steady-state 0 writes live-proven via performance_schema COUNT_WRITE. Same PRELAUNCH §1 bar before customer use. |
| Run state / validation log | `prism_internal.run_state` native JSON (row-alias upsert; rev check `COALESCE(CAST(state->>'$.rev' AS SIGNED),0)`; landed-detection via `affectedRows`); validation_log via `internalTable()`. |
| One-time / file rows / lookup export | M3 fork sweep: map table WITHOUT a PK (200+800 utf8mb4 composite exceeds the key limit — app-side dedup + 191-prefix KEY); JSON reads `column_data->>'$."…"'` (reuses the mssql JSON-path escaper — valid MySQL escaping, one helper no drift); lookup export default `prism_exports.<name>_lookup`; `prism_internal` targets refused. Live-tested via the setup suite. |
| Detection/ordering dialect | No `NULLS LAST` — order with `(col IS NULL), col`; no `SPLIT_PART` — `SUBSTRING_INDEX(x,' ',1)`; ENUM counts as a text type (categorical strings — Prism's domain), SET excluded. |
| Setup / grants | No programmatic grants pass (the mssql/pg rule); source grants are per-DATABASE `GRANT SELECT ON <db>.* TO 'prism_svc'@'%'` — covers future tables automatically (**no pg default-privileges footgun**). Kill switch: `ALTER USER 'prism_svc'@'%' ACCOUNT LOCK`. |
| Cost model | Provisioned capacity — protect load via heartbeat-gated tiers. ⚠️ Sleep-on-idle: PlanetScale (`*.psdb.cloud` host sniff, once-per-process warning) and Aurora Serverless v2 (not host-detectable) — onboarding disclosure required. |
| Version floor | **MySQL 8.0.19+** (row-alias upserts; functional key parts landed 8.0.13). Validate 8.4 LTS before a real customer. **MariaDB explicitly deferred** — no functional key parts; the follow-on design is generated columns + unique indexes. |

## SQL Server index-key limits in the export staging table (2026-08-07)

The per-rebuild alias staging table keys on `raw_value NVARCHAR(800)` to match
`LITERAL_ALIAS_MATCHES`. Its primary key **must be declared `NONCLUSTERED`**:

| Index type | Max key size | Max NVARCHAR chars |
|---|---|---|
| Clustered (SQL Server's default for `PRIMARY KEY`) | 900 bytes | 450 |
| Nonclustered | 1700 bytes | 850 |

A bare `PRIMARY KEY` is clustered, so any mapped literal longer than 450
characters threw *"The index entry of length N bytes … exceeds the maximum
length of 900 bytes"* and aborted the **entire** table's export rebuild — one
long value took the whole standardized output down. Snowflake has no
equivalent constraint (no index keys), which is why this never showed up on the
original adapter. Parity-tested: the declared length, both byte limits, and the
`NONCLUSTERED` keyword are all asserted in `scripts/parity-tests.ts`.

## Seeing a permission vs. seeing who holds it (2026-08-07)

These are separate privileges in SQL Server, and conflating them silently
revoked downstream access across export rebuilds:

- `sys.database_permissions` rows for an object become visible with **CONTROL**
  on that object (what `GRANT CONTROL ON SCHEMA::…` confers).
- Resolving the grantee's **name** via `sys.database_principals` additionally
  needs **VIEW DEFINITION on that specific principal**.

So the grant-capture query could see that a permission existed while being
unable to name its holder. With an inner `JOIN` those rows vanished from the
result set, the rebuild re-granted nothing, and the consumer lost access with
no message — while `HAS_PERMS_BY_NAME` reported the pipeline healthy. The query
now uses a `LEFT JOIN` and flags the unresolvable count with the remediation
(`GRANT VIEW ANY DEFINITION TO <service login>`), which grants no data access.
Snowflake's `SHOW GRANTS` has no equivalent split.

## Never tell an admin to `ALTER AUTHORIZATION ON SCHEMA` (2026-08-07)

Prism used to instruct admins to run
`ALTER AUTHORIZATION ON SCHEMA::<export_schema> TO <service login>` so exports
could preserve grants. **That statement silently drops every existing
object-level permission in the schema, immediately, before any rebuild runs** —
so the remediation destroyed exactly the access it was meant to protect, and
neither of the product's warnings fired. Live-reproduced: a consumer's `SELECT`
went from 1 permission row to 0 the instant the ALTER ran.

Use **`GRANT CONTROL ON SCHEMA::<export_schema> TO <service login>`** instead.
Verified live to be a strict improvement on every axis:

| | `ALTER AUTHORIZATION` | `GRANT CONTROL` |
|---|---|---|
| Existing grants | **destroyed** | preserved |
| CONTROL + VIEW DEFINITION on the schema | yes | yes |
| Applies to newly built tables in the schema | yes | yes |
| Transfers ownership | yes | **no** |

## Grant capture must preserve permission STATE (2026-08-07)

`sys.database_permissions.state` distinguishes `G` (grant), `W` (grant WITH
GRANT OPTION) and `D` (deny). The capture query filtered to `('G','W')` and
replayed everything as a plain `GRANT`, so each rebuild silently rewrote the
access model: a **DENY vanished entirely** (and DENY overrides GRANT in SQL
Server, so "this account must not read this" became no rule at all), and
`WITH GRANT OPTION` was downgraded, stripping a delegated admin's ability to
re-grant. Capture now includes `D` and replays each row in its original state.
Live-verified: `a:SELECT:G`, `b:SELECT:W`, `c:SELECT:D` all round-trip a
drop/rename/replay cycle unchanged. Snowflake's `COPY GRANTS` handles this
natively — the split only exists on this adapter.

## `SELECT … INTO` silently drops `ORDER BY` without `TOP` (2026-08-08)

SQL Server **ignores** `ORDER BY` on a `SELECT … INTO` whose destination is a
heap unless the query also has a `TOP`. It is not an error and there is no
warning — the rows simply land unordered.

The mssql export rebuild resolved its PK/unique/clustered ordering tier
correctly and appended `ORDER BY`, so the code read as if source order was
preserved. It never was. Live-reproduced: a PK-keyed source whose rows were
inserted `5,3,1,4,2,8,6,7` rebuilt into exactly that scrambled order, while the
Snowflake builder's equivalent tier worked — the two warehouses silently
disagreed about documented behaviour (OUT-03).

Fixed by emitting `TOP (9223372036854775807)` whenever an ordering applies. That
is a *cap*, not a limit, so it selects every row; verified live that the same
fixture comes back `1,2,3,4,5,6,7,8` with all 8 rows intact.

As on Snowflake, this only affects the PHYSICAL order rows are written in.
Consumers needing guaranteed order must still `ORDER BY` the key columns
themselves — they are present in the export.

| | Snowflake | SQL Server |
|---|---|---|
| Ordered rebuild | `CREATE OR REPLACE TABLE … AS SELECT … ORDER BY` | `SELECT TOP (…) … INTO … ORDER BY` — **`TOP` mandatory** |
