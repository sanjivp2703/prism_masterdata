/**
 * Phase P4 exit-criteria test — workspace-choice resolution, workspace-tier
 * credentials, personal credentials, the one-time export writer, and one-time
 * file rows on PostgreSQL (docs/POSTGRES_PORT_PLAN.md).
 *
 *   PG_ADMIN_PASSWORD='...' npm run test:pg-setup
 *
 * Isolated SQLite; the container from docs/DEV_POSTGRES.md. Library-layer
 * (same scope as test:mssql-setup — route auth is session-bound and is
 * exercised through the running app, not here).
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

// NOTE: no PRISM_WAREHOUSE_TYPE here — this test proves the WORKSPACE choice
// (SQLite) drives the factory, with encrypted workspace credentials.
process.env.PRISM_ENCRYPTION_KEY ??= 'a'.repeat(64);
const tmpDb = path.join(os.tmpdir(), `prism-pg-setup-test-${process.pid}.db`);
process.env.PRISM_SQLITE_PATH = tmpDb;
delete process.env.PG_HOST; delete process.env.PG_DATABASE; delete process.env.PG_USER; delete process.env.PG_PASSWORD;

const SVC_PASSWORD = 'PrismSvc!Dev1';
const DBNAME = 'prism_dev';

const { getDb } = await import('../app/api/_lib/sqlite');
const { encryptSecret } = await import('../app/api/_lib/crypto');
const { getWarehouseAdapter, invalidateWarehouseTypeCache, withWarehouse, withUserWarehouse, hasUserWarehouseConfig, executeQuery: exec } = await import('../app/api/_lib/warehouse');
const { invalidateWorkspacePgConfig, pgServiceConnectionSource } = await import('../app/api/_lib/warehouse/postgres/connection');
const { exportOneTimeToSnowflake } = await import('../app/api/_lib/op-one-time');
const { insertOneTimeFileRows, readOneTimeDistinctValues, deleteOneTimeFileRows, storeOneTimeFileBlob, loadOneTimeFileBlob } = await import('../app/api/_lib/op-one-time-file');

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
   SET warehouse_type = 'postgres', pg_host = 'localhost', pg_port = 5432, pg_database = ?,
       pg_user = 'prism_svc', pg_password = ?, pg_sslmode = 'disable'
   WHERE id = 1`,
).run(DBNAME, encryptSecret(SVC_PASSWORD));
invalidateWarehouseTypeCache();
invalidateWorkspacePgConfig();

check('workspace choice switches the factory to postgres', getWarehouseAdapter().kind === 'postgres');
check('service connection source is workspace', pgServiceConnectionSource() === 'workspace');

await withWarehouse(async (conn) => {
  const rows = await exec(conn, `SELECT current_database() AS d, current_user AS u`);
  check('workspace-tier credentials connect (encrypted round-trip)', rows[0]?.d === DBNAME && rows[0]?.u === 'prism_svc', rows[0]);
});

// ── Personal credentials (one-time fallback) ─────────────────────────────────
console.log('Personal credentials:');
db.prepare(
  `INSERT INTO accounts (google_id, email, name, role, pg_host, pg_port, pg_database, pg_user, pg_password)
   VALUES ('pg-setup-test', 'pg-setup-test@example.com', 'Setup Test', 'user', 'localhost', 5432, ?, 'prism_svc', ?)`,
).run(DBNAME, encryptSecret(SVC_PASSWORD));
const accountId = Number((db.prepare(`SELECT account_id FROM accounts WHERE google_id = 'pg-setup-test'`).get() as any).account_id);
check('hasUserConfig sees personal pg creds', (await hasUserWarehouseConfig(accountId)) === true);
await withUserWarehouse(accountId, async (conn) => {
  const rows = await exec(conn, `SELECT current_user AS u`);
  check('personal connection works', String(rows[0]?.u ?? '').length > 0, rows[0]);
});

// ── One-time export writer ────────────────────────────────────────────────────
console.log('One-time export (create + overwrite):');
await withWarehouse(async (conn) => {
  await exec(conn, `DROP TABLE IF EXISTS prism_exports.ot_target`);
  const args = {
    source_relation: `${DBNAME}.test_sources.raw_mobile_carriers_short`,
    target_fqn: `${DBNAME}.prism_exports.ot_target`,
    mode: 'create' as const,
    nonce: 'p4test',
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

  // Overwrite path: existing target → staged transactional DELETE + INSERT.
  const overwritten = await exportOneTimeToSnowflake(conn, { ...args, mode: 'overwrite' } as any);
  check('overwrite-mode export succeeds on existing target', overwritten.rows_written === 28, overwritten);
  await exec(conn, `DROP TABLE IF EXISTS prism_exports.ot_target`);
});

// ── One-time file rows (JSONB) ────────────────────────────────────────────────
console.log('One-time file rows:');
await withWarehouse(async (conn) => {
  await deleteOneTimeFileRows(conn, '__pg_setup__');
  await insertOneTimeFileRows(conn, '__pg_setup__', [
    { Carrier: 'ATT', Company: "O'Brien & Sons" },
    { Carrier: 'AT&T', Company: 'Acme' },
    { Carrier: 'T Mobile', Company: 'Beta LLC' },
    { Carrier: 'att', Company: 'Gamma' },
  ]);
  const distinct = await readOneTimeDistinctValues(conn, '__pg_setup__', 'Carrier');
  check('file rows insert + distinct read (normalized dedup: att≡ATT)', distinct.length === 3, distinct);

  // Original-file blob round trip (edit-in-place export storage) — chunked
  // store, ordered reassembly, lifecycle shared with the rows.
  const fakeFile = Buffer.from('Name,Carrier\nAcme,att\n', 'utf8').toString('base64');
  await storeOneTimeFileBlob(conn, '__pg_setup__', { file_name: 'export.csv', file_kind: 'csv', sheet_name: null, header_row: 0 }, fakeFile);
  const blob = await loadOneTimeFileBlob(conn, '__pg_setup__');
  check('original-file blob round trip', blob?.file_kind === 'csv' && blob?.dataB64 === fakeFile && blob?.header_row === 0, blob?.file_name);

  await deleteOneTimeFileRows(conn, '__pg_setup__');
  const gone = await loadOneTimeFileBlob(conn, '__pg_setup__');
  check('blob deleted with the rows (shared lifecycle)', gone === null, gone);
});

// ── Cleanup ───────────────────────────────────────────────────────────────────
fs.rmSync(tmpDb, { force: true });
fs.rmSync(`${tmpDb}-wal`, { force: true });
fs.rmSync(`${tmpDb}-shm`, { force: true });

if (failures > 0) {
  console.error(`\n${failures} setup check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll Phase P4 setup checks passed.');
