/**
 * GET  /api/pipelines  — list all pipelines with domain name joined
 * POST /api/pipelines  — create or upsert a pipeline
 */

import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { refreshExportTable } from '@/app/api/_lib/export-table';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

export function row2pipeline(r: any) {
  return {
    pipeline_id:         Number(r.PIPELINE_ID         ?? r.pipeline_id),
    name:                r.NAME                ?? r.name                ?? null,
    table_fqn:           String(r.TABLE_FQN           ?? r.table_fqn           ?? ''),
    column_name:         String(r.COLUMN_NAME         ?? r.column_name         ?? ''),
    export_table_fqn:    r.EXPORT_TABLE_FQN    ?? r.export_table_fqn    ?? null,
    domain_id:           r.DOMAIN_ID != null           ? Number(r.DOMAIN_ID    ?? r.domain_id) : null,
    domain_name:         r.DOMAIN_NAME         ?? r.domain_name         ?? null,
    status:              String(r.STATUS              ?? r.status              ?? 'active'),
    mode:                String(r.MODE                ?? r.mode                ?? 'auto'),
    queue_size:          Number(r.QUEUE_SIZE          ?? r.queue_size          ?? 0),
    total_new_values:    Number(r.TOTAL_NEW_VALUES     ?? r.total_new_values    ?? 0),
    last_polled_at:      r.LAST_POLLED_AT      ?? r.last_polled_at      ?? null,
    last_queue_empty_at: r.LAST_QUEUE_EMPTY_AT ?? r.last_queue_empty_at ?? null,
    created_at:          r.CREATED_AT          ?? r.created_at          ?? null,
    updated_at:          r.UPDATED_AT          ?? r.updated_at          ?? null,
    total_mapped:        Number(r.TOTAL_MAPPED  ?? r.total_mapped        ?? 0),
  };
}

const PIPELINE_SELECT = `
  SELECT
    p.pipeline_id,
    p.name,
    p.table_fqn,
    p.column_name,
    p.export_table_fqn,
    p.domain_id,
    d.name              AS domain_name,
    p.status,
    p.mode,
    p.queue_size,
    p.total_new_values,
    p.total_mapped,
    p.last_polled_at,
    p.last_queue_empty_at,
    p.created_at,
    p.updated_at
  FROM STAND_DB.STAND_INTERNAL.PIPELINES p
  LEFT JOIN STAND_DB.STAND_INTERNAL.DOMAINS d ON d.domain_id = p.domain_id`;

/**
 * GET /api/pipelines
 * Returns all pipelines, joining domain name. No extra auth required.
 */
export async function GET() {
  try {
    return await withSnowflake(async (conn) => {
      const rows = await exec(
        conn,
        `${PIPELINE_SELECT}
         ORDER BY
           p.last_polled_at DESC NULLS LAST,
           p.created_at     DESC`,
      );
      return Response.json({ pipelines: rows.map(row2pipeline) });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to fetch pipelines');
  }
}

/**
 * POST /api/pipelines
 * Body: { table_fqn, column_name, domain_id?, name?, status?, mode?, export_table_fqn? }
 *
 * Upserts on the unique key (table_fqn, column_name, domain_id).
 * Returns the pipeline row (created or existing, with updated status).
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const session = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const table_fqn        = String(body?.table_fqn        ?? '').trim();
  const column_name      = String(body?.column_name       ?? '').trim();
  const export_table_fqn = body?.export_table_fqn ? String(body.export_table_fqn).trim() : null;
  const domain_id        = body?.domain_id != null ? Number(body.domain_id) : null;
  const name             = body?.name ? String(body.name).trim() : null;
  const mode             = ['auto', 'manual'].includes(body?.mode) ? String(body.mode) : 'auto';
  const status           = ['active', 'paused', 'pending_baseline'].includes(body?.status)
    ? String(body.status)
    : 'active';

  if (!table_fqn)   return Response.json({ error: 'table_fqn is required' }, { status: 400 });
  if (!column_name) return Response.json({ error: 'column_name is required' }, { status: 400 });

  try {
    return await withSnowflake(async (conn) => {
      // Unqualified form for single-table queries against PIPELINES alone
      const domainFilter = domain_id != null
        ? `AND domain_id = ${Number(domain_id)}`
        : `AND domain_id IS NULL`;

      // Qualified form for queries that use PIPELINE_SELECT (which joins PIPELINES p with DOMAINS d)
      // — without the alias Snowflake raises "Ambiguous column name 'DOMAIN_ID'"
      const pDomainFilter = domain_id != null
        ? `AND p.domain_id = ${Number(domain_id)}`
        : `AND p.domain_id IS NULL`;

      const existing = await exec(
        conn,
        `SELECT pipeline_id FROM STAND_DB.STAND_INTERNAL.PIPELINES
         WHERE table_fqn = ? AND column_name = ? ${domainFilter}
         LIMIT 1`,
        [table_fqn, column_name],
      );

      if (existing.length > 0) {
        const pid = Number((existing[0] as any).PIPELINE_ID ?? (existing[0] as any).pipeline_id);
        const setClauses = [`status = ?`, `mode = ?`, `updated_at = CURRENT_TIMESTAMP()`];
        const binds: any[] = [status, mode];
        if (name)             { setClauses.push('name = ?');             binds.push(name); }
        if (export_table_fqn) { setClauses.push('export_table_fqn = ?'); binds.push(export_table_fqn); }
        binds.push(pid);
        await exec(conn, `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES SET ${setClauses.join(', ')} WHERE pipeline_id = ?`, binds);
      } else {
        const cols   = ['table_fqn', 'column_name', 'name', 'status', 'mode'];
        const vals   = [table_fqn, column_name, name, status, mode];
        if (domain_id != null)  { cols.push('domain_id');        vals.push(String(domain_id)); }
        if (export_table_fqn)   { cols.push('export_table_fqn'); vals.push(export_table_fqn); }

        const placeholders = vals.map((v, i) => {
          // domain_id is already inlined as a number literal; others use ?
          if (cols[i] === 'domain_id') return String(Number(domain_id));
          return '?';
        });
        const bindVals = vals.filter((_, i) => cols[i] !== 'domain_id');

        await exec(
          conn,
          `INSERT INTO STAND_DB.STAND_INTERNAL.PIPELINES (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
          bindVals,
        );
      }

      const rows = await exec(
        conn,
        `${PIPELINE_SELECT}
         WHERE p.table_fqn = ? AND p.column_name = ? ${pDomainFilter}
         LIMIT 1`,
        [table_fqn, column_name],
      );

      if (!rows.length) {
        return Response.json({ error: 'Pipeline was saved but could not be retrieved.' }, { status: 500 });
      }

      const pipeline = row2pipeline(rows[0]);

      // If the pipeline was created as active and has an export table, build it.
      if (status === 'active' && pipeline.export_table_fqn) {
        refreshExportTable(
          pipeline.table_fqn,
          pipeline.column_name,
          pipeline.export_table_fqn,
          pipeline.domain_id,
          pipeline.pipeline_id,
        ).catch(err => {
          console.error(`[ExportTable] Background refresh failed for pipeline ${pipeline.pipeline_id}:`, err);
        });
      }

      return Response.json({ pipeline }, { status: 201 });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to save pipeline');
  }
}
