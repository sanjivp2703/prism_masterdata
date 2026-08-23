/**
 * Phase 5 exit-criteria test — the FULL pipeline lifecycle on SQL Server:
 * queue → tick standardization (100% lookup hits ⇒ zero LLM calls) → lookup
 * writes → export rebuild (staging join + transactional swap) → permission
 * survival → dequeue → freshness stamp → >5k bulk drain across installments.
 *
 *   MSSQL_SA_PASSWORD='...' NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx scripts/live-mssql-lifecycle-test.mts
 *
 * Isolated SQLite (PRISM_SQLITE_PATH) — the dev server's app state is never
 * touched. No AI key needed: every queued value is a lookup hit by design.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

process.env.PRISM_WAREHOUSE_TYPE = 'mssql';
process.env.MSSQL_SERVER ??= 'localhost';
process.env.MSSQL_USER ??= 'sa';
process.env.MSSQL_PASSWORD ??= process.env.MSSQL_SA_PASSWORD ?? '';
process.env.MSSQL_TRUST_SERVER_CERT = 'true';
process.env.MSSQL_DATABASE = 'PRISM_DB';
// processPipelineQueue requires an AI provider to be configured, but this
// test's values are 100% lookup hits — the LLM is never actually called, so a
// dummy key satisfies the guard (any real call would fail loudly).
process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test-dummy-never-called';
const tmpDb = path.join(os.tmpdir(), `prism-lifecycle-test-${process.pid}.db`);
process.env.PRISM_SQLITE_PATH = tmpDb;

const { getDb } = await import('../app/api/_lib/sqlite');
const { withWarehouse, executeQuery: exec } = await import('../app/api/_lib/warehouse');
const { bulkUpsertApprovedAliasesMssql, bulkUpsertLiteralMatchesMssql } = await import('../app/api/_lib/warehouse/mssql/mappings');
const { queueValues, getQueueSize } = await import('../app/api/_lib/warehouse/mssql/detection');
const { pollOneMssqlPipeline } = await import('../app/api/_lib/pipeline-poller-mssql');
const { processPipelineQueue } = await import('../app/api/_lib/pipeline-hourly-processor');

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const SRC_FQN = 'TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT';
const EXP_FQN = 'TEST_DB.dbo.CARRIERS_STD';
const PID = 9101;

const CARRIER_MAPPINGS: Array<[string, string]> = [
  ['AT&T', 'AT&T'], ['ATT', 'AT&T'], ['A T & T', 'AT&T'],
  ['American Telephone and Telegraph', 'AT&T'], ['American Telephone & Telegraph Company', 'AT&T'], ['AT and T', 'AT&T'],
  ['Verizon', 'Verizon'], ['Verizon Wireless', 'Verizon'], ['Verizon Wirless', 'Verizon'], ['VZW', 'Verizon'], ['Verizon Communications', 'Verizon'],
  ['T-Mobile', 'T-Mobile'], ['T Mobile', 'T-Mobile'], ['TMobile', 'T-Mobile'], ['T-Mobile USA', 'T-Mobile'],
  ['Sprint', 'Sprint'], ['Sprint PCS', 'Sprint'],
  ['Boost Mobile', 'Boost Mobile'], ['Boost', 'Boost Mobile'],
  ['Cricket', 'Cricket Wireless'], ['Cricket Wireless', 'Cricket Wireless'],
  ['MetroPCS', 'Metro by T-Mobile'], ['Metro PCS', 'Metro by T-Mobile'], ['Metro by T-Mobile', 'Metro by T-Mobile'],
  ['US Cellular', 'UScellular'], ['USCellular', 'UScellular'],
  ['Capital One', 'Capital One'], ['C1', 'Capital One'],
];

const pipelineForProcessing = {
  pipeline_id: PID, table_fqn: SRC_FQN, column_name: 'RAW_CARRIER_VALUE',
  export_table_fqn: EXP_FQN, export_kind: 'table' as const, domain_id: 1,
  domain_name: 'Mobile Carriers', status: 'active', source_type: 'snowflake',
  file_source_meta: null, file_export_meta: null,
};
const pollRef = {
  pipeline_id: PID, table_fqn: SRC_FQN, column_name: 'RAW_CARRIER_VALUE',
  domain_id: 1, export_table_fqn: EXP_FQN, status_message: null, change_tracking_consent: true,
  // As above: service connection, table export, mapped-only.
  use_user_connection: false, created_by: null, export_kind: 'table',
  export_unmapped_rows: false,
};
const pipelineRow = () => getDb().prepare(`SELECT * FROM pipelines WHERE pipeline_id = ?`).get(PID) as any;

// ── Setup ─────────────────────────────────────────────────────────────────────
await withWarehouse(async (conn) => {
  await exec(conn, `DELETE FROM PRISM_DB.INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`, [PID]);
  await exec(conn, `DELETE FROM PRISM_DB.INTERNAL.LITERAL_ALIAS_MATCHES WHERE domain_id = 1`);
  await exec(conn, `DELETE FROM PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES WHERE domain_id = 1`);
  await exec(conn, `DELETE FROM TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT WHERE RAW_COMPANY_VALUE = ?`, ['__P5__']);
  await exec(conn, `DROP TABLE IF EXISTS TEST_DB.dbo.CARRIERS_STD`);

  // Seed the lookup through the REAL mssql write path (exercises the MERGEs).
  const aliasIds = await bulkUpsertApprovedAliasesMssql(conn, CARRIER_MAPPINGS.map(m => m[1]), 1);
  await bulkUpsertLiteralMatchesMssql(
    conn,
    CARRIER_MAPPINGS.map(([lit, alias]) => ({ literalValue: lit, aliasId: aliasIds.get(alias)! })),
    1, 0,
  );
  const seeded = await exec(conn, `SELECT COUNT(*) AS c FROM PRISM_DB.INTERNAL.LITERAL_ALIAS_MATCHES WHERE domain_id = 1`);
  check('lookup seeded via mssql MERGE writers', Number(seeded[0]?.c) === CARRIER_MAPPINGS.length, seeded[0]);
});

getDb().prepare(
  `INSERT INTO pipelines (pipeline_id, table_fqn, column_name, domain_id, name, status, update_schedule, queue_size, export_table_fqn, export_kind)
   VALUES (?, ?, ?, 1, 'lifecycle-test', 'active', '{"type":"always"}', 0, ?, 'table')`,
).run(PID, SRC_FQN, 'RAW_CARRIER_VALUE', EXP_FQN);

// ── Lifecycle round 1: detect → standardize → export ────────────────────────
console.log('Lifecycle round 1 (known values, zero LLM):');

await pollOneMssqlPipeline(pollRef); // init detection (CT baseline)
await withWarehouse(c => exec(c, `INSERT INTO TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT (RAW_CARRIER_VALUE, RAW_COMPANY_VALUE) VALUES (N'TMobile', N'__P5__'), (N'VZW', N'__P5__')`));
await pollOneMssqlPipeline(pollRef);
check('new rows queued by detection', Number(pipelineRow().queue_size) === 2, pipelineRow().queue_size);

await processPipelineQueue(pipelineForProcessing);

const runRow = getDb().prepare(`SELECT run_status FROM runs ORDER BY run_id DESC LIMIT 1`).get() as any;
check('standardization run completed', runRow?.run_status === 'completed', runRow?.run_status);
check('queue drained after export', Number(pipelineRow().queue_size) === 0, pipelineRow().queue_size);
check('freshness stamped on drain', pipelineRow().fully_synced_at != null);

await withWarehouse(async (conn) => {
  const [cnt] = await exec(conn, `SELECT COUNT(*) AS c FROM TEST_DB.dbo.CARRIERS_STD`);
  const [srcCnt] = await exec(conn, `SELECT COUNT(*) AS c FROM TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT`);
  check('export table built with all rows (all values mapped)', Number(cnt.c) === Number(srcCnt.c), { export: cnt.c, source: srcCnt.c });

  const [std] = await exec(conn, `SELECT TOP (1) RAW_CARRIER_VALUE AS v FROM TEST_DB.dbo.CARRIERS_STD WHERE RAW_COMPANY_VALUE = N'PwC'`);
  check('watched column standardized (TMobile row → T-Mobile)', std?.v === 'T-Mobile', std?.v);

  const [raw] = await exec(conn, `SELECT TOP (1) RAW_COMPANY_VALUE AS v FROM TEST_DB.dbo.CARRIERS_STD WHERE RAW_CARRIER_VALUE = N'AT&T'`);
  check('unwatched column passes through raw', raw?.v === 'Goldman Sachs', raw?.v);

  const cols = await exec(conn, `SELECT c.name AS n FROM TEST_DB.sys.columns c WHERE c.object_id = OBJECT_ID('TEST_DB.dbo.CARRIERS_STD')`);
  const names = cols.map((r: any) => String(r.n));
  check('export mirrors source columns exactly (incl. ROW_ID key, no synthetic column)',
    names.length === 3 && names.includes('ROW_ID'), names);

  const ordered = await exec(conn, `SELECT ROW_ID AS id FROM TEST_DB.dbo.CARRIERS_STD ORDER BY ROW_ID`);
  check('source order reconstructable by PK', Number(ordered[0]?.id) < Number(ordered[ordered.length - 1]?.id));
});

// ── Round 2: permissions survive the rebuild ────────────────────────────────
console.log('Round 2 (permission survival):');
// Roles are per-database — create a consumer role in TEST_DB (where the
// export lives), the same shape as a customer's BI-reader role.
await withWarehouse(c => exec(c, `USE TEST_DB; IF DATABASE_PRINCIPAL_ID('P5_CONSUMER') IS NULL CREATE ROLE P5_CONSUMER;`));
await withWarehouse(c => exec(c, `USE TEST_DB; GRANT SELECT ON dbo.CARRIERS_STD TO P5_CONSUMER`));
await withWarehouse(c => exec(c, `INSERT INTO TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT (RAW_CARRIER_VALUE, RAW_COMPANY_VALUE) VALUES (N'Sprint PCS', N'__P5__')`));
await pollOneMssqlPipeline(pollRef);
await processPipelineQueue(pipelineForProcessing);

await withWarehouse(async (conn) => {
  const grants = await exec(
    conn,
    `SELECT dp.name AS grantee, p.permission_name AS perm
     FROM TEST_DB.sys.database_permissions p
     JOIN TEST_DB.sys.database_principals dp ON dp.principal_id = p.grantee_principal_id
     WHERE p.major_id = OBJECT_ID('TEST_DB.dbo.CARRIERS_STD') AND p.class = 1`,
  );
  check('SELECT grant survived the rebuild swap',
    grants.some((g: any) => String(g.grantee) === 'P5_CONSUMER' && String(g.perm).trim() === 'SELECT'), grants);
});

// ── Round 3: >5k bulk drain across installments ─────────────────────────────
console.log('Round 3 (6,000-value bulk drain across installments):');
const BULK = 6_000;
await withWarehouse(async (conn) => {
  const bulkAliases = Array.from({ length: BULK }, (_, i) => `BulkAlias ${i}`);
  const aliasIds = await bulkUpsertApprovedAliasesMssql(conn, bulkAliases, 1);
  check('6k aliases upserted (batched)', aliasIds.size === BULK, aliasIds.size);
  await bulkUpsertLiteralMatchesMssql(
    conn,
    bulkAliases.map((alias, i) => ({ literalValue: `bulk value ${i}`, aliasId: aliasIds.get(alias)! })),
    1, 0,
  );
  await queueValues(conn, PID, Array.from({ length: BULK }, (_, i) => ({ literal_value: `bulk value ${i}`, frequency: 1 })));
  getDb().prepare(`UPDATE pipelines SET queue_size = ? WHERE pipeline_id = ?`).run(BULK, PID);
  check('6k values queued', (await getQueueSize(conn, PID)) === BULK);
});

await processPipelineQueue(pipelineForProcessing);
let midSize = 0;
await withWarehouse(async (conn) => { midSize = await getQueueSize(conn, PID); });
check('first drain takes exactly the 5k installment', midSize === BULK - 5_000, midSize);

await processPipelineQueue(pipelineForProcessing);
let endSize = -1;
await withWarehouse(async (conn) => { endSize = await getQueueSize(conn, PID); });
check('second drain empties the queue', endSize === 0, endSize);

// ── Cleanup ───────────────────────────────────────────────────────────────────
await withWarehouse(async (conn) => {
  await exec(conn, `DELETE FROM PRISM_DB.INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`, [PID]);
  await exec(conn, `DELETE FROM PRISM_DB.INTERNAL.LITERAL_ALIAS_MATCHES WHERE domain_id = 1`);
  await exec(conn, `DELETE FROM PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES WHERE domain_id = 1`);
  await exec(conn, `DELETE FROM TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT WHERE RAW_COMPANY_VALUE = ?`, ['__P5__']);
  await exec(conn, `DROP TABLE IF EXISTS TEST_DB.dbo.CARRIERS_STD`);
});
fs.rmSync(tmpDb, { force: true });
fs.rmSync(`${tmpDb}-wal`, { force: true });
fs.rmSync(`${tmpDb}-shm`, { force: true });

if (failures > 0) {
  console.error(`\n${failures} lifecycle check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll Phase 5 lifecycle checks passed.');
