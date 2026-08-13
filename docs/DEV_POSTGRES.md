# Local PostgreSQL dev environment

The Postgres analog of `docs/DEV_MSSQL.md` — a disposable container for
developing and live-testing the postgres warehouse adapter
(docs/POSTGRES_PORT_PLAN.md).

## 1. Container

```bash
docker run -d --name prism-pg \
  -e POSTGRES_PASSWORD='PrismDev!Passw0rd' \
  -p 5432:5432 \
  postgres:16
```

Native on Apple Silicon (official multi-arch image — no Rosetta needed,
unlike the SQL Server container). Data is inside the container; `docker rm -f
prism-pg` fully resets the environment.

The version floor is Postgres 13 — to validate against it:
`docker run -d --name prism-pg13 -e POSTGRES_PASSWORD=… -p 5433:5432 postgres:13`.

## 2. Install the Prism schema + demo data

```bash
cd stand-ui
PG_ADMIN_PASSWORD='PrismDev!Passw0rd' npm run pg:install
```

Creates the `prism_dev` database (override with `PG_DATABASE`), the
`prism_internal` + `prism_exports` schemas, the six data-plane tables, the
`prism_*` roles, and the `test_sources.raw_mobile_carriers_short` demo table.
Re-running resets the warehouse side (DROP + CREATE — dev-reset semantics).

The dev service login (created by the live test setup, or by hand):

```sql
CREATE ROLE prism_svc LOGIN PASSWORD 'PrismSvc!Dev1';
GRANT prism_service TO prism_svc;
ALTER ROLE prism_svc SET statement_timeout = '600s';
```

## 3. Point the app / tests at it

`.env.local` (or inline for scripts):

```bash
PRISM_WAREHOUSE_TYPE=postgres
PG_HOST=localhost
PG_DATABASE=prism_dev
PG_USER=prism_svc
PG_PASSWORD='PrismSvc!Dev1'
# PG_SSLMODE defaults to 'disable' — right for the local container; managed
# providers need 'require' (or 'verify-full' + PG_SSL_CA_PATH).
```

## 4. Live suites

```bash
PG_ADMIN_PASSWORD='PrismDev!Passw0rd' npm run test:pg-live   # Phase P1 exit criteria
```

(Phase P2/P3/P4 suites — `test:pg-detection`, `test:pg-lifecycle`,
`test:pg-setup` — follow the same pattern as the mssql ones.)

## Notes

- ⚠️ These are DEV credentials for a throwaway container — presumed
  compromised (they appear in transcripts/configs); never reuse anything from
  this file on a real system (CLIENT_ONBOARDING §11).
- The container has no TLS — hence `PG_SSLMODE=disable` locally.
- `psql` into it: `docker exec -it prism-pg psql -U postgres -d prism_dev`.
