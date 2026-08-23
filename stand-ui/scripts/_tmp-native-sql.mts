/**
 * Scratch SQL runner for the N3 native install loop (untracked, like the
 * other _tmp-* scripts). Connects as PRISM_SVC (key-pair from .env.local) and
 * executes the statements in the file passed as argv[2]. Statements are
 * separated by a line containing exactly `--;;` (so $$ proc bodies and
 * semicolons inside them survive). Prints each statement's first rows.
 *
 *   npx tsx scripts/_tmp-native-sql.mts /path/to/statements.sql [ROLE]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const line of fs.readFileSync(path.join(here, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
}

const require2 = createRequire(path.join(here, '..', 'package.json'));
const snowflake = require2('snowflake-sdk');

const file = process.argv[2];
if (!file) { console.error('usage: tsx _tmp-native-sql.mts <file.sql> [ROLE]'); process.exit(1); }
const roleOverride = process.argv[3];

const statements = fs.readFileSync(file, 'utf8')
  .split(/^--;;\s*$/m)
  .map(s => s.trim())
  .filter(s => s.length > 0);

const conn = snowflake.createConnection({
  account:   process.env.SNOWFLAKE_ACCOUNT,
  username:  process.env.SNOWFLAKE_USER,
  warehouse: process.env.SNOWFLAKE_WAREHOUSE,
  role:      roleOverride ?? process.env.SNOWFLAKE_ROLE,
  authenticator: 'SNOWFLAKE_JWT',
  privateKey: fs.readFileSync(process.env.SNOWFLAKE_PRIVATE_KEY_PATH!, 'utf8'),
});

function exec(sqlText: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({ sqlText, complete: (err: any, _s: any, rows: any[]) => err ? reject(err) : resolve(rows ?? []) });
  });
}

await new Promise<void>((res, rej) => conn.connect((e: any) => e ? rej(e) : res()));
let failed = 0;
for (const stmt of statements) {
  const label = stmt.replace(/\s+/g, ' ').slice(0, 110);
  try {
    const rows = await exec(stmt);
    console.log(`\nOK  ${label}`);
    for (const r of rows.slice(0, 15)) console.log('   ', JSON.stringify(r));
    if (rows.length > 15) console.log(`    … ${rows.length - 15} more rows`);
  } catch (e: any) {
    failed++;
    console.log(`\nERR ${label}\n    ${String(e?.message ?? e)}`);
  }
}
await new Promise<void>((res) => conn.destroy(() => res()));
if (failed) { console.error(`\n${failed} statement(s) failed`); process.exit(1); }
console.log('\nall statements ok');
