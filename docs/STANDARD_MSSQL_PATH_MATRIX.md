# Prism path matrix — SQL Server + vendor Anthropic key

Comprehensive per-path test list for the client-sim install
(clienttest.prismmasterdata.com; config: warehouse = SQL Server, AI = vendor
env key). Companion to `STANDARD_MSSQL_CLIENT_TEST.md` (which holds the
findings log — add anything that fails there).

Timing to keep in mind while testing: the poller checks sources at every
**minute** mark; standardization runs at every **10-minute** mark (x:00,
x:10, …). "Detected" shows as queue/unstandardized counts on the card;
"standardized" means the tick ran and the export updated.

**Fixture tables** (all in `CLIENT_DB.dbo` unless noted; CT pre-enabled on
every table with a PK):

| Table | Column | Built for |
|---|---|---|
| CUSTOMER_ORDERS | carrier | A1 baseline (done), B1 live CT test, D4 unmapped toggle |
| SUPPORT_TICKETS | issue_category | F2 second user's pipeline |
| PRODUCT_CATALOG | department | C2 regex convention |
| SALES_LEADS | company | C1 standardization rules + A2 lookup-only |
| NO_PK_EVENTS | event_name | B2 diff-scan detection (deliberately NO primary key) |
| REGIONS | region | A3 column mode (SACRIFICIAL — column mode writes on it) |
| CONTACTS | carrier + state_name | A5 multi-column / add-column |
| EMPTY_ORDERS | vendor | B3 empty-source creation |
| SUPPLIER_INVOICES | supplier | E4 one-time from a warehouse table |
| PRIVATE_DB.dbo.SECRET_VENDORS | vendor | F4/F5 personal-credential paths (invisible to prism_svc; login analyst1 / Analyst!Test9) |

---

## A. Pipeline output modes

- [x] **A1 — Table export** (CUSTOMER_ORDERS → PRISM_OUT.CUSTOMER_ORDERS_STANDARDIZED).
  DONE 2026-08-17: created via wizard, 16/16 mapped, export table real, CT mode.
- [ ] **A2 — Lookup-only (no export object)** — SALES_LEADS, output option
  "Lookup table" (do this as part of C1). *Expected:* pipeline works with NO
  export table anywhere; Mappings tab fills; card shows no destination; the
  lookup-table download button still exports mappings.
- [ ] **A3 — Column mode** — REGIONS, output "Column". *Expected, in order:*
  (1) an unmissable warning panel + required consent checkbox in the form;
  (2) creation succeeds but the card is FLAGGED with exact fix SQL (the
  automatic grant needs the creator's personal SQL Server credentials, which
  the admin hasn't saved) — run that SQL via sqlcmd as sa; (3) after the next
  sync, `SELECT region, region_STANDARDIZED FROM CLIENT_DB.dbo.REGIONS` shows
  canonical names beside mapped raws, NULL for unmapped; other columns
  untouched; (4) the pipeline's own change detection sees Prism's writes once
  and settles (no endless re-detect loop). ⚠ First-ever live run of column
  mode on any warehouse — treat every deviation as a finding.
- [ ] **A4 — View mode absent** — while creating any mssql pipeline.
  *Expected:* the output picker offers Table / Column / Lookup only — no View
  option (views can't reference mssql's per-rebuild staging).
- [ ] **A5 — Multi-column pipeline** — CONTACTS: create on `carrier`, finish,
  then use the card's **+** to add `state_name` (own spec). *Expected:* second
  column gets its own review run; both columns share the export table; the
  card shows a per-column breakdown; export has BOTH columns standardized.

## B. Detection modes & live updates

- [ ] **B1 — Change Tracking live cycle** — CUSTOMER_ORDERS. Insert via
  sqlcmd: `INSERT INTO dbo.CUSTOMER_ORDERS (carrier) VALUES (N'AT+T'),
  (N'Cricket'), (N'cricket wireless');` *Expected:* card shows the new values
  detected within ~1 minute; at the next 10-minute mark they standardize with
  ZERO review needed (AT+T should join AT&T; Cricket forms a new group) and
  the export table gains the rows. Then `DELETE FROM dbo.CUSTOMER_ORDERS
  WHERE carrier = N'Cricket';` *Expected:* export rebuild drops that row
  within ~a minute (delete-aware hygiene).
- [ ] **B2 — Diff-scan fallback (no primary key)** — NO_PK_EVENTS.
  *Expected:* no Change Tracking consent offer during creation (the table
  can't have CT); pipeline works anyway; Activity tab hints at scan-based
  detection; an inserted row is detected on a slower cadence (up to ~5
  minutes — the heartbeat permission isn't granted) and standardizes at the
  next tick.
- [ ] **B3 — Empty source** — EMPTY_ORDERS. *Expected:* "Create initial
  standardizations" reports no values found and the pipeline lands directly
  in 'paused' — no review run, no errors.

## C. Specs: rules & conventions

- [ ] **C1 — Standardization rules** — SALES_LEADS (lookup-only output).
  Spec rule: `Group subsidiaries under their parent company and use the
  parent's canonical name: Instagram/WhatsApp/Facebook → Meta; YouTube →
  Google; LinkedIn/GitHub → Microsoft.` *Expected:* review shows a Meta group
  containing Instagram + WhatsApp + Facebook variants, Google containing
  YouTube, Microsoft containing LinkedIn + GitHub — the rule OVERRIDES the
  default "same entity only" behavior. The rules panel shows atop the review
  page.
- [ ] **C2 — Regex naming convention (enforced)** — PRODUCT_CATALOG. Spec
  convention, type regex: `^[A-Z][a-z]+( [A-Z][a-z]+)*$` (Title Case words).
  *Expected:* proposed names comply (Home Goods, Consumer Electronics,
  Sporting Goods, Office Supplies); the editor labels the convention
  "Enforced"; in review, renaming a group to `home goods` is auto-corrected
  or BLOCKED with a per-requirement reason.
- [ ] **C3 — Referee (observational)** — during any review, move one
  already-lookup-matched value into an obviously wrong group and export.
  *Expected:* export succeeds either way (fail-open); the deliberate mistake
  MAY be reverted by the validation referee. Note what happens.

## D. Schedules & pipeline controls

- [ ] **D1 — Manual-only** — set a pipeline's schedule to Manual only.
  *Expected:* new values queue but never auto-standardize; no Pause button;
  "Update Standardizations" drains the queue on click.
- [ ] **D2 — Window vs 24/7** — set a window that's currently CLOSED.
  *Expected:* values stay queued through tick marks; switching to 24/7 drains
  at the next mark.
- [ ] **D3 — Pause/resume** — *Expected:* paused pipeline stops polling
  (timestamps freeze); resume picks up within a minute.
- [ ] **D4 — Unmapped-rows toggle** — CUSTOMER_ORDERS settings. Insert a
  value, then look at the export BEFORE the tick standardizes it.
  *Expected:* with the toggle OFF (default) the unstandardized row is absent
  from the export; turning it ON + save re-renders the export including the
  raw row.

## E. One-time standardization (admin)

- [x] **E1 — CSV upload → CSV export.** DONE 2026-08-17 (after finding #9 fix).
- [ ] **E2 — Excel upload → Excel export** — same data saved as .xlsx.
  *Expected:* works like E1; the downloaded file preserves everything except
  the standardized cells (in-place patch).
- [ ] **E3 — Paste values** — paste a messy list. *Expected:* review + export
  work; export downloads as a generated file.
- [ ] **E4 — Warehouse table, create + collision + overwrite** —
  SUPPLIER_INVOICES → destination `CLIENT_DB.PRISM_OUT.SUPPLIER_CLEANUP`,
  mode create. *Expected:* table appears with standardized suppliers (Acme
  Corporation, Globex, Initech, Umbrella × your chosen canonicals).
  Re-export same destination in CREATE mode: *expected* clean "already
  exists" error (never silently replaces). OVERWRITE mode: *expected*
  succeeds.
- [ ] **E5 — Archive** — the one-time card lists past sessions with their
  outcomes.

## F. Team & second user

- [ ] **F1 — Invite flow** — Settings → Team → invite. *Expected:* real
  email arrives (SMTP); accept link works; new user sees the terms
  interstitial once; lands as role 'user' (no Settings menu item).
- [ ] **F2 — Non-admin pipeline** — as user 2: SUPPORT_TICKETS
  (issue_category), Table output, default destination
  `CLIENT_DB.PRISM_OUT.SUPPORT_TICKETS_STANDARDIZED`. *Expected:* identical
  flow to the admin's; billing/tick/detection all work.
- [ ] **F3 — Personal credentials save** — as user 2, /setup (optional
  variant): server `localhost`, user `analyst1`, password `Analyst!Test9`.
  *Expected:* saves after a live test; admin-only grants pass is skipped.
- [ ] **F4 — Personal-credential ONE-TIME (first live run of the ported
  fix)** — as user 2: one-time on `PRIVATE_DB.dbo.SECRET_VENDORS` → export
  create to `PRIVATE_DB.dbo.VENDORS_CLEAN`. *Expected:* the table probe
  falls back to analyst1's credentials (prism_svc has zero PRIVATE_DB
  access); export builds its scratch in the TARGET schema and succeeds.
  PASS ⇒ tell Claude — clears the WAREHOUSES.md "code-only" warning.
- [ ] **F5 — USER-CONNECTION PIPELINE (first live run)** — as user 2:
  pipeline on `PRIVATE_DB.dbo.SECRET_VENDORS`, Table output, and CHANGE the
  destination to `PRIVATE_DB.dbo.SECRET_VENDORS_STD` (the suggested
  PRISM_OUT schema doesn't exist in PRIVATE_DB). *Expected:* creation
  succeeds via the credentials fallback; review + Begin work; the poller
  detects inserted rows on analyst1's connection; export table is built
  under analyst1's access with staging appearing transiently in dbo, never
  in PRISM_DB.
- [ ] **F6 — Credential sabotage** — with F5 active, as sa:
  `ALTER LOGIN analyst1 DISABLE;` *Expected:* within ~1 minute ONLY that
  pipeline pauses, with a message naming the creator's personal credentials
  (no workspace-wide banner). `ALTER LOGIN analyst1 ENABLE;` + resume →
  recovers.
- [ ] **F7 — Role management** — promote user 2 to admin (*expected:*
  Settings appears for them ~immediately), demote back (*expected:* gone —
  session revocation is instant), and confirm last-admin/self-delete guards
  refuse removing yourself as the only admin.

## G. Lookup exports & mappings

- [ ] **G1 — Lookup download, CSV + Excel** — from any live card's
  lookup-table button. *Expected:* file lists literal → canonical rows for
  that column's spec.
- [ ] **G2 — Lookup export to a warehouse table** — same dialog, SQL Server
  option, default destination `PRISM_DB.EXPORTS.<NAME>_LOOKUP`. *Expected:*
  table created; a `PRISM_DB.INTERNAL...` destination is refused.
- [ ] **G3 — Mappings tab + spec tooltip** — *Expected:* per-column mappings
  listed; the ⓘ beside each column shows description/rules/convention.

## H. Guards (deliberate-failure tests)

- [ ] **H1 — Creation gate** — try creating a pipeline with destination
  `CLIENT_DB.dbo.SHOULD_NOT_EXIST`. *Expected:* clear error at the green
  button naming the missing permissions + fix SQL; NO pipeline appears
  anywhere; recreating with the PRISM_OUT default then works.
- [ ] **H2 — URL in the table field** — paste the site URL as the table.
  *Expected:* "That looks like a web address, not a table name…" — no grant
  chase.
- [ ] **H3 — Delete pipeline** — delete any test pipeline. *Expected:* card
  gone immediately, no error toast (finding #6 fix), recreate works.
- [ ] **H4 — Column-mode name conflict** — after A3, delete the REGIONS
  pipeline and try to recreate it in column mode. *Expected:* refused with a
  clear message — `region_STANDARDIZED` already exists and Prism won't write
  into a column it can't prove it owns (drop the column manually to
  reconnect).

## Out of scope for this rehearsal
Google Sheets surfaces (OAuth app friction; optional), OpenAI/Gemini
providers (untested by design — vendor Anthropic key is the config under
test), Snowflake/pg/mysql paths, scale tests (5k installments, 20k one-time
cap), native edition.
