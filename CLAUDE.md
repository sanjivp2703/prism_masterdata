# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

This file is the **index and the rules**. Deep detail lives in `docs/` and is read on
demand — see *Where to look* below. When you change behaviour described in a `docs/` file,
update that file in the same change.

## How to Communicate

Write responses in plain, understandable language while staying fully detailed. Don't
sacrifice completeness for brevity — instead, explain jargon the first time it's used, walk
through processes step by step in the order they actually happen, and say *why* something
works the way it does, not just *what* it does. Prefer "the app opens a fresh connection for
every request and closes it when done" over "no connection pool; per-request lifecycle."

---

## What This Project Is

Prism (also called "STAND" in legacy code) is a warehouse-native data standardization
platform — each installation runs on the customer's Snowflake, Microsoft SQL Server,
PostgreSQL, or MySQL (chosen once in the setup wizard; see the `warehouse/` adapter layer).
Snowflake is the original and most battle-tested backend. It maps inconsistent text values
from a source column (e.g. "att", "AT&T wireless", "a t and t") to a single canonical name
(e.g. "AT&T"). Confirmed mappings accumulate into a per-column-spec lookup table and embed
into the customer's data pipeline.

Two surfaces: the **warehouse database layer** (storage + computation) and the **Next.js web
UI** (human review and run management).

Prism is a **single product**: the fully automated pipeline platform. A background poller
watches live source tables; new values are queued, LLM-grouped, and exported automatically;
deletes/updates drop rows from the export table. The old basic/premium tier split is gone —
there is no `NEXT_PUBLIC_APP_MODE`, no `feature-flags.ts`, and no mode guards.

One additional feature (not a tier): the **one-time standardization flow**
(`app/one-time/`) — "clean a list once", standardize a source table's columns to a
standalone output table without ever touching the shared lookup.

### The pipeline in one paragraph

A **poll pass** runs at every wall-clock minute mark and only ever *detects and queues*
values (Snowflake streams / SQL Server Change Tracking / diff scans). A **standardization
tick** runs at every 10-minute mark and drains any non-empty queue for pipelines whose update
window is open: hash-lookup known values, LLM-group the rest, write confirmed mappings to the
shared lookup, rebuild the export. The **top-of-hour tick** additionally runs a reconciliation
sweep + safety export rebuilds. Nothing standardizes inline during a poll.

### User flow

1. New Run → per-column spec (description + rules + convention, edited inline) → locked at creation
2. Data source — warehouse table path, Excel/CSV upload, or paste values
3. Column selection + preview
4. Auto Group (button click) → hash lookup → LLM chunks in parallel → merge pass
5. Human review — drag items between groups, rename groups, create groups
6. Export → writes to the lookup table
7. For pipelines, the poller then keeps the export in sync automatically

---

## Where to look

| Working on… | Read first |
|---|---|
| UI, components, styling, copy, review-screen client state | `docs/DESIGN_SYSTEM.md` |
| Schemas, migrations, queries, the state blob, column specs | `docs/DATA_MODEL.md` |
| Poller, detection, ticks, exports, health guards, warehouse cost | `docs/PIPELINE_INTERNALS.md` |
| Grouping, prompts, the referee, the export write path, LLM providers | `docs/LLM_PIPELINE.md` |
| Google Sheets / CSV / Excel pipelines, uploads, the one-time flow | `docs/FILE_PIPELINES.md` |
| `/setup` wizard, auth/sessions, `/settings`, deployment | `docs/SETUP_WIZARD.md` |
| Anything per-warehouse (SQL text, dialect quirks, parity matrix) | `docs/WAREHOUSES.md` + the `warehouse-change` skill |
| Why a product decision was made | `docs/PRODUCT_DECISIONS.md` |
| Security posture, credential storage, customer disclosures | `docs/SECURITY_AND_DISCLOSURES.md` |
| Porting to another warehouse | `docs/MSSQL_PORT_PLAN.md`, `docs/POSTGRES_PORT_PLAN.md`, `docs/MYSQL_PORT_PLAN.md` |
| Marketplace / Native App edition | `docs/NATIVE_APP_PLAN.md` |
| Onboarding a client; prelaunch gates | `docs/CLIENT_ONBOARDING.md`, `docs/PRELAUNCH_CHECKLIST.md` |
| Local dev containers for non-Snowflake warehouses | `docs/DEV_MSSQL.md`, `docs/DEV_POSTGRES.md`, `docs/DEV_MYSQL.md` |

---

## Commands

All commands run from `stand-ui/`:

```bash
npm install        # install dependencies
npm run dev        # start dev server on http://localhost:8000
npm run build      # production build
npm run lint       # eslint
npm run test:parity        # warehouse parity tests (pure logic, no DB)
npm run typecheck:scripts  # typecheck scripts/ — deliberately NOT part of `build`
```

`test:parity` covers `normalizeLiteral` vs the `PRISM_NORMALIZE` UDF, `sqlStringLiteral`
escaping, mssql dialect helpers, header-row detection, the convention-regex ReDoS screen, and
the provider-routing guard. **There is no test suite beyond `test:parity`. Run it after ANY
change to normalization or warehouse dialect helpers.**

Live per-warehouse suites (each needs its dev container — see the matching `docs/DEV_*.md`):

```bash
npm run mssql:install    npm run test:mssql-live    npm run test:mssql-detection
npm run test:mssql-lifecycle    npm run test:mssql-setup
npm run pg:install       npm run test:pg-live       npm run test:pg-detection
npm run test:pg-lifecycle       npm run test:pg-setup
npm run mysql:install    npm run test:mysql-live    npm run test:mysql-detection
npm run test:mysql-lifecycle    npm run test:mysql-setup
```

They are the phase exit-criteria tests: `-live` = adapter/dialect/install, `-detection` =
the change-detection engine, `-lifecycle` = detect→standardize→export, `-setup` = workspace
choice, credentials, one-time export, file rows.

**`scripts/` is excluded from the production typecheck** (`tsconfig.json` → `exclude`). The
include list picks up `**/*.mts` project-wide, so a half-finished throwaway script under
`scripts/` used to fail `npm run build` even though nothing in it ships — it happened three
times during the 2026-08 QA run, each time blaming a file unrelated to the app. A stray dev
script must never block a deploy. The maintained scripts are still typechecked, just
deliberately: `npm run typecheck:scripts` (`tsconfig.scripts.json`). Run it alongside
`npx tsc --noEmit` when you change one. `tsx` executes scripts regardless of either config,
so `test:parity` and the live suites are unaffected.

### Deploy SQL to Snowflake (run from repo root)

```bash
snowsql -f 00_bootstrap.sql       # DB + schemas + the ONBOARDING MIRROR (see below)
snowsql -f 01_internal_tables.sql # tables + UDF + roles + grants — the CUSTOMER install
snowsql -f 02_demo_data.sql       # DEV/DEMO ONLY — never run on a customer account
```

That's the complete Snowflake-side deploy (the SQLite app database creates itself on first
boot) — there are no deploy/setup shell scripts. **The customer/dev split:** `00` + `01` are
everything a customer's account requires (and are what the setup wizard serves);
`02_demo_data.sql` is dev/demo-only — the fake
`TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT` source table, the dev `TEST_DB` grants, and the
dev user's role grants.

`00_bootstrap.sql` also carries the **onboarding mirror**: the SQL the `/setup` wizard's step
2 (Parts B–D) has a customer admin run by hand — `PRISM_SVC` service-user creation (the
`RSA_PUBLIC_KEY` ALTER stays commented so re-runs never clobber the live key) and the Part D
data-access grants for the dev `TEST_DB.PUBLIC` schema. Purpose: dev resets and
onboarding-SQL testing never require clicking through the wizard — `00` + `01` fully onboard
the account. The mirror sits below the **`-- PRISM:INSTALL-SCRIPT-END` marker** —
`/api/accounts/install-script` truncates the file there, so customers see only the clean
bootstrap portion (a marker-less file is served whole). **Keep the mirror in sync with
`app/setup/page.tsx`** (`SERVICE_USER_SQL`, `buildDataAccessGrants`) whenever the onboarding
SQL changes.

> **⚠️ The install scripts are CUSTOMER-FACING DOCUMENTS (comment hygiene, 2026-08-17).**
> The `/setup` wizard serves `00_bootstrap.sql` (to its marker) + `01_internal_tables.sql` —
> and the mssql/postgres/mysql `01_internal_tables.*.sql` variants — **verbatim** to the
> customer's DBA in step 2. Their comments must stay customer-appropriate: no references to
> `02_demo_data.*`, npm dev runners, dev resets, `TEST_DB`/`test_sources`, port-plan
> docs/phases, cross-engine "differences from Snowflake" comparisons, or internal
> architecture names like SQLite (say "Prism's app-side database"). Dev/demo/reset knowledge
> belongs in `docs/DEV_*.md` and this file, never in the served scripts. (Found live in the
> 2026-08 client-sim rehearsal: a prospect's DBA was reading dev-reset instructions.)

**Full dev reset = `01` + `02` + the app-state reset.** Re-running `01` resets the Snowflake
side (lookup tables, queue, file rows) and also **drops all `PIPELINE_STREAM_*` streams**
(Snowflake Scripting block — stale streams from previous pipeline generations otherwise
accumulate); re-running `02` resets the demo source table. COLUMN_SPECS / PIPELINES / RUNS
live in SQLite, which snowsql can't touch — reset them with:

```bash
cd stand-ui && npm run reset-app-state   # scripts/reset-app-state.mjs
```

It empties `pipelines` / `runs` / `column_specs` / `one_time_standardizations` and restarts
the autoincrement counters. `accounts`, `invitations`, and the workspace config are
deliberately untouched (no re-onboarding). **Restart the dev server afterwards** — the
poller/tick hold in-memory state for the old pipelines.

**Demo seed (currently disabled).** `02_demo_data.sql` carries the demo seed for
`TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT` (two columns, one shared export table). As of
2026-06-14 the initial standardizations (`APPROVED_ALIAS_NAMES` + `LITERAL_ALIAS_MATCHES`)
are **temporarily disabled** with `TEMP:` markers (wrapped in `/* … */`). The raw source
table + its sample rows are kept live, so a fresh `01` + `02` = all internal tables
created/empty + a populated source table (clean slate to test the from-scratch create flow).
Re-enable the `TEMP:`-marked blocks to restore the pre-confirmed lookup. The **client-side
half** of the demo — prefilled table/column values in the connect form — is gated behind the
`NEXT_PUBLIC_PRISM_DEMO_DATA` env flag (off by default).

---

## Environment Variables

Copy `stand-ui/.env.local.example` to `stand-ui/.env.local`. Long-form notes on
`PRISM_EDITION` and `PRISM_FRESH_SETUP` are in `docs/SETUP_WIZARD.md`.

| Variable | Purpose |
|---|---|
| `SNOWFLAKE_ACCOUNT` / `SNOWFLAKE_USER` / `SNOWFLAKE_WAREHOUSE` | Service-connection **fallback** — used only when no workspace credentials are saved via `/setup` (SQLite `workspace_config`). Warehouse default is `PRISM_WH` |
| `SNOWFLAKE_PASSWORD` | Password auth (fallback) |
| `SNOWFLAKE_PRIVATE_KEY` | Inline PEM private key (preferred); handle literal `\n` → real newline |
| `SNOWFLAKE_PRIVATE_KEY_PATH` | File path to PEM private key (alternative to inline) |
| `ANTHROPIC_API_KEY` | LLM-key **fallback** (SQLite `workspace_llm_config` wins). All key reads go through `_lib/anthropic-key.ts` — never read this env var directly. **Doubles as the "Prism-provided AI" mechanism** (vendor key set at deploy time for clients with no LLM account) |
| `SESSION_SECRET` | HMAC key for session cookies |
| `PRISM_ENCRYPTION_KEY` | 64 hex chars (32 bytes) — AES-256-GCM key for stored secrets: `ACCOUNTS.sf_password`, `ACCOUNTS.sf_private_key`, the Google `refresh_token` in `file_source_meta`. Ciphertext format `enc:v1:<iv>:<ciphertext>:<authTag>`. Generate with `openssl rand -hex 32`; store per-installation in a password manager (losing it orphans the encrypted secrets) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Google OAuth (login + Sheets export) |
| `ADMIN_EMAIL` | Bootstrap admin; all other users must be invited |
| `REDIS_URL` | Optional — enables auto-export baseline tracking; degrades gracefully if absent |
| `PRISM_SQLITE_PATH` | Local SQLite app-state DB file (default `./data/prism.db`, gitignored). Must be on persistent storage; backup = copy the file |
| `SMTP_*` + `APP_URL` | Email invitations |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | Optional server/client error monitoring. No-ops when unset |
| `PRISM_DEBUG_TOOLS` | `'true'` enables `/debug` and `/api/admin/table`. Operator-only — never set in customer installs |
| `PRISM_DEBUG_ARTIFACTS` | Writes LLM breakdown / validation audit JSONs to the OS temp dir |
| `NEXT_PUBLIC_PRISM_DEMO_DATA` | Enables demo prefills in the connect form (off by default) |
| `PRISM_WAREHOUSE_TYPE` | Dev/operator switch for the adapter factory: `snowflake` (default), `mssql`, `postgres`, `mysql`. The wizard choice (`workspace_config.warehouse_type`) takes precedence. Ignored entirely in the native edition |
| `PRISM_EDITION` / `NEXT_PUBLIC_PRISM_EDITION` | `standard` (default) or `native` (Snowflake Marketplace build). Both must be set together. See `docs/SETUP_WIZARD.md` |
| `PRISM_FRESH_SETUP` | Dev-only — simulates a bare customer install everywhere setup-facing. Never set in customer installs |
| `PRISM_CHUNK_MODEL` / `PRISM_MERGE_MODEL` | Model-ID overrides for grouping chunk / merge calls (default `claude-sonnet-4-6`; Anthropic only) |
| `PRISM_OPENAI_MODEL` / `PRISM_GEMINI_MODEL` | Overrides for the pinned non-Anthropic models (defaults `gpt-4.1` / `gemini-flash-latest`). `PRISM_COPILOT_MODEL` still exists but is vestigial — Copilot was removed as a provider 2026-07-27 |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_DATABASE` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_SSL` | MySQL service-connection config (env tier). `MYSQL_DATABASE` is only the session default (MySQL joins across databases); `MYSQL_SSL` is `false` \| `true` \| `strict`. Workspace tier: `workspace_config.my_*`. Floor MySQL 8.0.19; MariaDB unsupported |
| `PG_HOST` / `PG_PORT` / `PG_DATABASE` / `PG_USER` / `PG_PASSWORD` / `PG_SSLMODE` / `PG_SSL_CA_PATH` | PostgreSQL service-connection config (env tier). `PG_DATABASE` is the ONE database the install standardizes (Postgres cannot query across databases); `PG_SSLMODE` is `disable` \| `require` \| `verify-full`. Workspace tier: `workspace_config.pg_*` |
| `MSSQL_SERVER` / `MSSQL_USER` / `MSSQL_PASSWORD` / `MSSQL_DATABASE` / `MSSQL_PORT` / `MSSQL_ENCRYPT` / `MSSQL_TRUST_SERVER_CERT` | SQL Server service-connection config (env tier). `MSSQL_DATABASE` defaults to `PRISM_DB`; set `MSSQL_TRUST_SERVER_CERT=true` for the dev container's self-signed cert |

---

## Traps & hard rules

Violating any of these has broken production before. Details are in the linked doc.

1. **⚠️ `domain_id` NEVER means a domain.** Domains were removed 2026-07-15 (migration 012). Every physical column still named `domain_id` — SQLite `pipelines`/`runs`, warehouse `APPROVED_ALIAS_NAMES`/`LITERAL_ALIAS_MATCHES`, `file_source_meta.columns[]`, the `?domain_id=` API param — **holds a `column_specs.spec_id`**. Deliberate compatibility decision, not an accident. → `docs/DATA_MODEL.md`
2. **Customer VALUES never rest in SQLite.** Data-residency rule: state blobs (`RUN_STATE`), the validation log, one-time mappings and the lookup all live in the customer's warehouse. SQLite holds metadata/config only. → `docs/DATA_MODEL.md`
3. **Never call the state-blob helpers from recurring surfaces** (GET /api/pipelines, SSE refetches, idle poll cycles). They are warehouse calls and each one can wake `PRISM_WH`. Review pages, exports, and the tick only.
4. **Recurring background paths use metadata-layer commands only** (`SHOW`, `DESCRIBE`, `SYSTEM$STREAM_HAS_DATA`) — never a `SELECT` against `INFORMATION_SCHEMA`, which wakes and bills a warehouse. An idle poll cycle must cost zero. → `docs/PIPELINE_INTERNALS.md` → Snowflake Cost Model
5. **Write `PRISM_NORMALIZE` fully qualified** (`PRISM_DB.INTERNAL.PRISM_NORMALIZE(...)`) in all generated SQL. A bare call breaks `CREATE VIEW` for every export destination outside `PRISM_DB.INTERNAL` (KI-149).
6. **`normalizeLiteral()` and the `PRISM_NORMALIZE` UDF must change together**, and `LITERAL_ALIAS_MATCHES.normalized_value` must be backfilled if the logic changes. Every INSERT/MERGE into that table must set `normalized_value`.
7. **Parse `export_kind` only via `asExportKind()`.** A hand-rolled `=== 'view' ? 'view' : 'table'` coercion silently turns a column pipeline into a table rebuild aimed at the customer's source table.
8. **Never pattern-match `status_message` in code** — it is prose for the card. Anything that acts on a flag filters on `status_reason` (`PIPELINE_BLOCK_REASONS` / `NOT_BLOCKED_SQL`). A skip flag must block EVERY standardization entry point.
9. **Convention regexes compile with RE2** (`compileSafeRegex`), never `new RegExp` server-side. `null` means "cannot enforce", never "fall back". A backtracking regex freezes the entire single-threaded installation. → `docs/PIPELINE_INTERNALS.md`
10. **New API routes must call `requireValidSession` / `requireAdminSession`**, not bare `decodeSession`. → `docs/SETUP_WIZARD.md`
11. **Never read `process.env.ANTHROPIC_API_KEY` directly** — go through `_lib/anthropic-key.ts`.
12. **Poller/background changes need a full dev-server restart.** Hot-reload does not replace already-scheduled closures; this has repeatedly masked correct fixes. Tell the user to restart.
13. **The install SQL scripts are customer-facing documents** — see the comment-hygiene warning above.
14. **Warehouse field names come back uppercase; coalesce BEFORE any null check.** `r.DOMAIN_ID != null ? Number(r.DOMAIN_ID) : null` silently returns null for every SQLite row (lowercase keys). Correct: `const raw = r.DOMAIN_ID ?? r.domain_id; raw != null ? Number(raw) : null`. This blanked `domain_id`/`created_by` across the UI until fixed in `row2pipeline` 2026-07-13.
15. **Portal every floating element** (tooltips, dropdowns, menus) to `document.body` with `position: fixed` + an exact `width` — cards use `overflow: hidden` and clip absolute children. → `docs/DESIGN_SYSTEM.md`
16. **All borders are 0.5px; all copy is sentence case.** Two design rules with almost no exceptions. → `docs/DESIGN_SYSTEM.md`
17. **A change touching SQL, change detection, exports, grants, or normalization is an adapter-level change** — implement it for every warehouse, update `docs/WAREHOUSES.md` and the parity tests in the same change. Follow the `.claude/skills/warehouse-change` checklist.

---

## Glossary

| Term | Definition |
|---|---|
| Column spec | Per-column standardization contract (description + rules + convention). Scopes that column's alias names via `spec_id`. Replaced Domains, which replaced Concepts. |
| Run | A processing session against one source column. Produces groups for human review. |
| Group | A proposed cluster of raw values that map to the same canonical alias name. |
| Literal value | A distinct raw string from the source column, exactly as it appears. |
| Alias name | The canonical correct name a group maps to (e.g. "AT&T"). Stored in `APPROVED_ALIAS_NAMES`. |
| Lookup match | A previously confirmed `literal_value → alias_id` mapping in `LITERAL_ALIAS_MATCHES`. |
| Export kind | `'table'` \| `'view'` \| `'column'`, or no export object at all ("Lookup table" in the UI). |

## The two stores, in brief

Any table joined against customer source data inside warehouse SQL stays in the warehouse;
pure app-state lives in a local SQLite file.

- **Warehouse `PRISM_DB.INTERNAL`** — `APPROVED_ALIAS_NAMES`, `LITERAL_ALIAS_MATCHES`, `PIPELINE_QUEUE`, `PIPELINE_FILE_ROWS`, `RUN_STATE`, `VALIDATION_LOG`, `ONE_TIME_FILE_ROWS`/`_BLOBS`, plus streams, export tables and the `PRISM_NORMALIZE` UDF.
- **SQLite** (`_lib/sqlite.ts`) — `accounts`, `invitations`, `column_specs`, `one_time_standardizations`, `runs` (metadata only), `pipelines`, `workspace_config`, `workspace_llm_config`.

Cross-store references are plain integers; warehouse SQL cannot join the SQLite side, so
those joins are split and combined app-side. Full schemas, migration history and the
`internalTable()` helper: `docs/DATA_MODEL.md`.

---

## Scale & Input Limits

Guardrails — all refuse loudly or defer, never drop silently.

| Limit | Where | On exceed |
|---|---|---|
| 5,000 distinct / standardization run | queue drain + baseline scans | remainder processes on later passes/clicks |
| 20,000 distinct / one-time column | `ONE_TIME_MAX_DISTINCT` (`op-one-time.ts`) | 400, "connect as a pipeline" |
| 5,000 rows / bulk MERGE statement | `EXPORT_MERGE_BATCH` (`op-export.ts`) | automatic batching (Snowflake ~65k-bind ceiling) |
| 100,000 rows / Google Sheet tab | `MAX_SHEET_ROWS` + `SheetTooLargeError` | creation → rollback + 400; poller → pipeline pauses with `status_message` |
| 20 MB / 200,000 rows per CSV/Excel upload | client pre-parse + `POST /api/pipelines/file` | clear error, "load into a warehouse table" |
| 20 rules × 500 chars; description ≤1,000; regex convention ≤500 (examples/natural ≤2,000); pre-standardized values+examples ≤500 total × 200 chars | spec create route (one-time route mirrors the rule caps) | 400 with the specific limit |
| 200 chars / alias name | both review UIs (matches `sanitizeProposedName`) | rename blocked with banner |

---

## Key Invariants

- Lookup group alias names always win over LLM-proposed names in a merge (matched on `normalizeLiteral(name)`)
- Spec **standardization rules override the same-entity grouping default** — a rule may direct grouping related-but-distinct entities, and both the chunk and merge prompts state the precedence explicitly
- The column spec is locked at run creation — cannot be changed after
- Ungrouped items are never written to `LITERAL_ALIAS_MATCHES` (and auto-group leaves nothing ungrouped: unplaceable values become convention-compliant `needs_review` self-map singletons)
- Export is user-first, unconditionally since 2026-08-18: the reviewer's exported mappings are written verbatim — the validation referee is DISABLED by owner decision (`EXPORT_REFEREE_ENABLED = false` in `op-export.ts`; machinery retained behind the flag). Nothing blocks or loses an export
- The initial standardization is trusted: user moves away from a high-confidence initial LLM group are refereed (Case C) *when the referee is on*, just as moves away from confirmed lookups are (Case A); renames of `llm_proposed` groups are the user's prerogative and never refereed
- State blob (warehouse `INTERNAL.RUN_STATE`) is the sole source of truth for a run's final state at export time; concurrent writers are serialized by the blob's `rev`
- Customer VALUES never rest in SQLite (data-residency rule)
- `LITERAL_ALIAS_MATCHES` stores `alias_id` FK (not `alias_name` directly), every write sets `normalized_value`, and there is at most one row per `(normalized_value, spec)` — writers must dedupe on the normalized form
- LLM failures degrade honestly — `'llm_failed'` / confidence `'l'` / `needs_review`, never a fabricated high-confidence group
- Scale limits defer or refuse loudly, never drop silently
- One-time runs (`run_type='one_time'`) never touch the shared lookup
- NULL and **blank** source values (anything `normalizeLiteral` reduces to `''`) are never standardized: not counted as source values, never queued, exported as-is. SQL filters go through `notBlankSql`/`isBlankSql` (Snowflake) or the dialects' `notBlankPredicate`/`isBlankPredicate`, never a bare `IS NOT NULL` — `''` IS NOT NULL on every warehouse (2026-09-14)
- "Update Standardizations" / manual review reconcile the source BEFORE draining the queue: the card's "Unstandardized" stat is source-minus-lookup, the queue is only what detection captured, and an empty queue must never turn the buttons into silent no-ops
- New source values never *cause* an export rebuild during a poll — they wait for the tick (consistent-snapshot export). The one exception is raw passthrough (`export_unmapped_rows = true`), by owner decision 2026-08-18
- Column-mode pipelines never create, drop or replace a table, and every write path calls `assertCompanionColumnSafe` first

---

## Server-Side Library (`stand-ui/app/api/_lib/`)

| File | Responsibility |
|---|---|
| `warehouse/` | **The warehouse adapter layer.** `warehouse/index.ts` is the facade every consumer imports: `withWarehouse` (service connection), `withUserWarehouse` (personal credentials), `executeQuery` (the one shared statement runner — do NOT write local `exec()` helpers), `isWarehouseAccessError`, `warehouseErrorResponse`, `serviceConnectionSource`, `getWarehouseAdapter`. `warehouse/types.ts` is the `WarehouseAdapter` contract; `warehouse/snowflake/connection.ts` (the old `snowflake.ts`, relocated) is the ONLY place allowed to import `snowflake-sdk` (lint-enforced via `no-restricted-imports`). Setup surfaces import their warehouse's connection module directly: Snowflake (`test-snowflake`, `workspace-snowflake`, `snowflake-config`, `verify-install`, `grants.ts`) ← `warehouse/snowflake/connection`; SQL Server (`workspace-mssql`, `mssql-config`, `warehouse-type`) ← `warehouse/mssql/connection` (`withAdHocMssql`, workspace/personal config helpers). The platform choice lives in `workspace_config.warehouse_type`; the resolved kind comes from `getWarehouseAdapter().kind`. **Decision test for new code:** touches SQL, change detection, exports, grants, or normalization → it's an adapter-level change, and must be implemented for every warehouse before it ships. Per-operation detail: `docs/WAREHOUSES.md` |
| `warehouse-tables.ts` | `internalTable(name)` — internal table references that work on every warehouse: Snowflake and mssql resolve `PRISM_DB.INTERNAL.<NAME>`; Postgres (schema) and MySQL (database) get `prism_internal.<lowercase>`. Shared SQL must use this instead of hardcoding the 3-part form |
| `env.ts` | `getOptionalEnv` + `isFreshSetupSim` — pure env reads shared across server modules |
| `session.ts` | HMAC-signed cookie encode/decode (`prism_session`) — payload carries `v` + `exp`; `sanitizeReturnTo`; `Secure` in production |
| `account-security.ts` | Session revocation: `requireAdminSession` / `requireValidSession` / `bumpSessionVersion` — checks cookie `v` against SQLite `accounts.session_version` on every request (no cache; instant revocation) |
| `sqlite.ts` | Local app-state database (better-sqlite3, WAL). `getDb()` singleton (hot-reload-safe via `global`), append-only migrations keyed on `PRAGMA user_version` — pending migrations are ALSO applied when a hot-reloaded module reuses the cached global handle, so a long-running dev server picks up migrations written after it booted. Never holds customer values |
| `crypto.ts` | App-level AES-256-GCM secret encryption (`encryptSecret` / `decryptSecret`), key from `PRISM_ENCRYPTION_KEY`, `enc:v1:` format; plaintext passthrough for unmigrated values; malformed key throws |
| `anthropic-key.ts` | AI-provider resolution: `getLlmProviderConfig()` (workspace row → env fallback, 10 s cache, `invalidateAnthropicKeyCache()`), `getAnthropicApiKey()`, `anthropicKeySource()`, `asLlmProvider()`. Decrypt failure logs + falls through to env, never throws |
| `report-error.ts` | Central error reporting: always `console.error`, forwards to Sentry when configured, never throws. Deliberately importable from client AND server |
| `run-header.ts` | `getRunHeader` — direct server-side run-header query for the run page server component. LEFT JOINs `column_specs` (on `spec_id = runs.domain_id`) to carry the spec's column name, rules and convention fields |
| `pipeline-broadcaster.ts` | In-process Node `EventEmitter` on `global` for SSE push to the UI. Survives hot-reloads. Event types include `alert` |
| `pipeline-coordination.ts` | Per-pipeline lock tracking — prevents concurrent standardization runs on the same pipeline. The lock map lives on `globalThis` (`__prismStandardizingSince`, pipeline_id → started-at ms; module-local state once stranded a leaked lock across dev-bundle instances and the poller silently skipped that pipeline forever). Locks self-expire after 30 min (`STANDARDIZING_MAX_MS`) |
| `pipeline-alerts.ts` | `pausePipelineWithMessage`, `clearPipelineStatusMessage`, `flagPipelineMessage`, `broadcastGlobalAlert`, `broadcastPipelineAlert`; `PIPELINE_BLOCK_REASONS` + `NOT_BLOCKED_SQL` — the shared gate every standardization entry point applies |
| `normalize.ts` | `normalizeLiteral()` — pure TS mirror of the `PRISM_NORMALIZE` UDF; keep in sync with the UDF + the stored `normalized_value` column. Also `sqlStringLiteral()` for safe string-literal interpolation. (Pure — no `server-only`) |
| `pipeline-poller.ts` | Minute-mark poll passes for ALL active pipelines. Snowflake path: throttled `checkSourceHealth`, stream classify, queue ALL new values, hygiene rebuilds at most once per table per cycle. File-based path: `pollOneFilePipeline`. On mssql installs, live-table pipelines dispatch to `pipeline-poller-mssql.ts`. `fetchActivePipelines` cached 10 s. `PipelineRef` carries `source_type` and the parsed `update_schedule` so the two paths never cross. Detect + queue ONLY — never standardizes |
| `pipeline-poller-mssql.ts` | SQL Server poll orchestration: per-pipeline detection state, Change Tracking consumption or tiered diff scans via `warehouse/mssql/detection.ts`, health cadence, pause/flag semantics, freshness stamping. Writers: `warehouse/mssql/mappings.ts`; builder `warehouse/mssql/export.ts` (staging-join, transactional swap, grants re-applied; `export_kind` 'view' is refused on mssql) |
| `pipeline-poller-postgres.ts` | Postgres poll orchestration: diff-scan-only detection via `warehouse/postgres/detection.ts`, gated by the free `pg_stat_user_tables` write-counter heartbeat (its delete counter flags hygiene rebuilds the same cycle — something mssql diff mode can't see). RLS on the source = the masking analog (`policy_blocked`). Writers: `warehouse/postgres/mappings.ts` (ON CONFLICT upserts); builder `warehouse/postgres/export.ts` (staging join, transactional swap, ACL re-apply; view kind SUPPORTED via persistent mapping tables; column kind guarded) |
| `pipeline-poller-mysql.ts` | MySQL poll orchestration: diff-scan-only detection via `warehouse/mysql/detection.ts`, gated by the `information_schema.TABLES.UPDATE_TIME` heartbeat (fresh via per-session `information_schema_stats_expiry=0` — the 24h default would blind it; delete-BLIND, hourly rebuild covers). Writers: `warehouse/mysql/mappings.ts` (row-alias ON DUPLICATE KEY); builder `warehouse/mysql/export.ts` (atomic multi-RENAME swap, verbatim 'user'@'host' grant replay, view kind via persistent maps, column kind guarded) |
| `pipeline-hourly-processor.ts` | The 10-minute standardization tick (`startQueueProcessor`) + on-demand `processPipelineQueue`. `fetchQueueLiteralsWithFreq` drains the queue in 5,000-value FIFO installments. Failure backoff + auto-pause after 5 consecutive failures; retries reuse the pending run (`hourly_<pid>_` nonce). Exports `bulkProcessPipelineQueue`. (Filename is historical — it's the tick processor now) |
| `update-schedule.ts` | Update time windows (pure, shared with the client): `UpdateSchedule` type, `DEFAULT_UPDATE_SCHEDULE` (Mon–Fri 9–5), `asUpdateSchedule` (strict), `parseStoredSchedule` (tolerant), `isScheduleActiveNow` (Intl-based), `scheduleLabel` |
| `op-file-pipeline.ts` | File-based pipeline helpers: `readAllSheetRows` (paginated, `SheetTooLargeError`), `a1Sheet`, `syncSheetsColumn` (non-destructive rewrite), `refreshSheetsFileRows`, `insertFileRows` / `readFileDistinctValues`, `readFilePipelineRowsForDownload` |
| `op-auto-group.ts` | State-blob types (`OpRunState`, `OpGroup`, …) + load/save helpers including the rev-checked save — ~100 lines, nothing else |
| `op-auto-group-run.ts` | Live auto-grouping: normalized literal lookup → lookup groups → `runOnePromptGrouping` for unmatched → assemble state. Builds the existing-names list, makes self-map singleton names convention-compliant, stamps `initial_*`, honest `'llm_failed'` fallbacks |
| `llm-one-prompt-grouping.ts` | LLM grouping + merge calls. Sorted boundary-aware chunking (`sortAndChunkItems`), diverse merge reps (`pickDiverseReps`), retries, prompt caching, JSON-escaped literals, proposed-name validation. Exports `callAnthropicWithRetry` / `JSON_ONLY_REMINDER` / `fixNamesForConvention` |
| `grouping-types.ts` | Shared grouping types (`RunItemForPairing`, `FinalGroup`, …) — the only survivors of the deleted deterministic pipeline |
| `op-export.ts` | User-first fail-open export: reads state blob, detects Case A/B/C, (referee disabled), writes everything in one pass — batched idempotent MERGEs at `EXPORT_MERGE_BATCH=5000`, deduped on `normalizeLiteral`, sets `normalized_value` — marks run `'completed'` |
| `op-one-time.ts` | One-time standardization engine: lookup-free LLM grouping, optional naming convention, export to a standalone table, archive to `ONE_TIME_STANDARDIZATIONS` |
| `file-inplace.ts` | Edit-in-place patcher for one-time CSV/XLSX exports (pure, parity-tested): byte-span CSV tokenizer + zip-level XLSX surgery that replaces ONLY the standardized cells. ANY patch failure falls back to the regenerated export — never a corrupted "original" |
| `convention-rules.ts` | Structured naming-convention rules — prompt instructions + deterministic normalization of LLM output. Pure module shared by UI and server |
| `safe-regex.ts` | `compileSafeRegex` / `safeRegexError` — RE2 (`re2-wasm`) compilation of user-authored convention regexes. Must never contain `new RegExp` |
| `namescore.ts` | Deterministic "most representative literal" scoring, used as the fallback group namer |
| `export-table.ts` | Rebuilds the pipeline's export table/view (`CREATE OR REPLACE … COPY GRANTS AS SELECT`), joining stored `normalized_value` vs `PRISM_NORMALIZE(source)`. Hosts `refreshStandardizedColumnsSnowflake` and dispatches all export kinds from `refreshExportTable`. Refuses a destination equal to the source table |
| `export-kind.ts` | Pure module (shared with the client): `ExportKind`, `asExportKind()` (the ONLY sanctioned parser), `standardizedColumnName()`, `assertCompanionColumnSafe()`. Parity-tested |
| `table-shape.ts` | `detectHeaderRow` + `columnLetter` — deterministic header-row detection for uploads and Sheets (pure, parity-tested) |
| `grants.ts` | `buildGrantStatements` / `applyGrants` — programmatic role grants. Account-level CREATE ROLE/WAREHOUSE statements are pre-checked via SHOW and reported `skipped` when the object exists |
| `email.ts` | SMTP invitation emails |
| `timing.ts` | `appendTiming` — phase-timing instrumentation to console + log file (`PRISM_TIMING_LOG`, default `/tmp/prism-timing.log`) |
| `redis.ts` | Optional ioredis singleton; returns `null` when `REDIS_URL` is unset |
| `auto-export-seen.ts` | Redis-backed baseline tracking — records which values existed at pipeline setup |

Background startup (`instrumentation.ts`) and the SSE contract are documented in
`docs/PIPELINE_INTERNALS.md`.

---

## File/Folder Conventions

- All warehouse-touching and secret-touching `_lib` files include `import 'server-only'`. Intentional exceptions: `normalize.ts`, `convention-rules.ts`, `grouping-types.ts`, `namescore.ts`, `update-schedule.ts`, `export-kind.ts`, `table-shape.ts` (pure modules shared with the client) and `report-error.ts` (deliberately client-safe); `warehouse/types.ts` is types-only.
- API routes: run operations `/api/run/[run_id]/...`; pipelines `/api/pipelines/...`; one-time `/api/one-time/...`; members `/api/accounts/members...`
- Shared UI components live in `app/components/`
- Warehouse field names come back uppercase; normalise with the `r.FIELD_NAME ?? r.field_name` pattern — **coalesce before any null check** (trap 14 above)

---

## Deferred / Open Items

- **⚠️ Column output mode never live-tested:** the entire `export_kind='column'` path (companion-column sync on both warehouses, consent-time provisioning via creator credentials, guardrail behavior, stream-echo settling) plus the view repair path exist only as passing builds/parity tests. **`docs/PRELAUNCH_CHECKLIST.md` §1 is the mandatory live-warehouse protocol** — run it before any customer touches column mode.
- **⚠️ Non-Anthropic AI providers untested:** the OpenAI / Gemini paths (and grouping quality on non-Claude models — prompts were tuned on Claude) have never run end-to-end against a production-tier account. Test before any customer picks them, or hide the untested cards in `/setup` step 4.
- **⚠️ mssql user-connection pipelines are code-only** (migration 021, `_lib/pipeline-user-connection.ts`) — not yet live-tested. See `docs/WAREHOUSES.md` → Personal connection.
- **FQN parsing loses a boundary space:** `parseFqn` trims the whole FQN string and preserves each part verbatim, so interior spaces (`DB.S.MY TABLE`) survive — but a table whose real name *ends* in a space, or a database whose name *starts* with one, still loses that character, being indistinguishable from copy-paste whitespace. Live-reproduced (DET-S10). Benign now (a genuine not-found, not a mangled name blamed on the customer); a proper fix means accepting quoted FQNs (`DB.S."TBL "`) through every warehouse path.
- **Legal pages:** `/terms` and `/privacy` carry placeholder legal text pending counsel review — including echoing the column-mode no-liability wording that currently lives only in the connect form's warning panel.
- **File-pipeline distinct read is uncapped:** `readFileDistinctValues` reads every distinct value from `PIPELINE_FILE_ROWS` — a huge CSV builds one monster standardization run (no longer *fails* post-batching; merge degrades gracefully) but should get the same 5k installment treatment as the queue drain.
- **One-time partial-creation orphans:** the create route builds runs column-by-column; if a later column trips the 20k cap (or any error), earlier columns' working runs remain as invisible orphan rows in `runs`. Fix = pre-scan all columns' distinct counts before creating any runs.
- **Run page uppercase-prop latent bug:** `run/[run_id]/page.tsx` reads `runData?.RUN_STATUS` / `SOURCE_RELATION` (uppercase) but `getRunHeader` returns lowercase keys, so `initialRunStatus`/`sourceRelation` props have always been `undefined` (the client fetches everything itself, so no visible breakage). Fixing it would suddenly activate never-run `initialRunStatus` code paths — do it deliberately, not as a drive-by.
- **`needs_review` evaporates at export:** the flag lives only in the run state blob; once auto-mode self-maps are written to `LITERAL_ALIAS_MATCHES`, nothing durable marks the review debt. Candidate fix: a `needs_review`/`reviewed_at` column on the lookup, set from the group flag at export.
- **Review UI is unvirtualized:** all groups render; sluggish in the low thousands of groups — the practical review ceiling, distinct from any processing limit.
- **Sheets header row is uncorrectable:** file uploads get a header-row override; Google Sheets connections don't (SHEETS-HDR-02), so a mis-detected Sheets header is silent.
- **No per-workspace LLM usage rollup:** token usage is recorded per run (`llm_usage` in run state) but never aggregated. Needed if "Prism-provided AI" becomes the standard offering.
- **"AI included" setup copy:** when the LLM key source is env (vendor-provided), `/setup` step 4's note reads "already configured on the server" — could instead say "AI is included with your Prism installation". Approved idea, not yet built.
- **`PRISM_FRESH_SETUP` currently left `true` in the local dev `.env.local`** (added 2026-07-12 for the fresh-customer walkthrough) — remove the two TEMP lines and restart to restore normal env-aware behavior.
