# Prism — Microsoft SQL Server Integration Plan

The implementation plan for supporting Microsoft SQL Server as an alternative
warehouse. A customer chooses their warehouse **once, at setup**: Snowflake
installs keep working exactly as today; SQL Server installs run every
warehouse-touching function — source reads, change detection, the internal
data-plane tables, export tables — against their SQL Server instead. Prism is
single-tenant, so one installation only ever has one warehouse type; nothing
needs to mix at runtime.

Design decisions in this document were settled in July 2026 (see
`PRODUCT_DECISIONS.md` for the tradeoff log style this follows). Rough total
effort: 12–16 engineer-weeks.

---

## 1. What changes and what doesn't

**Unchanged** (roughly half the codebase):
- The SQLite app-state store and everything in it (accounts, column specs — formerly domains, runs,
  pipelines, workspace config) — the two-store split survives; only the
  "warehouse half" becomes pluggable.
- All LLM grouping/merge/validation logic (`llm-one-prompt-grouping.ts`,
  `op-auto-group-run.ts`, the referee in `op-export.ts` above the write layer).
- The review UI, run state blob, sessions/auth, invitations, Google OAuth.
- Google Sheets / CSV / Excel pipeline logic (the file rows table moves with
  the warehouse, but the flows are warehouse-agnostic).

**Ported to the active warehouse** (runs on Snowflake today → runs on SQL Server when selected):
- The four data-plane tables: `LITERAL_ALIAS_MATCHES`, `APPROVED_ALIAS_NAMES`,
  `PIPELINE_QUEUE`, `PIPELINE_FILE_ROWS` — they must live where the customer's
  source data lives, because export joins run against source tables in SQL.
- Change detection (streams → Change Tracking / diff scans).
- Distinct-value scans, export table rebuilds, bulk mapping upserts.
- Install script, grants model, verify-install probes, connection testing.

---

## 2. Settled design decisions

### 2.1 Change detection: Change Tracking fast path, diff-scan universal fallback

SQL Server's **Change Tracking (CT)** is the delete-aware analog of Snowflake
streams. Unlike streams it requires altering the customer's database
(`ALTER DATABASE … SET CHANGE_TRACKING = ON` + per-table enable) and requires
a **primary key** on tracked tables.

- **Onboarding** encourages enabling CT database-wide: one click if the
  connecting user has permission, otherwise the wizard shows the exact command
  for their DBA. Never blocks.
- **Per pipeline, decided automatically at creation**: CT when the table
  qualifies (PK exists + CT enabled), otherwise **diff-scan mode**. The mode is
  shown on the pipeline card with upgrade nudges ("enable Change Tracking" /
  "add an index on this column").
- **Enablement reuses the existing Snowflake auto-fix ladder**
  (`attemptChangeTrackingFix` / `withUserSnowflake`): try the service
  connection → try the pipeline creator's saved personal credentials → on SQL
  Server, fall back to diff-scan (Snowflake has no fallback and pauses with
  fix SQL). The two warehouses' onboarding asks are now symmetric — Snowflake
  pipelines also require change tracking enabled on source tables.
- **Rejected**: keeping a PK-added copy of PK-less tables to satisfy CT. It's
  circular — keeping the copy in sync requires the change detection you lack.
  Also rejected: altering customer tables to add keys.

**Diff-scan mode mechanics** (aligned with the current poller architecture —
minute-mark poll passes, detection-only; standardization happens at the
10-minute tick per `update_schedule`):

1. Every minute-mark pass, a **free heartbeat**: read
   `sys.dm_db_index_usage_stats.last_user_update` (in-memory DMV, no table
   access) — "was this table written to since I last looked?" Needs
   `VIEW SERVER STATE`; without it, degrade to running scans on the tier
   schedule without the gate (correct, slightly more load).
2. Only when the heartbeat fires, the **real scan**: `SELECT DISTINCT` of the
   watched column, compared against the queue + lookup to find new values
   (which are queued, exactly like stream results).
3. **Scan tiers by table size, then self-tuned**: <1M rows → scan every pass;
   1–50M → every ~2–3 passes; >50M → every ~10 passes. Initial tier from
   catalog row count (free); promoted/demoted by measured scan duration (a big
   indexed table earns the fast tier; a slow small one gets demoted).
   Thresholds live as constants in one place.
4. **Deletes need no special detection** in diff-scan mode: export rebuilds
   select from the current source, so removed rows fall out at the next
   rebuild (the hourly safety rebuild covers the long tail, same as Snowflake).

### 2.2 Normalization: app-side only — no T-SQL port of PRISM_NORMALIZE

SQL Server has no JavaScript UDFs, no native Unicode NFC normalization in
T-SQL, and CLR is unavailable on Azure SQL Database. Porting the UDF would
create two SQL implementations that must agree with `normalizeLiteral()`
forever — and any silent drift breaks matching with no error anywhere. That is
Prism's worst possible failure mode, so we eliminate the need instead:

- **Every normalization happens in the app**, using the one existing TS
  function, unchanged. `LITERAL_ALIAS_MATCHES.normalized_value` continues to be
  materialized at write time (computed in TS — it already is on most paths).
- **Joins against source data use a staging table**: pull the column's
  distinct raw values (cheap — categorical columns), normalize + resolve
  aliases in the app, write a temp exact-match mapping table
  (`raw_value → alias`) into the customer's SQL Server, and run the big
  million-row export join on **raw equality**.
- **Collation trap**: SQL Server default collations are case-INsensitive, so
  every exact-match join must specify `COLLATE Latin1_General_100_BIN2` (or
  the staging table's columns are created with it). Without this, values you
  meant to keep distinct silently over-match.
- **Accepted cost**: a hard cap on distinct values per column (they must pass
  through app memory per rebuild). Fine — Prism only standardizes categorical
  columns, and the 5,000-value queue-drain installments already impose the
  same shape of limit. Cap violations pause the pipeline with a clear message
  (scale limits defer or refuse loudly, never drop silently).

### 2.3 Cost model: protect server load, not a bill — except serverless Azure

SQL Server bills by provisioned capacity, not activity, so the Snowflake
wake-cost discipline mostly relaxes: the thing to protect is the customer's
CPU/IO headroom, which the heartbeat-gated tiered scans do.

- **CT's own cost** (disclose in onboarding): small DML overhead on tracked
  tables plus change-table storage for the retention window (default 2 days,
  auto-cleaned).
- **⚠️ Azure SQL serverless tier auto-pauses like a Snowflake warehouse.** A
  minute-mark heartbeat would hold it awake 24/7 and silently negate the
  customer's auto-pause savings — the exact failure mode the Snowflake poller
  was engineered to avoid. The adapter must detect the serverless service
  objective at connection time and stretch polling cadence (and/or warn at
  setup). Provisioned Azure tiers and on-prem/VM SQL Server are unaffected.

---

## 3. Architecture: the warehouse adapter

```
stand-ui/app/api/_lib/warehouse/
  types.ts        ← WarehouseAdapter interface + shared types (the contract)
  index.ts        ← factory: reads the install's warehouse type from
                     workspace_config (env fallback), returns the adapter singleton
  snowflake/      ← today's code, relocated: connection.ts, detection.ts,
                     export.ts, mappings.ts, grants.ts, verify.ts, dialect.ts
  mssql/          ← the new implementation, same file shape
```

**The one hard rule: routes, the poller, and the tick processor talk ONLY to
the interface.** No `snowflake-sdk` or `mssql` import may exist outside
`warehouse/`. Once that holds, adding a method to the interface makes
TypeScript refuse to build until every warehouse implements it — "we forgot
the SQL Server half" becomes a compile error, not a code-review catch. (The
in-repo precedent for this shape is the LLM multi-provider dispatch:
`callAnthropicWithRetry` + `OPENAI_STYLE_PROVIDERS` is one dispatch point that
made all downstream code provider-agnostic.)

### 3.1 The interface (grounded in current call sites)

Derived from the 36 files that call `withSnowflake`/`createSnowflakeConnection`
today. Operations grouped by concern:

**Connection & errors**
- `withConnection(fn)` / `withUserConnection(accountId, fn)` — service and
  personal-credential execution (today: `withSnowflake` / `withUserSnowflake`).
- `testConnection(config)` — powering `/api/accounts/test-snowflake`.
- `classifyError(err)` — access-denied vs infra vs transient vs
  change-detection-privilege (today: `isSnowflakeAccessError`,
  `isChangeTrackingPrivilegeError`, `classifyPollError`).
- `sanitizeErrorForClient(err)` — no raw SQL/driver messages to the browser.

**Change detection (the poller's surface)**
- `ensureDetection(pipeline)` — create stream / verify CT state, including the
  auto-fix ladder and gap recovery (today: stream create + `recoverAfterStreamReset`).
- `hasChanges(pipeline)` — the free check: `SYSTEM$STREAM_HAS_DATA` /
  DMV heartbeat + `CHANGE_TRACKING_CURRENT_VERSION()` comparison. Must never
  wake/scan anything on the idle path.
- `consumeChanges(pipeline)` — classify + queue new values, report deletes
  (today: the stream-consuming MERGE; mssql: `CHANGETABLE(CHANGES …)` or the
  tiered diff scan, per the pipeline's mode).
- `checkSourceHealth(pipeline)` — table/column existence, type still text,
  masking-policy detection (today: `SHOW COLUMNS` + `POLICY_REFERENCES`;
  mssql: `sys.columns` + `sys.masked_columns` — both cheap catalog reads).

**Scans & metadata**
- `scanDistinctValues(relation, column, opts)` — the deduped distinct scan
  (today: `GROUP BY PRISM_NORMALIZE(...)` + `ANY_VALUE`; mssql:
  `SELECT DISTINCT` + app-side `normalizeLiteral` dedup — this sidesteps the
  `ANY_VALUE` 2022+ version gate entirely rather than branching on it, so it
  behaves identically on 2019 and 2022+ with no `MIN()` fallback needed).
- `listColumns(relation)` / `previewRows(relation, column)` — the connect-form
  and one-time-flow probes (INFORMATION_SCHEMA is fine and cheap on mssql).

**Writes**
- `bulkUpsertMappings(rows)` — batched idempotent MERGEs into the lookup
  (both dialects have MERGE; mssql needs `WITH (HOLDLOCK)` and the same
  5,000-row batching — its parameter ceiling is ~2,100 binds/statement, so
  batches are smaller or use TVPs/JSON payloads; decide in Phase 5).
- `queueValues(pipelineId, values)` / `drainQueue(pipelineId, limit)` — the
  `PIPELINE_QUEUE` MERGE + FIFO installment reads.
- `rebuildExportTable(pipeline)` — today `CREATE OR REPLACE TABLE … COPY
  GRANTS AS SELECT`, physically sorted to mirror the source only when it has a
  PK / unique key / clustering key (no synthetic order column — removed
  2026-07); mssql: build `_new` table from the
  staging-table join, then swap inside a transaction (`sp_rename` or
  drop+rename — T-SQL DDL is transactional, which makes the swap atomic), then
  re-apply permissions (no COPY GRANTS equivalent — track and re-grant).
- `writeStagingMappings(pipeline, rows)` — mssql-only internally (Snowflake
  impl is a no-op/inline), but exposed as one operation so callers stay
  warehouse-blind.

**Install & admin**
- `getInstallScript()` — serves `/setup` step 2 (today reads `00/01_*.sql`;
  mssql serves the T-SQL install file).
- `applyGrants(config)` — programmatic grants with the "already in place =
  green" pre-check pattern (mssql: `CREATE LOGIN/USER/ROLE`, `GRANT`).
- `verifyInstall()` — the step-5 checklist probes (today: `SHOW` commands;
  mssql: catalog views — all cheap).

**Dialect helpers** (pure, unit-testable)
- `quoteIdent(name)` (`"x"` vs `[x]`), `parseFqn(fqn)` (both are
  `db.schema.table`, but bracket/quote rules differ), `sqlStringLiteral(s)`,
  bind-parameter style (`?` vs `@pN` — the mssql driver layer maps this).

### 3.2 State additions

- `workspace_config` (SQLite migration): add `warehouse_type`
  (`'snowflake' | 'mssql'`, default `'snowflake'`) + mssql credential fields
  (server, database, auth mode, user, password/Entra fields — secrets
  `enc:v1:` encrypted like everything else).
- `accounts`: generalize the personal-credential columns (the `sf_*` names
  stay for Snowflake; add mssql equivalents rather than renaming — renames buy
  nothing pre-launch but the reset workflow makes either cheap).
- `pipelines`: add `detection_mode` (`'ct' | 'diff'`, Snowflake rows use
  `'stream'`) + a `detection_state` JSON column (CT sync version, diff-scan
  tier, last content fingerprint) — per-pipeline detection bookkeeping that
  today lives implicitly in the stream offset.
- New warehouse-side table (mssql installs): the temp staging-mapping table is
  created per rebuild in `PRISM_DB.INTERNAL` and dropped after; no permanent
  schema addition beyond the ported four tables.
- mssql export default schema is `PRISM_DB.EXPORTS` (not PUBLIC — name
  collides with SQL Server's built-in database role).

---

## 4. Phases

Build order is **refactor-first**: Phase 1 ships with zero behavior change on
Snowflake, which de-risks everything after it.

### Phase 1 — Adapter extraction (Snowflake-only, zero behavior change) · ~1.5–2 wk

> **STATUS: implemented 2026-07** — `_lib/warehouse/` created (`types.ts`
> contract, `snowflake/connection.ts` = relocated `snowflake.ts` + adapter
> object + `createAdHocSnowflakeConnection`, `index.ts` facade), `_lib/env.ts`
> split out (`getOptionalEnv`/`isFreshSetupSim`), all ~40 consumers rewired
> (`withWarehouse`/`withUserWarehouse`/`executeQuery`/`isWarehouseAccessError`/
> `warehouseErrorResponse`), ~34 duplicated local `exec()` helpers consolidated
> into the shared `executeQuery`, driver-import lint guard added
> (`no-restricted-imports` on `snowflake-sdk` outside `warehouse/`), CLAUDE.md
> updated with the layout + decision test. tsc + production build green; manual
> Snowflake regression still pending (exit criteria below).
- Create `warehouse/types.ts` + `warehouse/snowflake/*` by relocating existing
  code; `index.ts` factory returns the Snowflake adapter unconditionally.
- Convert all 36 consumer files to the interface. Mechanical, but every diff
  must be behavior-preserving — review each hot path (`pipeline-poller.ts`,
  `pipeline-hourly-processor.ts`, `op-export.ts`, `export-table.ts`,
  `op-file-pipeline.ts`) individually.
- Add the lint guard: no driver imports outside `warehouse/`.
- **Exit criteria**: full manual regression on Snowflake — pipeline lifecycle
  (create → baseline → activate → detect insert/delete → tick standardizes →
  export updates), one-time flow, Sheets pipeline, exports. Poller restarted
  (hot reload doesn't replace it).

### Phase 2 — Parity system · ~0.5 wk (alongside Phase 1)

> **STATUS: implemented 2026-07** — `docs/WAREHOUSES.md` matrix written
> (per-operation × per-warehouse with quirks + status legend);
> `.claude/skills/warehouse-change` checklist skill created; parity tests at
> `stand-ui/scripts/parity-tests.ts` (`npm run test:parity`, tsx devDep) —
> normalizeLiteral ⇄ PRISM_NORMALIZE UDF (body extracted from
> `01_internal_tables.sql`) over an NFC/NFD/control-char corpus + null-boundary
> semantics + `sqlStringLiteral` escaping, all green; CLAUDE.md rules/decision
> test were delivered during Phase 1 and now point at the matrix + skill.
- CLAUDE.md section: the abstraction rules + the decision test ("touches SQL,
  change detection, exports, grants, or normalization? → adapter change,
  implement for every warehouse before it ships").
- `docs/WAREHOUSES.md` parity matrix: one row per interface operation, one
  column per warehouse, with quirks (BIN2 collation, version-floor-agnostic
  dedup via `SELECT DISTINCT` + app-side normalize (no `ANY_VALUE`/`MIN()`
  branch), CT needs PK, bind-parameter ceilings, wake-cost rules vs
  always-on load, serverless Azure caveat).
- `.claude/skills/warehouse-change` checklist skill (update interface →
  implement per warehouse → update matrix → note untested paths).
- Parity test file for pure logic that runs with **no live database**:
  normalization fixtures, SQL text generation per dialect, FQN parsing,
  quoting. Runs alongside `npm run lint`.

### Phase 3 — SQL Server foundation: schema, connection, dialect · ~1.5–2 wk

> **STATUS: implemented 2026-07** — `01_internal_tables.mssql.sql` (INTERNAL +
> EXPORTS schemas — "PUBLIC" collides with the built-in role; BIN2 collation;
> NVARCHAR caps 800/450 for the 1700-byte index-key limit; ISJSON constraint;
> roles + login/CT templates; TEST_DB demo with CT on) + `npm run
> mssql:install` GO-batch runner + `docs/DEV_MSSQL.md` Docker recipe.
> `warehouse/mssql/`: `dialect.ts` (bracket quoting, FQN parse, quote/comment-
> aware `?`→`@pN` translation, `isServerlessAzureTier`) + `connection.ts`
> (env-config service connection, `executeQuery` with explicit type mapping,
> error numbers classification, sanitized responses, once-per-process
> serverless warning) + `mssqlAdapter`; factory switches on
> `PRISM_WAREHOUSE_TYPE` env (dev switch until P6). Deps: `mssql`,
> `@types/mssql`, `server-only` (explicit). **Exit criteria met live** on
> Docker SQL Server 2022 (Rosetta on Apple Silicon — enabled in Docker
> Desktop): install clean, adapter CRUD with `?` binds, BIN2 case-sensitivity,
> CT enabled, ISJSON rejection, access-error classification
> (`scripts/live-mssql-test.mts`). Azure SQL DB validation deferred to P8.
> Snowflake regression: tsc + build + parity green.
- `01_internal_tables.mssql.sql`: the four tables (IDENTITY PKs,
  `NVARCHAR(MAX)` for JSON columns, BIN2 collation on `normalized_value` and
  staging join columns), the `PRISM_SERVICE`/`PRISM_DATA_ADMIN` role
  equivalents (database roles + a login), no UDF (decision 2.2), no warehouse.
- `warehouse/mssql/connection.ts` on the `mssql` (tedious) package: SQL auth +
  Entra ID; per-request connection matching the current model (a small pool is
  fine here — no wake cost — but keep semantics identical first, optimize
  later); error classification + sanitization; serverless-tier detection.
- Dialect helpers + the parity tests for them.
- Dev environment: `mcr.microsoft.com/mssql/server` Docker recipe in the
  README; a scripted dev reset mirroring the `01` + `reset-app-state` flow.
- **Exit criteria**: connection test, install script runs clean on Docker
  mssql + Azure SQL DB, parity tests green.

### Phase 4 — Change detection engine · ~3–4 wk (the biggest phase)

> **STATUS: implemented 2026-07** — SQLite migration 009
> (`pipelines.detection_mode`/`detection_state`; Snowflake rows backfilled to
> 'stream'). `warehouse/mssql/detection.ts` (pure ops: mode init w/ CT-enable
> attempt, CHANGETABLE consumption + min-valid staleness reconcile, DMV
> heartbeat, capped tiered diff scan, unknown-value filtering, bind-ceiling
> batched queue MERGE, catalog health check) + `_lib/pipeline-poller-mssql.ts`
> (orchestration: state persistence, health cadence, pause/flag/alerts,
> freshness semantics). Poller dispatches by adapter kind inside pollOneTable
> (same result contract; scan spans/rebuild dedup/sync stamping unchanged);
> tick processor + export rebuilds guarded with Phase-5 skip logs. API exposes
> `detection_mode`/`detection_reason`; ActivityTab shows a Change Tracking /
> Scheduled-scan hint with upgrade nudges. Tier + error-classification logic
> parity-tested; **all exit criteria live-tested on Docker SQL Server 2022**
> (`npm run test:mssql-detection`): CT insert/known-value/update/delete,
> consistent snapshot, retention-expiry reconcile + gap recovery + re-baseline,
> freshness frozen while queued, PK-less diff fallback (no_pk), heartbeat
> idle-skip, new-value scan queue, DDM flag+skip, dropped-table pause.
> Snowflake regression: tsc + build + parity green. NOT yet possible on mssql
> (by design, Phase 5): standardization tick, export rebuilds, pipeline
> creation via UI.
- CT path: enable ladder (service → creator's personal credentials →
  diff-scan fallback), `CHANGETABLE(CHANGES …)` consumption with the sync
  version persisted in `pipelines.detection_state`, min-valid-version staleness
  → full reconcile (the analog of `recoverAfterStreamReset` — reconcile
  unmapped→queue + export rebuild, and don't stamp `fully_synced_at` until
  recovery completes).
- Diff-scan path: DMV heartbeat (graceful without `VIEW SERVER STATE`), tiered
  scans with self-tuning, new-value diff → queue.
- `checkSourceHealth` via catalog views; `classifyPollError` for mssql error
  codes (login expired, DB offline/failover, permission revoked, timeout).
- Poller integration: `PipelineRef` already carries `source_type` and parsed
  schedule; add `detection_mode`; both modes queue-only, standardization stays
  in the 10-minute tick untouched.
- UI: detection-mode label with the schedule badge + "Last updated"
  (`fully_synced_at`) on the card — **no polling ring** (removed 2026-07-13,
  do not reintroduce); upgrade nudges for CT/index.
- **Exit criteria**: on a live mssql source — insert detected ≤1 min (CT and
  diff modes), delete drops from export at next rebuild, UPDATE handled as
  delete+insert, CT-disabled table falls back cleanly, PK-less table falls
  back cleanly, tier promotion/demotion observed, idle pipeline does zero
  table reads (verified via Query Store / profiler).

### Phase 5 — Reads, writes, export rebuild · ~2–3 wk

> **STATUS: implemented 2026-07** — `warehouse/mssql/mappings.ts` (HOLDLOCK
> MERGEs, app-side normalized_value, small-batch strategy: 1500 names /
> 400 matches per statement — TVPs unnecessary at 6k-entry benchmark) +
> `warehouse/mssql/export.ts` (staging-join export builder, transactional
> swap, grants captured via the export DB's principals + re-applied,
> PK→unique→clustered ordering tiers, 100k distinct cap, view kind refused
> loudly) + dialect branches in op-export / op-auto-group-run (bind-budgeted
> IN batching via adapter.bindLimit, TOP↔LIMIT, SPLIT_PART↔LEFT/CHARINDEX) +
> hourly-processor (TOP drain, batched dequeue, mssql reconcile via the
> detection engine) + Phase-5 guards removed. **Exit criteria live-tested**
> (`npm run test:mssql-lifecycle`): detect → queue → tick standardization
> (100% lookup hits, zero LLM) → mapping writes → export rebuild (values
> standardized, unwatched columns raw, source columns mirrored, PK order) →
> dequeue + freshness stamp → SELECT grant survives the swap → 6k bulk drain
> across two 5k installments. Snowflake regression: tsc + build + parity
> green. Still Snowflake-only (P6/P7): pipeline-creation routes, file
> pipelines, one-time flow, lookup-table exports.
- `scanDistinctValues` with app-side normalization + the distinct-count cap.
- `bulkUpsertMappings` + queue MERGEs: settle the parameter strategy (TVP vs
  JSON-payload vs smaller batches — mssql's ~2,100-bind ceiling vs Snowflake's
  ~65k) behind the same batching contract; idempotent, retry-safe.
- `rebuildExportTable`: staging-mapping table (BIN2 join) → build `_new` →
  transactional swap → re-apply tracked permissions; source-order tiers
  (PK → unique key → clustered index; no synthetic order column, unordered when
  the source has no key — mssql has real PKs and clustered indexes, so ordered
  exports are more often available than on Snowflake).
- Hourly reconciliation sweep + 5,000-value installment drain re-pointed
  through the adapter (they're mostly warehouse-blind after Phase 1).
- Include-unmapped-rows behavior keyed on schedule type — identical semantics.
- **Exit criteria**: full pipeline lifecycle on mssql end-to-end, including a
  bulk load (>5k distinct) draining across ticks; export table row-order
  matches source; permissions on the export table survive a rebuild.

### Phase 6 — Setup, onboarding, personal credentials · ~1.5–2 wk

> **STATUS: implemented 2026-07** — migration 010 (workspace warehouse_type +
> ms_* creds; accounts ms_* personal creds); factory resolves workspace →
> `PRISM_WAREHOUSE_TYPE` env → snowflake (10 s cache); routes:
> `warehouse-type`, `workspace-mssql` (test/save/clear, blank-keeps-secret,
> save asserts the platform choice), install-script `?warehouse=mssql`,
> verify-install mssql probes, test-connection adapter-aware; setup UI:
> platform picker persists, `StepInstallScriptMssql` (script + login + CT
> templates), `StepCredentialsMssql`; creation surfaces: columns/source
> preview/propose-groupings branched, create-initial-run runs `initDetection`
> with the CT-enable ladder (service → creator's personal creds → diff
> fallback) + capped diff-scan baseline. Note: no programmatic grants pass on
> mssql BY DESIGN (service login can't grant; sysadmin script + verify
> checklist instead). Live-tested (`npm run test:mssql-setup`).
- Wire the `/setup` step-1 platform picker (currently a "Coming soon" stub):
  selection persists `warehouse_type` to `workspace_config`.
- Step 2: serve the T-SQL install script + service-login creation block
  (`CREATE LOGIN prism_svc …; CREATE USER …; ALTER ROLE PRISM_SERVICE ADD
  MEMBER …`) — admin runs it in SSMS/az CLI, credentials never typed into
  Prism, same trust story as Snowflake.
- Step 3: mssql credential form variant (server, database, auth mode); the
  `workspace-snowflake` route generalizes (connection-test before save,
  encrypted at rest, blank-secret adoption rules preserved).
- Step 5: `verifyInstall()` mssql probes (role identity, database + schema,
  four tables, no-UDF check is N/A, CT enabled on the DB — informational).
- The CT-enablement encouragement step (decision 2.1) with the one-click /
  DBA-command split.
- Personal credentials: mssql variant of the non-admin `/setup` form + the
  one-time flow's access fallback (`withUserConnection`).
- `/home` setup gate: warehouse-agnostic "no resolvable service connection".
- **Exit criteria**: a fresh mssql install completes the 5-step wizard
  (including under `PRISM_FRESH_SETUP`), creates a pipeline, and the grants
  report shows "already in place" green for script-first installs.

### Phase 7 — Long tail: one-time flow, remaining routes, exports · ~1–1.5 wk

> **STATUS: implemented 2026-07** — one-time flow (diff-scan distinct read w/
> 20k cap → OneTimeTooLargeError; raw-value map table + BIN2 join +
> `COLLATE DATABASE_DEFAULT` COALESCE; SELECT INTO create / stage+DELETE+INSERT
> overwrite); file pipelines (plain-VALUES JSON inserts, JSON_VALUE reads,
> app-side metrics incl. row-weighted variant); lookup export (EXPORTS default
> schema, DROP+SELECT INTO); spec-value seeding + mapping-edit routes through the
> mssql writers; personal creds route (`mssql-config`) + non-admin setup
> variant. Live-tested in `test:mssql-setup` (create+overwrite export,
> personal connection, file rows round-trip, normalized dedup).
- One-time standardization on mssql (personal-connection fallback, overwrite/
  create export targets, refuse-internal-targets check on the mssql FQN form).
- Lookup-table export to a warehouse table; CSV/Excel/Sheets exports are
  warehouse-blind already.
- `/api/columns`, admin table inspector, download routes.
- **Exit criteria**: one-time flow end-to-end on mssql with both service and
  personal connections.

### Phase 8 — Docs + QA hardening · ~2 wk

> **STATUS: implemented 2026-07 (local scope)** — CLIENT_ONBOARDING Appendix B
> (SQL Server playbook: install, service login, CT recommendation, kill
> switch, cost model, serverless warning, RBAC spot-check) + operator
> credential-hygiene section; SECURITY_AND_DISCLOSURES mssql credential
> inventory; full sweep green (4 live suites, parity, tsc, build). REMAINING
> (needs infrastructure this machine doesn't have): Azure SQL Database /
> Managed Instance validation, SQL Server 2019 (container is 2022), Entra ID
> auth — run before the first real SQL Server customer.
- `docs/CLIENT_ONBOARDING.mssql` variant (or a warehouse-split of the
  existing doc): install runbook, grants recipe, kill switch
  (`ALTER LOGIN prism_svc DISABLE`), audit story (their SQL Server audit /
  Query Store instead of Snowflake query history), cost section rewritten for
  the load model + CT overhead disclosure + serverless Azure guidance, and a
  permission sanity spot-check analog of the Snowflake zero-grants RBAC test
  (Appendix A item — SQL Server is default-deny by design, but verify on
  *their* instance; the Snowflake finding taught us not to assume).
- `SECURITY_AND_DISCLOSURES.md`: the mssql credential paths and what they're
  used for (it went stale once before — update it in the same PR as the code).
- Environment matrix QA: Docker mssql 2019, 2022, Azure SQL Database
  (provisioned + serverless), ideally Azure SQL Managed Instance. Version
  floor: **SQL Server 2019+** — confirmed live (INS-M11, 2026-07-29) via all
  four live suites passing cleanly on a genuine 2019 container; the dedup
  path never uses `ANY_VALUE` at all (`SELECT DISTINCT` + app-side dedup
  uniformly), so there is no 2022+ version gate to work around.
- Failure-mode drills: revoke permission mid-run, drop the source table,
  disable CT under a live pipeline, kill the connection mid-export (verify the
  `'validating'` idempotency guard holds on mssql).

---

## 5. Snowflake → SQL Server translation reference

| Concern | Snowflake (today) | SQL Server |
|---|---|---|
| Change detection | Standard streams (Prism-side offsets) | Change Tracking (customer-side enable, PK required) → tiered diff scan fallback |
| "Anything new?" cheap check | `SYSTEM$STREAM_HAS_DATA` (metadata layer) | `CHANGE_TRACKING_CURRENT_VERSION()` / `sys.dm_db_index_usage_stats` DMV |
| Normalization in SQL | `PRISM_NORMALIZE` JS UDF | **None** — app-side `normalizeLiteral` + exact-match staging table, BIN2 collation |
| Export rebuild | `CREATE OR REPLACE TABLE … COPY GRANTS AS SELECT` | Build `_new` + transactional rename swap + re-grant (no COPY GRANTS) |
| Bulk upsert | MERGE, ~65k binds/statement, 5k batches | MERGE `WITH (HOLDLOCK)`, ~2.1k binds → TVP/JSON payload or smaller batches |
| Dedup representative | `GROUP BY PRISM_NORMALIZE(...)` + `ANY_VALUE` | `SELECT DISTINCT` + app dedup — never uses `ANY_VALUE`, so this is version-floor-agnostic (identical on 2019 and 2022+) |
| Column/table health | `SHOW COLUMNS` (metadata, free) | `sys.columns` (catalog, cheap) |
| Masking detection | `POLICY_REFERENCES` | `sys.masked_columns` (Dynamic Data Masking) |
| JSON storage | `VARIANT` + `PARSE_JSON` (not in VALUES!) | `NVARCHAR(MAX)` + `OPENJSON`/`JSON_VALUE` |
| Identifiers | `"Quoted"` (upper-cases unquoted) | `[Bracketed]` (preserves case; collation-dependent compare) |
| Result-column case | UPPERCASE (`r.FIELD ?? r.field` pattern) | As-written (the existing pattern already tolerates this) |
| Service identity | `PRISM_SVC` user + `PRISM_SERVICE` role, key-pair | `prism_svc` login + DB user + role; SQL auth or Entra ID |
| Kill switch | `ALTER USER … SET DISABLED = TRUE` | `ALTER LOGIN … DISABLE` |
| Cost model | Warehouse wake-time — idle cycles must touch metadata only | Provisioned capacity — protect load; **serverless Azure = Snowflake-style, detect + stretch cadence** |
| Statement timeout | Warehouse `STATEMENT_TIMEOUT_IN_SECONDS = 600` | Per-request timeout in the driver config |

---

## 6. Risks and open questions

1. **Diff-scan load on pathological tables** (huge, unindexed, hot) — the
   tiers bound it, but the first real customer workload should tune the
   constants. Mitigation is already designed (index nudge, CT nudge).
2. **mssql bind-parameter ceiling** (~2,100) forces a bulk-write strategy
   decision (TVPs vs JSON payloads vs 500-row batches) — decide in Phase 5
   with a benchmark, not in advance.
3. **Entra ID auth variants** (service principal vs managed identity vs SQL
   auth) — start with SQL auth + service principal; managed identity only if
   a customer's policy demands it.
4. **No test suite exists** — the parity tests (Phase 2) cover pure logic
   only; everything stateful is manual QA on the Phase 8 matrix. Accepted, but
   the failure-mode drills are non-negotiable before a real customer.
5. **Grouping quality is warehouse-independent** (LLM layer untouched), but
   the *untested non-Anthropic LLM providers* remain a separate open item —
   don't conflate the two test matrices.

---

## 7. Definition of done

A SQL Server install, provisioned exactly like a Snowflake one (per
`CLIENT_ONBOARDING`), passes: the 5-step setup wizard → first pipeline
(connect → review → accept → activate) → a new row in the source detected and
standardized within one 10-minute tick → a deleted row gone from the export
after the next rebuild → one-time standardization against a table the service
login can't see (personal credentials) → lookup export to all four formats →
overnight idle with zero table reads on the customer's server — with every
Snowflake regression check still green on an unmodified Snowflake install.
