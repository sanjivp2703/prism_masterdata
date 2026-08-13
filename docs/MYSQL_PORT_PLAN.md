# Prism — MySQL Integration Plan

The implementation plan for supporting MySQL as the fourth warehouse option
(marketed as a "warehouse" alongside Snowflake, SQL Server, and PostgreSQL —
same deliberate positioning decision as Postgres). A customer chooses their
warehouse **once, at setup**; Prism is single-tenant, so nothing mixes at
runtime. Covers self-hosted MySQL and managed flavors (AWS RDS/Aurora MySQL,
Google Cloud SQL, Azure Database for MySQL, PlanetScale) — same wire protocol.

This is the third run of the port playbook (`docs/MSSQL_PORT_PLAN.md` built
the architecture; `docs/POSTGRES_PORT_PLAN.md` proved it repeats — P1–P4 of
that port landed in one working session against live exit-criteria suites).
MySQL borrows the Postgres port's shape almost everywhere; the sections below
lead with what is genuinely DIFFERENT. Rough total effort: **4.5–6
engineer-weeks** solo, less if the Postgres suites are cloned mechanically.

**Version floor: MySQL 8.0.13+** (functional key parts — see §2.4; 5.7 is
EOL). **MariaDB is explicitly deferred**: it lacks MySQL's functional-key-part
syntax (§2.4's uniqueness design would need a generated-column variant), so
"MariaDB support" is a small follow-on decided by demand, not a freebie.

---

## 1. What changes and what doesn't

Same split as the Postgres plan §1: SQLite app-state, LLM logic, review UI,
auth untouched. New implementation: `warehouse/mysql/` implementing the
existing `WarehouseAdapter` contract. Existing adapters untouched except at
kind-dispatch points (`getWarehouseAdapter().kind === 'mysql'`), which the
Postgres port already converted from booleans to kind switches in the shared
paths — most shared sites need only a new arm, and several
(`internalTable()`-based SQL, LIMIT/NULLS-free queries) need nothing at all.

---

## 2. Settled design decisions

### 2.1 Scope: databases ARE schemas — `prism_internal` as a sibling DATABASE

MySQL has **no schema level inside a database** (`CREATE SCHEMA` is a literal
alias for `CREATE DATABASE`); names are two-part `database.table`. Unlike
Postgres, **cross-database queries work freely** on one server, so Prism gets
its own databases without any join problem:

- The install creates two DATABASES: **`prism_internal`** (data plane) and
  **`prism_exports`** (default export destination), lowercase.
- **`internalTable()` needs NO new arm**: it already returns
  `prism_internal.literal_alias_matches` for Postgres, and on MySQL that same
  string means database `prism_internal`, table `literal_alias_matches` —
  resolve the mysql branch to the pg spelling and every shared statement
  works verbatim. (Snowflake/mssql keep `PRISM_DB.INTERNAL.*`.)
- The app-wide 3-part FQN model maps to MySQL's 2-part reality the same way
  the pg dialect handles `schema.table`: `parseFqn` accepts
  `database.table` (2-part) and tolerates a 3-part form by treating part one
  as the server-connection default database check — but unlike Postgres there
  is no hard cross-database rejection to enforce. Sources can live in ANY
  database on the server the service user can read. This is a genuine
  advantage over the pg port: no one-database-per-install limitation.
- ⚠️ **Case sensitivity of table names is OS-dependent**
  (`lower_case_table_names`: Linux servers are case-sensitive, Windows/mac
  are not). The install and all generated SQL use lowercase names throughout
  (same convention as pg), and the connect form should lowercase-fold
  unquoted user-typed FQNs only on display, never silently on execution.

### 2.2 Change detection: diff-scan only, heartbeat = `information_schema.TABLES.UPDATE_TIME`

Same decision shape as Postgres §2.2 — binlog/CDC is rejected (needs
REPLICATION privileges and server config; wrong trust profile for a plain
service user), triggers are rejected (DDL on customer tables), so:

- Every MySQL pipeline runs the tiered **diff-scan** mode (`detection_mode =
  'diff'`, reason `'mysql_diff'` with its own nudge-free UI tooltip, mirroring
  `pg_diff`). Tier constants shared with the other diff engines.
- **Free heartbeat**: `information_schema.TABLES.UPDATE_TIME` for the watched
  table — no grant beyond what SELECT already implies, no setup. InnoDB
  maintains it in memory since 5.7; it is **NULL after a server restart and
  not crash-persistent**, so the poller treats NULL/backwards exactly like
  the pg counter-reset case: fail OPEN into a scan. (Optional refinement,
  same tier as mssql's DMV: `performance_schema.table_io_waits_summary_by_table`
  write counters when performance_schema is on — default on in 8.0 — gives a
  delete-visible counter like pg's `n_tup_del`. Start with UPDATE_TIME;
  measure whether the perf-schema upgrade is worth it in M2, not before.)
- Deletes: UPDATE_TIME moves on delete, so the scan runs, finds no new
  values, and the hourly safety rebuild publishes the removal — the mssql
  diff-mode story, honestly documented. (The perf-schema refinement would
  restore pg's same-cycle delete flag if adopted.)

### 2.3 Normalization: app-side, staging joins under `utf8mb4_bin`

Same rule as both prior ports — one normalization implementation
(`normalizeLiteral`), zero SQL twins. MySQL specifics:

- Staging tables: `VARCHAR(800) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`
  (byte-wise — the BIN2 / COLLATE "C" analog).
- ⚠️ **Charset coercion, not just collation**: a legacy source column in
  `latin1` cannot take a bare `COLLATE utf8mb4_bin` — the join's source side
  must be `CONVERT(src.col USING utf8mb4) COLLATE utf8mb4_bin`. Wrap once in
  a dialect helper (`binaryCompare(expr)`) so no call site hand-rolls it;
  parity-test the emitted SQL. Legacy charsets are common in exactly the
  old-company MySQL installs Prism targets — this is a mainline path.

### 2.4 Uniqueness without partial indexes: functional key parts

The lookup invariants need what pg got from partial unique indexes — at most
one scopeless (NULL `domain_id`) row per name/normalized value — but **MySQL
has no partial indexes**, and its UNIQUE treats NULLs as always-distinct
(unlimited NULL duplicates). Solution, and the reason for the 8.0.13 floor:

- **Functional key parts**: `UNIQUE KEY uq_aan ((COALESCE(domain_id, -1)),
  alias_name)` — the COALESCE sentinel makes NULL scopes collide like values.
  Same construction on `literal_alias_matches (COALESCE(domain_id,-1),
  normalized_value)`. `-1` is unreachable (spec_ids are positive SQLite
  autoincrements).
- Upserts are `INSERT … ON DUPLICATE KEY UPDATE`. Two quirks vs pg's
  ON CONFLICT, both must be respected: **(1)** it fires on ANY unique-key
  collision, not a named target — key design above makes that equivalent;
  **(2)** there is **no RETURNING** — the alias-id map uses the mssql
  pattern (upsert batch, then SELECT the ids back), not the pg RETURNING
  collapse.

### 2.5 Export rebuild: atomic multi-RENAME instead of transactional DDL

MySQL DDL is **not transactional** (implicit commit), but `RENAME TABLE` is
**atomic across multiple renames in one statement** — the classic swap:

- Build `<export>__prism_new_<nonce>` → `RENAME TABLE <export> TO
  <export>__prism_old_<nonce>, <export>__prism_new_<nonce> TO <export>` (one
  atomic statement; first-ever build renames only the new table) → `DROP` the
  old. A crash between rename and drop leaves a stray `__prism_old` table,
  never a missing export — the builder drops stale `__prism_old_*` leftovers
  at the start of each rebuild.
- CTAS: `CREATE TABLE … AS SELECT … ORDER BY` — InnoDB writes in the ORDER BY
  order (physical best-effort only, as everywhere; consumers ORDER BY keys).
  Ordering tiers: PK → unique key (two tiers, like pg).
- Grants: captured from `information_schema.TABLE_PRIVILEGES` (+
  `COLUMN_PRIVILEGES` for column-scoped grants, deduped against table-level
  like the pg capture) and re-applied after the swap — no COPY GRANTS
  equivalent, no DENY concept. Note: MySQL privileges are granted to
  `'user'@'host'` accounts — quote grantees exactly as captured
  (`GRANTEE` comes back as `'name'@'%'`).
- **`export_kind 'view'` IS supported**, pg-style: `CREATE OR REPLACE VIEW`
  over PERSISTENT per-column mapping tables (`prism_internal.viewmap_<md5>`)
  refreshed transactionally (DML transactions are fine — only DDL isn't).
  Same live-view benefit and the same offboarding materialize-before-drop
  caveat.

### 2.6 Column mode: privilege-based, no IF-NOT-EXISTS ADD COLUMN

- MySQL has no table ownership — `ALTER TABLE ADD COLUMN` needs the ALTER
  privilege, `UPDATE` needs UPDATE; both grantable per-table. Consent
  provisioning ladder maps 1:1 (creator's personal credentials run the GRANT
  + ADD, or the admin runs `columnModeSetupSqlMysql()`'s block).
- ⚠️ MySQL 8.0 has **no `ADD COLUMN IF NOT EXISTS`** (MariaDB does). The
  generated consent SQL guards via `information_schema.COLUMNS` in a
  conditional, and the sync path checks the catalog before ALTERing (it
  already does on every warehouse) — a duplicate-column errno (1060) is
  classified as already-provisioned, not a failure.
- Same guardrails as everywhere: `assertCompanionColumnSafe`, creation-time
  conflict refusal, consent flag, PRELAUNCH §1 live test before customer use.

### 2.7 Dialect essentials

- **Driver: `mysql2`** (mature, promise API). Placeholders are **native
  `?`** — `translateBinds` is the identity function (scanner still validates
  count; parity-test that quotes/comments don't miscount). This is the
  easiest driver fit of the four warehouses.
- Identifiers: **backticks** `` `x` `` with doubled backticks escaping;
  `quoteIdent` rejects control chars as usual.
- JSON: native JSON type (validates on write — the ISJSON analog is free);
  reads via `state->>'$.rev'` / `JSON_UNQUOTE(JSON_EXTRACT(…))`; rev check
  `COALESCE(CAST(state->>'$.rev' AS SIGNED), 0) = ?`. Landed-row detection
  for the rev-checked save: `affectedRows` from the driver result (mysql2
  returns it directly — no OUTPUT/RETURNING needed).
- Statement timeout: `SET SESSION MAX_EXECUTION_TIME = 600000` — ⚠️ applies
  to **SELECT only** in MySQL; long writes are bounded by
  `innodb_lock_wait_timeout` and the driver-level timeout, which the
  connection sets too. Document, don't pretend parity.
- Errors (errno-based classification): global = 1045 (auth), 1049 (unknown
  database); table = 1044/1142 (db/table privilege denied), 1146 (table
  missing), 1054 (column missing); transient = 1213 (deadlock), 1205 (lock
  wait), ECONNREFUSED/ETIMEDOUT. Access-error set for the one-time fallback:
  1044/1142/1146/1045/1049.
- Health check: `information_schema.TABLES`/`COLUMNS` (cheap); text types =
  char/varchar/text families (+ enum — decide: treat ENUM as text, it holds
  categorical strings, which is Prism's whole domain). **No RLS/masking
  analog** — the policy-skip path is n/a on MySQL (health check returns
  masked:false unconditionally; document in the matrix).
- Service identity: `CREATE USER 'prism_svc'@'%' IDENTIFIED BY …` + a
  `prism_service` ROLE (MySQL 8.0 roles) granted to it, with
  `SET DEFAULT ROLE` — or direct grants to the user if role UX proves
  awkward on managed flavors (decide in M1 against RDS docs). Kill switch:
  `ALTER USER 'prism_svc'@'%' ACCOUNT LOCK;`
- TLS: `ssl` options in mysql2 config (managed providers require it);
  sslmode-equivalent field in workspace config, mirroring pg's.
- Cost model: provisioned capacity — protect load via the heartbeat-gated
  tiers. ⚠️ Scale-to-zero: **Aurora Serverless v2 (min ACU 0) and
  PlanetScale** sleep-on-idle tiers — same best-effort host sniff + ×10
  cadence stretch + onboarding disclosure as pg (§2.4 there).

---

## 3. State & schema additions

- SQLite migration (next number at implementation time): `workspace_config`
  gains `my_host/my_port/my_database/my_user/my_password/my_ssl` (encrypted
  secret, `enc:v1:`); `accounts` gains the personal `my_*` variant;
  `warehouse_type` accepts `'mysql'`.
- `01_internal_tables.mysql.sql`: `prism_internal` + `prism_exports`
  DATABASES, the six data-plane tables (`AUTO_INCREMENT` PKs, utf8mb4 with
  `utf8mb4_bin` on matching columns, JSON columns, functional-key-part
  uniques per §2.4), `prism_service`/`prism_data_admin`/`prism_readonly`
  roles + user template + per-database source-grant template
  (`GRANT SELECT ON <db>.* TO 'prism_svc'@'%'` — database-wide SELECT is the
  FUTURE-TABLES analog and covers new tables automatically, one real
  simplification vs pg's default-privileges footgun). `02_demo_data.mysql.sql`
  with the standard 28-row carrier fixture in a `test_sources` database.
- `scripts/mysql-install.mjs` + `npm run mysql:install`; `docs/DEV_MYSQL.md`
  (`docker run -d --name prism-mysql -e MYSQL_ROOT_PASSWORD=… -p 3306:3306
  mysql:8.0` — official multi-arch image, no Rosetta).

---

## 4. Phases

Same five-phase shape as the Postgres plan, each gated on a live suite
(clone the `live-pg-*.mts` suites — they are the template, and most checks
port by find-replace):

### Phase M1 — Foundation · ~1 wk

> **STATUS: implemented 2026-08-11** — `01_internal_tables.mysql.sql` +
> `02_demo_data.mysql.sql` (incl. the latin1 charset fixture) + `npm run
> mysql:install` runner + `docs/DEV_MYSQL.md`; `warehouse/mysql/{dialect,
> connection}.ts` (native-`?` count validation, `binaryCompare`, errno
> classification, PlanetScale host sniff) + factory arm + `mysql2` lint guard
> + `internalTable()` mysql arm (pg spelling, per §2.1); parity tests (30
> cases). **Design delta discovered at implementation:** InnoDB's 3072-byte
> key limit makes an 800-char utf8mb4 unique key impossible, so the
> queue/lookup unique keys are FUNCTIONAL SHA2-hash keys
> (`(pipeline_id, (SHA2(literal_value,256)))`,
> `((COALESCE(domain_id,-1)), (SHA2(normalized_value,256)))`) with a
> 191-char-prefix secondary index for lookups — collision-safe for dedup and
> serves ON DUPLICATE KEY UPDATE. **Exit criteria met live** (`npm run
> test:mysql-live`, Docker mysql:8.0, 28 checks): install clean, CRUD,
> utf8mb4_bin distinctness, functional-key scopeless + normalized-scope
> uniqueness (invariant ENFORCED), latin1 CONVERT join + bare-COLLATE
> failure proof, JSON round-trip/rejection, rev-check via affectedRows,
> atomic multi-RENAME swap, access classification, ad-hoc credentials.
> Regression: parity + tsc + build + `test:pg-live` green.
Install scripts + runner + dev doc; `warehouse/mysql/{dialect,connection}.ts`
(+ factory arm, `mysql2` added to the driver lint guard); parity tests
(backtick quoting, 2-part FQN, bind-count validation, errno classification,
`binaryCompare` emission, scale-to-zero hosts).
**Exit: `test:mysql-live`** — install clean on Docker mysql:8.0; CRUD with
binds; `utf8mb4_bin` case-distinctness; functional-key scopeless uniqueness;
JSON round-trip + invalid-JSON rejection; charset-coercion join
(latin1 source fixture); atomic RENAME swap sanity; access-error
classification. tsc/build/parity green, other warehouses untouched.

### Phase M2 — Detection · ~1 wk

> **STATUS: implemented 2026-08-12** — `warehouse/mysql/detection.ts`
> (UPDATE_TIME heartbeat, shared tiers, binaryCompare-grouped diff scans with
> the KI-138 distinct-collation rule, row-alias ON DUPLICATE KEY queue writes
> with the KI-121/106 guards, catalog health check — no masking analog) +
> `pipeline-poller-mysql.ts` (pg-orchestrator clone minus RLS/delete-flag) +
> poller/sweep/tick dispatch arms + `mysql_diff` UI tooltip + MySQL queue-read
> ordering arms (`(detected_at IS NULL)` — no NULLS LAST on MySQL).
> **Design deltas locked at implementation:** (1) `information_schema_stats_
> expiry = 0` is set per session — the 24h default would blind the heartbeat
> for a day (live-proven fresh: a write is detected the same minute);
> (2) version floor RAISED to **8.0.19** — `VALUES()` in upserts is deprecated
> in 8.0.20 and removed in 8.4, so the row-alias form is the only spelling
> valid across the supported range; (3) `READS` is a reserved word (aliases).
> **Exit criteria met live** (`npm run test:mysql-detection`, 17 checks):
> init + baseline queue, idle skip with ZERO table reads (performance_schema
> I/O counters), same-minute new-value detection, known-value non-requeue,
> delete-blindness documented as a passing assertion (hourly rebuild covers),
> corrupt/backwards-heartbeat fail-open + re-stamp, dropped-table pause.
> Regression: parity + tsc + build + `test:mysql-live` + `test:pg-detection`
> green.
`warehouse/mysql/detection.ts` (UPDATE_TIME heartbeat with NULL/backwards
fail-open, shared tiers, ON DUPLICATE KEY queue writes with the KI-121/106
guards, catalog health check) + `pipeline-poller-mysql.ts` (clone the pg
orchestrator minus the RLS branch) + poller/sweep/tick dispatch arms +
`mysql_diff` UI tooltip.
**Exit: `test:mysql-detection`** — init, baseline queue, idle skip (prove via
perf-schema counters or query log), new-value detection, known-value
non-requeue, UPDATE_TIME-reset fail-open, dropped-table pause.

### Phase M3 — Reads, writes, export, one-time · ~1–1.5 wk

> **STATUS: implemented 2026-08-12** — `warehouse/mysql/mappings.ts` (row-alias
> ON DUPLICATE KEY + select-back id maps — no RETURNING on MySQL) +
> `warehouse/mysql/export.ts` (staging join under binaryCompare, CTAS + ATOMIC
> multi-RENAME swap + stale `__prism_old/new` sweep, TABLE_/COLUMN_PRIVILEGES
> capture with verbatim `'user'@'host'` grantee replay, view kind via
> persistent mapping tables, guarded column mode w/ errno-1060 tolerance) +
> run-state arms (JSON `->>'$.rev'`, affectedRows landed-detection) +
> op-export/column-specs/export-table/op-auto-group-run/create-initial-run
> arms (incl. the NULLS-LAST and SUBSTRING_INDEX dialect swaps) + one-time
> flow + read/lookup routes (fork sweep — one-time map table drops its PK for
> the InnoDB key limit; COALESCE arms both CONVERTed against
> illegal-mix-of-collations). **Bug caught by gate-order review:**
> `fetchSourceLiterals` 3-part gate ran before the diff-engine branch, so
> 2-part MySQL FQNs returned an EMPTY baseline — branch moved above the gate.
> **Exit criteria met live** (`npm run test:mysql-lifecycle`, 19 checks):
> zero-LLM tick drain, export values/mirror/PK-physical-order/mapped-only,
> grant survives the RENAME swap, live view without rebuild, column-mode
> fill + steady-state 0-write proof (performance_schema counters), 6k drain
> across two 5k installments. Regression: parity + tsc + build + all three
> mysql suites + `test:pg-lifecycle` + `test:pg-setup` green.
`mappings.ts` (ON DUPLICATE KEY + select-back id maps), `export.ts` (staging
join with `binaryCompare`, CTAS + atomic multi-RENAME + stale `__prism_old`
sweep, TABLE_/COLUMN_PRIVILEGES capture/re-grant, view kind via persistent
maps, column mode per §2.6), run-state/validation-log arms (JSON operators,
`affectedRows` landed-detection), one-time flow + lookup export
(`prism_exports.<name>_lookup`; refuse `prism_internal` targets), shared-site
arms (most already resolve via `internalTable()`; audit the
`kind === 'postgres'` ternaries added in that port and generalize any that
should read "not snowflake/mssql").
**Exit: `test:mysql-lifecycle`** — clone of the pg suite: zero-LLM tick,
export values/mirror/PK-order/mapped-only, grant survives the RENAME swap,
live view without rebuild, column-mode fill + 0-row steady state, 6k
two-installment drain.

### Phase M4 — Setup, onboarding, credentials · ~1 wk

> **STATUS: implemented 2026-08-12** — migration 019 (workspace + personal
> my_* credential columns); routes: `workspace-mysql` (database OPTIONAL —
> session default only, not a pg-style scope), `mysql-config` (personal),
> warehouse-type accepts 'mysql', install-script `?warehouse=mysql`,
> verify-install mysql scope (databases/tables/roles probes; a denied
> mysql.role_edges read degrades to a warning, not red — least-privilege
> installs can't read it), test-snowflake status arm; wizard MySQL platform
> card (step-1 grid went 2×2 for four cards) + StepInstallScriptMysql
> (per-DATABASE grants generator, future-tables-covered note, 8.0.19+ floor,
> ACCOUNT LOCK kill switch) + StepCredentialsMysql (ssl select, optional
> database) + PersonalSetupFormMysql + AutoExportHome 2-part-FQN/no-CT arms;
> warehouse labels (use-warehouse-label, ExportLookupModal prism_exports
> default, terms/privacy warehouseName). **Exit criteria met live**
> (`npm run test:mysql-setup`, 11 checks): workspace choice drives the
> factory, encrypted workspace + personal credential round-trips, one-time
> create/overwrite export, native-JSON file rows. Regression: parity + tsc +
> build + all four mysql suites + `test:pg-setup` green. Wizard UI
> visually unverified (same caveat as the pg port — click through /setup).
Migration; `workspace-mysql` + `mysql-config` routes (clone the pg pair);
warehouse-type/install-script/verify-install/test-snowflake arms; wizard
MySQL platform card + install/credentials steps (per-database grant
generator — simpler than pg's: no default-privileges footgun) + personal
variant; labels (`use-warehouse-label`, ExportLookupModal `prism_exports`
default, terms/privacy `warehouseName` → 'MySQL').
**Exit: `test:mysql-setup`** — workspace choice drives the factory, encrypted
workspace/personal round-trips, one-time create+overwrite, JSON file rows.

### Phase M5 — Docs + QA hardening · ~0.5–1 wk

> **STATUS: docs implemented 2026-08-12** — WAREHOUSES.md MySQL section
> (incl. the stats-expiry, InnoDB-key-limit, VALUES()-removal, charset, and
> grantee-addressing traps), CLIENT_ONBOARDING **Appendix D** (per-database
> grants, no-footgun note, ACCOUNT LOCK, sleep-on-idle warning, legacy-charset
> note, RBAC spot check), SECURITY_AND_DISCLOSURES MySQL credential inventory,
> CLAUDE.md commands/env/library rows. REMAINING (infrastructure/time):
> mysql:8.4 LTS validation, one managed provider (RDS) + one sleep-on-idle
> provider (PlanetScale) live pass, failure drills beyond the suites,
> MariaDB decision note if demand appears. Run before the first real MySQL
> customer.
WAREHOUSES.md MySQL section; CLIENT_ONBOARDING **Appendix D** (install
runbook, per-database grants, kill switch = ACCOUNT LOCK, no-RLS note, cost
model + Aurora-v2/PlanetScale sleep warning, zero-grants RBAC spot check —
MySQL is default-deny but check for broad `GRANT … ON *.*` legacy grants);
SECURITY_AND_DISCLOSURES inventory; CLAUDE.md commands/env/library rows.
Environment matrix: Docker 8.0 (floor) + 8.4 LTS; RDS MySQL; one
scale-to-zero provider. Failure drills per the standard list. MariaDB:
explicitly OUT — record the generated-column uniqueness workaround as the
follow-on design note.

---

## 5. Translation reference (delta view — full matrix in WAREHOUSES.md at implementation)

| Concern | PostgreSQL (shipped) | MySQL (this plan) |
|---|---|---|
| Install scope | ONE database; `prism_internal` SCHEMA | Any databases on the server; `prism_internal` DATABASE (cross-db joins work) |
| `internalTable()` | `prism_internal.x` (schema.table) | **same string** (database.table) — no new arm |
| Detection heartbeat | pg_stat counters (delete-visible) | `information_schema.TABLES.UPDATE_TIME` (restart-volatile, fail-open; perf-schema upgrade optional) |
| Binary compare | `COLLATE "C"` | `utf8mb4_bin` + `CONVERT(… USING utf8mb4)` for legacy charsets |
| Scopeless uniqueness | Partial unique indexes | Functional key parts `(COALESCE(domain_id,-1), …)` — the 8.0.13 floor |
| Upsert | `ON CONFLICT` + RETURNING | `ON DUPLICATE KEY UPDATE` + select-back (no RETURNING) |
| Export swap | Transactional DDL | Atomic multi-`RENAME TABLE` + stale-`__prism_old` sweep |
| View kind | ✅ persistent maps | ✅ same design (`CREATE OR REPLACE VIEW`) |
| Masking analog | Row-Level Security → skip | none — n/a |
| Binds | `?`→`$n` translation | native `?` — identity |
| Kill switch | `ALTER ROLE … NOLOGIN` | `ALTER USER … ACCOUNT LOCK` |
| Scale-to-zero trap | Neon / Aurora | Aurora Serverless v2 / PlanetScale |

---

## 6. Risks and open questions

1. **Functional-key-part floor (8.0.13)** — verify managed flavors (RDS,
   Cloud SQL, Azure) all offer ≥8.0.13 (they do today; confirm at M1) and
   that PlanetScale's schema restrictions (no foreign keys historically)
   don't reject the install script — the FK from `literal_alias_matches` to
   `approved_alias_names` may need to become advisory (index-only) on
   PlanetScale, which Snowflake-parity already tolerates (Snowflake never
   enforced FKs).
2. **UPDATE_TIME reliability** across managed flavors and replicas — M2's
   live suite must include a restart-reset case; if a provider proves flaky,
   promote the perf-schema counter path from optional to primary.
3. **Charset zoo** — the `binaryCompare` helper is load-bearing; M1's live
   suite needs a genuine latin1 source fixture, not just utf8mb4.
4. **`'user'@'host'` grant addressing** in ACL capture/re-apply — quote and
   replay grantees verbatim; a naive re-grant to `'name'` (implicit `@'%'`)
   can silently address a different account.
5. **Demand check before building** — this plan exists so the port is
   scoped, not to green-light it. The stated trigger is a concrete
   MySQL-shop prospect; until then Snowflake + SQL Server + PostgreSQL is
   the shipping story and MySQL is "on request."

---

## 7. Definition of done

A MySQL install (Docker or RDS), provisioned per CLIENT_ONBOARDING Appendix
D, passes: 5-step wizard → first pipeline (connect → review → accept →
activate) → new row detected within its scan tier and standardized at the
next tick → deleted row gone after the next rebuild → view-kind export live →
one-time standardization via personal credentials → lookup export to all
formats → overnight idle with no source reads — with Snowflake, mssql, AND
postgres regressions green (tsc, build, parity, and each platform's live
suites).
