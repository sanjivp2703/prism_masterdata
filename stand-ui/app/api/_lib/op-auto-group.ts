/**
 * Run state blob schema + persistence helpers.
 *
 * The RUNS.state VARIANT column is the sole source of truth for a run.
 * These types describe its shape; loadOpRunState / saveOpRunState read and
 * write the blob. Live auto-grouping lives in op-auto-group-run.ts →
 * llm-one-prompt-grouping.ts.
 */

import 'server-only';

// ---------------------------------------------------------------------------
// Public types (blob schema)
// ---------------------------------------------------------------------------

export interface OpStateItem {
  run_item_id?:         number;   // stable 1-based index assigned at run creation; absent for legacy blobs
  literal_value:        string;
  source_frequency?:    number;
  matched_from_lookup:  boolean;
  alias_name?:          string;
}

export interface OpGroupItem {
  literal_value:       string;
  matched_from_lookup: boolean;
}

export interface OpGroup {
  group_id:          number;
  alias_name:        string;
  /** 'llm_failed' = the LLM chunk call for this item failed even after retries;
   *  the item is self-mapped as an honest low-confidence fallback. */
  alias_name_source: 'lookup_validated' | 'llm_proposed' | 'user_override' | 'llm_failed';
  confidence:        'h' | 'm' | 'l';
  from_lookup_chunk: boolean;
  /** Singleton groups the LLM couldn't confidently place — self-mapped and
   *  surfaced in yellow for the user to confirm/rename. Still written to the
   *  lookup so no value is left unmapped (keeps the pipeline queue empty). */
  needs_review?:     boolean;
  items:             OpGroupItem[];
}

export interface OpUngrouped {
  literal_value:       string;
  matched_from_lookup: boolean;
}

export interface OpRunState {
  status:    'created' | 'running' | 'complete' | 'failed';
  items:     OpStateItem[];
  groups:    OpGroup[];
  ungrouped: OpUngrouped[];
  /** Optimistic-concurrency revision counter. Missing = 0 (legacy blobs). */
  rev?:      number;
  /** Set to 'failed' when the post-export async validation pass could not be
   *  applied (LLM parse failure etc.). The run itself stays 'completed' — the
   *  user's mappings were already written at face value. */
  validation_status?: 'failed' | 'ok';
}

// ---------------------------------------------------------------------------
// Snowflake exec helper (local — not exported)
// ---------------------------------------------------------------------------

async function exec(connection: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete: (err: any, _stmt: any, rows: any[]) => {
        if (err) reject(err);
        else     resolve(rows ?? []);
      },
    });
  });
}

// ---------------------------------------------------------------------------
// State persistence helpers (exported for reuse in routes)
// ---------------------------------------------------------------------------

export async function loadOpRunState(connection: any, runId: number): Promise<OpRunState | null> {
  const rows = await exec(
    connection,
    `SELECT state FROM STAND_DB.STAND_INTERNAL.RUNS WHERE run_id = ?`,
    [runId],
  );
  if (!rows.length) return null;

  const raw = (rows[0] as any).STATE ?? (rows[0] as any).state;
  if (raw == null) return null;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as OpRunState;
}

export async function saveOpRunState(
  connection: any,
  runId:      number,
  state:      OpRunState,
): Promise<void> {
  const json = JSON.stringify(state);
  await exec(
    connection,
    `UPDATE STAND_DB.STAND_INTERNAL.RUNS
     SET state      = PARSE_JSON(?),
         updated_at = CURRENT_TIMESTAMP()
     WHERE run_id = ?`,
    [json, runId],
  );
}

/**
 * Optimistic-concurrency save: writes the blob with rev = expectedRev + 1, but
 * ONLY if the stored blob's rev still equals expectedRev (a missing rev counts
 * as 0). Returns true when the write landed, false on a rev conflict (someone
 * else wrote the blob since it was loaded).
 */
export async function saveOpRunStateWithRev(
  connection:  any,
  runId:       number,
  state:       OpRunState,
  expectedRev: number,
): Promise<boolean> {
  const json = JSON.stringify({ ...state, rev: expectedRev + 1 });
  const rows = await exec(
    connection,
    `UPDATE STAND_DB.STAND_INTERNAL.RUNS
     SET state      = PARSE_JSON(?),
         updated_at = CURRENT_TIMESTAMP()
     WHERE run_id = ?
       AND ((state:rev IS NULL AND ? = 0) OR state:rev::NUMBER = ?)`,
    [json, runId, expectedRev, expectedRev],
  );
  // Snowflake returns "number of rows updated" in the result of an UPDATE.
  return Number((rows[0] as any)?.['number of rows updated'] ?? 0) > 0;
}
