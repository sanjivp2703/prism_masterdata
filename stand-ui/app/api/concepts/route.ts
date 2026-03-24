import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';

export async function GET() {
  try {
    return await withSnowflake(async (connection) => {
      const rows = await new Promise<any[]>((resolve, reject) => {
        connection.execute({
          sqlText: `
            SELECT
              concept_id,
              concept_key,
              description,
              data_type,
              profile_id,
              is_active,
              created_at,
              updated_at
            FROM STAND_DB.STAND_INTERNAL.CONCEPTS
            WHERE is_active = TRUE
            ORDER BY concept_key
          `,
          complete: (err, stmt, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        });
      });

      return Response.json(
        { data: rows },
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
    console.error('Concepts error:', error);
    return snowflakeErrorResponse(error, 'Failed to fetch concepts');
  }
}

export async function POST(request: Request) {
  let body: any = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const concept_key = String(body?.concept_key ?? '').trim();
  const profile_id_raw = body?.profile_id;
  const profile_id =
    profile_id_raw === null || profile_id_raw === undefined || profile_id_raw === ''
      ? 1
      : Number(profile_id_raw);
  const descriptionRaw = body?.description ?? null;
  const description =
    descriptionRaw === null || descriptionRaw === undefined
      ? null
      : String(descriptionRaw).trim();

  if (!concept_key) {
    return Response.json({ error: 'concept_key is required' }, { status: 400 });
  }
  if (!Number.isFinite(profile_id) || !Number.isInteger(profile_id) || profile_id <= 0) {
    return Response.json({ error: 'profile_id must be a positive integer' }, { status: 400 });
  }
  // Keep this conservative for now (matches typical Snowflake identifier-ish keys).
  if (!/^[a-z][a-z0-9_]*$/.test(concept_key)) {
    return Response.json(
      {
        error:
          'concept_key must match /^[a-z][a-z0-9_]*$/ (lowercase letters, numbers, underscores; must start with a letter)',
      },
      { status: 400 }
    );
  }

  try {
    return await withSnowflake(async (connection) => {
      // Insert, relying on the DB UNIQUE(concept_key) constraint for concurrency safety.
      await new Promise<void>((resolve, reject) => {
        connection.execute({
          sqlText: `
            INSERT INTO STAND_DB.STAND_INTERNAL.CONCEPTS (
              concept_key,
              description,
              data_type,
              profile_id,
              is_active,
              created_at,
              updated_at
            )
            VALUES (?, ?, 'string', ?, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `,
          binds: [concept_key, description, profile_id],
          complete: (err) => {
            if (err) reject(err);
            else resolve();
          },
        });
      });

      const rows = await new Promise<any[]>((resolve, reject) => {
        connection.execute({
          sqlText: `
            SELECT concept_id, concept_key, description, data_type, profile_id, is_active, created_at, updated_at
            FROM STAND_DB.STAND_INTERNAL.CONCEPTS
            WHERE concept_key = ?
            LIMIT 1
          `,
          binds: [concept_key],
          complete: (err, stmt, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        });
      });

      return Response.json({ data: rows?.[0] ?? null }, { status: 201 });
    });
  } catch (error: any) {
    // Friendly unique-key message
    const msg = String(error?.message ?? '');
    if (msg.toLowerCase().includes('unique_concept_key') || msg.toLowerCase().includes('unique')) {
      return Response.json(
        { error: `Concept '${concept_key}' already exists` },
        { status: 409 }
      );
    }
    console.error('Create concept error:', error);
    return snowflakeErrorResponse(error, 'Failed to create concept');
  }
}


