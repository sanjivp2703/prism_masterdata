/**
 * Phase M2 exit-criteria test: the MySQL detection engine, LIVE against the
 * docs/DEV_MYSQL.md container (docs/MYSQL_PORT_PLAN.md).
 *
 *   MYSQL_ROOT_PASSWORD='...' npm run test:mysql-detection
 *
 * Drives pollOneMysqlPipeline (the REAL orchestrator) against a real source
 * table, with an isolated SQLite for pipeline state. Admin-side mutations run
 * as root — playing the customer's application writing to their own table.
 *
 * Covered: diff-mode init + baseline queue · UPDATE_TIME heartbeat idle-skip
 * with ZERO table reads (proven via performance_schema I/O counters) ·
 * new-value detection · known-value non-requeue · corrupt/backwards heartbeat
 * fail-open · stats-expiry freshness (a write is visible the SAME minute,
 * not 24h later) · dropped-table pause. NOT covered (documented deltas vs
 * pg): no delete flag (UPDATE_TIME can't see deletes — hourly rebuild
 * covers), no RLS analog.
 */

process.env.PRISM_WAREHOUSE_TYPE = 'mysql';
process.env.PRISM_SQLITE_PATH = `/tmp/prism-mysql-det-test-${process.pid}.db`;
process.env.MYSQL_HOST ??= 'localhost';
process.env.MYSQL_USER ??= 'prism_svc';
process.env.MYSQL_PASSWORD ??= 'PrismSvc!Dev1';
process.env.MYSQL_SSL ??= 'false';
const ROOT_PASSWORD = process.env.MYSQL_ROOT_PASSWORD ?? 'PrismDev!Passw0rd';

const { getDb } = await import('../app/api/_lib/sqlite');
const { withAdHocMysql } = await import('../app/api/_lib/warehouse/mysql/connection');
const { pollOneMysqlPipeline } = await import('../app/api/_lib/pipeline-poller-mysql');
const { getWarehouseAdapter } = await import('../app/api/_lib/warehouse');

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const adapter = getWarehouseAdapter();
const TBL = 'test_sources.det_test_carriers';
const FQN = 'test_sources.det_test_carriers'; // MySQL FQNs are 2-part
const admin = <T,>(fn: (conn: any) => Promise<T>) =>
  withAdHocMysql(
    { host: process.env.MYSQL_HOST!, user: process.env.MYSQL_ADMIN_USER ?? 'root', password: ROOT_PASSWORD, ssl: 'false' },
    fn,
  );
const svc = <T,>(fn: (conn: any) => Promise<T>) => adapter.withConnection(fn);

// UPDATE_TIME has SECOND granularity — writes inside the same second as the
// previous marker read would be invisible. 1.2s settle keeps checks honest
// (production polls at minute cadence, where this cannot bite).
const settle = () => new Promise((r) => setTimeout(r, 1_200));

// ── Fixture ──────────────────────────────────────────────────────────────────
await admin(async (c) => {
  await adapter.executeQuery(c, `DROP TABLE IF EXISTS ${TBL}`);
  await adapter.executeQuery(c, `CREATE TABLE ${TBL} (row_id INT AUTO_INCREMENT PRIMARY KEY, carrier VARCHAR(200)) ENGINE=InnoDB`);
  await adapter.executeQuery(c, `INSERT INTO ${TBL} (carrier) VALUES ('AT&T'), ('ATT'), ('Verizon'), ('VZW'), ('T-Mobile')`);
  await adapter.executeQuery(c, `GRANT SELECT ON test_sources.* TO 'prism_service'`);
  // Seed one KNOWN value in the lookup so filterUnknownValues excludes it.
  await adapter.executeQuery(c, `DELETE FROM prism_internal.literal_alias_matches WHERE domain_id = ?`, [9902]);
  await adapter.executeQuery(c, `DELETE FROM prism_internal.approved_alias_names WHERE domain_id = ?`, [9902]);
  await adapter.executeQuery(c, `INSERT INTO prism_internal.approved_alias_names (alias_name, domain_id) VALUES ('__DET_KNOWN__', 9902)`);
  await adapter.executeQuery(
    c,
    `INSERT INTO prism_internal.literal_alias_matches (literal_value, normalized_value, alias_id, domain_id, run_id)
     SELECT 'Verizon', 'verizon', alias_id, 9902, 990201 FROM prism_internal.approved_alias_names WHERE alias_name = '__DET_KNOWN__' AND domain_id = 9902`,
  );
  await adapter.executeQuery(c, `DELETE FROM prism_internal.pipeline_queue WHERE pipeline_id = ?`, [990200]);
});
await settle();

const db = getDb();
db.prepare(
  `INSERT INTO pipelines (pipeline_id, name, table_fqn, column_name, domain_id, status, update_schedule)
   VALUES (990200, 'det-test', ?, 'carrier', 9902, 'active', '{"type":"always"}')`,
).run(FQN);

const ref = () => {
  const r = db.prepare(`SELECT status, status_message, detection_mode, detection_state, queue_size, total_source_values FROM pipelines WHERE pipeline_id = 990200`).get() as any;
  return { ...r, state: r?.detection_state ? JSON.parse(r.detection_state) : null };
};
const pollRef = () => {
  const r = ref();
  return { pipeline_id: 990200, table_fqn: FQN, column_name: 'carrier', domain_id: 9902, export_table_fqn: null, status_message: r.status_message ?? null };
};
const queueRows = () =>
  svc(async (c) => (await adapter.executeQuery(c, `SELECT literal_value FROM prism_internal.pipeline_queue WHERE pipeline_id = ? ORDER BY literal_value`, [990200])).map((r: any) => String(r.literal_value)));
// performance_schema I/O counters — the "did anything actually READ the
// table" proof (information_schema probes are metadata and do not appear).
const sourceReads = () =>
  admin(async (c) => {
    const r = await adapter.executeQuery(
      c,
      `SELECT COALESCE(SUM(COUNT_READ), 0) AS total_reads FROM performance_schema.table_io_waits_summary_by_table
       WHERE OBJECT_SCHEMA = 'test_sources' AND OBJECT_NAME = 'det_test_carriers'`,
    );
    return Number(r[0]?.total_reads ?? 0);
  });

// ── 1. First poll: init + baseline scan queues unknown values ────────────────
{
  const res = await pollOneMysqlPipeline(pollRef());
  const r = ref();
  check('first poll checked', res.checked === true, res);
  check('detection_mode persisted as diff', r.detection_mode === 'diff', r.detection_mode);
  check('diff_reason is mysql_diff', r.state?.diff_reason === 'mysql_diff', r.state);
  const q = await queueRows();
  check('unknown values queued (known “Verizon” excluded)',
    q.length === 4 && q.includes('AT&T') && q.includes('ATT') && q.includes('VZW') && q.includes('T-Mobile') && !q.includes('Verizon'), q);
  check('queue_size metric updated', ref().queue_size === 4, ref().queue_size);
  check('total_source_values counted', ref().total_source_values === 5, ref().total_source_values);
}

// ── 2. Idle poll: heartbeat equal → zero table reads ─────────────────────────
{
  await settle();
  const before = await sourceReads();
  const res = await pollOneMysqlPipeline(pollRef());
  const after = await sourceReads();
  check('idle poll reports checked', res.checked === true, res);
  check('idle poll did NOT read the source table (perf-schema I/O unchanged)', after === before, { before, after });
}

// ── 3. New value: heartbeat moves → scan → queued (freshness, not 24h cache) ─
{
  await admin(async (c) => { await adapter.executeQuery(c, `INSERT INTO ${TBL} (carrier) VALUES ('Sprint')`); });
  await settle();
  const res = await pollOneMysqlPipeline(pollRef());
  const q = await queueRows();
  check('new value detected + queued the SAME minute (stats_expiry=0 is live)', q.includes('Sprint'), q);
  check('poll after insert reports checked', res.checked === true);
}

// ── 4. New row of a KNOWN value: heartbeat moves, nothing re-queues ──────────
{
  const before = await queueRows();
  await admin(async (c) => { await adapter.executeQuery(c, `INSERT INTO ${TBL} (carrier) VALUES ('Verizon')`); });
  await settle();
  await pollOneMysqlPipeline(pollRef());
  const after = await queueRows();
  check('known value does not re-queue (lookup hit excluded)', JSON.stringify(after) === JSON.stringify(before), after);
}

// ── 5. Delete: documented delta — NO same-cycle flag on mysql ────────────────
{
  await admin(async (c) => { await adapter.executeQuery(c, `DELETE FROM ${TBL} WHERE carrier = 'ATT'`); });
  await settle();
  const res = await pollOneMysqlPipeline(pollRef());
  check('delete does NOT flag a rebuild (UPDATE_TIME is delete-blind; hourly rebuild covers)', res.needsExportRefresh === false, res);
  check('delete cycle still completes (scan ran, nothing new)', res.checked === true, res);
}

// ── 6. Corrupt/backwards heartbeat fails OPEN (scan, no crash) ───────────────
{
  const r = ref();
  const corrupted = { ...r.state, heartbeat: '2099-12-31T23:59:59', passes_since_scan: 0 };
  db.prepare(`UPDATE pipelines SET detection_state = ? WHERE pipeline_id = 990200`).run(JSON.stringify(corrupted));
  const res = await pollOneMysqlPipeline(pollRef());
  check('corrupt/backwards heartbeat tolerated (poll completes, fails open into a scan)', res.checked === true, res);
  const healed = ref().state?.heartbeat;
  check('heartbeat re-stamped from reality after the scan', healed !== '2099-12-31T23:59:59', healed);
}

// ── 7. Dropped table: pause with message ─────────────────────────────────────
{
  await admin(async (c) => { await adapter.executeQuery(c, `DROP TABLE ${TBL}`); });
  await pollOneMysqlPipeline({ ...pollRef(), status_message: 'force-health-check' });
  const r = ref();
  check('dropped table pauses the pipeline', r.status === 'paused', r.status);
  check('pause message mentions access', String(r.status_message ?? '').toLowerCase().includes('access') || String(r.status_message ?? '').includes('no longer exists'), r.status_message);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
await admin(async (c) => {
  await adapter.executeQuery(c, `DELETE FROM prism_internal.pipeline_queue WHERE pipeline_id = ?`, [990200]);
  await adapter.executeQuery(c, `DELETE FROM prism_internal.literal_alias_matches WHERE domain_id = ?`, [9902]);
  await adapter.executeQuery(c, `DELETE FROM prism_internal.approved_alias_names WHERE domain_id = ?`, [9902]);
  await adapter.executeQuery(c, `DROP TABLE IF EXISTS ${TBL}`);
});

if (failures > 0) {
  console.error(`\n${failures} live detection check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll live mysql detection checks passed.');
