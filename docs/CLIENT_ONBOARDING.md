# Prism — Client Onboarding Guide

This is the operator's playbook for bringing a new client company onto Prism:
every step in order, who performs it (you vs. the client), and the rules that
govern access, data residency, and cost. Written for the current deployment
model: **Prism-hosted, one dedicated instance per client** (a single long-lived
Node process per installation — required by the in-process poller and SSE
broadcaster).

---

## 1. The big picture

Prism straddles two environments:

| Where | What lives there | Who controls it |
|---|---|---|
| **Client's Snowflake account** | The data plane: confirmed mappings (`LITERAL_ALIAS_MATCHES`, `APPROVED_ALIAS_NAMES`), the work queue, file-row snapshots, streams on their source tables, export tables, the `PRISM_NORMALIZE` UDF, and the dedicated `PRISM_WH` warehouse | The client — they can revoke Prism's access unilaterally at any time |
| **Prism instance (your VM)** | The app + local SQLite database (`data/prism.db`): user accounts, invitations, column specs, pipeline configs, run/pipeline metadata (run review state, the validation audit log, and one-time mappings live in the CLIENT's warehouse — data residency) | You |
| **Anthropic API** | Sees distinct text values in grouping/validation prompts, transiently. Not stored by Prism outside the run state | Your API key (their key / Cortex are future options) |

**The one-sentence trust story for the client:** *your accumulated mappings and
export tables never leave your Snowflake account; Prism connects with a service
user you create and can disable at any time; the app's own bookkeeping lives on
Prism's instance; distinct values are sent to Anthropic for grouping.*

---

## 2. Prerequisites

**From the client (collect before onboarding day):**
- A contact with **ACCOUNTADMIN** (or equivalent) access to their Snowflake account — needed once, at install.
- The **account identifier** (e.g. `xy12345.us-east-1`).
- The list of **source schemas** containing tables to standardize, and the **schema where export tables should land**.
- The **email address** of their workspace admin (the person who will run Prism day-to-day) — must be a Google-sign-in-capable address.

**From you (per instance):**
- A VM/container for the instance (one per client), with **persistent disk** for the SQLite file.
- `ANTHROPIC_API_KEY`.
- Google OAuth client (see §6 — verification status matters).
- SMTP credentials for invitation emails (optional; invite links can be copied manually).
- Generated secrets: `SESSION_SECRET` and `PRISM_ENCRYPTION_KEY` (see §4).

---

## 3. Snowflake setup (client's ACCOUNTADMIN — ~15 minutes)

Run on a screen-share or send as a runbook. All statements are in the repo's
SQL files; the client admin runs them **as ACCOUNTADMIN**.

### 3.1 Create the database, tables, roles, and warehouse

```
snowsql -f 00_bootstrap.sql        -- creates PRISM_DB + INTERNAL schema
snowsql -f 01_internal_tables.sql  -- tables, UDF, roles, grants, PRISM_WH warehouse
```

This creates:
- `PRISM_DB.INTERNAL` with the four data-plane tables.
- The **`PRISM_WH` warehouse** — XSMALL, 60-second auto-suspend, initially
  suspended, 600 s statement timeout. Prism runs exclusively on this warehouse
  so its compute cost is isolated and visible on the client's bill, and its
  suspend tuning never touches their other workloads.
- The four Snowflake roles (see §5).

> **Edit before running:** `01_internal_tables.sql` ends with a
> `GRANT ROLE ... TO USER <name>` — replace the dev username with the client's
> service user (created next), and remove/adjust the dev `TEST_DB` grants.

### 3.2 Create the service user

Prism connects as a **machine identity** — never as a person. Key-pair auth is
strongly preferred over password (no MFA interference, rotatable):

```sql
CREATE USER PRISM_SVC
  RSA_PUBLIC_KEY = '<public key>'      -- client generates the key pair and keeps the private key to hand to you
  DEFAULT_ROLE   = PRISM_SERVICE
  DEFAULT_WAREHOUSE = PRISM_WH
  COMMENT = 'Service user for the Prism standardization platform';

GRANT ROLE PRISM_SERVICE TO USER PRISM_SVC;
```

Key generation (client side): `openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt`
then `openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub`.

### 3.3 Grant access to source and export schemas — **the key governance decision**

Prism can only ever reach what `PRISM_SERVICE` is granted. This is the client
admin's control surface: sensitive schemas simply never get granted, and no
Prism user — regardless of their in-app role — can reach past these grants.

The setup wizard's step 2 **Part D** generates these blocks for the admin from
the schema names they type in — this section is the reference for doing it by
hand. One block per source database/schema:

```sql
GRANT USAGE  ON DATABASE <source_db>                          TO ROLE PRISM_SERVICE;
GRANT USAGE  ON SCHEMA   <source_db>.<schema>                 TO ROLE PRISM_SERVICE;
GRANT SELECT ON ALL TABLES IN SCHEMA <source_db>.<schema>     TO ROLE PRISM_SERVICE;
GRANT SELECT ON FUTURE TABLES IN SCHEMA <source_db>.<schema>  TO ROLE PRISM_SERVICE;
```

**These grants give Prism no write access to existing tables — deliberately.**
The one feature that writes to a source table (the "Column" output mode, which
adds and fills `<col>_STANDARDIZED` companion columns) is consent-gated in the
product and granted per table at setup time, either automatically via the
pipeline creator's personal credentials or by the admin running the flagged
single-table `ALTER + GRANT UPDATE`. Never pre-grant schema-wide UPDATE. (See
SECURITY_AND_DISCLOSURES §1 and PRELAUNCH_CHECKLIST §1.)

For the export destination schema:

```sql
GRANT USAGE        ON SCHEMA <export_db>.<schema>          TO ROLE PRISM_SERVICE;
GRANT CREATE TABLE ON SCHEMA <export_db>.<schema>          TO ROLE PRISM_SERVICE;
GRANT CREATE VIEW  ON SCHEMA <export_db>.<schema>          TO ROLE PRISM_SERVICE;  -- "view" export mode

-- Let the client's consuming roles (BI, analysts) automatically read every
-- export table Prism creates here. Prism rebuilds exports with COPY GRANTS,
-- so this one-time grant survives every rebuild:
GRANT SELECT ON FUTURE TABLES IN SCHEMA <export_db>.<schema> TO ROLE <their_consumer_role>;
```

**Advise granting narrowly.** The workspace access model (see §5) means every
invited Prism user can standardize any granted table — "grant only the schemas
the team should standardize; invite only the people who should see them."

---

## 4. Instance provisioning (you — ~30 minutes)

Per-client instance checklist:

1. **VM with persistent disk.** The SQLite file (`PRISM_SQLITE_PATH`, default
   `stand-ui/data/prism.db`) holds accounts, column specs, and run/pipeline metadata — never customer values — and pipeline
   configs — losing it loses those (never confirmed mappings; those are in the
   client's Snowflake). Disk encryption on.
2. **`.env.local`** from `.env.local.example`:
   - `SNOWFLAKE_ACCOUNT` / `SNOWFLAKE_USER=PRISM_SVC` / `SNOWFLAKE_WAREHOUSE=PRISM_WH` / `SNOWFLAKE_ROLE=PRISM_SERVICE`
   - `SNOWFLAKE_PRIVATE_KEY_PATH` → the service user's private key file
   - `ANTHROPIC_API_KEY`
   - `SESSION_SECRET` → `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `PRISM_ENCRYPTION_KEY` → `openssl rand -hex 32` — **exactly 64 hex chars, no quotes/brackets.**
     Store it in your password manager per installation: it encrypts saved
     Snowflake credentials and Google refresh tokens at rest; losing it means
     those must be re-entered.
   - `ADMIN_EMAIL` → the client workspace admin's email (bootstraps their admin account)
   - `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` (redirect URI = this instance's domain + `/api/auth/google/callback`)
   - `APP_URL` + `SMTP_*` for invitation emails
   - Leave `PRISM_DEBUG_TOOLS` / `PRISM_DEBUG_ARTIFACTS` / **`PRISM_FRESH_SETUP`** **unset** — operator-only,
     never in client installs. `PRISM_FRESH_SETUP` was missing from this list and is the easiest to miss:
     it makes `/setup`, the `/home` gate and `verify-install` falsely report that no credentials exist, so
     a correctly-configured install looks broken to the customer. Verify with:
     `grep -nE '^(PRISM_DEBUG_TOOLS|PRISM_FRESH_SETUP|PRISM_DEBUG_ARTIFACTS)=true' stand-ui/.env.local`
     (expect no output). The server also warns loudly at boot if any is set — see PRELAUNCH_CHECKLIST §1b.
3. **Google OAuth audience** (§6): add the client admin's email as a test user
   if the OAuth app is still unverified.
4. Build and start (`npm run build && npm start`), behind TLS.
5. The SQLite database creates itself on first boot — no migration step.

---

## 5. The roles model — rules of the road

Two **separate** permission systems that never automatically interact:

### 5.1 Snowflake roles (in the client's account; govern warehouse access)

| Role | Held by | Powers | When granted |
|---|---|---|---|
| `PRISM_SERVICE` | The `PRISM_SVC` service user **only** — never a human | Everything the app needs: write on `PRISM_DB.INTERNAL`, read on granted source schemas, create tables in the export schema, use `PRISM_WH` | Install time |
| `PRISM_DATA_ADMIN` | A human data engineer at the client — never the service user | Direct SQL write on the mapping/config tables only (manual surgery: fix a bad mapping, bulk-seed, PII purge). No source reads, no streams | **Break-glass only.** Default: nobody. Grant when a concrete need appears; revoke after |
| `PRISM_USER` / `PRISM_READONLY` | Nobody yet | Reserved (DB visibility only). `PRISM_READONLY` is the future read-only/audit tier | Not granted |
| `ACCOUNTADMIN` | The client's own Snowflake admin | Runs the install script once; creates/disables the service user | Pre-existing |

Rules:
- **Never** grant `PRISM_DATA_ADMIN` to the service user, or `PRISM_SERVICE` to a human.
- Anyone writing to `LITERAL_ALIAS_MATCHES` manually **must** set
  `normalized_value = PRISM_NORMALIZE(literal_value)` — every code path does;
  hand edits must too.
- The client's **kill switch**: `ALTER USER PRISM_SVC SET DISABLED = TRUE`
  cuts Prism off instantly, no cooperation needed. Every query Prism runs is in
  their query history under `PRISM_SVC` — a complete audit trail.

### 5.2 Prism app roles (in the app; govern who can use it)

| Role | How obtained | Powers |
|---|---|---|
| `admin` | First sign-in by the `ADMIN_EMAIL` address; or promotion by an admin | Everything a user can do, **plus** Settings (workspace Snowflake credentials + grants), team management (invite/promote/remove), pipeline-health rollup |
| `user` | Accepting an invitation | The full product: create/review/export runs, create/edit/pause/**delete any pipeline**, column specs, one-time standardizations |

Any member may additionally save **personal Snowflake credentials** (via
`/setup`; stored encrypted on their own account row). These are used ONLY for
one-time standardizations of tables the service role can't see — the read and
the output write run under the member's own Snowflake entitlements (an
`overwrite` export requires their own write access to the target). Pipelines
and the shared lookup always use the service connection.

Rules the client admin must understand:
- **Workspace-level access:** every invited user has equal access inside the
  app — there is no per-user data scoping. Any user can reach any table that
  `PRISM_SERVICE` was granted (via the connect form) and can modify any
  pipeline. The two access dials are: *which schemas the Snowflake admin
  grants* and *who the Prism admin invites.*
- **Invitations are email-bound:** the invite link only works for the invited
  address (verified via Google sign-in — a different account gets rejected).
  Invites expire after **7 days**; statuses are pending/accepted/revoked.
  Inviting an address that already has an account is rejected.
- **Revocation is instant:** removing a member (or changing their role) bumps
  their session version — their very next request is rejected, and the UI
  ejects them to the login page with the cookie cleared.
- **Last-admin guard:** the workspace must always keep one admin; self-deletion
  is blocked.
- Prism users do **not** get Snowflake roles, and inviting someone never grants
  warehouse access. Direct-SQL access (`PRISM_DATA_ADMIN`) is a separate,
  deliberate act by the client's Snowflake admin.

---

## 6. Google sign-in (auth for humans)

- All Prism login is Google OAuth — no passwords.
- **While the OAuth app is unverified/in Testing mode**, every sign-in address
  must be listed as a test user: Google Cloud Console → APIs & Services →
  OAuth consent screen → Audience → Test users. Otherwise users hit
  *"Access blocked: Prism has not completed the Google verification process."*
- **Before general availability:** publish the OAuth app and pass Google's
  verification review (required because Prism requests the sensitive
  `spreadsheets` scope for Sheets pipelines). Needs a privacy-policy URL,
  domain verification, and scope justification; allow days-to-weeks.
  Until then, budget one test-user entry per client user (100 max).

---

## 7. First login and the setup card

1. The client admin signs in with Google at the instance URL. Because their
   email matches `ADMIN_EMAIL`, their account is created as `admin`.
2. They land on the **setup card**. Since you pre-configured the env
   connection, it shows *"✓ This workspace already has a working Snowflake
   connection (warehouse PRISM_WH)"* — they click **Continue with existing
   connection** and they're in. Nothing to type.
3. (Alternative flow — credentials via the app instead of env: fill the form
   with the service user + `PRISM_SERVICE` role and "Save and apply grants."
   Credentials are stored AES-256-GCM-encrypted. The grants report shows
   account-level items as *"already in place from install"* — green, expected.
   Red items appear only if the install script was never run.)
4. Invited members **never see the setup card** — they go straight to the app.

Onboarding walkthrough to do with the admin (15 minutes):
- Connect a source column and fill in its **column spec** (description, rules, optional naming convention) inline in the connect form.
- **Connect a source table** → create initial standardizations → review the
  proposed groups → Accept → **Begin Pipeline Standardization**.
- Show the pipeline card: the 30-second polling ring, metrics, pause button,
  lookup-table export.
- Insert a test row in the source table and watch it get detected and
  standardized within a cycle; show the row appearing in the export table.
- **Invite** one teammate to demonstrate the flow.

---

## 8. Data residency — what to tell their security team

- **Stays in their Snowflake, always:** confirmed mappings, approved canonical
  names, the work queue, file-row snapshots (full contents of uploaded
  files/Sheets — deliberately kept in their account), streams, export tables.
- **On the Prism instance (SQLite):** accounts (Google identity, role),
  invitations, column-spec definitions (descriptions/rules — config, not values). NO LONGER on the instance since the 2026-07-28 data-residency change: run review state, the validation log, and one-time mappings all live in the client's warehouse. (Historical wording: run review state (contains the distinct
  values under review), pipeline configuration, validation audit log, one-time
  archives. Encrypted fields: saved Snowflake credentials, Google refresh
  tokens.
- **Transits Anthropic:** the distinct values of columns being standardized,
  inside grouping/validation prompts, under Prism's API key (API data is not
  used for training per Anthropic's API terms). List Anthropic and Google
  (Sheets) as subprocessors.
- **Never leaves their warehouse:** full source tables. Export tables are built
  by `CREATE TABLE … AS SELECT` running entirely inside their account.
- Prism (the company) has **no Snowflake user** in the client's account — all
  access is through the service user they created and can disable.

---

## 9. The cost model (what they'll see on their Snowflake bill)

- All Prism compute runs on **`PRISM_WH`** (XSMALL) — one clean line item.
- **Idle costs ~nothing.** An idle poll cycle uses only metadata-layer
  operations (`SYSTEM$STREAM_HAS_DATA`, stream DDL checks) that don't wake the
  warehouse; the app's own bookkeeping is local. The warehouse suspends after
  60 s of quiet.
- The warehouse wakes for: new source values (classify → queue → export
  rebuild), standardization exports, the hourly reconciliation sweep (~24
  brief wakes/day), on-demand exports, and source-health checks on data-bearing
  cycles.
- Expected steady-state for a typical client: **minutes of XSMALL compute per
  day**, dominated by how often their source data actually changes.
- Consumers should read export tables on **their own** warehouses.

---

## 10. Ongoing operations

| Task | Cadence | Who |
|---|---|---|
| Back up the SQLite file (`sqlite3 data/prism.db ".backup ..."` or file copy) | Daily, automated | You |
| Rotate the service user's key (`ALTER USER PRISM_SVC SET RSA_PUBLIC_KEY=...`, update instance) | Per client policy (e.g. yearly) | Client admin + you |
| Review Settings → Pipeline health (paused pipelines carry a `status_message` explaining why) | As needed — pipelines self-pause after 5 consecutive standardization failures with the reason shown | Client admin |
| Monitor errors (Sentry, env-gated by `SENTRY_DSN`) | Continuous | You |
| Add/remove team members | As needed (Settings → Team) | Client admin |
| Grant additional source schemas as new use-cases appear (§3.3 block) | As needed | Client's Snowflake admin |

**Common gotchas:**
- *Pipeline paused with "source table dropped/renamed…"* — the health guard
  fired. Fix the table/grants, then Resume; the reconcile sweep recovers
  anything missed.
- *Masking/row-access policy detected* — Prism skips standardizing that column
  (auto-recovers when the policy is removed). Prism detects policies only to
  stay safe; it does not manage them.
- *Sheets pipeline stopped refreshing* — the stored Google refresh token
  expired/was revoked; re-authenticate from the pipeline card.
- *Invite link "invalid or already used"* — expired (7 days) or revoked; send a
  new one.
- ⚠️ *A role you never granted anything to can still read a table* — before
  assuming this is a Prism bug, see **`PRODUCT_DECISIONS.md` → "Known Issues
  & Findings Requiring Future Verification"** for the full investigation.
  Short version: a dev Snowflake account was once found to not enforce
  default-deny RBAC at all (a role with literally zero grants could read
  arbitrary data) — completely unrelated to Prism's code or grants. **This
  has NOT been re-tested against a real client account.** Run the
  zero-grants-role check (Appendix A, below) before trusting the grants model
  for a new client; if it fails the same way there, stop and treat it as a
  serious finding, not a known quirk.

---

## 11. Operator credential hygiene (you)

Rules for handling credentials on YOUR side — a leak on the operator laptop is
a breach of every client at once:

- **Never type a password inline in a shell command** (`SNOWSQL_PWD='…' snowsql`,
  `-P password`). It lands in shell history, process listings, and any tooling
  that records commands. Use key files, env files, or the tool's prompt.
- **Key-pair auth over passwords everywhere a machine identity connects.**
  Passwords are for humans; service users get rotatable keys.
- **One credential set per client, stored in a password manager** — service-user
  private key, `PRISM_ENCRYPTION_KEY`, `SESSION_SECRET`, and (if used) the
  vendor Anthropic key are all per-installation. Never reuse across clients;
  churn = revoke one client's set, nothing else.
- **Dev credentials never touch client systems.** Anything used during
  development (dev Snowflake logins, the local SQL Server container's SA
  password) is presumed compromised — it appears in logs, transcripts, and
  config files. Rotate any credential that has ever landed in one of those
  before it guards anything real.
- **Client secrets only ever land in that client's instance** (`.env.local` on
  their VM / the encrypted SQLite rows) — never on the operator laptop beyond
  the password manager.

## 12. Offboarding a client

1. You: stop the instance; securely delete the VM/disk (SQLite file included).
2. Client: `DROP USER PRISM_SVC;` `DROP WAREHOUSE PRISM_WH;`
   `DROP DATABASE PRISM_DB;` and `DROP ROLE` for the four Prism roles.
3. **Their asset survives — with ONE exception you must check first.**
   Export **tables** and standardized **columns** live in the client's own
   schemas and hold real materialized data, so they are unaffected by the drop.

   ⚠️ **View-kind exports do NOT survive.** A `export_kind='view'` pipeline
   creates a live, non-materialized view whose defining SQL hard-references
   `PRISM_DB.INTERNAL.LITERAL_ALIAS_MATCHES`, `APPROVED_ALIAS_NAMES` and
   `PRISM_DB.INTERNAL.PRISM_NORMALIZE` by fully qualified name. Dropping
   `PRISM_DB` leaves the view object in place but **every query against it
   fails** — the client is left with something that looks like their data and
   returns an error (OPS-05).

   **Before step 2, run this and resolve anything it returns:**

   ```sql
   -- Any pipeline whose output is a view? (run against the Prism SQLite, or ask the operator)
   --   SELECT pipeline_id, table_fqn, export_table_fqn FROM pipelines WHERE export_kind = 'view';
   -- Then, in Snowflake, materialize each one so it survives:
   CREATE OR REPLACE TABLE <export_fqn>_FINAL AS SELECT * FROM <export_fqn>;
   DROP VIEW <export_fqn>;
   ALTER TABLE <export_fqn>_FINAL RENAME TO <export_fqn>;
   ```

   Do this **while `PRISM_DB` still exists** — the `SELECT *` is what copies the
   standardized values out, and it cannot work afterwards.

4. If they want the raw lookup, export it (CSV / warehouse table) before
   dropping `PRISM_DB`.

---

## Appendix A — Onboarding checklist (print-friendly)

**Before the call**
- [ ] Collected: account identifier, source/export schemas, admin email
- [ ] Instance provisioned; secrets generated; `ADMIN_EMAIL` set
- [ ] Google OAuth: client admin added as test user (if unverified)

**With the client's Snowflake admin**
- [ ] `00_bootstrap.sql` + `01_internal_tables.sql` run as ACCOUNTADMIN
- [ ] `PRISM_SVC` created (key-pair, `DEFAULT_ROLE = PRISM_SERVICE`); private key handed over securely
- [ ] Source schema grants applied; export schema grants + FUTURE TABLES consumer grant applied
- [ ] Confirmed: `PRISM_DATA_ADMIN` granted to nobody (break-glass)
- [ ] **Verified the account actually enforces default-deny RBAC.** Prism's entire access model assumes a role with no grants sees nothing. Run this **exactly as written** — the `USE SECONDARY ROLES NONE` line is load-bearing:

      ```sql
      CREATE ROLE ZG_TEST;
      GRANT USAGE ON WAREHOUSE <wh> TO ROLE ZG_TEST;
      GRANT ROLE ZG_TEST TO USER <you>;
      USE ROLE ZG_TEST;
      USE SECONDARY ROLES NONE;   -- REQUIRED: without this the test silently passes
      SELECT * FROM <some_ungranted_table> LIMIT 1;   -- MUST fail with an access error
      -- cleanup
      USE ROLE ACCOUNTADMIN; DROP ROLE ZG_TEST;
      ```

      ⚠️ **Why `USE SECONDARY ROLES NONE` matters (2026-08-03):** Snowflake defaults users to
      `DEFAULT_SECONDARY_ROLES = ('ALL')`, so `USE ROLE ZG_TEST` does **not** drop the other roles
      you hold — your session keeps ACCOUNTADMIN active in the background and the `SELECT`
      succeeds no matter what. The earlier version of this checklist omitted that line, which is
      why a dev account was previously recorded as "not enforcing default-deny". That conclusion
      was wrong: the **test** was invalid, not the account. Verify with
      `SELECT CURRENT_SECONDARY_ROLES();` — it must report an empty role list before you trust the result.

      ⚠️ **Also check for blanket PUBLIC grants**, which are a real and separate way to defeat
      default-deny (every role inherits PUBLIC):

      ```sql
      SHOW GRANTS TO ROLE PUBLIC;                       -- look for anything on YOUR databases
      SHOW FUTURE GRANTS IN SCHEMA <db>.<schema>;       -- look for grantee PUBLIC
      ```

      On the Prism dev account this found PUBLIC holding SELECT/INSERT/UPDATE/DELETE on both
      existing and future tables in `TEST_DB.PUBLIC`; it was revoked 2026-08-03.

**Verify**
- [ ] Instance restart with final env; admin signs in, sees green "existing connection" card
- [ ] Settings → Test connection: green, no auto-suspend warning
- [ ] First pipeline end-to-end (connect → review → accept → activate → detect a new row → export table updates)
- [ ] Invite flow tested with one teammate
- [ ] Next morning: `PRISM_WH` shows near-zero overnight credits

**Handoffs**
- [ ] Admin knows: invite rules, revocation, pause reasons, lookup export
- [ ] Snowflake admin knows: kill switch, schema-grant recipe, `PRISM_DATA_ADMIN` policy
- [ ] You: SQLite backup scheduled; `PRISM_ENCRYPTION_KEY` + session secret in password manager

---

## Appendix B — SQL Server installs (differences from the Snowflake playbook)

Prism supports Microsoft SQL Server as the warehouse (chosen in the setup
wizard's first step). The playbook above applies with these substitutions:

**§3 Snowflake setup → SQL Server setup (client DBA, ~15 min):**
- Run `01_internal_tables.mssql.sql` as a sysadmin (SSMS / Azure Data Studio /
  sqlcmd). Creates `PRISM_DB` with `INTERNAL` + `EXPORTS` schemas, the four
  data-plane tables, and the PRISM_* database roles. No warehouse, no UDF —
  normalization runs app-side on SQL Server.
- Service identity: `CREATE LOGIN prism_svc WITH PASSWORD = '<generated>'`,
  `CREATE USER … FOR LOGIN …`, `ALTER ROLE PRISM_SERVICE ADD MEMBER prism_svc`.
  For each source database: `CREATE USER prism_svc FOR LOGIN prism_svc;
  GRANT SELECT ON SCHEMA::<schema> TO prism_svc;`
- **Change Tracking (recommended, optional):** `ALTER DATABASE <db> SET
  CHANGE_TRACKING = ON (CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON)` + per
  table `ENABLE CHANGE_TRACKING` + `GRANT VIEW CHANGE TRACKING`. Gives ~1-min
  detection; requires a primary key per table. Without it Prism automatically
  uses scheduled scans (tier shown on the pipeline card). Optional heartbeat
  optimization: `GRANT VIEW SERVER STATE TO prism_svc` (Azure SQL DB:
  `GRANT VIEW DATABASE STATE`). It reads the table's last-write time from
  server bookkeeping, so an idle table is skipped without being read at all —
  worth asking for when Change Tracking isn't on. Declining it costs ~5 minutes
  of extra detection latency on scanned tables (Prism floors the scan cadence
  at 5 minutes rather than reading the column every minute), and occasionally
  one extra 10-minute standardization cycle before a new value reaches the
  output — so up to ~10 min end-to-end in the worst case, not ~5. Nothing
  breaks.
- **Kill switch:** `ALTER LOGIN prism_svc DISABLE;` — instant, no cooperation
  needed. Their audit surface is SQL Server auditing / Query Store rather than
  Snowflake query history.

**§9 Cost model:** SQL Server bills provisioned capacity, not activity — no
warehouse line item. Prism's load: a per-minute metadata heartbeat
(negligible), change-proportional Change Tracking reads, and size-tiered
distinct scans. Change Tracking itself adds small DML overhead + ~2 days of
change-table storage on tracked tables. ⚠️ **Azure SQL serverless tier**: it
auto-pauses like a Snowflake warehouse; Prism detects the tier and stretches
its polling ×10, but a serverless database watched by any always-on tool will
pause less — recommend a provisioned tier for watched databases.

**Version floor:** SQL Server 2019+ (Azure SQL Database and Managed Instance
supported; CLR is never required). Known limitation: `export_kind = 'view'`
is not available on SQL Server (table exports only).

**Pre-onboarding check (analog of the Appendix A RBAC test):** create a
throwaway login with no grants, confirm it CANNOT read a source table, drop
it. SQL Server is default-deny by design, but verify on their instance.

