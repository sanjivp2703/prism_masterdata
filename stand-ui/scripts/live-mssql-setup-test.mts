/**
 * Phase 6/7 exit-criteria test — workspace-choice resolution, workspace-tier
 * credentials, personal credentials, the one-time export writer, and file
 * pipelines on SQL Server.
 *
 *   MSSQL_SA_PASSWORD='...' NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx scripts/live-mssql-setup-test.mts
 *
 * Isolated SQLite; the container from docs/DEV_MSSQL.md.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// NOTE: no PRISM_WAREHOUSE_TYPE here — this test proves the WORKSPACE choice
// (SQLite) drives the factory, with encrypted workspace credentials.
process.env.PRISM_ENCRYPTION_KEY ??= 'a'.repeat(64);
const tmpDb = path.join(os.tmpdir(), `prism-setup-test-${process.pid}.db`);
process.env.PRISM_SQLITE_PATH = tmpDb;

const SA_PASSWORD = process.env.MSSQL_SA_PASSWORD ?? '';

const { getDb } = await import('../app/api/_lib/sqlite');
const { encryptSecret } = await import('../app/api/_lib/crypto');
const { getWarehouseAdapter, invalidateWarehouseTypeCache, withWarehouse, withUserWarehouse, hasUserWarehouseConfig, executeQuery: exec } = await import('../app/api/_lib/warehouse');
const { invalidateWorkspaceMsConfig, mssqlServiceConnectionSource } = await import('../app/api/_lib/warehouse/mssql/connection');
const { exportOneTimeToSnowflake } = await import('../app/api/_lib/op-one-time');
const { insertOneTimeFileRows, readOneTimeDistinctValues, deleteOneTimeFileRows } = await import('../app/api/_lib/op-one-time-file');
const { normalizeLiteral } = await import('../app/api/_lib/normalize');

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

// ── Workspace choice + workspace-tier credentials ────────────────────────────
console.log('Workspace resolution:');
check('fresh install resolves snowflake', getWarehouseAdapter().kind === 'snowflake');

const db = getDb();
db.prepare(`INSERT OR IGNORE INTO workspace_config (id, sf_account, sf_user, sf_warehouse) VALUES (1, '', '', '')`).run();
db.prepare(
  `UPDATE workspace_config
   SET warehouse_type = 'mssql', ms_server = 'localhost', ms_port = 1433, ms_database = 'PRISM_DB',
       ms_user = 'sa', ms_password = ?, ms_encrypt = 1, ms_trust_server_cert = 1
   WHERE id = 1`,
).run(encryptSecret(SA_PASSWORD));
invalidateWarehouseTypeCache();
invalidateWorkspaceMsConfig();

check('workspace choice switches the factory to mssql', getWarehouseAdapter().kind === 'mssql');
check('service connection source is workspace', mssqlServiceConnectionSource() === 'workspace');

await withWarehouse(async (conn) => {
  const rows = await exec(conn, `SELECT DB_NAME() AS d`);
  check('workspace-tier credentials connect (encrypted round-trip)', rows[0]?.d === 'PRISM_DB', rows[0]);
});

// ── Personal credentials (one-time fallback) ─────────────────────────────────
console.log('Personal credentials:');
db.prepare(
  `INSERT INTO accounts (google_id, email, name, role, ms_server, ms_port, ms_database, ms_user, ms_password)
   VALUES ('setup-test', 'setup-test@example.com', 'Setup Test', 'user', 'localhost', 1433, 'PRISM_DB', 'sa', ?)`,
).run(encryptSecret(SA_PASSWORD));
const accountId = Number((db.prepare(`SELECT account_id FROM accounts WHERE google_id = 'setup-test'`).get() as any).account_id);
check('hasUserConfig sees personal mssql creds', hasUserWarehouseConfig(accountId) === true);
await withUserWarehouse(accountId, async (conn) => {
  const rows = await exec(conn, `SELECT SUSER_SNAME() AS u`);
  check('personal connection works', String(rows[0]?.u ?? '').length > 0);
});

// ── One-time export writer ────────────────────────────────────────────────────
console.log('One-time export (create + overwrite):');
await withWarehouse(async (conn) => {
  await exec(conn, `DROP TABLE IF EXISTS TEST_DB.dbo.OT_TARGET`);
  const args = {
    source_relation: 'TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT',
    target_fqn: 'TEST_DB.dbo.OT_TARGET',
    mode: 'create' as const,
    nonce: 'p7test',
    columns: [{
      column_name: 'RAW_CARRIER_VALUE',
      mappings: [
        { raw: 'ATT', standardized: 'AT&T' },
        { raw: 'TMobile', standardized: 'T-Mobile' },
        { raw: 'VZW', standardized: 'Verizon' },
      ],
    }],
  };
  const created = await exportOneTimeToSnowflake(conn, args as any);
  check('create-mode export writes all source rows', created.rows_written === 28, created);

  const [std] = await exec(conn, `SELECT TOP (1) RAW_CARRIER_VALUE AS v FROM TEST_DB.dbo.OT_TARGET WHERE RAW_COMPANY_VALUE = N'Goldman Sachs & Co'`);
  check('mapped value standardized (ATT → AT&T)', std?.v === 'AT&T', std?.v);
  const [raw] = await exec(conn, `SELECT TOP (1) RAW_CARRIER_VALUE AS v FROM TEST_DB.dbo.OT_TARGET WHERE RAW_COMPANY_VALUE = N'McKinsey'`);
  check('unmapped value falls through raw (Verizon row untouched by other maps)', raw?.v === 'Verizon', raw?.v);

  // Overwrite path: existing target → DELETE + INSERT (permission-preserving).
  const overwritten = await exportOneTimeToSnowflake(conn, { ...args, mode: 'overwrite' } as any);
  check('overwrite-mode export succeeds on existing target', overwritten.rows_written === 28, overwritten);
  await exec(conn, `DROP TABLE IF EXISTS TEST_DB.dbo.OT_TARGET`);
});

// ── One-time file rows (JSON rows) ────────────────────────────────────────────
// File PIPELINES were removed on the warehouse-only-pipelines branch — files
// and Google Sheets are one-time sources now. Same coverage intent (JSON row
// insert + normalized-dedup distinct read), against ONE_TIME_FILE_ROWS.
console.log('One-time file rows:');
await withWarehouse(async (conn) => {
  const nonce = 'setup-test-nonce';
  await deleteOneTimeFileRows(conn, nonce);
  await insertOneTimeFileRows(conn, nonce, [
    { Carrier: 'ATT', Company: "O'Brien & Sons" },
    { Carrier: 'AT&T', Company: 'Acme' },
    { Carrier: 'T Mobile', Company: 'Beta LLC' },
    { Carrier: 'att', Company: 'Gamma' },
  ]);
  const distinct = await readOneTimeDistinctValues(conn, nonce, 'Carrier');
  check('one-time file rows insert + distinct read (normalized dedup: att≡ATT)', distinct.length === 3, distinct);
  const att = distinct.find(d => normalizeLiteral(d.literal_value) === 'att');
  check('frequency summed across normalized dupes', (att?.source_frequency ?? 0) === 2, distinct);
  await deleteOneTimeFileRows(conn, nonce);
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
fs.rmSync(tmpDb, { force: true });
fs.rmSync(`${tmpDb}-wal`, { force: true });
fs.rmSync(`${tmpDb}-shm`, { force: true });

if (failures > 0) {
  console.error(`\n${failures} setup check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll Phase 6/7 setup checks passed.');
