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

// ── Emission planning (native edition — SYSTEM$CREATE_BILLING_EVENT) ────────
//
// The system function accepts base_charge with AT MOST TWO decimal places and
// requires it > 0 and < 99,999.99 (docs, verified 2026-08-13). Our unit price
// is $0.025 — three decimals — so accrued charges are floored to whole cents
// at emission and the sub-cent remainder CARRIES FORWARD in the ledger
// arithmetic (pending = accrued − emitted; nothing is ever rounded away).
// 251 units = $6.275 accrued → emit $6.27, carry $0.005 into the next event.

/** Hard per-event ceiling (the function rejects ≥ 99,999.99). An accrual past
 *  it emits this much and carries the rest — the next pass emits again. */
export const MAX_EVENT_USD = 99_999.98;

export interface EmissionPlan {
  /** Whole-cent amount to emit now (0 = nothing emittable yet). */
  emitUsd: number;
  /** Sub-cent (or over-cap) remainder left pending after this emission. */
  carryUsd: number;
}

/** Plan the next billing event from ledger sums. All arithmetic in integer
 *  ten-thousandths of a dollar — every charge is a multiple of $0.0001
 *  (unit price $0.025, stored NUMBER(12,4)) — so float error cannot move a
 *  cent. Negative/NaN inputs clamp to 0. */
export function planBillingEmission(accruedUsd: number, emittedUsd: number): EmissionPlan {
  const accrued4 = Math.max(0, Math.round((Number(accruedUsd) || 0) * 10_000));
  const emitted4 = Math.max(0, Math.round((Number(emittedUsd) || 0) * 10_000));
  const pending4 = Math.max(0, accrued4 - emitted4);
  const cents = Math.floor(pending4 / 100);           // whole cents emittable
  const emit4 = Math.min(cents * 100, MAX_EVENT_USD * 10_000);
  return { emitUsd: emit4 / 10_000, carryUsd: (pending4 - emit4) / 10_000 };
}
