import { getDb } from '@/app/api/_lib/sqlite';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { CURRENT_TERMS_VERSION } from '@/app/api/_lib/terms-version';

/**
 * Records the signed-in account's acceptance of the current terms version
 * (clickwrap — the /accept-terms interstitial POSTs here after the user
 * checks the box). Idempotent; always stamps the CURRENT version, so an
 * account re-accepting after a terms bump is recorded against the new one.
 */
export async function POST() {
  const session = await requireValidSession();
  if (session instanceof Response) return session;

  getDb()
    .prepare(
      `UPDATE accounts
       SET terms_accepted_version = ?,
           terms_accepted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE account_id = ?`,
    )
    .run(CURRENT_TERMS_VERSION, session.accountId);

  return Response.json({ ok: true, version: CURRENT_TERMS_VERSION });
}
