# Prism — Snowflake Marketplace (Native App) Edition Plan

**Status: DRAFT — both owner decisions made 2026-08-12 (§2.4 Cortex, §2.5
block volume); each is confirmed-pending its N0 validation spike.**
Written 2026-08-12. This plan covers packaging Prism as a Snowflake Native App
("the native edition") for distribution on the Snowflake Marketplace, alongside
the existing standalone product ("the standard edition"). It follows the same
phase/exit-criteria discipline as the warehouse port plans.

The core inversion to keep in mind throughout: **standard Prism runs on our VPS
and connects out to the customer's warehouse with credentials they give us; the
native edition runs *inside* the customer's Snowflake account**, installed from
an application package, authenticated ambiently, with privileges the customer
grants through Snowflake's own consent UI. Marketplace rules prohibit asking
consumers for Snowflake credentials and prohibit routing core functionality
through an external website — so prismmasterdata.com-style hosting cannot be
the app, and the whole credential layer becomes dead weight in this edition.

---

## 1. What changes and what doesn't

**Unchanged (the shared core — this is why it's one repo, not a fork):**
- The grouping engine, merge pass, referee, convention system, normalization
  (`PRISM_NORMALIZE` UDF + `normalizeLiteral`), lookup/export logic, run state
  blob, review UI, one-time flow (Snowflake-source + upload variants), the
  poller/tick architecture, the cost-model discipline (metadata-layer idle
  cycles still matter — the compute pool is the customer's bill).
- The warehouse adapter facade. The native edition pins
  `warehouse_type = 'snowflake'`; the adapter surface is untouched.
- SQLite as the app-state store (v1 — see §2.5).

**New:**
- `native/` directory at the repo root: `manifest.yml`, `setup.sql`, SPCS
  service spec, Dockerfile, image build/push + version/patch release script.
- `PRISM_EDITION` switch (`'standard' | 'native'`), resolved once in
  `_lib/env.ts` like `isFreshSetupSim()` — one predicate, checked at surfaces.
- A third connection tier in `warehouse/snowflake/connection.ts`: SPCS ambient
  OAuth (token file at `/snowflake/session/token` + `SNOWFLAKE_HOST`).
- Snowflake-native user sessions: the SPCS ingress authenticates the user and
  passes identity via the `Sf-Context-Current-User` header; our session layer
  trusts that instead of Google OAuth.
- A warehouse-side migration discipline for the setup script (upgrades re-run
  it; `CREATE OR REPLACE` on data tables would wipe customer lookups).

**Cut from the native edition v1 (edition-gated, not deleted):**
- Google OAuth login, invitations + SMTP (`nodemailer`) — Snowflake owns
  identity; anyone the consumer grants the app role to is a user.
- Google Sheets pipelines and Sheets exports (`googleapis`) — would need a
  Google external access integration + OAuth consent; not worth v1 friction.
  CSV/Excel upload stays (no egress). CSV/Excel *download* exports stay.
- Sentry (already no-ops without a DSN — never set one here; outbound
  telemetry requires disclosure + consent).
- Redis / `auto-export-seen` (already optional).
- mssql / postgres / mysql backends (Snowflake-only edition).
- The credential half of `/setup` (steps 2–3), `workspace_config` Snowflake
  credentials, per-account `sf_*` personal credentials, and the
  `PRISM_ENCRYPTION_KEY` machinery for warehouse secrets. The personal-
  credential fallbacks (one-time flow, change-tracking auto-fix, column-mode
  provisioning) are replaced by the references/consent model — see §2.6.
- The "Prism-provided AI" env-key fallback (`ANTHROPIC_API_KEY` baked into a
  deployment). A vendor key inside a scanned container image is exactly the
  plaintext-secret pattern the security review rejects. Replacement: §2.4.
- `/debug`, `PRISM_DEBUG_TOOLS`, `PRISM_FRESH_SETUP` (never in this edition).

---

## 2. Design decisions

### 2.1 SETTLED — Same repo, edition switch, no fork
Decided in conversation 2026-08-12. The differences are mostly subtractive plus
a packaging shell; the shared core is where all ongoing work lands; parity
tests must keep covering both. Escalation path if the security scan or image
size ever forces it: npm-workspaces split (shared core package + two thin app
shells) *inside* this repo — never a second source tree.

### 2.2 SETTLED — Distribution mechanics
Snowflake Native App Framework, app-with-containers (SPCS). The UI/backend is
one containerized Next.js service — Streamlit cannot express this app. Only the
UI endpoint is public; Snowflake fronts it with its own authentication.
Versioning: application-package versions/patches, release channels (QA channel
→ default), release directives for rollout. Every externally-distributed
version/patch passes the automated security scan before release — hotfix
latency is hours, not seconds; plan release cadence accordingly.

### 2.3 SETTLED — Single-node service, by design
Prism requires exactly one instance (in-process poller, SSE broadcaster,
pipeline locks — same constraint as the standard edition's "one long-lived
Node process" rule). `MIN_NODES = 1`, documented as by-design in the listing.
Availability trade-off is accepted; it is identical to the standard edition's.

### 2.4 DECIDED (owner, 2026-08-12) — LLM: Cortex
**Decision: option A (Cortex).** The N0 grouping-quality spike is the
validation gate — a material quality regression on Cortex-served Claude
models reopens this in favor of option B. The options, for the record:
- **(A) Snowflake Cortex (recommended).** Declare `SNOWFLAKE.CORTEX_USER` in
  the manifest; call Cortex's REST/SQL COMPLETE interface as a fourth provider
  in the existing dispatch layer (`anthropic-key.ts` /
  `callAnthropicWithRetry` — the abstraction already exists for
  OpenAI/Gemini). Cortex serves Claude models in most regions, so the
  Claude-tuned prompts largely carry over. No egress, no keys, no external
  disclosure, billing lands on the consumer natively — which also fixes the
  "usage bills to Sanjiv" problem for this channel. Costs to verify in N0:
  model availability per region (cross-region inference as fallback),
  prompt-caching absence (the batching win documented in CLAUDE.md is
  Anthropic-API-only; treat Cortex like the non-Anthropic providers — low
  chunk concurrency), and JSON-output fidelity of the available models.
- **(B) Consumer-supplied Anthropic key** via a Snowflake SECRET + external
  access integration to `api.anthropic.com`, consumer-approved at install.
  Keeps the exact current code path and caching. Cost: the consent
  conversation is "your column values are sent to Anthropic" — real friction
  for a data-quality product — and every consumer needs their own Anthropic
  account.
- Not mutually exclusive long-term: A as default, B as an opt-in for
  customers who want their own key. But v1 ships ONE path (A).

### 2.5 DECIDED (owner, 2026-08-12) — App state: SQLite on a block volume
**Decision: SQLite on an SPCS block-storage volume (v1).** The N0
block-volume spike is the validation gate. The container filesystem is
ephemeral, so the SQLite file needs a durable mount; a block volume is the
one option that keeps `sqlite.ts` and its synchronous access pattern
untouched (a stage-mounted volume is not safe for SQLite locking).

"Everything in Snowflake" was considered and declined for v1 — not on
rewrite effort alone, but because app-state reads are constant (per-request
session checks, minute-mark poller reads, the tick's queue_size
short-circuit) and moving them into the warehouse breaks the idle-cost-zero
guarantee unless fronted by a new in-memory write-through cache layer;
regular Snowflake tables also enforce no constraints and are the wrong shape
for OLTP-style app state. The rewrite itself is ~2–3 weeks of async
conversion across every SQLite call site.

Recorded **escalation path (v2 candidate)**: migrate app state to **hybrid
tables** (Unistore) — the OLTP-shaped Snowflake option — if the block volume
proves problematic in practice, or immediately if the N0 spike finds block
volumes unsupported for app-with-containers in target regions (in which case
the plan grows by ~2–3 weeks; flagged in §6). Note the backup story changes
either way: today = cron-copy of the file; native = volume snapshots (or
table Time Travel).

### 2.6 SETTLED — Privileges and consent map onto the references model
The native edition's access model is *better* aligned with Prism's
consent-first design than the standard one, and the mapping is mechanical:

| Standard mechanism | Native equivalent |
|---|---|
| `PRISM_SERVICE` role + `grants.ts` + wizard Part D grant SQL | Manifest privileges + per-table **references** the consumer grants in the app's permission UI (SELECT + change-tracking on each source table) |
| `PRISM_DATA_ADMIN` human role | Application role (e.g. `APP_DATA_ADMIN`) granted by the consumer to their humans |
| `CREATE WAREHOUSE PRISM_WH` in `01_internal_tables.sql` | `CREATE WAREHOUSE` account-level privilege requested in the manifest; created post-install with the same AUTO_SUSPEND=60 discipline |
| Change-tracking auto-fix via creator's personal credentials | Consumer grants the reference with change tracking; no personal-credential path exists or is needed |
| Column-mode consent checkbox + `provisionColumnModeAccess` | Same UI consent, but the UPDATE/ALTER grant arrives as a reference grant on that table |
| One-time flow's personal-connection fallback ("tables the service can't see") | "Grant the app a reference to that table" — one consistent story |
| `PRISM_DB.INTERNAL` tables + UDF | Same objects in app-owned schemas, created by `setup.sql` (versioned schema for code, unversioned **state schema** for data tables so upgrades preserve them) |

### 2.7 SETTLED — Setup script is migration-style from day one
`01_internal_tables.sql` is written reset-style (`CREATE OR REPLACE TABLE`) —
correct for dev resets, catastrophic in an upgrade path. `native/setup.sql`
uses `CREATE TABLE IF NOT EXISTS` + version-aware idempotent `ALTER`s for the
data tables, and may only use `CREATE OR REPLACE` for stateless objects (UDF,
views, procedures). The framework guarantees upgrades are consecutive
(N → N+1 only), which keeps the migration chain simple — same append-only
philosophy as `sqlite.ts` migrations. This discipline is also owed to the
standard edition (DEPLOY.md's "warehouse-side schema changes are NOT automated
yet"); building it here should produce a shared mechanism, not a fork.

### 2.8 DECIDED (owner, 2026-08-12) — Pricing: $25 per 1,000 new distinct values, first 1,000 free
Usage-based pricing on the Marketplace listing via **Custom Event Billing**
(GA 2025-07): the app emits billable events through
`SYSTEM$CREATE_BILLING_EVENT(S)` — callable ONLY from a stored procedure
defined in the app's setup script, so `native/setup.sql` ships an
`EMIT_BILLING(count)` proc the Node service calls. Charges land on the
consumer's Snowflake bill; Snowflake takes a marketplace transaction fee
(verify current % in N0 — it shapes the margin math). With Cortex (§2.4) the
consumer already pays AI compute directly, so this revenue is near-pure
margin minus that fee.

**The billable unit — precision matters, this is what customers get charged
on:** one NEW row written to `LITERAL_ALIAS_MATCHES`, i.e. the first
confirmed mapping of a normalized value within a spec. Consequences of that
definition, all deliberate:
- Lookup re-hits, re-exports, and retried idempotent MERGEs are FREE — the
  meter counts **actual inserted rows reported by the MERGE**, never
  candidate counts (the batched MERGEs are idempotent upserts; a retry must
  not double-bill).
- Renames, group moves, and referee reversals of existing mappings: free.
- Deletes never decrement; a value deleted from the source and later
  re-standardized is not re-billed (its lookup row persisted).
- The same value standardized under two specs = two billable units (it is
  two standardizations; consistent with the per-spec lookup scoping).
- `llm_failed` / `needs_review` self-map singletons DO count once written —
  they are standardized rows. Acceptable because they're rare and reviewed;
  revisit if it ever feels wrong to a customer.
- **One-time standardizations count too** (metered at one-time export on the
  distinct exported values) — they never touch the lookup, but leaving them
  free would make the one-time flow a billing bypass.

**Free tier:** the first 1,000 cumulative billable units per installation,
lifetime, enforced in-app (no events emitted until the meter passes 1,000).
In-app enforcement (vs. the listing's trial feature) keeps the boundary
exact and lets the UI show "612 of 1,000 free values used".

**Metering architecture (shared core, not native-only):**
- `_lib/billing-meter.ts` — increments on every lookup-write path
  (`writeAllDecisions`, `commit-standardizations`, `runOpExportDirect`, the
  one-time export). The meter itself is edition-agnostic: the standard
  edition uses the same counter for contract invoicing (today there is NO
  usage rollup at all — see the existing "no per-workspace LLM usage rollup"
  deferred item; this subsumes it).
- The counter is **warehouse-side** (new `INTERNAL.BILLING_METER` table —
  cumulative count + an append-only ledger of emitted billing blocks). It
  must survive container/volume loss; SQLite may mirror it for display only.
  Ledger + emission in the same transaction scope gives effectively-once
  emission; events are batched (`SYSTEM$CREATE_BILLING_EVENTS`) to respect
  the per-minute frequency limits.
- A **usage surface in the UI** (Settings → Usage: values standardized,
  free-tier remaining, current month's billable count) — customers being
  charged per unit must be able to see the meter; this prevents disputes and
  is likely a listing-review expectation anyway.

---

## 3. New state & artifacts

- `native/manifest.yml` — privileges (`CREATE WAREHOUSE`,
  `CREATE COMPUTE POOL`, `BIND SERVICE ENDPOINT`, `SNOWFLAKE.CORTEX_USER` if
  §2.4=A), reference definitions (source tables: SELECT + change tracking;
  column-mode tables: + UPDATE/ALTER... exact privilege set fixed in N3),
  version metadata, ingress endpoint declaration.
- `native/setup.sql` — application roles, versioned code schema, unversioned
  state schema (the INTERNAL tables + UDF + `BILLING_METER`),
  post-install/upgrade callbacks (create compute pool + warehouse,
  start/upgrade the service), and the `EMIT_BILLING` stored procedure
  wrapping `SYSTEM$CREATE_BILLING_EVENTS` (§2.8).
- `native/service-spec.yaml` — the Prism container, block volume mount
  (§2.5), ingress endpoint, `MIN_NODES=1`.
- `native/Dockerfile` — Next.js standalone build. Note `xlsx` resolves from
  `cdn.sheetjs.com` at `npm ci` time: build-time egress only; vendor the
  tarball if the build environment is locked down.
- `native/release.sh` — build → push to image repo → `ALTER APPLICATION
  PACKAGE … ADD PATCH` → (scan) → release-directive/channel promotion.
- `stand-ui`: `PRISM_EDITION` in `_lib/env.ts`; SPCS auth tier in
  `warehouse/snowflake/connection.ts`; header-based session mode in
  `session.ts`/`account-security.ts`; edition gates at the cut surfaces (§1);
  `_lib/billing-meter.ts` + the Settings → Usage surface (§2.8 — shared
  core, both editions).
- New SQLite migration: none expected v1 (accounts table gains rows keyed on
  Snowflake usernames instead of Google IDs — reuse `google_id` column
  semantics or add `sf_username`; decide in N2, keep it one migration).

---

## 4. Phases

Estimates are engineering time, excluding Snowflake review latency (which is
calendar time in N5/N6). Total ≈ 6–9 weeks of build.

### Phase N0 — Validation spikes + accounts · ~0.5–1 wk
- Validate the two decided calls (§2.4 Cortex, §2.5 block volume) with their
  spikes — a failed spike reopens the corresponding decision:
  1. **Cortex grouping-quality spike**: run the existing chunk+merge prompts
     through Cortex COMPLETE (Claude model) on a known dataset (the E2E test
     plan fixtures); compare group quality + JSON validity against the
     production path.
  2. **Block-volume spike**: confirm app-with-containers block-volume support
     in target regions; measure SQLite behavior on it.
- Set up: Marketplace provider profile on the org; a second Snowflake account
  as the test consumer; accept provider terms (paid-listing terms included);
  confirm the current marketplace transaction fee % for the §2.8 margin math.
- Read the current Native App + SPCS docs end-to-end once (they move fast;
  this plan records intent, the docs are authoritative on syntax).
- **Exit criteria:** both spikes pass (or the affected decision is reopened
  and re-settled in §2); provider profile live; test-consumer account
  reachable.

### Phase N1 — Edition switch + containerization · ~1 wk · **BUILT 2026-08-12, live lifecycle test pending**
- `PRISM_EDITION` predicate; gate every §1 cut surface. Standard edition
  behavior must be byte-identical when the flag is absent (default
  `'standard'`).
- Dockerfile; image runs locally via `docker run` with env-var credentials
  (the standard env tier — no SPCS dependency yet), SQLite on a mounted
  volume, poller + tick alive, warehouse pinned to snowflake.
- CI-ish check: `npm run build` + parity suite green in both editions.
- **Exit criteria:** full lifecycle (connect → baseline review → activate →
  poller detect → tick standardize → export) against the dev Snowflake
  account, running entirely inside the local container. Standard-edition
  regression: `test:parity` + a normal dev-server smoke pass unchanged.

### Phase N2 — SPCS hosting (bare, not yet a Native App) · ~1.5–2 wk · **LIVE-VERIFIED 2026-08-13 (core); tail items open**

**Verified live in the dev account:** service running in SPCS (`PRISM_APP` on
`PRISM_POOL`, image via `PRISM_IMAGES` repo); ambient-token warehouse auth
end-to-end (reads, writes, stream creation, export CREATE TABLE — zero
configured credentials); `Sf-Context-Current-User` → cookie bootstrap with
auto-provisioning + admin bootstrap; block-volume SQLite surviving container
replacement (twice — the §2.5 spike is answered YES); full pipeline
lifecycle through the ingress incl. LLM grouping (59 mappings, 30-row export
on the demo table). **Found + fixed live:** the /home setup gate didn't
recognize the `'spcs'` source; the invite button rendered in native;
**LLM egress needs an External Access Integration** (SPCS has no default
outbound — network rule + `PRISM_ANTHROPIC_EAI` now in `spcs-dev-setup.sql`;
this is interim scaffolding that §2.4's Cortex decision removes).
**Also verified (2026-08-13):** SSE Live pulse through the ingress; the
insert→minute-mark-detect→10-minute-tick standardize flow; the formal
suspend/resume drill (service stops fully, resumes READY in ~12 s, poller +
tick restart, state intact). **The one open exit item: second-user role
check** (a different Snowflake user arrives as 'user', not admin). Service +
pool left SUSPENDED after testing — resume with
`ALTER SERVICE PRISM_DB.INTERNAL.PRISM_APP RESUME` (pool auto-resumes).
Run the image as a hand-created SPCS service in the dev account first —
isolates SPCS problems from Native-App-packaging problems.
- Image repo push; compute pool; service with ingress endpoint + block volume.
- Ambient-auth tier in `connection.ts` (token file + `SNOWFLAKE_HOST`,
  `authenticator: OAUTH`); `serviceConnectionSource()` learns `'spcs'`.
- Session layer: trust `Sf-Context-Current-User` from ingress; map to
  `accounts` rows (auto-provision on first sight; first user = admin, or
  admin = holder of an admin application role — decide here); role checks
  (`requireAdminSession` etc.) unchanged above the session boundary.
- Verify SSE through the ingress proxy (buffering/timeout behavior); verify
  the poller's clock-aligned loops behave under SPCS restarts (block volume
  remount → SQLite intact → poller resumes cleanly).
- **Exit criteria:** the Phase-N1 lifecycle repeated entirely through the
  SPCS ingress URL with zero configured credentials (ambient auth only),
  two distinct Snowflake users seeing correct roles; service survives a
  suspend/resume with state intact.

### Phase N3 — Native App packaging · ~2–3 wk (the long pole)
- Write `manifest.yml` + `setup.sql` + callbacks per §2.6/§2.7/§3; translate
  `01_internal_tables.sql` object-by-object (keep a checklist; every table,
  the UDF, grants → application roles).
- References flow end-to-end: the app requests a reference for a source
  table; consumer grants it in the permission UI; `create-initial-run` +
  poller create the stream on the referenced table. Rework the connect form's
  table picker to enumerate granted references instead of INFORMATION_SCHEMA
  browsing. Column-mode consent → reference with UPDATE/ALTER.
- First-run experience replaces the credential wizard: choose LLM
  (or nothing to choose, if §2.4=A), grant references, done.
- **Metering + billing (§2.8):** the shared `billing-meter.ts` on every
  lookup-write path (MERGE-reported insert counts — build this early in the
  phase; it's edition-agnostic and the standard edition wants it for
  invoicing regardless), the `BILLING_METER` table + emission ledger, the
  `EMIT_BILLING` proc, free-tier gate, and the Settings → Usage surface.
  Verify emitted events appear in the provider's billing-event views from
  the test-consumer install.
- Install as a private app (`DISTRIBUTION=INTERNAL`) in the dev account, then
  in the test-consumer account from a listing share.
- **Exit criteria (the port-plan-style lifecycle test, run in the TEST
  CONSUMER account):** fresh install from the package → grant references →
  full pipeline lifecycle on a consumer table incl. delete-hygiene rebuild
  and an export table + lookup export; one-time flow on an uploaded CSV;
  uninstall leaves no orphaned account-level objects. Billing: the meter
  matches hand-counted new distinct values across the lifecycle (incl. a
  re-export and a retry proving no double-billing), the free-tier boundary
  triggers at exactly 1,000, and events past it land in the provider views.

### Phase N4 — Upgrade path + warehouse migrations · ~1 wk
- Migration-style setup script proven: install v1.0 → create real pipeline
  data → publish v1.1 with a schema change (add a column to an INTERNAL
  table) → upgrade → data intact, poller resumes, no re-consent needed.
- Failed-upgrade drill: a deliberately broken v1.2 setup script — confirm the
  framework's rollback leaves v1.1 functional.
- Container-image update drill: new image in a patch → service upgraded via
  the upgrade callback.
- Write `native/RELEASING.md`: the patch/version/channel/directive cadence,
  the two-active-versions constraint, expected scan latency, and the
  hotfix-is-hours reality.
- **Exit criteria:** all three drills pass in the test-consumer account.

### Phase N5 — Security-review readiness + private listing · ~1–1.5 wk build + review calendar time
- Dependency pass: prune `googleapis`, `nodemailer`, `mssql`, `pg`, `mysql2`,
  `ioredis` from the native image if feasible without the workspaces refactor
  (dynamic imports / build-time exclusion); `npm audit` clean of
  critical/high; hardened minimal base image; no secrets in image or stage
  artifacts (scrub `rsa_key.p8`-style files from build context — it's in the
  repo root today).
- Disclosure docs: update `SECURITY_AND_DISCLOSURES.md` with the native
  edition's data flows (Cortex stays in-account — a genuinely better story;
  or the Anthropic egress disclosure if §2.4=B); README with setup steps,
  privileges, references, SQL examples per listing requirements.
- Flip `DISTRIBUTION=EXTERNAL` → automated security scan → fix findings →
  submit for Marketplace Operations functional review as a **private
  listing** first.
- Install the private listing with 1–2 design-partner accounts; run the
  PRELAUNCH_CHECKLIST.md disciplines that apply (column mode §1 especially,
  if column mode ships in native v1 — consider deferring column mode to a
  native v1.1 to shrink the review surface).
- **Exit criteria:** scan passed; private listing installed and used by a
  real external account for ≥1 week without provider intervention.

### Phase N6 — Public Marketplace listing · calendar-gated
- Listing content (copy, screenshots, categories, support contact) and the
  **usage-based pricing plan per §2.8**: the billable-event class priced at
  $25 per 1,000-value block, free tier stated plainly in the listing copy
  (customers must understand the unit BEFORE install — "new distinct value,
  first standardization only, re-encounters free" is the pitch as much as
  the meter). QA release channel wired as the staging path for all future
  releases.
- **Exit criteria:** listing live; one full patch release shipped through
  QA-channel → default-channel after going live (proves the update loop);
  first real billing cycle reconciles — provider-side revenue reporting
  matches the app's own meter for at least one paying consumer.

---

## 5. Standard → Native translation reference

| Concern | Standard edition | Native edition |
|---|---|---|
| Hosting | VPS + Caddy + systemd (`deploy/`) | SPCS service, 1 node, in consumer account |
| Deploy/update | `deploy.sh` rsync per instance | image push + package patch + release directive; auto-rollout to ALL consumers |
| Snowflake auth | workspace creds / env (password or JWT) | ambient OAuth token file |
| User auth | Google OAuth + invitations | Snowflake ingress (`Sf-Context-Current-User`) + application roles |
| Install SQL | admin copy-pastes `00`/`01` in a worksheet | `setup.sql` runs automatically at install/upgrade |
| Source-table access | Part D GRANT sql run by admin | per-table references granted in permission UI |
| Warehouse | `CREATE WAREHOUSE` in `01` | manifest privilege + post-install callback |
| LLM | workspace key / env fallback | Cortex (or SECRET + external access) |
| App state | SQLite on VPS disk + cron backup | SQLite on block volume + snapshots (§2.5) |
| Secrets at rest | `PRISM_ENCRYPTION_KEY` AES-GCM | mostly obsolete (no warehouse creds, no Google tokens); keep for any residual secret |
| Error telemetry | Sentry (optional) | none (disclosure cost) |
| Emergency fix latency | minutes | hours (scan + rollout) |
| Multi-warehouse | snowflake/mssql/pg/mysql | snowflake only |

## 6. Risks and open questions

- **Cortex model/prompt parity** (§2.4 spike): if grouping quality on
  Cortex-served Claude models regresses materially, option B's consent
  friction becomes the price of quality. Also: no prompt caching on Cortex —
  cost model per run changes; measure in the spike.
- **Block volumes for app-with-containers** (§2.5 spike): if
  unsupported/regionally gated, the app-tables migration is ~2 extra weeks
  and touches every synchronous SQLite call site. This is the biggest
  schedule risk.
- **SSE through SPCS ingress**: proxies sometimes buffer event streams.
  Fallback if broken: poll-based refetch (the client already refetches on a
  30 s clock for relative timestamps).
- **Region availability**: consumer regions without SPCS or without the
  chosen Cortex model can't install/run — set listing region availability
  accordingly; consider cross-region inference for Cortex gaps.
- **Scan latency on hotfixes** is structural (§2.2). Mitigation is process:
  QA channel always warm, small frequent patches, never batch risky changes.
- **References UX at scale**: a customer with 50 source tables grants 50
  references. Verify the permission SDK's bulk ergonomics in N3; may shape
  whether we request a schema-level reference instead.
- **Repo hygiene before any packaging**: `rsa_key.p8`/`rsa_key.pub` sit in
  the repo root and must never reach a build context or stage; and the
  current branch's commit backlog should land before `native/` work starts.
- **Billing correctness is a trust cliff** (§2.8): a double-billing bug is
  worse than any functional bug — hence MERGE-reported insert counts only,
  the append-only emission ledger, and the N3 exit criterion reconciling the
  meter against hand counts. Also verify in N3: `SYSTEM$CREATE_BILLING_EVENTS`
  frequency limits + proc-only call path under the app's restricted caller
  context, and how mid-cycle uninstalls affect emitted-but-unbilled events.
- **Pricing-model portability**: the standard edition should bill on the SAME
  meter definition ($25/1,000, first 1,000 free) so the two editions never
  quote different numbers for the same work — the shared `billing-meter.ts`
  is the single source of that count; standard-edition invoicing reads it
  (no Snowflake billing events there).
- **Marketplace review is a moving target**: requirements (scan rules,
  container policies) update frequently; re-read the listing requirements at
  N5 start rather than trusting this document.

## 7. Definition of done

A consumer with zero prior contact can: find the listing → install → grant
references and (if applicable) approve the LLM path → review a baseline → run
live pipelines with exports in their own account — with no credentials ever
typed into Prism, no external UI, provider updates arriving automatically
through release directives, and usage-based charges ($25 per 1,000 new
distinct values after the first free 1,000) landing on their Snowflake bill
from a meter they can inspect in the app. The standard edition's behavior and test suite
remain byte-for-byte unaffected by every commit the native edition adds.
