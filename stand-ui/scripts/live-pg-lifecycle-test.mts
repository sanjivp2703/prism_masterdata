/**
 * Phase P3 exit-criteria test: the full Postgres detect → standardize → export
 * lifecycle, LIVE against the docs/DEV_POSTGRES.md container
 * (docs/POSTGRES_PORT_PLAN.md).
 *
 *   PG_ADMIN_PASSWORD='...' npm run test:pg-lifecycle
 *
 * All standardization here is lookup-seeded (100% hash hits) so the tick makes
 * ZERO LLM calls — the dummy ANTHROPIC_API_KEY below is never used.
 *
 * Covered: queue drain through the real tick processor (processPipelineQueue)
 * with mapping writes + dequeue + freshness stamp · table-kind export rebuild
 * (values standardized, unwatched columns mirrored, PK physical order,
 * mapped-only default drops unmapped rows) · SELECT grant surviving the swap ·
 * view-kind export (live view: a new row of a KNOWN value appears through the
 * view with no rebuild) · column-kind companion sync (values filled, guarded
 * steady-state second sync updates 0 rows) · 6k bulk drain across two 5k
 * installments (ON CONFLICT batching under the pg bind budget).
 */

process.env.PRISM_WAREHOUSE_TYPE = 'postgres';
process.env.PRISM_SQLITE_PATH = `/tmp/prism-pg-lc-test-${process.pid}.db`;
process.env.ANTHROPIC_API_KEY = 'dummy-never-called';
process.env.PG_HOST ??= 'localhost';
process.env.PG_DATABASE ??= 'prism_dev';
process.env.PG_USER ??= 'prism_svc';
process.env.PG_PASSWORD ??= 'PrismSvc!Dev1';
process.env.PG_SSLMODE ??= 'disable';
const ADMIN_PASSWORD = process.env.PG_ADMIN_PASSWORD ?? 'PrismDev!Passw0rd';

const { getDb } = await import('../app/api/_lib/sqlite');
const { withAdHocPostgres } = await import('../app/api/_lib/warehouse/postgres/connection');
const { getWarehouseAdapter } = await import('../app/api/_lib/warehouse');
const { processPipelineQueue, fetchPipelineById } = await import('../app/api/_lib/pipeline-hourly-processor');
const { refreshExportTable } = await import('../app/api/_lib/export-table');
const { normalizeLiteral } = await import('../app/api/_lib/normalize');

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const adapter = getWarehouseAdapter();
const DBNAME = process.env.PG_DATABASE!;
const admin = <T,>(fn: (conn: any) => Promise<T>) =>
  withAdHocPostgres(
    { host: process.env.PG_HOST!, database: DBNAME, user: process.env.PG_ADMIN_USER ?? 'postgres', password: ADMIN_PASSWORD, sslmode: 'disable' },
    fn,
  );
const svcQ = (sql: string, binds?: any[]) => adapter.withConnection((c) => adapter.executeQuery(c, sql, binds));
const settle = () => new Promise((r) => setTimeout(r, 700));

const SRC = 'test_sources.lc_src';
const SRC_FQN = `${DBNAME}.test_sources.lc_src`;
const EXP_FQN = `${DBNAME}.prism_exports.lc_out`;
const VIEW_FQN = `${DBNAME}.prism_exports.lc_view`;
const SPEC = 9903;

// ── Fixture ──────────────────────────────────────────────────────────────────
await admin(async (c) => {
  await c.query(`DROP VIEW IF EXISTS prism_exports.lc_view`);
  await c.query(`DROP TABLE IF EXISTS ${SRC} CASCADE`);
  await c.query(`DROP TABLE IF EXISTS prism_exports.lc_out`);
  await c.query(`DROP TABLE IF EXISTS prism_internal."viewmap_lc" `).catch(() => {});
  await c.query(`CREATE TABLE ${SRC} (id INT PRIMARY KEY, carrier VARCHAR(200), city VARCHAR(100))`);
  // Deliberately inserted OUT of PK order to prove the physical ORDER BY.
  await c.query(`INSERT INTO ${SRC} (id, carrier, city) VALUES
    (5, 'VZW', 'Austin'), (3, 'att', 'Boston'), (1, 'AT&T', 'Chicago'),
    (4, 'T-Mobile', 'Denver'), (2, 'Verizon', 'Erie'), (6, 'UnknownCo', 'Fargo')`);
  await c.query(`GRANT SELECT ON ${SRC} TO prism_service`);
  // Consent-time column-mode provisioning (simulated admin run):
  await c.query(`GRANT UPDATE ON ${SRC} TO prism_service`);

  // Lookup seed: AT&T family + Verizon family + T-Mobile mapped; UnknownCo NOT.
  await c.query(`DELETE FROM prism_internal.literal_alias_matches WHERE domain_id = ${SPEC}`);
  await c.query(`DELETE FROM prism_internal.approved_alias_names WHERE domain_id = ${SPEC}`);
  const pairs: Array<[string, string]> = [
    ['AT&T', 'AT&T'], ['att', 'AT&T'], ['Verizon', 'Verizon'], ['VZW', 'Verizon'], ['T-Mobile', 'T-Mobile'],
  ];
  for (const alias of ['AT&T', 'Verizon', 'T-Mobile']) {
    await c.query(`INSERT INTO prism_internal.approved_alias_names (alias_name, domain_id) VALUES ($1, ${SPEC})`, [alias]);
  }
  for (const [lit, alias] of pairs) {
    await c.query(
      `INSERT INTO prism_internal.literal_alias_matches (literal_value, normalized_value, alias_id, domain_id, run_id)
       SELECT $1, $2, alias_id, ${SPEC}, 990301 FROM prism_internal.approved_alias_names WHERE alias_name = $3 AND domain_id = ${SPEC}`,
      [lit, normalizeLiteral(lit), alias],
    );
  }
  await c.query(`DELETE FROM prism_internal.pipeline_queue WHERE pipeline_id IN (990300, 990310)`);
  // Queue holds the already-mapped values (the legitimate "queued before their
  // mappings were exported by a sibling" state) → 100% lookup hits, zero LLM.
  for (const lit of ['AT&T', 'att', 'Verizon', 'VZW', 'T-Mobile']) {
    await c.query(`INSERT INTO prism_internal.pipeline_queue (pipeline_id, literal_value, source_frequency) VALUES (990300, $1, 1)`, [lit]);
  }
});

const db = getDb();
db.prepare(
  `INSERT INTO pipelines (pipeline_id, name, table_fqn, column_name, domain_id, status, update_schedule, export_table_fqn, export_kind, export_unmapped_rows)
   VALUES (990300, 'lc-test', ?, 'carrier', ${SPEC}, 'active', '{"type":"always"}', ?, 'table', 0)`,
).run(SRC_FQN, EXP_FQN);
db.prepare(`UPDATE pipelines SET queue_size = 5 WHERE pipeline_id = 990300`).run();

// ── 1. Tick standardization: 100% lookup hits, zero LLM, full drain ──────────
{
  const pipeline = await fetchPipelineById(990300);
  check('fixture pipeline resolves', pipeline != null);
  await processPipelineQueue(pipeline!);
  const q = await svcQ(`SELECT COUNT(*) AS c FROM prism_internal.pipeline_queue WHERE pipeline_id = 990300`);
  check('queue fully drained by the tick', Number(q[0]?.c) === 0, q[0]);
  const row = db.prepare(`SELECT queue_size, fully_synced_at, total_mapped FROM pipelines WHERE pipeline_id = 990300`).get() as any;
  check('queue_size metric 0', Number(row?.queue_size) === 0, row);
  check('fully_synced_at stamped after drain', row?.fully_synced_at != null, row);
}

// ── 2. Table export: standardized values, mirror columns, PK order, mapped-only ──
{
  const rows = await svcQ(`SELECT id, carrier, city FROM prism_exports.lc_out`);
  check('export table exists with rows', rows.length > 0, rows.length);
  const byId = new Map(rows.map((r: any) => [Number(r.id), r]));
  check('watched column standardized (att → AT&T)', byId.get(3)?.carrier === 'AT&T', byId.get(3));
  check('watched column standardized (VZW → Verizon)', byId.get(5)?.carrier === 'Verizon', byId.get(5));
  check('unwatched column mirrored raw', byId.get(1)?.city === 'Chicago', byId.get(1));
  check('unmapped row dropped (export_unmapped_rows=0)', !byId.has(6), rows.length);
  check('mapped rows all present (5 of 6)', rows.length === 5, rows.length);
  // Physical PK order: ctid order should match id order after the ordered CTAS.
  const phys = await svcQ(`SELECT id FROM prism_exports.lc_out ORDER BY ctid`);
  check('physical write order follows PK', JSON.stringify(phys.map((r: any) => Number(r.id))) === JSON.stringify([1, 2, 3, 4, 5]), phys);
}

// ── 3. Grant survives the swap ───────────────────────────────────────────────
{
  await admin(async (c) => {
    // A leftover role from a previous run may still hold grants — revoke them
    // all first (DROP ROLE refuses while privileges exist).
    await c.query(`DROP OWNED BY lc_consumer`).catch(() => {});
    await c.query(`DROP ROLE IF EXISTS lc_consumer`);
    await c.query(`CREATE ROLE lc_consumer NOLOGIN`);
    await c.query(`GRANT USAGE ON SCHEMA prism_exports TO lc_consumer`);
  });
  await svcQ(`GRANT SELECT ON prism_exports.lc_out TO lc_consumer`);
  await adapter.withConnection((c) =>
    refreshExportTable(SRC_FQN, 'carrier', EXP_FQN, SPEC, 990300, 'table').then(() => undefined),
  ).catch(() => refreshExportTable(SRC_FQN, 'carrier', EXP_FQN, SPEC, 990300, 'table'));
  const acl = await admin(async (c) => {
    const r = await c.query(
      `SELECT 1 FROM information_schema.role_table_grants
       WHERE table_schema = 'prism_exports' AND table_name = 'lc_out' AND grantee = 'lc_consumer' AND privilege_type = 'SELECT'`,
    );
    return r.rowCount ?? 0;
  });
  check('consumer SELECT grant survives the rebuild swap', acl === 1, acl);
}

// ── 6. 6k bulk drain across two 5k installments ──────────────────────────────
{
  await admin(async (c) => {
    await c.query(`DELETE FROM prism_internal.pipeline_queue WHERE pipeline_id = 990300`);
    // 6,000 pre-mapped values → queue. Batched inserts.
    await c.query(`DELETE FROM prism_internal.literal_alias_matches WHERE run_id = 990302`);
    await c.query(`DELETE FROM prism_internal.approved_alias_names WHERE alias_name = '__BULK__' AND domain_id = ${SPEC}`);
    await c.query(`INSERT INTO prism_internal.approved_alias_names (alias_name, domain_id) VALUES ('__BULK__', ${SPEC})`);
    const aid = Number((await c.query(`SELECT alias_id FROM prism_internal.approved_alias_names WHERE alias_name = '__BULK__' AND domain_id = ${SPEC}`)).rows[0].alias_id);
    const CH = 1000;
    for (let base = 0; base < 6000; base += CH) {
      const lits = Array.from({ length: CH }, (_, i) => `bulkval_${base + i}`);
      const lamVals = lits.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}, ${aid}, ${SPEC}, 990302)`).join(', ');
      await c.query(
        `INSERT INTO prism_internal.literal_alias_matches (literal_value, normalized_value, alias_id, domain_id, run_id) VALUES ${lamVals}`,
        lits.flatMap((l) => [l, l]),
      );
      const qVals = lits.map((_, i) => `(990300, $${i + 1}, 1)`).join(', ');
      await c.query(`INSERT INTO prism_internal.pipeline_queue (pipeline_id, literal_value, source_frequency) VALUES ${qVals}`, lits);
    }
  });
  db.prepare(`UPDATE pipelines SET queue_size = 6000 WHERE pipeline_id = 990300`).run();

  const pipeline = await fetchPipelineById(990300);
  await processPipelineQueue(pipeline!);           // installment 1: 5,000
  const mid = await svcQ(`SELECT COUNT(*) AS c FROM prism_internal.pipeline_queue WHERE pipeline_id = 990300`);
  check('first installment drains exactly 5,000 (1,000 remain)', Number(mid[0]?.c) === 1000, mid[0]);
  await processPipelineQueue(pipeline!);           // installment 2: the tail
  const end = await svcQ(`SELECT COUNT(*) AS c FROM prism_internal.pipeline_queue WHERE pipeline_id = 990300`);
  check('second installment drains the tail', Number(end[0]?.c) === 0, end[0]);
}

// The pipelines UNIQUE(table_fqn, column_name, domain_id) triple means the
// view/column pipelines can't coexist with the table one — sequence them.
db.prepare(`DELETE FROM pipelines WHERE pipeline_id = 990300`).run();

// ── 4. View kind: live view sees new rows of KNOWN values without a rebuild ──
{
  db.prepare(
    `INSERT INTO pipelines (pipeline_id, name, table_fqn, column_name, domain_id, status, update_schedule, export_table_fqn, export_kind, export_unmapped_rows)
     VALUES (990310, 'lc-view', ?, 'carrier', ${SPEC}, 'active', '{"type":"always"}', ?, 'view', 0)`,
  ).run(SRC_FQN, VIEW_FQN);
  await refreshExportTable(SRC_FQN, 'carrier', VIEW_FQN, SPEC, 990310, 'view');
  const v1 = await svcQ(`SELECT COUNT(*) AS c FROM prism_exports.lc_view`);
  check('view export queries correctly', Number(v1[0]?.c) === 5, v1[0]);

  await admin(async (c) => { await c.query(`INSERT INTO ${SRC} (id, carrier, city) VALUES (7, 'att', 'Georgetown')`); });
  const v2 = await svcQ(`SELECT carrier FROM prism_exports.lc_view WHERE city = ?`, ['Georgetown']);
  check('new row of a KNOWN value appears through the live view (no rebuild)', v2[0]?.carrier === 'AT&T', v2[0]);
}

db.prepare(`DELETE FROM pipelines WHERE pipeline_id = 990310`).run();

// ── 5. Column kind: companion sync + steady-state guard ──────────────────────
{
  db.prepare(
    `INSERT INTO pipelines (pipeline_id, name, table_fqn, column_name, domain_id, status, update_schedule, export_table_fqn, export_kind, export_unmapped_rows)
     VALUES (990320, 'lc-col', ?, 'carrier', ${SPEC}, 'active', '{"type":"always"}', ?, 'column', 0)`,
  ).run(SRC_FQN, SRC_FQN);
  // The service role owns no ALTER on the customer table — companion added by
  // the admin (consent provisioning), then Prism only UPDATEs.
  // Same identifier case the real consent SQL (columnModeSetupSqlPg) creates —
  // quoted pg identifiers are case-sensitive.
  await admin(async (c) => { await c.query(`ALTER TABLE ${SRC} ADD COLUMN IF NOT EXISTS "carrier_STANDARDIZED" VARCHAR(450)`); });
  await refreshExportTable(SRC_FQN, 'carrier', SRC_FQN, SPEC, 990320, 'column');
  const src = await svcQ(`SELECT id, carrier, "carrier_STANDARDIZED" AS std FROM ${SRC} ORDER BY id`);
  const by = new Map(src.map((r: any) => [Number(r.id), r]));
  check('companion filled for mapped values', by.get(3)?.std === 'AT&T' && by.get(5)?.std === 'Verizon', by.get(3));
  check('companion NULL for unmapped value', by.get(6)?.std == null, by.get(6));

  await settle();
  const updBefore = await admin(async (c) => Number((await c.query(`SELECT n_tup_upd FROM pg_stat_user_tables WHERE schemaname='test_sources' AND relname='lc_src'`)).rows[0]?.n_tup_upd ?? 0));
  await refreshExportTable(SRC_FQN, 'carrier', SRC_FQN, SPEC, 990320, 'column');
  await settle();
  const updAfter = await admin(async (c) => Number((await c.query(`SELECT n_tup_upd FROM pg_stat_user_tables WHERE schemaname='test_sources' AND relname='lc_src'`)).rows[0]?.n_tup_upd ?? 0));
  check('steady-state column sync updates 0 rows (change guards hold)', updAfter === updBefore, { updBefore, updAfter });
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
await admin(async (c) => {
  await c.query(`DELETE FROM prism_internal.pipeline_queue WHERE pipeline_id IN (990300, 990310, 990320)`);
  await c.query(`DELETE FROM prism_internal.literal_alias_matches WHERE run_id IN (990301, 990302) OR domain_id = ${SPEC}`);
  await c.query(`DELETE FROM prism_internal.approved_alias_names WHERE domain_id = ${SPEC}`);
  await c.query(`DROP VIEW IF EXISTS prism_exports.lc_view`);
  await c.query(`DROP TABLE IF EXISTS prism_exports.lc_out`);
  await c.query(`DROP TABLE IF EXISTS ${SRC} CASCADE`);
  await c.query(`DROP OWNED BY lc_consumer`).catch(() => {});
  await c.query(`DROP ROLE IF EXISTS lc_consumer`).catch(() => {});
  const maps = await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'prism_internal' AND table_name LIKE 'viewmap_%'`);
  for (const m of maps.rows) await c.query(`DROP TABLE IF EXISTS prism_internal."${m.table_name}"`);
});

if (failures > 0) {
  console.error(`\n${failures} live lifecycle check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll live postgres lifecycle checks passed.');
