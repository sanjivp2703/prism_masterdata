# Security, Access & Disclosures Review

Full evaluation of roles, data access paths, and security risks, with the map of
user-facing disclosures at each consent point. Reviewed 2026-07-13. Update this
document when an access path or disclosure changes.

---

## 1. Roles and what they can do

### Snowflake roles (created by `01_internal_tables.sql` / `grants.ts`)

| Role | Held by | Access |
|---|---|---|
| `PRISM_SERVICE` | The app's service user (`PRISM_SVC`) | Full read/write on `PRISM_DB.INTERNAL` (lookup, queue, file rows, streams, UDF); `CREATE TABLE`/`CREATE VIEW` on `PRISM_DB.PUBLIC` (lookup exports); per-customer grants: `SELECT` on source schemas, `CREATE TABLE`/`CREATE VIEW` on export schemas; `USAGE, OPERATE` on `PRISM_WH`. Deliberately NOT granted `MODIFY` on source tables — enabling change tracking needs the table owner (see §3). **Exception (2026-07-22, "Column" output mode — per-table, consent-gated):** a pipeline whose output is a standardized companion column requires `UPDATE` on that source table (every sync) plus a one-time owner-run `ALTER TABLE ADD COLUMN`. **Onboarding grants no write access on existing tables** — Part D's generated SQL states this policy explicitly. Instead, `UPDATE` is granted case-by-case: the connect form requires a consent checkbox on the Column option's warning panel (the API refuses `export_kind='column'` without `column_write_consent: true`), and on creation Prism provisions access via the pipeline creator's personal credentials (`provisionColumnModeAccess` — same pattern as the change-tracking auto-fix): companion `ADD COLUMN IF NOT EXISTS` plus `GRANT UPDATE ON TABLE <that one table>`; when that isn't possible the pipeline is flagged with the exact single-table SQL for an admin to run (`columnModeSetupSql`). Prism only ever writes the `<col>_STANDARDIZED` companion columns it creates — never the customer's own columns. Enforced by code guardrails (`assertCompanionColumnSafe` — every write target must be a watched column's companion, checked before any SQL runs; `assertCompanionColumnAvailable` — creation refused when the companion name already exists on the table) and required to be live-tested before any deployment (docs/PRELAUNCH_CHECKLIST.md §1). Disclosed via an unmissable warning panel on the Column option in the connect form (how the table is edited, the never-touch-existing-columns intent, a no-liability statement for the unlikely error case, and a recommendation against using it on highly important or unrecoverable data) + the activation card's "Snowflake changes" disclosure. |
| `PRISM_DATA_ADMIN` | Human operators only | Read/write on the lookup tables + `PIPELINE_FILE_ROWS` for manual SQL maintenance. Never held by the service user. |
| `PRISM_USER` / `PRISM_READONLY` | Reserved | DB `USAGE` visibility only; no writes on `INTERNAL`. |

Snowflake doesn't enforce CHECK/PK/FK/UNIQUE, so **grants are the guardrail**
for the lookup tables. ⚠️ Open item (memory: snowflake-rbac-verification-needed):
a dev account once appeared not to enforce default-deny — re-verify RBAC on a
clean account before onboarding real clients.

### App roles (SQLite `accounts.role`)

| Capability | Admin | Member |
|---|---|---|
| View all pipelines, column specs, mappings, queues, run history, standardized values | ✔ | ✔ (single-tenant by design — no per-user data isolation) |
| Create/modify/delete pipelines, create column specs, trigger standardization, export lookup tables (CSV/Excel/Sheets/Snowflake) | ✔ | ✔ |
| One-time standardizations (incl. personal-credential fallback) | ✔ | ✔ |
| Save their own personal Snowflake credentials | ✔ | ✔ |
| Edit column specs | ✔ | ✔ (`/api/column-specs` is member-accessible; the old admin-only `/api/domains` was removed with domains, 2026-07-15) |
| Workspace Snowflake credentials, AI provider config, install verification | ✔ | ✘ |
| Invite / remove members, change roles | ✔ | ✘ (last-admin + self-delete guards; removal bumps `session_version` → instant logout) |
| `/settings`, `/invite` pages | ✔ | ✘ |

Notable: **members can delete any pipeline and export the full lookup table** —
acceptable single-tenant defaults, but worth knowing when inviting.

---

## 2. Credential & secret inventory

| Secret | Where stored | Protection | Used for |
|---|---|---|---|
| Workspace Snowflake service creds | SQLite `workspace_config` | AES-256-GCM (`PRISM_ENCRYPTION_KEY`), `enc:v1:` | All pipelines, poller, lookup — everything background |
| Personal Snowflake creds | SQLite `accounts.sf_*` | Same | (a) one-time flow fallback for tables the service role can't see; (b) **change-tracking auto-fix** — the poller/setup may use the pipeline CREATOR'S creds to run `ALTER TABLE … SET CHANGE_TRACKING = TRUE` on tables they connect (disclosed at save time) |
| AI provider key (Anthropic / OpenAI / Gemini) | SQLite `workspace_llm_config` | Same | LLM grouping/merge/validation calls. *Copilot removed from this list 2026-08-09 (SEC-07) — it was dropped as a provider option on 2026-07-27 because it has no standalone API key of its own, and zero references remain in the setup or provider code.* |
| Google OAuth refresh token | `pipelines.file_source_meta.refresh_token` | Same | Background re-reads of connected Sheets + output writes |
| Session cookie | Browser | HMAC-signed (`SESSION_SECRET`), 7-day TTL, `Secure` in prod, version-checked per request | Auth |
| `PRISM_ENCRYPTION_KEY`, env fallbacks | Deployment env | Host security | Master key; losing it orphans all `enc:v1:` secrets |

Trust boundary: whoever controls the app host (env + SQLite file) can decrypt
everything above. Single-tenant deployment makes that the customer (or Sanjiv
for hosted installs) — document per-install key custody.

---

**Data residency (2026-07-28):** no customer VALUES rest on the app host.
The run review state blob (`RUN_STATE`), the export-referee audit trail
(`VALIDATION_LOG`), and one-time mappings live in the customer's warehouse;
the app's SQLite holds only accounts, configs, and run/pipeline metadata.
Values still TRANSIT the app host in memory (grouping, review rendering) and
go to the AI provider as prompts — the claim is "not stored on vendor
infrastructure", not "not visible to the vendor". Logs must not capture
values: `PRISM_DEBUG_ARTIFACTS` stays off outside dev, and Sentry payload
scrubbing is a pre-launch item.

## 3. Data flows that leave the customer's control surface

1. **AI provider**: distinct text values from standardized columns (+ spec
   descriptions/rules, approved alias names) are sent to the configured
   provider. Never credentials, never full source rows. Vendor-key mode routes
   through Sanjiv's Anthropic workspace (one Console workspace per client).
2. **Google**: sign-in requests `spreadsheets` + `drive.file` scopes UP FRONT
   for every user (⚠️ over-scoped — recommend on-demand incremental auth
   later); connected Sheets are re-read every poll pass; output sheets and
   lookup exports are written to the user's Drive.
3. **Exports**: lookup CSV/Excel downloads and Sheets exports move mapping data
   out of Snowflake — user-initiated, disclosed at the export modals.
4. **Sentry** (when DSN set): errors/stack traces; no deliberate data payloads.

## 4. Other risk notes

- **Streams/change tracking**: enabling CT needs table-owner action or the
  creator-credential auto-fix; failure pauses the pipeline with the exact SQL
  (never silent).
- **Export overwrite**: one-time 'overwrite' fully replaces a table
  (CREATE OR REPLACE) — guarded by an explicit authorization warning.
- **Debug surfaces**: `/debug` + `/api/admin/table` are `PRISM_DEBUG_TOOLS`-gated
  (operator only, never customer installs); `PRISM_DEBUG_ARTIFACTS` writes LLM
  payloads to the OS temp dir — leave off outside dev.
- **Error hygiene**: Snowflake errors are sanitized before reaching the browser.
- **Invitations**: token links expire in 7 days; statuses pending/accepted/
  revoked; anyone holding an unexpired link + the invited Google account gets in.

---

## 5. Disclosure map (validated 2026-07-13)

Consent point → what the user is told. ✔ = pre-existing, validated as adequate;
✚ = added/amended in this review (kept to one sentence where it touches UI).

| Consent point | Disclosure | Status |
|---|---|---|
| Login page | Terms/Privacy agreement ✔; Google Sheets scope requested at sign-in, used only for spreadsheets you connect/export ✚ |
| Setup step 1–2 (install) | Data stays in your warehouse; admin credentials never requested; dedicated low-privilege service user ✔ |
| Setup step 3 (service creds) | Tested before save, stored encrypted ✔ |
| Setup step 4 (AI provider) | AI used for grouping, bills to your provider account ✔; **distinct column values are sent to the provider (never credentials/full rows)** ✚ |
| Setup footer | "service credentials + AI provider key, encrypted; admin credentials never saved" (was Anthropic-only) ✚ |
| Setup personal variant | Encrypted; used for one-time fallback **and the change-tracking fix on tables you connect** (was inaccurate after the auto-fix shipped) ✚ |
| Settings → Snowflake | Read/write purpose + grants-on-save ✔; "stored encrypted" ✚. **Corrected 2026-08-08 (SEC-07):** this section edits `ACCOUNTS.sf_*` — the signed-in admin's own PERSONAL credentials (`/api/accounts/snowflake-config`) — NOT the workspace service connection that pipelines, the poller and the lookup actually use (which resolves `workspace_config` → env, via `/api/accounts/workspace-snowflake` on the `/setup` flow). An admin editing here is not changing what the pipelines run as. The section is labelled accordingly. |
| Settings → Team | "Every member can view all pipelines, mappings, and the data values Prism standardizes" ✚; removal ends sessions immediately ✔ |
| Invite flow | Full disclosure box (data access, inviter responsibility, no liability) + required authority checkbox + role capability preview + 7-day expiry ✔ |
| Accept-invite | Workspace data visibility + consent + liability ✔; Terms/Privacy links ✚ |
| Terms interstitial (`/accept-terms`) | **Added 2026-08-14 (owner decision: shared visibility is acceptable only if explicitly disclosed); copy clarified + AI clause added 2026-08-16.** Carries two bolded disclosures: the shared workspace (everyone sees all pipelines/mappings/standardized values, including from tables that person couldn't open directly in Snowflake) and the AI — edition-aware: native names Claude on Snowflake Cortex, in-account, billed to the company's Snowflake account, no separate subscription; standard names the configured provider and that distinct column values are sent to it (2026-08-17: standard copy made configuration-neutral — no billing claim, since vendor-key installs bill the vendor, not the customer's provider account; and the shared-workspace sentence says "Prism workspace", not "Snowflake account" — standard installs are invitation-scoped and may run on any supported warehouse). Load-bearing in the NATIVE edition, where users are auto-provisioned on first visit and never see the invite/accept-invite disclosures — this interstitial is the one screen every member passes exactly once. |
| Native first-run (`/setup`, native edition) | **Added 2026-08-14.** The grant section tells the ADMIN, at the point of granting app access, that everyone with access sees all mappings — including ones built from tables their own Snowflake permissions can't read. |
| Snowflake connect form | Output-mode explanations ✔, including the Column-mode warning panel + required consent checkbox. **Corrected 2026-08-08 (SEC-07):** the collapsible "Snowflake changes" privilege panel (`ExportTableDisclosure`) is rendered on the **post-baseline activation card**, not on this form — it has exactly one render site. This row previously contradicted §1 of this same document, which places it correctly. The privileges are disclosed before the pipeline goes live, just at a later step than this row claimed. |
| Sheets connect | Manual-only + output-sheet behavior ✔; **encrypted Google token stored for background reads/output writes** ✚ |
| One-time fallback | Connect-your-own-credentials prompt ✔; "stored encrypted, used only on your behalf" ✚ |
| Connect-form preflight (SQL Server) | **Added 2026-08-08 (SEC-07).** On SQL Server installs the submit-time preflight popup ("Prism needs a few permissions first…") is the SOLE consent gate before Prism runs, with the pipeline creator's PERSONAL login: (a) Change-Tracking DDL — `ALTER DATABASE … SET CHANGE_TRACKING = ON` and `ALTER TABLE … ENABLE CHANGE_TRACKING`, plus `GRANT VIEW CHANGE TRACKING`; and (b) for Column output mode, `ALTER TABLE … ADD COLUMN` for the companion column and `GRANT UPDATE ON OBJECT::<that one table>`. Both are per-table and consent-gated (`change_tracking_consent`, `column_write_consent`). If consent is withheld or no personal credentials are saved, Prism performs NO DDL: it flags the pipeline with the exact SQL for an admin to run by hand (`columnModeSetupSql`, `tableModeSetupSql`) and the warehouse refuses the writes until they do. |
| One-time export overwrite | Explicit write authorization + data-loss disclaimer + safe recommendation ✔ |
| Terms/Privacy | Substantive (subprocessors, encryption, TLS, revocation) ✔; provider list generalized beyond Anthropic ✚. Still `PLACEHOLDER` pending counsel; example.com contacts. |

## 6. Recommendations (not yet implemented)

1. Incremental Google OAuth: request Sheets/Drive scopes only when a user first
   connects or exports a spreadsheet, not at sign-in.
2. Re-verify Snowflake RBAC default-deny on a clean account (open memory item).
3. Counsel review of /terms + /privacy before first sale; replace example.com
   contacts; confirm the vendor-key ("Prism-provided AI") data flow is covered.
4. Consider per-member audit logging (who exported/deleted what) before
   multi-team customers.
5. Document `PRISM_ENCRYPTION_KEY` custody per installation (password manager,
   documented in CLAUDE.md env table).

---

## SQL Server installs (port, 2026-07)

Credential inventory on SQL Server installs mirrors the Snowflake one:

| Credential | Where stored | Encrypted | Used for |
|---|---|---|---|
| Workspace service login (`workspace_config.ms_*`) | SQLite | AES-256-GCM (`enc:v1:`) | Everything automatic: poller, standardization, exports (via `/setup` step 3 or `MSSQL_*` env fallback) |
| Personal login (`accounts.ms_*`) | SQLite | AES-256-GCM | ONLY the one-time flow's access fallback (`/api/accounts/mssql-config`, member-savable). Also the Change-Tracking enable ladder at pipeline creation. |
| Warehouse platform choice (`workspace_config.warehouse_type`) | SQLite | — (not a secret) | Adapter selection; admin-only writes (`/api/accounts/warehouse-type`, `workspace-mssql`) |

Disclosures: the setup wizard's SQL Server variant carries the same "service
credentials stored encrypted / admin credentials never saved" copy as the
Snowflake flow.

**Personal SQL Server credentials — corrected 2026-08-08 (SET-M05).** The
disclosure previously said these were used only for one-time standardizations,
i.e. read-only. That was inaccurate: `withUserWarehouse` also runs them for the
**Change-Tracking auto-fix** (`ALTER DATABASE` / `ALTER TABLE` — schema-modifying
DDL, `create-initial-run/route.ts`) and for **table/column output-mode access
provisioning** (`GRANT` statements, `export-table.ts`), both during ordinary
pipeline creation. The copy now names all three uses and says plainly that two
of them change settings on the table rather than only reading it. Both remain
scoped to tables the user chooses to connect, and both remain consent-gated
(Change Tracking via `change_tracking_consent`, Column mode via
`column_write_consent`). Snowflake's equivalent copy was corrected earlier for
the change-tracking use; SQL Server additionally needs the GRANT use named,
because its provisioning path grants to a login rather than a role.
No data leaves the customer's SQL Server except the same distinct-value
prompts to the AI provider documented above.

## PostgreSQL installs (port, 2026-08)

Credential inventory on Postgres installs mirrors the other two:

| Credential | Where stored | Encrypted | Used for |
|---|---|---|---|
| Workspace service role (`workspace_config.pg_*` — host, port, database, user, password, sslmode; migration 018) | SQLite | AES-256-GCM (`enc:v1:`) | Everything automatic: poller, standardization, exports (via `/setup` step 3 or `PG_*` env fallback) |
| Personal role (`accounts.pg_*`) | SQLite | AES-256-GCM | ONLY the one-time flow's access fallback (`/api/accounts/pg-config`, member-savable) and Column-mode consent provisioning (`GRANT UPDATE` + `ADD COLUMN`, consent-gated). **There is NO Change-Tracking analog on Postgres** — detection needs no DDL and no personal-credential ladder, so that entire use category does not exist here. |
| Warehouse platform choice (`workspace_config.warehouse_type`) | SQLite | — (not a secret) | Adapter selection; admin-only writes (`/api/accounts/warehouse-type`, `workspace-postgres`) |

Scope disclosures specific to Postgres: one installation reaches ONE database
(pg cannot query across databases — stated in the wizard); detection reads
only built-in statistics counters plus the granted source schemas; the kill
switch is `ALTER ROLE prism_svc NOLOGIN`. TLS: managed providers use
`sslmode=require`/`verify-full`; the sslmode is part of the stored workspace
config. No data leaves the customer's Postgres except the same distinct-value
prompts to the AI provider documented above.

## MySQL installs (port, 2026-08)

Credential inventory on MySQL installs mirrors the others:

| Credential | Where stored | Encrypted | Used for |
|---|---|---|---|
| Workspace service account (`workspace_config.my_*` — host, port, database, user, password, ssl; migration 019) | SQLite | AES-256-GCM (`enc:v1:`) | Everything automatic: poller, standardization, exports (via `/setup` step 3 or `MYSQL_*` env fallback) |
| Personal account (`accounts.my_*`) | SQLite | AES-256-GCM | ONLY the one-time flow's access fallback (`/api/accounts/mysql-config`, member-savable) and Column-mode consent provisioning (`GRANT UPDATE` + `ADD COLUMN`, consent-gated). No Change-Tracking analog exists on MySQL — that use category does not apply. |
| Warehouse platform choice (`workspace_config.warehouse_type`) | SQLite | — (not a secret) | Adapter selection; admin-only writes (`/api/accounts/warehouse-type`, `workspace-mysql`) |

Scope disclosures specific to MySQL: the service account reaches any DATABASE
it is granted (cross-database joins work — per-database `GRANT SELECT ON
<db>.*`); detection reads only InnoDB last-write metadata plus the granted
sources; no binlog/replication access is ever requested; kill switch is
`ALTER USER 'prism_svc'@'%' ACCOUNT LOCK`. TLS setting is part of the stored
workspace config. No data leaves the customer's MySQL except the same
distinct-value prompts to the AI provider documented above.


---

## 7. Customer-facing brief

`CUSTOMER_SECURITY_BRIEF.md` is the plain-language version of this document,
written to be shared with a customer or their security reviewer. THIS file
stays the engineering source of truth (code paths, exact grants, disclosure
map); the brief translates it.

**Keep them in step.** Any change to what Prism can access, or to what leaves
the customer's network, must update BOTH — plus the relevant UI disclosure, per
the rule in section 5. The brief deliberately includes a "risks we would raise
ourselves" section; when a new capability lands, decide explicitly whether it
belongs there rather than leaving it for a reviewer to discover.

### SQL Server export-schema ownership (added 2026-08-06, KI-117)

Onboarding now includes `GRANT CONTROL ON SCHEMA::<export_schema> TO
<service login>`, scoped to the export schema only.

Rationale for reviewers: SQL Server has no `COPY GRANTS` equivalent, so a
table-mode rebuild must re-apply permissions by hand — and only the schema
OWNER can both read the existing access list and re-grant it. Without ownership
SQL Server does not raise an error when an unprivileged login asks who has
access; it returns an EMPTY list, so the rebuild concluded there was nothing to
preserve and silently revoked every grant on the export table.

`refreshExportTableMssql` now verifies ownership (`HAS_PERMS_BY_NAME` for
VIEW DEFINITION + CONTROL) before the swap and flags the pipeline with the exact
fix statement when it is absent, so a skipped onboarding step surfaces instead
of silently losing grants. Snowflake is unaffected — `COPY GRANTS` preserves
privileges natively and it has no column-level GRANT.

## Native (Snowflake Marketplace) edition — data-flow summary (2026-08-13)

The native edition inverts the standard deployment model, and its disclosures
differ accordingly (the /terms and /privacy pages render edition-aware
variants; the setup footer likewise):

- **Nothing is stored or processed outside the customer's Snowflake account.**
  The app runs as a Snowpark Container Services service in their account; app
  state (SQLite) lives on a block volume in their account; all values and
  mappings are warehouse tables in their account.
- **No credentials are collected.** Snowflake authenticates users at the
  ingress; the app operates via its granted privileges and table references.
- **AI = Snowflake Cortex, in-account.** No external LLM provider, no vendor
  key, no egress (the container has no external access integration).
- **No Google, no SMTP, no Sentry** in this edition (all gated off).
- What the provider (we) receive: only Snowflake's aggregate provider
  reporting (install counts etc.). The app is free and meters nothing —
  billing events and the usage counter were removed 2026-08-27. Never
  values, never metadata, never usage counts.

Any future feature that transmits anything off-account must update the
edition-aware /terms + /privacy variants AND pass Snowflake's security
review disclosure requirements. Full N5 review of this document happens
before listing (docs/NATIVE_APP_PLAN.md).
