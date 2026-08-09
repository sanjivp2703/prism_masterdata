# Local SQL Server dev environment

How to run a SQL Server instance for developing/testing Prism's mssql
warehouse adapter (`docs/MSSQL_PORT_PLAN.md`).

## 1. Start the container (Docker)

```bash
docker run -d --name prism-mssql \
  --platform linux/amd64 \
  -e ACCEPT_EULA=Y \
  -e MSSQL_SA_PASSWORD='PrismDev!Passw0rd' \
  -p 1433:1433 \
  mcr.microsoft.com/mssql/server:2022-latest
```

Notes:
- On Apple Silicon the image runs under Rosetta emulation (`--platform
  linux/amd64`); enable "Use Rosetta for x86_64/amd64 emulation" in Docker
  Desktop settings if the container crash-loops.
- The SA password must satisfy SQL Server complexity rules (the one above
  does). It's a throwaway dev credential — fine to keep in shell history, never
  reuse anywhere real.
- Wait ~15–30 s after start for the server to accept logins
  (`docker logs prism-mssql` shows "SQL Server is now ready").

## 2. Install the Prism schema

```bash
cd stand-ui
MSSQL_SA_PASSWORD='PrismDev!Passw0rd' npm run mssql:install
```

Runs `01_internal_tables.mssql.sql` then `02_demo_data.mssql.sql` (repo root):
`01` creates `PRISM_DB` with the `INTERNAL`/`EXPORTS` schemas + four data-plane
tables and the roles (the customer install — no demo data); `02` creates the
`TEST_DB` demo source table with Change Tracking enabled (dev/demo only, never
run on a customer server). Re-running resets the mssql side, same dev-reset
semantics as the Snowflake scripts.

## 3. Point the app at it (dev switch)

In `stand-ui/.env.local`:

```
PRISM_WAREHOUSE_TYPE=mssql          # factory switch (Phase 6 replaces with setup UI)
MSSQL_SERVER=localhost
MSSQL_USER=prism_svc                # create via the login template in the .sql, or use sa in dev
MSSQL_PASSWORD=...
MSSQL_TRUST_SERVER_CERT=true        # container uses a self-signed cert
```

Unset `PRISM_WAREHOUSE_TYPE` (or set `snowflake`) to switch back.

**Current dev container's `prism_svc` login** (reset 2026-07-29 during INS-M07
least-privilege testing — password wasn't recorded anywhere before that):
password `PrismSvc!Test9x2Q`. Throwaway dev credential on the local container
only — same rule as the `sa` password above, never reuse anywhere real. Reset
again anytime via `sa` if needed:
`ALTER LOGIN prism_svc WITH PASSWORD = '<new password>';`

## Housekeeping

```bash
docker stop prism-mssql && docker rm prism-mssql   # tear down
docker exec -it prism-mssql /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P 'PrismDev!Passw0rd' -C -Q "SELECT @@VERSION"   # ad-hoc SQL
```

## Understanding Change Tracking (plain-language)

This section exists because SQL Server's naming and Change Tracking mechanics
trip people up the first time, even if you already know Snowflake well.

### Database vs. schema vs. table

SQL Server names everything three levels deep: `database.schema.table`. In
this repo's dev setup that's `TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT`:

- **`TEST_DB`** is the **database** — the top-level container. It's the
  Snowflake-world equivalent of a database like `PRISM_DB`.
- **`dbo`** is the **schema** — a namespace inside the database. SQL Server
  gives every database a default schema called `dbo` ("database owner")
  automatically; you only get a different name if someone deliberately
  creates a custom schema. Nothing in this repo does that, so `dbo` is what
  you'll see everywhere in the dev/demo setup.
- **`RAW_MOBILE_CARRIERS_SHORT`** is the **table** itself.

It's easy to assume "TEST_DB" sounds schema-like because Snowflake's default
schema is often literally called `PUBLIC` and people think of the database as
the big container — but in SQL Server the schema is a distinct middle layer,
and it's `dbo`, not the database name.

### What Change Tracking actually is

Change Tracking is SQL Server's built-in way of answering "what rows changed
in this table since I last checked?" without re-scanning the whole table.
Prism's poller uses it to detect new/changed/deleted values quickly. It's the
mssql equivalent of what Snowflake's streams do for the Snowflake side of
Prism — same job, different mechanism, because SQL Server has no built-in
stream feature.

### The three setup statements are three DIFFERENT jobs

```sql
ALTER DATABASE TEST_DB SET CHANGE_TRACKING = ON
  (CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON);

ALTER TABLE dbo.RAW_MOBILE_CARRIERS_SHORT ENABLE CHANGE_TRACKING;

GRANT VIEW CHANGE TRACKING ON SCHEMA::dbo TO prism_svc;
```

| # | Statement | What it does | Scope |
|---|---|---|---|
| 1 | `ALTER DATABASE ... SET CHANGE_TRACKING = ON` | Turns on the tracking *infrastructure* for the database. Tracks nothing by itself. | Once per database, ever. |
| 2 | `ALTER TABLE ... ENABLE CHANGE_TRACKING` | Actually starts recording every insert/update/delete on THIS table. Requires #1 to already be on, and requires the table to have a primary key. | Once per table — genuinely repeats for every table, no shortcut. |
| 3 | `GRANT VIEW CHANGE TRACKING ON SCHEMA::<schema> TO prism_svc` | A **permission**, not a switch — lets `prism_svc` *read* the change data that #1+#2 produce. Does not track anything by itself. | One grant, but it covers every table (current AND future) under that schema — the only one of the three that's schema-wide instead of per-table. |

**Key trap:** running #2 without #1 first just fails outright — SQL Server
refuses to enable table-level tracking until database-level tracking exists.
Running #2 without #3, though, "succeeds" silently in a misleading way: SQL
Server keeps faithfully recording changes to the table, but `prism_svc` has
no permission to read any of it, so Prism's detection code hits a permission
wall and quietly falls back to slower scheduled scanning — no error, no
warning, it just underperforms forever until someone notices the missing
grant.

### Why `sa` hides this problem, and why it's not just a testing concern

`sa` is a sysadmin login — it bypasses every permission check in the
database, including #3. So testing with `sa` will never reveal a missing
`GRANT`; Change Tracking will appear to work even if you forgot it entirely.

This matters beyond testing because **`sa` is dev-only and never used for
real** — every actual Prism customer connects exclusively through the
dedicated `prism_svc` service login (least-privilege by design, the same
identity Part B of the setup wizard creates). Since production Prism
authenticates the same restricted way your test setup does, the permission
gap you'd hit by skipping #3 is not a testing artifact — it's the exact same
wall a real customer's pipeline would silently fall into if their DBA ran the
first two `ALTER` lines but skipped the `GRANT`. Testing against `prism_svc`
instead of `sa` (as opposed to just using `sa` everywhere for convenience) is
what actually rehearses the real customer experience.
