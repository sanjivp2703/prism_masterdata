/**
 * Runs the PostgreSQL install script (01_internal_tables.postgres.sql)
 * followed by the dev/demo data script (02_demo_data.postgres.sql) against a
 * Postgres server — the pg-side equivalent of `snowsql -f 01_… -f 02_…`.
 * Customers run only 01 (served by the setup wizard); this runner is dev-only,
 * so it always installs the demo data too.
 *
 *   npm run pg:install
 *
 * Connects as an admin role (defaults match the local dev container from
 * docs/DEV_POSTGRES.md):
 *   PG_HOST              default localhost
 *   PG_PORT              default 5432
 *   PG_ADMIN_USER        default postgres
 *   PG_ADMIN_PASSWORD    (or PG_PASSWORD) — required
 *   PG_DATABASE          default prism_dev — created if missing, then both
 *                        scripts run INSIDE it (Postgres installs are
 *                        per-database; see docs/POSTGRES_PORT_PLAN.md §2.1)
 *
 * Each script is sent as ONE multi-statement query (simple protocol), so DO
 * blocks and dollar-quoted bodies need no client-side splitting.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPaths = [
  path.resolve(here, '..', '..', '01_internal_tables.postgres.sql'),
  path.resolve(here, '..', '..', '02_demo_data.postgres.sql'),
];

const env = (name) => {
  const v = process.env[name];
  return v && v.trim().length ? v.trim() : undefined;
};

const password = env('PG_ADMIN_PASSWORD') ?? env('PG_PASSWORD');
if (!password) {
  console.error('Set PG_ADMIN_PASSWORD (or PG_PASSWORD) to the admin role password.');
  process.exit(1);
}

const base = {
  host: env('PG_HOST') ?? 'localhost',
  port: Number(env('PG_PORT') ?? 5432),
  user: env('PG_ADMIN_USER') ?? 'postgres',
  password,
};
const database = env('PG_DATABASE') ?? 'prism_dev';

// 1) Ensure the target database exists (connect to the maintenance DB).
{
  const admin = new pg.Client({ ...base, database: 'postgres' });
  await admin.connect();
  try {
    const r = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (r.rowCount === 0) {
      // Identifier, not a bind — quote by doubling embedded quotes.
      await admin.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
      console.log(`Created database ${database}.`);
    }
  } finally {
    await admin.end().catch(() => {});
  }
}

// 2) Run both scripts inside the target database.
const client = new pg.Client({ ...base, database });
try {
  await client.connect();
  for (const scriptPath of scriptPaths) {
    const script = fs.readFileSync(scriptPath, 'utf8');
    console.log(`Running ${path.basename(scriptPath)} against ${base.host}:${base.port}/${database} …`);
    try {
      await client.query(script);
      console.log('  ok');
    } catch (err) {
      console.error(`  FAIL  ${err.message}`);
      if (err.position) {
        const upTo = script.slice(0, Number(err.position));
        const line = upTo.split('\n').length;
        console.error(`        (around line ${line} of ${path.basename(scriptPath)})`);
      }
      process.exit(1);
    }
  }
  console.log('Install complete.');
} finally {
  await client.end().catch(() => {});
}
