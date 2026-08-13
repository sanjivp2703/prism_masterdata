# Prism — native (Snowflake Marketplace) edition

Packaging for the Snowflake Native App edition. Plan: `docs/NATIVE_APP_PLAN.md`.
Phase N1 ships the edition switch + this container; SPCS hosting (N2) and the
application package (`manifest.yml` / `setup.sql`, N3) land here later.

## What the edition switch does

`PRISM_EDITION=native` (+ `NEXT_PUBLIC_PRISM_EDITION=native` for the client
bundle — the Dockerfile bakes both) flips the app into the Marketplace build:

- Warehouse pinned to **Snowflake** — `getWarehouseAdapter()` ignores the
  stored/env warehouse type; the setup picker shows only Snowflake; the
  warehouse-type API refuses anything else.
- **Google Sheets surfaces off** (server-guarded 403 + hidden in UI): the
  one-time Google Sheet source, `/api/sheets/*`, the run export-to-sheets, and
  the lookup export's Sheets format. CSV/Excel upload/download stay.
- **Email invitations off** (Snowflake will own membership from N2).
- **Sentry force-disabled** (no outbound telemetry), all three runtimes.
- **Debug tools hard-off** (`/debug`, `/api/admin/table`) regardless of env.

Unset (the default), behavior is byte-identical to the standard edition.

## Build

From the repo root (context is `stand-ui/` — `stand-ui/.dockerignore` keeps
env files, the SQLite DB, and logs out of the image):

```bash
docker build -f native/Dockerfile -t prism-native stand-ui
```

`npm ci` inside the build needs `registry.npmjs.org` and `cdn.sheetjs.com`
(pinned xlsx tarball).

## Run (N1 — local, env-tier credentials)

SPCS ambient auth is N2; for now the container authenticates like the standard
env tier. Create `native/dev.env` (gitignored — never commit):

```bash
SESSION_SECRET=...            # openssl rand -hex 32
PRISM_ENCRYPTION_KEY=...      # openssl rand -hex 32
ADMIN_EMAIL=you@company.com
APP_URL=http://localhost:8000
GOOGLE_CLIENT_ID=...          # login only in N1 (replaced by Snowflake auth in N2)
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:8000/api/auth/google/callback
SNOWFLAKE_ACCOUNT=...
SNOWFLAKE_USER=...
SNOWFLAKE_WAREHOUSE=PRISM_WH
SNOWFLAKE_PRIVATE_KEY_PATH=/run/secrets/rsa_key.p8   # mount it read-only
ANTHROPIC_API_KEY=...         # until Cortex (N-later)
```

```bash
docker run --rm -p 8000:8000 \
  -v prism-data:/data \
  -v "$PWD/rsa_key.p8":/run/secrets/rsa_key.p8:ro \
  --env-file native/dev.env \
  prism-native
```

`/data` (named volume) holds the SQLite app state — `PRISM_SQLITE_PATH` is
preset to `/data/prism.db`. Destroying the container keeps state; destroying
the volume is the reset.

## N2 — SPCS hosting (bare service, dev account)

Code side (shipped): the connection layer gained tier 0 — inside SPCS,
`spcsAmbientAvailable()` detects the platform token (`/snowflake/session/token`
+ `SNOWFLAKE_HOST`), connections authenticate with it (`authenticator: OAUTH`,
token re-read fresh per connection because it rotates), and
`serviceConnectionSource()` reports `'spcs'`. User auth: SPCS ingress
authenticates the browser against Snowflake and injects
`Sf-Context-Current-User`; `proxy.ts` bounces cookie-less requests to
`GET /api/auth/spcs`, which verifies the SPCS environment (never trusts the
header alone), auto-provisions an account per Snowflake username
(`accounts.sf_username`, migration 020; first account = admin), and issues the
normal session cookie — guards, terms gate, and revocation all work unchanged.
Local docker runs keep Google login (no header, no SPCS → normal flow).

Deploy to the dev account:

```bash
# 1. Registry + pool + stage (as ACCOUNTADMIN, snowsql):
snowsql -f native/spcs-dev-setup.sql          # note the repository_url it prints
# 2. Push the image (Apple Silicon: script forces linux/amd64):
docker login <registry-host> -u <snowflake-user>
bash native/push.sh <repository_url>
# 3. Upload the spec + create the service (see spcs-dev-setup.sql comments):
#    PUT file://native/service-spec.yaml @PRISM_DB.INTERNAL.NATIVE_ARTIFACTS ...
#    CREATE SERVICE ... ; SHOW ENDPOINTS IN SERVICE ... → ingress URL
```

Set real values for `SESSION_SECRET` / `PRISM_ENCRYPTION_KEY` /
`ANTHROPIC_API_KEY` in the spec before `CREATE SERVICE` (N3 moves these to
proper Snowflake secrets).

### N2 exit checklist

- [ ] Full lifecycle through the SPCS ingress URL with ZERO configured
      Snowflake credentials (ambient token only).
- [ ] Two different Snowflake users open the app; first is admin, second is
      user; roles display correctly.
- [ ] SSE works through the ingress (Live pulse + standardizing states).
- [ ] `ALTER SERVICE … SUSPEND` / `RESUME`: SQLite state intact on the block
      volume, poller resumes, pipelines keep working.

## N1 exit checklist

- [ ] Full lifecycle inside the container against the dev Snowflake account:
      connect → baseline review → activate → poller detects an insert →
      10-minute tick standardizes → export table updates.
- [ ] Container restart with the volume: pipelines resume, no re-onboarding.
- [ ] Standard edition unaffected: `npm run test:parity` + `npm run build`
      green with no `PRISM_EDITION` set.
