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
 * Billing-event EMISSION (native edition only — nothing emits elsewhere):
 * after each metering write, emitPendingBillingEvents drains the accrued
 * charge into Snowflake billing events via the app's EMIT_BILLING proc
 * (native/setup.sql — SYSTEM$CREATE_BILLING_EVENT is callable ONLY from a
 * setup-script proc). Bookkeeping is two append-only ledgers:
 * BILLING_METER (accrued) and BILLING_EVENTS (emitted); pending is their
 * difference, so every pass self-heals earlier emission failures. Events
 * are whole cents (the system function caps base_charge at 2 decimals; the
 * unit price is $0.025) — the sub-cent tail stays pending, never lost.
 * Failure side is chosen deliberately: the event row is recorded BEFORE the
 * system call and deleted if the call fails, so a crash in that window
 * UNDER-bills (customer's favor) rather than double-billing.
 */
import 'server-only';

import { getWarehouseAdapter } from './warehouse';
import { internalObject, appCodeObject } from './warehouse-tables';
import { isNativeEdition } from './edition';
import { reportError } from './report-error';
import { splitBillableUnits, planBillingEmission } from './billing-math';

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
    return;
  }
  // Native: drain the accrued charge into billing events on the same (awake)
  // connection. Its own try/catch — an emission failure just stays pending.
  await emitPendingBillingEvents(conn);
}

// ── Billing-event emission (native edition — §2.8) ───────────────────────────

let _eventsEnsured = false;
async function ensureEventsTable(conn: Conn): Promise<void> {
  if (_eventsEnsured) return;
  await exec(conn, `CREATE TABLE IF NOT EXISTS ${internalObject('BILLING_EVENTS')} (
    id               INTEGER AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY NOT NULL,
    charge_usd       NUMBER(12,2) NOT NULL,
    through_meter_id INTEGER,
    emitted_at       TIMESTAMP_NTZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
  )`);
  _eventsEnsured = true;
}

// In-process serialization: two concurrent exports must not both compute the
// same pending amount and double-emit. One long-lived Node process per
// installation is a deployment invariant (CLAUDE.md), so a module-level chain
// is a real mutex here.
let _emitChain: Promise<void> = Promise.resolve();

/**
 * Emit the pending accrued charge (whole cents, capped per event) as ONE
 * Snowflake billing event via the app's EMIT_BILLING proc. Native edition
 * only; never throws. Self-healing: pending = SUM(meter) − SUM(events), so a
 * failed or skipped emission is retried by the next standardization pass.
 */
let _listingUnavailableLogged = false;

export async function emitPendingBillingEvents(conn: Conn): Promise<void> {
  if (!isNativeEdition() || getWarehouseAdapter().kind !== 'snowflake') return;
  const run = _emitChain.then(async () => {
    await ensureEventsTable(conn);
    const accruedRows = await exec(conn,
      `SELECT COALESCE(SUM(charge_usd), 0) AS C, COALESCE(MAX(id), 0) AS M
       FROM ${internalObject('BILLING_METER')}`);
    const emittedRows = await exec(conn,
      `SELECT COALESCE(SUM(charge_usd), 0) AS C FROM ${internalObject('BILLING_EVENTS')}`);
    const accrued = Number(accruedRows?.[0]?.C ?? accruedRows?.[0]?.c ?? 0);
    const throughId = Number(accruedRows?.[0]?.M ?? accruedRows?.[0]?.m ?? 0);
    const emitted = Number(emittedRows?.[0]?.C ?? emittedRows?.[0]?.c ?? 0);
    const plan = planBillingEmission(accrued, emitted);
    if (plan.emitUsd < 0.01) return;

    // Record first, emit second, delete on failure — a crash between the two
    // UNDER-bills (see module doc). MAX(id) readback is safe: emission is
    // serialized in-process and this process is the only writer.
    await exec(conn,
      `INSERT INTO ${internalObject('BILLING_EVENTS')} (charge_usd, through_meter_id) VALUES (?, ?)`,
      [plan.emitUsd, throughId]);
    const idRows = await exec(conn,
      `SELECT MAX(id) AS ID FROM ${internalObject('BILLING_EVENTS')}`);
    const eventId = Number(idRows?.[0]?.ID ?? idRows?.[0]?.id ?? 0);
    try {
      await exec(conn, `CALL ${appCodeObject('EMIT_BILLING')}(?, ?)`, [plan.emitUsd, throughId]);
    } catch (callErr) {
      await exec(conn,
        `DELETE FROM ${internalObject('BILLING_EVENTS')} WHERE id = ?`, [eventId]);
      throw callErr;
    }
  });
  // Chain must survive a rejection or every later emission would fail too.
  _emitChain = run.catch(() => {});
  try {
    await run;
  } catch (err) {
    // Dev/package installs cannot emit billing events at all —
    // SYSTEM$CREATE_BILLING_EVENT requires a LISTING install (live-found
    // 2026-08-14: "Application instance is not installed from listing").
    // Not an error: the charge stays pending in the ledgers and drains on
    // the first pass after a listing install. Log once, quietly.
    if (/not installed from listing/i.test(String((err as Error)?.message ?? err))) {
      if (!_listingUnavailableLogged) {
        _listingUnavailableLogged = true;
        console.log('[billing] emission unavailable (not a listing install) — charges stay pending');
      }
      return;
    }
    // Stays pending; the next pass retries. Loud — this is revenue.
    reportError(err, { where: 'billing-emit' });
  }
}
