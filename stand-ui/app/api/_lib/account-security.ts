/**
 * Server-side session enforcement helpers.
 *
 * Lives apart from _lib/session.ts on purpose: session.ts is pure/edge-safe
 * (imported by proxy.ts), while these helpers hit the local SQLite database to
 * validate the session's version against accounts.session_version — the
 * revocation mechanism used by member management (role change / removal).
 *
 * ACCOUNTS lives in SQLite, so the version check is a local read — cheap
 * enough to run on every request with no cache and no fail-open compromise.
 */

import 'server-only';
import { cookies } from 'next/headers';
import { getDb } from './sqlite';
import { decodeSession, SESSION_COOKIE_NAME, type SessionPayload } from './session';

function fetchAccountSessionVersion(accountId: number): number | null {
  const row = getDb()
    .prepare(`SELECT session_version FROM accounts WHERE account_id = ?`)
    .get(accountId) as { session_version?: number } | undefined;
  if (!row) return null; // account deleted → no valid version
  return Number(row.session_version ?? 1);
}

/**
 * True when the session's `v` claim matches the account's current
 * session_version. False when the account no longer exists or the version was
 * bumped (role change / removal).
 */
export async function validateSessionVersion(session: SessionPayload): Promise<boolean> {
  const accountId = Number(session.accountId);
  if (!Number.isFinite(accountId) || accountId <= 0) return false;

  let current: number | null;
  try {
    current = fetchAccountSessionVersion(accountId);
  } catch (err) {
    console.error('[account-security] session_version lookup failed:', err);
    return true; // local DB error should be near-impossible — don't lock everyone out
  }

  if (current == null) return false;
  return Number(session.v ?? 1) === current;
}

/**
 * Increment accounts.session_version for an account, invalidating all of its
 * outstanding session cookies (they carry the old `v`).
 */
export async function bumpSessionVersion(accountId: number): Promise<void> {
  getDb()
    .prepare(
      `UPDATE accounts
       SET session_version = COALESCE(session_version, 1) + 1
       WHERE account_id = ?`,
    )
    .run(accountId);
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
