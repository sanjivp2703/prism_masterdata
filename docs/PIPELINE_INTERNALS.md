# Pipeline Internals — Scheduling, Poller, Detection, Export, Cost

Read this before touching the poller, the standardization tick, export builders, health
guards, or anything that runs on a timer. Per-warehouse operation details live in
docs/WAREHOUSES.md; this file is the cross-warehouse behaviour and the reasoning.

---

## Pipeline Update Time Windows

The old auto/manual `mode` is gone. Every pipeline carries an **update schedule**
(`PIPELINES.update_schedule` JSON, types + evaluation in `_lib/update-schedule.ts`, edited
via the shared `app/components/UpdateScheduleEditor.tsx` in both the connect form and the
card's Settings tab):

- **Time window** (`{"type":"window","days":[…],"start_hour":H,"end_hour":H,"timezone":"…"}`) — the creation **default is Mon–Fri, 9 AM–5 PM** in the creator's browser timezone (IANA name stored on the schedule; missing/invalid timezone → evaluated in server time). Days use JS `getDay()` encoding (0=Sun); `start_hour` inclusive, `end_hour` exclusive; an inverted window (22→6) wraps overnight. Prism auto-standardizes only while the window is open — the 10-minute tick checks `isScheduleActiveNow()` at fire time. Values arriving outside the window are queued and drain at the first tick after it opens.
- **24/7** (`{"type":"always"}`) — every 10-minute tick. Existing `mode='auto'` rows were backfilled to this (migration 006).
- **Manual only** (`{"type":"manual"}`) — Prism never auto-standardizes; the owner triggers it via "Update Standardizations". All file-based pipelines (Sheets, CSV, Excel) are always manual-only (hard-coded at creation; no schedule picker).

Only warehouse-table pipelines can have window/always schedules. The manual "Update
Standardizations" trigger works for every schedule type.

### The poll pass (every minute mark)

**The poller runs for ALL active pipelines regardless of schedule** — including manual-only
and file-based — but it ONLY detects and queues; it never standardizes inline. One poll
pass fires at every wall-clock MINUTE mark (2:33:00, 2:34:00, … —
`Date.now() % POLL_INTERVAL_MS`, self-chaining so passes never overlap; all tables polled
concurrently per pass, newly-activated pipelines picked up at the next mark). Each pass,
per pipeline:

- **Snowflake**: classify stream (list A = already in the lookup, list B = new/unmapped — informational split, logs only) → **queue EVERYTHING** (list A + list B) → update `total_source_values` / `queue_size`. Deletes (and null-only inserts) still trigger an immediate hygiene rebuild.
- **Sheets**: re-read Google Sheet via stored `refresh_token` → replace `PIPELINE_FILE_ROWS` → recompute `total_source_values` / `total_mapped` / `queue_size`
- **CSV/Excel**: recompute metrics from existing `PIPELINE_FILE_ROWS` vs `LITERAL_ALIAS_MATCHES`

All COLUMNS of a table poll together inside `pollOneTable` + `syncTableLastPolled` (one
shared `last_polled_at`). The old per-table self-chaining loops + `superviseTables`
supervisor existed only to phase-align the removed countdown ring — deleted 2026-07-13.

### The 10-minute standardization tick

`startQueueProcessor` (`pipeline-hourly-processor.ts`, started from `instrumentation.ts`)
fires at every 10-minute WALL-CLOCK mark (1:00, 1:10, … — `Date.now() % QUEUE_TICK_MS`,
aligned to the clock, not to process start or pipeline creation; self-chaining so ticks
never overlap and a long run skips to the next mark). Each tick drains **any non-empty
queue** (no size threshold) for every window-open pipeline, grouped by table, via
`standardizeTable` → `processPipelineQueue`. Replaced the old >25-queue threshold + hourly
sweep in 2026-07-13.

The **top-of-hour tick** additionally runs the reconciliation sweep + safety export rebuilds
first (kept hourly — they full-scan sources and rebuild every export). **The sweep is
window-aware (2026-08-06, KI-88/KI-115):** it skips pipelines whose `update_schedule` is an
*explicitly stored* `window` that is closed right now. `always` (24/7) and `manual`
pipelines are always swept, and so is any pipeline whose stored schedule is
missing/unparseable — the sweep **fails open**, because a safety net must keep running when
it cannot read its own configuration (`parseStoredSchedule` otherwise defaults a NULL/corrupt
value to Mon–Fri 9–5, which would silently stop overnight sweeps). Manual-only is
deliberately NOT excluded: the sweep is its only automatic recovery from a mass event, and
since the manual "Update Standardizations" button drains the QUEUE, values the sweep never
queued would not be standardized by a manual click either. Rationale: the sweep re-reads the
source (never metadata-only), so it woke the warehouse 24×/day regardless of activity — ~24
billed minutes/day on an idle install. A Mon–Fri 9–5 pipeline now sweeps 40×/week instead of
168×. The per-pipeline failure backoff still applies inside `processPipelineQueue`.

### Consistent-snapshot export

New source values — *even ones already standardized in the lookup* — never fast-path into
the export at the end of a poll cycle. They wait in `PIPELINE_QUEUE` and reach the export
together at the next tick, so the export table is always "fully updated as of its last
update" with no values trickling in between.

> **⚠️ Exception — raw passthrough (`export_unmapped_rows = true`), 2026-08-18 owner
> decision.** The rule above governs the DEFAULT (toggle off). When a pipeline opts into
> exporting unmapped rows, the export's contract is "mirror the source, standardized where
> known" — so a detected value that is invisible until the next tick is simply the toggle
> not working. All four pollers therefore set `needsExportRefresh` when a poll queues new
> values on a `table`-kind export with the toggle on (Snowflake: `rawPassthroughRebuild`;
> mssql CT branch triggers on any change reported, since a new row of an already-KNOWN value
> queues nothing yet still has to appear). Two consequences: the export can now show a raw
> value at detection and its standardized form after the tick (that is the toggle's whole
> point), and on Snowflake a rebuild wakes `PRISM_WH`, so an opted-in pipeline with a busy
> source pays for a rebuild per change-bearing poll cycle instead of one per tick. Idle
> cycles are unaffected — no new values, no rebuild.

Consequences wired into the code:

- The poller's consuming MERGE queues ALL new non-null values (no `lam.literal_value IS NULL` filter); the classify's list A/list B split is only for logs.
- The poller no longer bumps `total_mapped` at poll time (list A used to `+=` immediately); counters are recomputed absolutely at each rebuild, so the card describes the exported snapshot.
- **A tick whose queue is 100% lookup hits makes ZERO LLM calls** — `runAutoGroupForRun` hash-matches them against `LITERAL_ALIAS_MATCHES` and only calls `runOnePromptGrouping` when unmatched items exist; the export still rebuilds, publishing them.
- Export rebuild triggers in the poll cycle are row-level hygiene only: deletes and null-only inserts. (Any rebuild is CREATE OR REPLACE from live source, so hygiene rebuilds may incidentally surface queued values early — the guarantee is that new values never *cause* a rebuild.)

**Export shape is time-independent:** `refreshExportTable`'s include-unmapped-raw behavior
(LEFT JOIN + `export_unmapped_rows` setting) is keyed ONLY on the stored setting — never on
the schedule type or on whether the window is open at rebuild time — so the export's row set
never flips with the clock. Since 2026-07-22 the setting applies to **every** schedule, 24/7
included, and **defaults off**. The connect form shows the toggle for all schedules, and it
is **editable post-creation** in the card's Settings tab (PATCH accepts
`export_unmapped_rows`; the client fires one refresh-export after saving so the change lands
immediately — for views that recreates the view). The "Mapped only" card badge was removed
2026-07-24 at the user's request — the setting is visible only in the card's Settings tab
(do not reintroduce the badge).

UI notes: the Live indicator shows for **all** active pipelines. The Pause button is hidden
for manual-only schedules. The card badge shows the schedule label (`scheduleLabel()`:
"Mon–Fri, 9 AM–5 PM" / "24/7" / "Manual only") with the "Standardized table last updated X
ago" freshness timestamp (`fully_synced_at`) beneath it (an amber "Standardizing…" pulse
while a pass runs). The auto-standardize loading state for file-based pipelines is tracked
via local `autoStdBusyKey` state (not SSE events, which don't fire for file-based).

---

## Convention Regexes Run on RE2, Never the Backtracking Engine

A naming-convention regex is user-authored and is matched against raw source literals **on
the single Node thread**. `new RegExp` backtracks, so a pattern like `(a+)+b` never returns
— measured still running after 60 s against a 200-char input — and a running regex **cannot
be interrupted**, so it freezes the whole installation: UI, poller, every pipeline, with
nothing crashing and nothing logged. Capping the input was tried and does **not** bound it
(these patterns hang at ~40 chars).

Since 2026-08-08 the server compiles every convention regex with **RE2**
(`_lib/safe-regex.ts`, `re2-wasm`) — a linear-time engine that cannot backtrack. Same
pattern, 5 ms. `compileSafeRegex` returns null for a construct RE2 cannot express
(backreferences, lookahead, lookbehind); **null means "cannot enforce", never "fall back to
`new RegExp`"** — that fallback would reinstate the hang. `safeRegexError` gives the save
path a user-facing reason naming the construct.

Save-time keeps **both** checks, and they are not redundant: RE2 decides what the server can
enforce, while `isProbablyCatastrophicRegex` keeps catastrophic shapes out of storage
because the **browser** still uses plain `new RegExp` for the review UI's rename guard (a
one-tab freeze, not worth shipping wasm to the client to prevent). The cost is that a few
patterns RE2 could safely run are rejected at save — a deliberate trade. Parity-tested: the
server match sites must use `compileSafeRegex`, and `safe-regex.ts` must never contain
`new RegExp`.

---

## Literal Normalization (`PRISM_NORMALIZE`)

- `PRISM_DB.INTERNAL.PRISM_NORMALIZE(VARCHAR)` — a JavaScript UDF in `01_internal_tables.sql`: Unicode NFC → strip control chars → collapse/trim whitespace → lowercase. Mirrored EXACTLY by `normalizeLiteral()` in `app/api/_lib/normalize.ts` (same JS engine) so in-memory matching agrees with SQL matching — **change both together** (and backfill `LITERAL_ALIAS_MATCHES.normalized_value` if the logic changes).
- Purpose: byte-variant spellings of the same value (`"AT&T "` vs `at&t`, NFC vs NFD, stray control chars) compare equal for lookups/dedup.
- **Stored column on the lookup side**: `LITERAL_ALIAS_MATCHES.normalized_value` is materialized at write time (every INSERT/MERGE must set it), so lookup/export joins compare a plain stored column — hash-joinable, partition-prunable. Only the **source side** of a join runs the UDF. The **original** literal is still what's stored/displayed — case is folded only for the match key, so the LLM sees real casing.
- Source scans dedup with `GROUP BY PRISM_NORMALIZE(...)` + `ANY_VALUE(...)` instead of `SELECT DISTINCT`.
- Service role needs `GRANT USAGE ON FUNCTION PRISM_NORMALIZE` (included in the ROLES AND GRANTS block of `01_internal_tables.sql`).
- ⚠️ **Always write the UDF FULLY QUALIFIED (`PRISM_DB.INTERNAL.PRISM_NORMALIZE(...)`) in generated SQL — never bare.** Snowflake resolves an unqualified name in a **stored view body** against the *view's own schema*, not the session schema the view was created in. Bare calls therefore worked everywhere the statement ran in-session (schema = `INTERNAL`) but broke `CREATE VIEW` for every export destination outside `PRISM_DB.INTERNAL` — i.e. every realistic customer destination — with "Unknown function PRISM_NORMALIZE" (KI-149; fixed 2026-08-04 by qualifying all 29 call sites). Qualifying also removes the latent dependency on the `SNOWFLAKE_SCHEMA` env override.

---

## Delete-Aware Streams (NOT append-only)

- Pipeline streams are STANDARD streams (no `APPEND_ONLY`) so the poller sees inserts, updates, AND deletes.
- An UPDATE = delete-half + insert-half. The insert-half (new value) is queued/standardized; the delete-half triggers an export rebuild.
- On delete/update the **lookup table is never touched** — only the export table is rebuilt (`CREATE OR REPLACE … AS SELECT` from the current source), so rows no longer in the source drop out (within the next minute-mark poll pass).
- Once per process per pipeline the poller checks the stream via `SHOW STREAMS` (metadata-layer): **missing** → create + full gap recovery (rows inserted while no stream existed are invisible to the fresh stream — never `CREATE IF NOT EXISTS` without recovery; a swallowed initial-run pre-create failure once left a pipeline streamless and 2 already-mapped inserts undetected); **APPEND_ONLY** (legacy) → upgraded via `CREATE OR REPLACE`.
- **Change tracking is a hard prerequisite** — creating a table's FIRST stream auto-enables it, which requires MODIFY (the service role has only SELECT). Snowflake's "Insufficient privileges … without CHANGE_TRACKING enabled" error (`isChangeTrackingPrivilegeError`) is handled by an **auto-fix**: enable change tracking via the pipeline creator's saved personal credentials (`withUserWarehouse`), then create the stream and recover — done synchronously at setup (`create-initial-run`) and fire-and-forget from the poller (`attemptChangeTrackingFix`, in-flight-guarded; covers a customer `CREATE OR REPLACE`ing their table, which wipes change tracking). When the creator has no saved credentials or the ALTER fails, the pipeline pauses (poller) or is flagged (setup) with the exact fix SQL — this failure looped invisibly every cycle once; never let it be silent. The demo table in `02_demo_data.sql` is created with `CHANGE_TRACKING = TRUE`.
- Any offset reset (missing-create, upgrade, or stale recreate) calls `recoverAfterStreamReset`: reconcile (unmapped → queue) **and** an export rebuild (already-mapped gap rows → export directly — they can't be queued because the queue is value-level and recovery can't tell which ROWS of a known value are new; metrics recount at the rebuild). These reset paths update `last_polled_at` with `claimSynced: false` — they must not stamp `fully_synced_at` while gap rows are still being recovered.
- Hourly safety rebuild covers mass events the stream may not cleanly surface (TRUNCATE, bulk reload, Time-Travel restore/UNDROP).

---

## NULL and Blank Source Values

A NULL cell is "standardized as-is": it is not a source value, never queued, and
exports unchanged. Since 2026-09-14 a **blank** cell — anything `normalizeLiteral`
reduces to `''` (empty string, whitespace-only, control-characters-only) — gets
exactly the same treatment, on every path and every warehouse:

- source counts (`total_source_values`), the baseline scan, the stream
  classify + queue MERGE, and the reconciliation sweep all filter with
  `notBlankSql` (Snowflake, runs the UDF) or the dialects' `notBlankPredicate`
  instead of a bare `col IS NOT NULL`;
- the mapped-only export keeps a blank row the way it keeps a NULL row
  (`isBlankSql` in the WHERE);
- the queue drain (`fetchQueueLiteralsWithFreq`) purges any blank row it finds.

Why this matters: `''` IS NOT NULL on every warehouse, so the SQL side counted a
blank cell as a source value while every app-side path dropped it
(`filter(Boolean)`, `if (!val)`, the alias-name filter — no alias name can be
blank). The cell showed as "Unstandardized: 1" on the card with no path that
could ever write it to the lookup, and both standardize buttons were silent
no-ops. Found on the first client-test install.

Related: "Update Standardizations" (process-queue) and manual review
(standardize-run) now run `reconcilePipelineQueue` first when the queue is
empty. The stat is source-minus-lookup; the queue is only what detection
captured; a value the baseline review left unmapped, or one the stream missed,
is invisible to the queue until the top-of-hour sweep — an explicit click may
pay for that one-off source scan, and the client always reports the outcome.

## Reconciliation Sweep & Baseline Cap

- Baseline scans cap at `LIMIT 5000` distinct values. The tail beyond the cap (and gap rows) is recovered by `reconcilePipelineQueue` / `runReconciliationSweep`: a set-based MERGE that queues unmapped distinct source values not already queued, up to `RECONCILE_QUEUE_BATCH = 5000` per pass. Runs at the start of each top-of-hour tick.
- **Standardization runs drain the queue in 5,000-value installments** (`fetchQueueLiteralsWithFreq` has `LIMIT 5000`, FIFO by `detected_at`): a bulk load that floods the stream with tens of thousands of new distinct values becomes several sequential runs across successive 10-minute ticks (manual trigger = one 5k installment per click, `queue_size` shows the remainder). The queue itself is uncapped — it's the persistent buffer; stream consumption + queue MERGE are transactional, so no values are lost between them.

---

## Export Table — Source-Order Preservation

- **No synthetic ordering column** (the old `PRISM_ROW_ORDER` and its ingest-order fallback were removed 2026-07, user decision): the export contains ONLY the source's columns (watched ones replaced by canonical names). `resolveSourceOrdering` orders the TABLE build to mirror the source only when the source declares its own ordering basis, in tiers: (1) PRIMARY KEY, (2) UNIQUE KEY (first constraint by name), (3) CLUSTERING KEY columns — detected via metadata-layer `SHOW PRIMARY KEYS / SHOW UNIQUE KEYS` + `INFORMATION_SCHEMA.TABLES.CLUSTERING_KEY`. A source with none of these gets an unordered export.
- Consumers needing guaranteed order `ORDER BY` the key columns themselves (they exist in the export) — **this is the only guarantee, and it is not optional advice.** The physical CTAS sort clusters the data on the source's key; it does NOT make a plain `SELECT *` come back in that order. Live-reproduced 2026-08-09 (OPS-07A): on a 15-row export, 3 of 6 rebuild-then-raw-read trials returned the two micro-partitions in reverse order, even with `SYSTEM$CLUSTERING_INFORMATION` reporting perfect clustering (`average_overlaps: 0.0`, `average_depth: 1.0`). Snowflake simply does not order an unordered SELECT across micro-partitions. 15 rows already produced two partitions, so a real customer table hits this MORE often, not less. The sort is still worth doing — it makes ordered reads cheap — but never tell a customer their export reads back in source order. Views are never given an ORDER BY (order isn't preservable through a view).
- Rebuilds use `CREATE OR REPLACE TABLE … COPY GRANTS AS SELECT`, so privileges granted to consumers on the export table survive each rebuild.
- **Views are created exactly once, at activation** (`PATCH status='active'`, fire-and-forget) — the poller/tick never touch them, so that single attempt failing (e.g. missing `GRANT CREATE VIEW` on the export schema) used to leave a healthy-looking pipeline with no view and no retry anywhere. Since 2026-07-22: an activation-time export failure is flagged on the card (`flagPipelineMessage`, curated per-kind message — never raw driver text), and `POST /api/pipelines/[id]/refresh-export` runs for views too ("Recreate view now" button in the card's Settings tab), doubling as the repair path; a successful manual refresh clears the flag on active pipelines.

---

## Standardized-Column Output (`export_kind = 'column'`)

The fourth output mode ("Column" in the connect form, added 2026-07-22): Prism maintains a
`<col>_STANDARDIZED` companion column ON the customer's source table — canonical name where
the raw value has a confirmed mapping, NULL otherwise. Name comes from the shared
`standardizedColumnName()` helper (`_lib/export-kind.ts`) — used by BOTH warehouse
implementations and shown verbatim in the setup copy; parity-tested.

Implementations: `refreshStandardizedColumnsSnowflake` (in `export-table.ts`) and
`refreshStandardizedColumnsMssql` (in `warehouse/mssql/export.ts`, reusing the shared
`materializeAliasStaging` staging builder). Dispatched from `refreshExportTable` on kind
`'column'` — all existing call sites (poller hygiene, tick, activation, refresh-export
route, op-export) work unchanged because column pipelines store
`export_table_fqn = table_fqn`.

- **Never creates/drops/replaces a table.** First run adds the missing companion column(s) via `ALTER TABLE ADD COLUMN` (Snowflake: needs table OWNERSHIP; mssql: ALTER permission); every run then applies two guarded UPDATEs per column (set changed mapped values via `EQUAL_NULL`-style change guards; NULL-out no-longer-mapped rows). Privilege failures throw a message containing the exact ALTER/GRANT SQL for the customer's admin — the poller surfaces it as a pause `status_message`.
- **The change guards are load-bearing:** the pipeline's own stream/CT watches the source table, so Prism's writes are re-detected next poll. Because re-detected values are already in the lookup (no LLM cost) and the follow-up sync updates 0 rows (guards), the echo settles after one cycle instead of churning forever. Do not remove the `WHERE …changed` conditions.
- **Data-loss guard:** the table/view rebuild paths in BOTH builders throw if the export destination equals the source table — a mis-parsed export_kind can therefore never `CREATE OR REPLACE` the customer's source. Related: parse `export_kind` only via `asExportKind()`.

**Source-column guardrails (2026-07-22, do not weaken):**

1. `assertCompanionColumnSafe(writeTarget, watchedRawColumns)` (`export-kind.ts`, pure, parity-tested) — every column-mode write path calls it immediately before building ALTER/UPDATE statements; it throws unless the target is exactly a watched column's `standardizedColumnName()` companion and collides with no watched raw column.
2. Creation-time conflict refusal: `POST /api/pipelines` calls `assertCompanionColumnAvailable` for new column-mode pipelines and 400s with `CompanionColumnConflictError` when `<col>_STANDARDIZED` already exists on the source — Prism can't distinguish its own column from customer data, so pre-existing names are never written into (a leftover companion from a deleted Prism pipeline must be dropped manually to reconnect).
3. The connect form shows an unmissable warning panel on the Column option (how the table is edited, never-touch-existing-columns intent, no-liability statement, recommendation against unrecoverable data) with a **required consent checkbox** — the API 400s `export_kind='column'` without `column_write_consent: true` (AddColumnModal restates the notice for new columns on a column-mode table and sends the flag).
4. **Write access is per-table, consent-gated — onboarding grants none**: on creation the POST runs `provisionColumnModeAccess` via the creator's personal credentials (change-tracking-fix pattern) — companion `ADD COLUMN IF NOT EXISTS` (needs table ownership, which UPDATE doesn't confer — this is why the service connection can't do it at sync time) + `GRANT UPDATE ON TABLE <that table>`; failure/no-creds → pipeline flagged with the exact SQL (`columnModeSetupSql`, both dialects) and the warehouse itself refuses every write until an admin runs it.

**Column mode must pass docs/PRELAUNCH_CHECKLIST.md §1 (live source-integrity test) before
any customer deployment.**

UI: the Settings tab shows no destination input for column pipelines (destination is pinned)
and `handleSave` omits `export_table_fqn` from the PATCH; the manual button reads "Sync
standardized columns now" (same refresh-export route).

---

## Poller Cost & Failure Backoff

- **Standardization failure backoff** (`pipeline-hourly-processor.ts`): consecutive standardization failures per pipeline are tracked in memory; retries back off exponentially (`2^n` minutes, capped at 60), and after **5 consecutive failures the pipeline auto-pauses** with a `status_message` explaining why. A full success resets the counter.
- **Retries reuse the pending RUNS row** — tick-driven standardization runs are created with a `creation_nonce` prefixed `hourly_<pipeline_id>_` (historical prefix); a retry looks up and reuses the pending run for that pipeline instead of inserting a new one each attempt.
- **At most one export rebuild per table per cycle** — rebuild triggers are collected across all of a table's columns during the poll and executed once, not per column.
- **`fetchActivePipelines` is cached for 10 s** (shared by the supervisor tick and every per-table loop; invalidated whenever the poller itself changes a pipeline's status).
- **The 10-minute tick must not wake `PRISM_WH` on an idle install either.** `fetchPipelinesWithQueue` reads SQLite FIRST (active + warehouse + window-open), then short-circuits on the `pipelines.queue_size` mirror, and only opens a warehouse connection when the mirror says work might exist. It previously ran its `SUM(source_frequency)` query against `PIPELINE_QUEUE` unconditionally every tick — 144 warehouse resumes/day on a source that never changes, each billing a 60-second minimum. It only *looked* fine because Snowflake's 24h result cache served the byte-identical query; that is an opportunistic optimization, not a guarantee, and it evaporates the moment any pipeline's queue changes. The mirror is trustworthy because every writer into `PIPELINE_QUEUE` updates it in the same breath (poller MERGE, `reconcilePipelineQueue`, `removeExportedFromQueue`); a NULL `queue_size` **fails open** (treated as possible work) since a missed pass is worse than one extra wake.
- **Idle-cycle discipline (Phase 4):** an idle poll cycle (stream reports no data, local queue mirror is 0) touches ONLY metadata-layer operations — `CREATE STREAM IF NOT EXISTS`, `SYSTEM$STREAM_HAS_DATA` (cloud services), SQLite, SSE — and never wakes `PRISM_WH`. The idle-branch backlog check queries `PIPELINE_QUEUE` only when the SQLite `pipelines.queue_size` mirror is > 0. A failed `CREATE STREAM` (dropped/renamed source) sets `lastPollErrored` so the health check runs next cycle and pauses the pipeline with a message.
- **`checkSourceHealth` runs on data-bearing cycles only** (every 10th such cycle per pipeline — its POLICY_REFERENCES probe can wake the warehouse; the column check itself is a metadata-only `SHOW COLUMNS`, never a `SELECT` against `INFORMATION_SCHEMA.COLUMNS`, which resumed the warehouse and was once the account's most expensive query). It's forced immediately after an error; while a `status_message` is set it re-checks on an exponential backoff (2, 4, 8… cycles, capped ~5 min) instead of every cycle.

---

## Pipeline Health Guards & Alerts

When it runs (see cadence above), `checkSourceHealth` verifies before stream work:

- source table dropped/renamed/access-revoked, watched column dropped/renamed, or column type no longer text → **pause** + `status_message`. (Checked via `SHOW COLUMNS IN TABLE` — a missing table throws "does not exist or not authorized" rather than returning zero rows; `data_type` comes back as a JSON blob whose `type` field is `TEXT` for all varchar flavors. Exact-case quoted identifiers, same as the rest of the poller.)
- masking / row-access policy detected on the watched column (via `POLICY_REFERENCES`) → **skip** standardization + message; auto-recovers (re-checked on the exponential backoff) when removed. (Detection only — Prism does not manage or integrate with masking policies.)

**A "skip" flag must block EVERY standardization entry point, not just the poll cycle.**
`flagPipelineMessage(pid, msg, level, reason)` writes a machine-readable
`PIPELINES.status_reason` alongside the human `status_message`; `PIPELINE_BLOCK_REASONS` +
`NOT_BLOCKED_SQL` (`pipeline-alerts.ts`) are the shared gate, and the 10-minute tick, the
reconciliation sweep, and `POST /api/pipelines/[id]/process-queue` (409) all apply it. Until
2026-08-07 the masking flag was **advisory prose only**: the tick and sweep read `PIPELINES`
without consulting it, so a masked column's values were queued, LLM-standardized, and
written PERMANENTLY into `LITERAL_ALIAS_MATCHES` within about an hour — indistinguishable
from legitimately confirmed mappings — while the card told the user "standardization
skipped". **Never pattern-match `status_message` in code**; it is prose for the card.
Anything that needs to *act* on a flag filters on `status_reason`. Parity-tested (the SQL
fragment must stay derived from the reason list, and must admit unflagged/NULL pipelines — a
gate that accidentally excluded healthy pipelines would silently stop all automatic
standardization).

**`POLICY_REFERENCES` identifier quoting — FIXED 2026-08-07, do not regress.** `checkSourceHealth`
used to build `REF_ENTITY_NAME` as an unquoted string. Snowflake resolves that as an
identifier, so it was **case-folded to upper case before lookup**: any source table whose
real name was not already all-upper-case failed to resolve and masking/row-access policy
detection was silently skipped for it (console.warn only — no pause, no `status_message`, no
flag). This was once documented as a *spaces* problem; that was wrong and far too narrow.
Live-reproduced both ways: an ALL-CAPS name *containing a space* resolved fine, while a
mixed-case name with *no space* did not. The parts are now wrapped in `quoteIdent` (and the
whole thing escaped with `sqlStringLiteral`), matching the `SHOW COLUMNS` call in the same
function.

`classifyPollError`: global infra (expired key, disabled user, suspended/no-credit
warehouse, read-only secondary) → account-level banner + auto-resume, **no** per-pipeline
pause; per-table access (revoked/not-authorized/does-not-exist) → pause; transient → retry
next cycle.

SWAP / CREATE OR REPLACE and admin-dropped streams are handled by the stale-stream recreate
+ reconcile path. Renames are indistinguishable from drops, so both → pause + message.

See `pipeline-alerts.ts` for the helpers and the SSE `alert` event.

---

## Review-First Pipeline Creation (`pending_baseline`)

- "Create initial standardizations" inserts the pipeline as `status='pending_baseline'` (no auto-standardize) and builds a review run via `POST /api/pipelines/[id]/create-initial-run` (pre-creates the stream, then auto-groups) → opens `/run/{run_id}`.
- Run page (pipeline runs → `isAutoExport`) → **Accept Standardizations**. Corrected 2026-08-08 (PIPE-16) — this does NOT write to the lookup. `isAutoExport` is hardcoded `true` for every pipeline-mode run, so Accept always posts `defer: true`; the export route's deferWrite branch marks the run `'approved'` and writes nothing. It advances `pending_baseline → paused`, returns `pipeline_id`, and redirects to `/home`. The actual lookup write happens later, at **Begin Pipeline Standardization**, via `POST /api/pipelines/[id]/commit-standardizations`, which batch-writes every approved column's mappings and then flips `paused → active`. The deferral is what makes the multi-column wizard coherent: nothing is committed until the user has reviewed every column and confirmed.
- `/home` activation card → **Begin Pipeline Standardization** → `paused → active` (poller takes over). Resuming (`PATCH status='active'`) clears `status_message`.
- `pending_baseline` cards in `PipelinesView` have their own "Create initial standardizations" button (rebuilds the review run). The one-shot `/api/pipelines/setup` route **no longer exists** (verified 2026-07-24 — `POST /api/pipelines` is the only warehouse-pipeline create path, which is what makes the column-mode consent gate airtight).

Card-visibility and empty-state rules for these states: docs/DESIGN_SYSTEM.md.

---

## Dedicated Warehouse (`PRISM_WH`)

- `01_internal_tables.sql` creates `PRISM_WH` (XSMALL, `AUTO_SUSPEND = 60`, `AUTO_RESUME`, `INITIALLY_SUSPENDED`, `STATEMENT_TIMEOUT_IN_SECONDS = 600`) with `IF NOT EXISTS`, so re-running the script never clobbers an installer's resize — change settings via `ALTER WAREHOUSE`. `USAGE, OPERATE` granted to `PRISM_SERVICE`; `USAGE` to `PRISM_DATA_ADMIN`.
- Rationale: Prism runs on its own warehouse so its compute cost is isolated/attributable and auto-suspend tuning never touches the customer's other workloads. Clients *can* point Prism at their own warehouse (env var or Settings) — that's the escape hatch, not the default.
- `grants.ts` includes the same `CREATE WAREHOUSE` + grants; `CREATE WAREHOUSE` is an account-level privilege, so on non-ACCOUNTADMIN saves it fails gracefully (recorded in the grants result, like other elevated grants).
- The Settings "Test connection" verifies the warehouse exists (connecting with a nonexistent warehouse succeeds — it's only a session default) and returns a `warning` when `AUTO_SUSPEND` is missing/0 (never suspends) or > 60s.

---

## Snowflake Cost Model (why the poller is shaped this way)

- **Compute credits bill by warehouse-awake-time, not per query.** Per-second billing with a **60-second minimum every time a suspended warehouse resumes**; after that the warehouse keeps billing until `AUTO_SUSPEND` fires. So a 400 ms query against a suspended warehouse costs a full minute — and any recurring query spaced closer together than `AUTO_SUSPEND` keeps the warehouse resumed 24/7, billing for all the idle gap-time. Cost ∝ hours-awake × size (each size tier ≈ doubles credits/hour), never query count.
- **Metadata-layer operations are free; `INFORMATION_SCHEMA` SELECTs are not.** `SHOW` / `DESCRIBE` / `SYSTEM$STREAM_HAS_DATA` / `CREATE STREAM IF NOT EXISTS` run in the cloud-services layer — they never wake a warehouse (cloud services is only billed above 10% of daily compute; these never get close). A `SELECT` against an `INFORMATION_SCHEMA` view **does** require and wake a warehouse. **Rule: recurring/background code paths must use metadata-layer commands, never `INFORMATION_SCHEMA` SELECTs.** One-shot user-action paths (run creation, one-time flow, export) may use `INFORMATION_SCHEMA` — the warehouse is doing real work then anyway.
- **Incident that produced this rule (Jun/Jul 2026):** `checkSourceHealth`'s original `SELECT … FROM INFORMATION_SCHEMA.COLUMNS` was the account's single most expensive query (16.7 credits / 5,288 executions in one month — more than all real standardization work combined). Cause: forced every-30s re-checks on flagged/erroring pipelines during dev testing kept warehouses permanently resumed; part of it also ran on `COMPUTE_WH`, whose **default `AUTO_SUSPEND` is 10 minutes**, so each wake bought up to 10 min of billed idle. Fixed 2026-07-08: `SHOW COLUMNS` swap + exponential re-check backoff.
- **"The customer's warehouse is awake anyway" is never a valid assumption.** Prism runs on its own `PRISM_WH` precisely so its cost is isolated and attributable — which also means customer activity on their warehouses never keeps `PRISM_WH` warm; every `PRISM_WH` wake is Prism's bill. And real customer warehouses suspend nights/weekends, so a 24/7 background toucher would multiply, not piggyback on, their costs. This is why idle-cycle discipline exists: a no-new-data poll cycle must not wake `PRISM_WH` at all — the steady-state for a quiet source is a suspended warehouse costing zero.

**DECISION (2026-08-09, owner): the sweep stays HOURLY for every schedule.** An adaptive
back-off (hourly while it finds values, decaying once it doesn't) was offered and declined.
Rationale for keeping it: the sweep is the only mechanism that can find the PRE-EXISTING
distinct tail beyond the baseline's `LIMIT 5000` — those rows are not changes, so no stream
will ever emit them, and the 10-minute tick only ever reads `PIPELINE_QUEUE` and cannot
discover anything on its own. Predictable hourly behaviour was judged worth ~4
credits/month. Do NOT "optimise" this without revisiting that decision.

**Qualification (2026-08-09, DET-S07/DET-M08):** the "quiet source costs zero" guarantee
holds for the minute-mark POLLER and the 10-minute TICK on every schedule. It does NOT hold
for the top-of-hour reconciliation sweep on pipelines whose schedule is `always` or
`manual`: `fetchAllActivePipelines` deliberately skips only explicitly-stored `window`
schedules that are currently closed, so an `always`/`manual` pipeline gets an hourly source
scan + export rebuild that resumes `PRISM_WH` — roughly 8 wakes over an 8-hour night, each
billing the 60-second minimum. That is a conscious trade, not an oversight. A
window-scheduled pipeline — the creation default — genuinely does cost zero overnight. State
the guarantee to customers with that qualification rather than flatly.

**Operator notes:** keep `AUTO_SUSPEND = 60` on any warehouse Prism uses (`SHOW WAREHOUSES`
to verify — `01` uses `IF NOT EXISTS` and won't re-apply settings to an existing warehouse;
on dev accounts also `ALTER WAREHOUSE COMPUTE_WH SET AUTO_SUSPEND = 60` since worksheets
default to it). Non-warehouse lines on a Snowflake bill (Trust Center serverless scanners,
compute pools, cloud services) are **not** Prism — Prism only ever uses virtual warehouses.
(Trust Center's "Security Essentials" package is mandatory but its scheduled runs are free;
the billed one is the optional "Threat Intelligence" package.)

---

## Grants (`01_internal_tables.sql` — ROLES AND GRANTS block)

- All roles and grants are consolidated in `01_internal_tables.sql` (bottom section). A single `snowsql -f 01_internal_tables.sql` is sufficient for a fresh install — no separate grants file.
- The same grant statements are executed programmatically via `app/api/_lib/grants.ts` (`buildGrantStatements` / `applyGrants`) in two places: (1) when a user saves Snowflake credentials via Settings, and (2) automatically when a new account is created (Google OAuth callback Cases 2 and 3).
- `PRISM_SERVICE` = the app **service** role (full write — it writes mappings during standardization).
- `PRISM_DATA_ADMIN` = a separate **human-only** role, the ONLY other role granted write on `LITERAL_ALIAS_MATCHES` / `APPROVED_ALIAS_NAMES` / `PIPELINES` (for manual SQL maintenance). Non-admin roles get no write on `INTERNAL`. Snowflake doesn't enforce CHECK/PK/FK/UNIQUE, so grants are the guardrail; read paths tolerate orphans and a rebuild self-heals.

---

## Identifier & String Safety

- `isSimpleIdent` (poller, hourly processor, and the `auto-export/source`, `runs`, `auto-export/poll` routes) is **permissive**: any non-empty name `quoteIdent` can safely wrap is allowed (spaces, hyphens, leading digits, Unicode letters), rejecting only control chars and `" ' \`. Every identifier is wrapped in `quoteIdent` before SQL interpolation.
- `sqlStringLiteral()` in `normalize.ts` escapes backslashes + single quotes for column names interpolated into `column_data['...']` VARIANT paths (used at 4 sites: `export-table.ts`, `op-file-pipeline.ts` ×2 conceptually, `pipeline-poller.ts`). Use it for ANY string literal built into SQL text.
- The lookup-export route parses and quotes user-supplied target FQNs part-by-part and **refuses `PRISM_DB.INTERNAL` targets** (users cannot overwrite internal tables via export).

---

## Snowflake SQL Constraints

- **`PARSE_JSON(?)` is invalid in `VALUES` clauses.** Snowflake does not allow function calls around bind parameters inside VALUES. Use the `SELECT column1, column2, PARSE_JSON(column3) FROM VALUES (?, ?, ?)` pattern instead. This applies to `insertFileRows` and `refreshSheetsFileRows` in `op-file-pipeline.ts`.
- **Explicit transactions needed for multi-statement atomicity.** Snowflake auto-commits each statement by default. Wrap `DELETE` + `INSERT` (e.g. `refreshSheetsFileRows` replacing `PIPELINE_FILE_ROWS`) in explicit `BEGIN` / `COMMIT` / `ROLLBACK` to prevent a crash between statements from leaving the table empty.
- **Duplicate MERGE source keys error.** Snowflake rejects a MERGE whose source has duplicate join keys — bulk upserts must dedup their source rows first (done on `normalizeLiteral` in `op-export.ts`).

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
- Use `import 'server-only'` compile-time guard in all warehouse utility files
- Error responses to clients are sanitized (no raw SQL/driver messages)

---

## Background Startup (`instrumentation.ts`)

Next.js `register()` hook fires once on server start, initializes Sentry (server config),
and calls:

- `startPoller()` — one clock-aligned poll pass at every minute mark (self-chaining; all active tables polled concurrently per pass)
- `startQueueProcessor()` — the standardization tick at every 10-minute wall-clock mark (top-of-hour tick also reconciles)

Both are guarded with `global.__*Started` flags to prevent duplicate intervals on Next.js
hot-reloads. Neither is gated behind any mode/tier flag.

> ⚠️ **Poller/background code changes need a full dev-server restart.** Because
> `startPoller()` runs once (guarded by `global.__pipelinePollerStarted`) and its loops are
> already-scheduled closures, Next.js hot-reload does **not** replace the running poller —
> edits to `pipeline-poller.ts` / `instrumentation.ts`-started code won't take effect until
> you stop and restart `npm run dev`. This has repeatedly masked otherwise-correct fixes;
> always remind the user to restart after such changes.

## SSE Real-Time Updates

`GET /api/pipeline-events` is a Server-Sent Events endpoint. The poller and processor
broadcast events (`metrics_updated`, `scanning_started`, `scanning_finished`,
`standardizing_started`, `standardizing_finished`, and `alert`) via
`pipeline-broadcaster.ts`. The SSE route forwards all event types generically. `alert`
carries `{ level: 'error'|'warning'|'info', scope: 'global'|'pipeline', message,
pipeline_id?, ttl_ms? }` — `ttl_ms` tells the UI to auto-dismiss; persistent pause reasons
live on `PIPELINES.status_message`. The UI reconnects automatically on close.
