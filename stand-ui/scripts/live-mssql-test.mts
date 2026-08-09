/**
 * Live smoke test of the mssql warehouse adapter against a local SQL Server
 * (docs/DEV_MSSQL.md container). Exercises the REAL adapter code path:
 * factory → withConnection → executeQuery (?→@pN translation) → error
 * classification, plus schema/grants sanity.
 *
 *   MSSQL_SA_PASSWORD='...' npx tsx scripts/live-mssql-test.ts
 *
 * (Run via tsx with NODE_OPTIONS='--conditions=react-server' so the
 * `server-only` guard modules resolve to their empty variants outside Next.)
 */

process.env.PRISM_WAREHOUSE_TYPE = 'mssql';
process.env.MSSQL_SERVER ??= 'localhost';
process.env.MSSQL_USER ??= 'sa';
process.env.MSSQL_PASSWORD ??= process.env.MSSQL_SA_PASSWORD ?? '';
process.env.MSSQL_TRUST_SERVER_CERT = 'true';
process.env.MSSQL_DATABASE = 'PRISM_DB';

const { getWarehouseAdapter } = await import('../app/api/_lib/warehouse');
const { normalizeLiteral } = await import('../app/api/_lib/normalize');

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const adapter = getWarehouseAdapter();
check("factory returns mssql adapter (PRISM_WAREHOUSE_TYPE)", adapter.kind === 'mssql', adapter.kind);

await adapter.withConnection(async (conn) => {
  // ── Connection + basic query ───────────────────────────────────────────────
  const ver = await adapter.executeQuery(conn, `SELECT @@VERSION AS v`);
  check('connect + SELECT @@VERSION', String(ver[0]?.v ?? '').includes('Microsoft SQL Server'));

  // ── Install-script objects ─────────────────────────────────────────────────
  const tables = await adapter.executeQuery(
    conn,
    `SELECT s.name + '.' + t.name AS n FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id`,
  );
  const names = new Set(tables.map((r: any) => String(r.n)));
  for (const t of ['INTERNAL.PIPELINE_QUEUE', 'INTERNAL.APPROVED_ALIAS_NAMES', 'INTERNAL.LITERAL_ALIAS_MATCHES', 'INTERNAL.PIPELINE_FILE_ROWS', 'INTERNAL.RUN_STATE', 'INTERNAL.VALIDATION_LOG']) {
    check(`table ${t} exists`, names.has(t));
  }
  const roles = await adapter.executeQuery(
    conn,
    `SELECT name FROM sys.database_principals WHERE type = 'R' AND name LIKE ?`,
    ['PRISM%'],
  );
  check('roles created (bind translation works on LIKE ?)', roles.length === 3, roles);

  // ── CRUD through executeQuery with ? binds ─────────────────────────────────
  await adapter.executeQuery(conn, `DELETE FROM INTERNAL.LITERAL_ALIAS_MATCHES WHERE run_id = ?`, [999999]);
  await adapter.executeQuery(conn, `DELETE FROM INTERNAL.APPROVED_ALIAS_NAMES WHERE alias_name = ?`, ['__SMOKE_ALIAS__']);

  await adapter.executeQuery(
    conn,
    `INSERT INTO INTERNAL.APPROVED_ALIAS_NAMES (alias_name, domain_id, usage_count) VALUES (?, ?, ?)`,
    ['__SMOKE_ALIAS__', 42, 1],
  );
  const [alias] = await adapter.executeQuery(
    conn,
    `SELECT alias_id FROM INTERNAL.APPROVED_ALIAS_NAMES WHERE alias_name = ? AND domain_id = ?`,
    ['__SMOKE_ALIAS__', 42],
  );
  check('insert + select alias round-trip', Number(alias?.alias_id) > 0);

  const literal = "O'Brien's ?Test? Value"; // quotes + question marks stress the translator
  await adapter.executeQuery(
    conn,
    `INSERT INTO INTERNAL.LITERAL_ALIAS_MATCHES (literal_value, normalized_value, alias_id, domain_id, run_id)
     VALUES (?, ?, ?, ?, ?)`,
    [literal, normalizeLiteral(literal), Number(alias.alias_id), 42, 999999],
  );
  const [match] = await adapter.executeQuery(
    conn,
    `SELECT m.literal_value, m.normalized_value, a.alias_name
     FROM INTERNAL.LITERAL_ALIAS_MATCHES m
     JOIN INTERNAL.APPROVED_ALIAS_NAMES a ON a.alias_id = m.alias_id
     WHERE m.normalized_value = ? AND m.domain_id = ?`,
    [normalizeLiteral(literal), 42],
  );
  check('normalized-value join round-trip (app-side normalization)', match?.alias_name === '__SMOKE_ALIAS__');
  check('literal preserved exactly (quotes + ?)', match?.literal_value === literal, match?.literal_value);

  // ── BIN2 collation: case variants are DISTINCT ─────────────────────────────
  await adapter.executeQuery(conn, `DELETE FROM INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`, [999999]);
  await adapter.executeQuery(conn, `INSERT INTO INTERNAL.PIPELINE_QUEUE (pipeline_id, literal_value) VALUES (?, ?)`, [999999, 'AT&T']);
  await adapter.executeQuery(conn, `INSERT INTO INTERNAL.PIPELINE_QUEUE (pipeline_id, literal_value) VALUES (?, ?)`, [999999, 'at&t']);
  const qcount = await adapter.executeQuery(conn, `SELECT COUNT(*) AS c FROM INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`, [999999]);
  check('BIN2 collation keeps case variants distinct (unique constraint)', Number(qcount[0]?.c) === 2, qcount[0]);

  // ── Demo source table + Change Tracking ────────────────────────────────────
  const demo = await adapter.executeQuery(conn, `SELECT COUNT(*) AS c FROM TEST_DB.dbo.RAW_MOBILE_CARRIERS_SHORT`);
  check('demo source table seeded (28 rows)', Number(demo[0]?.c) === 28, demo[0]);
  // Check the DEMO table specifically — a long-lived dev container may have
  // other CT-registered tables from ad-hoc testing.
  const ct = await adapter.executeQuery(
    conn,
    `SELECT t.name AS n
     FROM TEST_DB.sys.change_tracking_tables ctt
     JOIN TEST_DB.sys.tables t ON t.object_id = ctt.object_id
     WHERE t.name = 'RAW_MOBILE_CARRIERS_SHORT'`,
  );
  check('Change Tracking enabled on TEST_DB demo table', ct.length === 1);

  // ── JSON storage (PIPELINE_FILE_ROWS ISJSON constraint) ────────────────────
  await adapter.executeQuery(conn, `DELETE FROM INTERNAL.PIPELINE_FILE_ROWS WHERE pipeline_id = ?`, [999999]);
  await adapter.executeQuery(
    conn,
    `INSERT INTO INTERNAL.PIPELINE_FILE_ROWS (pipeline_id, row_num, column_data) VALUES (?, ?, ?)`,
    [999999, 1, JSON.stringify({ 'Company Name': "O'Brien & Sons" })],
  );
  const [jrow] = await adapter.executeQuery(
    conn,
    `SELECT JSON_VALUE(column_data, '$."Company Name"') AS v FROM INTERNAL.PIPELINE_FILE_ROWS WHERE pipeline_id = ?`,
    [999999],
  );
  check('JSON round-trip via JSON_VALUE', jrow?.v === "O'Brien & Sons", jrow?.v);
  let jsonRejected = false;
  try {
    await adapter.executeQuery(conn, `INSERT INTO INTERNAL.PIPELINE_FILE_ROWS (pipeline_id, row_num, column_data) VALUES (?, ?, ?)`, [999999, 2, 'not json']);
  } catch { jsonRejected = true; }
  check('ISJSON constraint rejects non-JSON', jsonRejected);

  // ── Serverless detection (on-prem container → null objective → false) ─────
  const so = await adapter.executeQuery(conn, `SELECT CONVERT(NVARCHAR(128), DATABASEPROPERTYEX(DB_NAME(), 'ServiceObjective')) AS so`);
  check('service objective is null on non-Azure (serverless check no-op)', so[0]?.so == null, so[0]);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  await adapter.executeQuery(conn, `DELETE FROM INTERNAL.PIPELINE_FILE_ROWS WHERE pipeline_id = ?`, [999999]);
  await adapter.executeQuery(conn, `DELETE FROM INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`, [999999]);
  await adapter.executeQuery(conn, `DELETE FROM INTERNAL.LITERAL_ALIAS_MATCHES WHERE run_id = ?`, [999999]);
  await adapter.executeQuery(conn, `DELETE FROM INTERNAL.APPROVED_ALIAS_NAMES WHERE alias_name = ?`, ['__SMOKE_ALIAS__']);
});

// ── Error classification: access error shape ─────────────────────────────────
try {
  await adapter.withConnection(async (conn) => {
    await adapter.executeQuery(conn, `SELECT * FROM INTERNAL.DOES_NOT_EXIST_XYZ`);
  });
  check('missing object throws', false);
} catch (err) {
  check('missing object classified as access error', adapter.isAccessError(err), String((err as any)?.message));
}

if (failures > 0) {
  console.error(`\n${failures} live check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll live mssql adapter checks passed.');
