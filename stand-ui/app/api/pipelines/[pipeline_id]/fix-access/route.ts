/* eslint-disable @typescript-eslint/no-explicit-any --
   binds/rows are untyped driver values by nature (see ../../_lib/warehouse/types.ts). */
/**
 * POST /api/pipelines/[pipeline_id]/fix-access
 *
 * Attempts to automatically grant whatever warehouse permission a pipeline is
 * currently paused for (status_reason), using the pipeline CREATOR's saved
 * personal credentials — the service login can never grant its own way onto
 * a customer schema. Currently handles 'table_mode_access' (mssql table-mode
 * exports need CREATE TABLE + ALTER ON SCHEMA on the destination schema).
 *
 * On success: resumes the pipeline and rebuilds the export immediately, so
 * the fix is visibly complete rather than waiting for the next tick.
 * On failure (no saved personal credentials, or the grant itself fails): the
 * pipeline stays paused and the response carries the exact SQL for an admin
 * to run by hand instead.
 */

import { requireValidSession } from '@/app/api/_lib/account-security';
import { getDb } from '@/app/api/_lib/sqlite';
import { refreshExportTable, provisionTableModeAccess, tableModeSetupSql } from '@/app/api/_lib/export-table';
import { asExportKind } from '@/app/api/_lib/export-kind';
import { warehouseErrorResponse } from '@/app/api/_lib/warehouse';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ pipeline_id: string }> },
) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;

  const { pipeline_id } = await params;
  const pid = Number(pipeline_id);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Response.json({ error: 'Invalid pipeline_id' }, { status: 400 });
  }

  const row = getDb()
    .prepare(
      `SELECT table_fqn, column_name, export_table_fqn, export_kind, domain_id, status, status_reason, created_by
       FROM pipelines WHERE pipeline_id = ?`,
    )
    .get(pid) as any ?? null;
  if (!row) return Response.json({ error: `Pipeline ${pid} not found` }, { status: 404 });

  const statusReason = String(row.status_reason ?? row.STATUS_REASON ?? '');
  const exportTableFqn = row.export_table_fqn ?? row.EXPORT_TABLE_FQN ?? null;
  const createdBy = row.created_by != null ? Number(row.created_by ?? row.CREATED_BY) : NaN;

  if (statusReason !== 'table_mode_access' || !exportTableFqn) {
    return Response.json({ error: 'This pipeline is not paused for a fixable permission issue.' }, { status: 400 });
  }

  const granted = await provisionTableModeAccess(exportTableFqn, createdBy);
  if (granted !== 'granted') {
    return Response.json({
      ok: false,
      fixed: false,
      manual_sql: tableModeSetupSql(exportTableFqn),
      error: Number.isFinite(createdBy)
        ? "Couldn't grant access automatically — the pipeline creator may not have saved personal credentials, or the grant itself failed. Run this SQL as a sysadmin instead:"
        : 'No saved personal credentials for this pipeline’s creator. Run this SQL as a sysadmin instead:',
    });
  }

  const tableFqn   = String(row.table_fqn   ?? row.TABLE_FQN   ?? '');
  const columnName = String(row.column_name ?? row.COLUMN_NAME ?? '');
  const domainId   = (row.domain_id ?? row.DOMAIN_ID) != null ? Number(row.domain_id ?? row.DOMAIN_ID) : null;
  const exportKind = asExportKind(row.export_kind ?? row.EXPORT_KIND);

  getDb()
    .prepare(`UPDATE pipelines SET status = 'active', status_message = NULL, status_reason = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE pipeline_id = ?`)
    .run(pid);

  try {
    const result = await refreshExportTable(tableFqn, columnName, exportTableFqn, domainId, pid, exportKind);
    return Response.json({ ok: true, fixed: true, rows_written: result.rows_written });
  } catch (err) {
    // Granting succeeded but the rebuild still failed for some OTHER reason —
    // don't leave the pipeline claiming 'active' with a silently broken export.
    return warehouseErrorResponse(err, 'Access was granted, but rebuilding the export table failed');
  }
}
