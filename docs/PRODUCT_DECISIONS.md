# Prism — Product & Architecture Decisions Log

A running record of decisions that involved a real cost/benefit tradeoff — not
just "how we implemented X," but "we could have gone either way, and here's why
we picked one." Meant to save future-us (and anyone new) from re-litigating
settled questions, and to make the tradeoffs we accepted explicit rather than
buried in code comments.

Each entry: the decision, what we didn't do, why, and the cost we knowingly
accepted.

---

## Access & Governance

### No table is fully off-limits to Prism if a user personally has access

**Decision (2026-07-07):** One-time standardizations can run against a table
the `PRISM_SERVICE` role was never granted, by falling back to the requesting
user's own personal Snowflake credentials (saved once, encrypted). The read —
and, if they choose to overwrite/create, the write — runs entirely under that
user's own Snowflake entitlements.

**What this means in aggregate:** if a table is visible to *any* invited Prism
user's personal Snowflake login, that user can bring it into Prism via a
one-time standardization, regardless of what the company's Snowflake admin
granted to the service role. The service-role grant list is no longer a hard
ceiling on what Prism can touch — it's the ceiling for the *automatic, ongoing*
surface (pipelines, the shared lookup); a human with their own credentials can
still reach further, deliberately, one table at a time.

**Alternative considered:** restrict one-time standardization strictly to
tables the service role can see — simpler governance story, one clean ceiling.

**Why we didn't:** it blocks a real, legitimate self-serve case — a data
engineer who already has Snowflake access to a table (and could just as easily
open a worksheet and query it themselves) shouldn't need an IT ticket to get
Prism's help cleaning it up once. Prism would be *less* capable than the
person's own Snowflake login, for no security benefit.

**Why it's an acceptable expansion, not a hole:**
- It requires the user's **own, genuine** Snowflake access — Prism grants
  nothing; it only uses what already exists. Not a privilege escalation.
- It's scoped to the **one-time, lookup-free flow only** — never pipelines,
  never the shared lookup (`LITERAL_ALIAS_MATCHES`/`APPROVED_ALIAS_NAMES`).
  Nothing reached this way becomes a standing, automated surface.
- Every read/write is **audited under the user's own Snowflake identity** in
  their query history — same as if they'd run it in a worksheet.
- The org's Snowflake admin retains the actual control point: if a table
  shouldn't be reachable this way, don't grant *any* human user access to it
  either — the same discipline that already applies without Prism.

**Cost accepted:** the "what can Prism reach" answer for security reviewers is
now two-tiered — "automatically: what's granted to `PRISM_SERVICE`" and
"manually, one table at a time: whatever any invited user can personally
reach." Worth stating clearly to a client's security team rather than letting
them assume the service-role grant list is the whole story.

**Delivery detail (2026-07-07):** to make the personal-credential path
discoverable, the OAuth callback now routes **every** new account (not just
admins) through `/setup` once, with role-appropriate copy. Regular users see
a distinct, explicitly optional variant — "(optional)" tag, a "Skip for now"
button always available, empty (not `PRISM_SERVICE`/`PRISM_WH`) default
fields — and the account identifier is prefilled from the workspace's own
config, so a member connecting personal credentials only ever types their own
username + secret, never the Snowflake account itself (there is exactly one
per workspace). This was a UX delivery choice for the decision above, not a
separate tradeoff: the alternative (leave it undiscoverable until a user hits
a blocked table) was simply worse onboarding, with no corresponding benefit.

⚠️ **See "Known Issues & Findings Requiring Future Verification" at the end
of this document** — testing this exact feature surfaced a serious,
unresolved Snowflake-account-level finding (not a bug in this decision's
implementation) that must be re-verified before onboarding real clients.

---

### Workspace-level access — no per-user data restriction

**Decision:** every invited Prism user has equal access to everything inside
the app — any table Prism can reach, any pipeline (view/edit/delete), any
domain. There is no per-user or per-team scoping.

**Alternative considered:** row/table/pipeline-level ACLs per user.

**Why we didn't (at launch):** the target customer is "one team, one shared
workspace" — building a permission system before anyone asked for one is
speculative complexity. The two governance dials that exist instead — *which
schemas the Snowflake admin grants* and *who the Prism admin invites* — cover
the real need for launch-stage customers.

**Cost accepted:** any invited user can delete any other user's pipeline, or
export the full lookup for a column spec they didn't create. Acceptable for a
same-team workspace; **flagged in the backlog** (`visibility groups` on
pipelines/specs) as the answer if a customer demands team-scoped access —
deliberately not built preemptively.

---

### Prism invitations never grant Snowflake roles

**Decision:** inviting someone to the Prism app and granting them a Snowflake
role (`PRISM_DATA_ADMIN` etc.) are two fully separate acts. The app never
auto-grants warehouse access; a client's Snowflake admin does that by hand,
if ever.

**Alternative considered:** auto-grant a Snowflake role matching the invited
Prism role, so "invite" is a one-step provisioning action.

**Why we didn't:** it would turn the Prism invite button into a
privilege-escalation bridge — compromising an admin's Google account would
also mint direct database credentials for whoever got invited. It also doesn't
map cleanly: most Prism users (ops/analyst types) have no Snowflake login at
all, so "grant them a Snowflake role" is meaningless for the common case.

**Cost accepted:** manual step for the rare case a human genuinely needs direct
SQL access (`PRISM_DATA_ADMIN`) — judged the right cost for keeping the
service-role/human-role boundary hard.

---

## Storage & Hosting

### App-state split: SQLite (local) vs. Snowflake (customer's)

**Decision:** one governing rule — any table joined against customer source
data inside Snowflake SQL stays in Snowflake; everything else (accounts, run
review state, pipeline configs, domains, audit logs, one-time archive) moved to
a local SQLite file.

**Alternative considered:** Postgres for the app-state half.

**Why SQLite over Postgres:** the deployment model is already one long-lived
Node process per install (required by the in-process poller/SSE broadcaster) —
Postgres would add a second container/service to every install for no
capability gain at this scale. SQLite is zero extra infrastructure and fits a
single-process app exactly.

**Cost accepted:** doesn't scale to multiple app instances sharing state — but
the architecture already forbids that (single process is a hard requirement
independent of this choice), so the cost is theoretical at current scale.

---

### `PIPELINE_FILE_ROWS` stays in Snowflake despite the cost

**Decision:** unlike the other hot tables, full file-row snapshots (CSV/Excel/
Sheets uploads) were deliberately **not** moved to SQLite in the storage
migration — they stay in the customer's Snowflake account.

**Why:** every other moved table holds *Prism's own* bookkeeping. This one is
different — it's a copy of the customer's **entire uploaded file**, every
column, not just the ones being standardized. Of everything Prism touches,
it's the single largest chunk of raw customer data outside their warehouse.
Given the longer-term goal of Prism never storing customer data (see below),
this was the one line not worth crossing for a cost optimization.

**Cost accepted:** Sheets pipelines keep some recurring Snowflake touches
(mitigated in Phase 4 by skipping the refresh entirely when the sheet's
content hash is unchanged) — a real but bounded and now-minimized cost,
in exchange for keeping whole-file content off Prism's own infrastructure.

---

### Prism-hosted (vendor-managed) at launch, not customer-hosted

**Decision:** launch as one Prism-managed instance per client (you provision
and run it), not as software the client installs and runs themselves.

**Alternative considered:** ship Prism as self-hosted software from day one —
the strongest possible data-residency story (customer data never touches
vendor infrastructure at all).

**Why we didn't, yet:** self-hosted distribution turns every customer install
into a support and versioning problem — no direct log access, slow
iteration (a fix requires every customer to redeploy), and real setup friction
that filters out exactly the less-technical buyers the product also targets
(the Sheets/CSV self-serve users). Pre-launch, iteration speed and the ability
to actually see what broke are worth more than the (currently hypothetical)
customer who demands self-hosting.

**Cost accepted:** customer run-review state and file-row snapshots (see
above) transit and persist on vendor infrastructure, not purely the customer's
Snowflake — a real, deliberate tradeoff, mitigated by disk encryption and by
keeping the accumulated *asset* (confirmed mappings, export tables) in the
customer's Snowflake regardless of hosting model.

**Kept open, deliberately:** the single-process, two-store (Snowflake +
SQLite) architecture *is* the self-hosted shape already — moving to
customer-hosted later is a packaging/distribution exercise (Docker image,
license mechanism, per-install OAuth), not a re-architecture. This was a
sequencing decision, not a rejection of self-hosting.

---

### Long-term goal: minimize, then eliminate, vendor access to customer data

**Decision:** treat "Prism never touches client data" as a roadmap direction
guiding today's architecture choices, without requiring it immediately.

**The staged path this unlocks (not yet built):**
1. Customer's own Anthropic API key instead of Prism's — near-zero effort,
   removes Prism-the-company from the LLM data path entirely.
2. Snowflake Cortex (`AI_COMPLETE`) instead of the Anthropic API for
   grouping/validation — the strongest version: distinct values never leave
   the customer's Snowflake account at all, not even to a third-party API.
3. Customer-hosted distribution (see above) for the app/state layer.

**Why decide this now rather than later:** it constrains today's choices
cheaply — keep the LLM call site centralized in one file
(`llm-one-prompt-grouping.ts`) so swapping providers is a small change; keep
the deployment single-tenant and self-contained; keep whole-file content in
the customer's Snowflake (the decision above). None of that costs anything
today and all of it keeps the path open.

**Cost accepted:** none yet — this is a "don't foreclose the option" decision,
not a feature that shipped.

---

## Cost Engineering (Snowflake compute)

### A dedicated `PRISM_WH` warehouse, not the customer's existing compute

**Decision:** the install script creates and Prism runs exclusively on its own
warehouse (XSMALL, 60s auto-suspend), rather than defaulting to whatever
warehouse the customer points it at.

**Alternative considered:** let Prism share the customer's existing warehouse
by default (simpler install — one less object).

**Why we didn't:** shared compute means Prism's cost is invisible/unattributable
on the customer's bill, and Prism's auto-suspend needs would fight with
whatever tuning the customer already has for their own workloads (a
customer's dashboard-refresh warehouse probably shouldn't suspend after 60s).
A dedicated warehouse makes Prism's cost a clean, auditable line item.

**Cost accepted:** one more object at install time. Customers who insist on
shared compute can still point Prism at their own warehouse — kept as the
escape hatch, not the default.

---

### Idle-cycle discipline — aggressively minimizing per-poll-cycle Snowflake work

**Decision:** rebuilt the 30-second poller so a genuinely idle cycle touches
**zero** warehouse-waking operations — health checks throttled to
data-bearing cycles only, backlog checks gated on a local SQLite mirror before
querying Snowflake, Sheets refreshes skipped entirely on an unchanged content
hash, static-file metrics recomputed only every ~10 minutes instead of every
cycle.

**Why this mattered enough to engineer carefully:** the entire cost argument
for the storage migration collapses if the poller still wakes the warehouse
every 30 seconds regardless of whether anything changed — `AUTO_SUSPEND = 60`
does nothing if the warehouse is touched every 30. This phase is what actually
converts "the warehouse *can* suspend" into "the warehouse *does* suspend, all
night, every night."

**Cost accepted:** more in-process state to track correctly (per-pipeline
cycle counters, an in-memory sheet-content-hash cache) — real complexity, but
verified against the earlier decision to keep app-state local and cheap to
touch, so the added checks cost SQLite reads, not Snowflake queries.

---

## Export Table Shape

### No synthetic ordering column — order only when the source declares a key

**Decision (2026-07-14):** removed the `PRISM_ROW_ORDER` column from export
tables. The export now contains ONLY the source's own columns. When the source
table declares an ordering basis — a PRIMARY KEY, a UNIQUE KEY, or a
CLUSTERING KEY — the export table is physically built in that order so it
mirrors the source; a source with none of these gets an unordered export.

**Alternative considered:** keep the synthetic column (with its ingest-order
fallback for keyless tables) so every export carried a guaranteed,
queryable row order.

**Why we didn't keep it:** a metadata column Prism invents sitting inside what
customers think of as "their table, standardized" reads as clutter and
surprises reviewers (it surfaced as a suspected bug during testing). For
sources WITH a key, the column was redundant — consumers can `ORDER BY` the
key columns themselves, which exist in the export. For sources WITHOUT a key,
the fallback (value-ingest order) was an artificial order nobody asked for.

**Cost accepted:** exports from keyless sources have no recoverable source
order at all — a plain `SELECT` may return rows in any order, and there is no
column to sort by that reconstructs the source sequence. Acceptable because a
keyless Snowflake table has no meaningful stored order to preserve anyway.
Consumers of keyed exports must know to `ORDER BY` the key (worth one line in
onboarding docs).

---

## SQL Server Port (2026-07)

The port's settled tradeoffs live in `docs/MSSQL_PORT_PLAN.md` (§2, the
authoritative decision record) and per-operation in `docs/WAREHOUSES.md`.
Headlines, for this log's completeness:

- **No SQL-side normalization on SQL Server** — one TypeScript implementation
  + exact-match staging tables (BIN2), accepting a distinct-count ceiling, to
  eliminate the two-implementations-must-agree silent-corruption risk.
- **Change Tracking fast path, tiered diff-scan universal fallback** — never
  block onboarding on DBA-level DDL; PK-less tables just scan.
- **`PRISM_DB.EXPORTS` (not PUBLIC)** — "public" collides with the built-in
  database role.
- **No programmatic grants pass on mssql** — the service login can't grant;
  the sysadmin install script + verify checklist replace `applyGrants`.
- **`export_kind = 'view'` refused on mssql** (loud error) — views can't
  reference per-rebuild staging tables.
- **Azure SQL serverless detected and polling stretched ×10** — it auto-pauses
  like a Snowflake warehouse; steady polling would negate the customer's
  savings.

---

## Naming, Trust Signaling, and Polish

### Semantic Snowflake naming over a straight `STAND_` → `PRISM_` swap

**Decision:** renamed the legacy `STAND_*` Snowflake objects to names that
describe their *function*, not just the brand — `PRISM_SERVICE` (not
`PRISM_ADMIN`), `INTERNAL` schema under `PRISM_DB` (not `PRISM_INTERNAL`),
`PRISM_READONLY` (not `PRISM_VIEWER`).

**Why:** every one of these names is something a client's Snowflake admin will
eventually read directly in their own account (`SHOW GRANTS`, `SHOW ROLES`).
"Is this the service role or a human role?" should be answerable from the name
alone — `PRISM_SERVICE` says it; `PRISM_ADMIN` doesn't.

**Cost accepted:** a full-repo rename (54 files) plus a database reset —
acceptable specifically because it was done pre-launch, before any real
customer's Snowflake account carried the old names.

---

### Setup/grants UX: "already in place" is success, not failure

**Decision:** before running account-level `CREATE ROLE`/`CREATE WAREHOUSE`
statements from the app, pre-check whether the object already exists
(`SHOW ROLES`/`SHOW WAREHOUSES`) and report a match as "already in place from
install" — green — rather than letting the privilege error surface as a
red "failed" line.

**Why:** the *recommended* install path (run the SQL script as ACCOUNTADMIN
first) makes these statements redundant by design — the app's attempt to
re-create them was always going to fail on privileges. Before this fix, the
recommended, fully-successful path produced a scary red "5 failed" panel,
which is exactly backwards for a setup flow whose job is to build confidence.

**Cost accepted:** a couple of extra metadata queries per grants-application
run — negligible.

---

### Instant session revocation, no cache

**Decision:** once `ACCOUNTS` moved to local SQLite, dropped the 60-second
revocation cache and check the session version on **every** request.

**Why:** the cache existed only because the check used to be a Snowflake round
trip; once it's a local SQLite read, caching bought nothing but a 60-second
window where a removed employee could still act. Paired with a client-side
fix (a 401 on the session check now clears the cookie and redirects, so a
revoked user isn't stuck looking at a UI that renders but silently rejects
every action).

**Cost accepted:** none material — a local read on every request is cheap
enough not to matter.

---

### Accept Google OAuth Testing-mode friction now; defer verification

**Decision:** run on an unverified Google OAuth app (manually adding test
users) through early development and initial customers, rather than front-
loading Google's app verification review before writing any other code.

**Why:** verification requires a live privacy policy, domain ownership proof,
and a sensitive-scope (`spreadsheets`) justification — real work that's only
worth doing once you're actually approaching customers who'll hit the
100-test-user cap or balk at the "unverified app" warning. Doing it on day one
would have blocked unrelated work for no benefit at that stage.

**Cost accepted:** every new tester (including new client admins, until
verification completes) must be manually added to the OAuth consent screen's
test-user list — a real but small recurring task, tracked as a pre-GA
blocker in the backlog rather than solved prematurely.

---

## Pipeline Output Modes & Source-Table Writes (2026-07-22 → 24)

### Four output modes: Table, Column, View, Lookup table

**Decision (2026-07-22):** the connect form's Output picker offers four modes.
The new one, **Column**, writes standardized values into a
`<col>_STANDARDIZED` companion column added to the customer's own source table
(NULL until standardized). Internally a column pipeline stores
`export_table_fqn = table_fqn` so every rebuild trigger, the once-per-table
dedup, and card grouping work unchanged; `asExportKind()`
(`_lib/export-kind.ts`) is the only sanctioned parser, and both table/view
builders refuse a destination equal to the source (a mis-parsed kind fails
loudly instead of `CREATE OR REPLACE`-ing customer data).

**Key mechanism:** the column sync uses change-guarded UPDATEs (only rows
whose standardized value actually changes), because the pipeline's own
stream/CT watches the very table being written — unguarded writes would
re-detect themselves forever; guarded ones settle after one echo cycle.

### Source-table writes are per-table, consent-gated — never blanket

**Decision (2026-07-24, revised twice in one session):** onboarding grants the
service role read + create-its-own-outputs only, and the generated Part D SQL
*states* that Prism gets no write access to existing tables. Column mode's
`UPDATE` is granted case-by-case: a required consent checkbox on an unmissable
warning panel (API rejects `export_kind='column'` without
`column_write_consent: true`), then `provisionColumnModeAccess` runs the
companion `ADD COLUMN` + single-table `GRANT UPDATE` via the pipeline
creator's personal credentials (change-tracking-fix pattern); no credentials /
no authority → pipeline flagged with the exact one-table SQL, and the
warehouse itself refuses every write until an admin runs it.

**What we didn't do:** blanket `GRANT UPDATE ON ALL/FUTURE TABLES` in
onboarding Part D (it was briefly implemented, then reversed the same
session) — simpler, zero-friction, but hands Prism standing write access to
everything, which contradicts the trust story and the disclaimer's
"specific-table" framing.

**Cost accepted:** column-mode setup can stall on a flagged manual GRANT when
the creator has no personal credentials; a leftover companion column from a
deleted pipeline blocks reconnection until manually dropped (Prism refuses to
adopt any pre-existing column — it can't prove provenance).

**Enforcement layers (in trust order):** warehouse default-deny (no UPDATE
grants exist anywhere at onboarding — the layer that doesn't require trusting
Prism's code) → API consent gate → `assertCompanionColumnSafe` write-target
guard (parity-tested) + creation-time companion-conflict refusal. The
UI carries an explicit no-liability statement and a recommendation against
using column mode on unrecoverable data. **Live verification is mandatory
before shipping: docs/PRELAUNCH_CHECKLIST.md §1.**

### `export_unmapped_rows` applies to every schedule and defaults OFF

**Decision (2026-07-22):** the "Export unstandardized values" toggle shows for
all update schedules (previously hidden + forced true-but-ignored for 24/7)
and defaults off (mapped rows only). Rationale: 24/7 pipelines also hold
unmapped values — between ticks, during 5k-installment backlog drains, and
while paused — so "the window is negligible" was false. Post-creation the
setting is editable in the card's Settings tab (save triggers one
refresh-export; views get recreated). The "Mapped only" card badge existed
briefly and was removed 2026-07-24 (user preference — Settings-tab-only
visibility).

**Cost accepted:** pipelines created before the flip stored `true` and now
honor it (behavior change, acceptable pre-launch); a view's row behavior is
baked into its SQL, so setting changes require the view rebuild the Settings
save performs.

### Views: created exactly once, repaired manually — no periodic retry

**Decision (2026-07-23):** a view export is created at activation only; the
poller/tick never touch it. When that single fire-and-forget attempt fails
(e.g. missing `CREATE VIEW` grant — the incident that surfaced this), the
failure is flagged on the card with per-kind fix SQL, and
`refresh-export` / "Recreate view now" in Settings is the repair path.
Onboarding's new Part D (schemas typed in → generated grants incl.
`CREATE VIEW`) exists to prevent the incident class; the bootstrap's
dev-only ONBOARDING MIRROR (below the `-- PRISM:INSTALL-SCRIPT-END` marker,
truncated out of the customer-served install script) makes wizard-free dev
resets possible.

## Known Issues & Findings Requiring Future Verification

Unlike the sections above, these aren't decisions — they're things we
discovered that don't fit the "cost/benefit tradeoff" framing but are
important enough not to lose. Each is flagged with what still needs to
happen before it can be considered resolved.

### ⚠️ NEEDS RE-TESTING: a dev Snowflake account was found not enforcing default-deny RBAC

**Status: unresolved, environment-specific, blocks nothing today — but MUST be
re-verified against every real client's Snowflake account before relying on
the grants-based access model for them.**

**What was observed (2026-07-07):** while testing the one-time-standardization
personal-connection feature (see "No table is fully off-limits..." above), a
brand-new Prism account with **zero saved Snowflake credentials** was able to
read a table (`HR_DB.CONFIDENTIAL.EMPLOYEE_DEPARTMENTS`) that `PRISM_SERVICE`
had never been granted any access to, at any level (database, schema, or
table), direct or inherited.

**Investigation summary — every standard explanation was checked and ruled out,
in order:**
1. Confirmed `.env.local` correctly pins `SNOWFLAKE_ROLE=PRISM_SERVICE`, and
   `createSnowflakeConnection` passes it explicitly on every connection — no
   code path silently defaults to a different role.
2. Confirmed via a direct SQLite read that the test account genuinely had no
   `sf_*` credentials saved (ruling out the personal-connection fallback
   being what actually succeeded).
3. Confirmed via `SHOW GRANTS ON DATABASE/SCHEMA/TABLE` at every level: only
   `OWNERSHIP → ACCOUNTADMIN` and one deliberate test grant
   (`HR_READONLY_TEST`) existed. No `PRISM_SERVICE`, no `PUBLIC`, anywhere.
4. Confirmed via `SHOW GRANTS TO ROLE PRISM_SERVICE` (the complete,
   authoritative list of everything that role can do, direct or inherited via
   role hierarchy): every single row scoped to `PRISM_DB`, `TEST_DB`, or
   `PRISM_WH`. Nothing related to the test database at all.
5. Ruled out query-result caching explicitly (`ALTER SESSION SET
   USE_CACHED_RESULT = FALSE`) — the read still succeeded.
6. Ruled out worksheet/session role staleness by running `SELECT
   CURRENT_ROLE()` directly alongside the successful read — genuinely
   confirmed `PRISM_SERVICE` was the active role.
7. **Decisive test:** created a role (`ZERO_GRANTS_TEST`) with **no grants of
   any kind** except `USAGE` on a warehouse (the bare minimum to run any
   query at all). Switched to it, confirmed via `CURRENT_ROLE()`, and it
   **also** successfully read the same table.

**Conclusion:** step 7 proves this has nothing to do with `PRISM_SERVICE`,
Prism's code, or anything configured in `01_internal_tables.sql`/`grants.ts`
— all of which were independently verified correct. This specific Snowflake
account is not enforcing default-deny access control: **any role, regardless
of grants, can read this data.** That is a property of the Snowflake account
itself (very likely a trial/free-tier default, or a newer platform behavior —
genuinely unknown which, and not resolvable without Snowflake support or
testing against a different account type).

**Why this matters for Prism specifically:** the entire governance story in
`CLIENT_ONBOARDING.md` and the "workspace-level access" decisions above rests
on one assumption — *a role with no grants sees nothing.* We have direct,
repeatable proof of at least one real Snowflake account where that assumption
is false. If a client's account behaved the same way, `PRISM_SERVICE` would
be able to read schemas the client's Snowflake admin never intended to grant
it, and the entire "grant only what you want Prism to see" security story
would be silently void — through no fault of Prism's code.

**What still needs to happen (do not skip this):**
- **Before onboarding any real client**, run the zero-grants-role test from
  the onboarding checklist (Appendix A) against **their actual Snowflake
  account** — not this dev account. A production/enterprise Snowflake account
  should fail this test (i.e., correctly deny access) per Snowflake's
  documented RBAC model; if it doesn't, treat that as a serious,
  client-specific finding requiring Snowflake support involvement before
  proceeding.
- Optionally, narrow down *why* this dev account behaves this way (e.g., is
  it specific to objects owned by `ACCOUNTADMIN`, or truly universal within
  the account? Is it a documented trial-account default?) — not required to
  unblock anything, but would resolve the open question.
- If a pattern emerges across multiple client accounts, this stops being a
  one-off dev-environment curiosity and becomes a real product-security issue
  requiring a different mitigation (e.g., Prism performing its own
  belt-and-suspenders access check rather than trusting Snowflake's grants
  alone).

**Cleanup performed:** the test objects (`HR_DB` database, `HR_READONLY_TEST`
role, `ZERO_GRANTS_TEST` role) were dropped after the investigation. The
onboarding checklist item added as a result of this finding is in
`CLIENT_ONBOARDING.md` §Appendix A.

## Export referee disabled — the customer's mapping always wins (2026-08-18)

**Decision (owner, during the standard-edition client-sim rehearsal):** the
export validation referee (Case A/B/C LLM review of user changes that
contradict the lookup or a high-confidence initial grouping) is DISABLED.
Whatever the reviewer exports is written to the lookup verbatim, always.

**Trigger:** matrix test C3 — the owner deliberately moved a lookup-confirmed
"Boost" into the AT&T group; the referee reverted it to "Boost Mobile"
exactly per its spec ("revert only when extremely confident the change is a
mistake"). Working as designed — and the owner judged the design itself
wrong: user sovereignty over the shared lookup beats protection from
accidental drags.

**Trade accepted:** an accidental mis-drag exported by a reviewer now lands
in the shared lookup with no automatic backstop; the remedy is human (re-move
and re-export).

**Implementation:** `EXPORT_REFEREE_ENABLED = false` in op-export.ts's
`runWriteAndValidatePass` — the referee block is skipped, `decisions = null`
rides the long-standing fail-open path, `VALIDATION_LOG` gets no new rows
(table retained, vestigial). Detection machinery, prompts, and the Case C
`initial_*` stamps are all retained; re-enabling is a one-line change.

---

## Native (Marketplace) edition is free — usage metering removed entirely (2026-08-27)

**Decision:** The Snowflake Marketplace edition ships free. The whole §2.8
billing stack was deleted, not gated: `billing-meter.ts` / `billing-math.ts`,
the warehouse `BILLING_METER` + `BILLING_EVENTS` ledgers (setup.sql now drops
them on upgrade), the sealed `EMIT_BILLING` proc, `/api/accounts/usage`, and
the Settings → Usage surface. Prism keeps **no count** of standardized values
anywhere.

**What we didn't do:** keep the meter running "just in case" (edition-gated or
dark). Counting customers' activity while charging nothing is exactly the kind
of quiet tracking the privacy page says we don't do, and dead metering code on
every export path is a liability. The design survives in git and in
`NATIVE_APP_PLAN.md` §2.8 (marked superseded) if pricing ever returns.

**Cost knowingly accepted:** (1) no revenue from this channel — the listing is
a distribution/adoption play; consumers still pay Snowflake for their own
compute and Cortex tokens. (2) The standard edition loses the shared counter
that was meant to drive invoice rollups someday — it was Snowflake-only and
had no live consumer, so nothing breaks today; standard-edition invoicing
needs its own counting story if/when it matters. (3) The never-fully-solved
emission problem (billing events require a monetized listing install) becomes
moot rather than solved.

---

## Native edition: app-level roles removed — everyone is admin (2026-08-28)

**Decision:** Reverses the 2026-08-17 "keep admin/user roles" call. In the
native edition every account now provisions as admin (existing 'user' rows
self-promote on next visit) and the Settings → Team section is gone.
Membership is governed solely by the Snowflake-side application role grant
(`GRANT/REVOKE APPLICATION ROLE <app>.app_user`).

**Why the reversal:** the roles' remaining value had thinned to nothing —
billing/Usage (removed 2026-08-27) and Team management were the only gated
surfaces, and Team management duplicated what Snowflake's grant already does
better: revoking the application role blocks the person at the ingress,
before Prism even sees them. An in-app hierarchy nobody needs is onboarding
friction and test surface.

**Cost knowingly accepted:** no in-app "remove this person" button — an org
removes someone with a Snowflake REVOKE, which is where their DBA works
anyway. The standard edition keeps its roles and invitations unchanged.

---

## Native edition: RBAC-scoped visibility replaces the shared workspace (2026-08-28)

**Decision:** Reverses the 2026-08-14 shared-workspace-with-disclosure model.
In the native edition, "your role defines your view": a pipeline (and its
spec's mappings) is visible to a user only if they created it, OR their own
Snowflake access can read its source table, OR its source is an uploaded
CSV/Excel file (no Snowflake object exists — file work is visible to everyone
with app access). Access is checked on the viewer's caller-rights session via
SHOW OBJECTS (metadata-only — no warehouse wake), cached ~5 min per
(viewer, table). Where access CANNOT be verified — above all in databases
without the caller-grant opt-in — the object stays creator-only (owner choice:
unverifiable = hidden). The terms interstitial and /setup copy now state this
model; the shared-workspace disclosure is gone from native (standard edition
keeps its invitation-scoped shared workspace unchanged).

**What we didn't do:** keep the shared workspace (the August disclosure
model) or build per-team visibility groups. The owner chose the Snowflake
norm — users should never see derived values from tables their RBAC can't
read.

**Costs knowingly accepted:** (1) the caller opt-in quietly became
load-bearing for team visibility — a company that skips it gets
everyone-sees-only-their-own; the /setup copy says so. (2) The shared lookup
still accumulates across users (consistency is the product); scoping governs
*viewing*, not writing — two users' pipelines on the same column still share
mappings. (3) v1 scope: the pipelines list/detail/mappings surfaces and the
Mappings tab are scoped; SSE event payloads (ids/status) and run-page deep
links by guessed ID are not yet individually guarded — follow-up hardening
before a multi-team customer.
