/**
 * GET /api/accounts/usage (admin) — the §2.8 billing meter, read back for the
 * Settings → Usage surface. Customers billed per value must be able to see
 * the meter driving the charges (docs/NATIVE_APP_PLAN.md §2.8).
 *
 * One-shot user-clicked read — a warehouse wake here is acceptable (never
 * called from polling surfaces). A missing ledger table (install predating
 * the meter, or nothing standardized yet) reports zeros, not an error.
 */
import { requireAdminSession } from '@/app/api/_lib/account-security';
import { withWarehouse, executeQuery, getWarehouseAdapter } from '@/app/api/_lib/warehouse';
import { internalObject } from '@/app/api/_lib/warehouse-tables';
import { FREE_UNITS, USD_PER_UNIT } from '@/app/api/_lib/billing-math';

export const dynamic = 'force-dynamic';

export async function GET() {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;

  const empty = {
    available: true,
    total_units: 0,
    free_units: FREE_UNITS,
    free_used: 0,
    free_remaining: FREE_UNITS,
    billable_units: 0,
    charged_usd: 0,
    usd_per_unit: USD_PER_UNIT,
  };

  // Meter is Snowflake-only for now (see billing-meter.ts).
  if (getWarehouseAdapter().kind !== 'snowflake') {
    return Response.json({ ...empty, available: false });
  }

  try {
    return await withWarehouse(async (conn) => {
      const rows = await executeQuery(
        conn,
        `SELECT COALESCE(MAX(total_after), 0) AS TOTAL,
                COALESCE(SUM(charge_usd), 0)  AS CHARGED
         FROM ${internalObject('BILLING_METER')}`,
      );
      const r = rows?.[0] ?? {};
      const total = Number(r.TOTAL ?? r.total ?? 0);
      const charged = Number(r.CHARGED ?? r.charged ?? 0);
      const freeUsed = Math.min(total, FREE_UNITS);
      return Response.json({
        ...empty,
        total_units: total,
        free_used: freeUsed,
        free_remaining: FREE_UNITS - freeUsed,
        billable_units: Math.max(0, total - FREE_UNITS),
        charged_usd: Math.round(charged * 100) / 100,
      });
    });
  } catch (err) {
    // Table missing / connection unavailable → zeros, flagged unavailable.
    console.error('[usage] meter read failed:', err);
    return Response.json({ ...empty, available: false });
  }
}
