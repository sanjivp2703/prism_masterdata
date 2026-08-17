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
import { isNativeEdition } from '@/app/api/_lib/edition';
import { reportError } from '@/app/api/_lib/report-error';

/** Native edition: the app's own database name IS the application name the
 *  consumer chose — the grantee for consumer-side access grants. */
async function currentAppName(conn: unknown): Promise<string> {
  try {
    const r = await exec(conn as any, 'SELECT CURRENT_DATABASE() AS D');
    return String(r?.[0]?.D ?? (r?.[0] as any)?.d ?? 'PRISM');
  } catch { return 'PRISM'; }
}
import { isMssqlAccessError, getServiceLoginName } from '@/app/api/_lib/warehouse/mssql/connection';
import { quoteIdent as msQuoteIdent } from '@/app/api/_lib/warehouse/mssql/dialect';
import { isPgAccessError, getServiceRoleName } from '@/app/api/_lib/warehouse/postgres/connection';
import { quoteIdent as pgQuoteIdent, parseFqn as pgParseFqn } from '@/app/api/_lib/warehouse/postgres/dialect';
import { pgTableRef } from '@/app/api/_lib/warehouse/postgres/detection';
import { isMysqlAccessError, getServiceAccountName } from '@/app/api/_lib/warehouse/mysql/connection';
import { quoteIdent as myQuoteIdent } from '@/app/api/_lib/warehouse/mysql/dialect';
import { myTableRef } from '@/app/api/_lib/warehouse/mysql/detection';
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
  loadOneTimeFileBlob,
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
  // Native: who may read the exported table (owner request 2026-08-17).
  // 'PUBLIC' (default) | 'NONE' (no grant) | a role name. Validated for
  // identifier safety in the export function; anything unusable degrades to
  // no grant plus the access_note.
  const read_role = typeof body?.read_role === 'string' ? body.read_role.trim() : undefined;
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
  if (getWarehouseAdapter().kind === 'postgres') {
    // Postgres destinations may be 2-part (schema.table); pgTableRef rejects
    // cross-database references and unquotable names. Users can never write
    // into Prism's own schema — same rule as the lookup export's
    // refuse-internal-targets check.
    try {
      const parsed = pgTableRef(target_fqn);
      if (parsed.schema.toLowerCase() === 'prism_internal') {
        return Response.json({ error: 'Destination cannot be inside prism_internal — that schema belongs to Prism.' }, { status: 400 });
      }
    } catch (e) {
      return Response.json({ error: String((e as Error)?.message ?? `Invalid destination: ${target_fqn}`) }, { status: 400 });
    }
  } else if (getWarehouseAdapter().kind === 'mysql') {
    // MySQL destinations ARE 2-part (database.table); myTableRef rejects
    // 3-part shapes and unquotable names. Same refuse-internal-targets rule.
    try {
      const parsed = myTableRef(target_fqn);
      if (parsed.db.toLowerCase() === 'prism_internal') {
        return Response.json({ error: 'Destination cannot be inside prism_internal — that database belongs to Prism.' }, { status: 400 });
      }
    } catch (e) {
      return Response.json({ error: String((e as Error)?.message ?? `Invalid destination: ${target_fqn}`) }, { status: 400 });
    }
  } else {
    try {
      const { db, schema, table } = parseFqn(target_fqn);
      if (![db, schema, table].every(isSimpleIdent)) {
        return Response.json({ error: 'Destination table name contains unsupported characters.' }, { status: 400 });
      }
    } catch {
      return Response.json({ error: `Invalid destination. Expected DB.SCHEMA.TABLE, got: ${target_fqn}` }, { status: 400 });
    }
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
      // send the export down the wrong path. A connection='user' session is
      // by construction a warehouse-table one (only the table-probe path sets
      // it), so skip the check there — the user/caller connection cannot read
      // the app-internal ONE_TIME_FILE_ROWS anyway (live-found 2026-08-13,
      // native caller's-rights round). Still meta-derived, never client input.
      const isFileSession = !useUserConnection
        && (await countOneTimeFileRows(conn, sessionNonce)) > 0;

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
          // ── Edit-in-place: hand back the ORIGINAL file with only the
          // standardized cells changed (hidden columns/styles/order intact —
          // what a Dynamics/SAP reimport wizard needs). Falls back to the
          // regenerated {headers, rows} path on any mismatch or failure —
          // never a corrupted "original". See _lib/file-inplace.ts.
          try {
            const blob = await loadOneTimeFileBlob(conn, sessionNonce);
            const kindMatches =
              blob != null &&
              ((format === 'csv' && blob.file_kind === 'csv') ||
               (format === 'excel' && blob.file_kind === 'xlsx'));
            if (blob && kindMatches) {
              const { patchCsvInPlace, patchXlsxInPlace, extractCsvGrid, extractXlsxGrid } = await import('@/app/api/_lib/file-inplace');
              const { gridToRows: shapeRows, gridDataRowIndices } = await import('@/app/api/_lib/table-shape');
              const { normalizeLiteral } = await import('@/app/api/_lib/normalize');
              const bytes = Buffer.from(blob.dataB64, 'base64');

              // Build edits from the ORIGINAL file's own grid (one addressing
              // source of truth — never the stored rows).
              const originalGrid = blob.file_kind === 'csv'
                ? extractCsvGrid(bytes.toString('utf8'))
                : extractXlsxGrid(new Uint8Array(bytes), blob.sheet_name);
              const shaped = shapeRows(originalGrid, blob.header_row);
              const dataCount = gridDataRowIndices(originalGrid, blob.header_row).length;
              const lookup: Record<string, Record<string, string>> = Object.create(null);
              for (const [col, maps] of Object.entries(mappingsByCol)) {
                const m: Record<string, string> = Object.create(null);
                for (const { raw, standardized } of maps) m[normalizeLiteral(raw)] = standardized;
                lookup[col] = m;
              }
              const edits: { dataRow: number; column: string; value: string }[] = [];
              for (let i = 0; i < shaped.rows.length; i++) {
                for (const col of Object.keys(lookup)) {
                  const raw = String(shaped.rows[i][col] ?? '');
                  if (!raw) continue;
                  const std = lookup[col][normalizeLiteral(raw)];
                  if (std != null && std !== raw) edits.push({ dataRow: i, column: col, value: std });
                }
              }

              const patched = blob.file_kind === 'csv'
                ? Buffer.from(patchCsvInPlace(bytes.toString('utf8'), blob.header_row, edits), 'utf8')
                : Buffer.from(patchXlsxInPlace(new Uint8Array(bytes), blob.sheet_name, blob.header_row, edits));

              const dot = blob.file_name.lastIndexOf('.');
              const outName = dot > 0
                ? `${blob.file_name.slice(0, dot)} (standardized)${blob.file_name.slice(dot)}`
                : `${blob.file_name} (standardized)`;
              await finishOneTimeSession({
                target: format === 'csv' ? 'Downloaded .csv' : 'Downloaded .xlsx',
                runRows,
              });
              return Response.json({
                file_b64: patched.toString('base64'),
                file_name: outName,
                format,
                rows_written: dataCount,
                cells_changed: edits.length,
                in_place: true,
              });
            }
          } catch (patchErr) {
            console.warn('[one-time] in-place patch failed — falling back to regenerated file:', (patchErr as any)?.message ?? patchErr);
          }
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
          usedUserConnection: useUserConnection,
          readRole: read_role,
        });
      } catch (exportErr: any) {
        // Full detail server-side ALWAYS — the install test lost hours to this
        // branch classifying and responding without logging the underlying error.
        reportError(exportErr, { where: 'one-time export', target_fqn, mode });
        // Create-mode name collision — including a table Prism cannot even
        // SEE (created by another role/edition; Snowflake says "already
        // exists, but current role has no privileges on it"). This is not a
        // missing-grant problem, and showing the grants panel for it sent the
        // install test down a rabbit hole. Say what actually happened.
        const rawMsg = String(exportErr?.message ?? '');
        if (mode === 'create' && rawMsg.toLowerCase().includes('already exists')) {
          const invisible = rawMsg.toLowerCase().includes('no privileges');
          return Response.json(
            {
              error: `A table named ${target_fqn} already exists${invisible
                ? ' (created outside Prism, so Prism cannot see or replace it)'
                : ''}. Choose a different name, or drop the existing table and retry.`,
            },
            { status: 409 },
          );
        }
        const isMssql = getWarehouseAdapter().kind === 'mssql';
        const isPg = getWarehouseAdapter().kind === 'postgres';
        const isMy = getWarehouseAdapter().kind === 'mysql';
        const msg = String(exportErr?.message ?? '').toLowerCase();
        // Classify per WAREHOUSE. The substring list below is Snowflake's
        // vocabulary; SQL Server says "CREATE TABLE permission denied in
        // database …" and matches NONE of it, so on mssql a genuine permission
        // failure fell through to a generic error and the user never reached
        // the needs_grants / grants_sql / retry flow that exists for exactly
        // this case. Reuse the adapter's own classifier there rather than
        // bolting T-SQL phrases onto a Snowflake list. See KI-209. Postgres
        // gets the same treatment (SQLSTATE-based classifier).
        //
        // This route is where permission errors are MOST expected: the one-time
        // flow deliberately falls back to the creator's personal credentials
        // against tables the service role cannot see.
        const isPermission = isMssql
          ? isMssqlAccessError(exportErr)
          : isPg
          ? isPgAccessError(exportErr)
          : isMy
          ? isMysqlAccessError(exportErr)
          : (
            msg.includes('insufficient privileges') || msg.includes('insufficient privilege') ||
            msg.includes('not authorized') || msg.includes('does not exist or not authorized') ||
            msg.includes('access control error') || msg.includes('sql access control') ||
            msg.includes('object does not exist') || msg.includes('no privilege')
          );
        if (isPermission && useUserConnection) {
          // Personal-connection run: the fix is the USER's own warehouse
          // access, not Prism grants.
          const schemaLabel = isPg
            ? (() => { const p = pgParseFqn(target_fqn); return `${p.db != null ? `${p.db}.` : ''}${p.schema}`; })()
            : isMy
            ? myTableRef(target_fqn).db
            : (() => { const { db, schema } = parseFqn(target_fqn); return `${db}.${schema}`; })();
          const warehouseName = isMssql ? 'SQL Server login' : isPg ? 'Postgres role' : isMy ? 'MySQL account' : 'Snowflake user';
          return Response.json({
            error: mode === 'overwrite'
              ? `Your ${warehouseName} doesn't have write access to ${target_fqn}. Overwriting requires ownership of the table (or SELECT, INSERT, and DELETE on it).`
              : `Your ${warehouseName} can't create tables in ${schemaLabel}. Ask your administrator for CREATE on that schema, or pick a schema you can write to.`,
          }, { status: 403 });
        }
        if (isPermission && isPg) {
          // Postgres remediation. The Snowflake block below emits
          // `GRANT … TO ROLE PRISM_SERVICE` with a USAGE-on-DATABASE line —
          // neither is valid Postgres. Grant to the CONFIGURED service role
          // (see getServiceRoleName — never a hardcoded name).
          const p = pgParseFqn(target_fqn);
          const grantee = pgQuoteIdent(getServiceRoleName());
          const schemaRef = pgQuoteIdent(p.schema);
          const tableRef = `${schemaRef}.${pgQuoteIdent(p.table)}`;
          const lines = [
            `-- Run against the database as a superuser (or the schema owner)`,
            `GRANT USAGE, CREATE ON SCHEMA ${schemaRef} TO ${grantee};`,
          ];
          if (mode === 'overwrite') {
            lines.push(
              ``,
              `-- Target table already exists — Prism also needs to replace its contents:`,
              `GRANT SELECT, INSERT, DELETE ON ${tableRef} TO ${grantee};`,
            );
          }
          return Response.json(
            { error: 'Prism needs write access to this location.', needs_grants: true, grants_sql: lines.join('\n'), grants_run_as: 'a Postgres superuser (or the owner of that schema)' },
            { status: 403 },
          );
        }
        if (isPermission && isMy) {
          // MySQL remediation. Grants address 'user'@'host' ACCOUNTS (not
          // roles), and the grantee is the CONFIGURED service account (see
          // getServiceAccountName — never a hardcoded name). Database-wide
          // grants are the norm on MySQL; the stage table lives in
          // prism_internal (already granted), so only the target database
          // needs new privileges.
          const t = myTableRef(target_fqn);
          const grantee = `'${getServiceAccountName().replace(/'/g, "''")}'@'%'`;
          const dbRef = myQuoteIdent(t.db);
          const lines = [
            `-- Run against the MySQL server as an administrator`,
            `GRANT CREATE, SELECT, INSERT ON ${dbRef}.* TO ${grantee};`,
          ];
          if (mode === 'overwrite') {
            lines.push(
              ``,
              `-- Target table already exists — Prism also needs to replace its contents:`,
              `GRANT DELETE ON ${dbRef}.* TO ${grantee};`,
            );
          }
          return Response.json(
            { error: 'Prism needs write access to this location.', needs_grants: true, grants_sql: lines.join('\n'), grants_run_as: 'a MySQL administrator (root, or an account with GRANT OPTION)' },
            { status: 403 },
          );
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
          // Native (Marketplace) edition: the app IS the identity — grants go
          // TO APPLICATION <name> (the consumer-chosen app name = the app's
          // own database), never to PRISM_SERVICE (install-test bug: the
          // panel showed standard-edition SQL that does nothing for the app).
          const grantee = isNativeEdition()
            ? `APPLICATION ${qi(await currentAppName(conn))}`
            : 'ROLE PRISM_SERVICE';
          const lines = [
            `-- Run as ACCOUNTADMIN or SYSADMIN in Snowflake`,
            `GRANT USAGE ON DATABASE ${qi(db)} TO ${grantee};`,
            `GRANT USAGE ON SCHEMA ${qi(db)}.${qi(schema)} TO ${grantee};`,
            `GRANT CREATE TABLE ON SCHEMA ${qi(db)}.${qi(schema)} TO ${grantee};`,
          ];
          if (mode === 'overwrite') {
            lines.push(
              ``,
              `-- Target table already exists. Choose one option:`,
              `-- Option A — full replace (handles schema changes):`,
              `GRANT OWNERSHIP ON TABLE ${qi(db)}.${qi(schema)}.${qi(table)} TO ${grantee} COPY CURRENT GRANTS;`,
              `-- Option B — data-only update (table schema must match source):`,
              `GRANT SELECT, INSERT, DELETE ON TABLE ${qi(db)}.${qi(schema)}.${qi(table)} TO ${grantee};`,
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
      return Response.json({
        ok: true, rows_written: result.rows_written, target_fqn, mode,
        // Native + service connection: the created table is OWNED BY THE APP,
        // so the customer's own roles can't SELECT it until an admin grants it
        // (MANAGE GRANTS covers app-owned objects — live-verified 2026-08-16).
        // The client surfaces this line with the success message. Caller-path
        // exports (the native default) don't need it — the table lands owned
        // by the user's role.
        ...(isNativeEdition() && !useUserConnection
          ? {
              access_note:
                `The table was created by the Prism app. If your SQL queries can't see it, have an admin run: ` +
                `GRANT SELECT ON TABLE ${target_fqn} TO ROLE <your role>;`,
            }
          : {}),
      });
    });
  } catch (err) {
    return warehouseErrorResponse(err, 'Failed to export one-time standardization');
  }
}
