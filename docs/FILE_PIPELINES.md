# Files, Sheets & the One-Time Flow

Covers file/Google-Sheets pipelines, the upload + header-detection path, and the one-time
standardization flow. Read before touching any of them.

---

## File-Based Pipelines (Sheets, CSV, Excel)

File-based pipelines connect to uploaded files or Google Sheets instead of live warehouse
tables. They are always created with `update_schedule = {"type":"manual"}` — there is no
auto-standardize trigger.

### One pipeline per tab (key invariant)

**One PIPELINES row per Google Sheet tab (or per uploaded file).** All columns being
standardized for that tab are stored in `file_source_meta.columns`. The row-level
`column_name` / `domain_id` fields hold the first column only (schema compatibility).

This means the GET `/api/pipelines` route **virtually expands** Sheets pipelines: each entry
in `file_source_meta.columns` becomes a virtual pipeline object with the same `pipeline_id`
but different `column_name`/`domain_id`. `PipelinesView` groups by `file:${table_fqn}` (not
by `pipeline_id`) so all virtual entries land on one card.

### Dupe check (critical)

`POST /api/pipelines/file` checks for existing pipelines by `spreadsheet_id + tab_name`
before inserting. **Fetches ALL rows (no `LIMIT 1`)** — if any row is `active`/`paused`,
return 409. If all rows are `pending_baseline` (incomplete orphaned setups), delete them all
and proceed. Using `LIMIT 1` was a bug: if the DB had both a `pending_baseline` and a
`paused` row, it could miss the live one, resulting in a third pipeline row and duplicate
columns in the UI.

### `table_fqn` for file pipelines

`SHEETS:<spreadsheet_id>:<tab_name>:<nonce>` — the nonce ensures uniqueness even if a tab is
re-connected after deletion. Parseable by splitting on `:`.

### `file_source_meta` schema

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

The `refresh_token` is the user's Google OAuth refresh token, stored at pipeline creation so
the background poller can re-read the sheet autonomously every poll pass. Required for
automatic metrics updates. Stored **app-level encrypted** (AES-256-GCM via
`PRISM_ENCRYPTION_KEY`, `enc:v1:` format) and decrypted only at the point of use.

**Per-column metrics** (`total_source_values`, `total_mapped`) are written into each column
entry by `refreshSheetsFileRows` and the poller's fallback path. Meta write-backs **re-read
fresh `file_source_meta` and merge only the computed per-column metrics** into it (never
overwrite the whole object from a stale in-memory copy). The GET `/api/pipelines` virtual
expansion reads these per-column values when present, so `buildPipelineGroups` sums correct
per-column values instead of duplicating the row-level aggregate to every virtual entry
(which caused double-counting). If per-column metrics are absent (legacy rows), the
row-level aggregate is used as a fallback.

### Standardization flow (Sheets)

1. `POST /api/pipelines/file` → creates ONE pipeline row, stores all columns in `file_source_meta.columns`, **populates `PIPELINE_FILE_ROWS`** at creation time (reads the Google Sheet via OAuth access_token and inserts rows), creates one review run per column
2. Multi-column wizard → user reviews each column's run → "Accept Standardizations" (deferred export) for each → "Begin Pipeline" commits all
3. `POST /api/pipelines/[id]/process-queue` (manual trigger) → reads `PIPELINE_FILE_ROWS` via `readFileDistinctValues` per column → `bulkProcessPipelineQueue` per column → `syncSheetsColumn` once at end to write output sheet

### Google Sheets I/O (`op-file-pipeline.ts`)

- **Reads paginate**: `readAllSheetRows` fetches in 10 000-row pages until exhausted — no hardcoded `A1:ZZZ10000` cap; large sheets are read fully.
- **Output writes are non-destructive**: `syncSheetsColumn` rewrites the output tab via chunked `values.update` calls; any trailing-row cleanup happens only AFTER the new data is successfully written (a mid-write failure never leaves the tab cleared).
- **A1 tab names** are escaped by doubling single quotes (`a1Sheet`) so tabs with quotes/spaces address correctly.
- **Output matching + CSV download use `normalizeLiteral`** on the compare key, consistent with the SQL `PRISM_NORMALIZE` joins.
- `syncSheetsColumn` fetches ALL confirmed mappings from `LITERAL_ALIAS_MATCHES` for all standardized columns, reads the full source sheet, applies mappings to each standardized column, and writes back. One call covers all columns regardless of which column's pipeline triggered it.

### Background polling for file pipelines

`pollOneFilePipeline` runs every poll pass (minute mark) for each active file pipeline:

- **Sheets + refresh_token**: `refreshSheetsFileRows(pipelineId, meta)` — authenticates with the decrypted `refresh_token`, reads the full sheet via the paginated Sheets API, **skips all warehouse work when the sheet content hash is unchanged from the last cycle** (returns `'unchanged'`; in-memory sha256 cache, full refresh on first cycle after restart), wraps `DELETE` + `INSERT` into `PIPELINE_FILE_ROWS` in an explicit `BEGIN`/`COMMIT` transaction, computes per-column metrics via SQL joining `PIPELINE_FILE_ROWS` against `LITERAL_ALIAS_MATCHES` (normalized on both sides), writes per-column metrics into `file_source_meta.columns`, and updates aggregate PIPELINES metrics
- **CSV/Excel (or Sheets without token)**: recomputes metrics from `PIPELINE_FILE_ROWS` only **every 20th cycle (~10 min)** — the rows are static, and standardization paths recompute metrics themselves; the per-cycle recompute was pure warehouse churn. **Empty guard:** if `PIPELINE_FILE_ROWS` has zero rows (table not yet populated or data cleared), the UPDATE is skipped entirely to avoid resetting metrics to 0/0

Emits `scanning_started` / `scanning_finished` SSE events (same as Snowflake) — the client
currently ignores these. Does NOT LLM-standardize anything.

### Pipeline metrics for file-based

- `total_source_values` = total distinct non-empty values across all standardized columns in `PIPELINE_FILE_ROWS`
- `total_mapped` = distinct values with a confirmed match in `LITERAL_ALIAS_MATCHES` (normalized join per column)
- `queue_size` = `total_source_values − total_mapped`
- **Per-column storage:** each column's `total_source_values` and `total_mapped` are stored in `file_source_meta.columns[]`. The GET `/api/pipelines` virtual expansion reads these per-column values so that `buildPipelineGroups` sums correctly. Without per-column metrics, the row-level aggregate is duplicated to each virtual entry and summed again (double-counting bug).

### Multi-column Sheets wizard

`POST /api/pipelines/file` for Sheets returns `{ pipeline_id, run_ids, column_names }` — ONE
`pipeline_id` shared by all columns, one `run_id` per column. `FilePipelineConnectForm`
stores `{ kind: 'create', pids: runIds.map(() => pipelineId), cols: colNames, runs: runIds }`
in `sessionStorage` under `prism_ae_col_wizard` and navigates to the first run.

`RunReviewClient` reads the wizard key. For each column in sequence, the user reviews and
clicks "Accept Standardizations". The export route (`POST /api/run/[run_id]/export` with
`defer: true`) marks the run `approved` without writing to `LITERAL_ALIAS_MATCHES`. The
wizard advances to the next column's run. After the last column, the activation card
appears, and "Begin Pipeline Standardization" calls `POST
/api/pipelines/[id]/commit-standardizations` to batch-write all approved columns' mappings,
then advances the pipeline to `paused → active`.

The pipeline lookup in the deferred export path matches by `table_fqn` only for
`source_type = 'sheets'` (not `column_name`), because all columns share one pipeline row
whose `column_name` is only the first column.

Single-column Sheets pipelines skip the multi-column WIZARD (`runIds.length === 1` — no
column-to-column advance, no `prism_ae_col_wizard` key), but they still use the **deferred**
export path like every other pipeline-mode run. Corrected 2026-08-09 (FILE-05): this said
"standard non-deferred export path", which stopped being true when `isAutoExport` became a
hardcoded `true` for the single-tier product. `doAcceptStandardizations` now sends `defer: true` unconditionally, so Accept marks the run
`'approved'` and the lookup write happens at Begin Pipeline Standardization via
`commit-standardizations`. Skipping the wizard and deferring the write are independent
things; only the first is conditional on column count.

---

## Import Options & File Upload Flow

### Import options
- Warehouse table (primary)
- Excel/CSV upload (`.xlsx`, `.xls`, `.csv` only — reject all other formats with clear error)
- Paste values (tab or newline separated)

### Upload flow
1. Upload file → reject non-`.xlsx`/`.xls`/`.csv` with clear message
2. If multiple tabs: show tab selector (no auto-select)
3. Data start detection (deterministic only — no LLM) — see below
4. If multiple columns: show column dropdown (never guess)
5. Deduplicate silently; show total rows + distinct count
6. Preview first 10–15 values → user confirms
7. Run created with distinct values as input

Horizontal data (values across columns) is not supported. Show large file warning before run
creation if row count exceeds threshold.

### Header-row detection

**Implemented 2026-08-06 in `_lib/table-shape.ts` (`detectHeaderRow`, pure +
parity-tested) after KI-219** — before that it did not exist and row 1 was taken as the
header unconditionally, which built a pipeline over four non-existent columns on a real
customer sheet whose header was on row 5.

The heuristic, in order: skip leading blank rows; skip narrow title/summary rows; pick the
first row that is *about as wide as the data beneath it* (≥60% of the widest sampled row)
and is not mostly numeric. Width is the load-bearing signal — a summary row above the table
is narrower than the real header. Used by BOTH the CSV/Excel parser and
`/api/sheets/columns` (which reads rows 1–20, not `!1:1`), so the two cannot disagree.

- **The detected row is shown with an override — for FILE uploads only.** `HeaderPreview` renders the chosen header + first data rows and a "header row" input for CSV/Excel. This is the point: the heuristic *will* be wrong on some layout, and a wrong guess must be visible and correctable rather than silent. **Google Sheets connections currently get no such control** (`sheetsHeaderRow` is set from `/api/sheets/columns` and never surfaced) — so a mis-detected Sheets header is silent and uncorrectable. Recorded 2026-08-09 as SHEETS-HDR-02.
- **The data range follows the header row** — `grid.slice(headerRow + 1)` for files, and `<col><headerRow+2>:` for Sheets. Fixing detection without moving the data range would still ingest the blank rows and the header text as data. **This is exactly what happened for Sheets PIPELINES until 2026-08-09 (SHEETS-HDR-01):** detection was fixed and the picker used it, but the three consumers that re-read the sheet server-side — the creation ingest, the poller's `refreshSheetsFileRows`, and `syncSheetsColumn`'s output grid — all hardcoded `allRows[0]`. A header-on-row-5 sheet therefore ingested the TITLE as its only column name, matched none of the chosen columns, reported 0 source values forever, and echoed the junk rows into the output sheet. The confirmed row is now persisted as `file_source_meta.header_row` and read via `headerRowFromMeta()` by all three; parity-tested, including that no reader reintroduces `allRows[0]`.
- Column letters come from `columnLetter()`, not `String.fromCharCode(65 + i)`, which emitted `[`, `\`, `]` past column Z and silently read the wrong column on sheets wider than 26 columns.

### Export formats
All formats must include: raw value, canonical value, confidence indicator, run ID.

- **Warehouse export table** (default) — the standardized output table embedded in the customer's warehouse
- **CSV** — fallback for non-warehouse stacks, dbt seed file workflows
- **Excel/Google Sheets** — for less technical users

---

## One-Time Standardization (`app/one-time/`, `op-one-time.ts`)

A throwaway, one-shot flow: standardize one or more columns of a source table and write the
result to a standalone warehouse table (`'create'` or `'overwrite'`). Unlike the pipeline
path, it **never reads or writes the shared lookup** (`LITERAL_ALIAS_MATCHES` /
`APPROVED_ALIAS_NAMES`) — every value is grouped purely by the LLM, optionally subject to a
structured naming convention (`convention-rules.ts`, edited via `ConventionEditor`).

**Size guard:** the one-time distinct scan is otherwise uncapped, so columns with more than
`ONE_TIME_MAX_DISTINCT = 20,000` distinct normalized values are rejected at creation with a
typed `OneTimeTooLargeError` → clean 400 directing the user to a pipeline instead (the flow
assumes a single review sitting and a single merge pass — neither survives that scale).

**Edit-in-place round trip (2026-08-12):** CSV/XLSX uploads keep their ORIGINAL bytes
(base64-chunked in warehouse table `ONE_TIME_FILE_BLOBS` — customer values, data residency;
lifecycle shared with `ONE_TIME_FILE_ROWS` via `deleteOneTimeFileRows`) so the csv/excel
export can hand back the customer's own file with ONLY the standardized cells changed —
hidden columns (Dynamics GUIDs), styles, and column order intact for reimport wizards. The
patcher is `_lib/file-inplace.ts` (pure, parity-tested): a byte-span CSV tokenizer, and
zip-level XLSX surgery (fflate) replacing target `<c>` elements with style-preserving inline
strings while every other zip entry passes through byte-identical. Addressing never trusts
the stored rows — headers and blank-row-filtered data-row indices are re-derived from the
original file itself (`gridToRows` + `gridDataRowIndices`, one filter predicate). ANY patch
failure falls back to the legacy regenerated `{headers, rows}` path (never a corrupted
"original"); `.xls` (non-zip) and Sheets/paste sessions always use the fallback. Export
response carries `{file_b64, file_name, in_place: true}`; the review client downloads it
verbatim.

**Personal-connection fallback:** one-time runs can standardize tables the `PRISM_SERVICE`
role can't see. The create route probes the source with the service connection first; on an
access error it falls back to the creator's **personal credentials** (`accounts.sf_*` — any
member may save their own via `/setup`; `snowflake-config` POST is `requireValidSession`,
and only admin saves run the grants pass). `withUserWarehouse(accountId, fn)` /
`hasUserWarehouseConfig` (async — always await) / `isWarehouseAccessError` live in
`_lib/warehouse`; in the NATIVE edition the same two resolve to the SPCS caller's-rights
session (no stored credentials — NATIVE_APP_PLAN.md §2.9). The chosen connection is recorded
as `connection: 'service' | 'user'` in the run's one-time meta (`stats_snapshot`), and the
**export uses the same connection** — so an `'overwrite'` export requires the user's own
write access to the target table (`'create'` requires their CREATE TABLE on the schema);
permission failures return user-directed messages, not `PRISM_SERVICE` grant SQL.
`/api/columns` applies the same fallback (INFORMATION_SCHEMA shows zero rows, not an error,
for unGranted tables) and returns `needs_user_connection: true` when neither connection can
see the table; the one-time card links to `/setup` (which renders a personal-credentials
variant for non-admins). The shared lookup ALWAYS uses the service connection.

Working state lives in `RUNS` with `run_type = 'one_time'` (tied together by a session
nonce); the durable archive row is written to `ONE_TIME_STANDARDIZATIONS` on export. It
reuses the grouping engine (`runOnePromptGrouping`) and the run state blob. Routes live under
`/api/one-time/`; the review UI is `app/one-time/[session]/`.

**Known edge:** the create route builds runs column-by-column, so a later column tripping the
cap leaves earlier columns' working runs as harmless orphans (see CLAUDE.md → Deferred items).
