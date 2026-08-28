# Prism Native — Marketplace consumer test script

The manual pass to run against a **real listing install in the test-consumer
account**, before anything is sold. Work top to bottom — the order is a
realistic consumer journey and later phases depend on earlier state. Tick a box
only when the **expected result** matched exactly; anything else goes in the
findings log verbatim (error text especially) even if it "mostly worked".

Companion docs: `NATIVE_APP_PLAN.md` (N3/N4 exit criteria this covers),
`STANDARD_MSSQL_CLIENT_TEST.md` (the standard-edition analog — its 32 findings
are folded in here, tagged `SQL#n`), `PRELAUNCH_CHECKLIST.md` §1 (column mode's
own mandatory protocol).

**Trimmed 2026-08-27 (owner request):** the script now carries only the
hands-on functionality tests (~96 items). Cut: the volume/stress phase (10),
failure-injection drills (9.9–9.12, 14.2–14.3), micro edge-inputs (2.9–2.11,
4.6/4.7/4.9, 5.7–5.8, 6.5–6.7, 7.12–7.13, 8.6/8.7/8.9–8.11, 1.10, 11.6),
column mode (7.5 — deferred with its own protocol), and the cosmetics sweep
(15.3–15.7). All remain in git history; the shipped fixes behind them stay
shipped — they're just not re-verified this round.

**Legend:** **[CORE]** must pass before selling · **[EDGE]** should pass, fix or
consciously accept · **[DEFER]** only if the feature ships in native v1 ·
**[UNVAL]** never validated live in any edition — expect to find things.

**Current state (2026-08-23):** package `PRISM_PKG` at **patch 38**; listing
`PRISM_TEST` installed in `IPINRDF.PRISM_CLIENT_TEST` as app **`PRISM_TEST`**;
ingress `eqtjl6-ipinrdf-prism-client-test.snowflakecomputing.app`. Both the dev
app (`PRISM_APP_TEST`) and the consumer app are **suspended**. Users:
`SANJIVP27` (admin, DEFAULT_ROLE ACCOUNTADMIN) and `psanjiv` (ANALYST).
Fixtures: `DEMO_DATA.OPEN` (analyst-visible), `DEMO_DATA.RESTRICTED`
(admin-only — the negative control).

---

## ⚠️ Four standing rules — read before touching anything

1. **NEVER roll an image with stop/start.** `RESUME` pins the old digest, and
   overwriting `:latest` orphans it into "Failed to pull image" *permanently*.
   New image ⇒ `CALL <app>.app_code.upgrade_app()` / `ALTER SERVICE … FROM
   SPECIFICATION`. This has bitten before.
2. **Suspend both apps when you stop for the day** — the compute pool and
   `PRISM_APP_WH` bill while up. `CALL PRISM_TEST.app_code.stop_app()`
   (consumer) and the same on `PRISM_APP_TEST` (dev).
3. **`DEMO_DATA.RESTRICTED` must never receive an app grant.** It is the
   negative control that proves the access model. If you grant it to debug
   something, note it and revoke it before continuing Phase 2.
4. **Genuinely-new distinct values cost Cortex credits** (the app itself is
   free — billing was removed 2026-08-27 — but Cortex tokens bill to the
   account). Reuse already-standardized values wherever a test doesn't need
   fresh ones.

---

## Phase 0 — Provider side: get to a testable patch

- [ ] **0.1 [CORE]** Confirm what is actually running: `SHOW VERSIONS IN
      APPLICATION PACKAGE PRISM_PKG` and, in the consumer account,
      `DESC APPLICATION PRISM_TEST` → note version + patch. **A new image +
      patch is REQUIRED this round**: patch 38 predates the billing removal
      (2026-08-27 — Phase 12 tests it) and may also lack the three role-picker
      commits (`9464fa9`, `1830a88`, `b7641aa`, 2026-08-17). Build + push an
      image, `ADD PATCH`, move the release directive (ACCOUNTADMIN-only), then
      upgrade the consumer.
- [ ] **0.2 [CORE]** Registry login works — the full flags are required (no
      saved `snow` connection exists; bare `--temporary-connection` fails with
      "User is empty"): `snow spcs image-registry login --temporary-connection
      --account icc84228.us-east-1 --user PRISM_SVC --private-key-file
      ~/rsa_key.p8 --authenticator SNOWFLAKE_JWT` (the snowsql/PAT paths are
      MFA-blocked). Verified 2026-08-27.
- [ ] **0.3 [CORE]** `CALL PRISM_TEST.app_code.start_app()` → pool +
      `PRISM_APP_WH` + service created; `SHOW ENDPOINTS IN SERVICE` returns the
      ingress URL within ~2 min.
- [ ] **0.4 [CORE]** Patch adds cleanly with **zero validator warnings**
      (`diag()` removal fixed the two that existed — a new warning is a finding).
- [ ] **0.5 [EDGE]** Consumer upgrade loop works end to end: `ALTER APPLICATION
      PRISM_TEST UPGRADE` (follows the directive) + `CALL
      PRISM_TEST.app_code.upgrade_app()` → new code live, no re-consent.

## Phase 1 — Install & first run

- [ ] **1.1 [CORE]** Install the app from the listing (Snowsight → Apps). Grant
      the requested account privileges (compute pool, warehouse, endpoint
      binding, `SNOWFLAKE.CORTEX_USER`) in the permission UI — nothing should
      require a worksheet.
- [ ] **1.2 [CORE]** A warehouse must exist *before* Get, and first login must
      happen in **Snowsight, not the ingress** (the ingress can't do a
      first-login password reset). Both are documented in the listing README.
- [ ] **1.3 [CORE]** Installer opens the URL → Snowflake auth → terms
      interstitial appears ONCE → accept → lands on home as **Admin**. The info
      box carries the shared-workspace sentence ("every user within your
      company's Snowflake account … regardless of their own database
      permissions") — its absence is a launch blocker (owner decision
      2026-08-14).
- [ ] **1.4 [CORE]** Welcome modal appears on first visit and dismisses from
      **either** button; does not reappear on reload.
- [ ] **1.5 [CORE]** `/setup` shows the native **"Prism is ready"** page (grant
      SQL + caller opt-in + Cortex note) — NOT the credential wizard. Its grant
      section warns that everyone with app access sees all mappings, including
      from tables their own permissions can't read.
- [ ] **1.6 [CORE]** Starter SQL is present and correct on `/setup` **and** the
      listing README: `ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'AWS_US'`
      + `GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO APPLICATION PRISM_TEST`.
      Claude is not native on Cortex even in us-east-1; these cannot be
      manifest-requested.
- [ ] **1.7 [CORE]** `/api/accounts/ai-status` probe: before the starter SQL it
      reports the problem; after it, a green check.
- [ ] **1.8 [CORE]** Native cuts hold: one-time source tabs are **Snowflake |
      CSV | Excel** with no Google Sheets and **no paste tab** (SQL#18); no
      email-invitation UI anywhere; `/debug` → 404.
- [ ] **1.9 [CORE]** Second user (`psanjiv`) opens the URL → arrives as **user**,
      not admin: no Settings item, no member management; pipelines and mappings
      visible.

## Phase 2 — Access & grants (the consumer's first real friction)

- [ ] **2.1 [CORE]** With NO data grants: type a real table into the one-time
      card → clean "Prism can't see this table" message, never a raw SQL error.
      The "Don't see your table?" panel shows grant SQL with the REAL app name
      resolved live.
- [ ] **2.2 [CORE]** Run the single-table grant SQL → table appears in the
      picker's type-ahead suggestions; columns load. (Native input is a
      **type-in with datalist**, never a dropdown — owner decision.)
- [ ] **2.3 [CORE]** Run the whole-schema form (`ALL TABLES`) on a second schema
      → all existing tables usable. Create a brand-new table there → it is **NOT**
      visible (Snowflake forbids FUTURE grants to an application — live-confirmed
      2026-08-16) → re-running the `ALL TABLES` grant picks it up. The panel says
      exactly this, in prose and not only in a SQL comment.
- [ ] **2.4 [CORE]** Caller grants NOT opted in: one-time on a table only the
      user (not the app) can read → clean rejection telling them to ask the owner
      / use the panel. Fails closed, no hang, no raw error.
- [ ] **2.5 [CORE]** Run the caller-grant opt-in from the panel — it must be
      `GRANT ALL INHERITED CALLER PRIVILEGES ON ALL SCHEMAS/TABLES IN DATABASE`
      (SELECT-only stalls at the scratch INSERT), needs MANAGE CALLER GRANTS,
      and **all statements must run** (Snowsight ▶ runs only one). Then repeat
      2.4 end-to-end including export to a new table in that database.
- [ ] **2.6 [CORE]** `SHOW GRANTS TO APPLICATION PRISM_TEST` confirms the app
      still holds **zero direct grants** in that database, and the export table
      is owned by the **user's** role.
- [ ] **2.7 [CORE]** No dev-mode mirror needed: 2.5 works WITHOUT any
      `GRANT CALLER … TO ROLE` statements. A listing install has no owner role —
      this failing means the dev-mode rule leaked into production.
- [ ] **2.8 [CORE]** `DEMO_DATA.RESTRICTED` (never granted) stays invisible to
      the app *and* to `psanjiv`'s caller session throughout. Negative control.

## Phase 3 — Caller's rights & role selection ⚠️ THE RESUME POINT [UNVAL]

Everything here shipped 2026-08-17 and **has never been exercised live**. The
underlying finding: a caller session rides the user's DEFAULT role, and
Snowflake's CREATE check consults only the **PRIMARY** role — the Snowsight role
picker is irrelevant to it.

- [ ] **3.1 [CORE][UNVAL]** **"Create as role" actually acts.** In the one-time
      export dialog pick a non-default role that has CREATE TABLE on the
      destination → export succeeds and `SHOW GRANTS ON TABLE <target>` shows
      that role as owner. This is the single most important unvalidated item.
- [ ] **3.2 [CORE][UNVAL]** "My default role" (blank) still works as before.
- [ ] **3.3 [CORE][UNVAL]** Pick a role that **lacks** CREATE TABLE on the
      destination → honest permission message naming the role, not a grants
      panel aimed at the app.
- [ ] **3.4 [CORE][UNVAL]** The picker's role list is real: it comes from
      `CURRENT_AVAILABLE_ROLES()` on the caller session (`SHOW ROLES` is blocked
      there). Compare against what Snowsight shows for that user.
- [ ] **3.5 [CORE][UNVAL]** `USE SECONDARY ROLES ALL` is applied on every caller
      session — a table reachable only via a secondary role is readable.
- [ ] **3.6 [CORE][UNVAL]** **"Who can read this table" = Public** (default) →
      `GRANT SELECT … TO ROLE PUBLIC` applied; `psanjiv` can query the export.
      This default is what the terms promise — verify the terms still match.
- [ ] **3.7 [CORE][UNVAL]** **"Only my role"** → no grant issued; `psanjiv`
      cannot see it.
- [ ] **3.8 [CORE][UNVAL]** **"Role: X"** from the list → only that role reads it.
- [ ] **3.9 [EDGE][UNVAL]** **"Another role…"** with a typed name: valid role
      works; a nonexistent role fails with a clear message and does **not** lose
      the export (the table is created, the grant is best-effort).
- [ ] **3.10 [CORE]** Service-path exports are APP-OWNED and unreadable by the
      user — confirm the native one-time create route is **caller-first**, so
      this path is not reached in normal use. (The MANAGE GRANTS workaround is
      the documented escape hatch if it is.)
- [ ] **3.11 [EDGE]** Caller path works for a user whose DEFAULT_ROLE is a plain
      role (not ACCOUNTADMIN) — `psanjiv`/ANALYST is the realistic case, and the
      one a customer will actually hit.

## Phase 4 — One-time standardization: warehouse source

- [ ] **4.1 [CORE]** Single column → review groups → export, **Create new
      table** → table exists with all source columns, watched column
      standardized, unmapped/NULL values passed through raw.
- [ ] **4.2 [CORE]** Export again, **create mode, same name** → honest "already
      exists" message. Must be a plain `CREATE TABLE` — never `CREATE OR
      REPLACE`, never a grants panel (fixed 2026-08-14; under caller rights the
      collision used to surface as "must have CALLER OWNERSHIP" misclassified as
      needs-grants).
- [ ] **4.3 [CORE]** Export, **Overwrite existing** onto a table you own →
      contents replaced; row count right.
- [ ] **4.4 [CORE]** Multi-column session (2 columns, different specs) →
      per-column review pages → one export carrying both standardized columns.
- [ ] **4.5 [CORE]** One-time history: both sessions listed with target + date;
      opening an archived session shows its mappings (reconstructed from
      `RUN_STATE` — the `mappings` column is dead).
- [ ] **4.8 [EDGE]** Naming convention on a one-time spec (regex, e.g.
      `^[A-Z][a-z]+$`): Cortex names conform; a violating rename in review is
      blocked with the per-requirement reason; an `examples`/`natural` convention
      displays as guidance and does NOT block renames.

## Phase 5 — One-time: file sources

- [ ] **5.1 [CORE]** CSV upload: header row auto-detected AND the override input
      is shown; a header on row 5 is handled correctly (the data range must move
      with the header, not just the detection).
- [ ] **5.2 [CORE]** XLSX upload with multiple tabs → tab selector, no
      auto-select; column dropdown, never a guess.
- [ ] **5.3 [CORE]** **Edit-in-place round trip**: export the CSV/XLSX back →
      the downloaded file is the customer's original bytes with ONLY the
      standardized cells changed (hidden columns, styles, column order intact).
- [ ] **5.4 [CORE]** `.xls` (non-zip) falls back to the regenerated export
      rather than producing a corrupt "original".
- [ ] **5.5 [CORE]** Re-export an uploaded CSV **as a CSV** → works. It must not
      validate the warehouse-destination field (SQL#9: the prefill derives from
      the filename, so `My Data.csv — Sheet1_STANDARDIZED` used to be rejected as
      an invalid `DB.SCHEMA.TABLE`).
- [ ] **5.6 [CORE]** Export a file session to a **warehouse table** → works on
      the caller path.

## Phase 6 — Review UI mechanics (any run)

- [ ] **6.1 [CORE]** Drag between groups, rename a group, create a group, move an
      ungrouped value — all persist across a reload (30 s autosave + the blob's
      `rev`).
- [ ] **6.2 [CORE]** Two tabs on the same run → the second save gets a 409, the
      client refetches and rebases without losing the newer edits.
- [ ] **6.3 [CORE]** **The referee is OFF** (owner decision 2026-08-18, SQL#15):
      move a lookup-confirmed value into a different group and export → the move
      is written **verbatim**, no revert, no validation delay. This is a
      behaviour customers will notice.
- [ ] **6.4 [CORE]** Standardization-rules panel renders at the top of the review
      page; the convention shows for ALL four types with the correct
      "Enforced"/"Guidance for the AI" label.

## Phase 7 — Pipelines: creation & output modes

- [ ] **7.1 [CORE]** Create a pipeline on a granted table → `pending_baseline` →
      "Create initial standardizations" → review → **Accept** → advances to the
      activation card (nothing written to the lookup yet) → **Begin Pipeline
      Standardization** → mappings committed, `paused → active`.
- [ ] **7.2 [CORE]** Export kind **Table**: export table built in the consumer
      schema, correct rows, and `COPY GRANTS` preserved across a rebuild.
- [ ] **7.3 [CORE]** Export kind **View**: created once at activation; break it
      (drop it by hand) → "Recreate view now" in Settings repairs it and clears
      the flag.
- [ ] **7.4 [CORE]** Export kind **Lookup table only** (no destination) → no
      export object created, pipeline still healthy.
- [ ] **7.6 [CORE]** An **unbuildable export destination** blocks creation with
      the fix SQL and creates NO pipeline row (SQL#7 — previously it created a
      pipeline that paused, and resuming cleared the flag leaving an "active"
      pipeline with no export table).
- [ ] **7.7 [CORE]** **Destination collision guard** (SQL#21): point a second
      pipeline (or a one-time export) at an existing pipeline's destination →
      409 before any row is written. Sibling columns of the SAME source still
      share one export table by design.
- [ ] **7.8 [CORE]** **Multi-column pipeline** on one table (SQL#12): both
      columns' rebuilds of the shared export are **serialized**, not raced — no
      "name already in use", no stranded half-built table, and no spurious
      permissions warning on the FIRST build.
- [ ] **7.9 [CORE]** Add a column to an already-live pipeline → the live card
      stays **visible** while the new column's baseline builds (the
      card-visibility rule), then both columns show.
- [ ] **7.10 [CORE]** Delete a pipeline → clean 200, no 500 (SQL#6), no stray
      `DROP STREAM` error, export object handled per the documented rule.
- [ ] **7.11 [CORE]** **Manual re-standardization on an ACTIVE pipeline**
      (SQL#16): trigger "Update Standardizations", review, Accept → the export
      happens **immediately** (write + dequeue + rebuild) and you land back on
      the pipelines tab — NOT in the "Begin pipeline" activation card.

## Phase 8 — Update schedules & time windows [UNVAL]

**Never exercised in any edition — only 24/7 and manual have ever been run.**
The 10-minute tick checks `isScheduleActiveNow()` at fire time; the poller runs
regardless of schedule and only queues.

- [ ] **8.1 [CORE][UNVAL]** Creation default is **Mon–Fri, 9 AM–5 PM** in the
      creator's browser timezone, and the stored schedule carries the IANA
      timezone name.
- [ ] **8.2 [CORE][UNVAL]** **Window CLOSED:** set a window that excludes now →
      insert new values → within a minute they are **queued** (`queue_size` rises,
      card shows the backlog) and **no standardization runs** at the next
      10-minute mark. `fully_synced_at` must **freeze**, not advance.
- [ ] **8.3 [CORE][UNVAL]** **Window OPENS:** move the window to include now →
      the first tick after it opens drains the whole backlog and rebuilds the
      export.
- [ ] **8.4 [CORE][UNVAL]** **24/7** (`always`): values standardize at the next
      10-minute mark regardless of hour.
- [ ] **8.5 [CORE][UNVAL]** **Manual only**: nothing ever auto-standardizes; the
      "Update Standardizations" button works; the **Pause button is hidden**.
- [ ] **8.8 [CORE][UNVAL]** Schedule is **editable post-creation** in the card's
      Settings tab and takes effect without a restart.

## Phase 9 — Detection, mass events & recovery

- [ ] **9.1 [CORE]** Insert rows with **new** values → detected ≤1 min (stream),
      standardized at the next tick, export rebuilt. Correct lookup/new split in
      the logs.
- [ ] **9.2 [CORE]** Insert rows carrying **already-known** values → they still
      queue (consistent-snapshot) and the tick republishes them with **zero LLM
      calls**; the export row count catches up. `fully_synced_at` must not claim
      freshness while the export is short (SQL#30 — this was the mssql bug;
      Snowflake should be structurally immune, so this is a confirmation).
- [ ] **9.3 [CORE]** **Delete** rows → hygiene rebuild within the same
      minute-mark cycle; export loses the rows; the lookup is untouched.
- [ ] **9.4 [CORE]** **Update** a row's value → delete-half rebuilds, insert-half
      queues and standardizes.
- [ ] **9.5 [CORE]** **Raw passthrough** (`export_unmapped_rows` ON, SQL#17):
      insert a brand-new value → it appears in the export **at detection** with
      its raw value, then as the canonical after the tick. With the toggle OFF,
      the old behaviour holds (nothing until the tick).
- [ ] **9.6 [CORE]** `CREATE OR REPLACE` the source table (wipes change tracking)
      → the app detects the stale stream, recreates it, and **recovers the gap**
      (both unmapped→queue and already-mapped→export). Nothing is silently lost.
- [ ] **9.7 [CORE]** `TRUNCATE` / bulk reload → the top-of-hour safety rebuild
      reconciles source and export exactly.
- [ ] **9.8 [CORE]** Re-activating a pipeline (`PATCH status='active'`) does NOT
      swallow rows written between the initial scan and the next poll (SQL#19 was
      exactly this on mssql — verify the Snowflake path).

## Phase 10 — Volume & stress — DEFERRED (trimmed 2026-08-27)

Consciously not part of this round: the 2M-row scan/rebuild/stream drills,
memory/timeout/SQLite-growth audits, the 5,000-value installment drain, the
baseline-cap sweep, and awkward-shape sources. Run before onboarding a
volume-shaped customer; the full item list is in git history (this file,
pre-2026-08-27).

## Phase 11 — Lookup & mappings

- [ ] **11.1 [CORE]** Mappings tab lists confirmed mappings for the column's spec.
- [ ] **11.2 [CORE]** Lookup export → **CSV** and **Excel** download correctly.
- [ ] **11.3 [CORE]** Lookup export → **Snowflake table**: the target field is
      **prefilled and editable** (SQL#22 — it used to be grey placeholder text),
      and the route refuses a `PRISM_DB.INTERNAL` target.
- [ ] **11.4 [CORE]** Google Sheets export is **absent** in native.
- [ ] **11.5 [EDGE]** Multi-column pipeline → the export modal's column picker
      scopes to the chosen spec.

## Phase 12 — Free edition: no metering, no charges

The app is free (owner decision 2026-08-27): the §2.8 meter, both warehouse
ledgers, the `EMIT_BILLING` proc, and the Settings → Usage surface were all
removed. This phase verifies the removal is total — nothing counts, nothing
emits, nothing shows. (The dev install accrued ~$10.63 of pending test
charges under the old meter; they must vanish, not drain.)

- [ ] **12.1 [CORE]** Settings has **no Usage section**; `/api/accounts/usage`
      returns 404.
- [ ] **12.2 [CORE]** After the upgrade, `SHOW TABLES IN SCHEMA
      <app>.internal_state` lists **no** `BILLING_METER` / `BILLING_EVENTS`
      (setup.sql drops them), and `SHOW PROCEDURES IN SCHEMA <app>.app_code`
      lists **no** `EMIT_BILLING`.
- [ ] **12.3 [CORE]** Run a standardization pass and a one-time export, then
      check query history: **no metering statements** (no INSERT into a billing
      table, no `SYSTEM$CREATE_BILLING_EVENT`) — only the mapping/export SQL.
- [ ] **12.4 [CORE]** The listing itself is configured **free** — no pricing
      plan / billable items on `PRISM_TEST` (and on the eventual public
      listing); the install flow shows no charge or payment step.
- [ ] **12.5 [EDGE]** The dev app (`PRISM_APP_TEST`) after its upgrade: old
      pending ledger charges are gone with the tables; nothing ever emits.

## Phase 13 — Team, roles & sessions

- [ ] **13.1 [CORE]** First user is admin; `psanjiv` arrives as user. Roles gate
      Team management, Usage and Pipeline health only.
- [ ] **13.2 [CORE]** No invitation UI, no email anywhere in native.
- [ ] **13.3 [CORE]** Promote/demote via Team → the affected user's live session
      is revoked immediately (`session_version` bump).
- [ ] **13.4 [CORE]** Last-admin and self-delete guards hold.
- [ ] **13.5 [EDGE]** Both users see the same pipelines and mappings — including
      values from tables their own permissions can't read. This is the disclosed
      shared-workspace behaviour; confirm it matches the interstitial's wording
      exactly.

## Phase 14 — Upgrade, patch & uninstall drills (Phase N4)

- [ ] **14.1 [CORE][UNVAL]** **Schema migration drill**: install → create real
      pipeline data → publish a version with a new column on an INTERNAL table →
      upgrade → data intact, poller resumes, no re-consent.
- [ ] **14.4 [CORE][UNVAL]** **Uninstall** leaves no orphaned account-level
      objects (pool, warehouse, endpoints); consumer-schema export tables owned by
      the user's role survive, and that is the documented behaviour.
- [ ] **14.6 [CORE][UNVAL]** **Auto-upgrade rolls the container** (the
      `version_initializer` added 2026-08-28, first shipped in patch 40): move
      the release directive to a new patch and run `ALTER APPLICATION
      PRISM_TEST UPGRADE` (or wait for the background auto-upgrade) —
      **without calling `upgrade_app()`** → the service picks up the new
      image/spec by itself (`SHOW SERVICE CONTAINERS IN SERVICE
      PRISM_TEST.services.prism_app` shows a fresh container start), and the
      app serves the new version.
- [ ] **14.7 [CORE][UNVAL]** **version_init is harmless where there is nothing
      to refresh**: a fresh listing install (no privileges granted yet, no
      service) completes without error — the callback returns its quiet no-op
      instead of failing the install. (Covered implicitly by any fresh 1.1
      install on patch ≥40 — tick it there.)

## Phase 15 — Cosmetics, copy & disclosures (one pass at the end)

- [ ] **15.1 [CORE]** `/terms` + `/privacy` native wording is true: no
      provider-side storage claim, the data-loss disclaimer present, contact is
      `sanjivp2703@gmail.com`, privacy says Prism and its employees have no
      access. (Both still pending counsel — note that, don't fix it here.)
- [ ] **15.2 [CORE]** Terms interstitial AI clause is edition-correct (native
      says "every user within your company's Snowflake account").

## Phase 16 — Suspend & stop ⚠️ REQUIRED

- [ ] **16.1** `CALL PRISM_TEST.app_code.stop_app()` (consumer).
- [ ] **16.2** Dev app `PRISM_APP_TEST` still suspended.
- [ ] **16.3** Confirm the compute pool is suspended (it auto-suspends, but
      check) and note `PRISM_APP_WH` credit usage for the session.
- [ ] **16.4** Record results: update this file's boxes, the findings log below,
      `NATIVE_APP_PLAN.md` phase status, and the `native-app-marketplace` memory
      note.

---

## Findings log (add as the walkthrough surfaces them)

Format: number, one-line title with **live/FIXED/NOT FIXED** status, then what
actually happened and what changed. Same convention as
`STANDARD_MSSQL_CLIENT_TEST.md`.

1. _(none yet — this round starts at Phase 0)_

---

## Traceability: SQL Server findings → native coverage

| SQL# | Finding | Native |
|---|---|---|
| 1–5 | mssql setup wizard: ordering, script comments, grant generator, placeholders, CREATE TABLE grant | **N/A** — native has no credential wizard; the analog is Phase 1.5–1.6 + Phase 2 grant panels |
| 6 | Pipeline DELETE 500 (`source_type`) | **7.10** |
| 7 | Unbuildable export still created a pipeline | **7.6** |
| 8 | URL pasted as table name → misleading grants error | **2.9 / 2.10** |
| 9 | One-time CSV re-export blocked by destination validation | **5.5** |
| 10 | Inline grant SQL under the picker | **2.1 / 2.2** (native variant) |
| 11 | Stale copy / harmless DROP STREAM / CT loop noise / Sheets re-click | **11.6**; rest mssql-only |
| 12 | Multi-column rebuild race + false permissions warning | **7.8** |
| 13 | Phantom column entry disabled create | **7.12 / 2.11** |
| 14 | Column-mode permission error misread as "table dropped" | **7.5** (if column mode ships) |
| 15 | Referee disabled (product decision) | **6.3** |
| 16 | Manual re-standardization routed into Begin wizard | **7.11** |
| 17 | Raw passthrough didn't show until the tick | **9.5** |
| 18 | One-time source tabs; paste deleted | **1.8** |
| 19 | CT re-baseline swallowed rows | **9.8** (Snowflake analog) |
| 20, 28 | One-time destination defaults per connection | **4.1 / 3.10** |
| 21 | Silent export-destination collisions | **7.7** |
| 22 | Lookup export target was placeholder text | **11.3** |
| 23–24 | SMTP failure / invite UX | **N/A** — no email in native |
| 25 | British spellings | **15.3** |
| 26–27, 29 | Personal-credential prefill/readonly/fallback | **N/A** as written — native's analog is caller's rights, **Phase 3** |
| 30 | Known values never reached the export promptly | **9.2** |
| 31 | Column-mode consent promised access Prism couldn't grant | **7.5** |
| 32 | Per-table write access outlived the pipeline | **7.5** |

*(Traceability rows pointing at trimmed items — SQL#8 → 2.9/2.10, SQL#13 →
7.12/2.11, SQL#14 → 7.5, SQL#25 → 15.3, SQL#11 → 11.6 — refer to fixes that
remain shipped but are not re-verified in the trimmed run.)*
