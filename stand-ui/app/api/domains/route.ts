import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

function row2domain(r: any) {
  return {
    domain_id:    Number(r.DOMAIN_ID   ?? r.domain_id),
    name:         String(r.NAME        ?? r.name        ?? ''),
    usage_count:  Number(r.USAGE_COUNT ?? r.usage_count ?? 0),
    last_used_at: r.LAST_USED_AT ?? r.last_used_at ?? null,
    created_at:   r.CREATED_AT  ?? r.created_at  ?? null,
  };
}

/**
 * GET /api/domains
 * Returns all domains sorted by recency then usage. No auth required beyond session.
 */
export async function GET() {
  try {
    return await withSnowflake(async (conn) => {
      const rows = await exec(
        conn,
        `SELECT domain_id, name, usage_count, last_used_at, created_at
         FROM STAND_DB.STAND_INTERNAL.DOMAINS
         ORDER BY last_used_at DESC NULLS LAST,
                  usage_count   DESC,
                  name          ASC`,
      );
      return Response.json({ domains: rows.map(row2domain) });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to fetch domains');
  }
}

/**
 * POST /api/domains
 * Body: { name: string }
 * Creates a new domain. Any authenticated user can create one.
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const session = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const name = String(body?.name ?? '').trim();
  if (!name)             return Response.json({ error: 'name is required' }, { status: 400 });
  if (name.length > 500) return Response.json({ error: 'name too long (max 500 chars)' }, { status: 400 });

  try {
    return await withSnowflake(async (conn) => {
      // Check uniqueness before insert for a cleaner error message
      const existing = await exec(
        conn,
        `SELECT domain_id FROM STAND_DB.STAND_INTERNAL.DOMAINS WHERE name = ?`,
        [name],
      );
      if (existing.length > 0) {
        return Response.json({ error: `A domain named "${name}" already exists.` }, { status: 409 });
      }

      await exec(
        conn,
        `INSERT INTO STAND_DB.STAND_INTERNAL.DOMAINS (name)
         VALUES (?)`,
        [name],
      );

      // name is UNIQUE — safe to fetch back by name
      const rows = await exec(
        conn,
        `SELECT domain_id, name, usage_count, last_used_at, created_at
         FROM STAND_DB.STAND_INTERNAL.DOMAINS
         WHERE name = ?`,
        [name],
      );

      if (!rows.length) {
        return Response.json({ error: 'Domain was created but could not be retrieved.' }, { status: 500 });
      }

      return Response.json({ domain: row2domain(rows[0]) }, { status: 201 });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to create domain');
  }
}
