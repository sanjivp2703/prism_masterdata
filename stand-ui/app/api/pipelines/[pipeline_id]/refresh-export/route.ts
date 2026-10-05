/**
 * POST /api/pipelines/[pipeline_id]/refresh-export
 *
 * Synchronously rebuilds the standardized export table for a pipeline.
 * Returns the row count written so the caller can confirm it worked.
 */

import { withWarehouse, warehouseErrorResponse } from '@/app/api/_lib/warehouse';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getDb } from '@/app/api/_lib/sqlite';
import { refreshExportTable } from '@/app/api/_lib/export-table';
import { asExportKind } from '@/app/api/_lib/export-kind';
import { clearPipelineStatusMessage } from '@/app/api/_lib/pipeline-alerts';
import { probeNativeExportCollision } from '@/app/api/_lib/native-access';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ pipeline_id: string }> },
) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  const { pipeline_id } = await params;
  const pid = Number(pipeline_id);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Response.json({ error: 'Invalid pipeline_id' }, { status: 400 });
  }

  // Hoisted so the catch can name the destination when explaining a failure.
  let exportTableFqnForError: string | null = null;
  try {
    // Fetch the pipeline so we have all the info needed for the refresh.
    const row = getDb()
      .prepare(
        `SELECT table_fqn, column_name, export_table_fqn, export_kind, domain_id, status
         FROM pipelines WHERE pipeline_id = ?`,
      )
      .get(pid) as any ?? null;

    if (!row) {
      return Response.json({ error: `Pipeline ${pid} not found` }, { status: 404 });
    }

    const exportTableFqn = row.EXPORT_TABLE_FQN ?? row.export_table_fqn ?? null;
    exportTableFqnForError = exportTableFqn != null ? String(exportTableFqn) : null;
    if (!exportTableFqn) {
      return Response.json(
        { error: 'This pipeline does not have an export table configured.' },
        { status: 400 },
      );
    }

    const exportKind = asExportKind(row.EXPORT_KIND ?? row.export_kind);

    const tableFqn   = String(row.TABLE_FQN   ?? row.table_fqn   ?? '');
    const columnName = String(row.COLUMN_NAME ?? row.column_name ?? '');
    const domainId   = (row.DOMAIN_ID ?? row.domain_id) != null
      ? Number(row.DOMAIN_ID ?? row.domain_id) : null;

    // Run the refresh synchronously so any error is surfaced to the caller.
    // For a VIEW this is the repair path: a view is normally created once at
    // activation, and if that single fire-and-forget attempt failed (missing
    // CREATE VIEW grant, etc.) NOTHING else ever retries it — this route's
    // CREATE OR REPLACE VIEW is how the user fixes a missing/dropped view.
    const result = await refreshExportTable(tableFqn, columnName, exportTableFqn, domainId, pid, exportKind);

    // A successful build resolves any earlier export-failure flag. Only for
    // active pipelines — a paused pipeline's status_message is its pause reason.
    if (String(row.STATUS ?? row.status ?? '') === 'active') {
      await clearPipelineStatusMessage(pid).catch(() => {});
    }

    return Response.json({ ok: true, rows_written: result.rows_written, export_table_fqn: exportTableFqn, export_kind: exportKind });
  } catch (err) {
    // Native: a build that failed against a destination the app doesn't OWN
    // (pre-existing / one-time-export table) deserves its real explanation,
    // not a sanitized driver error. Probe only after failure — never blocks
    // a healthy rebuild.
    if (exportTableFqnForError) {
      const collision = await withWarehouse((conn) =>
        probeNativeExportCollision(conn, exportTableFqnForError!)).catch(() => null);
      if (collision) return Response.json({ error: collision }, { status: 409 });
    }
    return warehouseErrorResponse(err, 'Failed to refresh export table');
  }
}
