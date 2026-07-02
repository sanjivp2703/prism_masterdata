import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { premiumModeGuard } from '@/app/api/_lib/feature-flags';
import { readFilePipelineRowsForDownload } from '@/app/api/_lib/op-file-pipeline';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

function parseVariant(v: any): Record<string, any> {
  if (typeof v === 'object' && v !== null) return v as Record<string, any>;
  try { return JSON.parse(String(v)); } catch { return {}; }
}

/**
 * GET /api/pipelines/[pipeline_id]/download
 * Generates and streams a CSV with the standardized column appended.
 * Only works for CSV/Excel source pipelines (source_type != 'snowflake').
 */
export async function GET(
  _req: Request,
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

  try {
    return await withSnowflake(async (conn) => {
      const pRows = await exec(conn, `
        SELECT pipeline_id, column_name, domain_id, source_type, file_export_meta
        FROM STAND_DB.STAND_INTERNAL.PIPELINES WHERE pipeline_id = ? LIMIT 1
      `, [pid]);
      if (!pRows.length) return Response.json({ error: 'Pipeline not found' }, { status: 404 });

      const p           = pRows[0];
      const source_type = String(p.SOURCE_TYPE ?? p.source_type ?? 'snowflake');
      if (source_type === 'snowflake') {
        return Response.json({ error: 'Download is only available for file-based pipelines' }, { status: 400 });
      }

      const column_name = String(p.COLUMN_NAME ?? p.column_name ?? '');
      const domain_id   = (p.DOMAIN_ID ?? p.domain_id) != null ? Number(p.DOMAIN_ID ?? p.domain_id) : null;
      const meta        = parseVariant(p.FILE_EXPORT_META ?? p.file_export_meta);
      const suggested   = String(meta?.suggested_name ?? `pipeline_${pid}_standardized`);

      const { headers, rows } = await readFilePipelineRowsForDownload(conn, pid, column_name, domain_id);

      if (headers.length === 0) {
        return Response.json({ error: 'No data available for this pipeline' }, { status: 404 });
      }

      const escape = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
      const lines  = [
        headers.map(escape).join(','),
        ...rows.map(r => r.map(escape).join(',')),
      ];

      return new Response(lines.join('\n'), {
        headers: {
          'Content-Type':        'text/csv',
          'Content-Disposition': `attachment; filename="${suggested}.csv"`,
        },
      });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to generate download');
  }
}
