import 'server-only';
import { cookies } from 'next/headers';
import snowflake from 'snowflake-sdk';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { getOptionalEnv } from '@/app/api/_lib/snowflake';

async function exec(conn: any, sqlText: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

/** POST /api/accounts/test-snowflake — validate credentials without saving them */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const session = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const sf_account     = String(body?.sf_account    ?? '').trim();
  const sf_user        = String(body?.sf_user       ?? '').trim();
  const sf_warehouse   = String(body?.sf_warehouse  ?? '').trim();
  const sf_role        = String(body?.sf_role       ?? '').trim() || null;
  const sf_password    = String(body?.sf_password   ?? '').trim() || null;
  const sf_private_key = String(body?.sf_private_key ?? '').trim() || null;

  if (!sf_account || !sf_user || !sf_warehouse) {
    return Response.json({ error: 'Account, username, and warehouse are required.' }, { status: 400 });
  }
  if (!sf_password && !sf_private_key) {
    return Response.json({ error: 'Either a password or a private key is required.' }, { status: 400 });
  }

  const privateKey = sf_private_key
    ? (sf_private_key.includes('\\n') ? sf_private_key.replace(/\\n/g, '\n') : sf_private_key)
    : undefined;
  const authenticator = privateKey ? 'SNOWFLAKE_JWT' : undefined;
  const database = getOptionalEnv('SNOWFLAKE_DATABASE') ?? 'STAND_DB';
  const schema   = getOptionalEnv('SNOWFLAKE_SCHEMA')   ?? 'STAND_INTERNAL';

  const conn = snowflake.createConnection({
    account:   sf_account,
    username:  sf_user,
    warehouse: sf_warehouse,
    database,
    schema,
    ...(sf_role       ? { role: sf_role }     : {}),
    ...(authenticator ? { authenticator }      : {}),
    ...(privateKey
      ? { privateKey }
      : { password: sf_password ?? '' }),
  } as any);

  try {
    await new Promise<void>((resolve, reject) => {
      conn.connect((err) => (err ? reject(err) : resolve()));
    });

    const rows = await exec(conn, `SELECT CURRENT_VERSION() AS v, CURRENT_WAREHOUSE() AS w, CURRENT_DATABASE() AS d`);
    const r = rows[0] ?? {};

    return Response.json({
      ok:        true,
      version:   String(r.V ?? r.v ?? ''),
      warehouse: String(r.W ?? r.w ?? ''),
      database:  String(r.D ?? r.d ?? ''),
    });
  } catch (err: any) {
    // Log the raw driver error server-side; return only the failure CLASS to
    // the client (auth vs network vs other), never the raw message.
    console.error('[test-snowflake] connection test failed:', err);
    const raw  = String(err?.message ?? err ?? '');
    const code = (err as any)?.code;
    let error: string;
    if (/incorrect username or password|password|jwt|private key|authenticat|390100|390144|mfa/i.test(raw)) {
      error = 'Authentication failed. Check your username and password or private key.';
    } else if (/enotfound|econn|etimedout|certificate|could not connect|network|account.*(not exist|not found)|404/i.test(raw)) {
      error = 'Could not reach that Snowflake account. Check the account identifier and your network.';
    } else if (/warehouse/i.test(raw)) {
      error = 'Connected, but the warehouse could not be used. Check the warehouse name and its state.';
    } else {
      error = 'Connection failed. Check the account details and try again.';
    }
    return Response.json({ ok: false, error, code }, { status: 400 });
  } finally {
    await new Promise<void>((resolve) => {
      conn.destroy(() => resolve());
    });
  }
}
