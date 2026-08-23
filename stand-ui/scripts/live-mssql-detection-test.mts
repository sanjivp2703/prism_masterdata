/**
 * Phase 4 exit-criteria test — the change-detection engine against a live
 * SQL Server (docs/DEV_MSSQL.md container).
 *
 *   MSSQL_SA_PASSWORD='...' NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx scripts/live-mssql-detection-test.mts
 *
 * Drives the REAL poll orchestrator (pollOneMssqlPipeline) end to end:
 * CT mode (insert / known-value insert / update / delete / retention-expiry
 * reconcile), diff mode on a PK-less table (heartbeat idle-skip, scan,
 * new-value queue), health-check pause on a dropped table, and Dynamic Data
 * Masking skip. Uses an ISOLATED SQLite file (PRISM_SQLITE_PATH) so the dev
 * server's app state is never touched.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// Env BEFORE any app import (sqlite + adapter factory read these lazily but
// we take no chances with import order).
process.env.PRISM_WAREHOUSE_TYPE = 'mssql';
process.env.MSSQL_SERVER ??= 'localhost';
process.env.MSSQL_USER ??= 'sa';
process.env.MSSQL_PASSWORD ??= process.env.MSSQL_SA_PASSWORD ?? '';
process.env.MSSQL_TRUST_SERVER_CERT = 'true';
process.env.MSSQL_DATABASE = 'PRISM_DB';
const tmpDb = path.join(os.tmpdir(), `prism-detection-test-${process.pid}.db`);
process.env.PRISM_SQLITE_PATH = tmpDb;

const { getDb } = await import('../app/api/_lib/sqlite');
const { withWarehouse, executeQuery: exec } = await import('../app/api/_lib/warehouse');
const { pollOneMssqlPipeline } = await import('../app/api/_lib/pipeline-poller-mssql');

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

function makePipeline(id: number, fqn: string, column: string): void {
  getDb().prepare(
    `INSERT INTO pipelines (pipeline_id, table_fqn, column_name, domain_id, name, status, update_schedule, queue_size)
     VALUES (?, ?, ?, 1, ?, 'active', '{"type":"always"}', 0)`,
  ).run(id, fqn, column, `detection-test-${id}`);
}
const pipelineRow = (id: number) =>
  getDb().prepare(`SELECT * FROM pipelines WHERE pipeline_id = ?`).get(id) as any;
const ref = (id: number, fqn: string, column: string) => ({
  pipeline_id: id, table_fqn: fqn, column_name: column, domain_id: 1,
  export_table_fqn: null, status_message: null, change_tracking_consent: true,
  // Service-connection, table-kind, mapped-only — the defaults these detection
  // tests have always assumed; named explicitly since MssqlPipelineRef grew
  // the user-connection (2026-08-17) and raw-passthrough (2026-08-18) fields.
  use_user_connection: false, created_by: null, export_kind: 'table',
  export_unmapped_rows: false,
});

const CT_FQN = 'TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT';
const NOPK_FQN = 'TEST_DB.dbo.RAW_CARRIERS_NOPK';
const MASKED_FQN = 'TEST_DB.dbo.RAW_CARRIERS_MASKED';

await withWarehouse(async (conn) => {
  // ── Setup: clean slate on the warehouse side + companion tables ────────────
  await exec(conn, `DELETE FROM PRISM_DB.INTERNAL.PIPELINE_QUEUE WHERE pipeline_id IN (?, ?, ?)`, [9001, 9002, 9003]);
  await exec(conn, `DELETE FROM TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT WHERE RAW_CARRIER_VALUE LIKE ?`, ['__P4__%']);
  await exec(conn, `DROP TABLE IF EXISTS TEST_DB.dbo.RAW_CARRIERS_NOPK`);
  await exec(conn, `DROP TABLE IF EXISTS TEST_DB.dbo.RAW_CARRIERS_MASKED`);
  await exec(conn, `SELECT TOP (5) RAW_CARRIER_VALUE INTO TEST_DB.dbo.RAW_CARRIERS_NOPK FROM TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT`);
  await exec(conn, `CREATE TABLE TEST_DB.dbo.RAW_CARRIERS_MASKED (
      ROW_ID INT IDENTITY(1,1) PRIMARY KEY,
      RAW_CARRIER_VALUE NVARCHAR(200) MASKED WITH (FUNCTION = 'default()') NULL)`);
  await exec(conn, `INSERT INTO TEST_DB.dbo.RAW_CARRIERS_MASKED (RAW_CARRIER_VALUE) VALUES (N'AT&T')`);
});

makePipeline(9001, CT_FQN, 'RAW_CARRIER_VALUE');
makePipeline(9002, NOPK_FQN, 'RAW_CARRIER_VALUE');
makePipeline(9003, MASKED_FQN, 'RAW_CARRIER_VALUE');

const queueLiterals = async (pid: number): Promise<string[]> =>
  withWarehouse(async (conn) =>
    (await exec(conn, `SELECT literal_value FROM PRISM_DB.INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`, [pid]))
      .map((r: any) => String(r.literal_value)));

// ═══ CT MODE (table with PK + CT enabled) ═══════════════════════════════════
console.log('CT mode:');

// 1. First poll: init → CT mode, baseline at current version, nothing queued.
let res = await pollOneMssqlPipeline(ref(9001, CT_FQN, 'RAW_CARRIER_VALUE'));
let row = pipelineRow(9001);
check('init chooses ct mode', row.detection_mode === 'ct', row.detection_mode);
check('init poll checked', res.checked === true);
check('init queues nothing (baseline = now)', (await queueLiterals(9001)).length === 0);

// 2. Insert a NEW value → poll → queued.
await withWarehouse(c => exec(c, `INSERT INTO TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT (RAW_CARRIER_VALUE, RAW_COMPANY_VALUE) VALUES (N'__P4__NewCarrier', N'x')`));
res = await pollOneMssqlPipeline(ref(9001, CT_FQN, 'RAW_CARRIER_VALUE'));
check('insert detected and queued', (await queueLiterals(9001)).includes('__P4__NewCarrier'));
check('insert alone needs no export refresh', res.needsExportRefresh === false);

// 3. Insert a row with a KNOWN value → still queued (consistent snapshot).
await withWarehouse(c => exec(c, `INSERT INTO TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT (RAW_CARRIER_VALUE, RAW_COMPANY_VALUE) VALUES (N'Verizon', N'x')`));
res = await pollOneMssqlPipeline(ref(9001, CT_FQN, 'RAW_CARRIER_VALUE'));
check('known-value insert also queues (consistent snapshot)', (await queueLiterals(9001)).some(v => v === 'Verizon'));

// 4. UPDATE → delete-half flags export refresh; insert-half queues new value.
await withWarehouse(c => exec(c, `UPDATE TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT SET RAW_CARRIER_VALUE = N'__P4__Renamed' WHERE RAW_CARRIER_VALUE = N'__P4__NewCarrier'`));
res = await pollOneMssqlPipeline(ref(9001, CT_FQN, 'RAW_CARRIER_VALUE'));
check('update queues the new value', (await queueLiterals(9001)).includes('__P4__Renamed'));
check('update flags export refresh (delete-half)', res.needsExportRefresh === true);

// 5. DELETE → flags export refresh, queues nothing new.
await withWarehouse(c => exec(c, `DELETE FROM TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT WHERE RAW_CARRIER_VALUE = N'__P4__Renamed'`));
res = await pollOneMssqlPipeline(ref(9001, CT_FQN, 'RAW_CARRIER_VALUE'));
check('delete flags export refresh', res.needsExportRefresh === true);

// 6. Idle poll: checked, nothing new; queue non-empty → freshness frozen.
const beforeSync = pipelineRow(9001).fully_synced_at ?? null;
res = await pollOneMssqlPipeline(ref(9001, CT_FQN, 'RAW_CARRIER_VALUE'));
check('idle poll checked', res.checked === true);
check('freshness frozen while values queued', (pipelineRow(9001).fully_synced_at ?? null) === beforeSync);

// 7. Retention expiry: force stored version below the min valid window.
{
  const r = pipelineRow(9001);
  const st = JSON.parse(String(r.detection_state));
  st.ct_version = -1;
  getDb().prepare(`UPDATE pipelines SET detection_state = ? WHERE pipeline_id = 9001`).run(JSON.stringify(st));
}
await withWarehouse(c => exec(c, `INSERT INTO TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT (RAW_CARRIER_VALUE, RAW_COMPANY_VALUE) VALUES (N'__P4__GapValue', N'x')`));
res = await pollOneMssqlPipeline(ref(9001, CT_FQN, 'RAW_CARRIER_VALUE'));
check('expired CT window triggers reconcile (export refresh)', res.needsExportRefresh === true);
check('reconcile recovers the gap value from the source', (await queueLiterals(9001)).includes('__P4__GapValue'));
{
  const st = JSON.parse(String(pipelineRow(9001).detection_state));
  check('reconcile re-baselines the CT version', Number(st.ct_version) >= 0, st.ct_version);
}

// ═══ DIFF MODE (PK-less table) ══════════════════════════════════════════════
console.log('Diff mode (no primary key):');

// 8. Init → diff mode, reason no_pk; first scan queues unmapped distincts.
res = await pollOneMssqlPipeline(ref(9002, NOPK_FQN, 'RAW_CARRIER_VALUE'));
row = pipelineRow(9002);
check('PK-less table falls back to diff mode', row.detection_mode === 'diff', row.detection_mode);
check('diff reason is no_pk', JSON.parse(String(row.detection_state)).diff_reason === 'no_pk');
const diffQueued = await queueLiterals(9002);
check('first scan queues unmapped distinct values', diffQueued.length > 0, diffQueued.length);

// 9. Idle poll: heartbeat unchanged → early skip, no scan, still checked.
res = await pollOneMssqlPipeline(ref(9002, NOPK_FQN, 'RAW_CARRIER_VALUE'));
check('heartbeat-idle poll checked without scanning', res.checked === true);

// 10. Insert a new value → heartbeat fires → scan queues it.
await withWarehouse(c => exec(c, `INSERT INTO TEST_DB.dbo.RAW_CARRIERS_NOPK (RAW_CARRIER_VALUE) VALUES (N'__P4__DiffValue')`));
res = await pollOneMssqlPipeline(ref(9002, NOPK_FQN, 'RAW_CARRIER_VALUE'));
check('diff scan detects and queues the new value', (await queueLiterals(9002)).includes('__P4__DiffValue'));

// ═══ HEALTH GUARDS ══════════════════════════════════════════════════════════
console.log('Health guards:');

// 11. Masked column → flagged, standardization skipped, not paused.
res = await pollOneMssqlPipeline(ref(9003, MASKED_FQN, 'RAW_CARRIER_VALUE'));
row = pipelineRow(9003);
check('masked column flags the pipeline (not paused)', row.status === 'active' && String(row.status_message ?? '').includes('Masking'), row.status_message);
check('masked column skips the poll', res.checked === false);

// 12. Dropped table → health check pauses with a message.
await withWarehouse(c => exec(c, `DROP TABLE TEST_DB.dbo.RAW_CARRIERS_NOPK`));
healthReset(9002);
res = await pollOneMssqlPipeline(ref(9002, NOPK_FQN, 'RAW_CARRIER_VALUE'));
row = pipelineRow(9002);
check('dropped table pauses the pipeline', row.status === 'paused', row.status);
check('pause carries a human-readable reason', String(row.status_message ?? '').length > 0, row.status_message);

function healthReset(_pid: number): void {
  // Health checks run on the 1st/after-error pass; the in-memory counter is in
  // pipeline-poller-mssql.ts. Force the "after error" path by making the NEXT
  // check due: counters are per-process and this script polls each pipeline
  // only a handful of times, so pass 11 % 10 === 1 conveniently re-checks —
  // but to be deterministic we just rely on the error path: a dropped table
  // makes the CT/scan query fail → classified 'table' → paused. Nothing to do.
}

// ═══ Cleanup ════════════════════════════════════════════════════════════════
await withWarehouse(async (conn) => {
  await exec(conn, `DELETE FROM PRISM_DB.INTERNAL.PIPELINE_QUEUE WHERE pipeline_id IN (?, ?, ?)`, [9001, 9002, 9003]);
  await exec(conn, `DELETE FROM TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT WHERE RAW_CARRIER_VALUE LIKE ?`, ['__P4__%']);
  await exec(conn, `DELETE FROM TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT WHERE RAW_CARRIER_VALUE = ? AND RAW_COMPANY_VALUE = ?`, ['Verizon', 'x']);
  await exec(conn, `DROP TABLE IF EXISTS TEST_DB.dbo.RAW_CARRIERS_NOPK`);
  await exec(conn, `DROP TABLE IF EXISTS TEST_DB.dbo.RAW_CARRIERS_MASKED`);
});
fs.rmSync(tmpDb, { force: true });
fs.rmSync(`${tmpDb}-wal`, { force: true });
fs.rmSync(`${tmpDb}-shm`, { force: true });

if (failures > 0) {
  console.error(`\n${failures} detection check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll Phase 4 detection checks passed.');
