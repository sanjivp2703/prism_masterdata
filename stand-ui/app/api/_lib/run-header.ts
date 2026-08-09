/**
 * getRunHeader — direct server-side fetch of a run's header metadata.
 *
 * Used by the run page server component instead of HTTP-fetching its own API.
 * RUNS lives in local SQLite; the row shape keeps the historical uppercase
 * aliases callers normalize against.
 */

import 'server-only';
import { getDb } from './sqlite';

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
  // `runs.domain_id` now holds the per-column spec_id (the lookup scope). The
  // run's standardization rules + naming convention come from its column spec;
  // the "concept name" shown in the review UI is the column name itself.
  const r = getDb()
    .prepare(
      `SELECT r.run_id, r.run_status, r.mode, r.source_relation, r.source_column,
              r.created_at, r.updated_at, r.concept_key,
              cs.description AS spec_description, cs.standardization_rules,
              cs.convention_type, cs.convention_value, cs.convention_rules
       FROM runs r
       LEFT JOIN column_specs cs ON cs.spec_id = r.domain_id
       WHERE r.run_id = ?`,
    )
    .get(Number(runId)) as any;
  if (!r) return null;
  return {
    run_id:           r.run_id,
    run_status:       r.run_status,
    mode:             r.mode,
    source_relation:  r.source_relation,
    source_column:    r.source_column,
    created_at:       r.created_at,
    updated_at:       r.updated_at,
    concept_key:      r.concept_key,
    // The column name is the "concept" now — surfaced as the rules-panel title.
    column_name:      r.source_column ?? null,
    description:      r.spec_description ?? null,
    standardization_rules: r.standardization_rules ?? null,
    convention_type:  r.convention_type ?? null,
    convention_value: r.convention_value ?? null,
    convention_rules: r.convention_rules ?? null,
  } as RunHeaderRow;
}
