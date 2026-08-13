/**
 * Phase M3 exit-criteria test: the full MySQL detect → standardize → export
 * lifecycle, LIVE against the docs/DEV_MYSQL.md container
 * (docs/MYSQL_PORT_PLAN.md).
 *
 *   MYSQL_ROOT_PASSWORD='...' npm run test:mysql-lifecycle
 *
 * All standardization here is lookup-seeded (100% hash hits) so the tick makes
 * ZERO LLM calls — the dummy ANTHROPIC_API_KEY below is never used.
 *
 * Covered: queue drain through the real tick processor · table-kind export
 * rebuild (values standardized, unwatched columns mirrored, PK physical order
 * via the ordered CTAS + clustered index, mapped-only default) · SELECT grant
 * surviving the atomic RENAME swap · view-kind export (live view: new row of a
 * KNOWN value appears with no rebuild) · column-kind companion sync (values
 * filled, guarded steady-state second sync writes 0 rows — proven via
 * performance_schema write counters) · 6k bulk drain across two 5k
 * installments.
 */

process.env.PRISM_WAREHOUSE_TYPE = 'mysql';
process.env.PRISM_SQLITE_PATH = `/tmp/prism-mysql-lc-test-${process.pid}.db`;
process.env.ANTHROPIC_API_KEY = 'dummy-never-called';
process.env.MYSQL_HOST ??= 'localhost';
process.env.MYSQL_USER ??= 'prism_svc';
process.env.MYSQL_PASSWORD ??= 'PrismSvc!Dev1';
process.env.MYSQL_SSL ??= 'false';
const ROOT_PASSWORD = process.env.MYSQL_ROOT_PASSWORD ?? 'PrismDev!Passw0rd';

const { getDb } = await import('../app/api/_lib/sqlite');
const { withAdHocMysql } = await import('../app/api/_lib/warehouse/mysql/connection');
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
const admin = <T,>(fn: (conn: any) => Promise<T>) =>
  withAdHocMysql(
    { host: process.env.MYSQL_HOST!, user: process.env.MYSQL_ADMIN_USER ?? 'root', password: ROOT_PASSWORD, ssl: 'false' },
    fn,
  );
const adminQ = (sql: string, binds?: any[]) => admin((c) => adapter.executeQuery(c, sql, binds));
const svcQ = (sql: string, binds?: any[]) => adapter.withConnection((c) => adapter.executeQuery(c, sql, binds));
const settle = () => new Promise((r) => setTimeout(r, 1_200));

const SRC = 'test_sources.lc_src';
const SRC_FQN = 'test_sources.lc_src';        // MySQL FQNs are 2-part
const EXP_FQN = 'prism_exports.lc_out';
const VIEW_FQN = 'prism_exports.lc_view';
const SPEC = 9903;

// ── Fixture ──────────────────────────────────────────────────────────────────
await admin(async (c) => {
  const q = (sql: string, binds?: any[]) => adapter.executeQuery(c, sql, binds);
  await q(`DROP VIEW IF EXISTS prism_exports.lc_view`);
  await q(`DROP TABLE IF EXISTS prism_exports.lc_out`);
  await q(`DROP TABLE IF EXISTS ${SRC}`);
  await q(`CREATE TABLE ${SRC} (id INT PRIMARY KEY, carrier VARCHAR(200), city VARCHAR(100)) ENGINE=InnoDB`);
  // Deliberately inserted OUT of PK order to prove the physical ORDER BY.
  await q(`INSERT INTO ${SRC} (id, carrier, city) VALUES
    (5, 'VZW', 'Austin'), (3, 'att', 'Boston'), (1, 'AT&T', 'Chicago'),
    (4, 'T-Mobile', 'Denver'), (2, 'Verizon', 'Erie'), (6, 'UnknownCo', 'Fargo')`);
  await q(`GRANT SELECT ON test_sources.* TO 'prism_service'`);
  // Consent-time column-mode provisioning (simulated admin run):
  await q(`GRANT UPDATE ON ${SRC} TO 'prism_service'`);
  await q(`GRANT UPDATE ON test_sources.* TO 'prism_service'`);

  await q(`DELETE FROM prism_internal.pipeline_queue WHERE pipeline_id IN (990300, 990310, 990320)`);
  await q(`DELETE FROM prism_internal.literal_alias_matches WHERE domain_id = ?`, [SPEC]);
  await q(`DELETE FROM prism_internal.approved_alias_names WHERE domain_id = ?`, [SPEC]);
  for (const alias of ['AT&T', 'Verizon', 'T-Mobile']) {
    await q(`INSERT INTO prism_internal.approved_alias_names (alias_name, domain_id) VALUES (?, ${SPEC})`, [alias]);
  }
  const pairs: Array<[string, string]> = [
    ['AT&T', 'AT&T'], ['att', 'AT&T'], ['Verizon', 'Verizon'], ['VZW', 'Verizon'], ['T-Mobile', 'T-Mobile'],
  ];
  for (const [lit, alias] of pairs) {
    await q(
      `INSERT INTO prism_internal.literal_alias_matches (literal_value, normalized_value, alias_id, domain_id, run_id)
       SELECT ?, ?, alias_id, ${SPEC}, 990301 FROM prism_internal.approved_alias_names WHERE alias_name = ? AND domain_id = ${SPEC}`,
      [lit, normalizeLiteral(lit), alias],
    );
  }
  // Queue the already-mapped values (the legitimate "queued before their
  // mappings were exported by a sibling" state) → 100% lookup hits, zero LLM.
  for (const lit of ['AT&T', 'att', 'Verizon', 'VZW', 'T-Mobile']) {
    await q(`INSERT INTO prism_internal.pipeline_queue (pipeline_id, literal_value, source_frequency) VALUES (990300, ?, 1)`, [lit]);
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
  const row = db.prepare(`SELECT queue_size, fully_synced_at FROM pipelines WHERE pipeline_id = 990300`).get() as any;
  check('queue_size metric 0', Number(row?.queue_size) === 0, row);
  check('fully_synced_at stamped after drain', row?.fully_synced_at != null, row);
}

// ── 2. Table export: standardized values, mirror columns, PK order, mapped-only ──
{
  const rows = await svcQ(`SELECT id, carrier, city FROM prism_exports.lc_out ORDER BY id`);
  check('export table exists with rows', rows.length > 0, rows.length);
  const byId = new Map(rows.map((r: any) => [Number(r.id), r]));
  check('watched column standardized (att → AT&T)', byId.get(3)?.carrier === 'AT&T', byId.get(3));
  check('watched column standardized (VZW → Verizon)', byId.get(5)?.carrier === 'Verizon', byId.get(5));
  check('unwatched column mirrored raw', byId.get(1)?.city === 'Chicago', byId.get(1));
  check('unmapped row dropped (export_unmapped_rows=0)', !byId.has(6), rows.length);
  check('mapped rows all present (5 of 6)', rows.length === 5, rows.length);
  // Physical order: a CTAS table without a PK gets InnoDB's hidden rowid
  // clustered index = insertion order, so an unordered SELECT reads back in
  // the ordered-CTAS write order.
  const phys = await svcQ(`SELECT id FROM prism_exports.lc_out`);
  check('physical write order follows PK', JSON.stringify(phys.map((r: any) => Number(r.id))) === JSON.stringify([1, 2, 3, 4, 5]), phys);
}

// ── 3. Grant survives the atomic RENAME swap ─────────────────────────────────
{
  await adminQ(`CREATE ROLE IF NOT EXISTS 'lc_consumer'`);
  await adminQ(`GRANT SELECT ON prism_exports.lc_out TO 'lc_consumer'`);
  await refreshExportTable(SRC_FQN, 'carrier', EXP_FQN, SPEC, 990300, 'table');
  const acl = await adminQ(
    `SELECT COUNT(*) AS c FROM information_schema.TABLE_PRIVILEGES
     WHERE TABLE_SCHEMA = 'prism_exports' AND TABLE_NAME = 'lc_out' AND GRANTEE LIKE ? AND PRIVILEGE_TYPE = 'SELECT'`,
    ["%lc_consumer%"],
  );
  check('consumer SELECT grant survives the RENAME swap', Number(acl[0]?.c) === 1, acl[0]);
}

// ── 4. 6k bulk drain across two 5k installments ──────────────────────────────
{
  await admin(async (c) => {
    const q = (sql: string, binds?: any[]) => adapter.executeQuery(c, sql, binds);
    await q(`DELETE FROM prism_internal.pipeline_queue WHERE pipeline_id = 990300`);
    await q(`DELETE FROM prism_internal.literal_alias_matches WHERE run_id = 990302`);
    await q(`INSERT INTO prism_internal.approved_alias_names (alias_name, domain_id) VALUES ('__BULK__', ${SPEC})`);
    const aidRows = await q(`SELECT alias_id FROM prism_internal.approved_alias_names WHERE alias_name = '__BULK__' AND domain_id = ${SPEC}`);
    const aid = Number(aidRows[0].alias_id);
    const CH = 1000;
    for (let base = 0; base < 6000; base += CH) {
      const lits = Array.from({ length: CH }, (_, i) => `bulkval_${base + i}`);
      const lamVals = lits.map(() => `(?, ?, ${aid}, ${SPEC}, 990302)`).join(', ');
      await q(
        `INSERT INTO prism_internal.literal_alias_matches (literal_value, normalized_value, alias_id, domain_id, run_id) VALUES ${lamVals}`,
        lits.flatMap((l) => [l, l]),
      );
      const qVals = lits.map(() => `(990300, ?, 1)`).join(', ');
      await q(`INSERT INTO prism_internal.pipeline_queue (pipeline_id, literal_value, source_frequency) VALUES ${qVals}`, lits);
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

// ── 5. View kind: live view sees new rows of KNOWN values without a rebuild ──
{
  db.prepare(
    `INSERT INTO pipelines (pipeline_id, name, table_fqn, column_name, domain_id, status, update_schedule, export_table_fqn, export_kind, export_unmapped_rows)
     VALUES (990310, 'lc-view', ?, 'carrier', ${SPEC}, 'active', '{"type":"always"}', ?, 'view', 0)`,
  ).run(SRC_FQN, VIEW_FQN);
  await refreshExportTable(SRC_FQN, 'carrier', VIEW_FQN, SPEC, 990310, 'view');
  const v1 = await svcQ(`SELECT COUNT(*) AS c FROM prism_exports.lc_view`);
  check('view export queries correctly', Number(v1[0]?.c) === 5, v1[0]);

  await adminQ(`INSERT INTO ${SRC} (id, carrier, city) VALUES (7, 'att', 'Georgetown')`);
  const v2 = await svcQ(`SELECT carrier FROM prism_exports.lc_view WHERE city = ?`, ['Georgetown']);
  check('new row of a KNOWN value appears through the live view (no rebuild)', v2[0]?.carrier === 'AT&T', v2[0]);
}
db.prepare(`DELETE FROM pipelines WHERE pipeline_id = 990310`).run();

// ── 6. Column kind: companion sync + steady-state guard ──────────────────────
{
  db.prepare(
    `INSERT INTO pipelines (pipeline_id, name, table_fqn, column_name, domain_id, status, update_schedule, export_table_fqn, export_kind, export_unmapped_rows)
     VALUES (990320, 'lc-col', ?, 'carrier', ${SPEC}, 'active', '{"type":"always"}', ?, 'column', 0)`,
  ).run(SRC_FQN, SRC_FQN);
  // Companion added by the admin (consent provisioning); MySQL column names
  // are case-insensitive, so exact case is not load-bearing here.
  await adminQ(`ALTER TABLE ${SRC} ADD COLUMN \`carrier_STANDARDIZED\` VARCHAR(450) NULL`);
  await refreshExportTable(SRC_FQN, 'carrier', SRC_FQN, SPEC, 990320, 'column');
  const src = await svcQ(`SELECT id, carrier, \`carrier_STANDARDIZED\` AS std FROM ${SRC} ORDER BY id`);
  const by = new Map(src.map((r: any) => [Number(r.id), r]));
  check('companion filled for mapped values', by.get(3)?.std === 'AT&T' && by.get(5)?.std === 'Verizon', by.get(3));
  check('companion NULL for unmapped value', by.get(6)?.std == null, by.get(6));

  await settle();
  const writesBefore = await adminQ(
    `SELECT COALESCE(SUM(COUNT_WRITE), 0) AS w FROM performance_schema.table_io_waits_summary_by_table
     WHERE OBJECT_SCHEMA = 'test_sources' AND OBJECT_NAME = 'lc_src'`,
  );
  await refreshExportTable(SRC_FQN, 'carrier', SRC_FQN, SPEC, 990320, 'column');
  const writesAfter = await adminQ(
    `SELECT COALESCE(SUM(COUNT_WRITE), 0) AS w FROM performance_schema.table_io_waits_summary_by_table
     WHERE OBJECT_SCHEMA = 'test_sources' AND OBJECT_NAME = 'lc_src'`,
  );
  check('steady-state column sync writes 0 rows (change guards hold)', Number(writesAfter[0]?.w) === Number(writesBefore[0]?.w), { before: writesBefore[0], after: writesAfter[0] });
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
await admin(async (c) => {
  const q = (sql: string, binds?: any[]) => adapter.executeQuery(c, sql, binds);
  await q(`DELETE FROM prism_internal.pipeline_queue WHERE pipeline_id IN (990300, 990310, 990320)`);
  await q(`DELETE FROM prism_internal.literal_alias_matches WHERE domain_id = ?`, [SPEC]);
  await q(`DELETE FROM prism_internal.approved_alias_names WHERE domain_id = ?`, [SPEC]);
  await q(`DROP VIEW IF EXISTS prism_exports.lc_view`);
  await q(`DROP TABLE IF EXISTS prism_exports.lc_out`);
  await q(`DROP TABLE IF EXISTS ${SRC}`);
  await q(`DROP ROLE IF EXISTS 'lc_consumer'`);
  const maps = await q(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'prism_internal' AND table_name LIKE 'viewmap_%'`);
  for (const m of maps) await q(`DROP TABLE IF EXISTS prism_internal.\`${String(m.t)}\``);
});

if (failures > 0) {
  console.error(`\n${failures} live lifecycle check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll live mysql lifecycle checks passed.');
