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

async function requireAdmin(request: Request) {
  const cookieStore = await cookies();
  const session = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session)                return { error: 'Unauthorized', status: 401 };
  if (session.role !== 'admin') return { error: 'Admin access required.', status: 403 };
  return { session };
}

/**
 * PATCH /api/domains/[domain_id]
 * Body: { name: string }
 * Rename a domain. Admin only.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ domain_id: string }> },
) {
  const auth = await requireAdmin(request);
  if ('error' in auth) return Response.json({ error: auth.error }, { status: auth.status });

  const { domain_id } = await params;
  const id = Number(domain_id);
  if (!Number.isFinite(id) || id <= 0) {
    return Response.json({ error: 'Invalid domain_id' }, { status: 400 });
  }

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const name = String(body?.name ?? '').trim();
  if (!name)             return Response.json({ error: 'name is required' }, { status: 400 });
  if (name.length > 500) return Response.json({ error: 'name too long (max 500 chars)' }, { status: 400 });

  try {
    return await withSnowflake(async (conn) => {
      // Check target exists
      const existing = await exec(
        conn,
        `SELECT domain_id FROM STAND_DB.STAND_INTERNAL.DOMAINS WHERE domain_id = ?`,
        [id],
      );
      if (!existing.length) {
        return Response.json({ error: 'Domain not found.' }, { status: 404 });
      }

      // Check name uniqueness (excluding this domain)
      const conflict = await exec(
        conn,
        `SELECT domain_id FROM STAND_DB.STAND_INTERNAL.DOMAINS WHERE name = ? AND domain_id <> ?`,
        [name, id],
      );
      if (conflict.length > 0) {
        return Response.json({ error: `A domain named "${name}" already exists.` }, { status: 409 });
      }

      await exec(
        conn,
        `UPDATE STAND_DB.STAND_INTERNAL.DOMAINS
         SET name = ?, updated_at = CURRENT_TIMESTAMP()
         WHERE domain_id = ?`,
        [name, id],
      );

      const rows = await exec(
        conn,
        `SELECT domain_id, name, usage_count, last_used_at, created_at
         FROM STAND_DB.STAND_INTERNAL.DOMAINS WHERE domain_id = ?`,
        [id],
      );

      return Response.json({ domain: rows[0] });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to rename domain');
  }
}

/**
 * DELETE /api/domains/[domain_id]
 * Deletes a domain. Admin only.
 * Blocked if any runs or literal matches reference it.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ domain_id: string }> },
) {
  const auth = await requireAdmin(request);
  if ('error' in auth) return Response.json({ error: auth.error }, { status: auth.status });

  const { domain_id } = await params;
  const id = Number(domain_id);
  if (!Number.isFinite(id) || id <= 0) {
    return Response.json({ error: 'Invalid domain_id' }, { status: 400 });
  }

  try {
    return await withSnowflake(async (conn) => {
      // Block if runs exist for this domain
      const runRows = await exec(
        conn,
        `SELECT COUNT(*) AS cnt FROM STAND_DB.STAND_INTERNAL.RUNS WHERE domain_id = ?`,
        [id],
      );
      const runCount = Number((runRows[0] as any)?.CNT ?? (runRows[0] as any)?.cnt ?? 0);
      if (runCount > 0) {
        return Response.json(
          { error: `Cannot delete — ${runCount} run(s) are associated with this domain.` },
          { status: 409 },
        );
      }

      await exec(
        conn,
        `DELETE FROM STAND_DB.STAND_INTERNAL.DOMAINS WHERE domain_id = ?`,
        [id],
      );

      return Response.json({ ok: true });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to delete domain');
  }
}
