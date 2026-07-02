/**
 * POST /api/pipelines/setup
 *
 * Creates a pipeline and completes all initial setup before making it visible:
 *   1. Insert pipeline with status='initializing' (hidden from GET /api/pipelines)
 *   2. Fetch all distinct values from the source column
 *   3. Run baseline standardization (literal lookup + LLM grouping)
 *   4. Export mappings to LITERAL_ALIAS_MATCHES / APPROVED_ALIAS_NAMES
 *   5. Build the export table
 *   6. Compute and store metrics (total_source_values, total_mapped)
 *   7. Set status to 'active' — pipeline is now visible and the poller picks it up
 *
 * Body: { table_fqn, column_name, domain_id?, name?, mode?, export_table_fqn }
 */

import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { premiumModeGuard } from '@/app/api/_lib/feature-flags';
import { createRunFromQueue } from '@/app/api/_lib/pipeline-hourly-processor';
import { runAutoGroupForRun } from '@/app/api/_lib/op-auto-group-run';
import { runOpExportDirect } from '@/app/api/_lib/op-export';
import { refreshExportTable, updatePipelineMappedCount } from '@/app/api/_lib/export-table';
import { loadOpRunState } from '@/app/api/_lib/op-auto-group';
import { initBaseline } from '@/app/api/_lib/auto-export-seen';
import { row2pipeline, PIPELINE_SELECT } from '../route';
import { broadcastPipelineEvent } from '@/app/api/_lib/pipeline-broadcaster';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

function quoteIdent(ident: string): string {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const session = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const modeBlocked = premiumModeGuard();
  if (modeBlocked) return modeBlocked;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Response.json({ error: 'ANTHROPIC_API_KEY is not configured.' }, { status: 500 });

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const table_fqn        = String(body?.table_fqn ?? '').trim();
  const column_name      = String(body?.column_name ?? '').trim();
  const export_table_fqn = body?.export_table_fqn ? String(body.export_table_fqn).trim() : null;
  const domain_id        = body?.domain_id != null ? Number(body.domain_id) : null;
  const name             = body?.name ? String(body.name).trim() : null;
  const mode             = ['auto', 'manual'].includes(body?.mode) ? String(body.mode) : 'auto';

  if (!table_fqn)   return Response.json({ error: 'table_fqn is required' }, { status: 400 });
  if (!column_name) return Response.json({ error: 'column_name is required' }, { status: 400 });
  // Domain is mandatory — every pipeline must be scoped to a domain.
  if (domain_id == null || !Number.isFinite(domain_id)) {
    return Response.json({ error: 'domain_id is required — a pipeline must belong to a domain.' }, { status: 400 });
  }

  try {
    return await withSnowflake(async (conn) => {
      const domainFilter = domain_id != null
        ? `AND domain_id = ${Number(domain_id)}`
        : `AND domain_id IS NULL`;
      const pDomainFilter = domain_id != null
        ? `AND p.domain_id = ${Number(domain_id)}`
        : `AND p.domain_id IS NULL`;

      // ── Step 1: Create pipeline with status='initializing' ─────────────
      // Block duplicate table+column pairs regardless of domain.
      const duplicate = await exec(conn,
        `SELECT pipeline_id, status FROM STAND_DB.STAND_INTERNAL.PIPELINES
         WHERE table_fqn = ? AND column_name = ? LIMIT 1`,
        [table_fqn, column_name]);

      if (duplicate.length > 0) {
        const dup = duplicate[0] as any;
        const dupStatus = String(dup.STATUS ?? dup.status ?? '');
        if (dupStatus !== 'initializing') {
          return Response.json(
            { error: `A pipeline for ${table_fqn}.${column_name} already exists.` },
            { status: 409 },
          );
        }
        // Stale 'initializing' pipeline — clean it up and proceed.
        const staleId = Number(dup.PIPELINE_ID ?? dup.pipeline_id);
        await exec(conn,
          `DELETE FROM STAND_DB.STAND_INTERNAL.PIPELINES WHERE pipeline_id = ?`,
          [staleId]);
      }

      const existing = await exec(conn,
        `SELECT pipeline_id FROM STAND_DB.STAND_INTERNAL.PIPELINES
         WHERE table_fqn = ? AND column_name = ? ${domainFilter} LIMIT 1`,
        [table_fqn, column_name]);

      let pid: number;
      if (existing.length > 0) {
        pid = Number((existing[0] as any).PIPELINE_ID ?? (existing[0] as any).pipeline_id);
        await exec(conn,
          `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
           SET status = 'initializing', mode = ?, updated_at = CURRENT_TIMESTAMP()
               ${name ? ', name = ?' : ''}
               ${export_table_fqn ? ', export_table_fqn = ?' : ''}
           WHERE pipeline_id = ?`,
          [mode, ...(name ? [name] : []), ...(export_table_fqn ? [export_table_fqn] : []), pid]);
      } else {
        const cols = ['table_fqn', 'column_name', 'status', 'mode', 'created_by'];
        const binds: any[] = [table_fqn, column_name, 'initializing', mode];
        if (name)             { cols.push('name');             binds.push(name); }
        if (export_table_fqn) { cols.push('export_table_fqn'); binds.push(export_table_fqn); }
        if (domain_id != null) {
          cols.push('domain_id');
        }
        const placeholders = cols.map(c => {
          if (c === 'domain_id')  return String(Number(domain_id));
          if (c === 'created_by') return String(Number(session.accountId));
          return '?';
        });
        await exec(conn,
          `INSERT INTO STAND_DB.STAND_INTERNAL.PIPELINES (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`,
          binds);

        const idRows = await exec(conn,
          `SELECT pipeline_id FROM STAND_DB.STAND_INTERNAL.PIPELINES
           WHERE table_fqn = ? AND column_name = ? ${domainFilter} LIMIT 1`,
          [table_fqn, column_name]);
        pid = Number((idRows[0] as any).PIPELINE_ID ?? (idRows[0] as any).pipeline_id);
      }

      // Compute table references once — used by stream creation and the scan below.
      const parts    = table_fqn.split('.');
      const tableRef = parts.map(p => quoteIdent(p.trim())).join('.');
      const colRef   = quoteIdent(column_name);

      // ── Step 2: Pre-create stream BEFORE the source scan ──────────────
      // The stream must exist before we read the source table so there is no
      // gap between what the baseline scan sees and what the stream tracks.
      // Values in the table at scan time  → caught by the baseline scan.
      // Values inserted after this point  → caught by the stream on the next poll.
      // Standard (not APPEND_ONLY) so the poller can also detect deletes/updates.
      // IF NOT EXISTS makes this idempotent for re-setup or retries.
      const streamName = `STAND_DB.STAND_INTERNAL.PIPELINE_STREAM_${pid}`;
      try {
        await exec(conn, `
          CREATE STREAM IF NOT EXISTS ${streamName}
          ON TABLE ${tableRef}`);
        console.log(`[Setup] Pipeline ${pid}: stream pre-created (${streamName})`);
      } catch (streamErr: any) {
        // Non-fatal — the poller will create it on the first cycle if this fails.
        console.warn(`[Setup] Pipeline ${pid}: could not pre-create stream:`, streamErr?.message ?? streamErr);
      }

      // ── Step 3: Fetch source values ────────────────────────────────────
      // Dedup by the NORMALIZED form (casing/whitespace/Unicode variants collapse
      // to one value); ANY_VALUE keeps a representative original for the LLM.
      const sourceRows = await exec(conn,
        `SELECT ANY_VALUE(${colRef}) AS val FROM ${tableRef} WHERE ${colRef} IS NOT NULL
         GROUP BY PRISM_NORMALIZE(TO_VARCHAR(${colRef})) LIMIT 5000`);
      const literals = sourceRows.map((r: any) => String(r.VAL ?? r.val ?? '')).filter(Boolean);

      // Compute total source values
      const [countRow] = await exec(conn,
        `SELECT COUNT(*) AS cnt FROM ${tableRef} WHERE ${colRef} IS NOT NULL`);
      const totalSourceValues = Number(countRow?.CNT ?? countRow?.cnt ?? 0);

      // Seed Redis baseline
      if (literals.length > 0) {
        await initBaseline(table_fqn, column_name, literals);
      }

      // ── Steps 3-4: Baseline standardization ────────────────────────────
      const domainName = domain_id != null
        ? await exec(conn, `SELECT name FROM STAND_DB.STAND_INTERNAL.DOMAINS WHERE domain_id = ?`, [domain_id])
            .then(rows => rows.length > 0 ? String((rows[0] as any).NAME ?? (rows[0] as any).name ?? '') : null)
        : null;

      const pipelineForProcessing = {
        pipeline_id:      pid,
        table_fqn,
        column_name,
        export_table_fqn,
        domain_id,
        domain_name:      domainName,
        status:           'initializing',
        source_type:      'snowflake',
        file_source_meta: null,
        file_export_meta: null,
      };

      let totalMapped = 0;
      if (literals.length > 0) {
        const runId = await createRunFromQueue(conn, pipelineForProcessing, literals);
        await runAutoGroupForRun(conn, runId, apiKey, { writeBreakdown: false });

        const state = await loadOpRunState(conn, runId);
        const exportedLiterals = state?.groups.flatMap(g => g.items.map(gi => gi.literal_value)) ?? [];

        if (exportedLiterals.length > 0) {
          await runOpExportDirect(runId);
        }
      }

      // ── Step 5: Build export table ─────────────────────────────────────
      if (export_table_fqn) {
        const result = await refreshExportTable(table_fqn, column_name, export_table_fqn, domain_id, pid);
        totalMapped = result.rows_written;
      } else {
        // No export table — compute total_mapped from source join
        const [mappedRow] = await exec(conn,
          `SELECT COUNT(*) AS cnt FROM ${tableRef} src
           WHERE src.${colRef} IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
               WHERE lam.normalized_value = PRISM_NORMALIZE(TO_VARCHAR(src.${colRef}))
                 ${domain_id != null ? `AND lam.domain_id = ${Number(domain_id)}` : `AND lam.domain_id IS NULL`}
             )`);
        totalMapped = Number(mappedRow?.CNT ?? mappedRow?.cnt ?? 0);
      }

      // ── Step 6-7: Store metrics and activate ───────────────────────────
      await exec(conn,
        `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
         SET status              = 'active',
             total_source_values = ?,
             total_mapped        = ?,
             last_queue_empty_at = CURRENT_TIMESTAMP(),
             last_polled_at      = CURRENT_TIMESTAMP(),
             updated_at          = CURRENT_TIMESTAMP()
         WHERE pipeline_id = ?`,
        [totalSourceValues, totalMapped, pid]);

      // Fetch the final pipeline row
      const rows = await exec(conn,
        `${PIPELINE_SELECT} WHERE p.pipeline_id = ? LIMIT 1`,
        [pid]);

      if (!rows.length) {
        return Response.json({ error: 'Pipeline setup completed but row could not be retrieved.' }, { status: 500 });
      }

      broadcastPipelineEvent({ type: 'metrics_updated' });

      return Response.json({ pipeline: row2pipeline(rows[0]) }, { status: 201 });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to set up pipeline');
  }
}
