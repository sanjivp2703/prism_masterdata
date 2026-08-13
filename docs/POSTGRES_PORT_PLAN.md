# Prism — PostgreSQL Integration Plan

The implementation plan for supporting PostgreSQL as a third warehouse option
(marketed as a "warehouse" alongside Snowflake and SQL Server, even though
Postgres is technically an operational database — deliberate positioning
decision, 2026-08-11). A customer chooses their warehouse **once, at setup**;
Prism is single-tenant, so nothing mixes at runtime. Covers self-hosted
Postgres and every managed flavor (AWS RDS, Google Cloud SQL, Azure Database
for PostgreSQL, Supabase, Neon) — they are all the same thing to connect to.

This is the MSSQL port re-run on a mature adapter architecture: the contract,
parity system, poller dispatch, diff-scan detection design, staging-join
export pattern, and setup-wizard multi-platform plumbing all exist. Rough
total effort: **5.5–7 engineer-weeks** (vs. 12–16 for mssql, which built all
of that from scratch).

**Version floor: PostgreSQL 13+** (12 is EOL). Managed providers all run 13+.

---

## 1. What changes and what doesn't

**Unchanged** — same list as the mssql plan §1: SQLite app-state, all LLM
logic, review UI, run state blob, auth, one-time flow logic above the
warehouse calls.

**New implementation** — `warehouse/postgres/` implementing the existing
`WarehouseAdapter` contract: connection, dialect, detection, mappings, export.
Existing Snowflake and mssql adapters are untouched except at kind-dispatch
points; a Snowflake or mssql install never executes Postgres code.

---

## 2. Settled design decisions

### 2.1 ⚠️ Install scope is ONE DATABASE, not a server — schemas, not PRISM_DB

Postgres **cannot join across databases** (a connection is bound to exactly
one). The data-plane tables must be joinable against customer source tables
in SQL (export joins), so a separate `PRISM_DB` database — the Snowflake and
mssql model — is impossible.

- The install script creates two **schemas inside the customer's database**:
  `prism_internal` (the four data-plane tables) and `prism_exports` (default
  export destination). Lowercase, snake_case — Postgres folds unquoted
  identifiers to lowercase (the OPPOSITE of Snowflake), and an all-caps
  quoted `"PRISM_DB"` convention would force quoting forever.
- The FQN model stays `db.schema.table` app-wide; on Postgres the `db` part
  must equal the connected database. `parseFqn` accepts both 3-part and
  2-part (`schema.table`) forms; a 3-part FQN naming a DIFFERENT database is
  rejected at validation time with a clear "Postgres cannot query across
  databases — connect a separate Prism installation for that database"
  message (scale limits refuse loudly).
- **Limitation to disclose at setup**: one Prism installation standardizes one
  Postgres database. Customers with several databases need the sources
  consolidated (FDWs are their problem, not ours) or additional installs.

### 2.2 Change detection: diff-scan only in v1, with a free pg_stat heartbeat

Postgres has no stream/CT analog that doesn't require intrusive setup
(logical replication needs `wal_level=logical`, replication slots, and
near-superuser privileges — wrong trust profile for a service user; triggers
require DDL on customer tables for marginal gain over diff-scan). Decision:

- **Every Postgres pipeline runs the tiered diff-scan mode** — the engine
  designed for mssql (`detection_mode = 'diff'`, same tier constants, same
  self-tuning by measured duration, same `detection_state` JSON). The UI's
  "Scheduled scan" labeling already exists.
- **The free heartbeat is `pg_stat_user_tables`** (`n_tup_ins/upd/del`,
  cumulative counters; visible without special grants): "was this table
  written since I last looked?" — the analog of mssql's
  `sys.dm_db_index_usage_stats`, but WITHOUT the `VIEW SERVER STATE` grant
  hassle. Persist last-seen counters in `detection_state`; counters reset on
  server restart (`stats_reset`) — treat a backwards jump as "changed" (fail
  open, one wasted scan).
- Deletes need no special detection (same as mssql diff mode): export
  rebuilds select from the current source.
- **Trigger-based fast path: deferred, not rejected.** A consent-gated
  trigger + change-table (mirroring the `change_tracking_consent` pattern)
  could give ≤1-min detection later; build it when a customer's latency need
  justifies DDL on their tables.

### 2.3 Normalization: app-side, same as mssql — resist the `normalize()` temptation

Postgres 13+ actually HAS Unicode normalization in SQL (`normalize(x, NFC)`),
so a SQL-side `PRISM_NORMALIZE` twin is *possible* — and still **rejected**:
it would be a THIRD implementation that must agree with `normalizeLiteral()`
forever, reintroducing exactly the silent-drift failure mode the mssql
decision (§2.2 there) eliminated. Uniformity wins:

- App-side `normalizeLiteral`, staging-table exact-match joins, distinct-value
  cap with a loud pause on violation — the mssql pattern verbatim
  (`materializeAliasStaging` is already shared; reuse it).
- **Collation**: default Postgres collations are deterministic and
  case-SENSITIVE, so the mssql BIN2 trap mostly doesn't exist — but create
  staging join columns with `COLLATE "C"` anyway: it guarantees byte-wise
  equality regardless of database collation (a customer DB created with a
  nondeterministic ICU collation would otherwise break exact-match joins) and
  keeps the parity story symmetric.

### 2.4 Cost model: protect server load; watch scale-to-zero providers

Self-hosted/RDS/Cloud SQL Postgres bills provisioned capacity — protect
CPU/IO headroom via the heartbeat-gated tiered scans, same as mssql.

- **⚠️ Neon and Aurora Serverless scale to zero** — a per-minute connection
  would hold them awake 24/7, the exact failure the Snowflake poller was
  engineered against. v1 mitigation: detect at connection time where cheap
  (Neon via host suffix `.neon.tech`; Aurora via `aurora` in
  `server_version`/host), warn at setup, and stretch the poll cadence ×10
  like the Azure-serverless handling. Document in onboarding regardless —
  host-sniffing is best-effort, not a guarantee.
- Connection model: per-request connect/disconnect (matching the other
  adapters' semantics). `pg.Pool` with max 1–2 is fine as an internal detail;
  keep semantics identical first, optimize later.

### 2.5 Dialect essentials (the translation row for §5)

- **Upserts**: `INSERT … ON CONFLICT DO UPDATE/NOTHING` (not MERGE — works on
  every supported version, needs the unique indexes the schema already
  requires). Bind ceiling 65,535 params/statement — the Snowflake-sized 5,000-row
  batches fit comfortably; reuse `EXPORT_MERGE_BATCH`.
- **Export rebuild**: Postgres DDL is **fully transactional** — build
  `_new` table, then `BEGIN; DROP old; ALTER TABLE _new RENAME; COMMIT` is
  genuinely atomic (easier than mssql's sp_rename dance). No COPY GRANTS
  equivalent: capture ACLs from `information_schema.role_table_grants` and
  re-apply after the swap (mssql pattern).
- **`export_kind = 'view'` IS supported** (unlike mssql): live views over the
  staging-join work. View bodies schema-qualify `prism_internal.*` references;
  the offboarding materialize-before-drop caveat (CLIENT_ONBOARDING §12)
  applies to Postgres views identically.
- **Column mode**: `ALTER TABLE ADD COLUMN` requires table ownership;
  `GRANT UPDATE` per table at consent time — the existing consent +
  creator-credential provisioning ladder maps 1:1. Same PRELAUNCH §1 live
  test required before customer use.
- **Identifiers**: `"quoted"`, unquoted folds to LOWERCASE. `quoteIdent`
  doubles embedded quotes; the `r.FIELD ?? r.field` result-key pattern
  already tolerates Postgres's lowercase keys.
- **JSON**: `JSONB` for `PIPELINE_QUEUE`-adjacent JSON columns; `RUN_STATE`
  blob reads via `->>`/`jsonb_extract_path_text`; the rev check is
  `COALESCE((state->>'rev')::int, 0) = ?`.
- **Errors**: classify by SQLSTATE — `28P01`/`28000` auth, `42501` permission
  denied, `42P01` undefined table, `3D000` database missing, `57P03`
  cannot-connect, `53300` too many connections. Postgres error messages can
  embed SQL — sanitize before any client response.
- **Health checks**: `information_schema.columns` / `pg_catalog` (cheap);
  the masking-policy analog is **Row-Level Security** — a watched table with
  `pg_class.relrowsecurity = true` (or a `pg_policies` row) gets the same
  skip + flag + auto-recover treatment as Snowflake masking detection. Column
  type still text = `text`/`varchar`/`char` families.
- **Service identity**: `prism_service` NOLOGIN role holding grants +
  `prism_svc` LOGIN role granted membership. Kill switch:
  `ALTER ROLE prism_svc NOLOGIN` (instant, customer-controlled). Audit story:
  `log_statement`/pgAudit — theirs to enable, disclose in onboarding.
- **TLS**: `sslmode` is a first-class connection field (require/verify-full +
  optional CA cert for RDS/Cloud SQL). The dev container uses no TLS; managed
  providers require it.
- **Driver**: `pg` (node-postgres) — mature, pure JS, parameterized queries
  are `$1…$n` (dialect layer translates `?` like the mssql `@pN` translator).

---

## 3. State & schema additions

- SQLite migration: `workspace_config.warehouse_type` gains `'postgres'`;
  add `pg_*` workspace credential fields (host, port, database, user,
  password `enc:v1:`, sslmode, ca cert) and `accounts.pg_*` personal-credential
  columns (the sf_*/ms_* pattern).
- `pipelines.detection_mode` reuses `'diff'`; `detection_state` gains the
  pg_stat counter snapshot fields (adapter-owned JSON — no migration needed).
- `01_internal_tables.postgres.sql`: `prism_internal` + `prism_exports`
  schemas, the four data-plane tables (BIGINT GENERATED ALWAYS AS IDENTITY
  PKs, `text` value columns, `COLLATE "C"` on `normalized_value` and staging
  join columns, JSONB where applicable, unique indexes backing every
  ON CONFLICT target), roles + grants, no UDF, no warehouse. Templates for
  `CREATE ROLE prism_svc LOGIN PASSWORD …` and per-schema source grants
  (`GRANT USAGE ON SCHEMA`, `GRANT SELECT ON ALL TABLES IN SCHEMA` +
  `ALTER DEFAULT PRIVILEGES … GRANT SELECT` — the FUTURE TABLES analog,
  with its footgun: default privileges only apply to objects created by the
  role that ran the ALTER; document it).

---

## 4. Phases

### Phase P1 — Foundation: install script, connection, dialect · ~1 wk

> **STATUS: implemented 2026-08-11** — install script + `pg:install` runner +
> `docs/DEV_POSTGRES.md`; `warehouse/postgres/{dialect,connection}.ts` +
> factory + lint guard (`pg` added to no-restricted-imports); parity tests
> (quoting, 2/3-part FQN + cross-db rejection, `?`→`$n` incl. dollar-quotes and
> E-strings, SQLSTATE classification, scale-to-zero host). **Exit criteria met
> live** (`npm run test:pg-live`, Docker postgres:16): install clean, 21 checks
> incl. COLLATE "C" distinctness, scopeless-alias partial unique index, JSONB
> round-trip/rejection, rev extraction, transactional DDL, access-error
> classification. tsc + build + parity green.
- `01_internal_tables.postgres.sql` + `npm run pg:install` runner +
  `docs/DEV_POSTGRES.md` (Docker `postgres:16` recipe — trivial compared to
  mssql's Rosetta dance).
- `warehouse/postgres/connection.ts` (`pg`, env + workspace config tiers,
  executeQuery with `$n` translation, SQLSTATE classification, sanitization,
  scale-to-zero detection warning) + `dialect.ts` + adapter registration in
  the factory (`PRISM_WAREHOUSE_TYPE=postgres` dev switch first, wizard in P4).
- Parity tests: quoting, FQN parse (2-part + cross-database rejection), `$n`
  translation, SQL text generation.
- **Exit criteria**: install clean on Docker postgres:16; adapter CRUD with
  binds; COLLATE "C" case-sensitivity proven; access-error classification;
  `test:parity` + tsc + build green with Snowflake and mssql untouched.

### Phase P2 — Detection · ~1–1.5 wk

> **STATUS: implemented 2026-08-11** — `warehouse/postgres/detection.ts`
> (pg_stat heartbeat with reset fail-open + FREE delete detection via the
> del-counter delta, tiered scans sharing the mssql constants, ON CONFLICT
> queue writes with the KI-121/KI-106 guards, RLS health check) +
> `pipeline-poller-postgres.ts` (health cadence, policy_blocked flag,
> pause/alert semantics, freshness stamping) + poller dispatch + `pg_diff` UI
> tooltip + sweep/tick dispatches (`reconcilePgQueue`, queue-read branches).
> **Exit criteria met live** (`npm run test:pg-detection`): 21 checks incl.
> idle poll = ZERO table reads (proven via seq/idx-scan counters), delete →
> needsExportRefresh, stats-reset fail-open, RLS flag+skip+auto-recover,
> dropped-table pause.
- `warehouse/postgres/detection.ts`: pg_stat heartbeat (counter snapshot +
  reset tolerance), tiered diff scans (constants shared with mssql), queue
  MERGE via ON CONFLICT, catalog health check + RLS detection,
  `classifyPollError` for SQLSTATEs.
- `pipeline-poller-postgres.ts` orchestration (or generalize the mssql
  orchestrator if the diff shrinks to config — decide by diff size, not
  ideology).
- **Exit criteria** (live, `npm run test:pg-detection`): insert detected on
  the tier schedule; heartbeat idle-skip proven via
  `pg_stat_statements`/log inspection (zero table reads when idle); delete
  drops at next rebuild; RLS table flagged + skipped + auto-recovers;
  dropped-table pause; counter-reset fail-open.

### Phase P3 — Reads, writes, export, one-time · ~1.5–2 wk

> **STATUS: implemented 2026-08-11** — `warehouse/postgres/mappings.ts`
> (ON CONFLICT upserts w/ RETURNING; unique indexes added to the install script
> now ENFORCE the one-row-per-(normalized,spec) invariant) +
> `warehouse/postgres/export.ts` (staging join, transactional swap, ACL
> capture/re-apply, PK→unique ordering, view kind via PERSISTENT mapping
> tables, guarded column sync) + `_lib/warehouse-tables.ts` `internalTable()`
> (shared-SQL table naming across all three warehouses) + pg branches across
> op-export / op-auto-group(-run) / column-specs / hourly processor / one-time
> flow / read+lookup routes / run-export routes. **Exit criteria met live**
> (`npm run test:pg-lifecycle`): 19 checks — zero-LLM lookup-hit tick, export
> values/mirror/PK-physical-order/mapped-only, grant survives swap, live view
> shows new known-value rows with no rebuild, column-mode fill + steady-state
> 0-row guard (n_tup_upd delta), 6k drain across two 5k installments.
- Distinct scans with app-side normalize + cap; `bulkUpsertMappings` /
  queue ops on ON CONFLICT; staging-join export builder (reuse
  `materializeAliasStaging`) with transactional swap + ACL re-apply;
  ordering tiers (PK → unique → none; Postgres has no clustering keys —
  two-tier); view kind enabled; column mode behind the consent ladder;
  one-time flow (personal-connection fallback, create/overwrite, 20k cap,
  refuse `prism_internal` targets); lookup export default
  `<db>.prism_exports.<name>_lookup`.
- **Exit criteria** (live, `npm run test:pg-lifecycle`): full detect →
  standardize → export lifecycle incl. >5k installment drain; grant survives
  swap; view export queries correctly; one-time end-to-end on both
  connections.

### Phase P4 — Setup, onboarding, credentials · ~1 wk

> **STATUS: implemented 2026-08-11** — migration 018 (workspace + personal
> pg_* credential columns); routes: `workspace-postgres` (live-test-before-
> save, blank-keeps-secret, env adoption, clear), `pg-config` (personal),
> warehouse-type accepts 'postgres', install-script `?warehouse=postgres`,
> verify-install postgres scope (catalog probes), test-snowflake status arm;
> setup wizard PostgreSQL platform card + StepInstallScriptPostgres (psql
> instructions, role templates, per-schema grants generator w/ default-
> privileges footgun note) + StepCredentialsPostgres (sslmode select) +
> non-admin personal variant; warehouse labels (use-warehouse-label,
> ExportLookupModal prism_exports default, terms/privacy warehouseName).
> **Exit criteria met live** (`npm run test:pg-setup`): workspace choice
> drives the factory, encrypted workspace + personal credential round-trips,
> one-time create/overwrite export, JSONB file rows.
- Wizard step-1 gains the PostgreSQL card; `StepInstallScriptPostgres`
  (script + role templates + default-privileges grants generator — the
  Part D analog) ; `StepCredentialsPostgres` → `POST /api/accounts/
  workspace-postgres` (live-test before save, platform assert, blank-keeps-
  secret); `pg-config` personal-credentials route + non-admin variant;
  verify-install catalog probes; SQLite migration from §3; `/home` gate is
  already warehouse-agnostic.
- **Exit criteria** (live, `npm run test:pg-setup`): fresh install completes
  the wizard incl. under `PRISM_FRESH_SETUP`; creates a pipeline end-to-end.

### Phase P5 — Docs + QA hardening · ~1–1.5 wk

> **STATUS: docs implemented 2026-08-11** — WAREHOUSES.md PostgreSQL section,
> CLIENT_ONBOARDING Appendix C (one-database scope, grants recipe + footgun,
> kill switch, scale-to-zero warning, PUBLIC-grants RBAC check),
> SECURITY_AND_DISCLOSURES pg credential inventory, CLAUDE.md commands/env/
> library rows. REMAINING (needs infrastructure/time this session doesn't
> have): postgres:13 floor validation, a managed provider (RDS) + one
> scale-to-zero provider (Neon) live pass, failure-mode drills beyond the
> suites' coverage. Run before the first real Postgres customer.
- `CLIENT_ONBOARDING.md` Appendix C (install runbook, one-database scope,
  role/grant recipe incl. default-privileges footgun, kill switch, RLS note,
  cost model + scale-to-zero warning, zero-grants RBAC spot check — Postgres
  is default-deny but PUBLIC schema grants are its classic hole: revoke
  `CREATE ON SCHEMA public` check).
- `SECURITY_AND_DISCLOSURES.md` pg credential inventory;
  `docs/WAREHOUSES.md` third column across the matrix; CLAUDE.md env vars +
  invariants.
- Environment matrix: Docker 13 (floor) + 16; RDS; one scale-to-zero
  provider (Neon free tier) to validate the cadence stretch. Failure drills:
  revoke mid-run, drop table under a live pipeline, kill connection
  mid-export (the `'validating'` guard), counter reset mid-cycle.

---

## 5. Snowflake / SQL Server → Postgres translation reference

| Concern | Snowflake | SQL Server | PostgreSQL |
|---|---|---|---|
| Install scope | Account (PRISM_DB) | Server (PRISM_DB) | **One database** (`prism_internal` schema) |
| Change detection | Streams | CT → diff-scan | **Diff-scan only** (trigger fast path deferred) |
| Cheap "anything new?" | `SYSTEM$STREAM_HAS_DATA` | DMV / CT version | `pg_stat_user_tables` counters |
| Normalization in SQL | JS UDF | None — app-side + staging | None — app-side + staging (PG `normalize()` exists, deliberately unused) |
| Staging join collation | n/a | `Latin1_General_100_BIN2` | `COLLATE "C"` |
| Bulk upsert | MERGE, ~65k binds, 5k batches | MERGE HOLDLOCK, ~2.1k binds, small batches | `ON CONFLICT`, 65,535 binds, 5k batches |
| Export rebuild | `CREATE OR REPLACE … COPY GRANTS` | Build+swap+re-grant (sp_rename) | Build+swap+re-grant (**transactional DDL**) |
| View export kind | Yes | **Refused** | Yes (offboarding materialize caveat applies) |
| Masking analog | `POLICY_REFERENCES` | `sys.masked_columns` | **Row-Level Security** (`relrowsecurity`) |
| Identifier folding | Unquoted → UPPER | Preserved | Unquoted → **lower** |
| JSON | VARIANT | NVARCHAR(MAX)+ISJSON | JSONB |
| Service identity | PRISM_SVC user, key-pair | prism_svc login, SQL/Entra | `prism_svc` LOGIN role, password + sslmode |
| Kill switch | `SET DISABLED = TRUE` | `ALTER LOGIN … DISABLE` | `ALTER ROLE … NOLOGIN` |
| Cost trap | Warehouse wake-time | Serverless Azure auto-pause | **Neon / Aurora scale-to-zero** |
| Binds | `?` | `@pN` (translated) | `$n` (translated) |

---

## 6. Risks and open questions

1. **One-database scope surprises multi-DB customers** — surface it in the
   wizard AND the landing page fine print, not just docs.
2. **Scale-to-zero detection is heuristic** — host-sniffing Neon/Aurora is
   best-effort; the onboarding doc must carry the real warning. Revisit if a
   customer bill complaint ever materializes.
3. **Default-privileges footgun** (grants only cover objects created by the
   role that ran ALTER DEFAULT PRIVILEGES) — the Part D generator must emit
   per-owning-role statements or document the limitation loudly.
4. **Diff-scan latency is the only story in v1** (~1–5 min detection by
   tier) — fine for the ICP; the trigger fast path is the answer if a
   prospect needs less, and it's consent-gated DDL when it comes.
5. **Live-suite infrastructure is cheap here** (official Docker image, no
   Rosetta/licensing) — there is no excuse to skip the P2/P3/P4 live suites;
   they are the port's actual safety net, as they were for mssql.

---

## 7. Definition of done

A Postgres install (Docker or RDS), provisioned per CLIENT_ONBOARDING
Appendix C, passes: 5-step wizard → first pipeline (connect → review →
accept → activate) → new row detected within its scan tier and standardized
at the next tick → deleted row gone after the next rebuild → view-kind export
queries correctly → one-time standardization via personal credentials →
lookup export to all formats → overnight idle with zero table reads
(verified via pg_stat_statements) — with Snowflake AND mssql regressions
green (tsc, build, parity, and both platforms' live suites).
