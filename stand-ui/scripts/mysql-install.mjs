/**
 * Runs the MySQL install script (01_internal_tables.mysql.sql) followed by
 * the dev/demo data script (02_demo_data.mysql.sql) against a MySQL server —
 * the mysql-side equivalent of `snowsql -f 01_… -f 02_…`. Customers run only
 * 01 (served by the setup wizard); this runner is dev-only, so it always
 * installs the demo data too.
 *
 *   npm run mysql:install
 *
 * Connects as an admin account (defaults match the local dev container from
 * docs/DEV_MYSQL.md):
 *   MYSQL_HOST             default localhost
 *   MYSQL_PORT             default 3306
 *   MYSQL_ADMIN_USER       default root
 *   MYSQL_ADMIN_PASSWORD   (or MYSQL_ROOT_PASSWORD) — required
 *
 * Each script runs as ONE multi-statement batch on a single connection, so
 * `USE` statements carry across statements (no GO/DELIMITER handling needed —
 * the scripts contain no stored routines).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPaths = [
  path.resolve(here, '..', '..', '01_internal_tables.mysql.sql'),
  path.resolve(here, '..', '..', '02_demo_data.mysql.sql'),
];

const env = (name) => {
  const v = process.env[name];
  return v && v.trim().length ? v.trim() : undefined;
};

const password = env('MYSQL_ADMIN_PASSWORD') ?? env('MYSQL_ROOT_PASSWORD');
if (!password) {
  console.error('Set MYSQL_ADMIN_PASSWORD (or MYSQL_ROOT_PASSWORD) to the admin account password.');
  process.exit(1);
}

const conn = await mysql.createConnection({
  host: env('MYSQL_HOST') ?? 'localhost',
  port: Number(env('MYSQL_PORT') ?? 3306),
  user: env('MYSQL_ADMIN_USER') ?? 'root',
  password,
  multipleStatements: true,
});

try {
  for (const scriptPath of scriptPaths) {
    const script = fs.readFileSync(scriptPath, 'utf8');
    console.log(`Running ${path.basename(scriptPath)} against ${env('MYSQL_HOST') ?? 'localhost'}:${env('MYSQL_PORT') ?? 3306} …`);
    try {
      await conn.query(script);
      console.log('  ok');
    } catch (err) {
      console.error(`  FAIL  ${err.message}`);
      process.exit(1);
    }
  }
  console.log('Install complete.');
} finally {
  await conn.end().catch(() => {});
}
