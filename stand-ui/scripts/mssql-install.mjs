/**
 * Runs the SQL Server install script (01_internal_tables.mssql.sql) followed
 * by the dev/demo data script (02_demo_data.mssql.sql) against a SQL Server
 * instance — the mssql-side equivalent of `snowsql -f 01_… -f 02_…`.
 * Customers run only 01 (served by the setup wizard); this runner is dev-only,
 * so it always installs the demo data too.
 *
 *   npm run mssql:install
 *
 * Connects as an admin login (defaults match the local dev container from
 * docs/DEV_MSSQL.md):
 *   MSSQL_SERVER           default localhost
 *   MSSQL_PORT             default 1433
 *   MSSQL_ADMIN_USER       default sa
 *   MSSQL_ADMIN_PASSWORD   (or MSSQL_SA_PASSWORD) — required
 *
 * Splits the script into batches on `GO` lines (sqlcmd convention) and runs
 * them sequentially on ONE connection so `USE` statements carry across
 * batches, exactly like sqlcmd.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPaths = [
  path.resolve(here, '..', '..', '01_internal_tables.mssql.sql'),
  path.resolve(here, '..', '..', '02_demo_data.mssql.sql'),
];

const env = (name) => {
  const v = process.env[name];
  return v && v.trim().length ? v.trim() : undefined;
};

const password = env('MSSQL_ADMIN_PASSWORD') ?? env('MSSQL_SA_PASSWORD');
if (!password) {
  console.error('Set MSSQL_ADMIN_PASSWORD (or MSSQL_SA_PASSWORD) to the admin login password.');
  process.exit(1);
}

const config = {
  server: env('MSSQL_SERVER') ?? 'localhost',
  port: Number(env('MSSQL_PORT') ?? 1433),
  user: env('MSSQL_ADMIN_USER') ?? 'sa',
  password,
  database: 'master',
  options: {
    encrypt: true,
    // Dev containers use self-signed certs; override with MSSQL_TRUST_SERVER_CERT=false
    trustServerCertificate: (env('MSSQL_TRUST_SERVER_CERT') ?? 'true').toLowerCase() !== 'false',
  },
  pool: { max: 1, min: 0 }, // ONE connection so USE persists across batches
  requestTimeout: 120_000,
};

// Split on sqlcmd-style GO separator lines.
function splitBatches(text) {
  const batches = [];
  let current = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().toUpperCase() === 'GO') {
      if (current.join('\n').trim()) batches.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.join('\n').trim()) batches.push(current.join('\n'));
  return batches;
}

const pool = new sql.ConnectionPool(config);
try {
  await pool.connect();
  for (const scriptPath of scriptPaths) {
    const script = fs.readFileSync(scriptPath, 'utf8');
    const batches = splitBatches(script);
    console.log(`Running ${batches.length} batches from ${path.basename(scriptPath)} against ${config.server}:${config.port} …`);
    for (let i = 0; i < batches.length; i++) {
      const preview = batches[i].trim().split('\n')[0].slice(0, 88);
      try {
        await pool.request().batch(batches[i]);
        console.log(`  ok    [${i + 1}/${batches.length}] ${preview}`);
      } catch (err) {
        console.error(`  FAIL  [${i + 1}/${batches.length}] ${preview}`);
        console.error(`        ${err.message}`);
        process.exit(1);
      }
    }
  }
  console.log('Install complete.');
} finally {
  await pool.close().catch(() => {});
}
