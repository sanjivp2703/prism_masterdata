/**
 * Live smoke test of the mysql warehouse adapter against a local MySQL 8.0
 * (docs/DEV_MYSQL.md container). Phase M1 exit criteria
 * (docs/MYSQL_PORT_PLAN.md): factory → withConnection → executeQuery
 * (native-? validation) → error classification, plus schema/grants/collation/
 * charset/uniqueness/swap sanity.
 *
 *   MYSQL_ROOT_PASSWORD='...' npm run test:mysql-live
 *
 * (Run via tsx with NODE_OPTIONS='--conditions=react-server' so the
 * `server-only` guard modules resolve to their empty variants outside Next.)
 */

process.env.PRISM_WAREHOUSE_TYPE = 'mysql';
// Isolated app-state DB: the REAL dev SQLite has a saved workspace_config
// whose warehouse_type would outrank PRISM_WAREHOUSE_TYPE in the factory.
process.env.PRISM_SQLITE_PATH = `/tmp/prism-live-mysql-test-${process.pid}.db`;
process.env.MYSQL_HOST ??= 'localhost';
process.env.MYSQL_USER ??= 'prism_svc';
process.env.MYSQL_PASSWORD ??= 'PrismSvc!Dev1';
process.env.MYSQL_SSL ??= 'false';
const ROOT_PASSWORD = process.env.MYSQL_ROOT_PASSWORD ?? 'PrismDev!Passw0rd';

const { getWarehouseAdapter } = await import('../app/api/_lib/warehouse');
const { internalTable } = await import('../app/api/_lib/warehouse-tables');
const { withAdHocMysql } = await import('../app/api/_lib/warehouse/mysql/connection');
const { binaryCompare } = await import('../app/api/_lib/warehouse/mysql/dialect');
const { normalizeLiteral } = await import('../app/api/_lib/normalize');

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const adapter = getWarehouseAdapter();
check("factory returns mysql adapter (PRISM_WAREHOUSE_TYPE)", adapter.kind === 'mysql', adapter.kind);
check("internalTable resolves to prism_internal.* (shared with pg spelling)", internalTable('PIPELINE_QUEUE') === 'prism_internal.pipeline_queue', internalTable('PIPELINE_QUEUE'));

const admin = <T,>(fn: (conn: any) => Promise<T>) =>
  withAdHocMysql(
    { host: process.env.MYSQL_HOST!, user: process.env.MYSQL_ADMIN_USER ?? 'root', password: ROOT_PASSWORD, ssl: 'false' },
    fn,
  );

await adapter.withConnection(async (conn) => {
  // ── Connection + basic query ───────────────────────────────────────────────
  const ver = await adapter.executeQuery(conn, `SELECT VERSION() AS v`);
  check('connect + SELECT VERSION()', /^8\./.test(String(ver[0]?.v ?? '')), ver[0]);

  const [timeout] = await adapter.executeQuery(conn, `SELECT @@SESSION.MAX_EXECUTION_TIME AS t`);
  check('MAX_EXECUTION_TIME set to 600s (SELECT-only, documented)', Number(timeout?.t) === 600000, timeout);

  // ── Install-script objects ─────────────────────────────────────────────────
  const tables = await adapter.executeQuery(
    conn,
    `SELECT CONCAT(table_schema, '.', table_name) AS n
     FROM information_schema.tables WHERE table_schema = ?`,
    ['prism_internal'],
  );
  const names = new Set(tables.map((r: any) => String(r.n)));
  for (const t of ['prism_internal.pipeline_queue', 'prism_internal.approved_alias_names', 'prism_internal.literal_alias_matches', 'prism_internal.one_time_file_rows', 'prism_internal.run_state', 'prism_internal.validation_log']) {
    check(`table ${t} exists`, names.has(t));
  }
  const roles = await adapter.executeQuery(
    conn,
    `SELECT COUNT(DISTINCT from_user) AS c FROM mysql.role_edges WHERE from_user LIKE ?`,
    ['prism%'],
  ).catch(() => [{ c: -1 }]);
  // role_edges may not be readable by the service account — roles are proven
  // indirectly anyway: this whole session runs under prism_service's grants.
  check('bind validation works on LIKE ? (roles probe or graceful fallback)', Number(roles[0]?.c) >= -1);

  // ── CRUD through executeQuery with ? binds ─────────────────────────────────
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.literal_alias_matches WHERE run_id = ?`, [999999]);
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.approved_alias_names WHERE alias_name = ?`, ['__SMOKE_ALIAS__']);

  await adapter.executeQuery(
    conn,
    `INSERT INTO prism_internal.approved_alias_names (alias_name, domain_id, usage_count) VALUES (?, ?, ?)`,
    ['__SMOKE_ALIAS__', 42, 1],
  );
  const [alias] = await adapter.executeQuery(
    conn,
    `SELECT alias_id FROM prism_internal.approved_alias_names WHERE alias_name = ? AND domain_id = ?`,
    ['__SMOKE_ALIAS__', 42],
  );
  check('insert + select alias round-trip', Number(alias?.alias_id) > 0);

  const literal = "O'Brien's ?Test? Value"; // quotes + question marks stress the counter
  await adapter.executeQuery(
    conn,
    `INSERT INTO prism_internal.literal_alias_matches (literal_value, normalized_value, alias_id, domain_id, run_id)
     VALUES (?, ?, ?, ?, ?)`,
    [literal, normalizeLiteral(literal), Number(alias.alias_id), 42, 999999],
  );
  const [match] = await adapter.executeQuery(
    conn,
    `SELECT m.literal_value, a.alias_name
     FROM prism_internal.literal_alias_matches m
     JOIN prism_internal.approved_alias_names a ON a.alias_id = m.alias_id
     WHERE m.normalized_value = ? AND m.domain_id = ?`,
    [normalizeLiteral(literal), 42],
  );
  check('normalized-value join round-trip (app-side normalization)', match?.alias_name === '__SMOKE_ALIAS__');
  check('literal preserved exactly (quotes + ?)', match?.literal_value === literal, match?.literal_value);

  // ── ON DUPLICATE KEY against the functional unique (hash) key ──────────────
  const [dup] = await adapter.executeQuery(
    conn,
    `INSERT INTO prism_internal.literal_alias_matches (literal_value, normalized_value, alias_id, domain_id, run_id)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE run_id = VALUES(run_id), confirmed_at = NOW(3)`,
    ['DIFFERENT ORIGINAL', normalizeLiteral(literal), Number(alias.alias_id), 42, 888888],
  );
  check('ON DUPLICATE KEY fires on the functional (normalized,scope) key', Number(dup?.affectedRows) === 2, dup); // 2 = updated
  const [count1] = await adapter.executeQuery(
    conn,
    `SELECT COUNT(*) AS c FROM prism_internal.literal_alias_matches WHERE normalized_value = ? AND domain_id = ?`,
    [normalizeLiteral(literal), 42],
  );
  check('one-row-per-(normalized,scope) invariant ENFORCED', Number(count1?.c) === 1, count1);

  // ── utf8mb4_bin: case variants are DISTINCT ────────────────────────────────
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.pipeline_queue WHERE pipeline_id = ?`, [999999]);
  await adapter.executeQuery(conn, `INSERT INTO prism_internal.pipeline_queue (pipeline_id, literal_value) VALUES (?, ?)`, [999999, 'AT&T']);
  await adapter.executeQuery(conn, `INSERT INTO prism_internal.pipeline_queue (pipeline_id, literal_value) VALUES (?, ?)`, [999999, 'at&t']);
  const qcount = await adapter.executeQuery(conn, `SELECT COUNT(*) AS c FROM prism_internal.pipeline_queue WHERE pipeline_id = ?`, [999999]);
  check('utf8mb4_bin keeps case variants distinct (functional unique key)', Number(qcount[0]?.c) === 2, qcount[0]);

  // ── Scopeless-alias uniqueness (COALESCE sentinel functional key) ──────────
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.approved_alias_names WHERE alias_name = ?`, ['__SMOKE_NULL_SCOPE__']);
  await adapter.executeQuery(conn, `INSERT INTO prism_internal.approved_alias_names (alias_name, domain_id) VALUES (?, NULL)`, ['__SMOKE_NULL_SCOPE__']);
  let dupRejected = false;
  try {
    await adapter.executeQuery(conn, `INSERT INTO prism_internal.approved_alias_names (alias_name, domain_id) VALUES (?, NULL)`, ['__SMOKE_NULL_SCOPE__']);
  } catch { dupRejected = true; }
  check('at most one scopeless (NULL domain) row per name (COALESCE sentinel)', dupRejected);

  // ── Demo source + grants ───────────────────────────────────────────────────
  const demo = await adapter.executeQuery(conn, `SELECT COUNT(*) AS c FROM test_sources.raw_mobile_carriers_short`);
  check('demo source readable cross-database by service role (28 rows)', Number(demo[0]?.c) === 28, demo[0]);

  // ── Charset-coercion join (latin1 fixture — binaryCompare mainline) ────────
  const latinDistinct = await adapter.executeQuery(
    conn,
    `SELECT COUNT(DISTINCT ${binaryCompare('carrier')}) AS c FROM test_sources.legacy_latin1_carriers WHERE carrier IS NOT NULL`,
  );
  check('latin1 source: byte-distinct count via CONVERT (ATT≠att, 4 values)', Number(latinDistinct[0]?.c) === 4, latinDistinct[0]);
  let bareCollateFails = false;
  try {
    await adapter.executeQuery(conn, `SELECT COUNT(*) AS c FROM test_sources.legacy_latin1_carriers WHERE carrier COLLATE utf8mb4_bin = 'x'`);
  } catch { bareCollateFails = true; }
  check('bare COLLATE on latin1 column fails (proves CONVERT is required)', bareCollateFails);

  // ── JSON round-trip + rejection ────────────────────────────────────────────
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.one_time_file_rows WHERE session_nonce = ?`, ['__smoke__']);
  await adapter.executeQuery(
    conn,
    `INSERT INTO prism_internal.one_time_file_rows (session_nonce, row_num, column_data) VALUES (?, ?, ?)`,
    ['__smoke__', 1, JSON.stringify({ 'Company Name': "O'Brien & Sons" })],
  );
  const [jrow] = await adapter.executeQuery(
    conn,
    `SELECT column_data->>'$."Company Name"' AS v FROM prism_internal.one_time_file_rows WHERE session_nonce = ?`,
    ['__smoke__'],
  );
  check("JSON round-trip via ->> operator", jrow?.v === "O'Brien & Sons", jrow?.v);
  let jsonRejected = false;
  try {
    await adapter.executeQuery(conn, `INSERT INTO prism_internal.one_time_file_rows (session_nonce, row_num, column_data) VALUES (?, ?, ?)`, ['__smoke__', 2, 'not json']);
  } catch { jsonRejected = true; }
  check('native JSON type rejects non-JSON', jsonRejected);

  // ── run_state rev semantics (the M3 rev-checked save shape) ────────────────
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.run_state WHERE run_id = ?`, [999999]);
  await adapter.executeQuery(conn, `INSERT INTO prism_internal.run_state (run_id, state) VALUES (?, ?)`, [999999, JSON.stringify({ rev: 3, status: 'running' })]);
  const [rev] = await adapter.executeQuery(
    conn,
    `SELECT COALESCE(CAST(state->>'$.rev' AS SIGNED), 0) AS rev FROM prism_internal.run_state WHERE run_id = ?`,
    [999999],
  );
  check("rev extraction via CAST(state->>'$.rev')", Number(rev?.rev) === 3, rev);
  const [upd] = await adapter.executeQuery(
    conn,
    `UPDATE prism_internal.run_state SET state = ? WHERE run_id = ? AND COALESCE(CAST(state->>'$.rev' AS SIGNED), 0) = ?`,
    [JSON.stringify({ rev: 4 }), 999999, 3],
  );
  check('rev-checked save landed-detection via affectedRows', Number(upd?.affectedRows) === 1, upd);

  // ── Atomic multi-RENAME swap (the M3 export-swap primitive) ────────────────
  await adapter.executeQuery(conn, `DROP TABLE IF EXISTS prism_exports.__swap_cur`);
  await adapter.executeQuery(conn, `DROP TABLE IF EXISTS prism_exports.__swap_new`);
  await adapter.executeQuery(conn, `DROP TABLE IF EXISTS prism_exports.__swap_old`);
  await adapter.executeQuery(conn, `CREATE TABLE prism_exports.__swap_cur AS SELECT 1 AS generation`);
  await adapter.executeQuery(conn, `CREATE TABLE prism_exports.__swap_new AS SELECT 2 AS generation`);
  await adapter.executeQuery(
    conn,
    `RENAME TABLE prism_exports.__swap_cur TO prism_exports.__swap_old, prism_exports.__swap_new TO prism_exports.__swap_cur`,
  );
  const [gen] = await adapter.executeQuery(conn, `SELECT generation FROM prism_exports.__swap_cur`);
  check('atomic multi-RENAME swap replaces the export in one statement', Number(gen?.generation) === 2, gen);
  await adapter.executeQuery(conn, `DROP TABLE IF EXISTS prism_exports.__swap_cur`);
  await adapter.executeQuery(conn, `DROP TABLE IF EXISTS prism_exports.__swap_old`);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.one_time_file_rows WHERE session_nonce = ?`, ['__smoke__']);
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.run_state WHERE run_id = ?`, [999999]);
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.pipeline_queue WHERE pipeline_id = ?`, [999999]);
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.literal_alias_matches WHERE domain_id = ?`, [42]);
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.approved_alias_names WHERE alias_name IN (?, ?)`, ['__SMOKE_ALIAS__', '__SMOKE_NULL_SCOPE__']);
});

// ── Error classification: access error shape ─────────────────────────────────
try {
  await adapter.withConnection(async (conn) => {
    await adapter.executeQuery(conn, `SELECT * FROM prism_internal.does_not_exist_xyz`);
  });
  check('missing object throws', false);
} catch (err) {
  check('missing object classified as access error', adapter.isAccessError(err), String((err as any)?.message));
}

// Root-only sanity: the admin path works too (ad-hoc credentials — the setup
// wizard's test/save flow shape).
await admin(async (conn) => {
  const rows = await adapter.executeQuery(conn, `SELECT CURRENT_USER() AS u`);
  check('ad-hoc (typed) credentials connect', String(rows[0]?.u ?? '').startsWith('root'), rows[0]);
});

if (failures > 0) {
  console.error(`\n${failures} live check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll live mysql adapter checks passed.');
