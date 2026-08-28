import { warehouseErrorResponse, withWarehouse, executeQuery as exec, getWarehouseAdapter } from '@/app/api/_lib/warehouse';
import { upsertApprovedAliasMssql, bulkUpsertLiteralMatchesMssql } from '@/app/api/_lib/warehouse/mssql/mappings';
import { upsertApprovedAliasPg, bulkUpsertLiteralMatchesPg } from '@/app/api/_lib/warehouse/postgres/mappings';
import { upsertApprovedAliasMysql, bulkUpsertLiteralMatchesMysql } from '@/app/api/_lib/warehouse/mysql/mappings';
import { internalTable, prismNormalizeFn } from '@/app/api/_lib/warehouse-tables';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getDb } from '@/app/api/_lib/sqlite';
import { visibleSpecIdsForViewer } from '@/app/api/_lib/native-visibility';

// ── GET /api/global-standardizations ──────────────────────────────────────────
// Returns all LITERAL_ALIAS_MATCHES grouped by alias_name.
// Optionally filters by domain_id query param.

export async function GET(request: Request) {
  const authz = await requireValidSession();
  if (authz instanceof Response) return authz;
  const { searchParams } = new URL(request.url);
  const domainIdParam = searchParams.get('domain_id');
  const domainId = domainIdParam != null && domainIdParam !== '' ? Number(domainIdParam) : null;

  // Native edition: mappings follow their spec's pipelines — a viewer sees a
  // spec's mappings only if they can see one of its pipelines (or the spec
  // has no pipeline). null = standard edition, no scoping.
  const visibleSpecs = await visibleSpecIdsForViewer(authz.accountId);
  if (visibleSpecs && domainId != null && !visibleSpecs.has(domainId)) {
    return Response.json({ standardizations: {}, groups: {} });
  }

  try {
    return await withWarehouse(async (connection) => {
      const rows = await exec(
        connection,
        domainId != null
          ? `SELECT aan.alias_name, lam.literal_value, lam.run_id, lam.confirmed_at
             FROM ${internalTable('LITERAL_ALIAS_MATCHES')}  lam
             JOIN ${internalTable('APPROVED_ALIAS_NAMES')}   aan
               ON lam.alias_id = aan.alias_id
             WHERE lam.domain_id = ?
             ORDER BY aan.alias_name, lam.literal_value`
          : `SELECT aan.alias_name, lam.literal_value, lam.run_id, lam.confirmed_at, lam.domain_id
             FROM ${internalTable('LITERAL_ALIAS_MATCHES')}  lam
             JOIN ${internalTable('APPROVED_ALIAS_NAMES')}   aan
               ON lam.alias_id = aan.alias_id
             ORDER BY aan.alias_name, lam.literal_value`,
        domainId != null ? [domainId] : undefined,
      );

      // Object.create(null), NOT {}: alias names are user-authored (the review
      // UI's rename guard checks only length and newlines), and on a plain
      // object literal `grouped['__proto__']` and `grouped['constructor']`
      // resolve to inherited members that are TRUTHY. The `if (!grouped[name])`
      // guard below therefore skipped creating the group, and the next line's
      // .items.push threw — 500-ing this route for the ENTIRE install, not just
      // the offending spec, which takes out the Mappings tab and the CSV/Excel
      // exports for every column. Live-reproduced with a single alias named
      // `__proto__`. A null-prototype object has nothing to inherit.
      const grouped: Record<
        string,
        { items: Array<{ literal_value: string; run_id: number; confirmed_at: string }> }
      > = Object.create(null);

      for (const r of rows) {
        if (visibleSpecs) {
          const specRaw = r.DOMAIN_ID ?? r.domain_id;
          if (specRaw != null && !visibleSpecs.has(Number(specRaw))) continue;
        }
        const aliasName   = String(r.ALIAS_NAME    ?? r.alias_name    ?? '');
        const litVal      = String(r.LITERAL_VALUE ?? r.literal_value ?? '');
        const runId       = Number(r.RUN_ID        ?? r.run_id        ?? 0);
        const confirmedAt = String(r.CONFIRMED_AT  ?? r.confirmed_at  ?? '');
        if (!aliasName || !litVal) continue;
        if (!grouped[aliasName]) grouped[aliasName] = { items: [] };
        grouped[aliasName].items.push({ literal_value: litVal, run_id: runId, confirmed_at: confirmedAt });
      }

      return Response.json(
        { data: grouped },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    });
  } catch (err) {
    return warehouseErrorResponse(err, 'Failed to fetch global standardizations');
  }
}

// ── POST /api/global-standardizations ─────────────────────────────────────────
// Saves pending changes to the DB without LLM validation.
// Body:
//   item_moves: Record<string, string>          — existing literal → new alias
//   deleted_literals: string[]                  — existing literals to remove
//   new_items: Record<string, string[]>         — alias_name → new literal values to insert
//   domain_id: number | null                    — domain scope for new_items
//   pipeline_ids_to_dequeue: number[]           — remove accepted literals from PIPELINE_QUEUE

export async function POST(request: Request) {
  const authz = await requireValidSession();
  if (authz instanceof Response) return authz;
  try {
    const body = await request.json().catch(() => ({}));
    const {
      item_moves               = {},
      deleted_literals         = [],
      new_items                = {},
      domain_id: rawDomainId,
      pipeline_ids_to_dequeue  = [],
    } = body as {
      item_moves?:               Record<string, string>;
      deleted_literals?:         string[];
      new_items?:                Record<string, string[]>;
      domain_id?:                number | null;
      pipeline_ids_to_dequeue?:  number[];
    };

    const domainId: number | null = (rawDomainId != null && Number.isFinite(Number(rawDomainId)))
      ? Number(rawDomainId) : null;

    return await withWarehouse(async (connection) => {
      // ── Write new items (proposed queue groupings) ───────────────────────
      const domainIdLiteral = domainId != null ? String(Number(domainId)) : 'NULL';
      const domainFilter    = domainId != null
        ? `AND t.domain_id = ${domainIdLiteral}`
        : `AND t.domain_id IS NULL`;

      const isMssql = getWarehouseAdapter().kind === 'mssql';
      const isPg    = getWarehouseAdapter().kind === 'postgres';
      const isMy    = getWarehouseAdapter().kind === 'mysql';

      for (const [aliasName, literals] of Object.entries(new_items)) {
        if (!literals.length) continue;

        if (isMssql) {
          const aliasId = await upsertApprovedAliasMssql(connection, aliasName, domainId);
          await bulkUpsertLiteralMatchesMssql(
            connection,
            literals.map(lv => ({ literalValue: lv, aliasId })),
            domainId, 0,
          );
          continue;
        }
        if (isPg) {
          // App-side normalization path (no SQL-side normalize on Postgres).
          const aliasId = await upsertApprovedAliasPg(connection, aliasName, domainId);
          await bulkUpsertLiteralMatchesPg(
            connection,
            literals.map(lv => ({ literalValue: lv, aliasId })),
            domainId, 0,
          );
          continue;
        }
        if (isMy) {
          // Same app-side path (no SQL-side normalize on MySQL either).
          const aliasId = await upsertApprovedAliasMysql(connection, aliasName, domainId);
          await bulkUpsertLiteralMatchesMysql(
            connection,
            literals.map(lv => ({ literalValue: lv, aliasId })),
            domainId, 0,
          );
          continue;
        }

        // Upsert alias
        await exec(
          connection,
          `MERGE INTO ${internalTable('APPROVED_ALIAS_NAMES')} t
           USING (SELECT ? AS alias_name) s
             ON t.alias_name = s.alias_name ${domainFilter}
           WHEN MATCHED THEN UPDATE SET
             usage_count  = t.usage_count + 1,
             last_used_at = CURRENT_TIMESTAMP()
           WHEN NOT MATCHED THEN INSERT (alias_name, domain_id, usage_count, last_used_at)
             VALUES (s.alias_name, ${domainIdLiteral}, 1, CURRENT_TIMESTAMP())`,
          [aliasName],
        );

        const aliasRows = await exec(
          connection,
          `SELECT alias_id FROM ${internalTable('APPROVED_ALIAS_NAMES')}
           WHERE alias_name = ? ${domainFilter} LIMIT 1`,
          [aliasName],
        );
        if (!aliasRows.length) continue;
        const aliasId = Number((aliasRows[0] as any).ALIAS_ID ?? (aliasRows[0] as any).alias_id);

        // Upsert each literal (dedup by normalized form)
        for (const litVal of literals) {
          await exec(
            connection,
            `MERGE INTO ${internalTable('LITERAL_ALIAS_MATCHES')} t
             USING (SELECT ? AS literal_value) s
               ON t.normalized_value = ${prismNormalizeFn()}(s.literal_value)
                  ${domainFilter}
             WHEN MATCHED THEN UPDATE SET
               alias_id     = ${aliasId},
               confirmed_at = CURRENT_TIMESTAMP()
             WHEN NOT MATCHED THEN INSERT (literal_value, normalized_value, alias_id, domain_id, run_id, confirmed_at)
               VALUES (s.literal_value, ${prismNormalizeFn()}(s.literal_value), ${aliasId}, ${domainIdLiteral}, 0, CURRENT_TIMESTAMP())`,
            [litVal],
          );
        }
      }

      // ── Apply item moves (existing literal → different alias) ────────────
      for (const [litVal, newAlias] of Object.entries(item_moves)) {
        if (isMssql) {
          const aliasId = await upsertApprovedAliasMssql(connection, newAlias, domainId);
          await bulkUpsertLiteralMatchesMssql(connection, [{ literalValue: litVal, aliasId }], domainId, 0);
          continue;
        }
        if (isPg) {
          const aliasId = await upsertApprovedAliasPg(connection, newAlias, domainId);
          await bulkUpsertLiteralMatchesPg(connection, [{ literalValue: litVal, aliasId }], domainId, 0);
          continue;
        }
        if (isMy) {
          const aliasId = await upsertApprovedAliasMysql(connection, newAlias, domainId);
          await bulkUpsertLiteralMatchesMysql(connection, [{ literalValue: litVal, aliasId }], domainId, 0);
          continue;
        }
        await exec(
          connection,
          `MERGE INTO ${internalTable('APPROVED_ALIAS_NAMES')} t
           USING (SELECT ? AS alias_name) s
             ON t.alias_name = s.alias_name AND t.domain_id IS NULL
           WHEN MATCHED THEN UPDATE SET
             usage_count  = t.usage_count + 1,
             last_used_at = CURRENT_TIMESTAMP()
           WHEN NOT MATCHED THEN INSERT (alias_name, domain_id, usage_count, last_used_at)
             VALUES (s.alias_name, NULL, 1, CURRENT_TIMESTAMP())`,
          [newAlias],
        );
        const aliasRows = await exec(
          connection,
          `SELECT alias_id FROM ${internalTable('APPROVED_ALIAS_NAMES')}
           WHERE alias_name = ? AND domain_id IS NULL`,
          [newAlias],
        );
        if (!aliasRows.length) continue;
        const aliasId = Number((aliasRows[0] as any).ALIAS_ID ?? (aliasRows[0] as any).alias_id);
        await exec(
          connection,
          `UPDATE ${internalTable('LITERAL_ALIAS_MATCHES')}
           SET alias_id = ?
           WHERE literal_value = ?`,
          [aliasId, litVal],
        );
      }

      // ── Delete removed literals ──────────────────────────────────────────
      for (const litVal of deleted_literals) {
        await exec(
          connection,
          `DELETE FROM ${internalTable('LITERAL_ALIAS_MATCHES')}
           WHERE literal_value = ?`,
          [litVal],
        );
      }

      // ── Dequeue accepted literals from PIPELINE_QUEUE ────────────────────
      const allNewLiterals = Object.values(new_items).flat();
      if (pipeline_ids_to_dequeue.length > 0 && allNewLiterals.length > 0) {
        const pidPh  = pipeline_ids_to_dequeue.map(() => '?').join(', ');
        const litPh  = allNewLiterals.map(() => '?').join(', ');
        await exec(
          connection,
          `DELETE FROM ${internalTable('PIPELINE_QUEUE')}
           WHERE pipeline_id IN (${pidPh}) AND literal_value IN (${litPh})`,
          [...pipeline_ids_to_dequeue, ...allNewLiterals],
        );
        // Refresh queue_size on each pipeline
        for (const pid of pipeline_ids_to_dequeue) {
          const cntRows = await exec(
            connection,
            `SELECT COUNT(*) AS cnt FROM ${internalTable('PIPELINE_QUEUE')} WHERE pipeline_id = ?`,
            [pid],
          );
          const queueSize = Number((cntRows[0] as any).CNT ?? (cntRows[0] as any).cnt ?? 0);
          getDb()
            .prepare(`UPDATE pipelines SET queue_size = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE pipeline_id = ?`)
            .run(queueSize, pid);
        }
      }

      return Response.json({ success: true });
    });
  } catch (err) {
    return warehouseErrorResponse(err, 'Failed to save global standardizations');
  }
}
