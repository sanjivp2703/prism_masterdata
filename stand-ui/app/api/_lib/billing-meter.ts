/**
 * §2.8 usage meter (docs/NATIVE_APP_PLAN.md) — records newly standardized
 * distinct values into the warehouse-side BILLING_METER ledger.
 *
 * THE RULE: callers pass ACTUAL INSERTED-ROW COUNTS reported by the lookup
 * MERGEs (or the one-time export's distinct-value count) — never candidate
 * counts. Idempotent-retry batches therefore cannot double-bill: a retried
 * MERGE matches instead of inserting and reports 0.
 *
 * The ledger is warehouse-side (survives container loss; native edition's
 * SQLite is a volume that could be recreated) and append-only: each row is
 * one metering record with its free/billable split frozen at write time.
 * Snowflake-family only for now — the native (Marketplace) edition is the
 * driving consumer; wiring the standard edition's other warehouses for
 * invoice rollups is deferred (recorded in the plan).
 *
 * A metering failure NEVER blocks or fails an export (reportError + move on).
 *
 * Billing-event EMISSION (SYSTEM$CREATE_BILLING_EVENTS) is a separate step
 * that only exists inside an installed, monetized Native App — it lands with
 * the N3 application package (the EMIT_BILLING proc in native/setup.sql).
 * Until then the ledger accumulates and nothing is emitted.
 */
import 'server-only';

import { getWarehouseAdapter } from './warehouse';
import { internalObject } from './warehouse-tables';
import { reportError } from './report-error';
import { splitBillableUnits } from './billing-math';

type Conn = unknown;

function exec(conn: Conn, sql: string, binds?: unknown[]): Promise<any[]> {
  return getWarehouseAdapter().executeQuery(conn, sql, binds as any[]);
}

// Once per process: the ledger table exists on standard installs too (the
// native setup.sql creates it at install; 01_internal_tables.sql predates it).
let _ensured = false;
async function ensureMeterTable(conn: Conn): Promise<void> {
  if (_ensured) return;
  await exec(conn, `CREATE TABLE IF NOT EXISTS ${internalObject('BILLING_METER')} (
    id            INTEGER AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    event_units   INTEGER NOT NULL,
    charge_usd    NUMBER(12,4) NOT NULL,
    total_after   INTEGER NOT NULL,
    source        VARCHAR,
    emitted_at    TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
  )`);
  _ensured = true;
}

/**
 * Record `units` newly standardized distinct values (MERGE-reported inserts).
 * Reuses the caller's open connection — the warehouse is already awake doing
 * the export this metering describes. No-op for units <= 0 and on
 * non-Snowflake warehouses (native is Snowflake-only; see module doc).
 */
export async function recordStandardizedUnits(
  conn: Conn,
  units: number,
  source: 'pipeline_export' | 'commit_standardizations' | 'one_time_export',
): Promise<void> {
  if (!Number.isFinite(units) || units <= 0) return;
  if (getWarehouseAdapter().kind !== 'snowflake') return;
  try {
    await ensureMeterTable(conn);
    const rows = await exec(conn,
      `SELECT COALESCE(MAX(total_after), 0) AS T FROM ${internalObject('BILLING_METER')}`);
    const totalBefore = Number(rows?.[0]?.T ?? rows?.[0]?.t ?? 0);
    const split = splitBillableUnits(totalBefore, units);
    await exec(conn,
      `INSERT INTO ${internalObject('BILLING_METER')} (event_units, charge_usd, total_after, source)
       VALUES (?, ?, ?, ?)`,
      [Math.floor(units), split.chargeUsd, totalBefore + Math.floor(units), source]);
  } catch (err) {
    // Metering must never take an export down.
    reportError(err, { where: 'billing-meter', units, source });
  }
}
