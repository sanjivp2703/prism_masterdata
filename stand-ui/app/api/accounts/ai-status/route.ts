/**
 * GET /api/accounts/ai-status (native edition; any valid session) — is the
 * AI actually usable in this installation? Drives /setup's "Run once after
 * install" section: when Cortex already works, the page shows a green check
 * instead of asking (potentially non-admin) visitors to run ACCOUNTADMIN SQL
 * that was already run (owner request 2026-08-16).
 *
 * Probes with a minimal Cortex COMPLETE call on the service connection —
 * a one-shot user-clicked surface (the /setup page load), never polled, and
 * the verdict is cached in-process for 10 minutes so repeat visits are free.
 * Any failure reads as "not configured" (fail toward showing instructions).
 */
import { requireValidSession } from '@/app/api/_lib/account-security';
import { withWarehouse, executeQuery } from '@/app/api/_lib/warehouse';
import { isNativeEdition, nativeEditionUnavailable } from '@/app/api/_lib/edition';
import { DEFAULT_CORTEX_MODEL } from '@/app/api/_lib/llm-one-prompt-grouping';

export const dynamic = 'force-dynamic';

let _cache: { configured: boolean; at: number } | null = null;
const CACHE_MS = 10 * 60 * 1000;

export async function GET() {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  if (!isNativeEdition()) return nativeEditionUnavailable('AI status');

  if (_cache && Date.now() - _cache.at < CACHE_MS) {
    return Response.json({ configured: _cache.configured, cached: true });
  }

  let configured = false;
  try {
    await withWarehouse(async (conn) => {
      await executeQuery(
        conn,
        `SELECT SNOWFLAKE.CORTEX.COMPLETE(?, 'Reply with the word ok') AS R`,
        [DEFAULT_CORTEX_MODEL],
      );
    });
    configured = true;
  } catch {
    configured = false; // region flag or CORTEX_USER grant missing — show the SQL
  }
  _cache = { configured, at: Date.now() };
  return Response.json({ configured });
}
