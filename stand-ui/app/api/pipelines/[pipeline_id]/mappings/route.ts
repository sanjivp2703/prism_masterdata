/* eslint-disable @typescript-eslint/no-explicit-any --
   binds/rows are untyped driver values by nature (see ../../../_lib/warehouse/types.ts). */
/**
 * GET /api/pipelines/[pipeline_id]/mappings
 * Returns all confirmed mappings for the pipeline's column spec.
 * Joins LITERAL_ALIAS_MATCHES ← APPROVED_ALIAS_NAMES.
 * Supports ?search=... and ?limit=... query params.
 */

import { withWarehouse, warehouseErrorResponse, executeQuery as exec, getWarehouseAdapter } from '@/app/api/_lib/warehouse';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getDb } from '@/app/api/_lib/sqlite';
import { normalizeLiteral } from '@/app/api/_lib/normalize';
import { quoteIdent as msQuoteIdent, parseFqn as msParseFqn } from '@/app/api/_lib/warehouse/mssql/dialect';
import { upsertApprovedAlias } from '@/app/api/_lib/op-export';
import { refreshExportTable } from '@/app/api/_lib/export-table';
import { asExportKind } from '@/app/api/_lib/export-kind';

function quoteIdent(ident: string): string {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

// Same ceiling used elsewhere in the codebase for a "reasonable page" of
// lookup rows (EXPORT_MERGE_BATCH / RECONCILE_QUEUE_BATCH) — bounds the mssql
// path's in-memory fetch+filter below without needing SQL-side normalization.
const MSSQL_CANDIDATE_CAP = 5_000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ pipeline_id: string }> },
) {
  const authz = await requireValidSession();
  if (authz instanceof Response) return authz;
  const { pipeline_id } = await params;
  const pid = Number(pipeline_id);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Response.json({ error: 'Invalid pipeline_id' }, { status: 400 });
  }

  const url    = new URL(request.url);
  const search = url.searchParams.get('search')?.trim() ?? '';
  const limit  = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '200')));

  try {
    return await withWarehouse(async (conn) => {
      // Fetch pipeline to get domain_id, table, column
      const pRowDb = getDb()
        .prepare(`SELECT domain_id, table_fqn, column_name FROM pipelines WHERE pipeline_id = ?`)
        .get(pid) as any;
      const pRows = pRowDb ? [pRowDb] : [];
      if (!pRows.length) return Response.json({ error: 'Pipeline not found' }, { status: 404 });

      const domain_id: number | null = (pRows[0] as any).DOMAIN_ID ?? (pRows[0] as any).domain_id ?? null;
      const table_fqn   = String((pRows[0] as any).TABLE_FQN   ?? (pRows[0] as any).table_fqn   ?? '');
      const column_name = String((pRows[0] as any).COLUMN_NAME ?? (pRows[0] as any).column_name ?? '');
      const domainFilter = domain_id != null
        ? `AND lam.domain_id = ${Number(domain_id)}`
        : `AND lam.domain_id IS NULL`;

      const parts = table_fqn.split('.').map(s => s.trim()).filter(Boolean);

      // SQL Server has no PRISM_NORMALIZE function and no `||` concatenation
      // operator, so the Snowflake subquery below doesn't translate directly.
      // Normalize app-side instead (same pattern as the mssql detection
      // engine's filterUnknownValues) and scope/search/sort/paginate in
      // memory — bounded by MSSQL_CANDIDATE_CAP, a reasonable ceiling for a
      // manually-opened UI tab rather than a hot path.
      if (getWarehouseAdapter().kind === 'mssql') {
        const domainRows = await exec(
          conn,
          `SELECT TOP (${MSSQL_CANDIDATE_CAP}) lam.match_id, lam.alias_id, lam.literal_value, aan.alias_name, lam.run_id, lam.confirmed_at
           FROM PRISM_DB.INTERNAL.LITERAL_ALIAS_MATCHES lam
           JOIN PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES aan ON aan.alias_id = lam.alias_id
           WHERE 1=1 ${domainFilter}
           ORDER BY lam.confirmed_at DESC`,
        );

        let scoped = domainRows;
        if (parts.length === 3 && column_name) {
          const { db, schema, table } = msParseFqn(table_fqn);
          const tableRef = `${msQuoteIdent(db)}.${msQuoteIdent(schema)}.${msQuoteIdent(table)}`;
          const colRef   = msQuoteIdent(column_name);
          const srcRows  = await exec(conn, `SELECT DISTINCT ${colRef} AS v FROM ${tableRef} WHERE ${colRef} IS NOT NULL`);
          const normSet  = new Set(
            srcRows.map((r: any) => normalizeLiteral(String(r.v ?? r.V ?? ''))).filter(Boolean),
          );
          scoped = domainRows.filter((r: any) =>
            normSet.has(normalizeLiteral(String(r.literal_value ?? r.LITERAL_VALUE ?? ''))),
          );
        }

        const needle = search.toLowerCase();
        const filtered = needle
          ? scoped.filter((r: any) => {
              const lit   = String(r.literal_value ?? r.LITERAL_VALUE ?? '').toLowerCase();
              const alias = String(r.alias_name    ?? r.ALIAS_NAME    ?? '').toLowerCase();
              return lit.includes(needle) || alias.includes(needle);
            })
          : scoped;

        const mappings = filtered.slice(0, limit).map((r: any) => ({
          match_id:      Number(r.match_id      ?? r.MATCH_ID      ?? 0),
          alias_id:      Number(r.alias_id       ?? r.ALIAS_ID      ?? 0),
          literal_value: String(r.literal_value ?? r.LITERAL_VALUE ?? ''),
          alias_name:    String(r.alias_name    ?? r.ALIAS_NAME    ?? ''),
          run_id:        Number(r.run_id        ?? r.RUN_ID        ?? 0),
          confirmed_at:  r.confirmed_at ?? r.CONFIRMED_AT ?? null,
        }));

        return Response.json({ mappings, total: filtered.length });
      }

      // Scope to THIS table/column: only mappings whose (normalized) value actually
      // appears in the pipeline's source column — not every mapping in the spec scope.
      let colScopeFilter = '';
      if (parts.length === 3 && column_name) {
        const tableRef = parts.map(quoteIdent).join('.');
        const colRef   = quoteIdent(column_name);
        colScopeFilter = `AND lam.normalized_value IN (
          SELECT PRISM_DB.INTERNAL.PRISM_NORMALIZE(TO_VARCHAR(${colRef}))
          FROM ${tableRef}
          WHERE ${colRef} IS NOT NULL
        )`;
      }

      const searchFilter = search
        ? `AND (LOWER(lam.literal_value) LIKE LOWER('%' || ? || '%') OR LOWER(aan.alias_name) LIKE LOWER('%' || ? || '%'))`
        : '';
      const searchBinds = search ? [search, search] : [];

      const rows = await exec(
        conn,
        `SELECT
           lam.match_id,
           lam.alias_id,
           lam.literal_value,
           aan.alias_name,
           lam.run_id,
           lam.confirmed_at
         FROM PRISM_DB.INTERNAL.LITERAL_ALIAS_MATCHES lam
         JOIN PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES  aan
           ON aan.alias_id = lam.alias_id
         WHERE 1=1
           ${domainFilter}
           ${colScopeFilter}
           ${searchFilter}
         ORDER BY lam.confirmed_at DESC
         LIMIT ${limit}`,
        searchBinds,
      );

      const mappings = rows.map(r => ({
        match_id:      Number((r as any).MATCH_ID      ?? (r as any).match_id      ?? 0),
        alias_id:      Number((r as any).ALIAS_ID      ?? (r as any).alias_id      ?? 0),
        literal_value: String((r as any).LITERAL_VALUE ?? (r as any).literal_value ?? ''),
        alias_name:    String((r as any).ALIAS_NAME    ?? (r as any).alias_name    ?? ''),
        run_id:        Number((r as any).RUN_ID        ?? (r as any).run_id        ?? 0),
        confirmed_at:  (r as any).CONFIRMED_AT ?? (r as any).confirmed_at ?? null,
      }));

      // Total count for this table/column (regardless of search)
      const countRows = await exec(
        conn,
        `SELECT COUNT(*) AS cnt
         FROM PRISM_DB.INTERNAL.LITERAL_ALIAS_MATCHES lam
         WHERE 1=1 ${domainFilter} ${colScopeFilter}`,
      );
      const total = Number((countRows[0] as any).CNT ?? (countRows[0] as any).cnt ?? 0);

      return Response.json({ mappings, total });
    });
  } catch (err) {
    return warehouseErrorResponse(err, 'Failed to fetch mappings');
  }
}

/**
 * PATCH /api/pipelines/[pipeline_id]/mappings
 * Body: { match_id: number, new_alias_name: string, scope: 'this_value' | 'all_shared' }
 *
 * 'this_value'  — re-point ONLY this one literal to the target alias (existing
 *                 or newly created). Other literals sharing the old alias are
 *                 untouched. The old alias's usage_count is decremented, and
 *                 the old alias row is deleted if it's left with zero matches.
 * 'all_shared'  — rename the CURRENT alias itself (affects every literal that
 *                 shares it) — unless the target name already exists as a
 *                 DIFFERENT alias in this spec scope, in which case every match on
 *                 the old alias is moved onto the existing target alias (a
 *                 merge) and the now-orphaned old alias row is deleted.
 *
 * Immediately rebuilds the pipeline's export (table/view/column) if it has
 * one, so the standardized output reflects the edit right away rather than
 * waiting for the next tick — same as every other manual edit path.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ pipeline_id: string }> },
) {
  const authz = await requireValidSession();
  if (authz instanceof Response) return authz;
  const { pipeline_id } = await params;
  const pid = Number(pipeline_id);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Response.json({ error: 'Invalid pipeline_id' }, { status: 400 });
  }

  let body: any;
  try { body = await request.json(); } catch { body = {}; }
  const match_id = Number(body?.match_id);
  const scope: 'this_value' | 'all_shared' = body?.scope === 'all_shared' ? 'all_shared' : 'this_value';
  const newAliasName = typeof body?.new_alias_name === 'string' ? body.new_alias_name.trim() : '';

  if (!Number.isFinite(match_id) || match_id <= 0) {
    return Response.json({ error: 'match_id is required' }, { status: 400 });
  }
  if (!newAliasName) {
    return Response.json({ error: 'A canonical name is required' }, { status: 400 });
  }
  if (/[\r\n]/.test(newAliasName)) {
    return Response.json({ error: 'Canonical name cannot contain line breaks' }, { status: 400 });
  }
  if (newAliasName.length > 200) {
    return Response.json({ error: 'Canonical name must be 200 characters or fewer' }, { status: 400 });
  }

  try {
    return await withWarehouse(async (conn) => {
      const isMssql = getWarehouseAdapter().kind === 'mssql';
      const nowExpr = isMssql ? 'SYSUTCDATETIME()' : 'CURRENT_TIMESTAMP()';

      const pRow = getDb()
        .prepare(`SELECT domain_id, table_fqn, column_name, export_table_fqn, export_kind FROM pipelines WHERE pipeline_id = ?`)
        .get(pid) as any;
      if (!pRow) return Response.json({ error: 'Pipeline not found' }, { status: 404 });

      const domain_id: number | null = pRow.domain_id != null ? Number(pRow.domain_id) : null;
      const table_fqn        = String(pRow.table_fqn ?? '');
      const column_name      = String(pRow.column_name ?? '');
      const export_table_fqn = pRow.export_table_fqn ?? null;
      const export_kind      = asExportKind(pRow.export_kind);
      const domainFilter = domain_id != null ? `domain_id = ${Number(domain_id)}` : `domain_id IS NULL`;

      // Confirm the match belongs to THIS pipeline's scope — never let one
      // pipeline's edit touch another spec's mapping via a guessed match_id.
      const matchRows = await exec(
        conn,
        `SELECT match_id, alias_id FROM PRISM_DB.INTERNAL.LITERAL_ALIAS_MATCHES WHERE match_id = ? AND ${domainFilter}`,
        [match_id],
      );
      const matchRow = matchRows[0] as any;
      if (!matchRow) return Response.json({ error: 'Mapping not found' }, { status: 404 });
      const currentAliasId = Number(matchRow.alias_id ?? matchRow.ALIAS_ID);

      if (scope === 'this_value') {
        const targetAliasId = await upsertApprovedAlias(conn, newAliasName, domain_id);
        if (targetAliasId !== currentAliasId) {
          await exec(
            conn,
            `UPDATE PRISM_DB.INTERNAL.LITERAL_ALIAS_MATCHES SET alias_id = ?, confirmed_at = ${nowExpr} WHERE match_id = ?`,
            [targetAliasId, match_id],
          );
          await exec(
            conn,
            `UPDATE PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES SET usage_count = CASE WHEN usage_count > 0 THEN usage_count - 1 ELSE 0 END WHERE alias_id = ?`,
            [currentAliasId],
          );
          const remaining = await exec(
            conn,
            `SELECT COUNT(*) AS cnt FROM PRISM_DB.INTERNAL.LITERAL_ALIAS_MATCHES WHERE alias_id = ?`,
            [currentAliasId],
          );
          const remainingCount = Number((remaining[0] as any)?.cnt ?? (remaining[0] as any)?.CNT ?? 0);
          if (remainingCount === 0) {
            await exec(conn, `DELETE FROM PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES WHERE alias_id = ?`, [currentAliasId]);
          }
        }
      } else {
        // 'all_shared' — rename the current alias, or merge into an existing
        // one if the target name already belongs to a different alias.
        const existing = await exec(
          conn,
          `SELECT alias_id FROM PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES WHERE alias_name = ? AND ${domainFilter}`,
          [newAliasName],
        );
        const existingAliasId = existing[0] ? Number((existing[0] as any).alias_id ?? (existing[0] as any).ALIAS_ID) : null;

        if (existingAliasId == null || existingAliasId === currentAliasId) {
          await exec(
            conn,
            `UPDATE PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES SET alias_name = ?, last_used_at = ${nowExpr} WHERE alias_id = ?`,
            [newAliasName, currentAliasId],
          );
        } else {
          await exec(
            conn,
            `UPDATE PRISM_DB.INTERNAL.LITERAL_ALIAS_MATCHES SET alias_id = ?, confirmed_at = ${nowExpr} WHERE alias_id = ?`,
            [existingAliasId, currentAliasId],
          );
          await exec(conn, `DELETE FROM PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES WHERE alias_id = ?`, [currentAliasId]);
          await exec(
            conn,
            `UPDATE PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES SET last_used_at = ${nowExpr} WHERE alias_id = ?`,
            [existingAliasId],
          );
        }
      }

      // Reflect the edit in the standardized output right away, same as every
      // other manual-edit path — never leave the Mappings tab and the actual
      // export silently disagreeing until the next tick.
      if (export_table_fqn) {
        await refreshExportTable(table_fqn, column_name, export_table_fqn, domain_id, pid, export_kind);
      }

      return Response.json({ ok: true, rebuilt: Boolean(export_table_fqn) });
    });
  } catch (err) {
    return warehouseErrorResponse(err, 'Failed to update mapping');
  }
}
