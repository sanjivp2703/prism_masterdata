// Native-edition source-access preflight (owner "add it", 2026-09-02).
//
// The failure this prevents: interactive screens run with the CALLER's own
// Snowflake access (§2.9), so a user can connect and create a pipeline on a
// table the APPLICATION itself was never granted — and the background poller,
// which runs with the app's own grants and no user session, then pauses the
// pipeline on its first cycle, forever, with resume flipping straight back.
// These probes run on the SERVICE connection at the two moments the user can
// actually act — pipeline creation and resume — and turn the doomed state
// into an immediate, actionable refusal pointing at the setup page's access
// block (which grants read + change tracking for the whole database).
//
// Both probes are metadata-layer (SHOW) — no warehouse wake on a user click.
import 'server-only';

import { executeQuery, isWarehouseAccessError } from './warehouse';
import { isNativeEdition } from './edition';
import { getOptionalEnv } from './env';

const q = (s: string) => `"${String(s).replace(/"/g, '""')}"`;

function setupFix(db: string): string {
  return (
    `Open Prism's setup page, select the ${db} database, and run the access block as ` +
    `ACCOUNTADMIN (one paste: read access for background pipelines plus change ` +
    `detection for every table).`
  );
}

/**
 * Returns a user-facing refusal message when the APP cannot run a pipeline on
 * this source table, or null when everything checks out (or the check does
 * not apply: standard edition, non-3-part FQN — those fail elsewhere with
 * their own messages). Unexpected errors are rethrown for the caller's normal
 * error handling.
 */
export async function probeNativeSourceAccess(
  conn: unknown,
  tableFqn: string,
): Promise<string | null> {
  if (!isNativeEdition()) return null;
  const parts = String(tableFqn).trim().split('.');
  if (parts.length !== 3) return null;
  const [db, schema, table] = parts;

  // 1. Can the app see the table at all? SHOW COLUMNS throws for a table the
  //    connection has no visibility on (same probe the poller's health check
  //    uses).
  try {
    await executeQuery(conn, `SHOW COLUMNS IN TABLE ${q(db)}.${q(schema)}.${q(table)}`);
  } catch (e) {
    if (isWarehouseAccessError(e) || /does not exist|not authorized/i.test(String((e as Error)?.message ?? e))) {
      return (
        `Prism's background service can't read ${tableFqn} — you can see the table, but ` +
        `pipelines run with the app's own access, which was never granted here. ${setupFix(db)} ` +
        `Then try again.`
      );
    }
    throw e;
  }

  // 2. Is change tracking on? A stream can't be created without it, and the
  //    app can't enable it with read-only grants. Best-effort: any failure of
  //    this secondary probe defers to the poller's own pause-with-message.
  try {
    const rows = await executeQuery(
      conn,
      `SHOW TABLES LIKE '${table.replace(/'/g, "''")}' IN SCHEMA ${q(db)}.${q(schema)}`,
    );
    const first = rows?.[0] as Record<string, unknown> | undefined;
    const ct = String(first?.change_tracking ?? first?.CHANGE_TRACKING ?? '').toUpperCase();
    if (first && ct === 'OFF') {
      return (
        `Change detection is off for ${tableFqn}, so a pipeline can't watch it for new ` +
        `values. ${setupFix(db)} Then try again.`
      );
    }
  } catch { /* covered by the poller's change-tracking pause if it matters */ }

  return null;
}

/** The pause/refusal copy for a source the app can't reach, native wording —
 *  shared with the poller so the card and the preflights tell one story. */
export function nativeSourceAccessPauseMessage(tableFqn: string): string {
  const db = String(tableFqn).trim().split('.')[0] || 'the source';
  return (
    `Prism's background service can't read ${tableFqn} — it may have been dropped, ` +
    `renamed, or never granted to the app. ${setupFix(db)} Then resume this pipeline.`
  );
}

/**
 * AFTER a failed export build: does the destination exist under someone
 * else's ownership? CREATE OR REPLACE needs OWNERSHIP of the existing table —
 * schema CREATE TABLE rights are not enough — so a table made outside the
 * app (a caller-session one-time export, or one predating Prism) fails every
 * rebuild while the grants all look correct (live-found 2026-09-02:
 * DEMO_DATA.RESTRICTED.RAW_VENDORS_STANDARDIZED, created 08-16, owner
 * ACCOUNTADMIN — the card blamed a CREATE TABLE grant that existed). Only
 * called from failure handlers, never as a pre-block, so a probe quirk can
 * never stop a healthy build. Returns the explanation, or null.
 */
export async function probeNativeExportCollision(
  conn: unknown,
  exportFqn: string,
): Promise<string | null> {
  if (!isNativeEdition()) return null;
  const parts = String(exportFqn).trim().split('.');
  if (parts.length !== 3) return null;
  const [db, schema, table] = parts;
  const appName = getOptionalEnv('SNOWFLAKE_DATABASE') ?? '';
  if (!appName) return null;
  try {
    const rows = await executeQuery(
      conn,
      `SHOW TABLES LIKE '${table.replace(/'/g, "''")}' IN SCHEMA ${q(db)}.${q(schema)}`,
    );
    const first = rows?.[0] as Record<string, unknown> | undefined;
    if (!first) return null;
    const owner = String(first.owner ?? first.OWNER ?? '');
    if (!owner || owner.toUpperCase() === appName.toUpperCase()) return null;
    return (
      `The output table ${exportFqn} already exists and is owned by ${owner}, not Prism — ` +
      `it was created outside this pipeline (for example by a one-time export, or before ` +
      `Prism was set up), and Prism can only maintain a table it owns. Rename or drop the ` +
      `existing table (its standardized contents are rebuilt automatically): ` +
      `ALTER TABLE ${exportFqn} RENAME TO ${table}_OLD; ` +
      `then use "Rebuild export table now" in the card's Settings tab.`
    );
  } catch {
    return null; // can't verify — let the build error speak for itself
  }
}

/** Native wording for a failed export build (the standard edition's message
 *  says GRANT ... TO ROLE PRISM_SERVICE, which doesn't exist here). The app
 *  name comes from the SPCS env (SNOWFLAKE_DATABASE = the app's own db);
 *  the placeholder keeps the SQL legible if it's ever absent. */
export function nativeExportBuildFixMessage(
  exportFqn: string,
  exportSchema: string,
  kind: 'table' | 'view',
): string {
  const app = getOptionalEnv('SNOWFLAKE_DATABASE') ?? '<your Prism app name>';
  const objectWord = kind === 'view' ? 'view' : 'table';
  const createPriv = kind === 'view' ? 'CREATE VIEW' : 'CREATE TABLE';
  const repair = kind === 'view' ? 'Recreate view now' : 'Rebuild export table now';
  return (
    `The export ${objectWord} ${exportFqn} could not be built. Run in Snowflake: ` +
    `GRANT USAGE ON SCHEMA ${exportSchema} TO APPLICATION "${app}"; ` +
    `GRANT ${createPriv} ON SCHEMA ${exportSchema} TO APPLICATION "${app}"; ` +
    `then use "${repair}" in the card's Settings tab.`
  );
}

/** Native wording for the change-tracking pause (the standard edition's
 *  message names PRISM_SERVICE and personal credentials, neither of which
 *  exists in this edition). */
export function nativeChangeTrackingPauseMessage(tableFqn: string): string {
  const db = String(tableFqn).trim().split('.')[0] || 'the source';
  return (
    `Prism can't watch ${tableFqn} for changes: change tracking is not enabled on the ` +
    `table and the app can't enable it with read-only access. ${setupFix(db)} ` +
    `Then resume this pipeline.`
  );
}
