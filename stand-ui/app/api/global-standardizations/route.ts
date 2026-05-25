import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';

async function exec(connection: any, sqlText: string, binds?: any[]) {
  return new Promise<any[]>((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete: (err: any, _stmt: any, rows: any[]) => {
        if (err) reject(err);
        else resolve(rows || []);
      },
    });
  });
}

// ── GET /api/global-standardizations ──────────────────────────────────────────
// Returns all LITERAL_ALIAS_MATCHES grouped by alias_name.
// Optionally filters by domain_id query param.

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const domainIdParam = searchParams.get('domain_id');
  const domainId = domainIdParam != null && domainIdParam !== '' ? Number(domainIdParam) : null;

  try {
    return await withSnowflake(async (connection) => {
      const rows = await exec(
        connection,
        domainId != null
          ? `SELECT aan.alias_name, lam.literal_value, lam.run_id, lam.confirmed_at
             FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES  lam
             JOIN STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES   aan
               ON lam.alias_id = aan.alias_id
             WHERE lam.domain_id = ?
             ORDER BY aan.alias_name, lam.literal_value`
          : `SELECT aan.alias_name, lam.literal_value, lam.run_id, lam.confirmed_at
             FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES  lam
             JOIN STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES   aan
               ON lam.alias_id = aan.alias_id
             ORDER BY aan.alias_name, lam.literal_value`,
        domainId != null ? [domainId] : undefined,
      );

      const grouped: Record<
        string,
        { items: Array<{ literal_value: string; run_id: number; confirmed_at: string }> }
      > = {};

      for (const r of rows) {
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
    return snowflakeErrorResponse(err, 'Failed to fetch global standardizations');
  }
}

// ── POST /api/global-standardizations ─────────────────────────────────────────
// Saves pending changes (item moves + deletions) to the DB without LLM validation.
// Body: { item_moves: Record<string, string>, deleted_literals: string[] }

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const {
      item_moves = {},
      deleted_literals = [],
    } = body as {
      item_moves?: Record<string, string>;
      deleted_literals?: string[];
    };

    return await withSnowflake(async (connection) => {
      // Apply item moves: upsert the target alias, get its alias_id, then repoint literal.
      for (const [litVal, newAlias] of Object.entries(item_moves)) {
        await exec(
          connection,
          `MERGE INTO STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES t
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
          `SELECT alias_id FROM STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES
           WHERE alias_name = ? AND domain_id IS NULL`,
          [newAlias],
        );
        if (!aliasRows.length) continue;
        const aliasId = Number((aliasRows[0] as any).ALIAS_ID ?? (aliasRows[0] as any).alias_id);
        await exec(
          connection,
          `UPDATE STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES
           SET alias_id = ?
           WHERE literal_value = ?`,
          [aliasId, litVal],
        );
      }

      // Delete literals that were moved to the ungrouped (removal) zone
      for (const litVal of deleted_literals) {
        await exec(
          connection,
          `DELETE FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES
           WHERE literal_value = ?`,
          [litVal],
        );
      }

      return Response.json({ success: true });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to save global standardizations');
  }
}
