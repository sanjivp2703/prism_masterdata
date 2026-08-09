/**
 * Run state blob schema + persistence helpers.
 *
 * The warehouse-side INTERNAL.RUN_STATE table is the sole source of truth for
 * a run's grouping/review state (data residency: the blob holds customer
 * values, so it never rests in local SQLite — runs there is metadata only).
 * These types describe the blob's shape; loadOpRunState / saveOpRunState read
 * and write it. Live auto-grouping lives in op-auto-group-run.ts →
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
  /** Stamped at auto-group time for items placed in an LLM group: the initial
   *  group's alias/id/confidence as first proposed. The initial standardization
   *  is trusted — the export validation pass (Case C) uses these to referee
   *  user moves away from a high-confidence initial grouping, exactly like
   *  Case A referees moves away from confirmed lookup mappings. */
  initial_alias_name?:  string;
  initial_group_id?:    number;
  initial_confidence?:  'h' | 'm' | 'l';
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
// State persistence helpers (exported for reuse in routes)
//
// DATA RESIDENCY: the state blob contains the customer's distinct column
// values, so it lives in the CUSTOMER'S WAREHOUSE (INTERNAL.RUN_STATE), never
// in the local SQLite file. SQLite's runs table keeps metadata only (status,
// source, nonce). All access goes through the service connection — one-time
// runs included (RUN_STATE is Prism's own table, which the service role owns;
// the personal-credential fallback applies only to reading the customer's
// source and writing exports).
//
// COST RULE: these helpers run warehouse queries. They may be called from the
// run review page (user-active work), the export path, and the tick processor
// — never from recurring list/poll surfaces (GET /api/pipelines, SSE refetch,
// idle poll cycles), which must stay warehouse-free.
// ---------------------------------------------------------------------------

import { withWarehouse, executeQuery, getWarehouseAdapter } from './warehouse';

type WarehouseConn = unknown;

function runStateTable(): string {
  return getWarehouseAdapter().kind === 'mssql'
    ? 'INTERNAL.RUN_STATE'
    : 'PRISM_DB.INTERNAL.RUN_STATE';
}

function parseStateCell(raw: unknown): OpRunState | null {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as OpRunState; } catch { return null; }
  }
  return raw as OpRunState;  // snowflake-sdk returns VARIANT columns pre-parsed
}

async function withConn<T>(conn: WarehouseConn | undefined, fn: (c: WarehouseConn) => Promise<T>): Promise<T> {
  if (conn) return fn(conn);
  return withWarehouse((c) => fn(c));
}

export async function loadOpRunState(runId: number, conn?: WarehouseConn): Promise<OpRunState | null> {
  return withConn(conn, async (c) => {
    const rows = await executeQuery(
      c,
      `SELECT state FROM ${runStateTable()} WHERE run_id = ?`,
      [runId],
    ) as Array<Record<string, unknown>>;
    const row = rows?.[0];
    if (!row) return null;
    return parseStateCell(row.STATE ?? row.state);
  });
}

/** Batch load for user-initiated list surfaces (e.g. the one-time archive). */
export async function loadOpRunStatesBatch(
  runIds: number[],
  conn?: WarehouseConn,
): Promise<Map<number, OpRunState>> {
  const out = new Map<number, OpRunState>();
  const ids = runIds.filter((n) => Number.isFinite(n));
  if (!ids.length) return out;
  return withConn(conn, async (c) => {
    const BATCH = 500;  // well under both bind ceilings
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const rows = await executeQuery(
        c,
        `SELECT run_id, state FROM ${runStateTable()}
         WHERE run_id IN (${chunk.map(() => '?').join(', ')})`,
        chunk,
      ) as Array<Record<string, unknown>>;
      for (const r of rows ?? []) {
        const idRaw = r.RUN_ID ?? r.run_id;
        const parsed = parseStateCell(r.STATE ?? r.state);
        if (idRaw != null && parsed) out.set(Number(idRaw), parsed);
      }
    }
    return out;
  });
}

export async function saveOpRunState(runId: number, state: OpRunState, conn?: WarehouseConn): Promise<void> {
  const json = JSON.stringify(state);
  await withConn(conn, async (c) => {
    if (getWarehouseAdapter().kind === 'mssql') {
      await executeQuery(
        c,
        `MERGE INTO INTERNAL.RUN_STATE WITH (HOLDLOCK) AS t
         USING (SELECT ? AS run_id, ? AS state) AS s
         ON t.run_id = s.run_id
         WHEN MATCHED THEN UPDATE SET state = s.state, updated_at = SYSUTCDATETIME()
         WHEN NOT MATCHED THEN INSERT (run_id, state, updated_at)
           VALUES (s.run_id, s.state, SYSUTCDATETIME());`,
        [runId, json],
      );
    } else {
      // PARSE_JSON(?) is fine here — the VALUES-clause restriction doesn't
      // apply to a USING (SELECT …) source.
      await executeQuery(
        c,
        `MERGE INTO PRISM_DB.INTERNAL.RUN_STATE t
         USING (SELECT ? AS run_id, PARSE_JSON(?) AS state) s
         ON t.run_id = s.run_id
         WHEN MATCHED THEN UPDATE SET t.state = s.state, t.updated_at = CURRENT_TIMESTAMP()
         WHEN NOT MATCHED THEN INSERT (run_id, state, updated_at)
           VALUES (s.run_id, s.state, CURRENT_TIMESTAMP())`,
        [runId, json],
      );
    }
  });
}

/**
 * Optimistic-concurrency save: writes the blob with rev = expectedRev + 1, but
 * ONLY if the stored blob's rev still equals expectedRev (a missing rev counts
 * as 0; a missing ROW counts as rev 0 and is inserted). Returns true when the
 * write landed, false on a rev conflict (someone else wrote the blob since it
 * was loaded).
 */
export async function saveOpRunStateWithRev(
  runId:       number,
  state:       OpRunState,
  expectedRev: number,
  conn?:       WarehouseConn,
): Promise<boolean> {
  const json = JSON.stringify({ ...state, rev: expectedRev + 1 });
  return withConn(conn, async (c) => {
    if (getWarehouseAdapter().kind === 'mssql') {
      const rows = await executeQuery(
        c,
        `UPDATE INTERNAL.RUN_STATE
         SET state = ?, updated_at = SYSUTCDATETIME()
         OUTPUT INSERTED.run_id
         WHERE run_id = ?
           AND COALESCE(TRY_CAST(JSON_VALUE(state, '$.rev') AS INT), 0) = ?`,
        [json, runId, expectedRev],
      ) as unknown[];
      if ((rows?.length ?? 0) > 0) return true;
    } else {
      const rows = await executeQuery(
        c,
        `UPDATE PRISM_DB.INTERNAL.RUN_STATE
         SET state = PARSE_JSON(?), updated_at = CURRENT_TIMESTAMP()
         WHERE run_id = ?
           AND COALESCE(state:rev::NUMBER, 0) = ?`,
        [json, runId, expectedRev],
      ) as Array<Record<string, unknown>>;
      // Snowflake DML returns one row like { "number of rows updated": N }.
      const updated = Number(Object.values(rows?.[0] ?? {})[0] ?? 0);
      if (updated > 0) return true;
    }
    // No row updated. If the row simply doesn't exist yet (fresh run whose
    // skeleton save failed, or a pre-migration run), rev 0 is the only rev
    // that may create it.
    if (expectedRev === 0) {
      const existing = await executeQuery(
        c,
        `SELECT run_id FROM ${runStateTable()} WHERE run_id = ?`,
        [runId],
      ) as unknown[];
      if ((existing?.length ?? 0) === 0) {
        await saveOpRunState(runId, { ...state, rev: 1 }, c);
        return true;
      }
    }
    return false;
  });
}
