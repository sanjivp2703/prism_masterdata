# Standard-edition client onboarding rehearsal (SQL Server + vendor AI key)

A live simulation of a real prospect's onboarding, run exactly the way a real
client would be onboarded: a fresh droplet, a real subdomain with HTTPS, the
real deploy script, and the standard edition configured as **warehouse = SQL
Server, AI = vendor-provided Anthropic key** (the "Prism-provided AI" tier).
Companion to `docs/NATIVE_TEST_SCRIPT.md` (the native-edition analog).

The ONE stand-in vs. real life: a real client already owns a SQL Server full
of data. Here, a Docker SQL Server container on the test droplet plays that
role, pre-loaded with fabricated business data. Everything else is identical.

**Cast:** `sanjivp27@gmail.com` plays the client admin. The operator's own
account (`sanjivp2703@gmail.com`) stays out of the client workspace except as
an invited second user if desired.

---

## ⚠️ Two standing rules — read before touching anything

1. **The test droplet (`prism-clienttest`) MUST be destroyed when the test is
   done** (Phase 9). It bills ~3.5¢/hour until destroyed. "Power off" does
   NOT stop billing — only **Destroy** does.
2. **NEVER destroy the `prismmasterdata.com` droplet (167.99.235.20).** That
   is the production instance and is not part of this test. The destroy
   dialog makes you type the droplet's name — only ever type
   `prism-clienttest`.

---

## Phase 1 — Create the test droplet (DigitalOcean, browser)

1. cloud.digitalocean.com → Create → Droplets.
2. Region: same as prod. OS: **Ubuntu 24.04 x64**.
3. Size: **Basic / Regular / 4 GB RAM** (~$24/mo, billed hourly). Real client
   deploys use 2 GB — the extra 2 GB here is only because the stand-in SQL
   Server container shares the box.
4. Auth: the existing SSH key. Hostname: `prism-clienttest`.
5. Create; copy the droplet IP (referred to as `<DROPLET_IP>` below).

## Phase 2 — DNS (Cloudflare, browser)

Add an **A** record on `prismmasterdata.com`: name `clienttest`, value
`<DROPLET_IP>`, **gray cloud (DNS only — never proxied**; proxying breaks SSE
and TLS issuance).

## Phase 3 — Provision the server (terminal, laptop 1, repo root)

```bash
scp deploy/setup-server.sh root@<DROPLET_IP>:/root/
ssh root@<DROPLET_IP> bash /root/setup-server.sh clienttest.prismmasterdata.com
```

## Phase 4 — Google OAuth (browser)

console.cloud.google.com → APIs & Services → Credentials → the Prism OAuth
client → add authorized origin `https://clienttest.prismmasterdata.com` and
redirect URI `https://clienttest.prismmasterdata.com/api/auth/google/callback`.
(Real onboarding does this with the client's domain.)

## Phase 5 — Production env on the droplet

Create `/home/prism/app/stand-ui/.env.local` (owner `prism`, mode 600):
fresh `SESSION_SECRET` + `PRISM_ENCRYPTION_KEY` (`openssl rand -hex 32` each —
**both into the password manager, filed per-client**),
`ADMIN_EMAIL=sanjivp27@gmail.com`, `APP_URL` + `GOOGLE_REDIRECT_URI` on the
clienttest domain, the Google client ID/secret, the `SMTP_*` block, and
`ANTHROPIC_API_KEY=<vendor key>` — ideally a dedicated per-client Anthropic
Console Workspace key with a monthly spend cap (the real operating rule).
NO `PRISM_FRESH_SETUP`, no `MSSQL_*`, no debug flags, no custom SQLite path —
a real install's env is this simple.

## Phase 6 — Deploy (terminal, laptop 1, repo root)

```bash
bash deploy/deploy.sh <DROPLET_IP>
```

Success: `active (running)` status; `https://clienttest.prismmasterdata.com`
serves the login page with a valid certificate.

## Phase 7 — Stand-in: "the client's SQL Server" (on the droplet)

```bash
ssh root@<DROPLET_IP>
curl -fsSL https://get.docker.com | sh
docker run -d --name client-sqlserver --restart unless-stopped \
  -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='PrismDev!Passw0rd' \
  -p 127.0.0.1:1433:1433 \
  mcr.microsoft.com/mssql/server:2022-latest
# wait ~30s; verify:
docker logs client-sqlserver | grep "ready for client"
```

Pre-load the fabricated client data (interactive sqlcmd; statements execute
on `GO`):

```bash
docker exec -it client-sqlserver /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P 'PrismDev!Passw0rd' -C
```

```sql
CREATE DATABASE CLIENT_DB;
GO
USE CLIENT_DB;
GO
CREATE TABLE dbo.CUSTOMER_ORDERS (
  order_id INT IDENTITY PRIMARY KEY,
  carrier  NVARCHAR(200)
);
GO
INSERT INTO dbo.CUSTOMER_ORDERS (carrier) VALUES
 (N'att'), (N'AT&T Wireless'), (N'a t and t'), (N'AT&T'),
 (N'VZW'), (N'Verizon'), (N'verizon wireless'),
 (N'T-Mobile'), (N'tmobile'), (N'T Mobile US'),
 (N'Sprint'), (N'sprint pcs'),
 (N'US Cellular'), (N'u.s. cellular'),
 (N'Boost'), (N'boost mobile');
GO
```

Do NOT run the Prism install script or any grants here — those are the
client DBA's job during the walkthrough (that's the rehearsal).

## Phase 8 — The client walkthrough (any browser; laptop 2 for realism)

1. `https://clienttest.prismmasterdata.com` → Google sign-in as
   `sanjivp27@gmail.com`.
2. **Terms interstitial** — verify the 2026-08-17 standard-edition copy:
   "every member of your company's **Prism workspace**" (not "Snowflake
   account"), and an AI clause with NO "billed to your company's provider
   account" claim.
3. Wizard step 1: **Microsoft SQL Server**.
4. Wizard step 2 (as "the DBA", via `ssh root@<DROPLET_IP>`):
   - Install script:
     `docker exec -i client-sqlserver /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P 'PrismDev!Passw0rd' -C < /home/prism/app/01_internal_tables.mssql.sql`
   - Service login (interactive sqlcmd):
     ```sql
     CREATE LOGIN prism_svc WITH PASSWORD = 'PrismSvc!Client9';
     GO
     USE PRISM_DB;
     GO
     CREATE USER prism_svc FOR LOGIN prism_svc;
     ALTER ROLE PRISM_SERVICE ADD MEMBER prism_svc;
     GO
     ```
   - Data access + Change Tracking (the wizard's templates, filled in):
     ```sql
     USE CLIENT_DB;
     GO
     CREATE USER prism_svc FOR LOGIN prism_svc;
     GRANT SELECT ON SCHEMA::dbo TO prism_svc;
     GO
     ALTER DATABASE CLIENT_DB SET CHANGE_TRACKING = ON
       (CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON);
     GO
     ALTER TABLE dbo.CUSTOMER_ORDERS ENABLE CHANGE_TRACKING;
     GO
     GRANT VIEW CHANGE TRACKING ON SCHEMA::dbo TO prism_svc;
     GO
     CREATE SCHEMA PRISM_OUT;
     GO
     GRANT CONTROL ON SCHEMA::PRISM_OUT TO prism_svc;
     GO
     ```
5. Wizard step 3: server `localhost`, user `prism_svc`, password from above,
   trust-server-certificate ON.
6. Wizard step 4: should read **"already configured on the server"** → Keep
   current setup. Note the exact wording (open item: "AI is included with
   your Prism installation" copy).
7. Wizard step 5: verification checklist → finish.
8. Product exercises:
   - Pipeline on `CLIENT_DB.dbo.CUSTOMER_ORDERS` (expect the Change Tracking
     consent checkbox — table has a PK) → review → Begin.
   - Insert/update/delete rows via sqlcmd; expect detection ≤1 min, standardization
     at the next 10-minute tick, export rebuild on delete.
   - One-time standardization with a CSV upload.
   - Settings → Team → invite a second user (real email; link works anywhere).
   - **Personal-credential one-time export** (live-validates the 2026-08-17
     scratch-relocation port — see `docs/WAREHOUSES.md` One-time export row;
     clear its "code-only" warning if this passes):
     ```sql
     CREATE LOGIN analyst1 WITH PASSWORD = 'Analyst!Test9';
     GO
     CREATE DATABASE PRIVATE_DB;
     GO
     USE PRIVATE_DB;
     GO
     CREATE USER analyst1 FOR LOGIN analyst1;
     ALTER ROLE db_owner ADD MEMBER analyst1;
     GO
     CREATE TABLE dbo.SECRET_VENDORS (id INT IDENTITY PRIMARY KEY, vendor NVARCHAR(200));
     INSERT INTO dbo.SECRET_VENDORS (vendor) VALUES (N'IBM'), (N'I.B.M.'), (N'International Business Machines');
     GO
     ```
     Save `analyst1` as personal credentials (non-admin `/setup` variant),
     then one-time standardize + export `PRIVATE_DB.dbo.SECRET_VENDORS`.
   - **User-connection PIPELINE** (built 2026-08-17 mid-test, never live-run —
     first validation happens here): with `analyst1` saved as personal
     credentials, create a normal PIPELINE on `PRIVATE_DB.dbo.SECRET_VENDORS`
     (export kind Table, destination e.g. `PRIVATE_DB.dbo.SECRET_VENDORS_STD`).
     Expected: create-initial-run's service scan fails with access error →
     falls back to analyst1's credentials, sets
     `pipelines.use_user_connection=1`, review works, Begin activates, the
     poller detects inserted rows (diff scan on analyst1's connection), the
     tick standardizes, and the export table rebuilds — owned by analyst1's
     access, staging tables appearing transiently in the DESTINATION schema,
     never in PRISM_DB.INTERNAL. Then break it on purpose:
     `ALTER LOGIN analyst1 DISABLE;` → within a minute the pipeline should
     PAUSE with the personal-credentials message (no workspace-wide banner);
     `ALTER LOGIN analyst1 ENABLE;` + resume → recovers.

## Findings log (running — add as the walkthrough surfaces them)

1. **Step-2 ordering stumble (UX) — FIXED 2026-08-17:** the DBA can run
   Part B before Part A and hits a raw "Database 'PRISM_DB' does not exist".
   Part B's copy now says to run Part A first, names that exact error, and
   notes the skip-the-CREATE-LOGIN-line rule for re-runs.
2. **Install-script comments were dev-facing (FIXED 2026-08-17):** the served
   scripts mentioned demo data, dev runners, cross-engine comparisons, and
   internal architecture. All four `01_internal_tables*` scripts rewritten
   customer-facing; hygiene rule added to CLAUDE.md.
3. **No grant generator for SQL Server (wizard parity gap) — FIXED
   2026-08-17:** step 2's Part C is now "Give Prism access to your data" with
   a typed DATABASE.SCHEMA input generating idempotent, filled-in SQL
   (`buildMssqlDataAccessSql`): database user + schema read grant, Change
   Tracking (guarded ALTER DATABASE), and an export-area schema that is now
   CREATED before being granted (the old static template granted CONTROL on
   `<export_schema>` without ever creating it). Only the per-table ALTER
   TABLE line keeps a placeholder (table names unknowable). Not yet
   re-walked in the live wizard — verify on the next pass through step 2.
4. **Part C placeholder + sqlcmd friction (owner request 2026-08-17, FIXED
   same day):** the `<table>` placeholder confused even the owner (pasted
   unedited it aborts the whole batch), and the GO-less output silently did
   nothing in sqlcmd. Generator reworked: `DATABASE.SCHEMA` now enables
   Change Tracking on EVERY primary-keyed table in the schema via a
   server-side loop (PK-less tables PRINTed and skipped);
   `DATABASE.SCHEMA.TABLE` entries target specific tables; zero placeholders
   in either mode; every block ends in GO so it auto-runs in sqlcmd and SSMS
   alike. Verify live on the owner's self-run walkthrough of Part C.

5. **Part C omitted the CREATE TABLE grant + destination defaulted into dbo
   (live, owner's first pipeline; FIXED 2026-08-17):** table-mode exports
   need database-level CREATE TABLE *plus* rights on the destination schema;
   the generated SQL granted neither piece for a `dbo` destination, so the
   first pipeline paused with "CREATE TABLE permission denied". Fixes: the
   generator's export-area block now includes `GRANT CREATE TABLE TO
   prism_svc` (safe — schema rights stay confined to PRISM_OUT), and the
   connect form's suggested destination on mssql now defaults into
   `<db>.PRISM_OUT.<table>_STANDARDIZED` (the schema Part C actually
   grants) instead of the source schema.
6. **Every pipeline DELETE threw 500 (live; FIXED 2026-08-17):** the DELETE
   route still keyed its old Sheets sibling-delete on `source_type`, a
   column migration 016 dropped — "no such column: source_type" on every
   delete. Route simplified to warehouse-only per-pipeline delete.
7. **Unbuildable export ≠ blocked creation (live, owner report; FIXED
   2026-08-17):** a pipeline whose standardized table could never be built
   was still created — it paused with the fix SQL, but resuming cleared the
   message and left an "active" pipeline with NO export table and no
   indication. POST /api/pipelines now verifies buildability (perms via
   HAS_PERMS_BY_NAME; consented auto-grant attempted) BEFORE creating
   anything and 400s with the exact fix SQL — no pipeline row. Skipped when
   the service login can't see the source either (candidate user-connection
   pipeline; validated on the creator's connection at create-initial-run).

8. **URL pasted as table name → misleading grants error + stale copy (live,
   owner report; FIXED 2026-08-17):** a pasted URL splits into three
   dot-parts, passes the shape check, and dies in SQL ("Incorrect syntax
   near 'HTTPS:'") — surfaced as "Prism can't see this table … Part D",
   sending the user chasing grants for a typo. /api/columns now rejects
   URL-shaped and non-identifier input BEFORE any SQL with a plain "that
   looks like a web address / not a valid table name" 400. The
   pipeline-surface can't-see message is also warehouse-aware now: mssql
   cites Part C and offers the personal-credentials remedy (user-connection
   pipelines); "Part D" copy is Snowflake-only.

9. **One-time CSV re-export blocked by warehouse destination validation
   (live, owner report; FIXED 2026-08-17):** /api/one-time/export validated
   `target_fqn` as a warehouse table name unconditionally, but the client
   sends its prefilled destination regardless of format — for an uploaded
   file that prefill derives from the FILENAME, so exporting a CSV back as
   a CSV died with "Invalid destination. Expected DB.SCHEMA.TABLE, got:
   My Data.csv — Sheet1_STANDARDIZED". Validation now runs only for
   `format === 'warehouse'`; csv/excel/sheets never read the field.

10. **Access error now hands over the fix inline (owner request 2026-08-17;
    BUILT):** when the connect form's columns probe answers "service login
    can't see this table" on mssql, an inline panel under the picker renders
    the EXACT grant SQL for the typed table (shared generator
    `app/components/mssql-access-sql.ts`, now also powering setup Part C)
    with a copy button + a link to setup. No more walking back to the wizard.
11. **Pending polish (found in logs 2026-08-17/18, NOT yet fixed):**
    (a) lookup-table warehouse export error says "Failed to create Snowflake
    table" on mssql installs (stale copy); (b) deleting a pipeline on mssql
    logs a harmless `DROP STREAM` failure (Snowflake-only cleanup runs
    unconditionally — gate on adapter kind); (c) Part C's schema-wide CT
    loop's skip message lists SQL Server's internal
    `MSchange_tracking_history` table (exclude `is_ms_shipped`/that name);
    (d) after connecting Google for a Sheets export, the user must re-click
    the export (no auto-retry after the OAuth round-trip) — confusing,
    live-hit twice.

12. **Multi-column pipeline alerts: false permissions scare + rebuild race
    (live, A5 test; FIXED 2026-08-18):** export table built fine, but (a) a
    spurious "cannot preserve access permissions" warning fired on every
    FIRST build (HAS_PERMS_BY_NAME returns NULL on a nonexistent table —
    also the earlier "mystery banner"); (b) the two sibling columns raced
    concurrent rebuilds of the shared export — the loser died on sp_rename
    "name already in use", was misreported as a missing-grants pause, and
    stranded a half-built `__prism_new_` table in the export schema. Fixes:
    first-build detection skips the preserve probe/warning/capture; rebuilds
    of the same export table are now serialized (chained, not coalesced);
    the replacement table is dropped in `finally` on failure. Two stranded
    tables cleaned up by hand.

13. **Phantom column entry disabled the create button (live, A3 setup;
    FIXED 2026-08-18):** selected-column entries survive table changes and
    errored fetches unvalidated, so a stale/duplicate/empty/non-text
    leftover could linger invisibly — the form read "2 selected" with one
    visible checkbox and "Create initial standardizations" silently
    disabled. Column loads now prune entries to real, text-eligible,
    unique columns of the loaded table. (Also hardened the grant-SQL
    panel's state resets across all fetch outcomes — the owner saw the
    panel persist after switching to an accessible table; likely a stale
    bundle from the concurrent deploy, but now belt-and-braces.)

14. **Column-mode permission failure misread as "table dropped" (live, A3;
    FIXED 2026-08-18):** SQL Server hides objects a login can't ALTER, so
    its permission error reads "Cannot find the object … does not exist or
    you do not have permissions" — the failure classifier matched the
    "does not exist" half and broadcast a spurious "table may have been
    dropped/renamed" alert alongside the correct grant-needed flag. The
    classifier now reads that exact phrasing as 'privilege' (the sync only
    reaches ALTER after successfully listing the table's columns, so the
    object provably exists). The expected A3 grant flag itself behaved
    correctly; fix SQL run as sa, REGION_STANDARDIZED column added.

15. **C3 verdict → PRODUCT DECISION: referee disabled (2026-08-18):** the
    referee correctly reverted the owner's deliberate Boost→AT&T move — and
    the owner ruled the feature itself out: the customer's specified mapping
    always wins. `EXPORT_REFEREE_ENABLED = false` in op-export.ts (machinery
    retained); CLAUDE.md invariants + PRODUCT_DECISIONS.md updated.

16. **Manual re-standardization routed into the "Begin pipeline" wizard
   (live, owner report; FIXED 2026-08-18):** the review client hardcodes
   defer:true for every pipeline run, so Accept on a manual
   standardize-run for an already-ACTIVE pipeline marked the run 'approved',
   exported nothing, and dumped the reviewer into the initial-setup
   activation card. The export route now ignores `defer` when the run's
   pipeline is not pending_baseline — the reviewer's decisions export
   immediately (write + dequeue + rebuild) and the client returns straight
   to the pipelines tab (`pipeline_active: true` in the response drives the
   redirect; no activation card).

17. **"Export unstandardized values" didn't show detected values until the
   tick (live, owner report; FIXED 2026-08-18):** the consistent-snapshot
   rule ("new values never cause a rebuild") applied even with the raw-
   passthrough toggle ON, so a value the poller detected sat invisible for
   up to 10 minutes — exactly the wait the toggle exists to avoid. All four
   pollers now flag an export rebuild when a poll queues new values on a
   table-kind export with `export_unmapped_rows` on (mssql CT branch fires
   on any reported change, since a new row of an already-known value queues
   nothing but still must appear). Default (toggle off) behaviour unchanged;
   idle cycles still rebuild nothing. Cost note in CLAUDE.md: on Snowflake
   an opted-in busy pipeline now pays a rebuild per change-bearing cycle.

18. **One-time source tabs (owner decision 2026-08-18):** now
   `<warehouse> | CSV | Excel | Google Sheet`; the paste tab and all its
   machinery deleted (not hidden).
19. **Change Tracking re-baseline swallowed rows (live; FIXED):** PATCH
   status='active' clears detection state on EVERY activation, so the next
   poll re-baselined CT at the current version and lost everything written
   between the initial scan and that poll (proof: source 12 / export 11,
   stored version == current). Detection (re-)init now reconciles from the
   source — the mssql analog of `recoverAfterStreamReset`.
20. **One-time export defaulted into a schema Prism can't write (FIXED):**
   suggested `<source>_STANDARDIZED` (i.e. dbo). Now PRISM_OUT on the
   service path — see #28 for the personal-credentials correction.
21. **Export-destination collisions were silent (live E4; FIXED):** a
   one-time export's table, then two pipelines, all accepted the same
   destination; each rebuild fully replaces it, so they overwrite each other
   forever while every card reads healthy. New `_lib/export-claims.ts` guard
   on create (409, before any row is written) and on retarget. Sibling
   columns of the SAME source still share one export table by design.
22. **Lookup export target was grey placeholder text (FIXED):** prefilled
   and editable now; "Leave blank to use default" removed.
23. **SMTP failure failed the whole invitation (live; FIXED):** the invite
   row was already committed and only the email threw, but the 500 hid the
   copy-the-link fallback. Sending now degrades like "not configured".
   **23b:** DigitalOcean blocks outbound SMTP (25/465/587 all time out), so
   invitations now send over Resend's HTTPS API (`RESEND_API_KEY`,
   `EMAIL_FROM`); SMTP still works where it's allowed. Live-verified
   delivered.
24. **Invite success now warns about spam** and shows the link on success,
   not just on failure.
25. **British spellings in customer-facing copy (FIXED):** 14 instances of
   standardise/standardisation/organisational across the invitation email,
   invite form, accept-invite page and role badge.
26. **Personal credentials prefilled a database they can't open (live;
   FIXED):** the form inherited the workspace's PRISM_DB — Prism's internal
   database, which a least-privilege login is never granted — and SQL
   Server's 4060 text contains "login failed", so it was reported as bad
   credentials. Database is optional now (blank = the login's own default)
   and 4060 gets its own message.
27. **Personal server/port are read-only** where the workspace supplies
   them: one server per installation, and an editable field let any member
   make the Prism host dial arbitrary addresses.
28. **One-time destination must follow the session's connection (FIXED):**
   PRISM_OUT is right for the SERVICE login only; a personal-credentials
   session writes with the user's own rights, and PRISM_OUT may not exist in
   that database at all. The advice text splits the same way.
29. **Source-values preview lacked the personal-credentials fallback (live
   F5; FIXED):** columns loaded, values failed with 916. Same ladder as
   /api/columns now. ⚠️ The fallback is per-route — audit the remaining
   source-touching routes.
30. **Known values never reached the mssql export promptly (live, volume
   test; FIXED):** CT-reported values that were already mapped got filtered
   out, so nothing queued, nothing rebuilt — and `fully_synced_at` advanced
   anyway (its guard is just "queue empty"), leaving the card claiming
   freshness over an export 500k rows short. CT-reported values now queue
   even when mapped (Snowflake's consistent-snapshot semantics); the tick
   republishes them with zero LLM cost. Diff mode deliberately unchanged.

31. **Column-mode consent promised access Prism couldn't grant (live; FIXED):**
   the checkbox said ticking it grants Prism update access, but Prism can only
   do that with a privileged identity — SQL Server refuses a login granting
   permissions to *itself* (verified: "Cannot grant, deny, or revoke
   permissions to … yourself"). With no saved personal credentials, creation
   succeeded and the pipeline immediately paused asking for SQL. Now: creation
   is gated up front (400, no pipeline created), the consent copy states what
   actually happens, and the pre-create approval popup **collects credentials
   inline** so the user never leaves the half-filled form.
32. **Per-table write access outlived the pipeline (live; FIXED):** deleting a
   column-mode pipeline left Prism holding UPDATE on the customer's table
   forever — found by auditing grants after the column-mode test, where
   `REGIONS` still carried a grant from a deleted pipeline. Deletion now
   revokes it (best-effort, never blocks deletion, returns the SQL when Prism
   can't), skipping the revoke when another column pipeline still claims the
   table. The companion COLUMN is deliberately left behind — Prism never drops
   a column — and the response says so.

## Column output mode — verified live 2026-08-23 (closes PRELAUNCH §1 for mssql)

Against `CLIENT_DB.dbo.CUSTOMER_ORDERS` (25 rows), snapshotted to
`CUSTOMER_ORDERS_BACKUP` first:

| Check | Result |
|---|---|
| Original columns unchanged (EXCEPT, both directions) | **0 rows drift** |
| Row count | 25 / 25 |
| Companion column filled | 25 / 25, correct canonicals (att, AT&T Wireless, a t and t → AT&T) |
| Grant scope | UPDATE on `CUSTOMER_ORDERS` only |
| Automatic provisioning via the creator's credentials | worked (added column + granted itself, one table) |

⚠️ Still unverified for column mode: the privilege-revoked-mid-flight path
(§1.4) and the pre-existing-companion-column refusal (§1.3) on a live table.

## Volume tests (2026-08-21, droplet — 4 GB box also hosting SQL Server, so
these are pessimistic floors)

| Operation | Scale | Time |
|---|---|---|
| Distinct scan (reconcile) | 2,000,000 rows | ~1 s |
| Full export rebuild | 2,000,000 rows | 48 s |
| Change Tracking consume | 500,000 inserts | 11 s |
| Delete-triggered rebuild | 300,000 deletes → 2.2M rows | ~53 s |

24 messy spellings collapsed to 7 canonical names; source and export matched
exactly after every phase. Peak memory ~1.6 GB of 3.9 GB *including* SQL
Server. AI cost for the entire exercise: zero (the values were already in the
lookup, so every pass was a hash-lookup).

## Phase 9 — Teardown ⚠️ REQUIRED — billing does not stop by itself

1. **Destroy the test droplet**: DigitalOcean panel → `prism-clienttest` →
   **Destroy** (left menu) → type `prism-clienttest` to confirm. This is the
   step that stops the hourly charges. Powering off is NOT enough. Double-check
   the name — never type the prod droplet's name here.
2. Cloudflare: delete the `clienttest` A record.
3. Google console: remove the two `clienttest` URIs (optional).
4. Laptop 1 cleanup (from the earlier local-plan prep, now unneeded):
   - `cp stand-ui/.env.local.pre-client-sim.bak stand-ui/.env.local` and
     restart the dev server.
   - `docker rm -f prism-client-mssql` (the local SQL Server container).
5. Keep: the password-manager entry (template for real clients) and the test
   findings (update `docs/WAREHOUSES.md` / memory notes with results).
