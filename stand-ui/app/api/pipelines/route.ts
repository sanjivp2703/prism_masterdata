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

function parseMeta(v: any): Record<string, any> {
  if (typeof v === 'object' && v !== null) return v as Record<string, any>;
  try { return JSON.parse(String(v)); } catch { return {}; }
}

export function row2pipeline(r: any) {
  const rawUnmapped = r.EXPORT_UNMAPPED_ROWS ?? r.export_unmapped_rows;
  return {
    pipeline_id:          Number(r.PIPELINE_ID         ?? r.pipeline_id),
    name:                 r.NAME                ?? r.name                ?? null,
    table_fqn:            String(r.TABLE_FQN           ?? r.table_fqn           ?? ''),
    column_name:          String(r.COLUMN_NAME         ?? r.column_name         ?? ''),
    export_table_fqn:     r.EXPORT_TABLE_FQN    ?? r.export_table_fqn    ?? null,
    domain_id:            r.DOMAIN_ID != null           ? Number(r.DOMAIN_ID    ?? r.domain_id) : null,
    domain_name:          r.DOMAIN_NAME         ?? r.domain_name         ?? null,
    status:               String(r.STATUS              ?? r.status              ?? 'active'),
    status_message:       r.STATUS_MESSAGE      ?? r.status_message      ?? null,
    mode:                 String(r.MODE                ?? r.mode                ?? 'auto'),
    export_unmapped_rows: rawUnmapped !== false && rawUnmapped !== 'false',
    queue_size:           Number(r.QUEUE_SIZE          ?? r.queue_size          ?? 0),
    total_new_values:     Number(r.TOTAL_NEW_VALUES     ?? r.total_new_values    ?? 0),
    last_polled_at:       r.LAST_POLLED_AT      ?? r.last_polled_at      ?? null,
    last_queue_empty_at:  r.LAST_QUEUE_EMPTY_AT ?? r.last_queue_empty_at ?? null,
    created_by:           r.CREATED_BY != null ? Number(r.CREATED_BY ?? r.created_by) : null,
    created_at:           r.CREATED_AT          ?? r.created_at          ?? null,
    updated_at:           r.UPDATED_AT          ?? r.updated_at          ?? null,
    total_mapped:         Number(r.TOTAL_MAPPED         ?? r.total_mapped         ?? 0),
    total_source_values:  Number(r.TOTAL_SOURCE_VALUES  ?? r.total_source_values  ?? 0),
    source_type:          String(r.SOURCE_TYPE         ?? r.source_type          ?? 'snowflake'),
    file_source_meta:     r.FILE_SOURCE_META    ?? r.file_source_meta    ?? null,
    file_export_meta:     r.FILE_EXPORT_META    ?? r.file_export_meta    ?? null,
  };
}

export const PIPELINE_SELECT = `
  SELECT
    p.pipeline_id,
    p.name,
    p.table_fqn,
    p.column_name,
    p.export_table_fqn,
    p.domain_id,
    d.name              AS domain_name,
    p.status,
    p.status_message,
    p.mode,
    p.export_unmapped_rows,
    p.queue_size,
    p.total_new_values,
    p.total_mapped,
    p.total_source_values,
    p.last_polled_at,
    p.last_queue_empty_at,
    p.created_by,
    p.created_at,
    p.updated_at,
    p.source_type,
    p.file_source_meta,
    p.file_export_meta
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
         WHERE p.status != 'initializing'
         ORDER BY
           p.last_polled_at DESC NULLS LAST,
           p.created_at     DESC`,
      );
      const pipelines = rows.map(row2pipeline);

      // Expand multi-column Sheets pipelines into virtual per-column entries.
      // Each virtual entry shares the same pipeline_id but has a distinct
      // column_name / domain_id / domain_name, so PipelinesView can render
      // each column in one card while groupKeyFor maps them all to the same key.
      const extraDomainIds = new Set<number>();
      for (const p of pipelines) {
        if (p.source_type !== 'sheets') continue;
        const meta = parseMeta(p.file_source_meta);
        const cols: { column_name: string; domain_id: number | null }[] =
          Array.isArray(meta?.columns) ? meta.columns : [];
        if (cols.length <= 1) continue;
        for (const c of cols) {
          const did = c.domain_id != null ? Number(c.domain_id) : null;
          if (did != null && did !== p.domain_id) extraDomainIds.add(did);
        }
      }

      const domainNames: Record<number, string> = {};
      if (extraDomainIds.size > 0) {
        const ids = [...extraDomainIds];
        const ph  = ids.map(() => '?').join(',');
        const dRows = await exec(conn, `SELECT domain_id, name FROM STAND_DB.STAND_INTERNAL.DOMAINS WHERE domain_id IN (${ph})`, ids);
        for (const r of dRows) {
          domainNames[Number(r.DOMAIN_ID ?? r.domain_id)] = String(r.NAME ?? r.name ?? '');
        }
      }

      const expanded: ReturnType<typeof row2pipeline>[] = [];
      for (const p of pipelines) {
        if (p.source_type !== 'sheets') { expanded.push(p); continue; }
        const meta = parseMeta(p.file_source_meta);
        const cols: { column_name: string; domain_id: number | null }[] =
          Array.isArray(meta?.columns) && meta.columns.length > 1 ? meta.columns : [];
        if (cols.length === 0) { expanded.push(p); continue; }
        for (const c of cols) {
          const did = c.domain_id != null ? Number(c.domain_id) : null;
          const dname: string | null = did == null ? null
            : (did === p.domain_id ? (p.domain_name ?? null) : (domainNames[did] ?? null));
          // Use per-column metrics from file_source_meta when available (written by
          // refreshSheetsFileRows) to avoid double-counting when buildPipelineGroups
          // sums across virtual entries.
          const colTSV = (c as any).total_source_values != null ? Number((c as any).total_source_values) : undefined;
          const colTM  = (c as any).total_mapped != null ? Number((c as any).total_mapped) : undefined;
          expanded.push({
            ...p,
            column_name: String(c.column_name ?? ''),
            domain_id: did,
            domain_name: dname,
            ...(colTSV != null ? {
              total_source_values: colTSV,
              total_mapped:        colTM ?? 0,
              queue_size:          Math.max(0, colTSV - (colTM ?? 0)),
            } : {}),
          });
        }
      }

      return Response.json({ pipelines: expanded });
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

  const table_fqn           = String(body?.table_fqn        ?? '').trim();
  const column_name         = String(body?.column_name       ?? '').trim();
  const export_table_fqn    = body?.export_table_fqn ? String(body.export_table_fqn).trim() : null;
  const domain_id           = body?.domain_id != null ? Number(body.domain_id) : null;
  const name                = body?.name ? String(body.name).trim() : null;
  const mode                = ['auto', 'manual'].includes(body?.mode) ? String(body.mode) : 'auto';
  const export_unmapped_rows = body?.export_unmapped_rows === false ? false : true;
  const status              = ['active', 'paused', 'pending_baseline'].includes(body?.status)
    ? String(body.status)
    : 'active';

  if (!table_fqn)   return Response.json({ error: 'table_fqn is required' }, { status: 400 });
  if (!column_name) return Response.json({ error: 'column_name is required' }, { status: 400 });
  // Domain is mandatory — every pipeline must be scoped to a domain.
  if (domain_id == null || !Number.isFinite(domain_id)) {
    return Response.json({ error: 'domain_id is required — a pipeline must belong to a domain.' }, { status: 400 });
  }

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
        const setClauses = [`status = ?`, `mode = ?`, `export_unmapped_rows = ?`, `updated_at = CURRENT_TIMESTAMP()`];
        const binds: any[] = [status, mode, export_unmapped_rows];
        if (name)             { setClauses.push('name = ?');             binds.push(name); }
        if (export_table_fqn) { setClauses.push('export_table_fqn = ?'); binds.push(export_table_fqn); }
        binds.push(pid);
        await exec(conn, `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES SET ${setClauses.join(', ')} WHERE pipeline_id = ?`, binds);
      } else {
        const cols   = ['table_fqn', 'column_name', 'name', 'status', 'mode', 'export_unmapped_rows', 'created_by'];
        const vals   = [table_fqn, column_name, name, status, mode, String(export_unmapped_rows), String(session.accountId)];
        if (domain_id != null)  { cols.push('domain_id');        vals.push(String(domain_id)); }
        if (export_table_fqn)   { cols.push('export_table_fqn'); vals.push(export_table_fqn); }

        const placeholders = vals.map((v, i) => {
          // domain_id and created_by are inlined as number literals; others use ?
          if (cols[i] === 'domain_id')  return String(Number(domain_id));
          if (cols[i] === 'created_by') return String(Number(session.accountId));
          return '?';
        });
        const bindVals = vals.filter((_, i) => cols[i] !== 'domain_id' && cols[i] !== 'created_by');

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
