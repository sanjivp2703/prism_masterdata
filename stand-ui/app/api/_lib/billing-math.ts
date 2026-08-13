// Billing arithmetic for the §2.8 usage meter (docs/NATIVE_APP_PLAN.md).
// Pure module — no server-only — so the parity suite can exercise it and the
// future Settings → Usage surface can share the constants.
//
// Pricing (owner decisions 2026-08-12/13): $25 per 1,000 new distinct
// standardized values, first 1,000 free (lifetime, per installation), billed
// LINEARLY per value after the free tier — value #1,001 bills at $0.025
// immediately; never quantized into blocks.

export const FREE_UNITS = 1_000;
export const USD_PER_UNIT = 0.025;

export interface BillableSplit {
  /** Units of this increment absorbed by the remaining free tier. */
  free: number;
  /** Units of this increment that bill. */
  billable: number;
  /** billable × USD_PER_UNIT, rounded to 4 decimals (cents-safe). */
  chargeUsd: number;
}

/** Split an increment of newly standardized distinct values into free vs
 *  billable given the cumulative total BEFORE this increment. An increment
 *  straddling the boundary bills only its post-free portion. */
export function splitBillableUnits(totalBefore: number, units: number): BillableSplit {
  const prior = Math.max(0, Math.floor(totalBefore));
  const n = Math.max(0, Math.floor(units));
  const freeLeft = Math.max(0, FREE_UNITS - prior);
  const free = Math.min(n, freeLeft);
  const billable = n - free;
  return { free, billable, chargeUsd: Math.round(billable * USD_PER_UNIT * 10_000) / 10_000 };
}
