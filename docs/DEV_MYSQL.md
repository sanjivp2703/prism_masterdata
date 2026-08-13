# Local MySQL dev environment

The MySQL analog of `docs/DEV_POSTGRES.md` — a disposable container for
developing and live-testing the mysql warehouse adapter
(docs/MYSQL_PORT_PLAN.md).

## 1. Container

```bash
docker run -d --name prism-mysql \
  -e MYSQL_ROOT_PASSWORD='PrismDev!Passw0rd' \
  -p 3306:3306 \
  mysql:8.0
```

Official multi-arch image — native on Apple Silicon, no Rosetta. Data lives
inside the container; `docker rm -f prism-mysql` fully resets the environment.
(Version floor is 8.0.13 for functional key parts; the `8.0` tag is far past
that. Also validate against `mysql:8.4` — the LTS — before a real customer.)

## 2. Install the Prism schema + demo data

```bash
cd stand-ui
MYSQL_ROOT_PASSWORD='PrismDev!Passw0rd' npm run mysql:install
```

Creates the `prism_internal` + `prism_exports` databases, the six data-plane
tables, the `prism_*` roles, and the `test_sources` demo database (28-row
carrier table + a latin1 charset fixture). Re-running resets the warehouse
side (DROP + CREATE — dev-reset semantics).

The dev service account (created by the live test setup, or by hand):

```sql
CREATE USER 'prism_svc'@'%' IDENTIFIED BY 'PrismSvc!Dev1';
GRANT 'prism_service' TO 'prism_svc'@'%';
SET DEFAULT ROLE 'prism_service' TO 'prism_svc'@'%';
```

## 3. Point the app / tests at it

`.env.local` (or inline for scripts):

```bash
PRISM_WAREHOUSE_TYPE=mysql
MYSQL_HOST=localhost
MYSQL_USER=prism_svc
MYSQL_PASSWORD='PrismSvc!Dev1'
# MYSQL_DATABASE defaults to prism_internal (session default only — MySQL
# joins across databases freely); MYSQL_SSL defaults to 'false' — right for
# the local container; managed providers need 'true' (or 'strict').
```

## 4. Live suites

```bash
MYSQL_ROOT_PASSWORD='PrismDev!Passw0rd' npm run test:mysql-live   # Phase M1 exit criteria
```

(Phase M2/M3/M4 suites — `test:mysql-detection`, `test:mysql-lifecycle`,
`test:mysql-setup` — follow the postgres suites' pattern.)

## Notes

- ⚠️ These are DEV credentials for a throwaway container — presumed
  compromised (they appear in transcripts/configs); never reuse anything from
  this file on a real system (CLIENT_ONBOARDING §11).
- The container has no TLS config — hence `MYSQL_SSL=false` locally.
- `mysql` into it: `docker exec -it prism-mysql mysql -uroot -p'PrismDev!Passw0rd'`.
