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

## Connection & errors

| Operation | Snowflake | SQL Server (planned) |
|---|---|---|
| Service connection | ✅ `withWarehouse` → workspace_config (SQLite, encrypted) → `SNOWFLAKE_*` env fallback. Fresh connection per call, destroyed in `finally`. Key-pair JWT preferred; password+MFA fallback (MFA error 394508 → "use key-pair"). | ✅ P3 — `warehouse/mssql/connection.ts` (`mssql` driver), env tier (`MSSQL_SERVER/USER/PASSWORD/DATABASE/ENCRYPT/TRUST_SERVER_CERT`); fresh size-1 pool per call, closed in finally; 600 s request timeout (parity with PRISM_WH). Workspace tier ✅ P6 (`workspace_config.ms_*`, encrypted, 10 s cache; saved from `/setup` step 3 via `/api/accounts/workspace-mssql`). Factory: workspace_config.warehouse_type → `PRISM_WAREHOUSE_TYPE` env → snowflake. Entra ID: future (SQL auth first). |
| Personal connection | ✅ `withUserWarehouse(accountId, fn)` — `accounts.sf_*`, encrypted. Used ONLY by one-time flow fallback + change-tracking auto-fix. | ✅ P6/P7 — `accounts.ms_*` (migration 010, encrypted), `withUserMssql`; saved via `/api/accounts/mssql-config` (member-savable, no grants pass) + the non-admin `/setup` mssql variant. Same one-time-only rules. Live-tested. |
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
| One-time export | ✅ temp map table + `PRISM_NORMALIZE` join, `CREATE OR REPLACE TABLE` (DELETE+INSERT permission fallback) | ✅ P7 — raw-value map table (BIN2, `COLLATE DATABASE_DEFAULT` on COALESCE arms — collation-conflict fix), `SELECT INTO`; overwrite = stage → DELETE + INSERT (permission-preserving). Live-tested create+overwrite. |
| File pipelines (`PIPELINE_FILE_ROWS`) | ✅ VARIANT + `PARSE_JSON` via `SELECT FROM VALUES`; `column_data['x']::VARCHAR` reads; SQL-side normalize metrics | ✅ P7 — plain `VALUES` inserts (ISJSON check constraint), `JSON_VALUE` + escaped JSON paths, app-side normalized dedup/metrics (`mssqlFileColumnMetrics`). Live-tested. |
| Lookup-table export (warehouse format) | ✅ `CREATE OR REPLACE TABLE` default `PRISM_DB.PUBLIC.*` | ✅ P7 — `DROP IF EXISTS` + `SELECT INTO`, default `PRISM_DB.EXPORTS.*`. |
| Spec-value seeding / mapping edits | ✅ Snowflake MERGEs in the column-specs + global-standardizations routes (domains removed 2026-07-15 — `domain_id` params/columns carry a `column_specs.spec_id`) | ✅ P7 — routed through the mssql mappings writers (HOLDLOCK MERGEs). |
| Pipeline creation (baseline + detection setup) | ✅ stream pre-create + CT auto-fix ladder; `GROUP BY PRISM_NORMALIZE` baseline (5k) | ✅ P6 — `initDetection` w/ CT-enable ladder (service → creator's personal creds → diff fallback, never blocks); baseline via capped diff scan. |
| Setup wizard | ✅ 5-step Snowflake flow | ✅ P6 — platform picker persists `warehouse_type`; mssql install-script step (login + CT templates), credential form (test/save, blank-keeps-secret), verify checklist; non-admin personal mssql variant. |

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
