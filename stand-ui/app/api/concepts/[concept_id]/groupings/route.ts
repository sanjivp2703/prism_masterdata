import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ concept_id: string }> }
) {
  const { concept_id } = await params;
  const conceptIdNum = Number.parseInt(String(concept_id), 10);

  if (!Number.isFinite(conceptIdNum)) {
    return Response.json({ error: 'Invalid concept_id' }, { status: 400 });
  }

  try {
    return await withSnowflake(async (connection) => {
      const conceptRows = await new Promise<any[]>((resolve, reject) => {
        connection.execute({
          sqlText: `
            SELECT
              concept_id,
              concept_key,
              description,
              data_type,
              profile_id,
              is_active
            FROM STAND_DB.STAND_INTERNAL.CONCEPTS
            WHERE concept_id = ?
            LIMIT 1
          `,
          binds: [conceptIdNum],
          complete: (err, stmt, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        });
      });

      if (conceptRows.length === 0) {
        return Response.json({ error: 'Concept not found' }, { status: 404 });
      }

      const rows = await new Promise<any[]>((resolve, reject) => {
        connection.execute({
          sqlText: `
            SELECT
              a.alias_id,
              a.alias_name,
              rv.raw_value,
              rv.confidence
            FROM STAND_DB.STAND_INTERNAL.ALIASES a
            LEFT JOIN STAND_DB.STAND_INTERNAL.RAW_VALUES rv
              ON rv.alias_id = a.alias_id
            WHERE a.concept_id = ?
              AND a.status = 'active'
            ORDER BY a.alias_name, rv.raw_value
          `,
          binds: [conceptIdNum],
          complete: (err, stmt, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        });
      });

      const aliasMap: Record<
        string,
        {
          alias_id: number;
          items: Array<{
            raw_value: string;
            confidence: number | null;
          }>;
        }
      > = {};

      for (const r of rows) {
        const aliasName = String(r.ALIAS_NAME ?? r.alias_name ?? '');
        const aliasId = Number(r.ALIAS_ID ?? r.alias_id);
        if (!aliasName || !Number.isFinite(aliasId)) continue;

        if (!aliasMap[aliasName]) {
          aliasMap[aliasName] = { alias_id: aliasId, items: [] };
        }

        const rawValue = r.RAW_VALUE ?? r.raw_value;
        if (rawValue !== null && rawValue !== undefined) {
          aliasMap[aliasName].items.push({
            raw_value: String(rawValue),
            confidence:
              r.CONFIDENCE === null || r.CONFIDENCE === undefined
                ? null
                : Number(r.CONFIDENCE),
          });
        }
      }

      // Also include aliases with zero items (LEFT JOIN still yields 1 row with raw_value NULL,
      // but only if there is at least one row; handle the "no aliases" case explicitly).
      if (rows.length === 0) {
        const aliasRows = await new Promise<any[]>((resolve, reject) => {
          connection.execute({
            sqlText: `
              SELECT alias_id, alias_name
              FROM STAND_DB.STAND_INTERNAL.ALIASES
              WHERE concept_id = ?
                AND status = 'active'
              ORDER BY alias_name
            `,
            binds: [conceptIdNum],
            complete: (err, stmt, rows) => {
              if (err) reject(err);
              else resolve(rows || []);
            },
          });
        });
        for (const a of aliasRows) {
          const aliasName = String(a.ALIAS_NAME ?? a.alias_name ?? '');
          const aliasId = Number(a.ALIAS_ID ?? a.alias_id);
          if (!aliasName || !Number.isFinite(aliasId)) continue;
          if (!aliasMap[aliasName]) aliasMap[aliasName] = { alias_id: aliasId, items: [] };
        }
      }

      return Response.json(
        {
          data: {
            concept: conceptRows[0],
            groupings: aliasMap,
          },
        },
        {
          headers: {
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            Pragma: 'no-cache',
            Expires: '0',
          },
        }
      );
    });
  } catch (error) {
    console.error('Concept groupings error:', error);
    return snowflakeErrorResponse(error, 'Failed to fetch concept groupings');
  }
}


