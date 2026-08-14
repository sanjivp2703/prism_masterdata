/**
 * Phase M4 exit-criteria test — workspace-choice resolution, workspace-tier
 * credentials, personal credentials, the one-time export writer, and one-time
 * file rows on MySQL (docs/MYSQL_PORT_PLAN.md).
 *
 *   MYSQL_ROOT_PASSWORD='...' npm run test:mysql-setup
 *
 * Isolated SQLite; the container from docs/DEV_MYSQL.md. Library-layer
 * (same scope as the pg/mssql setup suites — route auth is session-bound and
 * is exercised through the running app, not here).
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// NOTE: no PRISM_WAREHOUSE_TYPE here — this test proves the WORKSPACE choice
// (SQLite) drives the factory, with encrypted workspace credentials.
process.env.PRISM_ENCRYPTION_KEY ??= 'a'.repeat(64);
const tmpDb = path.join(os.tmpdir(), `prism-mysql-setup-test-${process.pid}.db`);
process.env.PRISM_SQLITE_PATH = tmpDb;
delete process.env.MYSQL_HOST; delete process.env.MYSQL_USER; delete process.env.MYSQL_PASSWORD; delete process.env.MYSQL_DATABASE;

const SVC_PASSWORD = 'PrismSvc!Dev1';

const { getDb } = await import('../app/api/_lib/sqlite');
const { encryptSecret } = await import('../app/api/_lib/crypto');
const { getWarehouseAdapter, invalidateWarehouseTypeCache, withWarehouse, withUserWarehouse, hasUserWarehouseConfig, executeQuery: exec } = await import('../app/api/_lib/warehouse');
const { invalidateWorkspaceMyConfig, mysqlServiceConnectionSource } = await import('../app/api/_lib/warehouse/mysql/connection');
const { exportOneTimeToSnowflake } = await import('../app/api/_lib/op-one-time');
const { insertOneTimeFileRows, readOneTimeDistinctValues, deleteOneTimeFileRows } = await import('../app/api/_lib/op-one-time-file');

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
   SET warehouse_type = 'mysql', my_host = 'localhost', my_port = 3306, my_database = 'prism_internal',
       my_user = 'prism_svc', my_password = ?, my_ssl = 'false'
   WHERE id = 1`,
).run(encryptSecret(SVC_PASSWORD));
invalidateWarehouseTypeCache();
invalidateWorkspaceMyConfig();

check('workspace choice switches the factory to mysql', getWarehouseAdapter().kind === 'mysql');
check('service connection source is workspace', mysqlServiceConnectionSource() === 'workspace');

await withWarehouse(async (conn) => {
  const rows = await exec(conn, `SELECT DATABASE() AS d, CURRENT_USER() AS u`);
  check('workspace-tier credentials connect (encrypted round-trip)', rows[0]?.d === 'prism_internal' && String(rows[0]?.u ?? '').startsWith('prism_svc'), rows[0]);
});

// ── Personal credentials (one-time fallback) ─────────────────────────────────
console.log('Personal credentials:');
db.prepare(
  `INSERT INTO accounts (google_id, email, name, role, my_host, my_port, my_database, my_user, my_password)
   VALUES ('mysql-setup-test', 'mysql-setup-test@example.com', 'Setup Test', 'user', 'localhost', 3306, 'prism_internal', 'prism_svc', ?)`,
).run(encryptSecret(SVC_PASSWORD));
const accountId = Number((db.prepare(`SELECT account_id FROM accounts WHERE google_id = 'mysql-setup-test'`).get() as any).account_id);
check('hasUserConfig sees personal mysql creds', (await hasUserWarehouseConfig(accountId)) === true);
await withUserWarehouse(accountId, async (conn) => {
  const rows = await exec(conn, `SELECT CURRENT_USER() AS u`);
  check('personal connection works', String(rows[0]?.u ?? '').length > 0, rows[0]);
});

// ── One-time export writer ────────────────────────────────────────────────────
console.log('One-time export (create + overwrite):');
await withWarehouse(async (conn) => {
  await exec(conn, `DROP TABLE IF EXISTS prism_exports.ot_target`);
  const args = {
    source_relation: 'test_sources.raw_mobile_carriers_short',
    target_fqn: 'prism_exports.ot_target',
    mode: 'create' as const,
    nonce: 'm4test',
    columns: [{
      column_name: 'raw_carrier_value',
      mappings: [
        { raw: 'ATT', standardized: 'AT&T' },
        { raw: 'TMobile', standardized: 'T-Mobile' },
        { raw: 'VZW', standardized: 'Verizon' },
      ],
    }],
  };
  const created = await exportOneTimeToSnowflake(conn, args as any);
  check('create-mode export writes all source rows', created.rows_written === 28, created);

  const [std] = await exec(conn, `SELECT raw_carrier_value AS v FROM prism_exports.ot_target WHERE raw_company_value = ? LIMIT 1`, ['Goldman Sachs & Co']);
  check('mapped value standardized (ATT → AT&T)', std?.v === 'AT&T', std?.v);
  const [raw] = await exec(conn, `SELECT raw_carrier_value AS v FROM prism_exports.ot_target WHERE raw_company_value = ? LIMIT 1`, ['McKinsey']);
  check('unmapped value falls through raw', raw?.v === 'Verizon', raw?.v);

  const overwritten = await exportOneTimeToSnowflake(conn, { ...args, mode: 'overwrite' } as any);
  check('overwrite-mode export succeeds on existing target', overwritten.rows_written === 28, overwritten);
  await exec(conn, `DROP TABLE IF EXISTS prism_exports.ot_target`);
});

// ── One-time file rows (native JSON) ─────────────────────────────────────────
console.log('One-time file rows:');
await withWarehouse(async (conn) => {
  await deleteOneTimeFileRows(conn, '__mysql_setup__');
  await insertOneTimeFileRows(conn, '__mysql_setup__', [
    { Carrier: 'ATT', Company: "O'Brien & Sons" },
    { Carrier: 'AT&T', Company: 'Acme' },
    { Carrier: 'T Mobile', Company: 'Beta LLC' },
    { Carrier: 'att', Company: 'Gamma' },
  ]);
  const distinct = await readOneTimeDistinctValues(conn, '__mysql_setup__', 'Carrier');
  check('file rows insert + distinct read (normalized dedup: att≡ATT)', distinct.length === 3, distinct);
  await deleteOneTimeFileRows(conn, '__mysql_setup__');
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
fs.rmSync(tmpDb, { force: true });
fs.rmSync(`${tmpDb}-wal`, { force: true });
fs.rmSync(`${tmpDb}-shm`, { force: true });

if (failures > 0) {
  console.error(`\n${failures} setup check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll Phase M4 setup checks passed.');
