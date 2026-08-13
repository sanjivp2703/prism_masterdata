/* eslint-disable @typescript-eslint/no-explicit-any --
   driver rows are untyped by nature (see ../types.ts). */
// PostgreSQL implementations of the lookup write path — the ON CONFLICT
// counterparts of op-export.ts's Snowflake MERGEs and mssql/mappings.ts
// (docs/POSTGRES_PORT_PLAN.md Phase P3).
//
// Differences from the other warehouses, all deliberate:
//  * normalized_value is computed APP-SIDE (normalizeLiteral) — no SQL-side
//    normalize function (plan decision 2.3).
//  * Upserts are INSERT … ON CONFLICT (works on the Postgres 13+ floor;
//    MERGE arrived in 15) against the unique indexes the install script
//    creates. The NULL-domain (scopeless) case targets the partial indexes —
//    Postgres unique constraints treat NULLs as distinct.
//  * RETURNING collapses the mssql upsert-then-select round trip.
//  * Batches use the Snowflake-sized 5,000-row budget (~65k bind ceiling).
import 'server-only';

import { normalizeLiteral } from '../../normalize';
import { executeQuery as exec } from './connection';

const NAME_BATCH = 5_000;   // 1 bind per name
const MATCH_BATCH = 5_000;  // 4 binds per entry → 20k binds

function aliasConflictTarget(domainId: number | null): string {
  return domainId != null
    ? `(alias_name, domain_id)`
    : `(alias_name) WHERE domain_id IS NULL`;
}

export async function upsertApprovedAliasPg(
  conn:      any,
  aliasName: string,
  domainId:  number | null,
): Promise<number> {
  const domainLiteral = domainId != null ? String(Number(domainId)) : 'NULL';
  const rows = await exec(
    conn,
    `INSERT INTO prism_internal.approved_alias_names (alias_name, domain_id, usage_count, last_used_at)
     VALUES (?, ${domainLiteral}, 1, now())
     ON CONFLICT ${aliasConflictTarget(domainId)} DO UPDATE SET
       usage_count  = prism_internal.approved_alias_names.usage_count + 1,
       last_used_at = now()
     RETURNING alias_id`,
    [aliasName],
  );
  const aliasId = Number(rows[0]?.alias_id ?? 0);
  if (!aliasId) throw new Error(`[postgres/mappings] Could not retrieve alias_id for "${aliasName}"`);
  return aliasId;
}

export async function bulkUpsertApprovedAliasesPg(
  conn:       any,
  aliasNames: string[],
  domainId:   number | null,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const names  = Array.from(new Set(aliasNames)).filter((n) => n != null && n !== '');
  if (names.length === 0) return result;

  const domainLiteral = domainId != null ? String(Number(domainId)) : 'NULL';
  for (let i = 0; i < names.length; i += NAME_BATCH) {
    const batch = names.slice(i, i + NAME_BATCH);
    const valuesRows = batch.map(() => `(?, ${domainLiteral}, 1, now())`).join(', ');
    const rows = await exec(
      conn,
      `INSERT INTO prism_internal.approved_alias_names (alias_name, domain_id, usage_count, last_used_at)
       VALUES ${valuesRows}
       ON CONFLICT ${aliasConflictTarget(domainId)} DO UPDATE SET
         usage_count  = prism_internal.approved_alias_names.usage_count + 1,
         last_used_at = now()
       RETURNING alias_name, alias_id`,
      batch,
    );
    for (const r of rows) {
      const name = String(r.alias_name ?? '');
      const id   = Number(r.alias_id ?? 0);
      if (name && id) result.set(name, id);
    }
  }

  // RETURNING covers every input row (insert AND update paths), so the map is
  // complete; the safety sweep mirrors the mssql version anyway.
  for (const name of names) {
    if (!result.has(name)) result.set(name, await upsertApprovedAliasPg(conn, name, domainId));
  }
  return result;
}

/** Bulk-upsert literal → alias mappings. Callers must have deduped entries on
 *  normalizeLiteral (same contract as every other warehouse — an in-batch
 *  duplicate normalized value would raise "cannot affect row a second time");
 *  normalized_value is computed here app-side and is the conflict key. */
export async function bulkUpsertLiteralMatchesPg(
  conn:     any,
  entries:  Array<{ literalValue: string; aliasId: number }>,
  domainId: number | null,
  runId:    number,
): Promise<void> {
  if (entries.length === 0) return;

  const domainLiteral = domainId != null ? String(Number(domainId)) : 'NULL';
  const conflictTarget = domainId != null
    ? `(normalized_value, domain_id)`
    : `(normalized_value) WHERE domain_id IS NULL`;

  for (let i = 0; i < entries.length; i += MATCH_BATCH) {
    const batch = entries.slice(i, i + MATCH_BATCH);
    const valuesRows = batch.map(() => `(?, ?, ?, ${domainLiteral}, ?, now())`).join(', ');
    const binds: any[] = batch.flatMap(e => [
      e.literalValue,
      normalizeLiteral(e.literalValue),
      e.aliasId,
      runId,
    ]);
    await exec(
      conn,
      `INSERT INTO prism_internal.literal_alias_matches
         (literal_value, normalized_value, alias_id, domain_id, run_id, confirmed_at)
       VALUES ${valuesRows}
       ON CONFLICT ${conflictTarget} DO UPDATE SET
         alias_id     = EXCLUDED.alias_id,
         run_id       = EXCLUDED.run_id,
         confirmed_at = now()`,
      binds,
    );
  }
}
