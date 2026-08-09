#!/usr/bin/env node
/**
 * Reset the SQLite app-state tables to their default state — the companion to
 * re-running 01_internal_tables.sql (which resets the Snowflake side).
 *
 *   cd stand-ui && npm run reset-app-state
 *
 * Resets:
 *   • pipelines, runs          → emptied (autoincrement counters reset)
 *   • column_specs             → emptied (per-column specs belong to pipelines)
 *   • one_time_standardizations, validation_log → emptied
 *
 * Deliberately UNTOUCHED (so nobody has to re-onboard):
 *   • accounts, invitations, workspace_config, workspace_llm_config
 *
 * (Domains are gone — each pipeline column now carries its own spec, created
 * when the pipeline is set up, so there is nothing to reseed.)
 *
 * Restart the dev server afterwards — the poller and tick scheduler hold
 * in-memory state (verified streams, caches) referencing the old pipelines.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const standUi = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// PRISM_SQLITE_PATH from the environment or .env.local, default ./data/prism.db
let dbPath = process.env.PRISM_SQLITE_PATH?.trim();
if (!dbPath) {
  try {
    const env = fs.readFileSync(path.join(standUi, '.env.local'), 'utf8');
    dbPath = env.match(/^PRISM_SQLITE_PATH=(.+)$/m)?.[1]?.trim().replace(/^"|"$/g, '');
  } catch { /* no .env.local — use the default */ }
}
dbPath = dbPath || path.join(standUi, 'data', 'prism.db');

if (!fs.existsSync(dbPath)) {
  console.log(`No app database at ${dbPath} — nothing to reset (it is created with defaults on first boot).`);
  process.exit(0);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

const RESET_TABLES = ['pipelines', 'runs', 'column_specs', 'one_time_standardizations'];

const counts = {};
db.transaction(() => {
  for (const t of RESET_TABLES) {
    counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    db.prepare(`DELETE FROM ${t}`).run();
  }
  // Restart autoincrement counters so fresh pipelines/runs/specs start from 1.
  db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${RESET_TABLES.map(() => '?').join(', ')})`).run(...RESET_TABLES);
})();

db.close();

console.log(`App state reset (${dbPath}):`);
for (const t of RESET_TABLES) console.log(`  • ${t}: ${counts[t]} row(s) removed`);
console.log(`accounts / workspace config untouched.`);
console.log(`Warehouse-side state (RUN_STATE, VALIDATION_LOG, lookup, queue) resets via 01_internal_tables.sql.`);
console.log(`\nNow restart the dev server (the poller holds in-memory state for the old pipelines).`);
