/**
 * GET /api/pipelines/[pipeline_id]/mappings
 * Returns all confirmed mappings for the pipeline's domain.
 * Joins LITERAL_ALIAS_MATCHES ← APPROVED_ALIAS_NAMES.
 * Supports ?search=... and ?limit=... query params.
 */

import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ pipeline_id: string }> },
) {
  const { pipeline_id } = await params;
  const pid = Number(pipeline_id);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Response.json({ error: 'Invalid pipeline_id' }, { status: 400 });
  }

  const url    = new URL(request.url);
  const search = url.searchParams.get('search')?.trim() ?? '';
  const limit  = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '200')));

  try {
    return await withSnowflake(async (conn) => {
      // Fetch pipeline to get domain_id, table, column
      const pRows = await exec(
        conn,
        `SELECT domain_id, table_fqn, column_name
         FROM STAND_DB.STAND_INTERNAL.PIPELINES
         WHERE pipeline_id = ?`,
        [pid],
      );
      if (!pRows.length) return Response.json({ error: 'Pipeline not found' }, { status: 404 });

      const domain_id: number | null = (pRows[0] as any).DOMAIN_ID ?? (pRows[0] as any).domain_id ?? null;
      const domainFilter = domain_id != null
        ? `AND lam.domain_id = ${Number(domain_id)}`
        : `AND lam.domain_id IS NULL`;

      const searchFilter = search
        ? `AND (LOWER(lam.literal_value) LIKE LOWER('%' || ? || '%') OR LOWER(aan.alias_name) LIKE LOWER('%' || ? || '%'))`
        : '';
      const searchBinds = search ? [search, search] : [];

      const rows = await exec(
        conn,
        `SELECT
           lam.literal_value,
           aan.alias_name,
           lam.run_id,
           lam.confirmed_at
         FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
         JOIN STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES  aan
           ON aan.alias_id = lam.alias_id
         WHERE 1=1
           ${domainFilter}
           ${searchFilter}
         ORDER BY lam.confirmed_at DESC
         LIMIT ${limit}`,
        searchBinds,
      );

      const mappings = rows.map(r => ({
        literal_value: String((r as any).LITERAL_VALUE ?? (r as any).literal_value ?? ''),
        alias_name:    String((r as any).ALIAS_NAME    ?? (r as any).alias_name    ?? ''),
        run_id:        Number((r as any).RUN_ID        ?? (r as any).run_id        ?? 0),
        confirmed_at:  (r as any).CONFIRMED_AT ?? (r as any).confirmed_at ?? null,
      }));

      // Total count for the domain (regardless of search)
      const countRows = await exec(
        conn,
        `SELECT COUNT(*) AS cnt
         FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
         WHERE 1=1 ${domainFilter}`,
      );
      const total = Number((countRows[0] as any).CNT ?? (countRows[0] as any).cnt ?? 0);

      return Response.json({ mappings, total });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to fetch mappings');
  }
}
