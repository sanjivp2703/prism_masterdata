/**
 * GET /api/accounts/members — list all accounts. Admin only.
 */

import 'server-only';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { requireAdminSession } from '@/app/api/_lib/account-security';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

function col(r: any, key: string) {
  return r[key.toUpperCase()] ?? r[key.toLowerCase()];
}

export async function GET() {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;

  try {
    return await withSnowflake(async (conn) => {
      const rows = await exec(
        conn,
        `SELECT account_id, email, name, role, picture_url, created_at
         FROM STAND_DB.STAND_INTERNAL.ACCOUNTS
         ORDER BY created_at ASC`,
      );
      const members = rows.map((r) => ({
        account_id:  Number(col(r, 'account_id')),
        email:       String(col(r, 'email') ?? ''),
        name:        col(r, 'name') != null ? String(col(r, 'name')) : null,
        role:        col(r, 'role') === 'admin' ? 'admin' : 'user',
        picture_url: col(r, 'picture_url') != null ? String(col(r, 'picture_url')) : null,
        created_at:  col(r, 'created_at') ?? null,
      }));
      return Response.json({ members });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to load members');
  }
}
