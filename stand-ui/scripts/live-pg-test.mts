/**
 * Live smoke test of the postgres warehouse adapter against a local Postgres
 * (docs/DEV_POSTGRES.md container). Exercises the REAL adapter code path:
 * factory → withConnection → executeQuery (?→$n translation) → error
 * classification, plus schema/grants/collation sanity. Phase P1 exit criteria
 * (docs/POSTGRES_PORT_PLAN.md).
 *
 *   PG_PASSWORD='...' npm run test:pg-live
 *
 * (Run via tsx with NODE_OPTIONS='--conditions=react-server' so the
 * `server-only` guard modules resolve to their empty variants outside Next.)
 */

process.env.PRISM_WAREHOUSE_TYPE = 'postgres';
// Isolated app-state DB: the REAL dev SQLite has a saved workspace_config
// whose warehouse_type would outrank PRISM_WAREHOUSE_TYPE in the factory
// (workspace tier wins by design). Standard practice for live suites.
process.env.PRISM_SQLITE_PATH = `/tmp/prism-live-pg-test-${process.pid}.db`;
process.env.PG_HOST ??= 'localhost';
process.env.PG_DATABASE ??= 'prism_dev';
process.env.PG_USER ??= 'prism_svc';
process.env.PG_PASSWORD ??= 'PrismSvc!Dev1';
process.env.PG_SSLMODE ??= 'disable';

const { getWarehouseAdapter } = await import('../app/api/_lib/warehouse');
const { normalizeLiteral } = await import('../app/api/_lib/normalize');

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const adapter = getWarehouseAdapter();
check("factory returns postgres adapter (PRISM_WAREHOUSE_TYPE)", adapter.kind === 'postgres', adapter.kind);

await adapter.withConnection(async (conn) => {
  // ── Connection + basic query ───────────────────────────────────────────────
  const ver = await adapter.executeQuery(conn, `SELECT version() AS v`);
  check('connect + SELECT version()', String(ver[0]?.v ?? '').includes('PostgreSQL'));

  // Statement-timeout parity with PRISM_WH (600 s, set per connection).
  const [timeout] = await adapter.executeQuery(conn, `SHOW statement_timeout`);
  check('statement_timeout is 600s', String(timeout?.statement_timeout) === '10min', timeout);

  // ── Install-script objects ─────────────────────────────────────────────────
  const tables = await adapter.executeQuery(
    conn,
    `SELECT table_schema || '.' || table_name AS n
     FROM information_schema.tables WHERE table_schema = ?`,
    ['prism_internal'],
  );
  const names = new Set(tables.map((r: any) => String(r.n)));
  for (const t of ['prism_internal.pipeline_queue', 'prism_internal.approved_alias_names', 'prism_internal.literal_alias_matches', 'prism_internal.one_time_file_rows', 'prism_internal.run_state', 'prism_internal.validation_log']) {
    check(`table ${t} exists`, names.has(t));
  }
  const roles = await adapter.executeQuery(
    conn,
    `SELECT rolname FROM pg_roles WHERE rolname LIKE ? AND rolname != 'prism_svc'`,
    ['prism%'],
  );
  check('roles created (bind translation works on LIKE ?)', roles.length === 3, roles);

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
  check('insert + select alias round-trip (identity + sequence grants)', Number(alias?.alias_id) > 0);

  const literal = "O'Brien's ?Test? Value"; // quotes + question marks stress the translator
  await adapter.executeQuery(
    conn,
    `INSERT INTO prism_internal.literal_alias_matches (literal_value, normalized_value, alias_id, domain_id, run_id)
     VALUES (?, ?, ?, ?, ?)`,
    [literal, normalizeLiteral(literal), Number(alias.alias_id), 42, 999999],
  );
  const [match] = await adapter.executeQuery(
    conn,
    `SELECT m.literal_value, m.normalized_value, a.alias_name
     FROM prism_internal.literal_alias_matches m
     JOIN prism_internal.approved_alias_names a ON a.alias_id = m.alias_id
     WHERE m.normalized_value = ? AND m.domain_id = ?`,
    [normalizeLiteral(literal), 42],
  );
  check('normalized-value join round-trip (app-side normalization)', match?.alias_name === '__SMOKE_ALIAS__');
  check('literal preserved exactly (quotes + ?)', match?.literal_value === literal, match?.literal_value);

  // ── COLLATE "C": case variants are DISTINCT ────────────────────────────────
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.pipeline_queue WHERE pipeline_id = ?`, [999999]);
  await adapter.executeQuery(conn, `INSERT INTO prism_internal.pipeline_queue (pipeline_id, literal_value) VALUES (?, ?)`, [999999, 'AT&T']);
  await adapter.executeQuery(conn, `INSERT INTO prism_internal.pipeline_queue (pipeline_id, literal_value) VALUES (?, ?)`, [999999, 'at&t']);
  const qcount = await adapter.executeQuery(conn, `SELECT COUNT(*) AS c FROM prism_internal.pipeline_queue WHERE pipeline_id = ?`, [999999]);
  check('COLLATE "C" keeps case variants distinct (unique constraint)', Number(qcount[0]?.c) === 2, qcount[0]);

  // ── Scopeless-alias uniqueness (partial index restores NULLs-equal) ───────
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.approved_alias_names WHERE alias_name = ?`, ['__SMOKE_NULL_SCOPE__']);
  await adapter.executeQuery(conn, `INSERT INTO prism_internal.approved_alias_names (alias_name, domain_id) VALUES (?, NULL)`, ['__SMOKE_NULL_SCOPE__']);
  let dupRejected = false;
  try {
    await adapter.executeQuery(conn, `INSERT INTO prism_internal.approved_alias_names (alias_name, domain_id) VALUES (?, NULL)`, ['__SMOKE_NULL_SCOPE__']);
  } catch { dupRejected = true; }
  check('at most one scopeless (NULL domain) row per name', dupRejected);

  // ── Demo source table + grants ─────────────────────────────────────────────
  const demo = await adapter.executeQuery(conn, `SELECT COUNT(*) AS c FROM test_sources.raw_mobile_carriers_short`);
  check('demo source table seeded + readable by service role (28 rows)', Number(demo[0]?.c) === 28, demo[0]);

  // ── JSONB storage ──────────────────────────────────────────────────────────
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.one_time_file_rows WHERE session_nonce = ?`, ['__smoke__']);
  await adapter.executeQuery(
    conn,
    `INSERT INTO prism_internal.one_time_file_rows (session_nonce, row_num, column_data) VALUES (?, ?, ?)`,
    ['__smoke__', 1, JSON.stringify({ 'Company Name': "O'Brien & Sons" })],
  );
  const [jrow] = await adapter.executeQuery(
    conn,
    `SELECT column_data->>'Company Name' AS v FROM prism_internal.one_time_file_rows WHERE session_nonce = ?`,
    ['__smoke__'],
  );
  check("JSONB round-trip via ->> operator", jrow?.v === "O'Brien & Sons", jrow?.v);
  let jsonRejected = false;
  try {
    await adapter.executeQuery(conn, `INSERT INTO prism_internal.one_time_file_rows (session_nonce, row_num, column_data) VALUES (?, ?, ?)`, ['__smoke__', 2, 'not json']);
  } catch { jsonRejected = true; }
  check('JSONB type rejects non-JSON', jsonRejected);

  // ── run_state rev semantics (the P3 rev-checked save shape) ────────────────
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.run_state WHERE run_id = ?`, [999999]);
  await adapter.executeQuery(conn, `INSERT INTO prism_internal.run_state (run_id, state) VALUES (?, ?)`, [999999, JSON.stringify({ rev: 3, status: 'running' })]);
  const [rev] = await adapter.executeQuery(
    conn,
    `SELECT COALESCE((state->>'rev')::int, 0) AS rev FROM prism_internal.run_state WHERE run_id = ?`,
    [999999],
  );
  check("rev extraction via (state->>'rev')::int", Number(rev?.rev) === 3, rev);

  // ── Transactional DDL via the multi-statement simple-query path ────────────
  await adapter.executeQuery(conn, `DROP TABLE IF EXISTS prism_internal.__smoke_txn`);
  await adapter.executeQuery(conn, `BEGIN; CREATE TABLE prism_internal.__smoke_txn (x INT); ROLLBACK;`);
  const txn = await adapter.executeQuery(
    conn,
    `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
    ['prism_internal', '__smoke_txn'],
  );
  check('transactional DDL: rolled-back CREATE TABLE leaves nothing', Number(txn[0]?.c) === 0, txn[0]);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.one_time_file_rows WHERE session_nonce = ?`, ['__smoke__']);
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.run_state WHERE run_id = ?`, [999999]);
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.pipeline_queue WHERE pipeline_id = ?`, [999999]);
  await adapter.executeQuery(conn, `DELETE FROM prism_internal.literal_alias_matches WHERE run_id = ?`, [999999]);
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

if (failures > 0) {
  console.error(`\n${failures} live check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll live postgres adapter checks passed.');
