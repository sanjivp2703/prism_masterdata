# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Prism (also called "STAND" in legacy code) is a Snowflake-native data standardization platform. It maps inconsistent text values from a source column (e.g. "att", "AT&T wireless", "a t and t") to a single canonical name (e.g. "AT&T"). Confirmed mappings accumulate into a domain-scoped lookup table and embed into the customer's data pipeline.

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
```

There is no test suite.

### Deploy SQL to Snowflake (run from repo root)

```bash
snowsql -f 00_bootstrap.sql       # create DB + schemas
snowsql -f 01_internal_tables.sql # tables + UDF + roles + grants (all-in-one)
```

That's the complete deploy — `02_public_api.sql` was dead code and has been deleted, and there are no deploy/setup shell scripts. `01_internal_tables.sql` contains commented-out `ALTER TABLE` statements at the bottom for incremental migrations.

**Demo seed (currently disabled).** `01_internal_tables.sql` carries a demo seed for `TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT` (two columns → "Mobile Carrier" / "Company Name" domains, one shared export table). As of 2026-06-14 the internal-state seeds — `DOMAINS`, the example `PIPELINES`, and the initial standardizations (`APPROVED_ALIAS_NAMES` + `LITERAL_ALIAS_MATCHES`) — are **temporarily disabled** with `TEMP:` markers (the DOMAINS insert is `--`-commented; the others are wrapped in `/* … */`). The raw source table + its sample rows are kept live. So a fresh `01` run = all tables created/empty + a populated source table (clean slate to test the from-scratch create flow). Re-enable the `TEMP:`-marked blocks to restore the demo (re-enable DOMAINS too, since the pipeline/standardization seeds resolve `domain_id` by name). The **client-side half** of the demo — prefilled table/column values in the connect form — is gated behind the `NEXT_PUBLIC_PRISM_DEMO_DATA` env flag (off by default).

---

## Environment Variables

Copy `stand-ui/.env.local.example` to `stand-ui/.env.local`.

| Variable | Purpose |
|---|---|
| `SNOWFLAKE_ACCOUNT` / `SNOWFLAKE_USER` / `SNOWFLAKE_WAREHOUSE` | Required (server-env fallback when no per-account credentials are saved in Settings) |
| `SNOWFLAKE_PASSWORD` | Password auth (fallback) |
| `SNOWFLAKE_PRIVATE_KEY` | Inline PEM private key (preferred); handle literal `\n` → real newline |
| `SNOWFLAKE_PRIVATE_KEY_PATH` | File path to PEM private key (alternative to inline) |
| `ANTHROPIC_API_KEY` | Required for LLM grouping and validation |
| `SESSION_SECRET` | HMAC key for session cookies |
| `PRISM_ENCRYPTION_KEY` | 64 hex chars (32 bytes) — AES-256-GCM app-level encryption key for stored secrets: `ACCOUNTS.sf_password`, `ACCOUNTS.sf_private_key`, and the Google `refresh_token` in `file_source_meta`. Ciphertext format `enc:v1:<iv>:<ciphertext>:<authTag>`. Generate with `openssl rand -hex 32`; store per-installation in a password manager (losing it orphans the encrypted secrets). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Google OAuth (login + Sheets export) |
| `ADMIN_EMAIL` | Bootstrap admin; all other users must be invited |
| `REDIS_URL` | Optional — enables auto-export baseline tracking; degrades gracefully if absent |
| `SMTP_*` + `APP_URL` | Email invitations |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | Optional — server/client error monitoring. Everything no-ops when unset. |
| `PRISM_DEBUG_TOOLS` | `'true'` enables the `/debug` page and `/api/admin/table` inspector. Operator-only — never set in customer installs. |
| `PRISM_DEBUG_ARTIFACTS` | Writes LLM breakdown / validation audit JSONs to the OS temp dir for debugging. |
| `NEXT_PUBLIC_PRISM_DEMO_DATA` | Enables demo prefills in the connect form (off by default). |
| `PRISM_CHUNK_MODEL` / `PRISM_MERGE_MODEL` | Optional model-ID overrides for the grouping chunk / merge LLM calls (default `claude-sonnet-4-6`). |

---

## Architecture

### Classification System (Current)

The deterministic scoring pipeline has been replaced with a single LLM call per chunk. Key principles:

- No metadata generation — no tokenization or importance scoring (the deleted legacy deterministic pipeline). Note: a lightweight matching-only normalization (`PRISM_NORMALIZE`) IS applied to compare/dedup literals — see Pipeline Subsystems; it does not generate stored metadata beyond the `normalized_value` column on `LITERAL_ALIAS_MATCHES`.
- Hash lookup first — literal value match (normalized) against `LITERAL_ALIAS_MATCHES` before any LLM call
- Single JSON blob per run — run state in `RUNS.state`, one read on page load, one write per sync, optimistic-concurrency `rev` field
- Write-first export — the user's decisions are written immediately; the async LLM validation is an amendment pass afterwards and never blocks or unwinds the write

### Legacy Code (Deleted)

The original deterministic pipeline has been **deleted from the codebase**: `grouping-phase0.ts`–`grouping-phase4.ts`, `grouping-pipeline.ts`, `grouping-llm.ts`, `grouping-utils.ts`, `feature-payload.ts`, `llm-pairscore.ts`, `llm-confidence.ts`, `redis-cache.ts`, `clique-detection.ts`, and `pairscore.ts` are gone — the last two survive only as type definitions in `app/api/_lib/grouping-types.ts` (`RunItemForPairing`, `FinalGroup`, …), which the live LLM grouping flow still consumes. `masking-policy.ts` was also deleted: the masking feature was never wired into the product — **do not claim Prism supports masking policies** (the poller's `checkSourceHealth` still *detects* policies on watched columns purely to skip/pause safely).

The 13 legacy tables (`CONCEPTS`, `ALIASES`, `ALIAS_SUMMARY`, `RAW_VALUES`, `TOKENS_SUMMARY`, `ALIAS_TOKEN_COUNT`, `GLOBAL_TOKEN_COUNT`, `RUN_GROUPS`, `RUN_ITEMS`, `RUN_APPLIED_TARGETS`, `AUDIT_LOG`, `CLASSIFICATION_METADATA_PROFILES`, `CONCEPT_COMPATIBILITY`) are unreferenced by any live code path and can be dropped from any existing database without consequence.

---

## Domain Model

| Term | Definition |
|---|---|
| Domain | Named bucket (e.g. "Drug Names", "Carrier Names"). Replaces old Concept system. Each domain scopes its own alias names. |
| Run | A processing session against one source column. Produces groups for human review. |
| Group | A proposed cluster of raw values that map to the same canonical alias name. |
| Literal Value | A distinct raw string from the source column, exactly as it appears. |
| Alias Name | The canonical correct name a group maps to (e.g. "AT&T", "Verizon"). Stored in `APPROVED_ALIAS_NAMES`. |
| Lookup Match | A previously confirmed `literal_value → alias_id` mapping stored in `LITERAL_ALIAS_MATCHES`. |

Historical removals: **Concepts** → replaced by Domains; the blocking **Admin Validation Stage** → replaced by the post-export async LLM amendment pass; **Org ID scoping** → single-tenant by definition.

---

## Database Tables

All internal tables live in `STAND_DB.STAND_INTERNAL`.

### Active Tables

**RUNS**
- `run_id` INT AUTOINCREMENT PK
- `concept_key` VARCHAR (legacy field, nullable)
- `source_relation` VARCHAR — fully qualified source table
- `source_column` VARCHAR
- `domain_id` INT FK → DOMAINS (nullable — NULL = no domain)
- `mode` VARCHAR — `'auto'` | `'manual'`
- `run_type` VARCHAR — `'normal'` (writes to the shared lookup on export) | `'one_time'` (throwaway run that exports to a standalone table and never touches the lookup)
- `created_by` INT — ACCOUNTS.account_id of the creator (scopes the one-time archive)
- `run_status` VARCHAR — `'created'` | `'running'` | `'approved'` (wizard deferred export) | `'validating'` | `'completed'` | `'failed'`
- `state` VARIANT — full JSON blob (see State Blob Structure below)
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

**DOMAINS**
- `domain_id` INT AUTOINCREMENT PK
- `name` VARCHAR

**VALIDATION_LOG** — append-only audit trail
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
- `domain_id` INT FK **NOT NULL** — every pipeline must belong to a domain (first column's domain for file-based multi-column pipelines)
- `name` VARCHAR
- `export_table_fqn` VARCHAR (nullable) — Snowflake export table (not used for file-based)
- `source_type` VARCHAR — `'snowflake'` (default) | `'sheets'` | `'csv'` | `'excel'`
- `file_source_meta` VARIANT — for file-based: `{ source_type, spreadsheet_url, spreadsheet_id, sheet_tab_name, columns: [{column_name, domain_id}], refresh_token? }` (refresh_token stored **encrypted**, `enc:v1:` format)
- `file_export_meta` VARIANT — for Sheets: `{ spreadsheet_id, spreadsheet_url, output_spreadsheet_id, output_spreadsheet_url, output_tab_name }`
- `export_unmapped_rows` BOOLEAN — whether to include unmapped rows in export (default true)
- `status` VARCHAR — `'initializing'` | `'pending_baseline'` | `'active'` | `'paused'`
- `status_message` VARCHAR (nullable) — human-readable reason shown while paused/blocked (NULL = healthy); see Pipeline Health Guards & Alerts
- `mode` VARCHAR — `'auto'` | `'manual'`
- `created_by` INT — ACCOUNTS.account_id of creator (scopes alert notifications for non-admins)
- `total_source_values` INT, `total_new_values` INT
- `total_mapped` INT
- `queue_size` INT
- `last_polled_at`, `last_queue_empty_at`, `updated_at` TIMESTAMP
- Unique on `(table_fqn, column_name, domain_id)`

Each active **Snowflake** pipeline has a standard (delete-aware) Snowflake stream `PIPELINE_STREAM_<pipeline_id>` in `STAND_INTERNAL`. File-based pipelines have no stream.

**PIPELINE_QUEUE** — values detected by the stream poller not yet standardized. Deduped on the normalized form (`PRISM_NORMALIZE`); stores a representative original `literal_value`. Schema: `queue_id` PK, `pipeline_id` FK, `literal_value`, `source_frequency`, `detected_at`. Unique on `(pipeline_id, literal_value)`. Note: for file-based pipelines this table is NOT the primary source for standardization — `PIPELINE_FILE_ROWS` is used instead.

**PIPELINE_FILE_ROWS** (file-based pipelines only) — row-level snapshot of the uploaded file or Google Sheet. Schema: `pipeline_id` FK, `row_num` INT, `column_data` VARIANT (JSON object with all column values keyed by column name). Populated at pipeline creation from the uploaded file or Google Sheet. For Sheets pipelines: refreshed on every poller cycle by `refreshSheetsFileRows`. `readFileDistinctValues` reads from this table to get processable literals.

**ONE_TIME_STANDARDIZATIONS** — per-user archive of completed one-time sessions. One row per exported session: `ots_id` PK, `created_by`, `session_nonce` (ties together the session's working RUNS), `source_relation`, `columns` VARIANT, `export_target`, `export_mode` (`'create'` | `'overwrite'`), `convention` VARIANT, `mappings` VARIANT, `created_at`, `exported_at`. Fully decoupled from the domain lookup.

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

The `RUNS.state` VARIANT column is the sole source of truth for a run. Schema:

```json
{
  "rev": 4,
  "status": "created | running | complete",
  "items": [
    { "literal_value": "VZW", "source_frequency": 14, "matched_from_lookup": false }
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
4. LLM chunking — split unmatched items into chunks of 25; send all chunks in parallel
5. Merge pass — merge all proposed groups + lookup groups; lookup names always win (matched on `normalizeLiteral(name)`)
6. Write final state blob (bumping `rev`); update `run_status` to `'running'`
- Chunks whose LLM call fails even after retries become **honest fallbacks**: self-mapped singletons with `alias_name_source = 'llm_failed'`, `confidence = 'l'`, `needs_review = true` — never silently marked high-confidence.

### 3. User Review
- State maintained in memory on client
- Autosave every 30 seconds while there are unsaved changes; `pagehide` flushes via `sendBeacon`; `beforeunload` warns when unsaved changes exist
- On a 409 the client refetches the server blob and replaces its local copy

### 4. Export — WRITE-FIRST, VALIDATE-SECOND
1. Read final state blob
2. Detect Case A / Case B deviations (no DB writes yet)
3. Mark the run `'validating'` (double-export guard — a run already `'validating'`/`'completed'`/`'failed'` does not re-trigger the write pass; repeat calls return the same counts)
4. **Write everything immediately with the user's choices taken at face value** (`writeAllDecisions`): bulk-upsert grouped items into `LITERAL_ALIAS_MATCHES` (via `alias_id` FK, setting `normalized_value`), upsert alias names into `APPROVED_ALIAS_NAMES`, increment `usage_count`. The bulk MERGE dedups its source rows on `normalizeLiteral` first (Snowflake errors on duplicate MERGE source keys).
5. On successful write → `run_status = 'completed'`. Only a failure of the write itself marks the run `'failed'` — which is retriable.
6. The async LLM validation then runs as an **amendment pass** (may flip Case A/B rows afterwards). Its failure records `validation_status: 'failed'` in the state blob and **never blocks or unwinds the write**.
7. `PIPELINE_QUEUE` cleanup after export is scoped to the run's normalized literals only (never a blanket pipeline-wide delete).

Steps 4–6 normally run in the background after the HTTP response (fire-and-forget); the wizard's `wait: true` path awaits the write.

### 5. Async LLM Validation

Fires after the write pass. Reviews only:
- **Case A** — User moved a `matched_from_lookup = true` item to a different group
- **Case B** — User renamed a `lookup_validated` alias name

Does NOT review:
- Accepted automated groupings (trusted)
- New LLM-grouped items accepted as-is
- Ungrouped items (not written to DB)

The validation LLM's output is **structurally validated against exactly what was sent** (unknown literals/aliases are ignored) before any amendment is applied. All decisions logged to `VALIDATION_LOG`.

---

## LLM Integration

**Model**: `claude-sonnet-4-6` for ALL calls — grouping chunks, merge pass, and validation. Chunk and merge model IDs are env-overridable via `PRISM_CHUNK_MODEL` / `PRISM_MERGE_MODEL` (for A/B testing).

### Reliability
- Chunk + merge calls retry **twice with backoff** on 429/5xx and **once** on a parse failure.
- A chunk that still fails after retries degrades to honest `'llm_failed'` singleton fallbacks (confidence `'l'`, `needs_review: true`) — never a silent `'h'`.
- Group confidence is the LLM's real `h`/`m`/`l` band; lookup groups are `'h'`.
- Literal values are JSON-escaped when embedded in prompts; LLM-proposed names are validated (length cap, no newlines) before use.
- The merge call uses `max_tokens: 8000`.

### Prompt Caching
The "EXISTING CANONICAL NAMES" block (top 200 domain aliases by `usage_count`) lives in the **system prompt** with `cache_control: { type: 'ephemeral' }`, so all parallel chunks share one cached prefix instead of paying for it per chunk.

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

**Async validation prompt:**
```json
{
  "case_a": [{"lv": "literal_value", "k": "u|o"}, ...],
  "case_b": [{"original_alias": "string", "new_alias": "string", "k": "u|o", "apply_to_all": true}]
}
```
- `k = 'u'` — keep user's change
- `k = 'o'` — revert to original

### Merge Name Precedence
- Lookup group + non-lookup group → always use lookup group's alias_name. Lookup-vs-LLM group reconciliation matches names on `normalizeLiteral(name)` (so casing/whitespace variants of the same name collide correctly) — this documented invariant is now true in the live merge path.
- Two lookup groups → use alias with higher `usage_count` in `APPROVED_ALIAS_NAMES`
- Two non-lookup groups → LLM proposes merged name

### Group Naming
- The group's alias name comes from the **LLM's `proposed_name`** (its real-world canonical name), threaded through `FinalGroup.proposed_name` (types in `grouping-types.ts`) and carried through the merge pass (`applyMerges` uses the merge LLM's `merged_name`). `pickBestAliasName` (a deterministic pick from the input strings) is only a **fallback** for safety-net singletons or unidentifiable entities.
- The grouping + merge prompts (`llm-one-prompt-grouping.ts`) instruct the model to: identify the real entity and use its commonly-used canonical name (may differ from any input string); prefer the full common name over an acronym (use an acronym only when it genuinely IS the common name — IBM, AT&T); and **FIRST reuse an existing approved alias name verbatim** when a group matches one.
- The domain's existing `APPROVED_ALIAS_NAMES` (top 200 by `usage_count`) are passed into both prompts as the cached "EXISTING CANONICAL NAMES" list so the model snaps new groups onto already-approved names instead of coining near-duplicates.

---

## One-Time Standardization (`app/one-time/`, `op-one-time.ts`)

A throwaway, one-shot flow: standardize one or more columns of a source table and write the result to a standalone Snowflake table (`'create'` or `'overwrite'`). Unlike the domain pipeline path, it **never reads or writes the shared lookup** (`LITERAL_ALIAS_MATCHES` / `APPROVED_ALIAS_NAMES`) — every value is grouped purely by the LLM, optionally subject to a structured naming convention (`convention-rules.ts`, edited via `ConventionEditor`). Working state lives in `RUNS` with `run_type = 'one_time'` (tied together by a session nonce); the durable archive row is written to `ONE_TIME_STANDARDIZATIONS` on export. It reuses the grouping engine (`runOnePromptGrouping`) and the run state blob. Routes live under `/api/one-time/`; the review UI is `app/one-time/[session]/`.

---

## User Flow

1. New Run → Domain selection (or create inline) → locked at creation
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
3. Data start detection (deterministic only — no LLM):
   - Skip blank rows at top
   - Detect header row (short strings, title-case, no numbers)
   - Detect title row (single cell, rest empty)
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

---

## Domain Management

- Domain required before run creation; locked after run is created. Pipelines always require a domain (`PIPELINES.domain_id` NOT NULL); a lookup-less run can still have `domain_id = NULL`.
- Default to last used domain
- The domain picker is **`app/components/CompactDomainPicker.tsx`** (select existing, search, or create inline / via `CreateDomainModal`); domains are passed in from the parent so several pickers share one list (`onDomainCreated` propagates a new domain to all). Used by BOTH the new-pipeline setup (`AutoExportHome`) and the add-column modal (`PipelinesView`). It lives in `components/` (not `AutoExportHome`) specifically because `AutoExportHome` imports `PipelinesView` — defining it in either would create a circular import. The old full-page `DomainSelector.tsx` was **deleted**.
- The shared `Domain` interface lives in `app/components/domain-types.ts`.
- Domains can carry a structured naming convention (`convention-rules.ts` + `ConventionEditor`) enforced two ways: prompt instructions for the LLM + deterministic normalization of the model's output.

---

## Accounts & Auth

- Google OAuth — default authentication (no passwords). OAuth `returnTo` is sanitized to relative paths only (`sanitizeReturnTo`).
- All users in a company share one installation (no per-user data restriction at launch)
- First user to authenticate becomes account owner (`admin` role); `ADMIN_EMAIL` bootstraps the admin
- Invitations expire after 7 days; statuses: `pending` | `accepted` | `revoked`
- Roles: `admin` | `user`

### Sessions & Revocation
- The HMAC-signed session cookie (`prism_session`) carries `v` (session version) and `exp` (7-day TTL; missing/expired ⇒ rejected). Cookies get `Secure` in production.
- `ACCOUNTS.session_version` is the revocation switch: `_lib/account-security.ts` provides `requireAdminSession` / `requireValidSession` / `bumpSessionVersion`. The version check hits the DB with a **60-second in-memory cache** and **fails open on transient DB errors** (availability over strictness); a genuine mismatch or missing account fails closed.
- Member management APIs: `GET /api/accounts/members`, `PATCH` / `DELETE /api/accounts/members/[account_id]` — with **last-admin** and **self-delete** guards. Removing a user or demoting an admin bumps their `session_version`, so their live sessions die within ~60 s.

### Error Hygiene
Snowflake error responses to clients are sanitized — no raw SQL or driver messages leak to the browser.

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
- Status pills/badges use `rounded-pill` (not Tailwind's `rounded-full`) so they pick up the sharp radius.

### Borders
- All borders: **0.5px** — non-negotiable
- Default: `0.5px solid #E5E7EB`
- Row dividers: `0.5px solid #F3F4F6`
- Drag-over active state: `2px left border #378ADD` (only exception)
- Featured card accent: `2px full border #C5D8FC` (only exception)

### Shadows
None. No box-shadows anywhere except the active toggle option (`0 1px 3px rgba(0,0,0,0.08)`) — functional only to show selected state.

### Spacing
- Page outer padding: 32px top/bottom, 40px left/right
- Card internal padding: 24px
- Group row vertical: ~13px, horizontal: ~12px
- Gap between value chips: 6px
- Gap between ungrouped chips: 8px
- Gap between group rows: 4px
- Gap between major card sections: 24px

### Copy & Tone
- Sentence case everywhere — never ALL CAPS for labels or badges
- Humanize timestamps — "May 8, 2026 · 6:54 PM" not "5/8/2026, 6:54:22 PM"
- Humanize counts — "3 values need a home" not "Ungrouped items (3)"
- Status labels — "In review", "Created", "Completed" (not "IN REVIEW")
- Empty states encouraging — "No items yet" not blank

---

## Snowflake Connection

- Two auth modes: key-pair/JWT (preferred) vs password+MFA (fallback)
- Per-account credentials (`ACCOUNTS.sf_*`, saved via Settings → Snowflake connection, stored app-level encrypted) take precedence; the server env vars are the fallback when none are saved
- `SNOWFLAKE_PRIVATE_KEY`: inline PEM — handle literal `\n` → real newline conversion before use
- `SNOWFLAKE_PRIVATE_KEY_PATH`: file path alternative — read and parse at connection time
- No connection pool — new connection per request, destroyed in `finally`
- `destroy()` always resolves — swallows "Already disconnected" errors
- MFA error 394508 → respond with "use key-pair auth" message
- Use `import 'server-only'` compile-time guard in all Snowflake utility files
- Error responses to clients are sanitized (no raw SQL/driver messages)

---

## Pipeline Update Modes

Configured at pipeline setup — available as the `mode` field in `PIPELINES`:
- **`auto`** (default): new values detected by the stream poller are queued and standardized automatically (when queue exceeds 25 items or the hourly sweep fires). Only for Snowflake pipelines.
- **`manual`**: owner triggers standardization via the "Update Standardizations → Auto-standardize" button. All file-based pipelines (Sheets, CSV, Excel) are always `manual`.

**The poller runs for ALL active pipelines regardless of mode** — including manual and file-based. Each 30-second cycle:
- **Snowflake auto**: classify stream → queue list B → LLM if queue > threshold → export rebuild for list A + deletes
- **Snowflake manual**: classify stream → queue list B → NO LLM → export rebuild for list A + deletes (already-confirmed values appear in export immediately)
- **Sheets manual**: re-read Google Sheet via stored `refresh_token` → replace `PIPELINE_FILE_ROWS` → recompute `total_source_values` / `total_mapped` / `queue_size`
- **CSV/Excel manual**: recompute metrics from existing `PIPELINE_FILE_ROWS` vs `LITERAL_ALIAS_MATCHES`

The ring/Live indicator shows for **all** active pipelines (manual included). The Pause button is hidden for manual mode. The auto-standardize loading state for file-based pipelines is tracked via local `autoStdBusyKey` state (not SSE events, which don't fire for file-based).

---

## File-Based Pipelines (Sheets, CSV, Excel)

File-based pipelines connect to uploaded files or Google Sheets instead of live Snowflake tables. They always run in `mode='manual'` — there is no auto-standardize trigger.

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

The `refresh_token` is the user's Google OAuth refresh token, stored at pipeline creation so the background poller can re-read the sheet autonomously every 30 seconds. Required for automatic metrics updates. It is stored **app-level encrypted** (AES-256-GCM via `PRISM_ENCRYPTION_KEY`, `enc:v1:` format) and decrypted only at the point of use.

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

`pollOneFilePipeline` runs every 30 s for each active file pipeline:
- **Sheets + refresh_token**: `refreshSheetsFileRows(pipelineId, meta)` — authenticates with the decrypted `refresh_token`, reads the full sheet via the paginated Sheets API, wraps `DELETE` + `INSERT` into `PIPELINE_FILE_ROWS` in an explicit `BEGIN`/`COMMIT` transaction, computes per-column metrics via SQL joining `PIPELINE_FILE_ROWS` against `LITERAL_ALIAS_MATCHES` (normalized on both sides), writes per-column metrics into `file_source_meta.columns`, and updates aggregate PIPELINES metrics
- **CSV/Excel (or Sheets without token)**: computes metrics from existing `PIPELINE_FILE_ROWS` only, writes per-column metrics into `file_source_meta.columns`, updates aggregate PIPELINES metrics. **Empty guard:** if `PIPELINE_FILE_ROWS` has zero rows (table not yet populated or data cleared), the UPDATE is skipped entirely to avoid resetting metrics to 0/0

Emits `scanning_started` / `scanning_finished` SSE events (same as Snowflake) so the ring animates correctly. Does NOT LLM-standardize anything.

### Pipeline Metrics for File-Based

- `total_source_values` = total distinct non-empty values across all standardized columns in `PIPELINE_FILE_ROWS`
- `total_mapped` = distinct values with a confirmed match in `LITERAL_ALIAS_MATCHES` (normalized join per column)
- `queue_size` = `total_source_values − total_mapped`
- **Per-column storage:** each column's `total_source_values` and `total_mapped` are stored in `file_source_meta.columns[]` (see schema above). The GET `/api/pipelines` virtual expansion reads these per-column values so that `buildPipelineGroups` sums correctly. Without per-column metrics, the row-level aggregate is duplicated to each virtual entry and summed again (double-counting bug).

---

## Pipeline Subsystems

These cover the background pipeline path — the core of the product.

### Literal Normalization (`PRISM_NORMALIZE`)
- `STAND_DB.STAND_INTERNAL.PRISM_NORMALIZE(VARCHAR)` — a JavaScript UDF in `01_internal_tables.sql`: Unicode NFC → strip control chars → collapse/trim whitespace → lowercase. Mirrored EXACTLY by `normalizeLiteral()` in `app/api/_lib/normalize.ts` (same JS engine) so in-memory matching agrees with SQL matching — **change both together** (and backfill `LITERAL_ALIAS_MATCHES.normalized_value` if the logic changes).
- Purpose: byte-variant spellings of the same value (`"AT&T "` vs `at&t`, NFC vs NFD, stray control chars) compare equal for lookups/dedup.
- **Stored column on the lookup side**: `LITERAL_ALIAS_MATCHES.normalized_value` is materialized at write time (every INSERT/MERGE must set it), so lookup/export joins compare a plain stored column — hash-joinable, partition-prunable. Only the **source side** of a join runs the UDF (`PRISM_NORMALIZE()` on the source expression). The **original** literal is still what's stored/displayed — case is folded only for the match key, so the LLM sees real casing.
- Source scans dedup with `GROUP BY PRISM_NORMALIZE(...)` + `ANY_VALUE(...)` (a representative original) instead of `SELECT DISTINCT`.
- Service role needs `GRANT USAGE ON FUNCTION PRISM_NORMALIZE` (included in the ROLES AND GRANTS block of `01_internal_tables.sql`).

### Delete-Aware Streams (NOT append-only)
- Pipeline streams are STANDARD streams (no `APPEND_ONLY`) so the poller sees inserts, updates, AND deletes.
- An UPDATE = delete-half + insert-half. The insert-half (new value) is queued/standardized; the delete-half triggers an export rebuild.
- On delete/update the **lookup table is never touched** — only the export table is rebuilt (`CREATE OR REPLACE … AS SELECT` from the current source), so rows no longer in the source drop out (~30 s).
- Legacy `APPEND_ONLY` streams are upgraded once per process (poller `SHOW STREAMS` → `CREATE OR REPLACE` if append-only). Any offset reset (upgrade or stale recreate) calls `recoverAfterStreamReset`: reconcile (unmapped → queue) **and** an export rebuild (already-mapped gap rows → export).
- Hourly safety rebuild covers mass events the stream may not cleanly surface (TRUNCATE, bulk reload, Time-Travel restore/UNDROP).

### Reconciliation Sweep & Baseline Cap
- Baseline scans cap at `LIMIT 5000` distinct values. The tail beyond the cap (and gap rows) is recovered by `reconcilePipelineQueue` / `runReconciliationSweep`: a set-based MERGE that queues unmapped distinct source values not already queued, up to `RECONCILE_QUEUE_BATCH = 5000` per pass. Runs at the start of each hourly sweep and ~15 s after boot.

### Export Table — Source-Order Preservation
- `refreshExportTable` adds a `PRISM_ROW_ORDER` column and orders rows to mirror the source, resolved by `resolveSourceOrdering` in tiers: (1) source PRIMARY KEY, (2) source CLUSTERING KEY columns, (3) ingest order via `LITERAL_ALIAS_MATCHES.match_id`. Consumers should `ORDER BY PRISM_ROW_ORDER`. The full rebuild re-derives order each time, so a previously-missing row slots into its correct place once standardized.
- Rebuilds use `CREATE OR REPLACE TABLE … COPY GRANTS AS SELECT`, so privileges granted to consumers on the export table survive each rebuild.

### Poller Cost & Failure Backoff
- **Standardization failure backoff** (`pipeline-hourly-processor.ts`): consecutive standardization failures per pipeline are tracked in memory; retries back off exponentially (`2^n` minutes, capped at 60), and after **5 consecutive failures the pipeline auto-pauses** with a `status_message` explaining why. A full success resets the counter.
- **Retries reuse the pending RUNS row** — hourly/threshold standardization runs are created with a `creation_nonce` prefixed `hourly_<pipeline_id>_`; a retry looks up and reuses the pending run for that pipeline instead of inserting a new one each attempt.
- **At most one export rebuild per table per cycle** — rebuild triggers are collected across all of a table's columns during the poll and executed once, not per column.
- **`fetchActivePipelines` is cached for 10 s** (shared by the supervisor tick and every per-table loop; invalidated whenever the poller itself changes a pipeline's status).
- **`checkSourceHealth` runs every 10th cycle per pipeline** (INFORMATION_SCHEMA + POLICY_REFERENCES queries are expensive), forced immediately after an error or while a `status_message` is set.

### Pipeline Health Guards & Alerts
- When it runs (see cadence above), `checkSourceHealth` verifies before stream work:
  - source table dropped/renamed/access-revoked, watched column dropped/renamed, or column type no longer text → **pause** + `status_message`.
  - masking / row-access policy detected on the watched column (via `POLICY_REFERENCES`) → **skip** standardization that cycle + message; auto-recovers when removed. (Detection only — Prism does not manage or integrate with masking policies.)
- `classifyPollError`: global infra (expired key, disabled user, suspended/no-credit warehouse, read-only secondary) → account-level banner + auto-resume, **no** per-pipeline pause; per-table access (revoked/not-authorized/does-not-exist) → pause; transient → retry next cycle.
- SWAP / CREATE OR REPLACE and admin-dropped streams are handled by the stale-stream recreate + reconcile path. Renames are indistinguishable from drops, so both → pause + message.
- See `pipeline-alerts.ts` for the helpers and the SSE `alert` event.

### Review-First Pipeline Creation (`pending_baseline`)
- "Create initial standardizations" inserts the pipeline as `status='pending_baseline'` (no auto-standardize) and builds a review run via `POST /api/pipelines/[id]/create-initial-run` (pre-creates the stream, then auto-groups) → opens `/run/{run_id}`.
- Run page (pipeline runs → `isAutoExport`) → **Accept Standardizations** exports to the lookup, advances `pending_baseline → paused`, returns `pipeline_id`, redirects to `/home`.
- `/home` activation card → **Begin Pipeline Standardization** → `paused → active` (poller takes over). Resuming (`PATCH status='active'`) clears `status_message`.
- `pending_baseline` cards in `PipelinesView` have their own "Create initial standardizations" button (rebuilds the review run). The one-shot `/api/pipelines/setup` route still exists but is no longer the UI's create path.
- **Card-visibility rule (don't hide a live pipeline):** `PipelinesView` hides a card while its export is still being set up for the first time — but only when the export has **no** live (active/paused) column. Compute `exportsWithLiveColumn` first; an export is hidden only if every one of its columns is `pending_baseline`. Adding a column to an already-live pipeline creates a `pending_baseline` row sharing that export, so a naive "hide if any column is pending_baseline" wrongly hides the live pipeline → a "blank pipeline page" while the new column's baseline run builds. Do not reintroduce that.
- **Add a column to an existing pipeline:** the `+` on a table card opens `AddColumnModal`; each chosen column gets a domain via the shared `CompactDomainPicker`, is created `pending_baseline` (sharing the table's export + mode), then the review wizard opens for it.

### Multi-Column Sheets Wizard

`POST /api/pipelines/file` for Sheets returns `{ pipeline_id, run_ids, column_names }` — ONE `pipeline_id` shared by all columns, one `run_id` per column. `FilePipelineConnectForm` stores `{ kind: 'create', pids: runIds.map(() => pipelineId), cols: colNames, runs: runIds }` in `sessionStorage` under `prism_ae_col_wizard` and navigates to the first run.

`RunReviewClient` reads the wizard key. For each column in sequence, the user reviews and clicks "Accept Standardizations". The export route (`POST /api/run/[run_id]/export` with `defer: true`) marks the run `approved` without writing to `LITERAL_ALIAS_MATCHES`. The wizard advances to the next column's run. After the last column, the activation card appears, and "Begin Pipeline Standardization" calls `POST /api/pipelines/[id]/commit-standardizations` to batch-write all approved columns' mappings, then advances the pipeline to `paused → active`.

The pipeline lookup in the deferred export path matches by `table_fqn` only for `source_type = 'sheets'` (not `column_name`), because all columns share one pipeline row whose `column_name` is only the first column.

Single-column Sheets pipelines skip the wizard (`runIds.length === 1`) and use the standard non-deferred export path.

### Grants (`01_internal_tables.sql` — ROLES AND GRANTS block)
- All roles and grants are consolidated in `01_internal_tables.sql` (bottom section). A single `snowsql -f 01_internal_tables.sql` is sufficient for a fresh install — no separate grants file.
- The same grant statements are executed programmatically via `app/api/_lib/grants.ts` (`buildGrantStatements` / `applyGrants`) in two places: (1) when a user saves Snowflake credentials via Settings, and (2) automatically when a new account is created (Google OAuth callback Cases 2 and 3).
- `STAND_ADMIN` = the app **service** role (full write — it writes mappings during standardization).
- `STAND_DATA_ADMIN` = a separate **human-only** role, the ONLY other role granted write on `LITERAL_ALIAS_MATCHES` / `APPROVED_ALIAS_NAMES` / `PIPELINES` (for manual SQL maintenance). Non-admin roles get no write on `STAND_INTERNAL`. Snowflake doesn't enforce CHECK/PK/FK/UNIQUE, so grants are the guardrail; read paths tolerate orphans and a rebuild self-heals.

### Identifier & String Safety
- `isSimpleIdent` (poller, hourly processor, and the `auto-export/source`, `runs`, `auto-export/poll` routes) is **permissive**: any non-empty name `quoteIdent` can safely wrap is allowed (spaces, hyphens, leading digits, Unicode letters), rejecting only control chars and `" ' \`. Every identifier is wrapped in `quoteIdent` before SQL interpolation.
- `sqlStringLiteral()` in `normalize.ts` escapes backslashes + single quotes for column names interpolated into `column_data['...']` VARIANT paths (used at 4 sites: `export-table.ts`, `op-file-pipeline.ts` ×2 conceptually, `pipeline-poller.ts`). Use it for ANY string literal built into SQL text.
- The lookup-export route parses and quotes user-supplied target FQNs part-by-part and **refuses `STAND_DB.STAND_INTERNAL` targets** (users cannot overwrite internal tables via export).

---

## Snowflake SQL Constraints

- **`PARSE_JSON(?)` is invalid in `VALUES` clauses.** Snowflake does not allow function calls around bind parameters inside VALUES. Use the `SELECT column1, column2, PARSE_JSON(column3) FROM VALUES (?, ?, ?)` pattern instead. This applies to `insertFileRows` and `refreshSheetsFileRows` in `op-file-pipeline.ts`.
- **Explicit transactions needed for multi-statement atomicity.** Snowflake auto-commits each statement by default. Wrap `DELETE` + `INSERT` (e.g. `refreshSheetsFileRows` replacing `PIPELINE_FILE_ROWS`) in explicit `BEGIN` / `COMMIT` / `ROLLBACK` to prevent a crash between statements from leaving the table empty.
- **Duplicate MERGE source keys error.** Snowflake rejects a MERGE whose source has duplicate join keys — bulk upserts must dedup their source rows first (done on `normalizeLiteral` in `op-export.ts`).

---

## Deferred / Open Items

- **`POLICY_REFERENCES` for space-containing table names:** `checkSourceHealth` builds the entity name as an unquoted string, so policy detection silently skips tables whose **name** contains spaces (degrades gracefully). Column-name spaces are unaffected. Quote the parts if needed.
- **Legal pages:** `/terms` and `/privacy` carry placeholder legal text pending counsel review.

---

## Performance Targets

- Auto Group to UI results: under 10 seconds for most runs
- LLM chunks run fully in parallel; wall time = slowest single chunk (~3–5 s)
- Hash lookup eliminates LLM calls for all previously seen values
- Blob read/write: one Snowflake query per page load, one per sync interval

---

## Key Invariants

- Lookup group alias names always win over LLM-proposed names in a merge (matched on `normalizeLiteral(name)`)
- Domain is locked at run creation — cannot be changed after
- Ungrouped items are never written to `LITERAL_ALIAS_MATCHES`
- Export is write-first: the async validation is an amendment pass and never blocks, delays, or unwinds the user's exported decisions
- State blob (`RUNS.state`) is the sole source of truth for a run's final state at export time; concurrent writers are serialized by the blob's `rev`
- `LITERAL_ALIAS_MATCHES` stores `alias_id` FK (not `alias_name` directly) and every write sets `normalized_value`
- LLM failures degrade honestly — `'llm_failed'` / confidence `'l'` / `needs_review`, never a fabricated high-confidence group
- One-time runs (`run_type='one_time'`) never touch the shared lookup

---

## Server-Side Library (`stand-ui/app/api/_lib/`)

| File | Responsibility |
|---|---|
| `snowflake.ts` | Connection factory (`withSnowflake`) + error helpers (sanitized client messages). Every API route uses this. |
| `session.ts` | HMAC-signed cookie encode/decode (`prism_session`) — payload carries `v` (session version) + `exp` (7 days); `sanitizeReturnTo`; `Secure` in production. |
| `account-security.ts` | Session revocation: `requireAdminSession` / `requireValidSession` / `bumpSessionVersion` — checks cookie `v` against `ACCOUNTS.session_version` (60 s cache, fails open on transient DB errors). |
| `crypto.ts` | App-level AES-256-GCM secret encryption (`encryptSecret` / `decryptSecret`), key from `PRISM_ENCRYPTION_KEY`, `enc:v1:` format; plaintext passthrough for unmigrated values; malformed key throws. |
| `report-error.ts` | Central error reporting: always `console.error`, forwards to Sentry when a DSN is configured, never throws. Deliberately importable from client AND server. |
| `run-header.ts` | `getRunHeader` — direct server-side run-header query used by the run page server component (no self-HTTP fetch of its own API). |
| `pipeline-broadcaster.ts` | In-process Node `EventEmitter` on `global` for SSE push to the UI. Survives hot-reloads. Event types include `alert` (banner/toast). |
| `pipeline-coordination.ts` | Per-pipeline lock tracking — prevents concurrent standardization runs on same pipeline. |
| `pipeline-alerts.ts` | Pause/resume + alert helpers: `pausePipelineWithMessage`, `clearPipelineStatusMessage`, `flagPipelineMessage`, `broadcastGlobalAlert`, `broadcastPipelineAlert`. Writes `PIPELINES.status_message` and emits SSE `alert` events. |
| `normalize.ts` | `normalizeLiteral()` — pure TS mirror of the `PRISM_NORMALIZE` SQL UDF (NFC → strip control chars → collapse/trim whitespace → lowercase); keep in sync with the UDF + stored `normalized_value` column. Also `sqlStringLiteral()` for safe string-literal interpolation. (No `server-only` — pure.) |
| `pipeline-poller.ts` | 30 s background loop for ALL active pipelines (Snowflake and file-based). Snowflake path: throttled `checkSourceHealth`, stream classify (list A/B/deletes), queue list B, LLM if queue > 25 and `mode='auto'`, one export rebuild per table per cycle. File-based path: `pollOneFilePipeline`. `fetchActivePipelines` cached 10 s. `PipelineRef` carries `source_type` so the two paths never cross. |
| `op-file-pipeline.ts` | File-based pipeline helpers. `readAllSheetRows` (paginated 10k-row reads), `a1Sheet` (A1 tab-name escaping), `syncSheetsColumn` (non-destructive full output-tab rewrite), `refreshSheetsFileRows`, `insertFileRows` / `readFileDistinctValues`, `readFilePipelineRowsForDownload`. |
| `pipeline-hourly-processor.ts` | Hourly sweep + on-demand `processPipelineQueue` (`mode='auto'` only). Failure backoff + auto-pause after 5 consecutive failures; retries reuse the pending run (`hourly_<pid>_` nonce). Also `reconcilePipelineQueue` / `runReconciliationSweep` and per-pipeline safety export rebuild. Exports `bulkProcessPipelineQueue` for initial baseline imports. |
| `op-auto-group.ts` | State-blob types (`OpRunState`, `OpGroup`, …) + load/save helpers (including the rev-checked save) — ~100 lines, nothing else. Live auto-grouping is `op-auto-group-run.ts` → `llm-one-prompt-grouping.ts`. |
| `op-auto-group-run.ts` | Live auto-grouping: normalized literal lookup → lookup groups → `runOnePromptGrouping` for unmatched → assemble state (honest `'llm_failed'` fallbacks for failed chunks). Names groups from the LLM's `proposed_name`; passes the domain's existing alias names into the LLM. |
| `llm-one-prompt-grouping.ts` | LLM grouping + merge calls (`claude-sonnet-4-6`, env-overridable). Retries (2× backoff on 429/5xx, 1× on parse failure), prompt caching (`cache_control` on the canonical-names system block), JSON-escaped literals, proposed-name validation, merge `max_tokens: 8000`. |
| `grouping-types.ts` | Shared grouping types (`RunItemForPairing`, `FinalGroup`, …) — the only survivors of the deleted deterministic pipeline. |
| `op-export.ts` | Write-first export: reads state blob, detects Case A/B, **writes all decisions immediately** (atomic Snowflake MERGE, deduped on `normalizeLiteral`, sets `normalized_value`), marks run `'completed'`, then runs the validation LLM as an amendment pass (structurally validated output; failure → `validation_status: 'failed'`, never unwinds). |
| `op-one-time.ts` | One-time standardization engine: lookup-free LLM grouping, optional naming convention, export to a standalone table, archive to `ONE_TIME_STANDARDIZATIONS`. |
| `convention-rules.ts` | Structured naming-convention rules for a domain — prompt instructions + deterministic normalization of LLM output. Pure module shared by UI and server. |
| `namescore.ts` | NameScore — deterministic "most representative literal" scoring, used as the fallback group namer. |
| `export-table.ts` | Rebuilds the pipeline's optional export Snowflake table (`CREATE OR REPLACE TABLE … COPY GRANTS AS SELECT`). Joins stored `normalized_value` vs `PRISM_NORMALIZE(source)`, adds a `PRISM_ROW_ORDER` column ordered to mirror the source (PK → clustering key → ingest order). |
| `grants.ts` | `buildGrantStatements` / `applyGrants` — programmatic role grants (Settings save + OAuth account creation). |
| `email.ts` | SMTP invitation emails. |
| `timing.ts` | `appendTiming` — phase-timing instrumentation to console + log file (`PRISM_TIMING_LOG`, default `/tmp/prism-timing.log`). |
| `redis.ts` | Optional ioredis singleton; returns `null` when `REDIS_URL` is unset. |
| `auto-export-seen.ts` | Redis-backed baseline tracking — records which values existed at pipeline setup to avoid reprocessing. |

### Background Startup (`instrumentation.ts`)

Next.js `register()` hook fires once on server start, initializes Sentry (server config), and calls:
- `startPoller()` — starts per-table self-chaining poll loops (30 s cadence) via a `superviseTables` supervisor; see the Polling Ring Animation section for the loop model
- `startHourlyProcessor()` — runs at the top of each clock hour

Both are guarded with `global.__*Started` flags to prevent duplicate intervals on Next.js hot-reloads. Neither is gated behind any mode/tier flag.

> ⚠️ **Poller/background code changes need a full dev-server restart.** Because `startPoller()` runs once (guarded by `global.__pipelinePollerStarted`) and its loops are already-scheduled closures, Next.js hot-reload does **not** replace the running poller — your edits to `pipeline-poller.ts` / `instrumentation.ts`-started code won't take effect until you stop and restart `npm run dev`. This has repeatedly masked otherwise-correct fixes; always remind the user to restart after such changes.

### SSE Real-Time Updates

`GET /api/pipeline-events` is a Server-Sent Events endpoint. The poller and processor broadcast events (`metrics_updated`, `scanning_started`, `scanning_finished`, `standardizing_started`, `standardizing_finished`, and `alert`) via `pipeline-broadcaster.ts`. The SSE route forwards all event types generically. `alert` carries `{ level: 'error'|'warning'|'info', scope: 'global'|'pipeline', message, pipeline_id?, ttl_ms? }` — `ttl_ms` tells the UI to auto-dismiss; persistent pause reasons live on `PIPELINES.status_message`. The UI reconnects automatically on close.

---

## Pipeline Detail UI (`stand-ui/app/home/PipelineDetail.tsx`)

### Polling Ring Animation (`RefreshRing`)

The `ActivityTab` shows a circular progress ring tracking the 30-second poll cycle. `RefreshRing` props:
- `pct: number` — fill 0–100
- `mode?: 'normal' | 'scanning' | 'standardizing'` — controls color and transition

| Mode | `pct` passed | Ring color | Shown when |
|---|---|---|---|
| `normal` | `(secondsSince % 30) / 30 * 100` | Blue (`var(--accent)`) | Counting toward next poll |
| `scanning` | `0` | Teal (`#0891B2`) | Backend is classifying new stream data |
| `standardizing` | `100` | Amber (`#D97706`) | LLM standardization in progress |

**Critical invariant:** `ringPct` always uses `% 30` to wrap — never `Math.min(..., 100)`. Clamping causes the ring to stick at 100% indefinitely once `secondsSince ≥ 30`.

**Sweep direction & no reset animation:** the arc fills **clockwise** (`strokeDashoffset={offset}`). There is deliberately **no reset/retract animation** — the `stroke-dashoffset` transition is only enabled while the ring is *filling* (`mode === 'normal' && filling`, where `filling = pct >= prevPct`, `prevPct` tracked in state). Any drop in `pct` — the 100→0 wrap, or the switch into the held scanning/standardizing states — snaps instantly. So the ring fills to 100% and then jumps straight into the next state instead of rewinding.

**`isScanning` is event-driven** (not a time heuristic), scoped to the **whole table**, and fires on **every** poll cycle (not only when data is found). `pollOneTable` calls `startScan()` once at the very start of the cycle — emitting `scanning_started` for EVERY `pipeline_id` in the table — and `endScan()` in a `finally` (after standardization) emitting `scanning_finished` for all of them. So the ring's lifecycle each cycle is: fill blue 0→100 → **snap to teal 0% "checking for new values"** for the duration of the poll → then either resume the cycle from 0% (no new values / values queued) or, if the queue crossed the threshold, `standardizing_started` supersedes it (teal → amber). One span for all columns ⇒ a multi-column card shows a single check, not one per column. `PipelinesView` tracks `scanningPipelines: Set<number>` and passes `scanning={cols.some(c => scanningPipelines.has(c.pipeline_id))}` → `PipelineDetail` → `ActivityTab`. `standardizing_started` clears the scanning flag on the client so teal → amber has no gap; standardization keeps the scanning span open on the backend but the client masks it via `isScanning = scanningProp && !isStandardizing`.

This event-driven model replaced an old client-only heuristic (`secondsSince >= 30 && < 50` plus a `suppressScan` cooldown) that made the ring advance into a new cycle and snap back once values were detected mid-cycle.

**Poll cadence: per-table self-chaining loops, NOT one global `setInterval`.** Each active source table runs its OWN loop (`pollTableLoop`) that schedules its next cycle `POLL_INTERVAL_MS` AFTER the current one fully finishes (in a `finally`). Two reasons over a single global chain: (1) a global chain polls each table at the chain's phase, not the table's, so a freshly-activated table's first poll lands at an arbitrary point in the ring's countdown — the "ring picks up at a random time the first time a value is added" bug; (2) with several tables a global chain's 30 s tail is shared, so each table's ring drifts by the others' poll durations. A `superviseTables` tick (every 15 s) starts a loop for any active table that doesn't have one; on starting it calls `anchorTableRing` (sets `last_polled_at = now` + `metrics_updated`) and schedules the first poll one interval later, so the very first poll lands at ring 100% and the first detection sits at the cycle boundary. Because `last_polled_at` is written at poll COMPLETION and the next poll is exactly one interval later, the ring's 30 s countdown lines up with the next poll and self-corrects every cycle; loops for a table never overlap (the chain awaits each cycle), and `superviseTables` is re-entrancy-guarded so concurrent ticks can't double-start a table. All COLUMNS of a table still poll together inside `pollOneTable` + `syncTableLastPolled` (one shared timestamp), so a multi-column card's ring stays a single aligned animation.

**Ring countdown anchor = `Math.max(last_polled_at, cycleResetMs)`.** `last_polled_at` is a server timestamp delivered by the async `metrics_updated` refetch; `cycleResetMs` is a client-clock timestamp set the instant `scanning_finished` / `standardizing_finished` arrives (tracked per `pipeline_id` in `PipelinesView.cycleResetAt`, aggregated to the card as a max and passed down as `cycleResetMs`). The reset event lands BEFORE the refetch, so anchoring to it makes the ring resume from 0% immediately instead of briefly showing the stale pre-cycle position (e.g. ~16% for a 5 s scan) and snapping back — the "continue a little, reset, continue" jank. Standardization doesn't write `last_polled_at` at all, so `cycleResetMs` is also what resets the ring after an LLM pass. Since scanning now fires every cycle, `scanning_finished` (→ `markCycleReset`) anchors the resume of every cycle, including empty polls.

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

- **Pipeline cards** (`PipelinesView.tsx`) — "Lookup table" button (download icon) in the card toolbar. Opens `ExportLookupModal` with `columns` prop containing the card's columns. For multi-column pipelines, the modal shows a column picker so the user selects which domain's mappings to export.
- **Domain cards** (`StandardizationsView.tsx`) — "Lookup table" button next to the "Standardize" button. Opens `ExportLookupModal` with `domainId` and `domainName` props (no column picker needed).

### `ExportLookupModal` (`app/components/ExportLookupModal.tsx`)

Shared portaled modal (`createPortal` to `document.body`, z-index 60). Four format options in a 2x2 grid:

- **CSV** — client-side blob: fetches from `GET /api/global-standardizations?domain_id=N`, builds CSV string, triggers download
- **Excel** — client-side blob: same fetch, dynamic `import('xlsx')`, triggers `.xlsx` download
- **Google Sheets** — `POST /api/global-standardizations/export` with `{ format: 'sheets', domain_id, domain_name }`. Handles 401 → Google OAuth redirect. Opens the created sheet in a new tab.
- **Snowflake** — `POST /api/global-standardizations/export` with `{ format: 'snowflake', domain_id, domain_name, snowflakeTableFqn? }`. Shows an optional target table name input; default is `STAND_DB.PUBLIC.<DOMAIN>_LOOKUP`. The route parses/quotes the user-supplied FQN part-by-part and refuses `STAND_DB.STAND_INTERNAL` targets.

### `POST /api/global-standardizations/export` Extensions

The export route accepts optional `domain_id` and `domain_name` in the request body. When `domain_id` is provided, the lookup query is filtered to that domain. `domain_name` is used for the Google Sheet title and the default Snowflake table name.

---

## Settings, Debug & Top-Level Pages

The old `/admin` page is gone, split into:

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

- **One long-lived Node process per installation is REQUIRED.** The poller loops, per-pipeline locks, and the SSE broadcaster are all in-process — serverless/multi-instance deployments break them. Deploy as a single persistent `next start` (or equivalent) process.
- **Single-tenant:** one deployment + one customer Snowflake account per company. There is no cross-tenant isolation inside the app.
- **`xlsx` is installed from `cdn.sheetjs.com`** (pinned `0.20.3` tarball in `package.json`) — `npm install` may need network access to that host.

---

## File/Folder Conventions

- All Snowflake-touching and secret-touching `_lib` files include `import 'server-only'` (`snowflake.ts`, `crypto.ts`, `account-security.ts`, `op-auto-group.ts`, `op-auto-group-run.ts`, `op-export.ts`, `op-file-pipeline.ts`, `op-one-time.ts`, `export-table.ts`, `grants.ts`, `email.ts`, `redis.ts`, `auto-export-seen.ts`, `pipeline-broadcaster.ts`, `pipeline-coordination.ts`, `pipeline-alerts.ts`, `pipeline-hourly-processor.ts`, `run-header.ts`, `timing.ts`). Intentional exceptions: `normalize.ts`, `convention-rules.ts`, `grouping-types.ts`, `namescore.ts` (pure modules shared with the client) and `report-error.ts` (deliberately client-safe).
- API routes for run operations: `/api/run/[run_id]/...`
- Pipeline API routes: `/api/pipelines/...`; one-time routes: `/api/one-time/...`; member management: `/api/accounts/members...`
- Snowflake field names come back uppercase; normalise with `r.FIELD_NAME ?? r.field_name` pattern everywhere
- Shared UI components live in `app/components/` (`CompactDomainPicker`, `CreateDomainModal`, `ExportLookupModal`, `Toast`, `RoleBadge`, `ConventionEditor`, `DomainChangeWarning`, `UserMenu`, plus the `domain-types.ts` `Domain` interface)
