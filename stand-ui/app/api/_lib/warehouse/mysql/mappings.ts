/* eslint-disable @typescript-eslint/no-explicit-any --
   driver rows are untyped by nature (see ../types.ts). */
// MySQL implementations of the lookup write path — the ON DUPLICATE KEY
// counterparts of op-export.ts's Snowflake MERGEs (docs/MYSQL_PORT_PLAN.md
// Phase M3).
//
// Differences from the other warehouses, all deliberate:
//  * normalized_value is computed APP-SIDE (normalizeLiteral) — no SQL-side
//    normalize function (plan decision 2.3).
//  * Upserts are INSERT … ON DUPLICATE KEY UPDATE with the 8.0.19+ row-alias
//    form (`VALUES()` is removed in MySQL 8.4). The conflict targets are the
//    functional unique keys the install script creates:
//    (COALESCE(domain_id,-1), alias_name) and
//    (COALESCE(domain_id,-1), SHA2(normalized_value,256)).
//  * MySQL has NO RETURNING — the alias-id map uses the mssql pattern
//    (upsert the batch, then SELECT the ids back), not pg's RETURNING.
import 'server-only';

import { normalizeLiteral } from '../../normalize';
import { executeQuery as exec } from './connection';

const NAME_BATCH = 5_000;   // 1 bind per name (client-side interpolation)
const MATCH_BATCH = 5_000;  // 4 binds per entry

export async function upsertApprovedAliasMysql(
  conn:      any,
  aliasName: string,
  domainId:  number | null,
): Promise<number> {
  const domainLiteral = domainId != null ? String(Number(domainId)) : 'NULL';
  const selectFilter  = domainId != null ? `AND domain_id = ${Number(domainId)}` : `AND domain_id IS NULL`;

  await exec(
    conn,
    `INSERT INTO prism_internal.approved_alias_names (alias_name, domain_id, usage_count, last_used_at)
     VALUES (?, ${domainLiteral}, 1, NOW(3))
     ON DUPLICATE KEY UPDATE
       usage_count  = usage_count + 1,
       last_used_at = NOW(3)`,
    [aliasName],
  );

  const rows = await exec(
    conn,
    `SELECT alias_id FROM prism_internal.approved_alias_names WHERE alias_name = ? ${selectFilter}`,
    [aliasName],
  );
  const aliasId = Number(rows[0]?.alias_id ?? 0);
  if (!aliasId) throw new Error(`[mysql/mappings] Could not retrieve alias_id for "${aliasName}"`);
  return aliasId;
}

export async function bulkUpsertApprovedAliasesMysql(
  conn:       any,
  aliasNames: string[],
  domainId:   number | null,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const names  = Array.from(new Set(aliasNames)).filter((n) => n != null && n !== '');
  if (names.length === 0) return result;

  const domainLiteral = domainId != null ? String(Number(domainId)) : 'NULL';
  const selectFilter  = domainId != null ? `AND domain_id = ${Number(domainId)}` : `AND domain_id IS NULL`;

  for (let i = 0; i < names.length; i += NAME_BATCH) {
    const batch = names.slice(i, i + NAME_BATCH);
    const valuesRows = batch.map(() => `(?, ${domainLiteral}, 1, NOW(3))`).join(', ');
    await exec(
      conn,
      `INSERT INTO prism_internal.approved_alias_names (alias_name, domain_id, usage_count, last_used_at)
       VALUES ${valuesRows} AS new_rows
       ON DUPLICATE KEY UPDATE
         usage_count  = prism_internal.approved_alias_names.usage_count + 1,
         last_used_at = new_rows.last_used_at`,
      batch,
    );
  }

  // No RETURNING on MySQL — select the ids back (mssql pattern).
  for (let i = 0; i < names.length; i += NAME_BATCH) {
    const batch = names.slice(i, i + NAME_BATCH);
    const inPlaceholders = batch.map(() => '?').join(', ');
    const rows = await exec(
      conn,
      `SELECT alias_name, alias_id FROM prism_internal.approved_alias_names
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
    if (!result.has(name)) result.set(name, await upsertApprovedAliasMysql(conn, name, domainId));
  }
  return result;
}

/** Bulk-upsert literal → alias mappings. Callers must have deduped entries on
 *  normalizeLiteral (same contract everywhere); normalized_value is computed
 *  here app-side and — via its SHA2 functional key — is the conflict target. */
export async function bulkUpsertLiteralMatchesMysql(
  conn:     any,
  entries:  Array<{ literalValue: string; aliasId: number }>,
  domainId: number | null,
  runId:    number,
): Promise<void> {
  if (entries.length === 0) return;

  const domainLiteral = domainId != null ? String(Number(domainId)) : 'NULL';

  for (let i = 0; i < entries.length; i += MATCH_BATCH) {
    const batch = entries.slice(i, i + MATCH_BATCH);
    const valuesRows = batch.map(() => `(?, ?, ?, ${domainLiteral}, ?, NOW(3))`).join(', ');
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
       VALUES ${valuesRows} AS new_rows
       ON DUPLICATE KEY UPDATE
         alias_id     = new_rows.alias_id,
         run_id       = new_rows.run_id,
         confirmed_at = NOW(3)`,
      binds,
    );
  }
}
