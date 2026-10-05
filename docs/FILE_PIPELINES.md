# Files, Sheets & the One-Time Flow

Covers file and Google Sheets sources, the upload + header-detection path, and the one-time
standardization flow. Read before touching any of them.

(The filename is historical — other docs link to it. There are no file pipelines any more;
see the first section.)

---

## File and Sheets pipelines were removed

**Pipelines are warehouse-only.** Prism used to let a Google Sheet tab or an uploaded
CSV/Excel file be the source of a *pipeline*. That path was removed wholesale: a pipeline
exists to keep a LIVE source standardized on a schedule, and a spreadsheet had to be re-read
every 60 seconds to pretend it was one. Files and Google Sheets are one-shot by nature, so
they are now sources for the **one-time flow only** (below).

What that removal covered, so nobody goes looking for it:

- **Code:** `_lib/op-file-pipeline.ts`, `app/home/FilePipelineConnectForm.tsx` and the
  `POST /api/pipelines/file` route are deleted. The poller has no file branch
  (`pollOneFilePipeline` / `refreshSheetsFileRows` are gone), and `GET /api/pipelines` no
  longer "virtually expands" one Sheets row into several columns. The parity suite
  (`scripts/parity-tests.ts`, section "pipelines are warehouse-only") fails if any of these
  grow back.
- **SQLite:** migration 016 dropped `pipelines.source_type`, `file_source_meta` and
  `file_export_meta`. Every pipeline row is a warehouse table + column now. No Google
  refresh token is stored server-side any more (it used to sit, encrypted, in
  `file_source_meta`).
- **Warehouse:** `PIPELINE_FILE_ROWS` is gone — `01_internal_tables.sql` drops it if an
  older install still has it. The one-time flow has its own tables, `ONE_TIME_FILE_ROWS`
  and `ONE_TIME_FILE_BLOBS`.

What survived, and where it lives now:

| Piece | Lives in | Used by |
|---|---|---|
| Paged Sheets reader `readAllSheetRows` (10,000-row pages, no hardcoded `A1:ZZZ10000` cap), the 100,000-row ceiling `MAX_SHEET_ROWS` / `SheetTooLargeError`, A1 tab quoting `a1Sheet` (doubles single quotes so tabs with quotes/spaces address correctly) | `_lib/sheets-io.ts` | `POST /api/one-time/create` |
| Header-row detection and the grid → rows parser (`detectHeaderRow`, `gridToRows`, `gridDataRowIndices`, `columnLetter`) | `_lib/table-shape.ts` (pure, parity-tested) | the one-time card, `/api/sheets/columns`, the one-time create and export routes |
| Storage of uploaded rows and original file bytes | `_lib/op-one-time-file.ts` → warehouse `ONE_TIME_FILE_ROWS` / `ONE_TIME_FILE_BLOBS` | the one-time create and export routes, and `op-one-time.ts` (the distinct-value read) |

---

## File & Sheets sources (one-time flow)

### Source options

The one-time card (`app/home/OneTimeStandardizationCard.tsx`) offers three sources:

- **Warehouse table** — a fully qualified table name
- **File upload** — `.csv`, `.xlsx`, `.xls` only; every other format is rejected with a clear error
- **Google Sheet** — a sheet URL plus a tab (not available in the native edition, which has no Google Sheets surfaces)

A "paste values" tab existed until 2026-08-18; it was removed by owner decision — every
real source is a table, a file, or a Sheet. The create route accepts `source_type` of
`warehouse`, `csv`, `excel` or `sheets` and nothing else.

### File upload flow

1. Choose a file → non-`.csv`/`.xlsx`/`.xls` is rejected; files over **20 MB** are rejected with "load the data into a warehouse table" (client-side check, before parsing)
2. The file is parsed in the browser (`xlsx`). If the workbook has several tabs, a tab selector appears (the first tab is loaded initially)
3. Header-row detection (deterministic only — no LLM) — see below. The detected row is shown with an override
4. The user picks the column(s) to standardize and gives each its description / rules / convention
5. `POST /api/one-time/create` receives the parsed rows with the request (one object per source row, keyed by column header). More than **200,000 rows** is a 400. The rows are written to `ONE_TIME_FILE_ROWS` under the session nonce, and one one-time run is created per chosen column
6. For `.csv` and `.xlsx` uploads the browser also sends the ORIGINAL file bytes (base64), stored in `ONE_TIME_FILE_BLOBS` for the edit-in-place export (see the one-time section). Storing them is best-effort: if it fails the session is still created and the export falls back to a regenerated file

For a file session `source_relation` is a display label (the file name, plus the tab for a
workbook), not a table name — the server skips FQN parsing and the source-table probe for
it. File sessions always run on the service connection, which owns `ONE_TIME_FILE_ROWS`.

### Google Sheets flow

1. The user pastes a sheet URL and clicks Load → `GET /api/sheets/columns` reads the first 20 rows of the tab, detects the header row, and returns the columns, the detected row and sample rows. If the user has not yet granted Sheets access, the app sends them through `/api/auth/google`, which requests the Sheets scopes at that moment (sign-in itself asks only for identity)
2. The detected header row is shown with an override, same as for files
3. `POST /api/one-time/create` gets only the spreadsheet id, the tab name and the confirmed header row. **The server reads the sheet itself** (`readAllSheetRows`, then `gridToRows` from the confirmed header row) rather than having the browser fetch and re-post up to 100,000 rows. A tab over `MAX_SHEET_ROWS` (100,000) is a 400 that names the tab and the limit
4. The rows are stored in `ONE_TIME_FILE_ROWS` exactly like an uploaded file's. Nothing re-reads the sheet afterwards — the session works from that snapshot

The Google tokens for this live only in the user's browser cookies (`google_access_token` /
`google_refresh_token`, set by the Sheets consent round trip). No token is stored in SQLite
or the warehouse, and nothing reads a Sheet in the background.

### Why the rows are stored in the warehouse

A one-time session is not instantaneous: the user uploads, reviews groups (possibly for a
long while), then exports, and the export reproduces EVERY source row with the standardized
columns substituted — so the rows have to outlive the request that uploaded them, and
distinct values alone are not enough. They go in the customer's warehouse rather than
SQLite because they are customer values (the data-residency rule). Lifecycle: written at
session creation, read once per column when its run is created (the distinct-value scan)
and again at export. `deleteOneTimeFileRows` removes a session's rows and its blob chunks
together; the only caller today is the create route's failure path (a later column tripping
the size cap must not orphan a large upload in the warehouse).

Distinct values are deduped APP-SIDE on `normalizeLiteral` (`readOneTimeDistinctValues`),
not in SQL, so a session groups identically on every warehouse; `source_frequency` is the
real number of source rows that collapsed into each value.

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

- **The detected row is always shown with an override — for file uploads AND Google Sheets.** The one-time card renders a "header row" number input for both sources (for Sheets alongside the sample rows returned by `/api/sheets/columns`, which accepts a `headerRow` override and reports `detectedHeaderRow` next to it). This is the point: the heuristic *will* be wrong on some layout, and a wrong guess must be visible and correctable rather than silent. Sheets originally had no such control (SHEETS-HDR-02); that is fixed and parity-tested.
- **The data range follows the header row** — `gridToRows` slices `grid.slice(headerIdx + 1)`, for files in the browser and for Sheets on the server. Fixing detection without moving the data range would still ingest the blank rows and the header text as data. That is exactly what happened on the old Sheets pipeline path (SHEETS-HDR-01): its server-side readers hardcoded `allRows[0]`, so a header-on-row-5 sheet ingested the TITLE as its only column name. The parity suite still checks that no reader in `sheets-io.ts` reintroduces `allRows[0]` and that the one-time create route honours the confirmed row.
- **Blank rows are kept while parsing a file** (`blankrows: true`) so the row number shown to the user is the real spreadsheet row; `gridToRows` filters all-blank rows out of the data afterwards.
- **Duplicate or empty headers are renamed** by `gridToRows` so each column stays distinct, and the card warns the user to check which one they picked.
- Column letters come from `columnLetter()`, not `String.fromCharCode(65 + i)`, which emitted `[`, `\`, `]` past column Z and silently read the wrong column on sheets wider than 26 columns.

### Output formats for a file or Sheets session

`POST /api/one-time/export` takes a `format`: `warehouse` (a standalone table — the only
format for warehouse-table sessions), `csv`, `excel`, or `sheets`. All of them share one
grid builder: every source row from `ONE_TIME_FILE_ROWS` with the standardized columns
substituted (`applyMappingsToRows`). `csv` / `excel` return data (or the patched original
file — see "Edit-in-place round trip" below) for the browser to download; `sheets` creates
a NEW spreadsheet in the user's Google Drive and returns its URL — it never writes back
into the source sheet.

### Export formats
All formats must include: raw value, canonical value, confidence indicator, run ID.

- **Warehouse export table** (default) — the standardized output table embedded in the customer's warehouse
- **CSV** — fallback for non-warehouse stacks, dbt seed file workflows
- **Excel/Google Sheets** — for less technical users

---

## One-Time Standardization (`app/one-time/`, `op-one-time.ts`)

A throwaway, one-shot flow: standardize one or more columns of a source — a warehouse table,
an uploaded CSV/Excel file, or a Google Sheet (see above) — and write the result to a
standalone warehouse table (`'create'` or `'overwrite'`); file and Sheets sessions can
instead export as CSV, Excel or a new Google Sheet. Unlike the pipeline
path, it **never reads or writes the shared lookup** (`LITERAL_ALIAS_MATCHES` /
`APPROVED_ALIAS_NAMES`) — every value is grouped purely by the LLM, optionally subject to a
structured naming convention (`convention-rules.ts`, edited via `ConventionEditor`).

**Overwrite guard (2026-10-04):** an `'overwrite'` export replaces the whole table with the
current session's result, so a table last written by a *different* one-time session would
silently lose that session's standardized columns (found live: a `PAYMENT_METHOD` export was
replaced by a later `VENDOR_NAME` session aimed at the same name, and the table "came back
unstandardized"). `POST /api/one-time/export` now checks the `one_time_standardizations`
archive — the row with the newest `exported_at` for that `export_target`, compared
case-insensitively — and when its `session_nonce` differs, answers **409** with
`overwrite_other_session: true` and an explanation. The dialog shows the message; clicking
Export again on the *same* destination resends with `confirm_other_session: true`. The other
session's column names are included only for the user who created it. The check is
SQLite-only (no warehouse call), applies to warehouse-table exports only, and is wrapped so a
failure of the check can never block an export. It cannot see tables written by anything
other than a one-time export — the dialog's general "table will be fully replaced" warning
still covers those.

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
"original"); `.xls` (non-zip) and Sheets sessions always use the fallback. Export
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
