# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## How to Communicate

Write responses in plain, understandable language while staying fully detailed. Don't sacrifice completeness for brevity — instead, explain jargon the first time it's used, walk through processes step by step in the order they actually happen, and say *why* something works the way it does, not just *what* it does. Prefer "the app opens a fresh connection for every request and closes it when done" over "no connection pool; per-request lifecycle."

## What This Project Is

Prism (also called "STAND" in legacy code) is a warehouse-native data standardization platform — each installation runs on the customer's Snowflake OR Microsoft SQL Server (chosen once in the setup wizard; see the `warehouse/` adapter layer and `docs/MSSQL_PORT_PLAN.md`). Snowflake is the original and most battle-tested backend. It maps inconsistent text values from a source column (e.g. "att", "AT&T wireless", "a t and t") to a single canonical name (e.g. "AT&T"). Confirmed mappings accumulate into a per-column-spec lookup table and embed into the customer's data pipeline.

Two surfaces:
- **Snowflake database layer** — data storage and computation
- **Next.js web UI** — human review and run management

Prism is a **single product**: the fully automated pipeline platform. A background poller watches live Snowflake tables via standard (delete-aware) streams; new values are queued, LLM-grouped, and exported automatically; deletes/updates drop rows from the export table. See **Pipeline Subsystems** below. The old basic/premium tier split is gone — there is no `NEXT_PUBLIC_APP_MODE`, no `feature-flags.ts`, and no mode guards.

One additional feature (not a tier): the **one-time standardization flow** (`app/one-time/`) — "clean a list once", standardize a source table's columns to a standalone output table without ever touching the shared lookup. See **One-Time Standardization** below.

---

## Commands

All commands run from `stand-ui/`:

```bash
npm install        # install dependencies
npm run dev        # start dev server on http://localhost:8000
npm run build      # production build
npm run lint       # eslint
npm run test:parity # warehouse parity tests (pure logic, no DB) — normalizeLiteral vs the PRISM_NORMALIZE UDF, sqlStringLiteral escaping, mssql dialect helpers, header-row detection, convention-regex ReDoS screen, provider-routing guard
npm run typecheck:scripts # typecheck scripts/ — deliberately NOT part of `build`
npm run mssql:install    # run 01_internal_tables.mssql.sql + 02_demo_data.mssql.sql against a SQL Server (dev container recipe: docs/DEV_MSSQL.md)
npm run test:mssql-live  # live smoke test of the mssql adapter against that container
npm run test:mssql-detection # Phase 4 exit-criteria test: CT + diff-scan detection engine (live)
npm run test:mssql-lifecycle # Phase 5 exit-criteria test: full detect→standardize→export lifecycle (live)
npm run test:mssql-setup     # Phase 6/7 exit-criteria test: workspace choice, credentials, one-time export, file rows (live)
npm run pg:install           # run 01_internal_tables.postgres.sql + 02_demo_data.postgres.sql against a Postgres (dev container recipe: docs/DEV_POSTGRES.md)
npm run test:pg-live         # Postgres port P1 exit-criteria test: adapter/dialect/install (live)
npm run test:pg-detection    # Postgres port P2 exit-criteria test: pg_stat-gated diff-scan detection (live)
npm run test:pg-lifecycle    # Postgres port P3 exit-criteria test: detect→standardize→export incl. view + column kinds (live)
npm run test:pg-setup        # Postgres port P4 exit-criteria test: workspace choice, credentials, one-time export, file rows (live)
npm run mysql:install        # run 01_internal_tables.mysql.sql + 02_demo_data.mysql.sql against a MySQL 8 (dev container recipe: docs/DEV_MYSQL.md)
npm run test:mysql-live      # MySQL port M1 exit-criteria test: adapter/dialect/install (live)
npm run test:mysql-detection # MySQL port M2 exit-criteria test: UPDATE_TIME-gated diff-scan detection (live)
npm run test:mysql-lifecycle # MySQL port M3 exit-criteria test: detect→standardize→export incl. view + column kinds (live)
npm run test:mysql-setup     # MySQL port M4 exit-criteria test: workspace choice, credentials, one-time export, file rows (live)
```

There is no test suite beyond `test:parity`. Run `test:parity` after ANY change to normalization or warehouse dialect helpers.

**`scripts/` is excluded from the production typecheck** (`tsconfig.json` →
`exclude`). The include list picks up `**/*.mts` project-wide, so a half-finished
throwaway script under `scripts/` used to fail `npm run build` even though
nothing in it ships — it happened three times during the 2026-08 QA run, each
time blaming a file unrelated to the app. A stray dev script must never block a
deploy. The maintained scripts are still typechecked, just deliberately:
`npm run typecheck:scripts` (`tsconfig.scripts.json`). Run it alongside
`npx tsc --noEmit` when you change one. `tsx` executes scripts regardless of
either config, so `test:parity` and the live-mssql suites are unaffected.

### Deploy SQL to Snowflake (run from repo root)

```bash
snowsql -f 00_bootstrap.sql       # DB + schemas + the ONBOARDING MIRROR (see below)
snowsql -f 01_internal_tables.sql # tables + UDF + roles + grants — the CUSTOMER install (no demo data)
snowsql -f 02_demo_data.sql       # DEV/DEMO ONLY — demo source table + dev grants; never run on a customer account
```

`00_bootstrap.sql` also carries the **onboarding mirror**: the SQL the `/setup` wizard's step 2 (Parts B–D) has a customer admin run by hand — `PRISM_SVC` service-user creation (the `RSA_PUBLIC_KEY` ALTER stays commented so re-runs never clobber the live key) and the Part D data-access grants for the dev `TEST_DB.PUBLIC` schema. Purpose: dev resets and onboarding-SQL testing never require clicking through the wizard — `00` + `01` fully onboard the account. The mirror sits below the **`-- PRISM:INSTALL-SCRIPT-END` marker** — `/api/accounts/install-script` truncates the file there, so customers see only the clean bootstrap portion in the wizard (a marker-less file is served whole). **Keep the mirror in sync with `app/setup/page.tsx`** (`SERVICE_USER_SQL`, `buildDataAccessGrants`) whenever the onboarding SQL changes.

That's the complete Snowflake-side deploy (the SQLite app database creates itself on first boot) — there are no deploy/setup shell scripts. **The customer/dev split:** `00` + `01` are everything a customer's account requires (and are what the setup wizard serves); `02_demo_data.sql` is dev/demo-only — the fake `TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT` source table, the dev `TEST_DB` grants, and the dev user's role grants. Never run `02` on a customer account.

**Full dev reset = `01` + `02` + the app-state reset.** Re-running `01` resets the Snowflake side (lookup tables, queue, file rows) and also **drops all `PIPELINE_STREAM_*` streams** (Snowflake Scripting block — stale streams from previous pipeline generations otherwise accumulate); re-running `02` resets the demo source table. COLUMN_SPECS / PIPELINES / RUNS live in SQLite, which snowsql can't touch — reset them with the companion command:

```bash
cd stand-ui && npm run reset-app-state   # scripts/reset-app-state.mjs
```

It empties `pipelines` / `runs` / `column_specs` / `one_time_standardizations`, and restarts the autoincrement counters (the SQLite `validation_log` no longer exists — the audit trail is warehouse-side). `accounts`, `invitations`, and the workspace config are deliberately untouched (no re-onboarding). Restart the dev server afterwards — the poller/tick hold in-memory state for the old pipelines.

**Demo seed (currently disabled).** `02_demo_data.sql` carries the demo seed for `TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT` (two columns, one shared export table). As of 2026-06-14 the initial standardizations (`APPROVED_ALIAS_NAMES` + `LITERAL_ALIAS_MATCHES`) are **temporarily disabled** with `TEMP:` markers (wrapped in `/* … */`). The raw source table + its sample rows are kept live. So a fresh `01` + `02` run = all internal tables created/empty + a populated source table (clean slate to test the from-scratch create flow). Re-enable the `TEMP:`-marked blocks to restore the pre-confirmed lookup. The **client-side half** of the demo — prefilled table/column values in the connect form — is gated behind the `NEXT_PUBLIC_PRISM_DEMO_DATA` env flag (off by default).

---

## Environment Variables

Copy `stand-ui/.env.local.example` to `stand-ui/.env.local`.

| Variable | Purpose |
|---|---|
| `SNOWFLAKE_ACCOUNT` / `SNOWFLAKE_USER` / `SNOWFLAKE_WAREHOUSE` | Service-connection **fallback** — used only when no workspace credentials are saved via the `/setup` onboarding flow (SQLite `workspace_config`). Warehouse default is `PRISM_WH` — the dedicated warehouse created by `01_internal_tables.sql` (see Dedicated Warehouse below) |
| `SNOWFLAKE_PASSWORD` | Password auth (fallback) |
| `SNOWFLAKE_PRIVATE_KEY` | Inline PEM private key (preferred); handle literal `\n` → real newline |
| `SNOWFLAKE_PRIVATE_KEY_PATH` | File path to PEM private key (alternative to inline) |
| `ANTHROPIC_API_KEY` | LLM-key **fallback** — used only when no workspace AI provider is saved via `/setup` (SQLite `workspace_llm_config`). All key reads go through `_lib/anthropic-key.ts` — never read this env var directly. **Doubles as the "Prism-provided AI" mechanism**: Sanjiv sets a vendor key here at deploy time for clients with no LLM account (see LLM Integration → Prism-provided AI) |
| `SESSION_SECRET` | HMAC key for session cookies |
| `PRISM_ENCRYPTION_KEY` | 64 hex chars (32 bytes) — AES-256-GCM app-level encryption key for stored secrets: `ACCOUNTS.sf_password`, `ACCOUNTS.sf_private_key`, and the Google `refresh_token` in `file_source_meta`. Ciphertext format `enc:v1:<iv>:<ciphertext>:<authTag>`. Generate with `openssl rand -hex 32`; store per-installation in a password manager (losing it orphans the encrypted secrets). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Google OAuth (login + Sheets export) |
| `ADMIN_EMAIL` | Bootstrap admin; all other users must be invited |
| `REDIS_URL` | Optional — enables auto-export baseline tracking; degrades gracefully if absent |
| `PRISM_SQLITE_PATH` | Path to the local SQLite app-state DB file (default `./data/prism.db`, gitignored). Must be on persistent storage; backup = copy the file. |
| `SMTP_*` + `APP_URL` | Email invitations |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | Optional — server/client error monitoring. Everything no-ops when unset. |
| `PRISM_DEBUG_TOOLS` | `'true'` enables the `/debug` page and `/api/admin/table` inspector. Operator-only — never set in customer installs. |
| `PRISM_DEBUG_ARTIFACTS` | Writes LLM breakdown / validation audit JSONs to the OS temp dir for debugging. |
| `NEXT_PUBLIC_PRISM_DEMO_DATA` | Enables demo prefills in the connect form (off by default). |
| `PRISM_WAREHOUSE_TYPE` | Dev/operator switch for the warehouse adapter factory: `snowflake` (default), `mssql`, `postgres`, or `mysql`. The setup-wizard choice (`workspace_config.warehouse_type`, saved by the step-1 platform picker or a workspace credential save) takes precedence over this env var. Ignored entirely in the native edition (see `PRISM_EDITION`). |
| `PRISM_EDITION` / `NEXT_PUBLIC_PRISM_EDITION` | Product edition switch (`_lib/edition.ts`, pure module — client-safe): `standard` (default; both vars absent = byte-identical standard behavior) or `native` (the Snowflake Marketplace Native App build — see `docs/NATIVE_APP_PLAN.md` and `native/`). Native pins the warehouse adapter to Snowflake (stored/env types ignored), 403s + hides all Google Sheets surfaces and email invitations, force-disables Sentry in all three runtimes, and hard-disables `/debug` + `/api/admin/table` regardless of `PRISM_DEBUG_TOOLS`. Set at build time by `native/Dockerfile` (the `NEXT_PUBLIC_` var is what client bundles see — both must be set together). Server routes are the authoritative gates; client hiding is cosmetic. In native, the facade's "user connection" (`withUserWarehouse` / `hasUserWarehouseConfig`) is an SPCS **caller's-rights session** (request's `Sf-Context-Current-User-Token` dot-joined onto the service token) instead of saved personal credentials — see NATIVE_APP_PLAN.md §2.9; `hasUserWarehouseConfig` is async facade-wide for this (**always await it** — an un-awaited Promise is truthy). |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_DATABASE` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_SSL` | MySQL service-connection config (env tier — used when `PRISM_WAREHOUSE_TYPE=mysql`). `MYSQL_DATABASE` is only the session default (MySQL joins across databases — no pg-style scope); `MYSQL_SSL` is `false` (default; dev container) \| `true` \| `strict`. Workspace tier: `workspace_config.my_*` (migration 019). Floor MySQL 8.0.19; MariaDB unsupported. See `docs/DEV_MYSQL.md`. |
| `PG_HOST` / `PG_PORT` / `PG_DATABASE` / `PG_USER` / `PG_PASSWORD` / `PG_SSLMODE` / `PG_SSL_CA_PATH` | PostgreSQL service-connection config (env tier — used when `PRISM_WAREHOUSE_TYPE=postgres`). `PG_DATABASE` is the ONE database the install standardizes (Postgres cannot query across databases — see docs/POSTGRES_PORT_PLAN.md §2.1); `PG_SSLMODE` is `disable` (default; local dev container) \| `require` \| `verify-full` (+ CA path). Workspace tier: `workspace_config.pg_*` (migration 018). See `docs/DEV_POSTGRES.md`. |
| `MSSQL_SERVER` / `MSSQL_USER` / `MSSQL_PASSWORD` / `MSSQL_DATABASE` / `MSSQL_PORT` / `MSSQL_ENCRYPT` / `MSSQL_TRUST_SERVER_CERT` | SQL Server service-connection config (env tier — used when `PRISM_WAREHOUSE_TYPE=mssql`). `MSSQL_DATABASE` defaults to `PRISM_DB`; set `MSSQL_TRUST_SERVER_CERT=true` for the local dev container's self-signed cert. See `docs/DEV_MSSQL.md`. |
| `PRISM_FRESH_SETUP` | Dev-only — `'true'` simulates a bare customer install everywhere setup-facing (`isFreshSetupSim()` in `_lib/env.ts`): the `/setup` entry check reports not connected, the `/home` gate, `verify-install`, and both status GETs treat env credentials/key as absent, env-based form prefills are suppressed, and blank-save env adoption is disabled. Workspace rows saved during the walkthrough are real state and show through. The REAL service connection and LLM key resolution (`withWarehouse` / `getAnthropicApiKey`) are never affected — pipelines keep running. Never set in customer installs. |
| `PRISM_CHUNK_MODEL` / `PRISM_MERGE_MODEL` | Optional model-ID overrides for the grouping chunk / merge LLM calls (default `claude-sonnet-4-6`; Anthropic provider only). |
| `PRISM_COPILOT_MODEL` / `PRISM_OPENAI_MODEL` / `PRISM_GEMINI_MODEL` | Optional overrides for the pinned non-Anthropic provider models (defaults `openai/gpt-4.1` / `gpt-4.1` / `gemini-2.5-flash`). |

---

## Architecture

### Classification System (Current)

The deterministic scoring pipeline has been replaced with a single LLM call per chunk. Key principles:

- No metadata generation — no tokenization or importance scoring (the deleted legacy deterministic pipeline). Note: a lightweight matching-only normalization (`PRISM_NORMALIZE`) IS applied to compare/dedup literals — see Pipeline Subsystems; it does not generate stored metadata beyond the `normalized_value` column on `LITERAL_ALIAS_MATCHES`.
- Hash lookup first — literal value match (normalized) against `LITERAL_ALIAS_MATCHES` before any LLM call
- Single JSON blob per run — run state in `RUNS.state`, one read on page load, one write per sync, optimistic-concurrency `rev` field
- User-first, fail-open export — the user's decisions are written taking precedence; the validation LLM (which runs before the single write when Case A/B/C exist) only overrides a change it is extremely confident is a mistake, and any validation failure falls back to writing the user's decisions untouched

### Legacy Code (Deleted)

The original deterministic pipeline has been **deleted from the codebase**: `grouping-phase0.ts`–`grouping-phase4.ts`, `grouping-pipeline.ts`, `grouping-llm.ts`, `grouping-utils.ts`, `feature-payload.ts`, `llm-pairscore.ts`, `llm-confidence.ts`, `redis-cache.ts`, `clique-detection.ts`, and `pairscore.ts` are gone — the last two survive only as type definitions in `app/api/_lib/grouping-types.ts` (`RunItemForPairing`, `FinalGroup`, …), which the live LLM grouping flow still consumes. `masking-policy.ts` was also deleted: the masking feature was never wired into the product — **do not claim Prism supports masking policies** (the poller's `checkSourceHealth` still *detects* policies on watched columns purely to skip/pause safely).

The 13 legacy tables (`CONCEPTS`, `ALIASES`, `ALIAS_SUMMARY`, `RAW_VALUES`, `TOKENS_SUMMARY`, `ALIAS_TOKEN_COUNT`, `GLOBAL_TOKEN_COUNT`, `RUN_GROUPS`, `RUN_ITEMS`, `RUN_APPLIED_TARGETS`, `AUDIT_LOG`, `CLASSIFICATION_METADATA_PROFILES`, `CONCEPT_COMPATIBILITY`) are unreferenced by any live code path and can be dropped from any existing database without consequence.

---

## Column Specs & Glossary

**Domains were REMOVED 2026-07-15** (SQLite migration 012 dropped the table;
`/api/domains` and the domain picker components are gone). Their replacement is
the **per-column standardization spec** (`column_specs` SQLite table, migration
011): every standardized column carries its own spec — a mandatory
`description`, optional free-text `standardization_rules`, and an optional
naming convention. The spec's `spec_id` is the lookup scope.

⚠️ **THE NAMING TRAP:** the physical columns are still named `domain_id`
(SQLite `pipelines`/`runs`, warehouse `APPROVED_ALIAS_NAMES` /
`LITERAL_ALIAS_MATCHES`, `file_source_meta.columns[]`, and the
`?domain_id=` param on `/api/global-standardizations`) — **every one of them
holds a `column_specs.spec_id`**. This is a deliberate compatibility decision
(renaming would touch 100+ SQL strings across two dialects with no test
coverage), not an accident. New code may keep using the column names but must
never treat them as referencing a domains table — there isn't one.

| Term | Definition |
|---|---|
| Column spec | Per-column standardization contract (description + rules + convention). Scopes that column's alias names via `spec_id`. Replaced Domains, which replaced Concepts. |
| Run | A processing session against one source column. Produces groups for human review. |
| Group | A proposed cluster of raw values that map to the same canonical alias name. |
| Literal Value | A distinct raw string from the source column, exactly as it appears. |
| Alias Name | The canonical correct name a group maps to (e.g. "AT&T", "Verizon"). Stored in `APPROVED_ALIAS_NAMES`. |
| Lookup Match | A previously confirmed `literal_value → alias_id` mapping stored in `LITERAL_ALIAS_MATCHES`. |

Historical removals: **Concepts** → **Domains** → per-column **specs** (2026-07-15); the blocking **Admin Validation Stage** → replaced by the fail-open export validation referee; **Org ID scoping** → single-tenant by definition.

---

## Database Tables

Prism uses **two data stores**, split by one rule: *any table that gets joined
against customer source data inside Snowflake SQL stays in Snowflake; pure
app-state lives in a local SQLite file.*

- **Snowflake (`PRISM_DB.INTERNAL`)** — `APPROVED_ALIAS_NAMES`,
  `LITERAL_ALIAS_MATCHES`, `PIPELINE_QUEUE`, `PIPELINE_FILE_ROWS`,
  **`RUN_STATE`** (the run review state blob — moved out of SQLite 2026-07-28
  for data residency: it holds the customer's distinct values), and
  **`VALIDATION_LOG`** (export-referee audit trail — moved for the same
  reason), plus streams, export tables, and the `PRISM_NORMALIZE` UDF.
  **Data-residency rule: any table holding customer VALUES lives in the
  customer's warehouse; SQLite keeps only metadata/config.**
- **SQLite (`_lib/sqlite.ts`, file at `PRISM_SQLITE_PATH`, default
  `stand-ui/data/prism.db`)** — `accounts`, `invitations`, `column_specs`,
  `one_time_standardizations`, **`runs`** (metadata only — the state blob is
  warehouse-side in `RUN_STATE`; the SQLite `state` column is dead since
  migration 015, which also DROPped the old SQLite `validation_log`),
  **`pipelines`**,
  **`workspace_config`** (migration 003 — single row `id=1`, the workspace
  service credentials saved from `/setup`; secrets `enc:v1:` encrypted),
  **`workspace_llm_config`** (migrations 004+005 — single row `id=1`, the
  company's AI-provider config: `provider` ('anthropic' | 'openai' | 'gemini'), the
  encrypted credential in the legacy-named `anthropic_api_key` column, and a
  `model` override; deliberately its own table so it can be saved without
  Snowflake credentials).
  Schema is created by append-only migrations in `sqlite.ts`
  (`PRAGMA user_version`); WAL mode; better-sqlite3 (synchronous — no `await`
  on statements; `serverExternalPackages` in `next.config.ts`). Migration 011
  created `column_specs`; migration 012 DROPPED `domains`; migration 015
  dropped `validation_log` and scrubbed value-bearing columns (data
  residency); `runs`/`pipelines` are migration 002; migration
  006 adds `pipelines.update_schedule` (backfilling old `mode` rows: manual →
  manual-only, auto → 24/7) — the legacy `mode` column physically remains but
  is no longer read or written; migration 016 dropped the file-pipeline
  columns (warehouse-only pipelines — files/Sheets moved to the one-time
  flow); 017 added terms clickwrap (`terms_accepted_version`/`_at`); 018/019
  added the pg_*/my_* credential columns (Postgres/MySQL ports); 020 added
  `accounts.sf_username` (native-edition SPCS identity). Booleans are INTEGER 0/1
  (`export_unmapped_rows`); JSON columns are TEXT (`runs.state`,
  `stats_snapshot`, `file_source_meta`, `file_export_meta`,
  `update_schedule`); timestamps are ISO-8601 UTC TEXT.

Cross-store references (`PIPELINE_QUEUE.pipeline_id` → SQLite `pipelines`,
`LITERAL_ALIAS_MATCHES.run_id`/`domain_id` → SQLite `runs`/`column_specs`, …) are
plain integers — Snowflake never enforced FKs anyway. **Snowflake SQL can no
longer join the moved tables**: spec names/conventions are resolved app-side
(spec lookups in `app/api/pipelines/route.ts` /
`pipeline-hourly-processor.ts`); queue↔pipeline joins are split (queue
aggregates fetched from Snowflake by `pipeline_id`, pipeline rows from SQLite,
combined in app — see `fetchPipelinesWithQueue`). The state-blob helpers
(`loadOpRunState(runId, conn?)` / `saveOpRunState(runId, state, conn?)` /
`saveOpRunStateWithRev(runId, state, expectedRev, conn?)` /
`loadOpRunStatesBatch(runIds, conn?)`) are **warehouse calls** since
2026-07-28 (data residency — the blob holds customer values): they hit
`INTERNAL.RUN_STATE` via the service connection, reusing an already-open
connection when one is passed. The rev lives inside the blob; the rev check is
`COALESCE(state:rev::NUMBER,0) = ?` (Snowflake) /
`COALESCE(TRY_CAST(JSON_VALUE(state,'$.rev') AS INT),0) = ?` (mssql). COST
RULE: never call them from recurring list/poll surfaces (GET /api/pipelines,
SSE refetches, idle poll cycles) — review pages, exports, and the tick only.
During an active review session the 30s autosave keeps `PRISM_WH` awake —
that's accepted, user-visible work. Export ordering across stores:
mark run `'validating'` (SQLite) → write mappings (Snowflake) → mark
`'completed'` (SQLite); the `'validating'` guard keeps retries idempotent.

### Active Tables

**RUNS**
- `run_id` INT AUTOINCREMENT PK
- `concept_key` VARCHAR (legacy field, nullable)
- `source_relation` VARCHAR — fully qualified source table
- `source_column` VARCHAR
- `domain_id` INT — historical name, holds a `column_specs.spec_id` (nullable — NULL = no spec scope)
- `mode` VARCHAR — `'auto'` | `'manual'`
- `run_type` VARCHAR — `'normal'` (writes to the shared lookup on export) | `'one_time'` (throwaway run that exports to a standalone table and never touches the lookup)
- `created_by` INT — ACCOUNTS.account_id of the creator (scopes the one-time archive)
- `run_status` VARCHAR — `'created'` | `'running'` | `'approved'` (wizard deferred export) | `'validating'` | `'completed'` | `'failed'`
- `state` — DEAD SQLite column (NULLed by migration 015). The blob lives in warehouse `RUN_STATE` (see State Blob Structure below)
- `stats_snapshot` VARIANT
- `creation_nonce` VARCHAR
- `created_at`, `updated_at` TIMESTAMP

**APPROVED_ALIAS_NAMES**
- `alias_id` INT AUTOINCREMENT PK
- `alias_name` VARCHAR
- `domain_id` INT FK (nullable)
- `usage_count` INT
- `last_used_at` TIMESTAMP
- Unique on `(alias_name, domain_id)`

**LITERAL_ALIAS_MATCHES**
- `match_id` INT AUTOINCREMENT PK
- `literal_value` VARCHAR
- `normalized_value` VARCHAR — `PRISM_NORMALIZE(literal_value)` **materialized at write time** so lookup/export joins compare a plain stored column (hash-joinable, partition-prunable) instead of re-running the JS UDF over this only-growing table. Every code path that INSERTs/MERGEs here MUST set it. If `PRISM_NORMALIZE` logic ever changes, this column must be backfilled.
- `alias_id` INT FK → APPROVED_ALIAS_NAMES (not alias_name directly)
- `domain_id` INT FK (nullable, denormalized from alias)
- `run_id` INT FK
- `confirmed_at` TIMESTAMP

**COLUMN_SPECS** (SQLite, migration 011 — replaced DOMAINS, which migration 012 dropped)
- `spec_id` INTEGER PK AUTOINCREMENT — the lookup scope; stored into every historically-named `domain_id` slot
- `pipeline_id` INTEGER (nullable), `table_fqn` TEXT, `column_name` TEXT NOT NULL
- `description` TEXT NOT NULL — the concept definition (the concept NAME is the column name)
- `standardization_rules` TEXT (JSON array of free-text rules)
- `convention_type` / `convention_value` / `convention_rules` — naming convention (none/regex/examples/natural + structured rules)
- One spec per (pipeline_id, column_name), enforced in the routes (no UNIQUE constraint)

**VALIDATION_LOG** — append-only audit trail (**warehouse-side** since
2026-07-28 — rows contain literal values; written on the export connection,
insert failures never fail the export)
- `id` INT AUTOINCREMENT PK
- `literal_value` VARCHAR
- `run_id` INT
- `original_alias_name` VARCHAR
- `user_changed_to` VARCHAR
- `llm_decision` VARCHAR — `'user'` | `'original'`
- `decided_at` TIMESTAMP

**PIPELINES**
- `pipeline_id` INT AUTOINCREMENT PK
- `table_fqn` VARCHAR — fully qualified source table (for file-based: synthetic key `SHEETS:<spreadsheet_id>:<tab>:<nonce>`)
- `column_name` VARCHAR — first (or only) standardized column; authoritative for Snowflake pipelines
- `domain_id` INT **NOT NULL** — historical name, holds the column's `column_specs.spec_id` (first column's spec for file-based multi-column pipelines)
- `name` VARCHAR
- `export_table_fqn` VARCHAR (nullable) — Snowflake export table (not used for file-based). **For `export_kind='column'` pipelines this is pinned = `table_fqn`** (the source table IS the destination), so every rebuild trigger keyed on `export_table_fqn` fires for column mode too.
- `export_kind` TEXT — `'table'` (materialized copy, rebuilt each pass, default) | `'view'` (live view, created once; Snowflake only) | `'column'` (standardized `<col>_STANDARDIZED` companion column maintained ON the source table — NULL until standardized). A fourth UI option, "Lookup table", is `export_table_fqn = NULL` (no export object). Parse ONLY via `asExportKind()` (`_lib/export-kind.ts`, pure module) — a hand-rolled `=== 'view' ? 'view' : 'table'` coercion would silently turn a column pipeline into a table rebuild, and the builders' source==destination guard would then refuse it loudly.
- `source_type` VARCHAR — `'snowflake'` (default) | `'sheets'` | `'csv'` | `'excel'`
- `file_source_meta` VARIANT — for file-based: `{ source_type, spreadsheet_url, spreadsheet_id, sheet_tab_name, columns: [{column_name, domain_id}], refresh_token? }` (refresh_token stored **encrypted**, `enc:v1:` format)
- `file_export_meta` VARIANT — for Sheets: `{ spreadsheet_id, spreadsheet_url, output_spreadsheet_id, output_spreadsheet_url, output_tab_name }`
- `export_unmapped_rows` BOOLEAN — whether unmapped rows appear in the export with their raw values (**default false** — mapped rows only). Applies to EVERY update schedule since 2026-07-22 (the old rule hid the toggle and forced mapped-only for 24/7; removed because 24/7 pipelines also hold unmapped values between ticks, during 5k-installment backlog drains, and while paused)
- `status` VARCHAR — `'initializing'` | `'pending_baseline'` | `'active'` | `'paused'`
- `status_message` VARCHAR (nullable) — human-readable reason shown while paused/blocked (NULL = healthy); see Pipeline Health Guards & Alerts
- `update_schedule` TEXT (JSON) — the update time window (see Pipeline Update Time Windows): `{"type":"window","days":[1..5],"start_hour":9,"end_hour":17,"timezone":"America/New_York"}` | `{"type":"always"}` | `{"type":"manual"}`. The legacy `mode` column still exists physically but is dead.
- `export_updated_at` TIMESTAMP (nullable, migration 007) — when the standardized output (export table/view or Sheets output tab) was last rebuilt; stamped by `refreshExportTable` / `syncSheetsColumn`. Ops/debugging only — NOT shown in the UI.
- `detection_mode` TEXT (migration 009) — `'stream'` (Snowflake) | `'ct'` (SQL Server Change Tracking) | `'diff'` (tiered scan); `detection_state` TEXT holds adapter-owned JSON (CT sync version, scan tier, heartbeat). Exposed via GET /api/pipelines (+`detection_reason`) for the ActivityTab hint/upgrade nudge.
- `change_tracking_consent` INTEGER (migration 013, mssql only, default 0) — explicit per-pipeline consent before Prism attempts to enable SQL Server Change Tracking automatically (`ALTER DATABASE`/`ALTER TABLE`, schema-modifying DDL). Mirrors the Column output mode's consent gate: set only after the connect form / AddColumnModal shows the Change Tracking disclosure (offered when `/api/columns`' `ct_status` is `'available'` — a primary key exists but CT isn't enabled yet) and the creator checks the consent box. Without it, `initDetection`'s `tryEnable` is always `false` — both `create-initial-run` and the poller's first-poll init only report current status, never running DDL via the service login or the creator's personal credentials.
- `fully_synced_at` TIMESTAMP (nullable, migration 008) — **the one customer-facing freshness timestamp**: last time the standardized table was verified fully up to date. Advances when a poll checks the source with an empty queue (nothing pending), and when a standardization pass (10-minute tick or manual) exports everything and drains the queue; freezes while values sit queued. Stamped in `touchLastPolled` / the poller's metrics UPDATE (both `CASE WHEN queue_size = 0`), `syncTableLastPolled` (queue-empty AND only for pipelines whose poll actually consulted the source this cycle — `PollResult.checked`; a skipped/errored column must not be claimed "verified up to date" by the table-wide sync), `removeExportedFromQueue` (on drain, after the export rebuild), `refreshExportTable` (when queue empty), and `syncSheetsColumn` (unconditional — file pipelines). Shown as **"Standardized table last updated"** — "Standardized table last updated X ago" on the collapsed card and a right-aligned "Standardized table last updated" date at the top of the Activity tab; for multi-column cards the group value is the MIN across columns (all columns must be synced).
- `created_by` INT — ACCOUNTS.account_id of creator (scopes alert notifications for non-admins)
- `total_source_values` INT, `total_new_values` INT
- `total_mapped` INT
- `queue_size` INT
- `last_polled_at`, `last_queue_empty_at`, `updated_at` TIMESTAMP
- Unique on `(table_fqn, column_name, domain_id)`

Each active **Snowflake** pipeline has a standard (delete-aware) Snowflake stream `PIPELINE_STREAM_<pipeline_id>` in `INTERNAL`. File-based pipelines have no stream.

**PIPELINE_QUEUE** — values detected by the stream poller waiting for the next standardization tick. Holds ALL new values, **including ones already standardized in the lookup** — they wait here too so the export updates as one consistent batch instead of lookup hits trickling in per poll cycle. Deduped on the normalized form (`PRISM_NORMALIZE`); stores a representative original `literal_value`. Schema: `queue_id` PK, `pipeline_id` FK, `literal_value`, `source_frequency`, `detected_at`. Unique on `(pipeline_id, literal_value)`. Note: for file-based pipelines this table is NOT the primary source for standardization — `PIPELINE_FILE_ROWS` is used instead.

**PIPELINE_FILE_ROWS** (file-based pipelines only) — row-level snapshot of the uploaded file or Google Sheet. Schema: `pipeline_id` FK, `row_num` INT, `column_data` VARIANT (JSON object with all column values keyed by column name). Populated at pipeline creation from the uploaded file or Google Sheet. For Sheets pipelines: refreshed on every poller cycle by `refreshSheetsFileRows`. `readFileDistinctValues` reads from this table to get processable literals.

**ONE_TIME_STANDARDIZATIONS** — per-user archive of completed one-time sessions. One row per exported session: `ots_id` PK, `created_by`, `session_nonce` (ties together the session's working RUNS), `source_relation`, `columns` VARIANT, `export_target`, `export_mode` (`'create'` | `'overwrite'`), `convention` VARIANT, `created_at`, `exported_at`. The `mappings` column is DEAD (NULLed by migration 015 — mappings are customer values; the archive route reconstructs them on demand from the session runs' warehouse `RUN_STATE` blobs, degrading to empty if unreachable). Fully decoupled from the shared lookup.

**ACCOUNTS**
- `account_id` INT AUTOINCREMENT PK
- `google_id` VARCHAR, `email` VARCHAR, `name` VARCHAR, `picture_url` VARCHAR
- `role` VARCHAR — `'admin'` | `'user'`
- `session_version` INT NOT NULL DEFAULT 1 — bumped to revoke all of the account's live sessions (cookies carry the version they were issued with; a mismatch rejects the session)
- `sf_account` / `sf_user` / `sf_warehouse` / `sf_role` / `sf_password` / `sf_private_key` — per-account Snowflake configuration (nullable; falls back to env vars). `sf_password` and `sf_private_key` are stored **app-level encrypted** (AES-256-GCM via `PRISM_ENCRYPTION_KEY`, `enc:v1:` prefix).
- `creation_nonce` VARCHAR
- `created_at`, `last_login_at` TIMESTAMP

**INVITATIONS**
- Status values: `'pending'` | `'accepted'` | `'revoked'`
- Expire after 7 days

### Legacy Tables

The 13 legacy deterministic-pipeline tables (listed under **Legacy Code (Deleted)** above) may still exist in older databases but are unreferenced by any live code and can be dropped freely. Do not write new code against them.

---

## State Blob Structure

The warehouse table `PRISM_DB.INTERNAL.RUN_STATE` (`state` VARIANT keyed by `run_id`; mssql: `INTERNAL.RUN_STATE`, NVARCHAR(MAX)+ISJSON) is the sole source of truth for a run's grouping/review state. Schema of the blob:

```json
{
  "rev": 4,
  "status": "created | running | complete",
  "items": [
    { "literal_value": "VZW", "source_frequency": 14, "matched_from_lookup": false,
      "initial_alias_name": "Verizon", "initial_group_id": 3, "initial_confidence": "h" }
  ],
  "groups": [
    {
      "group_id": 1,
      "alias_name": "Verizon",
      "alias_name_source": "lookup_validated | llm_proposed | user_override | llm_failed",
      "confidence": "h | m | l",
      "needs_review": false,
      "from_lookup_chunk": true,
      "items": [{ "literal_value": "VZW", "matched_from_lookup": true }]
    }
  ],
  "ungrouped": [{ "literal_value": "some literal", "matched_from_lookup": false }]
}
```

**`source_frequency` is the real summed source count, on every path** (decision
2026-08-09, REV-01). It is how many source rows collapsed into that normalized
value. Warehouse baseline runs compute it — Snowflake via `COUNT(*)` alongside
the `ANY_VALUE` dedup, SQL Server by keeping the count `diffScan` already
produces — and tick-created runs take it from `PIPELINE_QUEUE.source_frequency`.
Previously the baseline path discarded it on both adapters and stamped `1`
everywhere, so the field silently disagreed with itself depending on how the run
was created; live-verified fixed (a source with 8/6/1-row families now records
8/6/1, not 1/1/1). File-based runs are the one honest exception:
`PIPELINE_FILE_ROWS` carries no per-value counts, so frequency is genuinely
unknown there and the `?? 1` fallback applies. Anything reading this field must
tolerate that case.

The `initial_*` fields on items are stamped at auto-group persist time for items
placed in an LLM group (never for lookup matches): the first-proposed group's
alias/id/confidence. They survive client edits (the client sends patches applied
server-side to the stored blob) and drive export-time **Case C** detection — the
initial standardization is trusted, so a user move away from a high-confidence
initial group gets refereed like Case A. Runs grouped before 2026-07-10 have no
stamps; Case C simply doesn't fire for them.

### Optimistic Concurrency (`rev`)

The blob carries an integer `rev` field (missing = 0). `PUT /api/run/[run_id]/state` takes `{ state, expectedRev }`; the UPDATE only lands when the stored rev still equals `expectedRev`. Success → `200 { rev: expectedRev + 1 }`; conflict → `409 { error: 'conflict', currentRev }` so the client can refetch and rebase. Server-side writers (auto-group, the export route's state patch) re-load fresh state and bump `rev` themselves.

---

## Run Lifecycle

### 1. Run Creation
1. Insert into `RUNS` with `run_status = 'created'`
2. Distinct-value scan of the source column — **deduped on the normalized form**: `GROUP BY PRISM_NORMALIZE(...)` + `ANY_VALUE(...)` (a representative original), NOT a raw `SELECT DISTINCT`
3. Write skeleton state blob to `RUNS.state` — items populated, groups = [], ungrouped = []

### 2. Auto Group (triggered by button click, not run creation)
1. Read items from state blob — do NOT re-query source table
2. Literal lookup — single hash lookup against `LITERAL_ALIAS_MATCHES` for all items at once (stored `normalized_value` vs `normalizeLiteral` of the item)
3. Lookup chunk — group matched items by alias; `alias_name_source = 'lookup_validated'`, `confidence = 'h'`; skip LLM entirely
4. LLM chunking — unmatched items are **sorted by `normalizeLiteral`** then split into chunks of ≤25 at **first-token boundaries** (`sortAndChunkItems`, backtrack ≤`CHUNK_BOUNDARY_SLACK=7`), so lexical variants of one entity land in the same chunk instead of relying on the merge pass; all chunks sent in parallel (`CHUNK_CONCURRENCY = 20`, env-overridable)
5. Merge pass — deterministic pre-merge of identically-named groups first, then one LLM merge call; lookup names always win (matched on `normalizeLiteral(name)`)
6. Write final state blob (bumping `rev`); update `run_status` to `'running'`; LLM-grouped items are stamped with `initial_alias_name/group_id/confidence` (Case C baseline)
- The "EXISTING CANONICAL NAMES" list handed to the LLM = this run's lookup-hit aliases + **the run's own current group names** (unexported passes / failed-export retries must reuse them) + top-200 of the spec's aliases by usage + (only when the 200 cap was hit) a retrieval slice of approved names whose first word matches a batch first word.
- Chunks whose LLM call fails even after retries become **honest fallbacks**: self-mapped singletons with `alias_name_source = 'llm_failed'`, `confidence = 'l'`, `needs_review = true` — never silently marked high-confidence.
- Items the LLM leaves unassigned also become self-mapped `needs_review` singletons (nothing is ever left unmapped), and **all self-map alias names are made convention-compliant**: deterministic form rules first (`applyConventionRules`), then one batched name-fix LLM attempt (`fixNamesForConvention`) for names still violating the regex/constraints (skipped for `llm_failed` literals — the API is unhealthy right then); still-failing names keep the deterministic best effort and stay `needs_review`. Literals whose convention-adjusted names collide share one group.

### 3. User Review
- State maintained in memory on client
- Autosave every 30 seconds while there are unsaved changes; `pagehide` flushes via `sendBeacon`; `beforeunload` warns when unsaved changes exist
- On a 409 the client refetches the server blob and replaces its local copy

### 4. Export — USER-FIRST, FAIL-OPEN
1. Read final state blob
2. Detect Case A / Case B / Case C deviations (no DB writes yet)
3. Mark the run `'validating'` (double-export guard — a run already `'validating'`/`'completed'`/`'failed'` does not re-trigger the write pass; repeat calls return the same counts)
4. **If any cases exist**, the validation LLM runs first — inside the background pass, before the single write — and its keep/revert verdicts are baked into that write. It uses the shared `callAnthropicWithRetry` (2× backoff on 429/5xx + one JSON-only parse retry). **FAIL-OPEN**: if it still fails, the export proceeds with `decisions = null` (every case defaults to keeping the user's change) and `validation_status: 'failed'` is recorded in the state blob after the write. Validation failure never blocks or loses an export.
5. **Write everything in one pass** (`writeAllDecisions`): bulk-upsert grouped items into `LITERAL_ALIAS_MATCHES` (via `alias_id` FK, setting `normalized_value`), upsert alias names into `APPROVED_ALIAS_NAMES`, increment `usage_count`. Bulk MERGEs dedup their source rows on `normalizeLiteral` and are **batched at `EXPORT_MERGE_BATCH = 5000` rows per statement** (Snowflake caps binds at ~65k/statement; the batches are idempotent upserts so partial-failure retries are safe).
6. On successful write → `run_status = 'completed'`. Only a failure of the write itself marks the run `'failed'`.
7. `PIPELINE_QUEUE` cleanup after export is scoped to the run's normalized literals only (never a blanket pipeline-wide delete).

Steps 4–6 normally run in the background after the HTTP response (fire-and-forget); the wizard's `wait: true` path awaits the write (by construction it has no Case A/B/C, so no LLM round-trip).

### 5. Export Validation LLM (the "referee")

Reviews ONLY user changes that contradict a trusted baseline:
- **Case A** — User moved a `matched_from_lookup = true` item to a different group
- **Case B** — User renamed a `lookup_validated` alias name
- **Case C** — User moved an item out of a **high-confidence (`h`) initial LLM group** (detected via the `initial_*` item stamps; the initial standardization is trusted like the lookup). The revert target is the initial group's *current* alias when it still exists (legit renames respected).

Does NOT review:
- Accepted automated groupings (trusted)
- Renames of `llm_proposed` groups (proposing better names is the user's job)
- Ungrouped items (not written to DB)

**The bar is deliberately high**: the system prompt frames the user as a domain expert whose changes are presumed correct — revert (`'o'`) only when *extremely confident* the change is a mistake; when torn, keep. The prompt also carries a **SPEC CONTEXT block** (column name/description, standardization rules, naming-convention requirements — built by `loadValidationSpecContext`/`buildValidationSystemPrompt`) so verdicts are informed, and rule violations count as evidence under the same bar. Output is **structurally validated against exactly what was sent** (unknown literals/aliases ignored; missing verdicts default to keeping the user's change). All decisions logged to `VALIDATION_LOG` and the debug audit JSON. `runOpExportDirect` (auto pipelines, no user) skips validation entirely.

---

## LLM Integration

**Model**: `claude-sonnet-4-6` for ALL calls — grouping chunks, merge pass, and validation. Chunk and merge model IDs are env-overridable via `PRISM_CHUNK_MODEL` / `PRISM_MERGE_MODEL` (for A/B testing).

**AI provider**: resolved by `getLlmProviderConfig()` (`_lib/anthropic-key.ts`) → `{ provider: 'anthropic' | 'openai' | 'gemini', apiKey, model, source }` (`asLlmProvider()` narrows untrusted strings). Workspace config (`workspace_llm_config` — `provider`, credential in the legacy-named `anthropic_api_key` column, `model` override; saved on `/setup` step 4, validated live before saving, encrypted at rest, 10 s cache + `invalidateAnthropicKeyCache()`) → `ANTHROPIC_API_KEY` env fallback (always provider `'anthropic'`). `getAnthropicApiKey()` returns the active provider's credential. **OpenAI-format path (OpenAI + Gemini)**: `callAnthropicWithRetry` is the single dispatch point — for any non-Anthropic workspace provider it translates the Anthropic-shaped payload to OpenAI chat-completions format and back (`OPENAI_STYLE_PROVIDERS` map: OpenAI → `api.openai.com/v1/chat/completions`; Gemini → Google's OpenAI-compat endpoint `generativelanguage.googleapis.com/v1beta/openai/chat/completions`), so all downstream code is provider-agnostic; `cache_control` is dropped (prompt caching is Anthropic-only). Non-Anthropic providers also get a lower chunk concurrency cap (`NON_ANTHROPIC_CHUNK_CONCURRENCY`, default 3 vs. `CHUNK_CONCURRENCY`'s default 20) and a longer 429 retry backoff — neither provider's rate limits are as generous as Anthropic's production tier, and free/low tiers (e.g. Gemini's free tier) are blown through instantly by 20 simultaneous chunk calls. Pinned models: `DEFAULT_OPENAI_MODEL` = `gpt-4.1`, `DEFAULT_GEMINI_MODEL` = `gemini-flash-latest` (Google's maintained current-flash alias — a hard-pinned version number risks 404ing as "no longer available to new users" the moment Google deprecates it, as `gemini-2.5-flash` did; env-overridable via `PRISM_OPENAI_MODEL` / `PRISM_GEMINI_MODEL`) — best structured-JSON fit at the lowest cost tier per provider. **⚠️ Neither non-Anthropic path has been end-to-end tested against a production-tier account** (see memory note llm-provider-testing-needed). GitHub Copilot was removed as a provider option (2026-07-27) — it has no standalone API key of its own; it only re-exposes OpenAI/other models, so it added no real coverage.

**Prism-provided AI (vendor key)**: for clients with no LLM account, Sanjiv sets HIS Anthropic key as `ANTHROPIC_API_KEY` in that client's deployment at install time — the env-fallback tier exists precisely for this. The client then sails through `/setup` step 4 ("already configured on the server" → Keep current setup) and never needs a provider account; if they later get their own, saving it in step 4 takes precedence instantly (clean graduation, no redeploy). Operating rules: **one Anthropic Console Workspace per client** with its own key + monthly spend limit (per-client cost visibility, blast-radius containment, one-key revocation on churn) — never share one key across clients. Usage bills to Sanjiv, so "AI included" pricing must assume the client's data volume. This model is **Claude-only by design** — no env fallback exists for OpenAI/Gemini. Admin-only route: `GET/POST /api/accounts/llm-provider` (`{provider, credential}`; `{clear:true}` reverts to env; replaced the old `anthropic-key` route). New code must never read `process.env.ANTHROPIC_API_KEY` directly.

### Reliability
- Chunk, merge, AND export-validation calls retry **twice with backoff** on 429/5xx and **once** on a parse failure (shared `callAnthropicWithRetry` + `JSON_ONLY_REMINDER`, exported from `llm-one-prompt-grouping.ts`).
- A chunk that still fails after retries degrades to honest `'llm_failed'` singleton fallbacks (confidence `'l'`, `needs_review: true`) — never a silent `'h'`.
- Group confidence is the LLM's real `h`/`m`/`l` band; lookup groups are `'h'`.
- Literal values are JSON-escaped when embedded in prompts; LLM-proposed names are validated (length cap 200 chars, no newlines) before use.
- The merge call uses `max_tokens: 8000`.

### Grouping Prompt Content (system prompt, `SYSTEM_PROMPT_TEMPLATE`)
- **Task definition with an operational test**: same real-world entity "written differently — not merely related, similar, or from the same family" — with an explicit announcement that STANDARDIZATION RULES **override** this default (a rule may direct grouping related-but-distinct entities, e.g. subsidiaries under a parent). The merge prompt carries the same override; the rules block itself states it takes precedence over the same-entity test and the bias against grouping.
- **VARIATION TYPES checklist**: 11 transformation classes (acronyms full/partial, word abbreviations/truncations, typos/spelling variants, separators/punctuation, affixes, word order, split/joined words, diacritics, codes/identifiers, rebrands, cross-language), each with a one-line cross-domain example — "check these before leaving a singleton".
- **DO NOT GROUP section** (deferring to rules/DEFINITION): lookalike different entities, ambiguous acronyms → unassigned, parent-vs-subsidiary granularity; plus a worked Country/USSR example.
- **Scoped caution**: bias-against-grouping applies to genuine uncertainty and may never be used to dodge an applicable rule.
- **Per-item payload is minimal**: `literal_value` (JSON-escaped) + `is_pure_acronym` flag only. The old deterministic-pipeline metadata fields (`cleaned_value`, token arrays) still exist on `RunItemForPairing` for `namescore.ts` compatibility but are always empty in live callers and no longer sent to the LLM (`pickBestAliasName` derives its own tokens from the raw literal).
- **Merge representatives are diverse**: each group shows its shortest, longest, and most character-distinct literals (`pickDiverseReps`), not the first three.

### Prompt Caching

The system prompt for the grouping chunks is sent with `cache_control: { type: 'ephemeral' }`
on its last block, so the whole system prefix — including the "EXISTING CANONICAL NAMES"
block — is cacheable. That block is **not** just "the top 200 aliases": it is this run's
lookup-hit aliases, then this run's own current group names, then the top 200 of the spec's
aliases by `usage_count`, plus a retrieval slice when the 200 cap was hit
(`op-auto-group-run.ts`).

**What the cache actually buys — corrected three times (LLM-01); read the code, not the
history.** The two earlier versions of this paragraph were both wrong, in opposite
directions:

1. The original claimed "all parallel chunks share one cached prefix instead of paying for
   it per chunk." False for the chunks that go out together — they race the cache WRITE, so
   none of them reads it.
2. The first correction then claimed the saving lands on "the merge pass, the name-fix pass,
   and successive runs over the same spec, since the canonical-names block is stable." Also
   false: those are different prompts, and that block is not stable.

**What is true:**

- **Within one run, across batches — this is the real saving, and it is the largest one.**
  Chunks are dispatched in batches of `CHUNK_CONCURRENCY` (20), not in a single `Promise.all`.
  Batch 1 pays and writes; batches 2..N read it. **Anthropic only** — see below. The benefit
  therefore *scales with run size*: at 25 items per chunk and 20 chunks per batch, a full
  5,000-value drain **of previously-unseen values** is ~200 chunks ≈ 10 batches, so ~90% of
  chunks hit a warm prefix. Count unmatched items only — values that hash-hit
  `LITERAL_ALIAS_MATCHES` never reach the LLM, so a queue that is mostly lookup hits produces
  far fewer chunks and correspondingly less benefit. A run of ≤20 chunks is a single batch and
  gets nothing at all.
- **On retries.** A retried call re-sends a byte-identical prefix seconds later.
- **Not across runs, in practice.** `existingAliasNames` leads with run-specific content (this
  run's lookup hits, this run's group names) and the single breakpoint covers the entire block,
  so any difference at the front voids the whole read. Even the top-200 tail reorders, because
  export bumps `usage_count` / `last_used_at`. One real exception: when `existingAliasNames` is
  EMPTY the names block is dropped entirely and the cached prefix is just the base system
  prompt, which carries nothing run-specific — so two runs on a brand-new spec (no lookup hits,
  no approved aliases, no existing groups) inside the TTL do share a prefix. That is the
  first-baseline case, e.g. clicking "Create initial standardizations" twice.
- **Nothing at all on OpenAI or Gemini.** `toOpenAiPayload` flattens the system blocks to one
  plain string and drops `cache_control`; `fromOpenAiBody` reports `cache_read_input_tokens: 0`
  unconditionally. Prompt caching is an Anthropic-only feature here. On those providers the
  batching still happens — at `NON_ANTHROPIC_CHUNK_CONCURRENCY` (3), not 20 — but it is purely
  a rate-limit guard and buys no cache reuse whatsoever. Do not read the batch arithmetic above
  as applying to them.
- **Not across call types.** The merge call builds its own system text
  (`buildMergeSystemPrompt`) with its own breakpoint — a separate cache entry, not the chunk
  one. The name-fix call (`fixNamesForConvention`) sets **no `cache_control` at all** and so
  participates in caching not at all.
- TTL is the `ephemeral` default (~5 minutes); nothing requests a longer one.

Serializing the first chunk to warm the cache before dispatching the rest is DECLINED
(owner decision) — it adds ~3–5 s to every run. Note the trade is larger than it first
looked: it would warm *all* subsequent batches, not merely help the occasional cold run.

### LLM Output Formats

**Grouping chunk prompt:**
```json
{"g":[[[item_indices],"proposed_name","h|m|l"],...],"u":[item_index,...]}
```
- `g` — groups: [item_indices (1-indexed), proposed_name, confidence]
- `u` — flat array of ungrouped item indices
- `h`/`m`/`l` — high/medium/low confidence

**Merge pass prompt:**
```json
{"m":[[[group_indices],"merged_name|null"],...]}
```
No merges needed: `{"m":[]}`

**Export validation prompt:**
```json
{
  "case_a": [{"lv": "literal_value", "k": "u|o"}, ...],
  "case_b": [{"original_alias": "string", "new_alias": "string", "k": "u|o", "apply_to_all": true}],
  "case_c": [{"lv": "literal_value", "k": "u|o"}, ...]
}
```
- `k = 'u'` — keep user's change (the default for missing/malformed verdicts)
- `k = 'o'` — revert to original (requires the model be *extremely confident* it's a mistake)

### Merge Name Precedence
- Lookup group + non-lookup group → always use lookup group's alias_name. Lookup-vs-LLM group reconciliation matches names on `normalizeLiteral(name)` (so casing/whitespace variants of the same name collide correctly) — this documented invariant is now true in the live merge path.
- Two lookup groups → **first-seen wins** (audited 2026-08-08, REV-04). This was documented as "the alias with the higher `usage_count`", but no such tie-break exists: the lookup SELECT in `op-auto-group-run.ts` never fetches `usage_count`, and `addToPendingGroup` collapses normalize-equal alias names purely in iteration order. The documented behaviour was aspirational. In practice the case is rare — it needs two DIFFERENT approved alias names that normalize to the same string within one spec (e.g. `AT&T` and `at&t `), which the export's own dedup already works to prevent. Implementing the tie-break would mean fetching `usage_count` in that SELECT and ordering the collapse by it; left as-is deliberately rather than adding a query for a case the data model discourages.
- Two non-lookup groups → LLM proposes merged name

### Group Naming
- The group's alias name comes from the **LLM's `proposed_name`** (its real-world canonical name), threaded through `FinalGroup.proposed_name` (types in `grouping-types.ts`) and carried through the merge pass (`applyMerges` uses the merge LLM's `merged_name`). `pickBestAliasName` (a deterministic pick from the input strings) is only a **fallback** for safety-net singletons or unidentifiable entities.
- The grouping + merge prompts (`llm-one-prompt-grouping.ts`) instruct the model to: identify the real entity and use its commonly-used canonical name (may differ from any input string); prefer the full common name over an acronym (use an acronym only when it genuinely IS the common name — IBM, AT&T); and **FIRST reuse an existing approved alias name verbatim** when a group matches one.
- The spec's existing `APPROVED_ALIAS_NAMES` (top 200 by `usage_count`) are passed into both prompts as the cached "EXISTING CANONICAL NAMES" list so the model snaps new groups onto already-approved names instead of coining near-duplicates.

---

## One-Time Standardization (`app/one-time/`, `op-one-time.ts`)

A throwaway, one-shot flow: standardize one or more columns of a source table and write the result to a standalone Snowflake table (`'create'` or `'overwrite'`). Unlike the pipeline path, it **never reads or writes the shared lookup** (`LITERAL_ALIAS_MATCHES` / `APPROVED_ALIAS_NAMES`) — every value is grouped purely by the LLM, optionally subject to a structured naming convention (`convention-rules.ts`, edited via `ConventionEditor`).

**Size guard:** the one-time distinct scan is otherwise uncapped, so columns with more than `ONE_TIME_MAX_DISTINCT = 20,000` distinct normalized values are rejected at creation with a typed `OneTimeTooLargeError` → clean 400 directing the user to a pipeline instead (the flow assumes a single review sitting and a single merge pass — neither survives that scale).

**Edit-in-place round trip (2026-08-12):** CSV/XLSX uploads keep their ORIGINAL bytes (base64-chunked in warehouse table `ONE_TIME_FILE_BLOBS` — customer values, data residency; lifecycle shared with `ONE_TIME_FILE_ROWS` via `deleteOneTimeFileRows`) so the csv/excel export can hand back the customer's own file with ONLY the standardized cells changed — hidden columns (Dynamics GUIDs), styles, and column order intact for reimport wizards. The patcher is `_lib/file-inplace.ts` (pure, parity-tested): a byte-span CSV tokenizer, and zip-level XLSX surgery (fflate) replacing target `<c>` elements with style-preserving inline strings while every other zip entry passes through byte-identical. Addressing never trusts the stored rows — headers and blank-row-filtered data-row indices are re-derived from the original file itself (`gridToRows` + `gridDataRowIndices`, one filter predicate). ANY patch failure falls back to the legacy regenerated `{headers, rows}` path (never a corrupted "original"); `.xls` (non-zip) and Sheets/paste sessions always use the fallback. Export response carries `{file_b64, file_name, in_place: true}`; the review client downloads it verbatim. Known edge: the create route builds runs column-by-column, so a later column tripping the cap leaves earlier columns' working runs as harmless orphans (see Deferred items).

**Personal-connection fallback:** one-time runs can standardize tables the `PRISM_SERVICE` role can't see. The create route probes the source with the service connection first; on an access error it falls back to the creator's **personal Snowflake credentials** (`accounts.sf_*` — any member may save their own via `/setup`; `snowflake-config` POST is `requireValidSession`, and only admin saves run the grants pass). `withUserWarehouse(accountId, fn)` / `hasUserWarehouseConfig` (async — always await) / `isWarehouseAccessError` live in `_lib/warehouse` (the warehouse facade); in the NATIVE edition the same two resolve to the SPCS caller's-rights session (no stored credentials — NATIVE_APP_PLAN.md §2.9). The chosen connection is recorded as `connection: 'service' | 'user'` in the run's one-time meta (`stats_snapshot`), and the **export uses the same connection** — so an `'overwrite'` export requires the user's own write access to the target table (`'create'` requires their CREATE TABLE on the schema); permission failures return user-directed messages, not `PRISM_SERVICE` grant SQL. `/api/columns` applies the same fallback (INFORMATION_SCHEMA shows zero rows, not an error, for unGranted tables) and returns `needs_user_connection: true` when neither connection can see the table; the one-time card links to `/setup` (which renders a personal-credentials variant for non-admins). Pipelines and the shared lookup ALWAYS use the service connection. Working state lives in `RUNS` with `run_type = 'one_time'` (tied together by a session nonce); the durable archive row is written to `ONE_TIME_STANDARDIZATIONS` on export. It reuses the grouping engine (`runOnePromptGrouping`) and the run state blob. Routes live under `/api/one-time/`; the review UI is `app/one-time/[session]/`.

---

## User Flow

1. New Run → per-column spec (description + rules + convention, edited inline) → locked at creation
2. Data source — Snowflake table path, Excel/CSV upload, or paste values
3. Column selection + preview
4. Auto Group (button click) → hash lookup → LLM chunks in parallel → merge pass
5. Human review — drag items between groups, rename groups, create groups
6. Export → writes to lookup table → async LLM validation runs in background

### Import Options
- Snowflake table (primary)
- Excel/CSV upload (`.xlsx`, `.xls`, `.csv` only — reject all other formats with clear error)
- Paste values (tab or newline separated)

### File Upload Flow
1. Upload file → reject non-`.xlsx`/`.xls`/`.csv` with clear message
2. If multiple tabs: show tab selector (no auto-select)
3. Data start detection (deterministic only — no LLM). **Implemented 2026-08-06 in `_lib/table-shape.ts` (`detectHeaderRow`, pure + parity-tested) after KI-219 — before that it did not exist and row 1 was taken as the header unconditionally, which built a pipeline over four non-existent columns on a real customer sheet whose header was on row 5.** The heuristic, in order: skip leading blank rows; skip narrow title/summary rows; pick the first row that is *about as wide as the data beneath it* (≥60% of the widest sampled row) and is not mostly numeric. Width is the load-bearing signal — a summary row above the table is narrower than the real header. Used by BOTH the CSV/Excel parser and `/api/sheets/columns` (which now reads rows 1–20, not `!1:1`), so the two cannot disagree.
   - **The detected row is shown with an override — for FILE uploads only.** `HeaderPreview` renders the chosen header + first data rows and a "header row" input for CSV/Excel. This is the point: the heuristic *will* be wrong on some layout, and a wrong guess must be visible and correctable rather than silent. **Google Sheets connections currently get no such control** (`sheetsHeaderRow` is set from `/api/sheets/columns` and never surfaced) — so a mis-detected Sheets header is silent and uncorrectable. Recorded 2026-08-09 as SHEETS-HDR-02; this paragraph previously claimed the override covered both paths, which was never true.
   - **The data range follows the header row** — `grid.slice(headerRow + 1)` for files, and `<col><headerRow+2>:` for Sheets. Fixing detection without moving the data range would still ingest the blank rows and the header text as data. **This is exactly what happened for Sheets PIPELINES until 2026-08-09 (SHEETS-HDR-01):** detection was fixed and the picker used it, but the three consumers that re-read the sheet server-side — the creation ingest, the poller's `refreshSheetsFileRows`, and `syncSheetsColumn`'s output grid — all hardcoded `allRows[0]`. A header-on-row-5 sheet therefore ingested the TITLE as its only column name, matched none of the chosen columns, reported 0 source values forever, and echoed the junk rows into the output sheet. The confirmed row is now persisted as `file_source_meta.header_row` and read via `headerRowFromMeta()` by all three; parity-tested, including that no reader reintroduces `allRows[0]`.
   - Column letters come from `columnLetter()`, not `String.fromCharCode(65 + i)`, which emitted `[`, `\`, `]` past column Z and silently read the wrong column on sheets wider than 26 columns.
4. If multiple columns: show column dropdown (never guess)
5. Deduplicate silently; show total rows + distinct count
6. Preview first 10–15 values → user confirms
7. Run created with distinct values as input

Horizontal data (values across columns) is not supported. Show large file warning before run creation if row count exceeds threshold.

### Export Formats
All formats must include: raw value, canonical value, confidence indicator, run ID.
- **Snowflake export table** (default) — the standardized output table embedded in the customer's warehouse
- **CSV** — fallback for non-Snowflake stacks, dbt seed file workflows
- **Excel/Google Sheets** — for less technical users

---

## State Management (Client)

Implemented in `RunReviewClient.tsx`:
- Do NOT write to Snowflake on every drag/rename — state is maintained in memory on the client
- A 30-second autosave timer writes the full blob (with `expectedRev`) whenever there are unsaved changes; suspended while an export is in flight
- `pagehide` flushes via `navigator.sendBeacon` (which can't read the response — acceptable); `beforeunload` warns when unsaved changes exist; the two are debounced against double-firing
- On a `409 conflict` the client refetches the server blob and replaces its local state
- On page load: fetch blob by `run_id` — one query, no joins — hydrate UI directly
- The per-group review checkmarks ("Checked X/Y" counter + round check button on each group row) were **removed 2026-07-13** from BOTH review UIs (`RunReviewClient` and `OneTimeReviewClient`) at the user's request — they were purely client-side state, never persisted or sent anywhere. Do not reintroduce them.

---

## Column Spec Management

- A spec is required for every standardized column and is locked once its run/pipeline is created. `PIPELINES.domain_id` (historical name) holds the spec_id and is NOT NULL; a spec-less run can still have `domain_id = NULL`.
- Specs are created/edited inline: **`app/components/ColumnSpecEditor.tsx`** (full editor) and **`ColumnSpecField.tsx`** (inline popover variant used in the connect form's column picker and the add-column modal). The old domain pickers (`CompactDomainPicker`, `CreateDomainModal`, `DomainSelector`) are **deleted**, as are `/api/domains` (replaced by `/api/column-specs` + `/api/column-specs/[spec_id]`; `POST /api/pipelines` also accepts the spec inline and creates it atomically).
- The shared `ColumnSpec` interface lives in `app/components/spec-types.ts`.
- Specs can carry a structured naming convention (`convention-rules.ts` + `ConventionEditor`). **Enforcement depends on the convention TYPE, and only `regex` and structured rules are actually enforced** — this was previously documented as "enforced three ways" without qualification, which was wrong for two of the four types (SPEC-04, 2026-08-08):

| Convention type | Prompt instruction | Deterministic check + name-fix repair | Review-UI rename guard |
|---|---|---|---|
| `regex` | yes | **yes** (anchored match) | **yes** |
| structured rules | yes | **yes** (`validateConventionViolations`) | **yes** |
| `examples` | yes | **no** | **no** |
| `natural` | yes | **no** | **no** |

  For `examples`/`natural` with no structured rules, `requirements[]` comes out empty, so `fixNamesForConvention` short-circuits with zero LLM calls. Those two types are **advisory prompt-only guidance, deliberately** (decision 2026-08-08): "match these examples" has no mechanical test, so the fix was to correct the *expectation* rather than fake enforcement. An AI-based soft check was considered and rejected — it would cost an extra call per run to re-ask the model something it was already told in the prompt, and still guarantee nothing.

  Two things follow, and both are now implemented. **The setup UI labels which is which**: `ConventionEditor` shows "Enforced — Prism checks every name against this" for regex/structured rules, and "Guidance for the AI — Prism asks the AI to follow this, but can't mechanically check the result" for examples/natural (`ENFORCEABLE_CONVENTION_TYPES` is the single source of truth). **The review UI now displays the convention for ALL types** — `run/[run_id]/page.tsx` used to pass `convention: null` for examples/natural, so a reviewer working through hundreds of groups had no reminder of the contract at all; it now passes any convention with content, carrying the same enforced/guidance label. Safe to widen because the client's rename guard only blocks on structured rules or `type === 'regex'`, so a non-enforceable convention arrives as display context and cannot start rejecting valid renames. The enforced mechanisms, for the types that have them, are: prompt instructions for the LLM, deterministic normalization + validation of the model's output (with a name-fix LLM repair loop), and **client-side rename guards in BOTH review UIs** (run review + one-time): the mechanical form rules are auto-applied to the typed name (same treatment LLM names get), then the rename is blocked with per-requirement reasons if it still violates the regex or a checkable constraint. `applyCase` treats hyphens/underscores as word boundaries ("t-mobile" → "T-Mobile"). Free-text **standardization rules** are deliberately NOT blocked in the UI (natural-language judgment, the human is the authority) — instead they're displayed as a panel at the top of the run review page (threaded via `getRunHeader`, which LEFT JOINs `column_specs` on `spec_id = runs.domain_id`) and handed to the export referee as context.
- Spec creation seeds pre-standardized values + convention examples into the lookup in **batches of 200** (scoped to the new spec_id; values are transient in the POST — never stored in SQLite, data residency) (2 statements/batch, deduped on the normalized form in TS first — statement-level `NOT EXISTS` can't see same-batch duplicates, and two lookup rows sharing a `normalized_value` would break the export joins).
- Both `standardization_rules` and the spec description go verbatim into every LLM prompt — hence the caps in Scale & Input Limits.

---

## Accounts & Auth

- Google OAuth — default authentication (no passwords). OAuth `returnTo` is sanitized to relative paths only (`sanitizeReturnTo`).
- **Terms acceptance (clickwrap, 2026-08-11):** every account must explicitly accept the current terms once before using the app. `CURRENT_TERMS_VERSION` (`_lib/terms-version.ts`, pure module) is the single source of truth — bump it when `/terms`/`/privacy` materially change to re-prompt everyone. Acceptance is recorded on `accounts.terms_accepted_version` + `terms_accepted_at` (migration 017; NULL = never accepted). Two gates route un-accepted accounts to the `/accept-terms` interstitial (checkbox + "Agree and continue" → `POST /api/accounts/accept-terms`, `requireValidSession`): the OAuth callback (every sign-in, including brand-new accounts — terms come before the setup wizard) and the `/home` server component (backstop for sessions predating the feature or a version bump). The login page's "By signing in you agree" line remains as a complement, but the recorded acceptance is the real consent.
- All users in a company share one installation (no per-user data restriction at launch)
- First user to authenticate becomes account owner (`admin` role); `ADMIN_EMAIL` bootstraps the admin
- Invitations expire after 7 days; statuses: `pending` | `accepted` | `revoked`
- Roles: `admin` | `user`

### Sessions & Revocation
- The HMAC-signed session cookie (`prism_session`) carries `v` (session version) and `exp` (7-day TTL; missing/expired ⇒ rejected). Cookies get `Secure` in production.
- `accounts.session_version` (SQLite) is the revocation switch: `_lib/account-security.ts` provides `requireAdminSession` / `requireValidSession` / `bumpSessionVersion`. The check is a local SQLite read — **no cache, runs on every request**, so revocation is effectively instant. A version mismatch or missing account fails closed.
- **Every API route is version-checked**: `proxy.ts` validates only the cookie signature/expiry; each route handler calls `requireValidSession` / `requireAdminSession` (the 2026-07 revocation sweep converted all bare-`decodeSession` routes and added guards to previously guard-less ones like `run/*`). New routes MUST use these guards, not bare `decodeSession`.
- Member management APIs: `GET /api/accounts/members`, `PATCH` / `DELETE /api/accounts/members/[account_id]` — with **last-admin** and **self-delete** guards. Removing a user or demoting an admin bumps their `session_version`, killing their live sessions immediately.

### Error Hygiene
Snowflake error responses to clients are sanitized — no raw SQL or driver messages leak to the browser.

### Security & Disclosures
`docs/SECURITY_AND_DISCLOSURES.md` is the reviewed map of roles, credential storage, data flows that leave the customer's control (AI provider, Google, exports), and where each user-facing disclosure lives (login, setup steps, settings, invite/accept-invite, connect forms, one-time flow). When adding an access path or changing what a credential is used for, update BOTH the relevant UI disclosure and that document — the personal-credentials copy went stale once when the change-tracking auto-fix started using them.

---

## Design System

### Typography
- Font: Inter (Google Fonts), weights 400/500/600 only — never 700
- 400 Regular: body text, meta labels, chip values
- 500 Medium: button labels, toggle options, status pills
- 600 Semibold: page title, card titles, alias names, section headings

### Color Tokens

| Token | Hex | Usage |
|---|---|---|
| `page-bg` | `#F4F6F8` | Page background |
| `surface` | `#FFFFFF` | Card/panel backgrounds |
| `surface-hover` | `#F9FAFB` | Row hover state |
| `accent` | `#378ADD` | Primary buttons, active states, links |
| `accent-strong` | `#185FA5` | Pressed state, text on accent-tint |
| `accent-tint` | `#EAF1FE` | Ghost button bg, selected chip bg |
| `accent-border` | `#C5D8FC` | Borders on accent-tint elements |
| `text-primary` | `#1A1A2E` | Headings, alias names |
| `text-secondary` | `#374151` | Body text, value chips |
| `text-muted` | `#6B7280` | Meta labels, helper text |
| `text-hint` | `#9CA3AF` | Placeholders, counts, empty states |
| `border` | `#E5E7EB` | Card/chip/button borders — always 0.5px |
| `border-subtle` | `#F3F4F6` | Row dividers — always 0.5px |
| `confidence-high` | `#0F6E56` | ≥90% — muted green |
| `confidence-med` | `#BA7517` | 70-89% — muted amber |
| `confidence-low` | `#A32D2D` | <70% — muted red |

### Border Radius — hard-edge (near-square, technical/professional feel)
Defined as CSS variables in `app/globals.css` (`--radius-*`) and mapped to Tailwind utilities (`rounded-card`, `rounded-button`, `rounded-toggle-option`, `rounded-pill`, `rounded-row`) via `@theme inline`. Change the tokens to retune globally.
- Cards / main containers: 3px (`rounded-card`)
- Buttons / toggle containers: 2px (`rounded-button`)
- Toggle group individual options: 2px (`rounded-toggle-option`)
- Value chips / status pills / ungrouped chips: 2px (`rounded-pill`) — these are slightly-rounded rectangles, NOT full pills
- Checkboxes: 50% (kept round)
- Row hover highlight: 2px (`rounded-row`)
- Avatars, status dots, progress bars, spinners, toggle switches, numbered step/notification circles stay round (`rounded-full` / `borderRadius: '50%'`) — do NOT sharpen these.
- **Multi-select squares** (the 18×18 pick boxes in the column pickers) use `borderRadius: 5` — a deliberate softer square that reads as selectable rather than as a status chip, used identically in `AutoExportHome`, `PipelinesView` and `OneTimeStandardizationCard`. Documented 2026-08-08 (UI-01) after an audit flagged it as off-token; every OTHER hardcoded radius found in that audit (a 12px and a 6px dropdown, a 7px card wrapper) was genuinely off-system and has been moved to `var(--radius-card)`.
- Status pills/badges use `rounded-pill` (not Tailwind's `rounded-full`) so they pick up the sharp radius.

### Borders
- All borders: **0.5px** — non-negotiable
- Default: `0.5px solid #E5E7EB`
- Row dividers: `0.5px solid #F3F4F6`
- Drag-over active state: `2px left border #378ADD` (only exception)
- Featured card accent: `2px full border #C5D8FC` (only exception)

### Shadows
Essentially none — shadows are functional, never decorative. Two sanctioned uses:
- The active toggle option (`0 1px 3px rgba(0,0,0,0.08)`) — shows selected state.
- **Floating elements that leave the page plane** — portaled tooltips, dropdown
  menus and the avatar button (`PipelinesView`, `UserMenu`, `RoleBadge`). These
  overlay other content, so a shadow is what separates them from what they cover;
  without it a portaled menu reads as part of the card beneath it. Documented
  2026-08-08 (UI-01) after an audit found five undocumented values in use.
Never add a shadow to a card, panel, row or button that sits IN the page flow.

### Spacing
- Page outer padding: 32px top/bottom, 40px left/right
- Card internal padding: 24px
- Group row vertical: ~13px, horizontal: ~12px
- Gap between value chips: 6px
- Gap between ungrouped chips: 8px
- Gap between group rows: 4px
- Gap between major card sections: 24px

### Copy & Tone
- Sentence case everywhere in the COPY — never write a label or badge string in
  ALL CAPS. This is about the source text: `How it works`, not `HOW IT WORKS`.
- **Sanctioned exception — the small-caps eyebrow treatment.** A handful of
  10–11px labels (section eyebrows, table column headers, data-type chips) carry
  the Tailwind `uppercase` class plus `tracking-wide`/`tracking-wider`. That is a
  deliberate *typographic* treatment, not shouted copy, and it is distinct from
  the rule above: the underlying string stays sentence case (or, for type chips,
  is explicitly `.toLowerCase()`d first) and only the rendering is capitalised.
  Keep it to small, secondary, non-prose labels. **Status pills are NOT in this
  exception** — they read "In review", "Created", "Completed" in both source and
  render, which is what the rule was written for (audited 2026-08-08, UI-01).
- Humanize timestamps — "May 8, 2026 · 6:54 PM" not "5/8/2026, 6:54:22 PM"
- Humanize counts — "3 values need a home" not "Ungrouped items (3)"
- Status labels — "In review", "Created", "Completed" (not "IN REVIEW")
- Empty states encouraging — "No items yet" not blank

---

## Snowflake Connection

- Two auth modes: key-pair/JWT (preferred) vs password+MFA (fallback)
- **Service connection resolution (`createSnowflakeConnection` in `_lib/warehouse/snowflake/connection.ts`), two tiers:** (1) workspace credentials saved by an admin on the `/setup` onboarding flow (SQLite `workspace_config`, secrets encrypted; 10 s in-process cache + `invalidateWorkspaceSfConfig()` on save; a decrypt failure logs and falls through) → (2) `SNOWFLAKE_*` env vars (operator escape hatch). `serviceConnectionSource()` reports `'workspace' | 'env' | 'none'`. Pipelines, the poller, and the shared lookup always use this resolution via `withWarehouse`.
- Per-account **personal** credentials (`ACCOUNTS.sf_*`, saved via Settings or the non-admin `/setup` variant, stored app-level encrypted) are a separate path (`withUserWarehouse`) used by (1) the one-time flow's access fallback and (2) the **change-tracking auto-fix** (`ALTER TABLE … SET CHANGE_TRACKING = TRUE` via the pipeline CREATOR'S credentials when the service role can't create the first stream — at setup in `create-initial-run`, and from the poller's `attemptChangeTrackingFix` if a source table is later recreated) — they never affect the service connection
- `SNOWFLAKE_PRIVATE_KEY`: inline PEM — handle literal `\n` → real newline conversion before use
- `SNOWFLAKE_PRIVATE_KEY_PATH`: file path alternative — read and parse at connection time
- No connection pool — new connection per request, destroyed in `finally`
- `destroy()` always resolves — swallows "Already disconnected" errors
- MFA error 394508 → respond with "use key-pair auth" message
- Use `import 'server-only'` compile-time guard in all Snowflake utility files
- Error responses to clients are sanitized (no raw SQL/driver messages)

---

## Pipeline Update Time Windows

The old auto/manual `mode` is gone. Every pipeline instead carries an **update schedule** (`PIPELINES.update_schedule` JSON, types + evaluation in `_lib/update-schedule.ts`, edited via the shared `app/components/UpdateScheduleEditor.tsx` in both the connect form and the card's Settings tab):

- **Time window** (`{"type":"window","days":[…],"start_hour":H,"end_hour":H,"timezone":"…"}`) — the creation **default is Mon–Fri, 9 AM–5 PM** in the creator's browser timezone (IANA name stored on the schedule; missing/invalid timezone → evaluated in server time). Days use JS `getDay()` encoding (0=Sun); `start_hour` inclusive, `end_hour` exclusive; an inverted window (22→6) wraps overnight. Prism auto-standardizes only while the window is open — the 10-minute tick checks `isScheduleActiveNow()` at fire time. Values arriving outside the window are queued and drain at the first tick after it opens.
- **24/7** (`{"type":"always"}`) — standardize automatically around the clock (every 10-minute tick). Existing `mode='auto'` rows were backfilled to this (migration 006).
- **Manual only** (`{"type":"manual"}`) — the old `manual` behavior: Prism never auto-standardizes; the owner triggers it via "Update Standardizations". All file-based pipelines (Sheets, CSV, Excel) are always manual-only (hard-coded at creation; no schedule picker).

Only Snowflake pipelines can have window/always schedules. The manual "Update Standardizations" trigger works for every schedule type.

**The poller runs for ALL active pipelines regardless of schedule** — including manual-only and file-based — but it ONLY detects and queues; it never standardizes inline. One poll pass fires at every wall-clock MINUTE mark (2:33:00, 2:34:00, … — `Date.now() % POLL_INTERVAL_MS`, self-chaining so passes never overlap; all tables polled concurrently per pass, newly-activated pipelines picked up at the next mark). Each pass, per pipeline:
- **Snowflake**: classify stream (list A = already in the lookup, list B = new/unmapped — informational split, logs only) → **queue EVERYTHING** (list A + list B) → update `total_source_values` / `queue_size`. Deletes (and null-only inserts) still trigger an immediate hygiene rebuild.
- **Sheets**: re-read Google Sheet via stored `refresh_token` → replace `PIPELINE_FILE_ROWS` → recompute `total_source_values` / `total_mapped` / `queue_size`
- **CSV/Excel**: recompute metrics from existing `PIPELINE_FILE_ROWS` vs `LITERAL_ALIAS_MATCHES`

**The 10-minute standardization tick (2026-07-13, replaces the >25-queue threshold + hourly sweep):** `startQueueProcessor` (`pipeline-hourly-processor.ts`, started from `instrumentation.ts`) fires at every 10-minute WALL-CLOCK mark (1:00, 1:10, … — `Date.now() % QUEUE_TICK_MS`, aligned to the clock, not to process start or pipeline creation; self-chaining so ticks never overlap and a long run skips to the next mark). Each tick drains **any non-empty queue** (no size threshold) for every window-open pipeline, grouped by table, via `standardizeTable` → `processPipelineQueue`. The **top-of-hour tick** additionally runs the reconciliation sweep + safety export rebuilds first (kept hourly — they full-scan sources and rebuild every export). **The sweep is window-aware (2026-08-06, KI-88/KI-115):** it skips pipelines whose `update_schedule` is an *explicitly stored* `window` that is closed right now. `always` (24/7) and `manual` pipelines are always swept, and so is any pipeline whose stored schedule is missing/unparseable — the sweep **fails open**, because a safety net must keep running when it cannot read its own configuration (`parseStoredSchedule` otherwise defaults a NULL/corrupt value to Mon–Fri 9–5, which would silently stop overnight sweeps). Manual-only is deliberately NOT excluded: the sweep is its only automatic recovery from a mass event, and since the manual "Update Standardizations" button drains the QUEUE, values the sweep never queued would not be standardized by a manual click either. Rationale: the sweep re-reads the source (never metadata-only), so it woke the warehouse 24×/day regardless of activity — ~24 billed minutes/day on an idle install, contradicting the "quiet source costs zero" guarantee below. A Mon–Fri 9–5 pipeline now sweeps 40×/week instead of 168×. The per-pipeline failure backoff still applies inside `processPipelineQueue`.

**Consistent-snapshot export:** new source values — *even ones already standardized in the lookup* — never fast-path into the export at the end of a poll cycle. They wait in `PIPELINE_QUEUE` and reach the export together at the next tick, so the export table is always "fully updated as of its last update" with no values trickling in between. Consequences wired into the code:
- The poller's consuming MERGE queues ALL new non-null values (no `lam.literal_value IS NULL` filter); the classify's list A/list B split is only for logs.
- The poller no longer bumps `total_mapped` at poll time (list A used to `+=` immediately); counters are recomputed absolutely at each rebuild, so the card describes the exported snapshot.
- **A tick whose queue is 100% lookup hits makes ZERO LLM calls** — `runAutoGroupForRun` hash-matches them against `LITERAL_ALIAS_MATCHES` and only calls `runOnePromptGrouping` when unmatched items exist; the export still rebuilds, publishing them. (E.g. 100 new rows of already-known values: queue shows 100, the next tick or a manual Auto-standardize maps them from the lookup and exports, no AI cost.)
- Export rebuild triggers in the poll cycle are row-level hygiene only: deletes and null-only inserts. (Any rebuild is CREATE OR REPLACE from live source, so hygiene rebuilds may incidentally surface queued values early — the guarantee is that new values never *cause* a rebuild.)
- The card shows ONE freshness timestamp — `fully_synced_at`, "Up to date X ago" — under the schedule badge (see the PIPELINES column docs for its stamp points). `export_updated_at` is still stamped on every rebuild but is not displayed.

**Export shape is time-independent:** `refreshExportTable`'s include-unmapped-raw behavior (LEFT JOIN + `export_unmapped_rows` setting) is keyed ONLY on the stored setting — never on the schedule type or on whether the window is open at rebuild time — so the export's row set never flips with the clock. Since 2026-07-22 the setting applies to **every** schedule, 24/7 included (which also holds unmapped values between ticks, during installment drains, and while paused), and **defaults off** (mapped rows only). The connect form shows the toggle for all schedules, and it is **editable post-creation** in the card's Settings tab (PATCH accepts `export_unmapped_rows`; the client fires one refresh-export after saving so the change lands immediately — for views that recreates the view). The "Mapped only" card badge was removed 2026-07-24 at the user's request — the setting is visible only in the card's Settings tab (do not reintroduce the badge).

The Live indicator shows for **all** active pipelines (the old polling ring is removed — see Activity Status). The Pause button is hidden for manual-only schedules. The card badge shows the schedule label (`scheduleLabel()`: "Mon–Fri, 9 AM–5 PM" / "24/7" / "Manual only") with the "Standardized table last updated X ago" freshness timestamp (`fully_synced_at`) beneath it (an amber "Standardizing…" pulse while a pass runs). The auto-standardize loading state for file-based pipelines is tracked via local `autoStdBusyKey` state (not SSE events, which don't fire for file-based).

---

## File-Based Pipelines (Sheets, CSV, Excel)

File-based pipelines connect to uploaded files or Google Sheets instead of live Snowflake tables. They are always created with `update_schedule = {"type":"manual"}` — there is no auto-standardize trigger.

### One Pipeline Per Tab Architecture

**Key invariant:** one PIPELINES row per Google Sheet tab (or per uploaded file). All columns being standardized for that tab are stored in `file_source_meta.columns`. The row-level `column_name` / `domain_id` fields hold the first column only (schema compatibility).

This means the GET `/api/pipelines` route **virtually expands** Sheets pipelines: each entry in `file_source_meta.columns` becomes a virtual pipeline object with the same `pipeline_id` but different `column_name`/`domain_id`. `PipelinesView` groups by `file:${table_fqn}` (not by `pipeline_id`) so all virtual entries land on one card.

### Dupe Check (Critical)

`POST /api/pipelines/file` checks for existing pipelines by `spreadsheet_id + tab_name` before inserting. **Fetches ALL rows (no `LIMIT 1`)** — if any row is `active`/`paused`, return 409. If all rows are `pending_baseline` (incomplete orphaned setups), delete them all and proceed. Using `LIMIT 1` was a bug: if the DB had both a `pending_baseline` and a `paused` row, it could miss the live one, resulting in a third pipeline row and duplicate columns in the UI.

### `table_fqn` for File Pipelines

`SHEETS:<spreadsheet_id>:<tab_name>:<nonce>` — the nonce ensures uniqueness even if a tab is re-connected after deletion. Parseable by splitting on `:`.

### `file_source_meta` Schema

```json
{
  "source_type": "sheets",
  "spreadsheet_url": "https://docs.google.com/...",
  "spreadsheet_id": "1abc...",
  "sheet_tab_name": "Sheet2",
  "columns": [
    { "column_name": "Company Name", "domain_id": 1, "total_source_values": 5, "total_mapped": 3 },
    { "column_name": "Mobile Carrier", "domain_id": 2, "total_source_values": 7, "total_mapped": 5 }
  ],
  "refresh_token": "enc:v1:..."
}
```

The `refresh_token` is the user's Google OAuth refresh token, stored at pipeline creation so the background poller can re-read the sheet autonomously every poll pass (each minute mark). Required for automatic metrics updates. It is stored **app-level encrypted** (AES-256-GCM via `PRISM_ENCRYPTION_KEY`, `enc:v1:` format) and decrypted only at the point of use.

**Per-column metrics** (`total_source_values`, `total_mapped`) are written into each column entry by `refreshSheetsFileRows` and the poller's fallback path. Meta write-backs **re-read fresh `file_source_meta` and merge only the computed per-column metrics** into it (never overwrite the whole object from a stale in-memory copy). The GET `/api/pipelines` virtual expansion reads these per-column values when present, so `buildPipelineGroups` sums correct per-column values instead of duplicating the row-level aggregate to every virtual entry (which caused double-counting). If per-column metrics are absent (legacy rows), the row-level aggregate is used as a fallback.

### Standardization Flow (Sheets)

1. `POST /api/pipelines/file` → creates ONE pipeline row, stores all columns in `file_source_meta.columns`, **populates `PIPELINE_FILE_ROWS`** at creation time (reads the Google Sheet via OAuth access_token and inserts rows), creates one review run per column
2. Multi-column wizard → user reviews each column's run → "Accept Standardizations" (deferred export) for each → "Begin Pipeline" commits all
3. `POST /api/pipelines/[id]/process-queue` (manual trigger) → reads `PIPELINE_FILE_ROWS` via `readFileDistinctValues` per column → `bulkProcessPipelineQueue` per column → `syncSheetsColumn` once at end to write output sheet

### Google Sheets I/O (`op-file-pipeline.ts`)

- **Reads paginate**: `readAllSheetRows` fetches in 10 000-row pages until exhausted — no hardcoded `A1:ZZZ10000` cap; large sheets are read fully.
- **Output writes are non-destructive**: `syncSheetsColumn` rewrites the output tab via chunked `values.update` calls; any trailing-row cleanup happens only AFTER the new data is successfully written (a mid-write failure never leaves the tab cleared).
- **A1 tab names** are escaped by doubling single quotes (`a1Sheet`) so tabs with quotes/spaces address correctly.
- **Output matching + CSV download use `normalizeLiteral`** on the compare key, consistent with the SQL `PRISM_NORMALIZE` joins.
- `syncSheetsColumn` fetches ALL confirmed mappings from `LITERAL_ALIAS_MATCHES` for all standardized columns, reads the full source sheet, applies mappings to each standardized column, and writes back. One call covers all columns regardless of which column's pipeline triggered it.

### Background Polling for File Pipelines

`pollOneFilePipeline` runs every poll pass (minute mark) for each active file pipeline:
- **Sheets + refresh_token**: `refreshSheetsFileRows(pipelineId, meta)` — authenticates with the decrypted `refresh_token`, reads the full sheet via the paginated Sheets API, **skips all Snowflake work when the sheet content hash is unchanged from the last cycle** (returns `'unchanged'`; in-memory sha256 cache, full refresh on first cycle after restart), wraps `DELETE` + `INSERT` into `PIPELINE_FILE_ROWS` in an explicit `BEGIN`/`COMMIT` transaction, computes per-column metrics via SQL joining `PIPELINE_FILE_ROWS` against `LITERAL_ALIAS_MATCHES` (normalized on both sides), writes per-column metrics into `file_source_meta.columns`, and updates aggregate PIPELINES metrics
- **CSV/Excel (or Sheets without token)**: recomputes metrics from `PIPELINE_FILE_ROWS` only **every 20th cycle (~10 min)** — the rows are static, and standardization paths recompute metrics themselves; the per-cycle recompute was pure warehouse churn. Computes from existing `PIPELINE_FILE_ROWS` only, writes per-column metrics into `file_source_meta.columns`, updates aggregate PIPELINES metrics. **Empty guard:** if `PIPELINE_FILE_ROWS` has zero rows (table not yet populated or data cleared), the UPDATE is skipped entirely to avoid resetting metrics to 0/0

Emits `scanning_started` / `scanning_finished` SSE events (same as Snowflake) — the client currently ignores these (the polling ring is gone). Does NOT LLM-standardize anything.

### Pipeline Metrics for File-Based

- `total_source_values` = total distinct non-empty values across all standardized columns in `PIPELINE_FILE_ROWS`
- `total_mapped` = distinct values with a confirmed match in `LITERAL_ALIAS_MATCHES` (normalized join per column)
- `queue_size` = `total_source_values − total_mapped`
- **Per-column storage:** each column's `total_source_values` and `total_mapped` are stored in `file_source_meta.columns[]` (see schema above). The GET `/api/pipelines` virtual expansion reads these per-column values so that `buildPipelineGroups` sums correctly. Without per-column metrics, the row-level aggregate is duplicated to each virtual entry and summed again (double-counting bug).

---

## Pipeline Subsystems

These cover the background pipeline path — the core of the product.

### Convention Regexes Run on RE2, Never the Backtracking Engine

A naming-convention regex is user-authored and is matched against raw source
literals **on the single Node thread**. `new RegExp` backtracks, so a pattern
like `(a+)+b` never returns — measured still running after 60 s against a
200-char input — and a running regex **cannot be interrupted**, so it freezes
the whole installation: UI, poller, every pipeline, with nothing crashing and
nothing logged. Capping the input was tried and does **not** bound it (these
patterns hang at ~40 chars).

Since 2026-08-08 the server compiles every convention regex with **RE2**
(`_lib/safe-regex.ts`, `re2-wasm`) — a linear-time engine that cannot backtrack.
Same pattern, 5 ms. `compileSafeRegex` returns null for a construct RE2 cannot
express (backreferences, lookahead, lookbehind); **null means "cannot enforce",
never "fall back to `new RegExp`"** — that fallback would reinstate the hang.
`safeRegexError` gives the save path a user-facing reason naming the construct.

Save-time keeps **both** checks, and they are not redundant: RE2 decides what
the server can enforce, while `isProbablyCatastrophicRegex` keeps catastrophic
shapes out of storage because the **browser** still uses plain `new RegExp` for
the review UI's rename guard (a one-tab freeze, not worth shipping wasm to the
client to prevent). The cost is that a few patterns RE2 could safely run are
rejected at save — a deliberate trade. Parity-tested: the server match sites
must use `compileSafeRegex`, and `safe-regex.ts` must never contain
`new RegExp`.

### Literal Normalization (`PRISM_NORMALIZE`)
- `PRISM_DB.INTERNAL.PRISM_NORMALIZE(VARCHAR)` — a JavaScript UDF in `01_internal_tables.sql`: Unicode NFC → strip control chars → collapse/trim whitespace → lowercase. Mirrored EXACTLY by `normalizeLiteral()` in `app/api/_lib/normalize.ts` (same JS engine) so in-memory matching agrees with SQL matching — **change both together** (and backfill `LITERAL_ALIAS_MATCHES.normalized_value` if the logic changes).
- Purpose: byte-variant spellings of the same value (`"AT&T "` vs `at&t`, NFC vs NFD, stray control chars) compare equal for lookups/dedup.
- **Stored column on the lookup side**: `LITERAL_ALIAS_MATCHES.normalized_value` is materialized at write time (every INSERT/MERGE must set it), so lookup/export joins compare a plain stored column — hash-joinable, partition-prunable. Only the **source side** of a join runs the UDF (`PRISM_NORMALIZE()` on the source expression). The **original** literal is still what's stored/displayed — case is folded only for the match key, so the LLM sees real casing.
- Source scans dedup with `GROUP BY PRISM_NORMALIZE(...)` + `ANY_VALUE(...)` (a representative original) instead of `SELECT DISTINCT`.
- Service role needs `GRANT USAGE ON FUNCTION PRISM_NORMALIZE` (included in the ROLES AND GRANTS block of `01_internal_tables.sql`).
- ⚠️ **Always write the UDF FULLY QUALIFIED (`PRISM_DB.INTERNAL.PRISM_NORMALIZE(...)`) in generated SQL — never bare.** Snowflake resolves an unqualified name in a **stored view body** against the *view's own schema*, not the session schema the view was created in. Bare calls therefore worked everywhere the statement ran in-session (schema = `INTERNAL`) but broke `CREATE VIEW` for every export destination outside `PRISM_DB.INTERNAL` — i.e. every realistic customer destination — with "Unknown function PRISM_NORMALIZE" (KI-149; fixed 2026-08-04 by qualifying all 29 call sites). Qualifying also removes the latent dependency on the `SNOWFLAKE_SCHEMA` env override.

### Delete-Aware Streams (NOT append-only)
- Pipeline streams are STANDARD streams (no `APPEND_ONLY`) so the poller sees inserts, updates, AND deletes.
- An UPDATE = delete-half + insert-half. The insert-half (new value) is queued/standardized; the delete-half triggers an export rebuild.
- On delete/update the **lookup table is never touched** — only the export table is rebuilt (`CREATE OR REPLACE … AS SELECT` from the current source), so rows no longer in the source drop out (within the next minute-mark poll pass).
- Once per process per pipeline the poller checks the stream via `SHOW STREAMS` (metadata-layer): **missing** → create + full gap recovery (rows inserted while no stream existed are invisible to the fresh stream — never `CREATE IF NOT EXISTS` without recovery; a swallowed initial-run pre-create failure once left a pipeline streamless and 2 already-mapped inserts undetected); **APPEND_ONLY** (legacy) → upgraded via `CREATE OR REPLACE`.
- **Change tracking is a hard prerequisite** — creating a table's FIRST stream auto-enables it, which requires MODIFY (the service role has only SELECT). Snowflake's "Insufficient privileges … without CHANGE_TRACKING enabled" error (`isChangeTrackingPrivilegeError`) is handled by an **auto-fix**: enable change tracking via the pipeline creator's saved personal credentials (`withUserWarehouse`), then create the stream and recover — done synchronously at setup (`create-initial-run`) and fire-and-forget from the poller (`attemptChangeTrackingFix`, in-flight-guarded; covers a customer `CREATE OR REPLACE`ing their table, which wipes change tracking). When the creator has no saved credentials or the ALTER fails, the pipeline pauses (poller) or is flagged (setup) with the exact fix SQL — this failure looped invisibly every cycle once; never let it be silent. The demo table in `02_demo_data.sql` is created with `CHANGE_TRACKING = TRUE`. Any offset reset (missing-create, upgrade, or stale recreate) calls `recoverAfterStreamReset`: reconcile (unmapped → queue) **and** an export rebuild (already-mapped gap rows → export directly — they can't be queued because the queue is value-level and recovery can't tell which ROWS of a known value are new; metrics recount at the rebuild). These reset paths update `last_polled_at` with `claimSynced: false` — they must not stamp `fully_synced_at` while gap rows are still being recovered.
- Hourly safety rebuild covers mass events the stream may not cleanly surface (TRUNCATE, bulk reload, Time-Travel restore/UNDROP).

### Reconciliation Sweep & Baseline Cap
- Baseline scans cap at `LIMIT 5000` distinct values. The tail beyond the cap (and gap rows) is recovered by `reconcilePipelineQueue` / `runReconciliationSweep`: a set-based MERGE that queues unmapped distinct source values not already queued, up to `RECONCILE_QUEUE_BATCH = 5000` per pass. Runs at the start of each top-of-hour tick.
- **Standardization runs drain the queue in 5,000-value installments** (`fetchQueueLiteralsWithFreq` has `LIMIT 5000`, FIFO by `detected_at`): a bulk load that floods the stream with tens of thousands of new distinct values becomes several sequential runs across successive 10-minute ticks (manual trigger = one 5k installment per click, `queue_size` shows the remainder). The queue itself is uncapped — it's the persistent buffer; stream consumption + queue MERGE are transactional, so no values are lost between them.

### Scale & Input Limits (guardrails — all refuse loudly or defer, never drop silently)
| Limit | Where | On exceed |
|---|---|---|
| 5,000 distinct / standardization run | queue drain + baseline scans | remainder processes on later passes/clicks |
| 20,000 distinct / one-time column | `ONE_TIME_MAX_DISTINCT` (`op-one-time.ts`) | 400, "connect as a pipeline" |
| 5,000 rows / bulk MERGE statement | `EXPORT_MERGE_BATCH` (`op-export.ts`) | automatic batching (Snowflake ~65k-bind ceiling) |
| 100,000 rows / Google Sheet tab | `MAX_SHEET_ROWS` + `SheetTooLargeError` (`op-file-pipeline.ts`) | creation → rollback + 400; poller → pipeline pauses with `status_message` |
| 20 MB / 200,000 rows per CSV/Excel upload | client pre-parse + `POST /api/pipelines/file` | clear error, "load into a Snowflake table" |
| 20 rules × 500 chars; description ≤1,000; regex convention ≤500 (examples/natural ≤2,000); pre-standardized values+examples ≤500 total × 200 chars | spec create route (one-time route mirrors the rule caps) | 400 with the specific limit |
| 200 chars / alias name | both review UIs (matches `sanitizeProposedName`) | rename blocked with banner |

### Export Table — Source-Order Preservation
- **No synthetic ordering column** (the old `PRISM_ROW_ORDER` and its ingest-order fallback were removed 2026-07, user decision): the export contains ONLY the source's columns (watched ones replaced by canonical names). `resolveSourceOrdering` orders the TABLE build to mirror the source only when the source declares its own ordering basis, in tiers: (1) PRIMARY KEY, (2) UNIQUE KEY (first constraint by name), (3) CLUSTERING KEY columns — detected via metadata-layer `SHOW PRIMARY KEYS / SHOW UNIQUE KEYS` + `INFORMATION_SCHEMA.TABLES.CLUSTERING_KEY`. A source with none of these gets an unordered export. Consumers needing guaranteed order `ORDER BY` the key columns themselves (they exist in the export) — **this is the only guarantee, and it is not optional advice.** The physical CTAS sort clusters the data on the source's key; it does NOT make a plain `SELECT *` come back in that order. Live-reproduced 2026-08-09 (OPS-07A): on a 15-row export, 3 of 6 rebuild-then-raw-read trials returned the two micro-partitions in reverse order, even with `SYSTEM$CLUSTERING_INFORMATION` reporting perfect clustering (`average_overlaps: 0.0`, `average_depth: 1.0`). Snowflake simply does not order an unordered SELECT across micro-partitions. 15 rows already produced two partitions, so a real customer table hits this MORE often, not less. The sort is still worth doing — it makes ordered reads cheap — but never tell a customer their export reads back in source order. Views are never given an ORDER BY (order isn't preservable through a view).
- Rebuilds use `CREATE OR REPLACE TABLE … COPY GRANTS AS SELECT`, so privileges granted to consumers on the export table survive each rebuild.
- **Views are created exactly once, at activation** (`PATCH status='active'`, fire-and-forget) — the poller/tick never touch them, so that single attempt failing (e.g. missing `GRANT CREATE VIEW` on the export schema) used to leave a healthy-looking pipeline with no view and no retry anywhere. Since 2026-07-22: an activation-time export failure is flagged on the card (`flagPipelineMessage`, curated per-kind message — never raw driver text), and `POST /api/pipelines/[id]/refresh-export` runs for views too ("Recreate view now" button in the card's Settings tab), doubling as the repair path; a successful manual refresh clears the flag on active pipelines.

### Standardized-Column Output (`export_kind = 'column'`)
- The fourth output mode ("Column" in the connect form, added 2026-07-22): Prism maintains a `<col>_STANDARDIZED` companion column ON the customer's source table — canonical name where the raw value has a confirmed mapping, NULL otherwise. Name comes from the shared `standardizedColumnName()` helper (`_lib/export-kind.ts`) — used by BOTH warehouse implementations and shown verbatim in the setup copy; parity-tested.
- Implementations: `refreshStandardizedColumnsSnowflake` (in `export-table.ts`) and `refreshStandardizedColumnsMssql` (in `warehouse/mssql/export.ts`, reusing the shared `materializeAliasStaging` staging builder). Dispatched from `refreshExportTable` on kind `'column'` — all existing call sites (poller hygiene, tick, activation, refresh-export route, op-export) work unchanged because column pipelines store `export_table_fqn = table_fqn`.
- **Never creates/drops/replaces a table.** First run adds the missing companion column(s) via `ALTER TABLE ADD COLUMN` (Snowflake: needs table OWNERSHIP; mssql: ALTER permission); every run then applies two guarded UPDATEs per column (set changed mapped values via `EQUAL_NULL`-style change guards; NULL-out no-longer-mapped rows). Privilege failures throw a message containing the exact ALTER/GRANT SQL for the customer's admin — the poller surfaces it as a pause `status_message`.
- **The change guards are load-bearing:** the pipeline's own stream/CT watches the source table, so Prism's writes are re-detected next poll. Because re-detected values are already in the lookup (no LLM cost) and the follow-up sync updates 0 rows (guards), the echo settles after one cycle instead of churning forever. Do not remove the `WHERE …changed` conditions.
- **Data-loss guard:** the table/view rebuild paths in BOTH builders throw if the export destination equals the source table — a mis-parsed export_kind can therefore never `CREATE OR REPLACE` the customer's source. Related: parse `export_kind` only via `asExportKind()`.
- **Source-column guardrails (2026-07-22, do not weaken):** (1) `assertCompanionColumnSafe(writeTarget, watchedRawColumns)` (`export-kind.ts`, pure, parity-tested) — every column-mode write path calls it immediately before building ALTER/UPDATE statements; it throws unless the target is exactly a watched column's `standardizedColumnName()` companion and collides with no watched raw column. (2) Creation-time conflict refusal: `POST /api/pipelines` calls `assertCompanionColumnAvailable` for new column-mode pipelines and 400s with `CompanionColumnConflictError` when `<col>_STANDARDIZED` already exists on the source — Prism can't distinguish its own column from customer data, so pre-existing names are never written into (a leftover companion from a deleted Prism pipeline must be dropped manually to reconnect). (3) The connect form shows an unmissable warning panel on the Column option (how the table is edited, never-touch-existing-columns intent, no-liability statement, recommendation against unrecoverable data) with a **required consent checkbox** — the API 400s `export_kind='column'` without `column_write_consent: true` (AddColumnModal restates the notice for new columns on a column-mode table and sends the flag). (4) **Write access is per-table, consent-gated — onboarding grants none**: on creation the POST runs `provisionColumnModeAccess` via the creator's personal credentials (change-tracking-fix pattern) — companion `ADD COLUMN IF NOT EXISTS` (needs table ownership, which UPDATE doesn't confer — this is why the service connection can't do it at sync time) + `GRANT UPDATE ON TABLE <that table>`; failure/no-creds → pipeline flagged with the exact SQL (`columnModeSetupSql`, both dialects) and the warehouse itself refuses every write until an admin runs it. **Column mode must pass docs/PRELAUNCH_CHECKLIST.md §1 (live source-integrity test) before any customer deployment.**
- UI: the Settings tab shows no destination input for column pipelines (destination is pinned) and `handleSave` omits `export_table_fqn` from the PATCH; the manual button reads "Sync standardized columns now" (same refresh-export route).

### Poller Cost & Failure Backoff
- **Standardization failure backoff** (`pipeline-hourly-processor.ts`): consecutive standardization failures per pipeline are tracked in memory; retries back off exponentially (`2^n` minutes, capped at 60), and after **5 consecutive failures the pipeline auto-pauses** with a `status_message` explaining why. A full success resets the counter.
- **Retries reuse the pending RUNS row** — tick-driven standardization runs are created with a `creation_nonce` prefixed `hourly_<pipeline_id>_` (historical prefix); a retry looks up and reuses the pending run for that pipeline instead of inserting a new one each attempt.
- **At most one export rebuild per table per cycle** — rebuild triggers are collected across all of a table's columns during the poll and executed once, not per column.
- **`fetchActivePipelines` is cached for 10 s** (shared by the supervisor tick and every per-table loop; invalidated whenever the poller itself changes a pipeline's status).
- **The 10-minute tick must not wake `PRISM_WH` on an idle install either.** `fetchPipelinesWithQueue` reads SQLite FIRST (active + Snowflake + window-open), then short-circuits on the `pipelines.queue_size` mirror, and only opens a warehouse connection when the mirror says work might exist. It previously ran its `SUM(source_frequency)` query against `PIPELINE_QUEUE` unconditionally every tick — 144 warehouse resumes/day on a source that never changes, each billing a 60-second minimum, directly contradicting the "a quiet source costs zero" guarantee. It only *looked* fine because Snowflake's 24h result cache served the byte-identical query; that is an opportunistic optimization, not a guarantee, and it evaporates the moment any pipeline's queue changes. The mirror is trustworthy because every writer into `PIPELINE_QUEUE` updates it in the same breath (poller MERGE, `reconcilePipelineQueue`, `removeExportedFromQueue`); a NULL `queue_size` **fails open** (treated as possible work) since a missed pass is worse than one extra wake.
- **Idle-cycle discipline (Phase 4):** an idle poll cycle (stream reports no data, local queue mirror is 0) touches ONLY metadata-layer operations — `CREATE STREAM IF NOT EXISTS`, `SYSTEM$STREAM_HAS_DATA` (cloud services), SQLite, SSE — and never wakes `PRISM_WH`. The idle-branch backlog check queries `PIPELINE_QUEUE` only when the SQLite `pipelines.queue_size` mirror is > 0. A failed `CREATE STREAM` (dropped/renamed source) sets `lastPollErrored` so the health check runs next cycle and pauses the pipeline with a message.
- **`checkSourceHealth` runs on data-bearing cycles only** (every 10th such cycle per pipeline — its POLICY_REFERENCES probe can wake the warehouse; the column check itself is a metadata-only `SHOW COLUMNS`, never a `SELECT` against `INFORMATION_SCHEMA.COLUMNS`, which resumed the warehouse and was once the account's most expensive query). It's forced immediately after an error; while a `status_message` is set it re-checks on an exponential backoff (2, 4, 8… cycles, capped ~5 min) instead of every cycle.

### Pipeline Health Guards & Alerts
- When it runs (see cadence above), `checkSourceHealth` verifies before stream work:
  - source table dropped/renamed/access-revoked, watched column dropped/renamed, or column type no longer text → **pause** + `status_message`. (Checked via `SHOW COLUMNS IN TABLE` — a missing table throws "does not exist or not authorized" rather than returning zero rows; `data_type` comes back as a JSON blob whose `type` field is `TEXT` for all varchar flavors. Exact-case quoted identifiers, same as the rest of the poller.)
  - masking / row-access policy detected on the watched column (via `POLICY_REFERENCES`) → **skip** standardization + message; auto-recovers (re-checked on the exponential backoff) when removed. (Detection only — Prism does not manage or integrate with masking policies.)
- **A "skip" flag must block EVERY standardization entry point, not just the poll cycle.** `flagPipelineMessage(pid, msg, level, reason)` writes a machine-readable `PIPELINES.status_reason` alongside the human `status_message`; `PIPELINE_BLOCK_REASONS` + `NOT_BLOCKED_SQL` (`pipeline-alerts.ts`) are the shared gate, and the 10-minute tick, the reconciliation sweep, and `POST /api/pipelines/[id]/process-queue` (409) all apply it. Until 2026-08-07 the masking flag was **advisory prose only**: the tick and sweep read `PIPELINES` without consulting it, so a masked column's values were queued, LLM-standardized, and written PERMANENTLY into `LITERAL_ALIAS_MATCHES` within about an hour — indistinguishable from legitimately confirmed mappings — while the card told the user "standardization skipped". **Never pattern-match `status_message` in code**; it is prose for the card. Anything that needs to *act* on a flag filters on `status_reason`. Parity-tested (the SQL fragment must stay derived from the reason list, and must admit unflagged/NULL pipelines — a gate that accidentally excluded healthy pipelines would silently stop all automatic standardization).
- `classifyPollError`: global infra (expired key, disabled user, suspended/no-credit warehouse, read-only secondary) → account-level banner + auto-resume, **no** per-pipeline pause; per-table access (revoked/not-authorized/does-not-exist) → pause; transient → retry next cycle.
- SWAP / CREATE OR REPLACE and admin-dropped streams are handled by the stale-stream recreate + reconcile path. Renames are indistinguishable from drops, so both → pause + message.
- See `pipeline-alerts.ts` for the helpers and the SSE `alert` event.

### Review-First Pipeline Creation (`pending_baseline`)
- "Create initial standardizations" inserts the pipeline as `status='pending_baseline'` (no auto-standardize) and builds a review run via `POST /api/pipelines/[id]/create-initial-run` (pre-creates the stream, then auto-groups) → opens `/run/{run_id}`.
- Run page (pipeline runs → `isAutoExport`) → **Accept Standardizations**. Corrected 2026-08-08 (PIPE-16) — this does NOT write to the lookup. `isAutoExport` is hardcoded `true` for every pipeline-mode run, so Accept always posts `defer: true`; the export route's deferWrite branch marks the run `'approved'` and writes nothing. It advances `pending_baseline → paused`, returns `pipeline_id`, and redirects to `/home`. The actual lookup write happens later, at **Begin Pipeline Standardization**, via `POST /api/pipelines/[id]/commit-standardizations`, which batch-writes every approved column's mappings and then flips `paused → active`. The deferral is what makes the multi-column wizard coherent: nothing is committed until the user has reviewed every column and confirmed.
- `/home` activation card → **Begin Pipeline Standardization** → `paused → active` (poller takes over). Resuming (`PATCH status='active'`) clears `status_message`.
- `pending_baseline` cards in `PipelinesView` have their own "Create initial standardizations" button (rebuilds the review run). The one-shot `/api/pipelines/setup` route **no longer exists** (verified 2026-07-24 — `POST /api/pipelines` is the only warehouse-pipeline create path, which is what makes the column-mode consent gate airtight).
- **Card-visibility rule (don't hide a live pipeline):** `PipelinesView` hides a card while its export is still being set up for the first time — but only when the export has **no** live (active/paused) column. Compute `exportsWithLiveColumn` first; an export is hidden only if every one of its columns is `pending_baseline`. Adding a column to an already-live pipeline creates a `pending_baseline` row sharing that export, so a naive "hide if any column is pending_baseline" wrongly hides the live pipeline → a "blank pipeline page" while the new column's baseline run builds. Do not reintroduce that.
- **Pipelines tab empty states:** Two distinct cases — (1) `pipelines.length === 0` → "No pipelines yet" with a prompt to use Connect tab; (2) pipelines exist but ALL are hidden by card-visibility (every pipeline is `pending_baseline` with no live sibling) → "Pipeline setup not complete" message directing to the Connect tab.
- **Incomplete pipeline cards (Connect tab):** When a user has `pending_baseline` pipelines they created (`created_by === accountId`), the Connect tab shows cards below the form with an "Incomplete" badge, table name, column info, a "Continue" button (POST to `create-initial-run` → navigate to `/run/{run_id}`), and an X button to DELETE the pipeline. Grouped by `table_fqn` so multi-column setups show as one card. Only visible to the pipeline's creator — admins don't see other users' incomplete setups here. Does NOT affect one-time standardizations (those use `RUNS` with `run_type='one_time'`, not `PIPELINES`).
- **Add a column to an existing pipeline:** the `+` on a table card opens `AddColumnModal`; each chosen column gets its own spec via the inline `ColumnSpecField`, is created `pending_baseline` (sharing the table's export + update schedule), then the review wizard opens for it.

### Multi-Column Sheets Wizard

`POST /api/pipelines/file` for Sheets returns `{ pipeline_id, run_ids, column_names }` — ONE `pipeline_id` shared by all columns, one `run_id` per column. `FilePipelineConnectForm` stores `{ kind: 'create', pids: runIds.map(() => pipelineId), cols: colNames, runs: runIds }` in `sessionStorage` under `prism_ae_col_wizard` and navigates to the first run.

`RunReviewClient` reads the wizard key. For each column in sequence, the user reviews and clicks "Accept Standardizations". The export route (`POST /api/run/[run_id]/export` with `defer: true`) marks the run `approved` without writing to `LITERAL_ALIAS_MATCHES`. The wizard advances to the next column's run. After the last column, the activation card appears, and "Begin Pipeline Standardization" calls `POST /api/pipelines/[id]/commit-standardizations` to batch-write all approved columns' mappings, then advances the pipeline to `paused → active`.

The pipeline lookup in the deferred export path matches by `table_fqn` only for `source_type = 'sheets'` (not `column_name`), because all columns share one pipeline row whose `column_name` is only the first column.

Single-column Sheets pipelines skip the multi-column WIZARD (`runIds.length === 1` — no column-to-column advance, no `prism_ae_col_wizard` key), but they still use the **deferred** export path like every other pipeline-mode run. Corrected 2026-08-09 (FILE-05): this said "standard non-deferred export path", which stopped being true when `isAutoExport` became a hardcoded `true` for the single-tier product — `doAcceptStandardizations` now sends `defer: true` unconditionally, so Accept marks the run `'approved'` and the lookup write happens at Begin Pipeline Standardization via `commit-standardizations`. Skipping the wizard and deferring the write are independent things; only the first is conditional on column count.

### Dedicated Warehouse (`PRISM_WH`)
- `01_internal_tables.sql` creates `PRISM_WH` (XSMALL, `AUTO_SUSPEND = 60`, `AUTO_RESUME`, `INITIALLY_SUSPENDED`, `STATEMENT_TIMEOUT_IN_SECONDS = 600`) with `IF NOT EXISTS`, so re-running the script never clobbers an installer's resize — change settings via `ALTER WAREHOUSE`. `USAGE, OPERATE` granted to `PRISM_SERVICE`; `USAGE` to `PRISM_DATA_ADMIN`.
- Rationale: Prism runs on its own warehouse so its compute cost is isolated/attributable and auto-suspend tuning never touches the customer's other workloads. Clients *can* point Prism at their own warehouse (env var or Settings) — that's the escape hatch, not the default.
- `grants.ts` includes the same `CREATE WAREHOUSE` + grants; `CREATE WAREHOUSE` is an account-level privilege, so on non-ACCOUNTADMIN saves it fails gracefully (recorded in the grants result, like other elevated grants).
- The Settings "Test connection" verifies the warehouse exists (connecting with a nonexistent warehouse succeeds — it's only a session default) and returns a `warning` when `AUTO_SUSPEND` is missing/0 (never suspends) or > 60s.

### Snowflake Cost Model (why the poller is shaped this way)

How warehouse billing actually works, and the rules it imposes on this codebase:

- **Compute credits bill by warehouse-awake-time, not per query.** Per-second billing with a **60-second minimum every time a suspended warehouse resumes**; after that the warehouse keeps billing until `AUTO_SUSPEND` fires. So a 400 ms query against a suspended warehouse costs a full minute — and any recurring query spaced closer together than `AUTO_SUSPEND` keeps the warehouse resumed 24/7, billing for all the idle gap-time. Cost ∝ hours-awake × size (each size tier ≈ doubles credits/hour), never query count.
- **Metadata-layer operations are free; `INFORMATION_SCHEMA` SELECTs are not.** `SHOW` / `DESCRIBE` / `SYSTEM$STREAM_HAS_DATA` / `CREATE STREAM IF NOT EXISTS` run in the cloud-services layer — they never wake a warehouse (cloud services is only billed above 10% of daily compute; these never get close). A `SELECT` against an `INFORMATION_SCHEMA` view **does** require and wake a warehouse. **Rule: recurring/background code paths must use metadata-layer commands, never `INFORMATION_SCHEMA` SELECTs.** One-shot user-action paths (run creation, one-time flow, export) may use `INFORMATION_SCHEMA` — the warehouse is doing real work then anyway.
- **Incident that produced this rule (Jun/Jul 2026):** `checkSourceHealth`'s original `SELECT … FROM INFORMATION_SCHEMA.COLUMNS` was the account's single most expensive query (16.7 credits / 5,288 executions in one month — more than all real standardization work combined). Cause: forced every-30s re-checks on flagged/erroring pipelines during dev testing kept warehouses permanently resumed; part of it also ran on `COMPUTE_WH`, whose **default `AUTO_SUSPEND` is 10 minutes**, so each wake bought up to 10 min of billed idle. Fixed 2026-07-08: `SHOW COLUMNS` swap + exponential re-check backoff (see Poller Cost & Failure Backoff / Pipeline Health Guards).
- **"The customer's warehouse is awake anyway" is never a valid assumption.** Prism runs on its own `PRISM_WH` precisely so its cost is isolated and attributable — which also means customer activity on their warehouses never keeps `PRISM_WH` warm; every `PRISM_WH` wake is Prism's bill. And real customer warehouses suspend nights/weekends, so a 24/7 background toucher would multiply, not piggyback on, their costs. This is why idle-cycle discipline exists: a no-new-data poll cycle must not wake `PRISM_WH` at all — the steady-state for a quiet source is a suspended warehouse costing zero.
  **DECISION (2026-08-09, owner): the sweep stays HOURLY for every schedule.**
  An adaptive back-off (hourly while it finds values, decaying once it doesn't)
  was offered and declined. Rationale for keeping it: the sweep is the only
  mechanism that can find the PRE-EXISTING distinct tail beyond the baseline's
  `LIMIT 5000` — those rows are not changes, so no stream will ever emit them,
  and the 10-minute tick only ever reads `PIPELINE_QUEUE` and cannot discover
  anything on its own. Predictable hourly behaviour was judged worth ~4
  credits/month. Do NOT "optimise" this without revisiting that decision.

  **Qualification (2026-08-09, DET-S07/DET-M08):** that guarantee holds for the minute-mark POLLER and the 10-minute TICK on every schedule. It does NOT hold for the top-of-hour reconciliation sweep on pipelines whose schedule is `always` or `manual`: `fetchAllActivePipelines` deliberately skips only explicitly-stored `window` schedules that are currently closed, so an `always`/`manual` pipeline gets an hourly source scan + export rebuild that resumes `PRISM_WH` — roughly 8 wakes over an 8-hour night, each billing the 60-second minimum. That is a conscious trade, not an oversight: the sweep is the only automatic recovery from a mass event (TRUNCATE, bulk reload, Time-Travel restore), and a `manual` pipeline has no other automatic path at all. A window-scheduled pipeline — the creation default — genuinely does cost zero overnight. State the guarantee to customers with that qualification rather than flatly.
- **Operator notes:** keep `AUTO_SUSPEND = 60` on any warehouse Prism uses (`SHOW WAREHOUSES` to verify — `01` uses `IF NOT EXISTS` and won't re-apply settings to an existing warehouse; on dev accounts also `ALTER WAREHOUSE COMPUTE_WH SET AUTO_SUSPEND = 60` since worksheets default to it). Non-warehouse lines on a Snowflake bill (Trust Center serverless scanners, compute pools, cloud services) are **not** Prism — Prism only ever uses virtual warehouses. (Trust Center's "Security Essentials" package is mandatory but its scheduled runs are free; the billed one is the optional "Threat Intelligence" package.)

### Grants (`01_internal_tables.sql` — ROLES AND GRANTS block)
- All roles and grants are consolidated in `01_internal_tables.sql` (bottom section). A single `snowsql -f 01_internal_tables.sql` is sufficient for a fresh install — no separate grants file.
- The same grant statements are executed programmatically via `app/api/_lib/grants.ts` (`buildGrantStatements` / `applyGrants`) in two places: (1) when a user saves Snowflake credentials via Settings, and (2) automatically when a new account is created (Google OAuth callback Cases 2 and 3).
- `PRISM_SERVICE` = the app **service** role (full write — it writes mappings during standardization).
- `PRISM_DATA_ADMIN` = a separate **human-only** role, the ONLY other role granted write on `LITERAL_ALIAS_MATCHES` / `APPROVED_ALIAS_NAMES` / `PIPELINES` (for manual SQL maintenance). Non-admin roles get no write on `INTERNAL`. Snowflake doesn't enforce CHECK/PK/FK/UNIQUE, so grants are the guardrail; read paths tolerate orphans and a rebuild self-heals.

### Identifier & String Safety
- `isSimpleIdent` (poller, hourly processor, and the `auto-export/source`, `runs`, `auto-export/poll` routes) is **permissive**: any non-empty name `quoteIdent` can safely wrap is allowed (spaces, hyphens, leading digits, Unicode letters), rejecting only control chars and `" ' \`. Every identifier is wrapped in `quoteIdent` before SQL interpolation.
- `sqlStringLiteral()` in `normalize.ts` escapes backslashes + single quotes for column names interpolated into `column_data['...']` VARIANT paths (used at 4 sites: `export-table.ts`, `op-file-pipeline.ts` ×2 conceptually, `pipeline-poller.ts`). Use it for ANY string literal built into SQL text.
- The lookup-export route parses and quotes user-supplied target FQNs part-by-part and **refuses `PRISM_DB.INTERNAL` targets** (users cannot overwrite internal tables via export).

---

## Snowflake SQL Constraints

- **`PARSE_JSON(?)` is invalid in `VALUES` clauses.** Snowflake does not allow function calls around bind parameters inside VALUES. Use the `SELECT column1, column2, PARSE_JSON(column3) FROM VALUES (?, ?, ?)` pattern instead. This applies to `insertFileRows` and `refreshSheetsFileRows` in `op-file-pipeline.ts`.
- **Explicit transactions needed for multi-statement atomicity.** Snowflake auto-commits each statement by default. Wrap `DELETE` + `INSERT` (e.g. `refreshSheetsFileRows` replacing `PIPELINE_FILE_ROWS`) in explicit `BEGIN` / `COMMIT` / `ROLLBACK` to prevent a crash between statements from leaving the table empty.
- **Duplicate MERGE source keys error.** Snowflake rejects a MERGE whose source has duplicate join keys — bulk upserts must dedup their source rows first (done on `normalizeLiteral` in `op-export.ts`).

---

## Deferred / Open Items

- **⚠️ Column output mode never live-tested:** the entire `export_kind='column'` path (companion-column sync on both warehouses, consent-time provisioning via creator credentials, guardrail behavior, stream-echo settling) plus the view repair path exist only as passing builds/parity tests. **docs/PRELAUNCH_CHECKLIST.md §1 is the mandatory live-warehouse protocol** — run it before any customer touches column mode. See also PRODUCT_DECISIONS.md → "Pipeline Output Modes & Source-Table Writes".
- **`POLICY_REFERENCES` identifier quoting — FIXED 2026-08-07.** `checkSourceHealth` used to build `REF_ENTITY_NAME` as an unquoted string. Snowflake resolves that as an identifier, so it was **case-folded to upper case before lookup**: any source table whose real name was not already all-upper-case failed to resolve and masking/row-access policy detection was silently skipped for it (console.warn only — no pause, no `status_message`, no flag). This entry previously blamed **spaces**; that was wrong and far too narrow. Live-reproduced both ways: an ALL-CAPS name *containing a space* resolved fine, while a mixed-case name with *no space* did not. The parts are now wrapped in `quoteIdent` (and the whole thing escaped with `sqlStringLiteral`), matching the `SHOW COLUMNS` call in the same function.
- **FQN parsing loses a boundary space:** `parseFqn` trims the whole FQN string and preserves each part verbatim, so interior spaces (`DB.S.MY TABLE`, or a space after a separator) survive — but a table whose real name *ends* in a space, or a database whose name *starts* with one, still loses that character, because it is indistinguishable from copy-paste whitespace at the string boundary. Live-reproduced (DET-S10). The failure is benign now (a genuine not-found, not a mangled name blamed on the customer), but a proper fix means accepting quoted FQNs (`DB.S."TBL "`) through every warehouse path.
- **Legal pages:** `/terms` and `/privacy` carry placeholder legal text pending counsel review — including echoing the column-mode no-liability wording that currently lives only in the connect form's warning panel.
- **File-pipeline distinct read is uncapped:** `readFileDistinctValues` reads every distinct value from `PIPELINE_FILE_ROWS` — a huge CSV builds one monster standardization run (no longer *fails* post-batching; merge degrades gracefully) but should get the same 5k installment treatment as the queue drain.
- **One-time partial-creation orphans:** the create route builds runs column-by-column; if a later column trips the 20k cap (or any error), earlier columns' working runs remain as invisible orphan rows in `runs`. Fix = pre-scan all columns' distinct counts before creating any runs.
- **Run page uppercase-prop latent bug:** `run/[run_id]/page.tsx` reads `runData?.RUN_STATUS` / `SOURCE_RELATION` (uppercase) but `getRunHeader` returns lowercase keys, so `initialRunStatus`/`sourceRelation` props have always been `undefined` (the client fetches everything itself, so no visible breakage). Fixing it would suddenly activate never-run `initialRunStatus` code paths — do it deliberately, not as a drive-by. The convention/rules fields added 2026-07-10 use lowercase keys and work.
- **`needs_review` evaporates at export:** the flag lives only in the run state blob; once auto-mode self-maps are written to `LITERAL_ALIAS_MATCHES`, nothing durable marks the review debt. Candidate fix (pairs with the mapping-editor backlog item): a `needs_review`/`reviewed_at` column on the lookup, set from the group flag at export.
- **Review UI is unvirtualized:** all groups render; sluggish in the low thousands of groups — the practical review ceiling, distinct from any processing limit.
- **Non-Anthropic AI providers untested:** the OpenAI / Gemini paths (and grouping quality on non-Claude models — prompts were tuned on Claude) have never run end-to-end against a production-tier account. Test before any customer picks them, or hide the untested cards in `/setup` step 4. See memory note llm-provider-testing-needed.
- **No per-workspace LLM usage rollup:** token usage is recorded per run (`llm_usage` in run state) but never aggregated. Needed if "Prism-provided AI" (vendor key) becomes the standard offering — a usage section in `/settings` beats reconciling from the Anthropic console.
- **"AI included" setup copy:** when the LLM key source is env (vendor-provided), `/setup` step 4's note reads "already configured on the server" — could instead say "AI is included with your Prism installation" to make Prism-provided AI feel like a product feature. Approved idea, not yet built.
- **`PRISM_FRESH_SETUP` currently left `true` in the local dev `.env.local`** (added 2026-07-12 for the fresh-customer walkthrough) — remove the two TEMP lines and restart to restore normal env-aware behavior.

---

## Performance Targets

- Auto Group to UI results: under 10 seconds for most runs
- LLM chunks run fully in parallel; wall time = slowest single chunk (~3–5 s)
- Hash lookup eliminates LLM calls for all previously seen values
- Blob read/write: one Snowflake query per page load, one per sync interval

---

## Key Invariants

- Lookup group alias names always win over LLM-proposed names in a merge (matched on `normalizeLiteral(name)`)
- Spec **standardization rules override the same-entity grouping default** — a rule may direct grouping related-but-distinct entities, and both the chunk and merge prompts state the precedence explicitly
- The column spec is locked at run creation — cannot be changed after
- Ungrouped items are never written to `LITERAL_ALIAS_MATCHES` (and auto-group leaves nothing ungrouped: unplaceable values become convention-compliant `needs_review` self-map singletons)
- Export is user-first and fail-open: the validation referee reverts a user change only when extremely confident it's a mistake, defaults to the user on missing/malformed verdicts, and its total failure writes the user's decisions untouched (`validation_status: 'failed'` in the blob) — it never blocks or loses an export
- The initial standardization is trusted: user moves away from a high-confidence initial LLM group are refereed (Case C), just as moves away from confirmed lookups are (Case A); renames of `llm_proposed` groups are the user's prerogative and never refereed
- State blob (warehouse `INTERNAL.RUN_STATE`) is the sole source of truth for a run's final state at export time; concurrent writers are serialized by the blob's `rev`. Customer VALUES never rest in SQLite (data-residency rule): state blobs, the validation log, and one-time mappings are warehouse-side
- `LITERAL_ALIAS_MATCHES` stores `alias_id` FK (not `alias_name` directly), every write sets `normalized_value`, and there is at most one row per `(normalized_value, spec)` — writers must dedupe on the normalized form
- LLM failures degrade honestly — `'llm_failed'` / confidence `'l'` / `needs_review`, never a fabricated high-confidence group
- Scale limits defer or refuse loudly, never drop silently (see Scale & Input Limits)
- One-time runs (`run_type='one_time'`) never touch the shared lookup

---

## Server-Side Library (`stand-ui/app/api/_lib/`)

| File | Responsibility |
|---|---|
| `warehouse/` | **The warehouse adapter layer** (Phase 1 of the SQL Server port — `docs/MSSQL_PORT_PLAN.md`). `warehouse/index.ts` is the facade every consumer imports: `withWarehouse` (service connection), `withUserWarehouse` (personal credentials), `executeQuery` (the one shared statement runner — do NOT write local `exec()` helpers), `isWarehouseAccessError`, `warehouseErrorResponse`, `serviceConnectionSource`, `getWarehouseAdapter`. `warehouse/types.ts` is the `WarehouseAdapter` contract; `warehouse/snowflake/connection.ts` is the Snowflake implementation (the old `snowflake.ts`, relocated) — the ONLY place allowed to import `snowflake-sdk` (lint-enforced via `no-restricted-imports`). Setup surfaces import their warehouse's connection module directly: Snowflake (`test-snowflake`, `workspace-snowflake`, `snowflake-config`, `verify-install`, `grants.ts`) ← `warehouse/snowflake/connection`; SQL Server (`workspace-mssql`, `mssql-config`, `warehouse-type`) ← `warehouse/mssql/connection` (`withAdHocMssql`, workspace/personal config helpers). The platform choice lives in `workspace_config.warehouse_type` (migration 010); the resolved kind comes from `getWarehouseAdapter().kind`. **Decision test for new code:** touches SQL, change detection, exports, grants, or normalization → it's an adapter-level change; once the mssql adapter exists (Phase 3+), implement it for every warehouse before it ships. Per-operation implementations + quirks live in `docs/WAREHOUSES.md` (update it in the same PR); follow the `.claude/skills/warehouse-change` checklist for any such change. |
| `env.ts` | `getOptionalEnv` + `isFreshSetupSim` — pure env reads shared across server modules (moved out of the old `snowflake.ts`). |
| `session.ts` | HMAC-signed cookie encode/decode (`prism_session`) — payload carries `v` (session version) + `exp` (7 days); `sanitizeReturnTo`; `Secure` in production. |
| `account-security.ts` | Session revocation: `requireAdminSession` / `requireValidSession` / `bumpSessionVersion` — checks cookie `v` against SQLite `accounts.session_version` on every request (no cache; instant revocation). |
| `sqlite.ts` | Local app-state database (better-sqlite3, WAL). `getDb()` singleton (hot-reload-safe via `global`), append-only migrations keyed on `PRAGMA user_version` — pending migrations are ALSO applied when a hot-reloaded module reuses the cached global handle, so a long-running dev server picks up migrations written after it booted (previously it executed new query code against the old schema — "no such column"). Holds `accounts`, `invitations`, `column_specs`, `one_time_standardizations`, run/pipeline metadata — never customer values (migration 015 dropped `validation_log` and NULLed `runs.state` / ots `mappings`; those live warehouse-side). File at `PRISM_SQLITE_PATH` (default `./data/prism.db`). |
| `crypto.ts` | App-level AES-256-GCM secret encryption (`encryptSecret` / `decryptSecret`), key from `PRISM_ENCRYPTION_KEY`, `enc:v1:` format; plaintext passthrough for unmigrated values; malformed key throws. |
| `anthropic-key.ts` | AI-provider resolution: `getLlmProviderConfig()` (workspace `workspace_llm_config` row → env `ANTHROPIC_API_KEY` fallback, 10 s cache, `invalidateAnthropicKeyCache()`), `getAnthropicApiKey()` (active credential — historical name), `anthropicKeySource()`, `asLlmProvider()`. Decrypt failure logs + falls through to env, never throws. |
| `report-error.ts` | Central error reporting: always `console.error`, forwards to Sentry when a DSN is configured, never throws. Deliberately importable from client AND server. |
| `run-header.ts` | `getRunHeader` — direct server-side run-header query used by the run page server component (no self-HTTP fetch of its own API). LEFT JOINs `column_specs` (on `spec_id = runs.domain_id`) to carry the spec's column name, `standardization_rules`, and convention fields for the review UI's rename guard + rules panel. |
| `pipeline-broadcaster.ts` | In-process Node `EventEmitter` on `global` for SSE push to the UI. Survives hot-reloads. Event types include `alert` (banner/toast). |
| `pipeline-coordination.ts` | Per-pipeline lock tracking — prevents concurrent standardization runs on same pipeline. The lock map lives on `globalThis` (`__prismStandardizingSince`, pipeline_id → started-at ms) — module-local state once stranded a leaked lock across dev-bundle instances and the poller silently skipped that pipeline forever (no stream ever created, no values queued). Locks self-expire after 30 min (`STANDARDIZING_MAX_MS`) as a leak safety valve; the poller logs each standardizing skip. |
| `pipeline-alerts.ts` | Pause/resume + alert helpers: `pausePipelineWithMessage`, `clearPipelineStatusMessage`, `flagPipelineMessage`, `broadcastGlobalAlert`, `broadcastPipelineAlert`. Writes `PIPELINES.status_message` and emits SSE `alert` events. |
| `normalize.ts` | `normalizeLiteral()` — pure TS mirror of the `PRISM_NORMALIZE` SQL UDF (NFC → strip control chars → collapse/trim whitespace → lowercase); keep in sync with the UDF + stored `normalized_value` column. Also `sqlStringLiteral()` for safe string-literal interpolation. (No `server-only` — pure.) |
| `pipeline-poller.ts` | Minute-mark poll passes (wall-clock-aligned) for ALL active pipelines (warehouse tables and file-based). On mssql installs, live-table pipelines dispatch to `pipeline-poller-mssql.ts` inside pollOneTable (same result contract). (Snowflake and file-based) — detect + queue ONLY, never standardizes. Snowflake path: throttled `checkSourceHealth`, stream classify (list A/B/deletes — informational), queue ALL new values (lookup hits included — consistent-snapshot export), hygiene rebuilds (deletes/null inserts) at most once per table per cycle. File-based path: `pollOneFilePipeline`. `fetchActivePipelines` cached 10 s. `PipelineRef` carries `source_type` and the parsed `update_schedule` so the two paths never cross. |
| `pipeline-poller-mssql.ts` | SQL Server poll orchestration (port Phase 4): per-pipeline detection state (SQLite `pipelines.detection_mode`/`detection_state`, migration 009), Change Tracking consumption or tiered diff scans via `warehouse/mssql/detection.ts`, health cadence (first poll / after errors / every 10th pass), pause/flag semantics, freshness stamping. Detect-and-queue ONLY (like the Snowflake poller); the 10-minute tick standardizes mssql queues through the ported write path (`warehouse/mssql/mappings.ts`) and export builder (`warehouse/mssql/export.ts` — staging-join, transactional swap, grants re-applied; `export_kind` 'view' is refused on mssql). |
| `pipeline-poller-postgres.ts` | PostgreSQL poll orchestration (docs/POSTGRES_PORT_PLAN.md P2): diff-scan-only detection via `warehouse/postgres/detection.ts`, gated by the free `pg_stat_user_tables` write-counter heartbeat (no grant needed; its delete counter flags hygiene rebuilds the same cycle — something mssql diff mode can't see). Same health cadence/pause/flag/freshness semantics as the mssql orchestrator; RLS on the source = the masking analog (`policy_blocked`). Writers: `warehouse/postgres/mappings.ts` (ON CONFLICT upserts), builder `warehouse/postgres/export.ts` (staging join, transactional swap, ACL re-apply; view kind SUPPORTED via persistent mapping tables; column kind guarded). |
| `warehouse-tables.ts` | `internalTable(name)` — internal data-plane table references that work on every warehouse: Snowflake AND mssql resolve `PRISM_DB.INTERNAL.<NAME>` verbatim; Postgres (schema) AND MySQL (database) get `prism_internal.<lowercase>`. Shared SQL must use this instead of hardcoding the 3-part form. |
| `pipeline-poller-mysql.ts` | MySQL poll orchestration (docs/MYSQL_PORT_PLAN.md M2): diff-scan-only detection via `warehouse/mysql/detection.ts`, gated by the `information_schema.TABLES.UPDATE_TIME` heartbeat (fresh via per-session `information_schema_stats_expiry=0` — the 24h default would blind it; delete-BLIND, hourly rebuild covers). Writers `warehouse/mysql/mappings.ts` (row-alias ON DUPLICATE KEY), builder `warehouse/mysql/export.ts` (atomic multi-RENAME swap, verbatim 'user'@'host' grant replay, view kind via persistent maps, column kind guarded). |
| `update-schedule.ts` | Update time windows (pure module, shared with the client): `UpdateSchedule` type (`window`/`always`/`manual`), `DEFAULT_UPDATE_SCHEDULE` (Mon–Fri 9–5), `asUpdateSchedule` (strict API validation), `parseStoredSchedule` (tolerant, defaults), `isScheduleActiveNow` (Intl-based timezone evaluation), `scheduleLabel`. |
| `op-file-pipeline.ts` | File-based pipeline helpers. `readAllSheetRows` (paginated 10k-row reads, throws `SheetTooLargeError` past `MAX_SHEET_ROWS=100k` — poller pauses the pipeline, creation route rolls back + 400s), `a1Sheet` (A1 tab-name escaping), `syncSheetsColumn` (non-destructive full output-tab rewrite), `refreshSheetsFileRows`, `insertFileRows` / `readFileDistinctValues`, `readFilePipelineRowsForDownload`. |
| `pipeline-hourly-processor.ts` | The 10-minute standardization tick (`startQueueProcessor` — wall-clock-aligned, drains ANY non-empty queue for window-open pipelines; top-of-hour tick also runs the reconciliation sweep + safety export rebuilds) + on-demand `processPipelineQueue`. `fetchQueueLiteralsWithFreq` drains the queue in 5,000-value FIFO installments. Failure backoff + auto-pause after 5 consecutive failures; retries reuse the pending run (`hourly_<pid>_` nonce, historical prefix). Exports `bulkProcessPipelineQueue` for initial baseline imports. (Filename is historical — it's the tick processor now.) |
| `op-auto-group.ts` | State-blob types (`OpRunState`, `OpGroup`, …) + load/save helpers (including the rev-checked save) — ~100 lines, nothing else. Live auto-grouping is `op-auto-group-run.ts` → `llm-one-prompt-grouping.ts`. |
| `op-auto-group-run.ts` | Live auto-grouping: normalized literal lookup → lookup groups → `runOnePromptGrouping` for unmatched → assemble state. Builds the existing-names list (lookup hits + in-run group names + top-200 + retrieval slice), makes self-map singleton names convention-compliant (`applyConventionRules` + `fixNamesForConvention`), stamps `initial_*` on LLM-grouped items (Case C baseline), honest `'llm_failed'` fallbacks for failed chunks. |
| `llm-one-prompt-grouping.ts` | LLM grouping + merge calls (`claude-sonnet-4-6`, env-overridable). Sorted boundary-aware chunking (`sortAndChunkItems`), diverse merge reps (`pickDiverseReps`), retries (2× backoff on 429/5xx, 1× on parse failure), prompt caching (`cache_control` on the canonical-names system block), JSON-escaped literals, proposed-name validation, merge `max_tokens: 8000`. Exports `callAnthropicWithRetry` / `JSON_ONLY_REMINDER` / `fixNamesForConvention` for reuse. |
| `grouping-types.ts` | Shared grouping types (`RunItemForPairing`, `FinalGroup`, …) — the only survivors of the deleted deterministic pipeline. |
| `op-export.ts` | User-first fail-open export: reads state blob, detects Case A/B/C, runs the validation referee (spec-context prompt, extreme-confidence bar, retries; failure → proceed with user's decisions + `validation_status: 'failed'`), then **writes everything in one pass** (batched idempotent MERGEs at `EXPORT_MERGE_BATCH=5000`, deduped on `normalizeLiteral`, sets `normalized_value`), marks run `'completed'`. |
| `op-one-time.ts` | One-time standardization engine: lookup-free LLM grouping, optional naming convention, export to a standalone table, archive to `ONE_TIME_STANDARDIZATIONS`. |
| `file-inplace.ts` | Edit-in-place file patcher for one-time CSV/XLSX exports (pure, parity-tested): byte-span CSV tokenizer + zip-level XLSX surgery (fflate) that replaces ONLY the standardized cells, leaving every other byte of the customer's original file intact (hidden columns, styles, column order). ANY patch failure falls back to the legacy regenerated `{headers, rows}` export — never a corrupted "original". |
| `convention-rules.ts` | Structured naming-convention rules for a column spec — prompt instructions + deterministic normalization of LLM output. Pure module shared by UI and server. |
| `namescore.ts` | NameScore — deterministic "most representative literal" scoring, used as the fallback group namer. Derives cleaned value + token arrays from the raw literal when callers pass empties (live callers no longer carry the deleted pipeline's precomputed fields). |
| `export-table.ts` | Rebuilds the pipeline's optional export Snowflake table/view (`CREATE OR REPLACE … COPY GRANTS AS SELECT`). Joins stored `normalized_value` vs `PRISM_NORMALIZE(source)`. Table builds are physically sorted to mirror the source when it has a PK / unique key / clustering key (`resolveSourceOrdering`); otherwise unordered — no synthetic order column. Also hosts `refreshStandardizedColumnsSnowflake` (export_kind `'column'` — guarded UPDATEs onto the source table, see Standardized-Column Output) and dispatches all kinds (incl. the mssql implementations) from `refreshExportTable`. Refuses a table/view destination equal to the source table. |
| `export-kind.ts` | Pure module (shared with the client): `ExportKind` type, `asExportKind()` (the ONLY sanctioned way to parse a stored/POSTed export_kind), `standardizedColumnName()` (`<col>_STANDARDIZED` — the one place the companion-column name is defined). Parity-tested. |
| `grants.ts` | `buildGrantStatements` / `applyGrants` — programmatic role grants (Settings save + OAuth account creation). Account-level CREATE ROLE/WAREHOUSE statements are pre-checked via SHOW ROLES/WAREHOUSES and reported `skipped` when the object already exists (script-first installs show green, not failures). |
| `email.ts` | SMTP invitation emails. |
| `timing.ts` | `appendTiming` — phase-timing instrumentation to console + log file (`PRISM_TIMING_LOG`, default `/tmp/prism-timing.log`). |
| `redis.ts` | Optional ioredis singleton; returns `null` when `REDIS_URL` is unset. |
| `auto-export-seen.ts` | Redis-backed baseline tracking — records which values existed at pipeline setup to avoid reprocessing. |

### Background Startup (`instrumentation.ts`)

Next.js `register()` hook fires once on server start, initializes Sentry (server config), and calls:
- `startPoller()` — one clock-aligned poll pass at every minute mark (self-chaining; all active tables polled concurrently per pass)
- `startQueueProcessor()` — the standardization tick at every 10-minute wall-clock mark (top-of-hour tick also reconciles)

Both are guarded with `global.__*Started` flags to prevent duplicate intervals on Next.js hot-reloads. Neither is gated behind any mode/tier flag.

> ⚠️ **Poller/background code changes need a full dev-server restart.** Because `startPoller()` runs once (guarded by `global.__pipelinePollerStarted`) and its loops are already-scheduled closures, Next.js hot-reload does **not** replace the running poller — your edits to `pipeline-poller.ts` / `instrumentation.ts`-started code won't take effect until you stop and restart `npm run dev`. This has repeatedly masked otherwise-correct fixes; always remind the user to restart after such changes.

### SSE Real-Time Updates

`GET /api/pipeline-events` is a Server-Sent Events endpoint. The poller and processor broadcast events (`metrics_updated`, `scanning_started`, `scanning_finished`, `standardizing_started`, `standardizing_finished`, and `alert`) via `pipeline-broadcaster.ts`. The SSE route forwards all event types generically. `alert` carries `{ level: 'error'|'warning'|'info', scope: 'global'|'pipeline', message, pipeline_id?, ttl_ms? }` — `ttl_ms` tells the UI to auto-dismiss; persistent pause reasons live on `PIPELINES.status_message`. The UI reconnects automatically on close.

---

## Pipeline Detail UI (`stand-ui/app/home/PipelineDetail.tsx`)

### Activity Status (polling ring REMOVED 2026-07-13)

The old `RefreshRing` 30-second countdown ring, the "refreshes every 30s / Next refresh in Ns" copy, and the teal "Checking for new values" scanning state are **gone from the UI** (removed with the move to 10-minute-tick standardization). Do not reintroduce them. What remains:

- **ActivityTab live status**: a green pulse dot "Live · watching for new values" for active cards, replaced by an amber pulse "Standardizing data" while a standardization pass runs (`isStandardizing` prop — driven by SSE `standardizing_started`/`_finished`, which `beginStandardization`/`endStandardization` broadcast from every path: the 10-minute tick, the manual Auto-standardize, and initial baselines).
- **Collapsed card**: while standardizing, the "Standardized table last updated X ago" line under the schedule badge is replaced by an amber pulse "Standardizing…" (same `running` flag that drives the button's spinner), so the animation is visible without expanding the card.
- **Live timestamps without reload**: `fully_synced_at` re-renders via the SSE-driven `fetchPipelines()` refetches (`metrics_updated` fires every poll cycle and after every rebuild; `standardizing_finished` also refetches), and a 30 s `setClockTick` interval in `PipelinesView` re-renders relative labels even when no events land (paused pipelines).
- The backend still emits `scanning_started`/`_finished` each poll cycle; the client now ignores them (`scanningPipelines`/`cycleResetAt`/`markCycleReset` state was deleted). ONE freshness timestamp — **"Standardized table last updated"** (`fully_synced_at`) — replaces the earlier separate "Last updated"/"Last standardized" pair (user request 2026-07-13: a single timestamp meaning "source checked and everything standardized+exported, or nothing new"; renamed from "Last updated" the same day at the user's request). It sits at the TOP of the Activity tab (right-aligned next to the Live/Standardizing status; the old milestones list is gone — "Created" moved to a small hint at the bottom of the Settings tab) and on the collapsed row as "Standardized table last updated X ago" under the schedule badge.
- **Columns + specs tooltip**: the Activity tab's per-column breakdown (Column | Spec | Standardized) renders for EVERY card — single-column included. Next to each column sits an ⓘ (`SpecInfoIcon`, exported from `PipelinesView`) that opens on hover OR click (click pins; outside-click closes) a PORTALED fixed-position panel with the spec's description, standardization rules (parsed JSON array), and naming convention (structured rules + regex/examples/natural `convention_value`). Full spec records come from one `/api/column-specs` fetch in `PipelinesView` (`specsById` map → `PipelineDetail` prop). There is deliberately NO spec chip on the collapsed title row.

**Poll cadence: one clock-aligned pass at every minute mark** (2:33:00, 2:34:00, …). The pass fetches active pipelines fresh, groups by source table, and polls all tables concurrently; self-chaining (next mark computed after the pass completes) so passes never overlap, and a pass longer than a minute skips to the next mark. Newly activated pipelines are picked up at the next mark (≤ 60 s). All COLUMNS of a table poll together inside `pollOneTable` + `syncTableLastPolled` (one shared `last_polled_at`). The old per-table self-chaining loops + `superviseTables` supervisor existed only to phase-align the removed countdown ring — deleted 2026-07-13.

### Logo Navigation

The Prism logo (`app/layout.tsx`) links to `/home?tab=connect`. `AutoExportHome.tsx` reads `useSearchParams()` to respond to the `tab` param and switch tabs, so clicking the logo from any tab always navigates to Connect. `AutoExportHome` is wrapped in `<Suspense>` in `home/page.tsx` because `useSearchParams()` requires a Suspense boundary in the Next.js App Router.

### Portal Tooltips and Dropdowns

**Always use `createPortal` for any floating UI (tooltips, dropdowns, menus) that lives inside a card or panel.** Pipeline cards and column-picker rows use `overflow: hidden` which clips `position: absolute` children. Portal to `document.body` + `position: fixed` + `getBoundingClientRect()` is the required pattern.

- `DomainInfoTooltip` in `AutoExportHome.tsx` — hover tooltip, `pointerEvents: 'none'`
- "Update Standardizations" dropdown in `PipelinesView.tsx` — click dropdown using `stdTriggerRef` / `stdMenuRef` / `menuPos` state / `openStdMenu()` / click-outside handler via refs. Portaled with `position: 'fixed', top: menuPos.top, right: menuPos.right, zIndex: 9999, width: 220`
- `Toast.tsx` in `app/components/` — shared portaled toast notifications.

**Critical:** use `width: NNN` (exact), NOT `minWidth`. A portaled `position: fixed` element with only `minWidth` will stretch to the viewport width because the fixed-position stacking context has no `overflow: hidden` parent to constrain it.

---

## Export Lookup Table

Users can export the lookup table (`LITERAL_ALIAS_MATCHES` joined with `APPROVED_ALIAS_NAMES`) from two surfaces:

- **Pipeline cards** (`PipelinesView.tsx`) — "Lookup table" button (download icon) in the card toolbar. Opens `ExportLookupModal` with `columns` prop containing the card's columns. For multi-column pipelines, the modal shows a column picker so the user selects which spec's mappings to export.
- **Pipeline detail — Mappings tab** (`PipelineDetail.tsx`) — the same modal, pre-scoped to the open column's spec. (The old domain-library `StandardizationsView.tsx` page was deleted with the domains removal.)

### `ExportLookupModal` (`app/components/ExportLookupModal.tsx`)

Shared portaled modal (`createPortal` to `document.body`, z-index 60). Four format options in a 2x2 grid:

- **CSV** — client-side blob: fetches from `GET /api/global-standardizations?domain_id=N`, builds CSV string, triggers download
- **Excel** — client-side blob: same fetch, dynamic `import('xlsx')`, triggers `.xlsx` download
- **Google Sheets** — `POST /api/global-standardizations/export` with `{ format: 'sheets', domain_id, domain_name }`. Handles 401 → Google OAuth redirect. Opens the created sheet in a new tab.
- **Snowflake** — `POST /api/global-standardizations/export` with `{ format: 'snowflake', domain_id, domain_name, snowflakeTableFqn? }`. Shows an optional target table name input; default is `PRISM_DB.PUBLIC.<NAME>_LOOKUP` (mssql: `PRISM_DB.EXPORTS.*`). The route parses/quotes the user-supplied FQN part-by-part and refuses `PRISM_DB.INTERNAL` targets.

### `POST /api/global-standardizations/export` Extensions

The export route accepts optional `domain_id` and `domain_name` in the request body — **historical names: `domain_id` carries a spec_id** and filters the lookup to that spec; `domain_name` is the display name used for the Google Sheet title and the default warehouse table name.

---

## Settings, Debug & Top-Level Pages

The old `/admin` page is gone, split into:

- **Setup card (`/setup`)**: the OAuth callback sends **every** new account here (not just admins), gated by role client-side once the session resolves (a loading state prevents a flash of the wrong copy):
  - **Admins** see the **guided onboarding flow**: on load it tests the current service connection (`GET /api/accounts/test-snowflake` — now workspace-config-aware); if healthy, "Continue with existing connection" is the fast path (with links to "Verify the install" / "Set up a different connection"). Otherwise a 5-step flow: **(1)** warehouse-platform picker — Snowflake or Microsoft SQL Server; the choice persists to `workspace_config.warehouse_type` (`POST /api/accounts/warehouse-type`) and drives the adapter factory. Choosing SQL Server swaps steps 2/3/5 for their mssql variants (`StepInstallScriptMssql` serving `01_internal_tables.mssql.sql` + service-login/Change-Tracking templates; `StepCredentialsMssql` → `POST /api/accounts/workspace-mssql`, which live-tests before saving and asserts the platform choice; verify-install runs catalog-view probes). Non-admins on mssql installs get an mssql personal-credentials variant (`/api/accounts/mssql-config`); **(2)** display the install SQL (`GET /api/accounts/install-script` reads `00_bootstrap.sql` + `01_internal_tables.sql` from the repo root, one level above `process.cwd()`; graceful message if not shipped) plus templated key-pair `openssl` commands and a `CREATE USER PRISM_SVC … TYPE = SERVICE` + `ALTER USER … SET RSA_PUBLIC_KEY` block (the install scripts create roles but NOT the service user) — the admin runs all of it themselves in a Snowflake worksheet as ACCOUNTADMIN, so admin credentials are never typed into Prism. **Part D (added 2026-07-22)**: the admin types the DB.SCHEMA(s) holding their source tables and `buildDataAccessGrants` generates the copy-paste grants — USAGE on db+schema, SELECT on all/future tables, and CREATE TABLE + **CREATE VIEW** (the missing-CREATE-VIEW failure used to surface only at view-pipeline activation); the generated SQL grants **no write access on existing tables** and states so — "Column"-mode UPDATE is granted per table, case-by-case, at consent time (see SECURITY_AND_DISCLOSURES §1). The step's Continue button runs a **best-effort spot check** (`verify-install?scope=snowflake`, Anthropic probe skipped): no resolvable connection or a network failure → pass through silently (a fresh install has no credentials until the next step; step 5 is the authoritative gate); connected but install objects missing → red panel with the missing items + "Continue anyway"; **(3)** enter the service user's credentials — `POST /api/accounts/workspace-snowflake` (admin-only) connection-tests them and only then saves to `workspace_config` (encrypted; typing no secret keeps the stored one; `{clear:true}` reverts to env). **Env-adopt convenience:** the GET prefills every non-secret field from the saved row falling back to env, and a save with a BLANK secret adopts, in order, the saved secret → the env secret (`getEnvSnowflakeSecrets`) — secrets are never sent to the browser, only `has_env_secret` is; **(4)** AI-provider picker + credential — Claude (Anthropic, recommended), OpenAI (API key), or Gemini (Google AI Studio key); Prism pins the model per provider (GPT-4.1 / Gemini Flash). `POST /api/accounts/llm-provider` validates the credential live before saving (a blank Anthropic key adopts the env `ANTHROPIC_API_KEY`; no env path for the other providers; skippable when a provider already resolves); **(5)** verification checklist — `GET /api/accounts/verify-install` (admin-only) connects as the service user and runs **metadata-layer-only** Snowflake probes (`SHOW DATABASES/SCHEMAS/TABLES/USER FUNCTIONS/WAREHOUSES`, scalar `CURRENT_ROLE()`; never wakes a warehouse): role identity, database + schemas, the 6 internal tables (visibility ⇒ grants ran), `PRISM_NORMALIZE`, warehouse existence + `AUTO_SUSPEND` ≤ 60 warning, plus an Anthropic-key check (live `/v1/models` call; network failure ⇒ warning not red). Red items carry fix text ("re-run the script as ACCOUNTADMIN"); "Finish anyway" is allowed. The old admin path through `snowflake-config` + `applyGrants` remains available from `/settings`. **Setup gate on `/home`** (`app/home/page.tsx`, now a server component wrapping the client `AutoExportHome`): admins are redirected to `/setup?next=/home` while the workspace has no resolvable service connection OR no Anthropic key (`serviceConnectionSource()` / `anthropicKeySource()`); non-admins pass through (the personal `/setup` variant can't fix a workspace-level gap). Under `PRISM_FRESH_SETUP` the gate ignores env credentials, so the simulation stays consistent until the flow saves workspace rows.
  - **Regular users** see a distinct, explicitly optional personal-connection variant ("(optional)" tag in the heading, copy explaining it's only needed later for one-time standardizations Prism can't otherwise see) with a **"Skip for now"** button always available (not gated on env status, since it's irrelevant to them). Role/warehouse fields default empty instead of `PRISM_SERVICE`/`PRISM_WH` (those are the service identity's objects). Saving here calls the same `snowflake-config` POST but never triggers the grants pass (see below).
  - The account identifier is **prefilled from the workspace's saved config, falling back to the `SNOWFLAKE_ACCOUNT` env value** (`GET /api/accounts/test-snowflake` returns it) — there is one Snowflake account per workspace, so a member connecting personal credentials only ever needs to type their own username + credential, never the account.
  - `GET /api/accounts/test-snowflake` also returns `role` (`CURRENT_ROLE()` from a live connection) — a diagnostic surfaced in the admin banner ("...running as role X") for verifying the service connection is actually activating the intended role, not silently falling back to something else.
- **Test connection is credential-smart**: `POST /api/accounts/test-snowflake` falls back to the account's SAVED (encrypted) credentials when no secret is typed — decrypted server-side only; typed non-secret fields override saved ones. Saving without typing a secret keeps the stored secret (change warehouse/role without re-pasting the key).
- **`snowflake-config` POST is `requireValidSession` (not admin-only)** — any member may save credentials to their own account row. The grants-application pass only runs when `session.role === 'admin'`; a non-admin save returns `{ ok: true, grants: null }` immediately. See One-Time Standardization above for what personal credentials are used for.
- **`/settings`** (admin-role-gated via `requireAdminSession`; `UserMenu` shows the Settings item for admins only): three sections —
  1. **Snowflake connection** — status, test connection, save credentials (+ applies grants; some grants require ACCOUNTADMIN and must be run manually)
  2. **Team** — member list, role changes, remove member, invite link (last-admin/self-delete guards enforced by the members API)
  3. **Pipeline health** — rollup of all pipelines' status/`status_message`
- **`/debug`** (gated by `PRISM_DEBUG_TOOLS === 'true'`, otherwise `notFound()` → 404): table inspector for operators. `/api/admin/table/[tableName]` is gated identically. Never enabled in customer installs.
- **`/terms`** and **`/privacy`** — placeholder legal text (pending counsel review), linked from the login page.
- **`/`** redirects to `/home`.

---

## Observability

Sentry is wired via `instrumentation.ts` (server), `instrumentation-client.ts` (client), and `app/global-error.tsx` (root error boundary) — all env-gated by `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` and fully no-op when unset. Use the `reportError(err, context)` helper (`_lib/report-error.ts`) instead of bare `console.error` in new code: it always console-logs, forwards to Sentry when configured, and never throws.

---

## Deployment Model

- **Production instance:** prismmasterdata.com on a DigitalOcean droplet
  (167.99.235.20). Update with `deploy/deploy.sh <ip>` (rsync → `npm ci` →
  build → systemd restart; see `deploy/DEPLOY.md`). The script typechecks on
  the operator machine first and sets `PRISM_SKIP_BUILD_TYPECHECK` server-side
  (the 2 GB droplet OOM-kills the build's TS pass). The prod env carries NO
  warehouse or AI credentials — both are wizard-configured (workspace rows).
  Cloudflare DNS must stay **DNS-only, never proxied** (proxying breaks SSE
  and Caddy's TLS issuance). The Google OAuth app is published but unverified
  (consent screen shows the warning until verification).
- **The SQLite file (`PRISM_SQLITE_PATH`) must live on persistent storage** — losing it loses accounts, column specs, and run/pipeline metadata (never customer values: confirmed mappings, run state blobs, and the validation log are all in the customer's warehouse).
- **One long-lived Node process per installation is REQUIRED.** The poller loops, per-pipeline locks, and the SSE broadcaster are all in-process — serverless/multi-instance deployments break them. Deploy as a single persistent `next start` (or equivalent) process.
- **Single-tenant:** one deployment + one customer Snowflake account per company. There is no cross-tenant isolation inside the app.
- **`xlsx` is installed from `cdn.sheetjs.com`** (pinned `0.20.3` tarball in `package.json`) — `npm install` may need network access to that host.

---

## File/Folder Conventions

- All Snowflake-touching and secret-touching `_lib` files include `import 'server-only'` (`warehouse/index.ts`, `warehouse/snowflake/connection.ts`, `env.ts`, `crypto.ts`, `anthropic-key.ts`, `account-security.ts`, `op-auto-group.ts`, `op-auto-group-run.ts`, `op-export.ts`, `op-file-pipeline.ts`, `op-one-time.ts`, `export-table.ts`, `grants.ts`, `email.ts`, `redis.ts`, `auto-export-seen.ts`, `pipeline-broadcaster.ts`, `pipeline-coordination.ts`, `pipeline-alerts.ts`, `pipeline-hourly-processor.ts`, `run-header.ts`, `timing.ts`, `sqlite.ts`). Intentional exceptions: `normalize.ts`, `convention-rules.ts`, `grouping-types.ts`, `namescore.ts`, `update-schedule.ts` (pure modules shared with the client) and `report-error.ts` (deliberately client-safe); `warehouse/types.ts` is types-only (no server-only needed).
- API routes for run operations: `/api/run/[run_id]/...`
- Pipeline API routes: `/api/pipelines/...`; one-time routes: `/api/one-time/...`; member management: `/api/accounts/members...`
- Snowflake field names come back uppercase; normalise with `r.FIELD_NAME ?? r.field_name` pattern everywhere. **Coalesce BEFORE any null check** — `r.DOMAIN_ID != null ? Number(r.DOMAIN_ID) : null` silently returns null for every SQLite row (lowercase keys); this blanked `domain_id`/`created_by` across the UI until fixed in `row2pipeline` 2026-07-13. Correct form: `const raw = r.DOMAIN_ID ?? r.domain_id; raw != null ? Number(raw) : null`
- Shared UI components live in `app/components/` (`ColumnSpecEditor`, `ColumnSpecField`, `ExportLookupModal`, `Toast`, `RoleBadge`, `ConventionEditor`, `SpecChangeWarning`, `UserMenu`, `UpdateScheduleEditor`, plus the `spec-types.ts` `ColumnSpec` interface)
