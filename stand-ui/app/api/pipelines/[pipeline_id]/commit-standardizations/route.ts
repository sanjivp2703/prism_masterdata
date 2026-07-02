/**
 * POST /api/pipelines/[pipeline_id]/commit-standardizations
 *
 * Premium only. Performs the DEFERRED lookup writes for one column at the
 * "Begin Pipeline Standardization" step. The review wizard accepts each column
 * with `defer: true` (no lookup writes, run marked 'approved'); this endpoint
 * finds that approved run and runs the export (upserting LITERAL_ALIAS_MATCHES +
 * APPROVED_ALIAS_NAMES), then advances the pipeline pending_baseline → paused and
 * clears its queue. Begin then activates the columns together.
 *
 * Idempotent: an already-committed run ('completed') is skipped.
 */

import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { premiumModeGuard } from '@/app/api/_lib/feature-flags';
import { runOpExport } from '@/app/api/_lib/op-export';
import { appendTiming } from '@/app/api/_lib/timing';
import { syncSheetsColumn, type SheetsSyncPipeline } from '@/app/api/_lib/op-file-pipeline';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ pipeline_id: string }> },
) {
  const cookieStore = await cookies();
  const session     = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const modeBlocked = premiumModeGuard();
  if (modeBlocked) return modeBlocked;

  const { pipeline_id } = await params;
  const pid = Number(pipeline_id);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Response.json({ error: 'Invalid pipeline_id' }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Response.json({ error: 'ANTHROPIC_API_KEY is not configured.' }, { status: 500 });

  try {
    let sheetsPipeline: SheetsSyncPipeline | null = null;

    await withSnowflake(async (conn) => {
      const _t0 = Date.now();

      // Fetch pipeline metadata (source meta carries multi-column spec for Sheets).
      const plRows = await exec(
        conn,
        `SELECT source_type, file_source_meta, file_export_meta, domain_id, column_name, table_fqn
         FROM STAND_DB.STAND_INTERNAL.PIPELINES WHERE pipeline_id = ?`,
        [pid],
      );
      if (plRows.length === 0) {
        appendTiming(`[Timing] commit.standardizations: ${Date.now() - _t0}ms (pipeline ${pid} not found)`);
        return;
      }

      const pr = plRows[0] as any;
      const srcType      = String(pr.SOURCE_TYPE      ?? pr.source_type      ?? '');
      const tableFqn     = String(pr.TABLE_FQN        ?? pr.table_fqn        ?? '');
      const rawSourceMeta = pr.FILE_SOURCE_META ?? pr.file_source_meta ?? null;
      const rawExportMeta = pr.FILE_EXPORT_META ?? pr.file_export_meta ?? null;

      if (srcType === 'sheets') {
        let parsedExportMeta: Record<string, any> = {};
        try {
          parsedExportMeta = typeof rawExportMeta === 'object' && rawExportMeta !== null
            ? rawExportMeta : JSON.parse(String(rawExportMeta ?? '{}'));
        } catch { /* ignore */ }
        sheetsPipeline = {
          file_source_meta: rawSourceMeta,
          file_export_meta: rawExportMeta,
          column_name:      String(pr.COLUMN_NAME ?? pr.column_name ?? ''),
          domain_id:        pr.DOMAIN_ID != null ? Number(pr.DOMAIN_ID) : (pr.domain_id != null ? Number(pr.domain_id) : null),
          output_tab_name:  parsedExportMeta.output_tab_name ? String(parsedExportMeta.output_tab_name) : null,
        };
      }

      // Determine the column configs to export. Multi-column Sheets pipelines store all
      // columns in file_source_meta.columns; single-column pipelines use the row fields.
      let parsedSourceMeta: Record<string, any> = {};
      try {
        parsedSourceMeta = typeof rawSourceMeta === 'object' && rawSourceMeta !== null
          ? rawSourceMeta : JSON.parse(String(rawSourceMeta ?? '{}'));
      } catch { /* ignore */ }

      const colConfigs: { column_name: string; domain_id: number | null }[] =
        Array.isArray(parsedSourceMeta?.columns) && parsedSourceMeta.columns.length > 1
          ? parsedSourceMeta.columns.map((c: any) => ({
              column_name: String(c.column_name ?? ''),
              domain_id:   c.domain_id != null ? Number(c.domain_id) : null,
            }))
          : [{
              column_name: String(pr.COLUMN_NAME ?? pr.column_name ?? ''),
              domain_id:   pr.DOMAIN_ID != null ? Number(pr.DOMAIN_ID) : (pr.domain_id != null ? Number(pr.domain_id) : null),
            }];

      // Export the most-recent review run for each column.
      for (const col of colConfigs) {
        if (!col.column_name) continue;
        const runRows = await exec(
          conn,
          `SELECT run_id, run_status
           FROM STAND_DB.STAND_INTERNAL.RUNS
           WHERE source_relation = ?
             AND source_column   = ?
             AND (domain_id = ? OR (? IS NULL AND domain_id IS NULL))
           ORDER BY run_id DESC LIMIT 1`,
          [tableFqn, col.column_name, col.domain_id, col.domain_id],
        );
        if (runRows.length > 0) {
          const runId     = Number((runRows[0] as any).RUN_ID     ?? (runRows[0] as any).run_id);
          const runStatus = String((runRows[0] as any).RUN_STATUS ?? (runRows[0] as any).run_status ?? '').toLowerCase();
          await runOpExport(conn, runId, apiKey, runStatus, { awaitWrite: true });
        }
      }

      await exec(conn, `DELETE FROM STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE WHERE pipeline_id = ?`, [pid]);

      // Advance pending_baseline → paused (ready to activate). No-op if already paused/active.
      await exec(
        conn,
        `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
         SET status              = CASE WHEN status = 'pending_baseline' THEN 'paused' ELSE status END,
             queue_size          = 0,
             last_queue_empty_at = CURRENT_TIMESTAMP(),
             updated_at          = CURRENT_TIMESTAMP()
         WHERE pipeline_id = ?`,
        [pid],
      );

      appendTiming(`[Timing] commit.standardizations: ${Date.now() - _t0}ms (pipeline ${pid})`);
    });

    // For Sheets pipelines: write confirmed mappings to the output spreadsheet now
    // that LITERAL_ALIAS_MATCHES has been populated by runOpExport above.
    // Awaited (not fire-and-forget) so that the sync completes before we return,
    // preventing races with any subsequent process-queue call.
    if (sheetsPipeline) {
      const cookieStore    = await cookies();
      const gAccessToken   = cookieStore.get('google_access_token')?.value;
      const gRefreshToken  = cookieStore.get('google_refresh_token')?.value;
      const gTokenExpiry   = cookieStore.get('google_token_expiry')?.value;
      try {
        await syncSheetsColumn(sheetsPipeline, gAccessToken, gRefreshToken, gTokenExpiry);
      } catch (e: any) {
        console.warn('[commit-standardizations] sheets sync error:', e?.message ?? e);
      }
    }

    return Response.json({ ok: true, pipeline_id: pid }, { status: 200 });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to commit standardizations');
  }
}
