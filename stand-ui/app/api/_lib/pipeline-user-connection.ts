// User-connection pipelines (mssql only, 2026-08-17): a pipeline whose source
// table the service login can't see runs its SOURCE reads on the CREATOR's
// saved personal credentials — the pipeline analog of the one-time flow's
// personal-connection fallback. Internal state (queue, lookup, run state)
// always stays on the service connection; the flag is set at
// create-initial-run when the service scan fails with an access error and the
// creator's credentials can read the table.
//
// Snowflake pipelines can never use this: stream reads require SELECT on the
// underlying table by the READING role, so a source the service role can't
// see is a source it can't watch — the answer there is granting the service
// role (setup wizard Part D). pg/mysql are diff-scan shaped like mssql and
// could adopt this later; until then the flag is only ever set on mssql.
import 'server-only';

import { getDb } from './sqlite';

export interface PipelineConnInfo {
  useUser: boolean;
  createdBy: number | null;
}

/** Which connection this pipeline's SOURCE reads run on. */
export function pipelineConnInfo(pipelineId: number): PipelineConnInfo {
  const r = getDb()
    .prepare(`SELECT use_user_connection, created_by FROM pipelines WHERE pipeline_id = ?`)
    .get(pipelineId) as any;
  return {
    useUser: r?.use_user_connection === 1,
    createdBy: r?.created_by != null ? Number(r.created_by) : null,
  };
}

export function markPipelineUserConnection(pipelineId: number): void {
  getDb()
    .prepare(
      `UPDATE pipelines
       SET use_user_connection = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE pipeline_id = ?`,
    )
    .run(pipelineId);
}

/** The one pause message for a user-connection pipeline whose credentials are
 *  missing or no longer work — shown on the card, so it must say what to do. */
export function userConnPauseMessage(tableFqn: string): string {
  return (
    `This pipeline reads ${tableFqn} with its creator's personal SQL Server credentials, ` +
    `which are missing or no longer work. The creator can re-save their credentials in Setup, ` +
    `or an admin can grant the Prism service login access to the table — then resume the pipeline.`
  );
}
