# Setup, Accounts, Settings & Deployment

The `/setup` onboarding flow, auth/session rules, the top-level pages, and how Prism is
deployed. Read before touching onboarding, auth, or the deploy path.

---

## Accounts & Auth

- Google OAuth — default authentication (no passwords). OAuth `returnTo` is sanitized to relative paths only (`sanitizeReturnTo`).
- **Terms acceptance (clickwrap, 2026-08-11):** every account must explicitly accept the current terms once before using the app. `CURRENT_TERMS_VERSION` (`_lib/terms-version.ts`, pure module) is the single source of truth — bump it when `/terms`/`/privacy` materially change to re-prompt everyone. Acceptance is recorded on `accounts.terms_accepted_version` + `terms_accepted_at` (migration 017; NULL = never accepted). Two gates route un-accepted accounts to the `/accept-terms` interstitial (checkbox + "Agree and continue" → `POST /api/accounts/accept-terms`, `requireValidSession`): the OAuth callback (every sign-in, including brand-new accounts — terms come before the setup wizard) and the `/home` server component (backstop for sessions predating the feature or a version bump). The login page's "By signing in you agree" line remains as a complement, but the recorded acceptance is the real consent.
- All users in a company share one installation (no per-user data restriction at launch)
- First user to authenticate becomes account owner (`admin` role); `ADMIN_EMAIL` bootstraps the admin
- Invitations expire after 7 days; statuses: `pending` | `accepted` | `revoked`
- Roles: `admin` | `user`

### Sessions & revocation

- The HMAC-signed session cookie (`prism_session`) carries `v` (session version) and `exp` (7-day TTL; missing/expired ⇒ rejected). Cookies get `Secure` in production.
- `accounts.session_version` (SQLite) is the revocation switch: `_lib/account-security.ts` provides `requireAdminSession` / `requireValidSession` / `bumpSessionVersion`. The check is a local SQLite read — **no cache, runs on every request**, so revocation is effectively instant. A version mismatch or missing account fails closed.
- **Every API route is version-checked**: `proxy.ts` validates only the cookie signature/expiry; each route handler calls `requireValidSession` / `requireAdminSession` (the 2026-07 revocation sweep converted all bare-`decodeSession` routes and added guards to previously guard-less ones like `run/*`). **New routes MUST use these guards, not bare `decodeSession`.**
- Member management APIs: `GET /api/accounts/members`, `PATCH` / `DELETE /api/accounts/members/[account_id]` — with **last-admin** and **self-delete** guards. Removing a user or demoting an admin bumps their `session_version`, killing their live sessions immediately.

### Error hygiene

Warehouse error responses to clients are sanitized — no raw SQL or driver messages leak to
the browser.

### Security & disclosures

`docs/SECURITY_AND_DISCLOSURES.md` is the reviewed map of roles, credential storage, data
flows that leave the customer's control (AI provider, Google, exports), and where each
user-facing disclosure lives (login, setup steps, settings, invite/accept-invite, connect
forms, one-time flow). When adding an access path or changing what a credential is used for,
update BOTH the relevant UI disclosure and that document — the personal-credentials copy
went stale once when the change-tracking auto-fix started using them.

---

## The `/setup` card

The OAuth callback sends **every** new account here (not just admins), gated by role
client-side once the session resolves (a loading state prevents a flash of the wrong copy).

### Admins — the guided onboarding flow

On load it tests the current service connection (`GET /api/accounts/test-snowflake` —
workspace-config-aware); if healthy, "Continue with existing connection" is the fast path
(with links to "Verify the install" / "Set up a different connection"). Otherwise a 5-step
flow:

1. **Warehouse-platform picker** — Snowflake or Microsoft SQL Server; the choice persists to `workspace_config.warehouse_type` (`POST /api/accounts/warehouse-type`) and drives the adapter factory. Choosing SQL Server swaps steps 2/3/5 for their mssql variants (`StepInstallScriptMssql` serving `01_internal_tables.mssql.sql` + service-login/Change-Tracking templates; `StepCredentialsMssql` → `POST /api/accounts/workspace-mssql`, which live-tests before saving and asserts the platform choice; verify-install runs catalog-view probes). Non-admins on mssql installs get an mssql personal-credentials variant (`/api/accounts/mssql-config`).
2. **Display the install SQL** — `GET /api/accounts/install-script` reads `00_bootstrap.sql` + `01_internal_tables.sql` from the repo root, one level above `process.cwd()`; graceful message if not shipped — plus templated key-pair `openssl` commands and a `CREATE USER PRISM_SVC … TYPE = SERVICE` + `ALTER USER … SET RSA_PUBLIC_KEY` block (the install scripts create roles but NOT the service user). The admin runs all of it themselves in a Snowflake worksheet as ACCOUNTADMIN, so admin credentials are never typed into Prism.
   **Part D (added 2026-07-22)**: the admin types the DB.SCHEMA(s) holding their source tables and `buildDataAccessGrants` generates the copy-paste grants — USAGE on db+schema, SELECT on all/future tables, and CREATE TABLE + **CREATE VIEW** (the missing-CREATE-VIEW failure used to surface only at view-pipeline activation); the generated SQL grants **no write access on existing tables** and states so — "Column"-mode UPDATE is granted per table, case-by-case, at consent time (see SECURITY_AND_DISCLOSURES §1).
   The step's Continue button runs a **best-effort spot check** (`verify-install?scope=snowflake`, Anthropic probe skipped): no resolvable connection or a network failure → pass through silently (a fresh install has no credentials until the next step; step 5 is the authoritative gate); connected but install objects missing → red panel with the missing items + "Continue anyway".
3. **Enter the service user's credentials** — `POST /api/accounts/workspace-snowflake` (admin-only) connection-tests them and only then saves to `workspace_config` (encrypted; typing no secret keeps the stored one; `{clear:true}` reverts to env). **Env-adopt convenience:** the GET prefills every non-secret field from the saved row falling back to env, and a save with a BLANK secret adopts, in order, the saved secret → the env secret (`getEnvSnowflakeSecrets`) — secrets are never sent to the browser, only `has_env_secret` is.
4. **AI-provider picker + credential** — Claude (Anthropic, recommended), OpenAI (API key), or Gemini (Google AI Studio key); Prism pins the model per provider (GPT-4.1 / Gemini Flash). `POST /api/accounts/llm-provider` validates the credential live before saving (a blank Anthropic key adopts the env `ANTHROPIC_API_KEY`; no env path for the other providers; skippable when a provider already resolves).
5. **Verification checklist** — `GET /api/accounts/verify-install` (admin-only) connects as the service user and runs **metadata-layer-only** Snowflake probes (`SHOW DATABASES/SCHEMAS/TABLES/USER FUNCTIONS/WAREHOUSES`, scalar `CURRENT_ROLE()`; never wakes a warehouse): role identity, database + schemas, the 6 internal tables (visibility ⇒ grants ran), `PRISM_NORMALIZE`, warehouse existence + `AUTO_SUSPEND` ≤ 60 warning, plus an Anthropic-key check (live `/v1/models` call; network failure ⇒ warning not red). Red items carry fix text ("re-run the script as ACCOUNTADMIN"); "Finish anyway" is allowed.

The old admin path through `snowflake-config` + `applyGrants` remains available from
`/settings`.

**Setup gate on `/home`** (`app/home/page.tsx`, a server component wrapping the client
`AutoExportHome`): admins are redirected to `/setup?next=/home` while the workspace has no
resolvable service connection OR no Anthropic key (`serviceConnectionSource()` /
`anthropicKeySource()`); non-admins pass through (the personal `/setup` variant can't fix a
workspace-level gap). Under `PRISM_FRESH_SETUP` the gate ignores env credentials, so the
simulation stays consistent until the flow saves workspace rows.

### Regular users — the personal-connection variant

A distinct, explicitly optional variant ("(optional)" tag in the heading, copy explaining
it's only needed later for one-time standardizations Prism can't otherwise see) with a
**"Skip for now"** button always available (not gated on env status, since it's irrelevant to
them). Role/warehouse fields default empty instead of `PRISM_SERVICE`/`PRISM_WH` (those are
the service identity's objects). Saving here calls the same `snowflake-config` POST but never
triggers the grants pass.

### Shared behaviours

- The account identifier is **prefilled from the workspace's saved config, falling back to the `SNOWFLAKE_ACCOUNT` env value** (`GET /api/accounts/test-snowflake` returns it) — there is one Snowflake account per workspace, so a member connecting personal credentials only ever needs to type their own username + credential, never the account.
- `GET /api/accounts/test-snowflake` also returns `role` (`CURRENT_ROLE()` from a live connection) — a diagnostic surfaced in the admin banner ("...running as role X") for verifying the service connection is actually activating the intended role, not silently falling back to something else.
- **Test connection is credential-smart**: `POST /api/accounts/test-snowflake` falls back to the account's SAVED (encrypted) credentials when no secret is typed — decrypted server-side only; typed non-secret fields override saved ones. Saving without typing a secret keeps the stored secret (change warehouse/role without re-pasting the key).
- **`snowflake-config` POST is `requireValidSession` (not admin-only)** — any member may save credentials to their own account row. The grants-application pass only runs when `session.role === 'admin'`; a non-admin save returns `{ ok: true, grants: null }` immediately.

---

## Other top-level pages

- **`/settings`** (admin-role-gated via `requireAdminSession`; `UserMenu` shows the Settings item for admins only): three sections —
  1. **Snowflake connection** — status, test connection, save credentials (+ applies grants; some grants require ACCOUNTADMIN and must be run manually)
  2. **Team** — member list, role changes, remove member, invite link (last-admin/self-delete guards enforced by the members API)
  3. **Pipeline health** — rollup of all pipelines' status/`status_message`
- **`/debug`** (gated by `PRISM_DEBUG_TOOLS === 'true'`, otherwise `notFound()` → 404): table inspector for operators. `/api/admin/table/[tableName]` is gated identically. Never enabled in customer installs.
- **`/terms`** and **`/privacy`** — placeholder legal text (pending counsel review), linked from the login page.
- **`/`** redirects to `/home`.

---

## Long-form environment-variable notes

The full variable table is in CLAUDE.md; these two carry enough behaviour to need prose.

### `PRISM_EDITION` / `NEXT_PUBLIC_PRISM_EDITION`

Product edition switch (`_lib/edition.ts`, pure module — client-safe): `standard` (default;
both vars absent = byte-identical standard behavior) or `native` (the Snowflake Marketplace
Native App build — see `docs/NATIVE_APP_PLAN.md` and `native/`).

Native pins the warehouse adapter to Snowflake (stored/env types ignored), 403s + hides all
Google Sheets surfaces and email invitations, force-disables Sentry in all three runtimes,
and hard-disables `/debug` + `/api/admin/table` regardless of `PRISM_DEBUG_TOOLS`. Set at
build time by `native/Dockerfile` (the `NEXT_PUBLIC_` var is what client bundles see — both
must be set together). Server routes are the authoritative gates; client hiding is cosmetic.

In native, the facade's "user connection" (`withUserWarehouse` / `hasUserWarehouseConfig`) is
an SPCS **caller's-rights session** (request's `Sf-Context-Current-User-Token` dot-joined onto
the service token) instead of saved personal credentials — see NATIVE_APP_PLAN.md §2.9;
`hasUserWarehouseConfig` is async facade-wide for this (**always await it** — an un-awaited
Promise is truthy).

Native `/setup` renders `NativeSetup` ("Prism is ready") instead of the credential wizard:
a database picker, one mandatory grant block built by `buildNativeSetupSql`
(`app/components/native-grant-sql.ts` — AI starter when needed, caller-grant opt-in,
per-database app grants + change tracking, and the hourly `PRISM_GRANT_REFRESH` task, all in
one paste) under "Run this as ACCOUNTADMIN to give Prism access to your tables.", plus a
collapsed "What this does and the permissions it needs" guide listing each section's line
range, purpose and least-privileged role (`buildNativeSetupSqlGuide`). Details and the
decision history: `docs/NATIVE_APP_PLAN.md` → Phase N3 "First-run experience".

### `PRISM_FRESH_SETUP`

Dev-only — `'true'` simulates a bare customer install everywhere setup-facing
(`isFreshSetupSim()` in `_lib/env.ts`): the `/setup` entry check reports not connected, the
`/home` gate, `verify-install`, and both status GETs treat env credentials/key as absent,
env-based form prefills are suppressed, and blank-save env adoption is disabled. Workspace
rows saved during the walkthrough are real state and show through.

The REAL service connection and LLM key resolution (`withWarehouse` / `getAnthropicApiKey`)
are never affected — pipelines keep running. Never set in customer installs.

---

## Observability

Sentry is wired via `instrumentation.ts` (server), `instrumentation-client.ts` (client), and
`app/global-error.tsx` (root error boundary) — all env-gated by `SENTRY_DSN` /
`NEXT_PUBLIC_SENTRY_DSN` and fully no-op when unset. Use the `reportError(err, context)`
helper (`_lib/report-error.ts`) instead of bare `console.error` in new code: it always
console-logs, forwards to Sentry when configured, and never throws.

---

## Deployment Model

- **Production instance:** prismmasterdata.com on a DigitalOcean droplet (167.99.235.20). Update with `deploy/deploy.sh <ip>` (rsync → `npm ci` → build → systemd restart; see `deploy/DEPLOY.md`). The script typechecks on the operator machine first and sets `PRISM_SKIP_BUILD_TYPECHECK` server-side (the 2 GB droplet OOM-kills the build's TS pass). The prod env carries NO warehouse or AI credentials — both are wizard-configured (workspace rows). Cloudflare DNS must stay **DNS-only, never proxied** (proxying breaks SSE and Caddy's TLS issuance). The Google OAuth app is published but unverified (consent screen shows the warning until verification).
- **The SQLite file (`PRISM_SQLITE_PATH`) must live on persistent storage** — losing it loses accounts, column specs, and run/pipeline metadata (never customer values: confirmed mappings, run state blobs, and the validation log are all in the customer's warehouse).
- **One long-lived Node process per installation is REQUIRED.** The poller loops, per-pipeline locks, and the SSE broadcaster are all in-process — serverless/multi-instance deployments break them. Deploy as a single persistent `next start` (or equivalent) process.
- **Single-tenant:** one deployment + one customer warehouse account per company. There is no cross-tenant isolation inside the app.
- **`xlsx` is installed from `cdn.sheetjs.com`** (pinned `0.20.3` tarball in `package.json`) — `npm install` may need network access to that host.
