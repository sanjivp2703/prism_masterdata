/**
 * POST /api/one-time/export
 *
 * Body: { session, target_fqn, mode: 'create' | 'overwrite' }
 * Verifies every column of the session is accepted, writes a standalone Snowflake
 * table (copy of the source with the chosen columns standardized), records an
 * ONE_TIME_STANDARDIZATIONS archive row, and marks the runs complete.
 *
 * Never touches LITERAL_ALIAS_MATCHES / APPROVED_ALIAS_NAMES.
 */

import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { loadOpRunState } from '@/app/api/_lib/op-auto-group';
import {
  exportOneTimeToSnowflake, mappingsFromState, isSimpleIdent, parseFqn, quoteIdent,
  type OneTimeExportColumn,
} from '@/app/api/_lib/op-one-time';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({ sqlText, binds, complete: (e: any, _s: any, r: any[]) => (e ? reject(e) : resolve(r || [])) });
  });
}

function safeJson(s: unknown): any {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return null; }
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const session = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const sessionNonce = String(body?.session ?? '').trim();
  const target_fqn   = String(body?.target_fqn ?? '').trim();
  const mode: 'create' | 'overwrite' = body?.mode === 'overwrite' ? 'overwrite' : 'create';

  if (!sessionNonce || !isSimpleIdent(sessionNonce)) {
    return Response.json({ error: 'Invalid session.' }, { status: 400 });
  }
  if (!target_fqn) return Response.json({ error: 'A destination table is required.' }, { status: 400 });
  try {
    const { db, schema, table } = parseFqn(target_fqn);
    if (![db, schema, table].every(isSimpleIdent)) {
      return Response.json({ error: 'Destination table name contains unsupported characters.' }, { status: 400 });
    }
  } catch {
    return Response.json({ error: `Invalid destination. Expected DB.SCHEMA.TABLE, got: ${target_fqn}` }, { status: 400 });
  }

  try {
    return await withSnowflake(async (conn) => {
      const runRows = await exec(
        conn,
        `SELECT run_id, source_relation, source_column, stats_snapshot
         FROM STAND_DB.STAND_INTERNAL.RUNS
         WHERE run_type = 'one_time' AND created_by = ?
           AND stats_snapshot:one_time_session::string = ?
         ORDER BY run_id`,
        [Number(session.accountId), sessionNonce],
      );
      if (!runRows.length) return Response.json({ error: 'No columns found for this session.' }, { status: 404 });

      const source_relation = String((runRows[0] as any).SOURCE_RELATION ?? (runRows[0] as any).source_relation ?? '');

      const columns: OneTimeExportColumn[] = [];
      const conventionByCol: Record<string, any> = {};
      const mappingsByCol: Record<string, { raw: string; standardized: string }[]> = {};

      for (const r of runRows) {
        const runId = Number((r as any).RUN_ID ?? (r as any).run_id);
        const colName = String((r as any).SOURCE_COLUMN ?? (r as any).source_column ?? '');
        const meta = safeJson((r as any).STATS_SNAPSHOT ?? (r as any).stats_snapshot) ?? {};
        if (meta.accepted !== true) {
          return Response.json(
            { error: `Column "${colName}" hasn't been accepted yet. Accept every column before exporting.` },
            { status: 409 },
          );
        }
        const state = await loadOpRunState(conn, runId);
        const mappings = mappingsFromState(state);
        columns.push({ column_name: colName, mappings });
        conventionByCol[colName] = meta.convention ?? null;
        mappingsByCol[colName] = mappings;
      }

      let result: { rows_written: number };
      try {
        result = await exportOneTimeToSnowflake(conn, {
          source_relation, target_fqn, mode, columns, nonce: sessionNonce,
        });
      } catch (exportErr: any) {
        const msg = String(exportErr?.message ?? '').toLowerCase();
        const isPermission =
          msg.includes('insufficient privileges') || msg.includes('insufficient privilege') ||
          msg.includes('not authorized') || msg.includes('does not exist or not authorized') ||
          msg.includes('access control error') || msg.includes('sql access control') ||
          msg.includes('object does not exist') || msg.includes('no privilege');
        if (isPermission) {
          const { db, schema, table } = parseFqn(target_fqn);
          const qi = (s: string) => quoteIdent(s);
          const lines = [
            `-- Run as ACCOUNTADMIN or SYSADMIN in Snowflake`,
            `GRANT USAGE ON DATABASE ${qi(db)} TO ROLE STAND_ADMIN;`,
            `GRANT USAGE ON SCHEMA ${qi(db)}.${qi(schema)} TO ROLE STAND_ADMIN;`,
            `GRANT CREATE TABLE ON SCHEMA ${qi(db)}.${qi(schema)} TO ROLE STAND_ADMIN;`,
          ];
          if (mode === 'overwrite') {
            lines.push(
              ``,
              `-- Target table already exists. Choose one option:`,
              `-- Option A — full replace (handles schema changes):`,
              `GRANT OWNERSHIP ON TABLE ${qi(db)}.${qi(schema)}.${qi(table)} TO ROLE STAND_ADMIN COPY CURRENT GRANTS;`,
              `-- Option B — data-only update (table schema must match source):`,
              `GRANT SELECT, INSERT, DELETE ON TABLE ${qi(db)}.${qi(schema)}.${qi(table)} TO ROLE STAND_ADMIN;`,
            );
          }
          return Response.json(
            { error: 'Prism needs write access to this location.', needs_grants: true, grants_sql: lines.join('\n') },
            { status: 403 },
          );
        }
        throw exportErr;
      }

      // Archive row (durable record the One-Time Archive reads).
      await exec(
        conn,
        `INSERT INTO STAND_DB.STAND_INTERNAL.ONE_TIME_STANDARDIZATIONS
           (created_by, session_nonce, source_relation, columns, export_target, export_mode,
            convention, mappings, created_at, exported_at)
         SELECT ${Number(session.accountId)}, ?, ?, PARSE_JSON(?), ?, ?, PARSE_JSON(?), PARSE_JSON(?),
                CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()`,
        [
          sessionNonce,
          source_relation,
          JSON.stringify(columns.map((c) => c.column_name)),
          target_fqn,
          mode,
          JSON.stringify(conventionByCol),
          JSON.stringify(mappingsByCol),
        ],
      );

      // Mark the working runs complete.
      const ids = runRows.map((r) => Number((r as any).RUN_ID ?? (r as any).run_id)).filter(Number.isFinite);
      if (ids.length) {
        await exec(
          conn,
          `UPDATE STAND_DB.STAND_INTERNAL.RUNS
           SET run_status = 'complete', updated_at = CURRENT_TIMESTAMP()
           WHERE run_id IN (${ids.map(() => '?').join(', ')})`,
          ids,
        );
      }

      return Response.json({ ok: true, rows_written: result.rows_written, target_fqn, mode });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to export one-time standardization');
  }
}
