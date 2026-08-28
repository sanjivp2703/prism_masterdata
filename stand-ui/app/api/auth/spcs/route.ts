/**
 * GET /api/auth/spcs — SPCS ingress session bootstrap (native edition only;
 * docs/NATIVE_APP_PLAN.md Phase N2).
 *
 * Behind a Snowpark Container Services public endpoint, Snowflake
 * authenticates the browser user BEFORE any request reaches this container
 * and injects the Snowflake username as the `Sf-Context-Current-User`
 * header. This route converts that ambient identity into Prism's normal
 * session cookie, so every downstream surface — route guards, the /home
 * gate, the terms interstitial, session revocation — works unchanged.
 * proxy.ts redirects cookie-less page loads here; the round trip is
 * invisible to the user (no interaction, the header is always present).
 *
 * Trust model: the header is only honored when the process can see the SPCS
 * ambient token (spcsAmbientAvailable) — i.e. we are actually inside SPCS,
 * where the only route to this container is Snowflake's authenticated
 * ingress. Outside SPCS (local docker, standard edition) the route 404s and
 * a forged header is meaningless.
 *
 * Provisioning: accounts are auto-created per Snowflake username on first
 * sight (`accounts.sf_username`, migration 020). EVERY native account is an
 * admin (owner decision 2026-08-28: the app-level role split is gone in this
 * edition — membership itself is governed by the Snowflake-side application
 * role grant, so an in-app hierarchy bought nothing). Pre-decision rows that
 * were provisioned as 'user' self-promote on their next visit.
 */
import { NextRequest } from 'next/server';
import { getDb } from '@/app/api/_lib/sqlite';
import { buildSessionCookie, sanitizeReturnTo, type SessionPayload } from '@/app/api/_lib/session';
import { isNativeEdition } from '@/app/api/_lib/edition';
import { spcsAmbientAvailable } from '@/app/api/_lib/warehouse/snowflake/connection';
import { CURRENT_TERMS_VERSION } from '@/app/api/_lib/terms-version';
import { reportError } from '@/app/api/_lib/report-error';

export const dynamic = 'force-dynamic';

const SPCS_USER_HEADER = 'sf-context-current-user';

interface AccountRow {
  account_id: number;
  email: string;
  name: string | null;
  role: string;
  session_version: number;
  terms_accepted_version: number | null;
}

export async function GET(request: NextRequest) {
  if (!isNativeEdition() || !spcsAmbientAvailable()) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  const rawUser = request.headers.get(SPCS_USER_HEADER)?.trim();
  if (!rawUser) {
    return Response.json(
      { error: 'No authenticated Snowflake user on this request.' },
      { status: 401 },
    );
  }
  // Snowflake usernames are case-insensitive; normalize for a stable identity.
  const sfUsername = rawUser.toUpperCase();

  let row: AccountRow | undefined;
  try {
    const db = getDb();
    row = db
      .prepare(
        `SELECT account_id, email, name, role, session_version, terms_accepted_version
         FROM accounts WHERE sf_username = ?`,
      )
      .get(sfUsername) as AccountRow | undefined;

    if (!row) {
      // Every native account is an admin (see module doc). google_id/email
      // are NOT NULL UNIQUE — synthesize stable values from the username (no
      // real email exists for a Snowflake identity).
      db.prepare(
        `INSERT INTO accounts (google_id, email, name, role, sf_username, last_login_at)
         VALUES (?, ?, ?, 'admin', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      ).run(
        `spcs:${sfUsername}`,
        `${sfUsername.toLowerCase()}@spcs.invalid`,
        rawUser,
        sfUsername,
      );
      row = db
        .prepare(
          `SELECT account_id, email, name, role, session_version, terms_accepted_version
           FROM accounts WHERE sf_username = ?`,
        )
        .get(sfUsername) as AccountRow;
    } else {
      // Self-heal rows provisioned before the everyone-is-admin decision.
      db.prepare(
        `UPDATE accounts SET role = 'admin',
                last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE account_id = ?`,
      ).run(row.account_id);
      row.role = 'admin';
    }
  } catch (err) {
    reportError(err, { where: 'auth/spcs', sfUsername });
    return Response.json({ error: 'Sign-in failed.' }, { status: 500 });
  }

  const payload: SessionPayload = {
    accountId: row.account_id,
    googleId: `spcs:${sfUsername}`,
    email: row.email,
    name: row.name ?? rawUser,
    pictureUrl: null,
    role: row.role === 'admin' ? 'admin' : 'user',
    v: Number(row.session_version ?? 1),
  };

  const returnTo = sanitizeReturnTo(request.nextUrl.searchParams.get('returnTo') ?? '/home');
  let redirectTo = returnTo || '/home';
  // Same clickwrap backstop as the OAuth callback: un-accepted (or outdated)
  // terms detour through the interstitial before anything else.
  if (Number(row.terms_accepted_version ?? 0) < CURRENT_TERMS_VERSION) {
    redirectTo = `/accept-terms?next=${encodeURIComponent(redirectTo)}`;
  }

  const headers = new Headers();
  headers.append('Set-Cookie', await buildSessionCookie(payload));
  headers.append('Location', redirectTo);
  return new Response(null, { status: 302, headers });
}
