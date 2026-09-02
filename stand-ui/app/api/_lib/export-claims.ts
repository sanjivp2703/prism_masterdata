import 'server-only';

import { getDb } from './sqlite';

/**
 * Who already writes to an export destination.
 *
 * An export table is REPLACED on every rebuild, from one source. Two
 * different sources aimed at the same destination therefore overwrite each
 * other forever, silently — both pipelines look healthy, and a one-time
 * export sitting at that name is destroyed by the first pipeline rebuild
 * (live-found 2026-08-18, client-sim E4).
 *
 * Columns of the SAME source table sharing one export table is the
 * documented multi-column design and is NOT a conflict. Likewise (owner
 * decision 2026-09-01) a pipeline may claim a one-time result built from the
 * SAME source table — that is the natural "clean once, then keep it fresh"
 * promotion, and the pipeline's rebuild reproduces the same content. Only a
 * DIFFERENT source aiming at the name is refused.
 *
 * Comparison is case-insensitive: SQL Server and Snowflake both resolve
 * unquoted identifiers case-insensitively, so DBO.T and dbo.t are one table.
 */
export function findExportClaim(
  exportFqn: string,
  forSourceTable: string,
  opts: { ignorePipelineId?: number } = {},
): { kind: 'pipeline' | 'one_time'; owner: string } | null {
  const target = exportFqn.trim().toUpperCase();
  if (!target) return null;
  const mySource = forSourceTable.trim().toUpperCase();

  const pipes = getDb()
    .prepare(
      `SELECT pipeline_id, table_fqn FROM pipelines
       WHERE export_table_fqn IS NOT NULL AND UPPER(TRIM(export_table_fqn)) = ?`,
    )
    .all(target) as Array<{ pipeline_id: number; table_fqn: string }>;
  for (const row of pipes) {
    if (opts.ignorePipelineId != null && Number(row.pipeline_id) === opts.ignorePipelineId) continue;
    if (String(row.table_fqn ?? '').trim().toUpperCase() === mySource) continue; // sibling column — fine
    return { kind: 'pipeline', owner: String(row.table_fqn ?? '') };
  }

  const ots = getDb()
    .prepare(
      `SELECT source_relation FROM one_time_standardizations
       WHERE export_target IS NOT NULL AND UPPER(TRIM(export_target)) = ?`,
    )
    .all(target) as Array<{ source_relation?: string }>;
  for (const row of ots) {
    // Same source → the pipeline is the promotion of that one-time result; fine.
    if (String(row.source_relation ?? '').trim().toUpperCase() === mySource) continue;
    return { kind: 'one_time', owner: String(row.source_relation ?? 'a one-time standardization') };
  }

  return null;
}

/** The message shown when a claim is found — says who owns it and what to do. */
export function exportClaimError(
  exportFqn: string,
  claim: { kind: 'pipeline' | 'one_time'; owner: string },
): string {
  return claim.kind === 'pipeline'
    ? `${exportFqn} is already the standardized output of ${claim.owner}. Prism rebuilds an ` +
      `output table by replacing it entirely, so two different source tables writing there would ` +
      `overwrite each other. Choose a different output table name.`
    : `${exportFqn} was created by a one-time standardization of ${claim.owner}. A pipeline ` +
      `rebuilds its output table by replacing it entirely, which would destroy that result. ` +
      `Choose a different output table name.`;
}
