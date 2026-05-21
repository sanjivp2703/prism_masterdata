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
// Returns all ONE_PROMPT_LITERAL_ALIAS_MATCHES grouped by alias_name.

export async function GET() {
  try {
    return await withSnowflake(async (connection) => {
      const rows = await exec(
        connection,
        `SELECT alias_name, literal_value, run_id, confirmed_at
         FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_LITERAL_ALIAS_MATCHES
         ORDER BY alias_name, literal_value`,
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
      // Apply item moves: UPDATE alias_name for specific literal values
      for (const [litVal, newAlias] of Object.entries(item_moves)) {
        await exec(
          connection,
          `UPDATE STAND_DB.STAND_INTERNAL.ONE_PROMPT_LITERAL_ALIAS_MATCHES
           SET alias_name = ?
           WHERE literal_value = ?`,
          [newAlias, litVal],
        );
        // Upsert new alias name into the approved-names catalog
        await exec(
          connection,
          `MERGE INTO STAND_DB.STAND_INTERNAL.ONE_PROMPT_APPROVED_ALIAS_NAMES t
           USING (SELECT ? AS alias_name) s ON t.alias_name = s.alias_name
           WHEN MATCHED THEN UPDATE SET
             usage_count  = t.usage_count + 1,
             last_used_at = CURRENT_TIMESTAMP()
           WHEN NOT MATCHED THEN INSERT (alias_name, usage_count, last_used_at)
             VALUES (s.alias_name, 1, CURRENT_TIMESTAMP())`,
          [newAlias],
        );
      }

      // Delete literals that were moved to the ungrouped (removal) zone
      for (const litVal of deleted_literals) {
        await exec(
          connection,
          `DELETE FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_LITERAL_ALIAS_MATCHES
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
