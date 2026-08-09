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
import { withWarehouse, withUserWarehouse, warehouseErrorResponse, executeQuery as exec, getWarehouseAdapter } from '@/app/api/_lib/warehouse';
import { isMssqlAccessError, getServiceLoginName } from '@/app/api/_lib/warehouse/mssql/connection';
import { quoteIdent as msQuoteIdent } from '@/app/api/_lib/warehouse/mssql/dialect';
import { getDb } from '@/app/api/_lib/sqlite';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { loadOpRunState } from '@/app/api/_lib/op-auto-group';
import {
  exportOneTimeToSnowflake, mappingsFromState, isSimpleIdent, parseFqn, quoteIdent,
  loadOneTimeMeta,
  type OneTimeExportColumn,
} from '@/app/api/_lib/op-one-time';
import { google } from 'googleapis';
import {
  readOneTimeFileRows, applyMappingsToRows, writeGridToWarehouseTable,
  countOneTimeFileRows,
} from '@/app/api/_lib/op-one-time-file';

function safeJson(s: unknown): any {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return null; }
}

type ExportFormat = 'warehouse' | 'csv' | 'excel' | 'sheets';

/**
 * Create a Google Sheet holding the standardized grid.
 *
 * Uses the same lazily-granted Sheets cookies as the lookup export — sign-in
 * itself requests identity scopes only, so a user who has never exported to
 * Sheets gets `needsAuth` and the client sends them through consent.
 */
async function exportOneTimeToSheets(
  args: { title: string; headers: string[]; grid: string[][] },
): Promise<{ url: string } | { error: Record<string, unknown>; status: number }> {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
    return { error: { error: 'Google Sheets export is not configured on this server.' }, status: 503 };
  }
  const jar          = await cookies();
  const accessToken  = jar.get('google_access_token')?.value;
  const refreshToken = jar.get('google_refresh_token')?.value;
  const tokenExpiry  = jar.get('google_token_expiry')?.value;
  if (!accessToken && !refreshToken) return { error: { needsAuth: true }, status: 401 };

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI,
  );
  oauth2Client.setCredentials({
    access_token: accessToken, refresh_token: refreshToken,
    expiry_date: tokenExpiry ? parseInt(tokenExpiry, 10) : undefined,
  });
  const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
  // Google caps a SHEET (tab) title at 100 chars but not the SPREADSHEET title
  // — the same deliberate asymmetry as the lookup export (LKP-02).
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: args.title },
      sheets: [{ properties: { title: args.title.slice(0, 100) } }],
    },
  });
  const spreadsheetId = created.data.spreadsheetId!;
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: 'A1', valueInputOption: 'RAW',
    requestBody: { values: [args.headers, ...args.grid] },
  });
  return { url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` };
}

export async function POST(request: Request) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const sessionNonce = String(body?.session ?? '').trim();
  const target_fqn   = String(body?.target_fqn ?? '').trim();
  const mode: 'create' | 'overwrite' = body?.mode === 'overwrite' ? 'overwrite' : 'create';
  // Output format. Only meaningful for FILE/SHEET sessions — a warehouse-source
  // session has always written a warehouse table and still does, so an omitted
  // format keeps the historical behaviour exactly.
  const rawFormat = String(body?.format ?? 'warehouse').trim().toLowerCase();
  const format: ExportFormat =
    rawFormat === 'csv' || rawFormat === 'excel' || rawFormat === 'sheets' ? rawFormat : 'warehouse';

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
    // Runs created against a table PRISM_SERVICE can't see carry
    // connection='user' in their meta — the export must read the source and
    // write the output under the SAME (personal) credentials. Write access is
    // enforced by Snowflake itself at write time; failures surface as the
    // clear permission messages below.
    const firstRun = getDb()
      .prepare(
        `SELECT run_id FROM runs
         WHERE run_type = 'one_time' AND created_by = ?
           AND json_extract(stats_snapshot, '$.one_time_session') = ?
         ORDER BY run_id LIMIT 1`,
      )
      .get(Number(session.accountId), sessionNonce) as any;
    const firstMeta = firstRun ? await loadOneTimeMeta(null, Number(firstRun.run_id)) : null;
    const useUserConnection = firstMeta?.connection === 'user';
    const withChosen = useUserConnection
      ? <T,>(fn: (conn: any) => Promise<T>) => withUserWarehouse(Number(session.accountId), fn)
      : withWarehouse;

    return await withChosen(async (conn) => {
      const runRows = getDb()
        .prepare(
          `SELECT run_id, source_relation, source_column, stats_snapshot
           FROM runs
           WHERE run_type = 'one_time' AND created_by = ?
             AND json_extract(stats_snapshot, '$.one_time_session') = ?
           ORDER BY run_id`,
        )
        .all(Number(session.accountId), sessionNonce) as any[];
      if (!runRows.length) return Response.json({ error: 'No columns found for this session.' }, { status: 404 });

      const source_relation = String((runRows[0] as any).SOURCE_RELATION ?? (runRows[0] as any).source_relation ?? '');

      const columns: OneTimeExportColumn[] = [];
      // Object.create(null) — keyed by the customer's own column names.
      const conventionByCol: Record<string, any> = Object.create(null);
      const mappingsByCol: Record<string, { raw: string; standardized: string }[]> = Object.create(null);

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
        const state = await loadOpRunState(runId);
        const mappings = mappingsFromState(state);
        columns.push({ column_name: colName, mappings });
        conventionByCol[colName] = meta.convention ?? null;
        mappingsByCol[colName] = mappings;
      }

      // Whether this session's source was an uploaded file / Sheet: the rows
      // were stored under the nonce at creation. Derived from the DATA rather
      // than from a request field so a client cannot mislabel a session and
      // send the export down the wrong path.
      const isFileSession = (await countOneTimeFileRows(conn, sessionNonce)) > 0;

      /**
       * Archive the session and mark its runs complete — shared by the
       * warehouse and file paths so the upsert semantics (one archive row per
       * session, re-export updates rather than appends) can only be defined
       * once.
       *
       * DATA RESIDENCY: `mappings` is never written here. It is reconstructed
       * on demand from the warehouse RUN_STATE blobs.
       */
      async function finishOneTimeSession(a: { target: string; runRows: Array<Record<string, unknown>> }): Promise<void> {
        const existing = getDb()
          .prepare(`SELECT ots_id FROM one_time_standardizations
                    WHERE session_nonce = ? AND created_by = ?`)
          .get(sessionNonce, Number(session.accountId)) as { ots_id?: number } | undefined;
        const colNames = JSON.stringify(columns.map((c) => c.column_name));
        if (existing?.ots_id != null) {
          getDb().prepare(
            `UPDATE one_time_standardizations
             SET source_relation = ?, columns = ?, export_target = ?, export_mode = ?,
                 convention = ?, mappings = NULL,
                 exported_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE ots_id = ?`,
          ).run(source_relation, colNames, a.target, mode, JSON.stringify(conventionByCol), existing.ots_id);
        } else {
          getDb().prepare(
            `INSERT INTO one_time_standardizations
               (created_by, session_nonce, source_relation, columns, export_target, export_mode,
                convention, mappings)
             VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
          ).run(Number(session.accountId), sessionNonce, source_relation, colNames,
                a.target, mode, JSON.stringify(conventionByCol));
        }
        const ids = a.runRows.map((r) => Number(r.run_id)).filter(Number.isFinite);
        if (ids.length) {
          getDb().prepare(
            `UPDATE runs SET run_status = 'complete',
                             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE run_id IN (${ids.map(() => '?').join(', ')})`,
          ).run(...ids);
        }
      }

      // ── FILE / SHEET SESSIONS ────────────────────────────────────────────
      // The source is uploaded rows, not a warehouse table, so the output is
      // rebuilt in memory from INTERNAL.ONE_TIME_FILE_ROWS with the
      // standardized columns substituted. Every format shares one grid builder
      // (applyMappingsToRows) so CSV, Excel, Sheets and a warehouse table can
      // never disagree about what a standardized row looks like.
      //
      // 'csv' and 'excel' return DATA rather than a file: the client already
      // builds those blobs for the lookup export (and does it without a
      // round-trip through the server holding the whole file in memory).
      if (isFileSession) {
        const fileRows = await readOneTimeFileRows(conn, sessionNonce);
        if (fileRows.length === 0) {
          return Response.json(
            { error: 'The uploaded rows for this session are no longer available. Start a new one-time standardization.' },
            { status: 409 },
          );
        }
        const headers = Object.keys(fileRows[0] ?? {});
        const grid    = applyMappingsToRows(fileRows, headers, mappingsByCol);

        if (format === 'csv' || format === 'excel') {
          await finishOneTimeSession({
            target: format === 'csv' ? 'Downloaded .csv' : 'Downloaded .xlsx',
            runRows,
          });
          return Response.json({ headers, rows: grid, rows_written: grid.length, format });
        }

        if (format === 'sheets') {
          const out = await exportOneTimeToSheets({
            title: `${source_relation} — Standardized`,
            headers, grid,
          });
          if ('error' in out) return Response.json(out.error, { status: out.status });
          await finishOneTimeSession({ target: out.url, runRows });
          return Response.json({ url: out.url, rows_written: grid.length, format: 'sheets' });
        }

        // Warehouse table from uploaded rows.
        const written = await writeGridToWarehouseTable(conn, {
          targetFqn: target_fqn, mode, headers, grid,
        });
        await finishOneTimeSession({ target: target_fqn, runRows });
        return Response.json({ rows_written: written, target: target_fqn, format: 'warehouse' });
      }

      let result: { rows_written: number };
      try {
        result = await exportOneTimeToSnowflake(conn, {
          source_relation, target_fqn, mode, columns, nonce: sessionNonce,
        });
      } catch (exportErr: any) {
        const isMssql = getWarehouseAdapter().kind === 'mssql';
        const msg = String(exportErr?.message ?? '').toLowerCase();
        // Classify per WAREHOUSE. The substring list below is Snowflake's
        // vocabulary; SQL Server says "CREATE TABLE permission denied in
        // database …" and matches NONE of it, so on mssql a genuine permission
        // failure fell through to a generic error and the user never reached
        // the needs_grants / grants_sql / retry flow that exists for exactly
        // this case. Reuse the adapter's own classifier there rather than
        // bolting T-SQL phrases onto a Snowflake list. See KI-209.
        //
        // This route is where permission errors are MOST expected: the one-time
        // flow deliberately falls back to the creator's personal credentials
        // against tables the service role cannot see.
        const isPermission = isMssql
          ? isMssqlAccessError(exportErr)
          : (
            msg.includes('insufficient privileges') || msg.includes('insufficient privilege') ||
            msg.includes('not authorized') || msg.includes('does not exist or not authorized') ||
            msg.includes('access control error') || msg.includes('sql access control') ||
            msg.includes('object does not exist') || msg.includes('no privilege')
          );
        if (isPermission && useUserConnection) {
          // Personal-connection run: the fix is the USER's own warehouse
          // access, not Prism grants.
          const { db, schema } = parseFqn(target_fqn);
          const warehouseName = isMssql ? 'SQL Server login' : 'Snowflake user';
          return Response.json({
            error: mode === 'overwrite'
              ? `Your ${warehouseName} doesn't have write access to ${target_fqn}. Overwriting requires ownership of the table (or SELECT, INSERT, and DELETE on it).`
              : `Your ${warehouseName} can't create tables in ${db}.${schema}. Ask your administrator for CREATE TABLE on that schema, or pick a schema you can write to.`,
          }, { status: 403 });
        }
        if (isPermission && isMssql) {
          // T-SQL remediation. The Snowflake block below emits
          // `GRANT … TO ROLE PRISM_SERVICE`, which is not valid T-SQL and names
          // a role that only exists inside PRISM_DB — following it verbatim on
          // SQL Server would fix nothing. Grant to the CONFIGURED service login
          // (see getServiceLoginName / KI-61), never a hardcoded name.
          const { db, schema, table } = parseFqn(target_fqn);
          const grantee = msQuoteIdent(getServiceLoginName());
          const lines = [
            `-- Run against the SQL Server as a sysadmin`,
            `USE ${msQuoteIdent(db)};`,
            `GRANT CREATE TABLE TO ${grantee};`,
            `GRANT ALTER ON SCHEMA::${msQuoteIdent(schema)} TO ${grantee};`,
          ];
          if (mode === 'overwrite') {
            lines.push(
              ``,
              `-- Target table already exists — Prism also needs to replace its contents:`,
              `GRANT SELECT, INSERT, DELETE ON OBJECT::${msQuoteIdent(schema)}.${msQuoteIdent(table)} TO ${grantee};`,
            );
          }
          return Response.json(
            { error: 'Prism needs write access to this location.', needs_grants: true, grants_sql: lines.join('\n'), grants_run_as: 'a SQL Server administrator (sysadmin, or the database owner)' },
            { status: 403 },
          );
        }
        if (isPermission) {
          const { db, schema, table } = parseFqn(target_fqn);
          const qi = (s: string) => quoteIdent(s);
          const lines = [
            `-- Run as ACCOUNTADMIN or SYSADMIN in Snowflake`,
            `GRANT USAGE ON DATABASE ${qi(db)} TO ROLE PRISM_SERVICE;`,
            `GRANT USAGE ON SCHEMA ${qi(db)}.${qi(schema)} TO ROLE PRISM_SERVICE;`,
            `GRANT CREATE TABLE ON SCHEMA ${qi(db)}.${qi(schema)} TO ROLE PRISM_SERVICE;`,
          ];
          if (mode === 'overwrite') {
            lines.push(
              ``,
              `-- Target table already exists. Choose one option:`,
              `-- Option A — full replace (handles schema changes):`,
              `GRANT OWNERSHIP ON TABLE ${qi(db)}.${qi(schema)}.${qi(table)} TO ROLE PRISM_SERVICE COPY CURRENT GRANTS;`,
              `-- Option B — data-only update (table schema must match source):`,
              `GRANT SELECT, INSERT, DELETE ON TABLE ${qi(db)}.${qi(schema)}.${qi(table)} TO ROLE PRISM_SERVICE;`,
            );
          }
          return Response.json(
            { error: 'Prism needs write access to this location.', needs_grants: true, grants_sql: lines.join('\n'), grants_run_as: 'ACCOUNTADMIN or SYSADMIN in Snowflake' },
            { status: 403 },
          );
        }
        throw exportErr;
      }

      await finishOneTimeSession({ target: target_fqn, runRows });
      return Response.json({ ok: true, rows_written: result.rows_written, target_fqn, mode });
    });
  } catch (err) {
    return warehouseErrorResponse(err, 'Failed to export one-time standardization');
  }
}
