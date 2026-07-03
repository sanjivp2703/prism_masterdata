/**
 * getRunHeader — direct server-side fetch of a run's header metadata.
 *
 * Used by the run page server component instead of HTTP-fetching its own API
 * (`http://localhost:8000/api/run/:id` never works deployed and carries no
 * cookie). Runs the same SELECT as GET /api/run/[run_id].
 */

import 'server-only';
import { withSnowflake } from './snowflake';

export interface RunHeaderRow {
  RUN_ID?:          number;
  RUN_STATUS?:      string;
  MODE?:            string | null;
  SOURCE_RELATION?: string | null;
  SOURCE_COLUMN?:   string | null;
  CREATED_AT?:      string | null;
  UPDATED_AT?:      string | null;
  CONCEPT_KEY?:     string | null;
  [key: string]: unknown;
}

export async function getRunHeader(runId: number | string): Promise<RunHeaderRow | null> {
  return withSnowflake(async (connection) => {
    const rows = await new Promise<any[]>((resolve, reject) => {
      connection.execute({
        sqlText: `
          SELECT
            r.run_id,
            r.run_status,
            r.mode,
            r.source_relation,
            r.source_column,
            r.created_at,
            r.updated_at,
            r.concept_key
          FROM STAND_DB.STAND_INTERNAL.RUNS r
          WHERE r.run_id = ?
        `,
        binds: [runId as any],
        complete: (err, _stmt, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        },
      });
    });

    return rows.length > 0 ? (rows[0] as RunHeaderRow) : null;
  });
}
