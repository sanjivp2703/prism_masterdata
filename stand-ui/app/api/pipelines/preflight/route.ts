/* eslint-disable @typescript-eslint/no-explicit-any --
   binds/rows are untyped driver values by nature (see ../../_lib/warehouse/types.ts). */
/**
 * GET /api/pipelines/preflight
 *
 * Called once, at the moment the user clicks "Create pipeline" — never as the
 * user types. Reports which warehouse permissions are missing for the table/
 * export the form is about to submit, so the client can show one unmissable
 * "Prism will enable the following — approve or cancel" popup before any grant
 * is attempted, instead of silently fixing things (or silently failing later).
 *
 * mssql only — Snowflake's onboarding wizard (Part D) already grants
 * everything a pipeline needs up front, so this always reports nothing there.
 *
 * Query params: table_fqn, column_name, export_kind ('table'|'view'|'column'),
 * export_table_fqn (only meaningful for 'table').
 */
import { requireValidSession } from '@/app/api/_lib/account-security';
import { withWarehouse, getWarehouseAdapter } from '@/app/api/_lib/warehouse';
import { getPrimaryKeyColumns, isCtEnabled, hasViewChangeTrackingPermission } from '@/app/api/_lib/warehouse/mssql/detection';
import { hasTableModePermissions } from '@/app/api/_lib/warehouse/mssql/export';
import { parseFqn } from '@/app/api/_lib/warehouse/mssql/dialect';

export interface PreflightItem {
  key:    'change_tracking' | 'table_mode_access';
  label:  string;
  detail: string;
}

export async function GET(request: Request) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;

  if (getWarehouseAdapter().kind !== 'mssql') {
    return Response.json({ items: [] });
  }

  const { searchParams } = new URL(request.url);
  const table_fqn         = searchParams.get('table_fqn')?.trim() ?? '';
  const export_kind       = searchParams.get('export_kind') ?? 'table';
  const export_table_fqn  = searchParams.get('export_table_fqn')?.trim() || null;

  const items: PreflightItem[] = [];

  try {
    await withWarehouse(async (conn) => {
      // ── Change Tracking: only offered when the table can even have it
      // (needs a primary key) — a PK-less table just uses scheduled scans,
      // nothing to approve. ──────────────────────────────────────────────
      if (table_fqn.split('.').filter(Boolean).length === 3) {
        const pkCols = await getPrimaryKeyColumns(conn, table_fqn).catch(() => []);
        if (pkCols.length > 0) {
          const ct = await isCtEnabled(conn, table_fqn);
          const canView = (ct.db && ct.table) ? await hasViewChangeTrackingPermission(conn, table_fqn) : false;
          if (!ct.db || !ct.table || !canView) {
            items.push({
              key:   'change_tracking',
              label: 'Enable Change Tracking',
              detail:
                `Turns on SQL Server's Change Tracking for ${table_fqn} and grants Prism's service login ` +
                `permission to read it, so new, changed, or deleted values are detected within about a minute ` +
                `instead of on a slower scheduled scan.`,
            });
          }
        }
      }

      // ── Table-mode export: only relevant when this pipeline builds a
      // materialized export table. ────────────────────────────────────────
      if (export_kind === 'table' && export_table_fqn && export_table_fqn.split('.').filter(Boolean).length === 3) {
        const ok = await hasTableModePermissions(conn, export_table_fqn).catch(() => false);
        if (!ok) {
          const { schema } = parseFqn(export_table_fqn);
          items.push({
            key:   'table_mode_access',
            label: 'Grant table-creation access',
            detail:
              `Grants CREATE TABLE (database-wide) and ALTER on the "${schema}" schema, so Prism can build and ` +
              `rebuild ${export_table_fqn}. This never touches any of your other existing tables, but the grants ` +
              `themselves are schema/database-scoped, not limited to just this one export table.`,
          });
        }
      }
    });
  } catch (err) {
    // Non-fatal — if the check itself can't run (e.g. connection hiccup),
    // don't block creation on it; the reactive pause/flag paths still catch
    // a genuinely missing permission afterward.
    console.warn('[Preflight] check failed:', (err as any)?.message ?? err);
  }

  return Response.json({ items });
}
