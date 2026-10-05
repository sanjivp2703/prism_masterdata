# Data Model — Tables, State Blob, Column Specs

Read this before any schema, migration, or query change. The two rules that govern
everything here (the store split and the `domain_id` naming trap) are also stated in
CLAUDE.md; this file carries the full detail.

---

## The Two Stores

Prism uses **two data stores**, split by one rule: *any table that gets joined against
customer source data inside warehouse SQL stays in the warehouse; pure app-state lives in
a local SQLite file.*

- **Warehouse (`PRISM_DB.INTERNAL`)** — `APPROVED_ALIAS_NAMES`, `LITERAL_ALIAS_MATCHES`, `PIPELINE_QUEUE`, `ONE_TIME_FILE_ROWS` / `ONE_TIME_FILE_BLOBS` (the one-time flow's uploaded rows and original file bytes), **`RUN_STATE`** (the run review state blob — moved out of SQLite 2026-07-28 for data residency: it holds the customer's distinct values), and **`VALIDATION_LOG`** (export-referee audit trail — moved for the same reason), plus streams, export tables, and the `PRISM_NORMALIZE` UDF.
- **SQLite** (`_lib/sqlite.ts`, file at `PRISM_SQLITE_PATH`, default `stand-ui/data/prism.db`) — `accounts`, `invitations`, `column_specs`, `one_time_standardizations`, **`runs`** (metadata only — the state blob is warehouse-side in `RUN_STATE`; the SQLite `state` column is dead since migration 015, which also DROPped the old SQLite `validation_log`), **`pipelines`**, **`workspace_config`** (migration 003 — single row `id=1`, the workspace service credentials saved from `/setup`; secrets `enc:v1:` encrypted), **`workspace_llm_config`** (migrations 004+005 — single row `id=1`, the company's AI-provider config: `provider` ('anthropic' | 'openai' | 'gemini'), the encrypted credential in the legacy-named `anthropic_api_key` column, and a `model` override; deliberately its own table so it can be saved without warehouse credentials).

**Data-residency rule: any table holding customer VALUES lives in the customer's
warehouse; SQLite keeps only metadata/config.**

### SQLite mechanics

Schema is created by append-only migrations in `sqlite.ts` (`PRAGMA user_version`); WAL
mode; better-sqlite3 (synchronous — no `await` on statements; `serverExternalPackages` in
`next.config.ts`). Booleans are INTEGER 0/1 (`export_unmapped_rows`); JSON columns are TEXT
(`runs.state`, `stats_snapshot`, `update_schedule`); timestamps are ISO-8601 UTC TEXT.

Migration history worth knowing:

| Migration | What it did |
|---|---|
| 002 | `runs` / `pipelines` |
| 003 | `workspace_config` |
| 004+005 | `workspace_llm_config` |
| 006 | `pipelines.update_schedule` (backfilled old `mode` rows: manual → manual-only, auto → 24/7). The legacy `mode` column physically remains but is no longer read or written |
| 007 | `pipelines.export_updated_at` |
| 008 | `pipelines.fully_synced_at` |
| 009 | `pipelines.detection_mode` / `detection_state` |
| 010 | `workspace_config.warehouse_type` |
| 011 | created `column_specs` |
| 012 | **DROPPED `domains`** |
| 013 | `pipelines.change_tracking_consent` (mssql) |
| 015 | dropped `validation_log`, scrubbed value-bearing columns (data residency) |
| 016 | dropped the file-pipeline columns (warehouse-only pipelines — files/Sheets moved to the one-time flow) |
| 017 | terms clickwrap (`terms_accepted_version` / `_at`) |
| 018 / 019 | `pg_*` / `my_*` credential columns (Postgres/MySQL ports) |
| 020 | `accounts.sf_username` (native-edition SPCS identity) |
| 021 | `pipelines.use_user_connection` (mssql user-connection pipelines) |

### Cross-store references

`PIPELINE_QUEUE.pipeline_id` → SQLite `pipelines`, `LITERAL_ALIAS_MATCHES.run_id` /
`domain_id` → SQLite `runs` / `column_specs`, … are plain integers — Snowflake never
enforced FKs anyway.

**Warehouse SQL can no longer join the moved tables**: spec names/conventions are resolved
app-side (spec lookups in `app/api/pipelines/route.ts` / `pipeline-hourly-processor.ts`);
queue↔pipeline joins are split (queue aggregates fetched from the warehouse by
`pipeline_id`, pipeline rows from SQLite, combined in app — see `fetchPipelinesWithQueue`).

The state-blob helpers (`loadOpRunState(runId, conn?)` / `saveOpRunState(runId, state,
conn?)` / `saveOpRunStateWithRev(runId, state, expectedRev, conn?)` /
`loadOpRunStatesBatch(runIds, conn?)`) are **warehouse calls** since 2026-07-28 (data
residency — the blob holds customer values): they hit `INTERNAL.RUN_STATE` via the service
connection, reusing an already-open connection when one is passed. The rev lives inside
the blob; the rev check is `COALESCE(state:rev::NUMBER,0) = ?` (Snowflake) /
`COALESCE(TRY_CAST(JSON_VALUE(state,'$.rev') AS INT),0) = ?` (mssql).

**COST RULE: never call them from recurring list/poll surfaces** (GET /api/pipelines, SSE
refetches, idle poll cycles) — review pages, exports, and the tick only. During an active
review session the 30s autosave keeps `PRISM_WH` awake — that's accepted, user-visible work.

**Export ordering across stores:** mark run `'validating'` (SQLite) → write mappings
(warehouse) → mark `'completed'` (SQLite); the `'validating'` guard keeps retries idempotent.

---

## ⚠️ The `domain_id` Naming Trap

Domains were **REMOVED 2026-07-15** (SQLite migration 012 dropped the table;
`/api/domains` and the domain picker components are gone). Their replacement is the
**per-column standardization spec** (`column_specs`, migration 011).

The physical columns are still named `domain_id` (SQLite `pipelines`/`runs`, warehouse
`APPROVED_ALIAS_NAMES` / `LITERAL_ALIAS_MATCHES`, and the
`?domain_id=` param on `/api/global-standardizations`) — **every one of them holds a
`column_specs.spec_id`**. This is a deliberate compatibility decision (renaming would touch
100+ SQL strings across two dialects with no test coverage), not an accident. New code may
keep using the column names but must never treat them as referencing a domains table —
there isn't one.

Historical removals: **Concepts** → **Domains** → per-column **specs** (2026-07-15); the
blocking **Admin Validation Stage** → replaced by the fail-open export validation referee;
**Org ID scoping** → single-tenant by definition.

---

## Active Tables

### RUNS
- `run_id` INT AUTOINCREMENT PK
- `concept_key` VARCHAR (legacy field, nullable)
- `source_relation` VARCHAR — fully qualified source table
- `source_column` VARCHAR
- `domain_id` INT — historical name, holds a `column_specs.spec_id` (nullable — NULL = no spec scope)
- `mode` VARCHAR — `'auto'` | `'manual'`
- `run_type` VARCHAR — `'normal'` (writes to the shared lookup on export) | `'one_time'` (throwaway run that exports to a standalone table and never touches the lookup)
- `created_by` INT — ACCOUNTS.account_id of the creator (scopes the one-time archive)
- `run_status` VARCHAR — `'created'` | `'running'` | `'approved'` (wizard deferred export) | `'validating'` | `'completed'` | `'failed'`
- `state` — DEAD SQLite column (NULLed by migration 015). The blob lives in warehouse `RUN_STATE`
- `stats_snapshot` VARIANT
- `creation_nonce` VARCHAR
- `created_at`, `updated_at` TIMESTAMP

### APPROVED_ALIAS_NAMES
- `alias_id` INT AUTOINCREMENT PK
- `alias_name` VARCHAR
- `domain_id` INT FK (nullable)
- `usage_count` INT
- `last_used_at` TIMESTAMP
- Unique on `(alias_name, domain_id)`

### LITERAL_ALIAS_MATCHES
- `match_id` INT AUTOINCREMENT PK
- `literal_value` VARCHAR
- `normalized_value` VARCHAR — `PRISM_NORMALIZE(literal_value)` **materialized at write time** so lookup/export joins compare a plain stored column (hash-joinable, partition-prunable) instead of re-running the JS UDF over this only-growing table. Every code path that INSERTs/MERGEs here MUST set it. If `PRISM_NORMALIZE` logic ever changes, this column must be backfilled.
- `alias_id` INT FK → APPROVED_ALIAS_NAMES (not alias_name directly)
- `domain_id` INT FK (nullable, denormalized from alias)
- `run_id` INT FK
- `confirmed_at` TIMESTAMP

### COLUMN_SPECS (SQLite, migration 011 — replaced DOMAINS)
- `spec_id` INTEGER PK AUTOINCREMENT — the lookup scope; stored into every historically-named `domain_id` slot
- `pipeline_id` INTEGER (nullable), `table_fqn` TEXT, `column_name` TEXT NOT NULL
- `description` TEXT NOT NULL — the concept definition (the concept NAME is the column name)
- `standardization_rules` TEXT (JSON array of free-text rules)
- `convention_type` / `convention_value` / `convention_rules` — naming convention (none/regex/examples/natural + structured rules)
- One spec per (pipeline_id, column_name), enforced in the routes (no UNIQUE constraint)

### VALIDATION_LOG
Append-only audit trail (**warehouse-side** since 2026-07-28 — rows contain literal values;
written on the export connection, insert failures never fail the export). Vestigial while
the referee is disabled.
- `id` INT AUTOINCREMENT PK
- `literal_value` VARCHAR
- `run_id` INT
- `original_alias_name` VARCHAR
- `user_changed_to` VARCHAR
- `llm_decision` VARCHAR — `'user'` | `'original'`
- `decided_at` TIMESTAMP

### PIPELINES
- `pipeline_id` INT AUTOINCREMENT PK
- `table_fqn` VARCHAR — fully qualified source table. Always a real warehouse table: pipelines are warehouse-only since migration 016
- `column_name` VARCHAR — the standardized column (one pipeline row per column)
- `domain_id` INT **NOT NULL** — historical name, holds the column's `column_specs.spec_id`
- `name` VARCHAR
- `export_table_fqn` VARCHAR (nullable) — warehouse export table. **For `export_kind='column'` pipelines this is pinned = `table_fqn`** (the source table IS the destination), so every rebuild trigger keyed on `export_table_fqn` fires for column mode too.
- `export_kind` TEXT — `'table'` (materialized copy, rebuilt each pass, default) | `'view'` (live view, created once; Snowflake only) | `'column'` (standardized `<col>_STANDARDIZED` companion column maintained ON the source table — NULL until standardized). A fourth UI option, "Lookup table", is `export_table_fqn = NULL` (no export object). Parse ONLY via `asExportKind()` (`_lib/export-kind.ts`, pure module) — a hand-rolled `=== 'view' ? 'view' : 'table'` coercion would silently turn a column pipeline into a table rebuild, and the builders' source==destination guard would then refuse it loudly.
- *(removed)* `source_type`, `file_source_meta`, `file_export_meta` — the file/Sheets-pipeline columns. **Dropped by migration 016**; selecting any of them throws "no such column". Files and Google Sheets are one-time sources only (`docs/FILE_PIPELINES.md`)
- `export_unmapped_rows` BOOLEAN — whether unmapped rows appear in the export with their raw values (**default false** — mapped rows only). Applies to EVERY update schedule since 2026-07-22 (the old rule hid the toggle and forced mapped-only for 24/7; removed because 24/7 pipelines also hold unmapped values between ticks, during 5k-installment backlog drains, and while paused)
- `status` VARCHAR — `'initializing'` | `'pending_baseline'` | `'active'` | `'paused'`
- `status_message` VARCHAR (nullable) — human-readable reason shown while paused/blocked (NULL = healthy)
- `status_reason` — machine-readable flag; the thing code filters on. **Never pattern-match `status_message`.**
- `update_schedule` TEXT (JSON) — `{"type":"window","days":[1..5],"start_hour":9,"end_hour":17,"timezone":"America/New_York"}` | `{"type":"always"}` | `{"type":"manual"}`. The legacy `mode` column still exists physically but is dead.
- `export_updated_at` TIMESTAMP (nullable, migration 007) — when the standardized output was last rebuilt; stamped by `refreshExportTable`. Ops/debugging only — NOT shown in the UI.
- `detection_mode` TEXT (migration 009) — `'stream'` (Snowflake) | `'ct'` (SQL Server Change Tracking) | `'diff'` (tiered scan); `detection_state` TEXT holds adapter-owned JSON (CT sync version, scan tier, heartbeat). Exposed via GET /api/pipelines (+`detection_reason`) for the ActivityTab hint/upgrade nudge.
- `change_tracking_consent` INTEGER (migration 013, mssql only, default 0) — explicit per-pipeline consent before Prism attempts to enable SQL Server Change Tracking automatically (`ALTER DATABASE`/`ALTER TABLE`, schema-modifying DDL). Mirrors the Column output mode's consent gate: set only after the connect form / AddColumnModal shows the Change Tracking disclosure (offered when `/api/columns`' `ct_status` is `'available'`) and the creator checks the consent box. Without it, `initDetection`'s `tryEnable` is always `false`.
- `use_user_connection` INTEGER (migration 021, mssql only) — see CLAUDE.md → personal connections.
- `fully_synced_at` TIMESTAMP (nullable, migration 008) — **the one customer-facing freshness timestamp**: last time the standardized table was verified fully up to date. Advances when a poll checks the source with an empty queue (nothing pending), and when a standardization pass exports everything and drains the queue; freezes while values sit queued. Stamped in `touchLastPolled` / the poller's metrics UPDATE (both `CASE WHEN queue_size = 0`), `syncTableLastPolled` (queue-empty AND only for pipelines whose poll actually consulted the source this cycle — `PollResult.checked`; a skipped/errored column must not be claimed "verified up to date" by the table-wide sync), `removeExportedFromQueue` (on drain, after the export rebuild), and `refreshExportTable` (when queue empty). Shown as **"Standardized table last updated"**; for multi-column cards the group value is the MIN across columns.
- `created_by` INT — ACCOUNTS.account_id of creator (scopes alert notifications for non-admins)
- `total_source_values` INT, `total_new_values` INT, `total_mapped` INT, `queue_size` INT
- `last_polled_at`, `last_queue_empty_at`, `updated_at` TIMESTAMP
- Unique on `(table_fqn, column_name, domain_id)`

Each active **Snowflake** pipeline has a standard (delete-aware) stream
`PIPELINE_STREAM_<pipeline_id>` in `INTERNAL`.

### PIPELINE_QUEUE
Values detected by the poller waiting for the next standardization tick. Holds ALL new
values, **including ones already standardized in the lookup** — they wait here too so the
export updates as one consistent batch instead of lookup hits trickling in per poll cycle.
Deduped on the normalized form (`PRISM_NORMALIZE`); stores a representative original
`literal_value`. Schema: `queue_id` PK, `pipeline_id` FK, `literal_value`,
`source_frequency`, `detected_at`. Unique on `(pipeline_id, literal_value)`.

### PIPELINE_FILE_ROWS (removed)
The row snapshot for file/Sheets *pipelines*. Those pipelines were removed (migration 016
on the SQLite side); `01_internal_tables.sql` now only DROPs this table if an older install
still has it, and nothing reads or writes it. Its replacement for the one-time flow is
`ONE_TIME_FILE_ROWS`, below.

### ONE_TIME_FILE_ROWS (one-time flow, file / Google Sheet sources)
Row-level snapshot of the uploaded CSV/Excel file or Google Sheet tab behind a one-time
session. Schema: `row_id` PK, `session_nonce` (the key — one-time sessions have no
pipeline), `row_num` INT, `column_data` VARIANT (JSON object with all column values keyed by
column name; JSONB on Postgres), `created_at`. Written by `POST /api/one-time/create`
(`insertOneTimeFileRows`), read per column for the distinct-value scan
(`readOneTimeDistinctValues`) and in full at export, because the export reproduces every
source row with the standardized columns substituted. It lives in the warehouse, not
SQLite, because the rows are customer values. Helpers: `_lib/op-one-time-file.ts`.

### ONE_TIME_FILE_BLOBS (one-time flow, CSV / XLSX uploads)
The ORIGINAL uploaded file's bytes, base64 and chunked, so the export can hand back the
customer's own file with only the standardized cells changed (see `docs/FILE_PIPELINES.md`
→ Edit-in-place round trip). Schema: PK `(session_nonce, chunk_num)`, `file_name`,
`file_kind` (`'csv'` | `'xlsx'`), `sheet_name` (xlsx tab, NULL for csv), `header_row`
(0-based row the user confirmed), `data` (one base64 chunk), `created_at`. The meta columns
repeat on every chunk. Chunked because a 20 MB file is about 27 MB of base64 and Snowflake
caps a VARCHAR value at 16 MB. Same lifecycle as `ONE_TIME_FILE_ROWS`
(`deleteOneTimeFileRows` clears both).

### ONE_TIME_STANDARDIZATIONS
Per-user archive of completed one-time sessions. One row per exported session: `ots_id` PK,
`created_by`, `session_nonce` (ties together the session's working RUNS),
`source_relation`, `columns` VARIANT, `export_target`, `export_mode`
(`'create'` | `'overwrite'`), `convention` VARIANT, `created_at`, `exported_at`. The
`mappings` column is DEAD (NULLed by migration 015 — mappings are customer values; the
archive route reconstructs them on demand from the session runs' warehouse `RUN_STATE`
blobs, degrading to empty if unreachable). Fully decoupled from the shared lookup.

### ACCOUNTS
- `account_id` INT AUTOINCREMENT PK
- `google_id` VARCHAR, `email` VARCHAR, `name` VARCHAR, `picture_url` VARCHAR
- `role` VARCHAR — `'admin'` | `'user'`
- `session_version` INT NOT NULL DEFAULT 1 — bumped to revoke all of the account's live sessions (cookies carry the version they were issued with; a mismatch rejects the session)
- `sf_account` / `sf_user` / `sf_warehouse` / `sf_role` / `sf_password` / `sf_private_key` — per-account Snowflake configuration (nullable; falls back to env vars). `sf_password` and `sf_private_key` are stored **app-level encrypted** (AES-256-GCM via `PRISM_ENCRYPTION_KEY`, `enc:v1:` prefix).
- `terms_accepted_version` / `terms_accepted_at` (migration 017), `sf_username` (migration 020)
- `creation_nonce` VARCHAR
- `created_at`, `last_login_at` TIMESTAMP

### INVITATIONS
Status values: `'pending'` | `'accepted'` | `'revoked'`. Expire after 7 days.

---

## Legacy Tables (droppable)

The 13 legacy deterministic-pipeline tables — `CONCEPTS`, `ALIASES`, `ALIAS_SUMMARY`,
`RAW_VALUES`, `TOKENS_SUMMARY`, `ALIAS_TOKEN_COUNT`, `GLOBAL_TOKEN_COUNT`, `RUN_GROUPS`,
`RUN_ITEMS`, `RUN_APPLIED_TARGETS`, `AUDIT_LOG`, `CLASSIFICATION_METADATA_PROFILES`,
`CONCEPT_COMPATIBILITY` — may still exist in older databases but are unreferenced by any
live code and can be dropped freely. Do not write new code against them.

---

## State Blob Structure

The warehouse table `PRISM_DB.INTERNAL.RUN_STATE` (`state` VARIANT keyed by `run_id`;
mssql: `INTERNAL.RUN_STATE`, NVARCHAR(MAX)+ISJSON) is the sole source of truth for a run's
grouping/review state.

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

**`source_frequency` is the real summed source count, on every path** (decision 2026-08-09,
REV-01). It is how many source rows collapsed into that normalized value. Warehouse
baseline runs compute it — Snowflake via `COUNT(*)` alongside the `ANY_VALUE` dedup, SQL
Server by keeping the count `diffScan` already produces — and tick-created runs take it
from `PIPELINE_QUEUE.source_frequency`. Previously the baseline path discarded it on both
adapters and stamped `1` everywhere, so the field silently disagreed with itself depending
on how the run was created; live-verified fixed. One-time runs sourced from a file or
Google Sheet also carry the real count (`readOneTimeDistinctValues` sums the rows that
collapse into each normalized value). The old file-*pipeline* path was the one exception —
its `PIPELINE_FILE_ROWS` read produced no per-value counts — and it no longer exists, but
readers still apply a `?? 1` fallback, so anything reading this field must tolerate a
missing value.

The `initial_*` fields on items are stamped at auto-group persist time for items placed in
an LLM group (never for lookup matches): the first-proposed group's alias/id/confidence.
They survive client edits (the client sends patches applied server-side to the stored blob)
and drive export-time **Case C** detection. Runs grouped before 2026-07-10 have no stamps;
Case C simply doesn't fire for them.

### Optimistic Concurrency (`rev`)

The blob carries an integer `rev` field (missing = 0). `PUT /api/run/[run_id]/state` takes
`{ state, expectedRev }`; the UPDATE only lands when the stored rev still equals
`expectedRev`. Success → `200 { rev: expectedRev + 1 }`; conflict →
`409 { error: 'conflict', currentRev }` so the client can refetch and rebase. Server-side
writers (auto-group, the export route's state patch) re-load fresh state and bump `rev`
themselves.

---

## Column Spec Management

- A spec is required for every standardized column and is locked once its run/pipeline is created. `PIPELINES.domain_id` (historical name) holds the spec_id and is NOT NULL; a spec-less run can still have `domain_id = NULL`.
- Specs are created/edited inline: **`app/components/ColumnSpecEditor.tsx`** (full editor) and **`ColumnSpecField.tsx`** (inline popover variant used in the connect form's column picker and the add-column modal). The old domain pickers (`CompactDomainPicker`, `CreateDomainModal`, `DomainSelector`) are **deleted**, as are `/api/domains` (replaced by `/api/column-specs` + `/api/column-specs/[spec_id]`; `POST /api/pipelines` also accepts the spec inline and creates it atomically).
- The shared `ColumnSpec` interface lives in `app/components/spec-types.ts`.
- Spec creation seeds pre-standardized values + convention examples into the lookup in **batches of 200** (scoped to the new spec_id; values are transient in the POST — never stored in SQLite, data residency) — 2 statements/batch, deduped on the normalized form in TS first (statement-level `NOT EXISTS` can't see same-batch duplicates, and two lookup rows sharing a `normalized_value` would break the export joins).
- Both `standardization_rules` and the spec description go verbatim into every LLM prompt — hence the caps in Scale & Input Limits (CLAUDE.md).

### Naming-convention enforcement — only `regex` and structured rules are enforced

This was previously documented as "enforced three ways" without qualification, which was
wrong for two of the four types (SPEC-04, 2026-08-08):

| Convention type | Prompt instruction | Deterministic check + name-fix repair | Review-UI rename guard |
|---|---|---|---|
| `regex` | yes | **yes** (anchored match) | **yes** |
| structured rules | yes | **yes** (`validateConventionViolations`) | **yes** |
| `examples` | yes | **no** | **no** |
| `natural` | yes | **no** | **no** |

For `examples`/`natural` with no structured rules, `requirements[]` comes out empty, so
`fixNamesForConvention` short-circuits with zero LLM calls. Those two types are **advisory
prompt-only guidance, deliberately** (decision 2026-08-08): "match these examples" has no
mechanical test, so the fix was to correct the *expectation* rather than fake enforcement.
An AI-based soft check was considered and rejected — it would cost an extra call per run to
re-ask the model something it was already told in the prompt, and still guarantee nothing.

Two consequences, both implemented. **The setup UI labels which is which**:
`ConventionEditor` shows "Enforced — Prism checks every name against this" for
regex/structured rules, and "Guidance for the AI — Prism asks the AI to follow this, but
can't mechanically check the result" for examples/natural (`ENFORCEABLE_CONVENTION_TYPES`
is the single source of truth). **The review UI displays the convention for ALL types** —
`run/[run_id]/page.tsx` used to pass `convention: null` for examples/natural, so a reviewer
working through hundreds of groups had no reminder of the contract at all; it now passes
any convention with content, carrying the same enforced/guidance label. Safe to widen
because the client's rename guard only blocks on structured rules or `type === 'regex'`.

The enforced mechanisms, for the types that have them: prompt instructions for the LLM,
deterministic normalization + validation of the model's output (with a name-fix LLM repair
loop), and **client-side rename guards in BOTH review UIs** (run review + one-time): the
mechanical form rules are auto-applied to the typed name (same treatment LLM names get),
then the rename is blocked with per-requirement reasons if it still violates the regex or a
checkable constraint. `applyCase` treats hyphens/underscores as word boundaries
("t-mobile" → "T-Mobile").

Free-text **standardization rules** are deliberately NOT blocked in the UI (natural-language
judgment, the human is the authority) — instead they're displayed as a panel at the top of
the run review page (threaded via `getRunHeader`, which LEFT JOINs `column_specs` on
`spec_id = runs.domain_id`) and handed to the export referee as context.

---

## Glossary

| Term | Definition |
|---|---|
| Column spec | Per-column standardization contract (description + rules + convention). Scopes that column's alias names via `spec_id`. Replaced Domains, which replaced Concepts. |
| Run | A processing session against one source column. Produces groups for human review. |
| Group | A proposed cluster of raw values that map to the same canonical alias name. |
| Literal Value | A distinct raw string from the source column, exactly as it appears. |
| Alias Name | The canonical correct name a group maps to (e.g. "AT&T", "Verizon"). Stored in `APPROVED_ALIAS_NAMES`. |
| Lookup Match | A previously confirmed `literal_value → alias_id` mapping stored in `LITERAL_ALIAS_MATCHES`. |
