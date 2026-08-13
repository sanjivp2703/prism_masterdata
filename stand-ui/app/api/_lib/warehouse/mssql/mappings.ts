/* eslint-disable @typescript-eslint/no-explicit-any --
   driver rows are untyped by nature (see ../types.ts). */
// SQL Server implementations of the lookup write path (docs/MSSQL_PORT_PLAN.md
// Phase 5) — the T-SQL counterparts of op-export.ts's Snowflake MERGEs.
//
// Differences from the Snowflake versions, all deliberate:
//  * normalized_value is computed APP-SIDE (normalizeLiteral) — there is no
//    SQL-side normalize function on this warehouse (plan decision 2.2).
//  * VALUES-table sources use T-SQL syntax `(VALUES …) AS s(col, …)` instead
//    of Snowflake's `SELECT column1 … FROM VALUES`.
//  * Batches are sized under the ~2,100-bind statement ceiling.
//  * MERGE takes WITH (HOLDLOCK) (T-SQL MERGE is not atomic against races
//    without it) and requires a terminating semicolon.
import 'server-only';

import { normalizeLiteral } from '../../normalize';
import { internalTable } from '../../warehouse-tables';
import { executeQuery as exec } from './connection';

// 1 bind per name → 1500 is comfortably inside the ceiling.
const NAME_BATCH = 1_500;
// 4 binds per entry (literal, normalized, alias_id, run_id) → 400 rows = 1600.
const MATCH_BATCH = 400;

export async function upsertApprovedAliasMssql(
  conn:      any,
  aliasName: string,
  domainId:  number | null,
): Promise<number> {
  const domainFilter  = domainId != null ? `AND t.domain_id = ${Number(domainId)}` : `AND t.domain_id IS NULL`;
  const selectFilter  = domainId != null ? `AND domain_id = ${Number(domainId)}`   : `AND domain_id IS NULL`;
  const domainLiteral = domainId != null ? String(Number(domainId)) : 'NULL';

  await exec(
    conn,
    `MERGE ${internalTable('APPROVED_ALIAS_NAMES')} WITH (HOLDLOCK) AS t
     USING (SELECT ? AS alias_name) AS s
       ON t.alias_name = s.alias_name ${domainFilter}
     WHEN MATCHED THEN UPDATE SET
       usage_count  = t.usage_count + 1,
       last_used_at = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT (alias_name, domain_id, usage_count, last_used_at)
       VALUES (s.alias_name, ${domainLiteral}, 1, SYSUTCDATETIME());`,
    [aliasName],
  );

  const rows = await exec(
    conn,
    `SELECT alias_id FROM ${internalTable('APPROVED_ALIAS_NAMES')} WHERE alias_name = ? ${selectFilter}`,
    [aliasName],
  );
  const aliasId = Number(rows[0]?.alias_id ?? 0);
  if (!aliasId) throw new Error(`[mssql/mappings] Could not retrieve alias_id for "${aliasName}"`);
  return aliasId;
}

export async function bulkUpsertApprovedAliasesMssql(
  conn:       any,
  aliasNames: string[],
  domainId:   number | null,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const names  = Array.from(new Set(aliasNames)).filter((n) => n != null && n !== '');
  if (names.length === 0) return result;

  const domainFilter  = domainId != null ? `AND t.domain_id = ${Number(domainId)}` : `AND t.domain_id IS NULL`;
  const selectFilter  = domainId != null ? `AND domain_id = ${Number(domainId)}`   : `AND domain_id IS NULL`;
  const domainLiteral = domainId != null ? String(Number(domainId)) : 'NULL';

  for (let i = 0; i < names.length; i += NAME_BATCH) {
    const batch = names.slice(i, i + NAME_BATCH);
    const valuesRows = batch.map(() => '(?)').join(', ');
    await exec(
      conn,
      `MERGE ${internalTable('APPROVED_ALIAS_NAMES')} WITH (HOLDLOCK) AS t
       USING (VALUES ${valuesRows}) AS s (alias_name)
         ON t.alias_name = s.alias_name ${domainFilter}
       WHEN MATCHED THEN UPDATE SET
         usage_count  = t.usage_count + 1,
         last_used_at = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN INSERT (alias_name, domain_id, usage_count, last_used_at)
         VALUES (s.alias_name, ${domainLiteral}, 1, SYSUTCDATETIME());`,
      batch,
    );
  }

  for (let i = 0; i < names.length; i += NAME_BATCH) {
    const batch = names.slice(i, i + NAME_BATCH);
    const inPlaceholders = batch.map(() => '?').join(', ');
    const rows = await exec(
      conn,
      `SELECT alias_name, alias_id FROM ${internalTable('APPROVED_ALIAS_NAMES')}
       WHERE alias_name IN (${inPlaceholders}) ${selectFilter}`,
      batch,
    );
    for (const r of rows) {
      const name = String(r.alias_name ?? '');
      const id   = Number(r.alias_id ?? 0);
      if (name && id) result.set(name, id);
    }
  }

  for (const name of names) {
    if (!result.has(name)) result.set(name, await upsertApprovedAliasMssql(conn, name, domainId));
  }
  return result;
}

/** Bulk-upsert literal → alias mappings. Callers must have deduped entries on
 *  normalizeLiteral (same contract as the Snowflake version); normalized_value
 *  is computed here app-side and both stored and used as the match key. */
export async function bulkUpsertLiteralMatchesMssql(
  conn:     any,
  entries:  Array<{ literalValue: string; aliasId: number }>,
  domainId: number | null,
  runId:    number,
): Promise<void> {
  if (entries.length === 0) return;

  const domainFilter  = domainId != null ? `AND t.domain_id = ${Number(domainId)}` : `AND t.domain_id IS NULL`;
  const domainLiteral = domainId != null ? String(Number(domainId)) : 'NULL';

  for (let i = 0; i < entries.length; i += MATCH_BATCH) {
    const batch = entries.slice(i, i + MATCH_BATCH);
    const valuesRows = batch.map(() => '(?, ?, ?, ?)').join(', ');
    const binds: any[] = batch.flatMap(e => [
      e.literalValue,
      normalizeLiteral(e.literalValue),
      e.aliasId,
      runId,
    ]);
    await exec(
      conn,
      `MERGE ${internalTable('LITERAL_ALIAS_MATCHES')} WITH (HOLDLOCK) AS t
       USING (VALUES ${valuesRows}) AS s (literal_value, normalized_value, alias_id, run_id)
         ON t.normalized_value = s.normalized_value ${domainFilter}
       WHEN MATCHED THEN UPDATE SET
         alias_id     = s.alias_id,
         run_id       = s.run_id,
         confirmed_at = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN INSERT (literal_value, normalized_value, alias_id, domain_id, run_id, confirmed_at)
         VALUES (s.literal_value, s.normalized_value, s.alias_id, ${domainLiteral}, s.run_id, SYSUTCDATETIME());`,
      binds,
    );
  }
}
