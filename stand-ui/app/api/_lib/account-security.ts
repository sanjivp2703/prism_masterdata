/**
 * Server-side session enforcement helpers.
 *
 * Lives apart from _lib/session.ts on purpose: session.ts is pure/edge-safe
 * (imported by proxy.ts), while these helpers hit Snowflake to validate the
 * session's version against ACCOUNTS.session_version — the revocation
 * mechanism used by member management (role change / removal).
 */

import 'server-only';
import { cookies } from 'next/headers';
import { withSnowflake } from './snowflake';
import { decodeSession, SESSION_COOKIE_NAME, type SessionPayload } from './session';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

// ── Session-version cache (60 s TTL) ─────────────────────────────────────────
// Avoids a Snowflake round-trip on every version-checked request. Bumping a
// version invalidates the entry immediately in this process.

const VERSION_CACHE_TTL_MS = 60_000;
const versionCache = new Map<number, { version: number; fetchedAt: number }>();

async function fetchAccountSessionVersion(accountId: number): Promise<number | null> {
  const rows = await withSnowflake(async (conn) =>
    exec(
      conn,
      `SELECT session_version FROM STAND_DB.STAND_INTERNAL.ACCOUNTS WHERE account_id = ? LIMIT 1`,
      [accountId],
    ),
  );
  if (!rows.length) return null; // account deleted → no valid version
  const r = rows[0] as any;
  return Number(r.SESSION_VERSION ?? r.session_version ?? 1);
}

/**
 * True when the session's `v` claim matches the account's current
 * session_version. False when the account no longer exists or the version was
 * bumped (role change / removal). Fails open on transient Snowflake errors so
 * an outage doesn't lock everyone out.
 */
export async function validateSessionVersion(session: SessionPayload): Promise<boolean> {
  const accountId = Number(session.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) return false;

  const cached = versionCache.get(accountId);
  let current: number | null;
  if (cached && Date.now() - cached.fetchedAt < VERSION_CACHE_TTL_MS) {
    current = cached.version;
  } else {
    try {
      current = await fetchAccountSessionVersion(accountId);
    } catch (err) {
      console.error('[account-security] session_version lookup failed:', err);
      return true; // transient DB error — don't lock the user out
    }
    if (current != null) versionCache.set(accountId, { version: current, fetchedAt: Date.now() });
    else versionCache.delete(accountId);
  }

  if (current == null) return false;
  return Number(session.v ?? 1) === current;
}

/**
 * Increment ACCOUNTS.session_version for an account, invalidating all of its
 * outstanding session cookies (they carry the old `v`).
 */
export async function bumpSessionVersion(accountId: number): Promise<void> {
  await withSnowflake(async (conn) => {
    await exec(
      conn,
      `UPDATE STAND_DB.STAND_INTERNAL.ACCOUNTS
       SET session_version = COALESCE(session_version, 1) + 1
       WHERE account_id = ?`,
      [accountId],
    );
  });
  versionCache.delete(accountId);
}

// ── Route guards ──────────────────────────────────────────────────────────────
// Both return either the decoded SessionPayload or a ready-to-return Response.
// Usage:
//   const auth = await requireAdminSession();
//   if (auth instanceof Response) return auth;
//   // auth is the SessionPayload

/** Any authenticated user with a current (non-revoked) session. */
export async function requireValidSession(): Promise<SessionPayload | Response> {
  const cookieStore = await cookies();
  const session = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!(await validateSessionVersion(session))) {
    return Response.json({ error: 'Session is no longer valid. Sign in again.' }, { status: 401 });
  }
  return session;
}

/** Admin-only guard with the same session-version check. */
export async function requireAdminSession(): Promise<SessionPayload | Response> {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  if (auth.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });
  return auth;
}
