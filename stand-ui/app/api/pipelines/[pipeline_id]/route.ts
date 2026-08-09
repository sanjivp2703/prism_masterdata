/**
 * PATCH  /api/pipelines/[pipeline_id]  — update status / poll stats / name
 * DELETE /api/pipelines/[pipeline_id]  — remove pipeline
 */

import { cookies } from 'next/headers';
import { withWarehouse, warehouseErrorResponse, executeQuery as exec, getWarehouseAdapter } from '@/app/api/_lib/warehouse';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getDb } from '@/app/api/_lib/sqlite';
import { dropPipelineStream } from '@/app/api/_lib/pipeline-poller';
import { refreshExportTable, columnModeSetupSql } from '@/app/api/_lib/export-table';
import { tableModeSetupSql } from '@/app/api/_lib/warehouse/mssql/export';
import { asUpdateSchedule, serializeUpdateSchedule } from '@/app/api/_lib/update-schedule';
import { type ExportKind, asExportKind } from '@/app/api/_lib/export-kind';
import { reconcilePipelineQueue } from '@/app/api/_lib/pipeline-hourly-processor';
import { flagPipelineMessage } from '@/app/api/_lib/pipeline-alerts';

/**
 * PATCH /api/pipelines/[pipeline_id]
 * Partial update. Accepts any subset of:
 *   { status, name, update_schedule, export_table_fqn, export_kind, total_new_values, last_polled_at, increment_new_values }
 *
 * increment_new_values: number — adds to the running total rather than setting it
 * last_polled_at: ISO string | 'now' (default when status changes to 'active')
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ pipeline_id: string }> },
) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  const { pipeline_id } = await params;
  const pid = Number(pipeline_id);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Response.json({ error: 'Invalid pipeline_id' }, { status: 400 });
  }

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const setClauses: string[]  = [];
  const binds:      any[]     = [];

  if (body?.name !== undefined) {
    setClauses.push('name = ?');
    binds.push(body.name ? String(body.name).trim() : null);
  }
  if (body?.update_schedule !== undefined) {
    const schedule = asUpdateSchedule(body.update_schedule);
    if (!schedule) {
      return Response.json({ error: 'Invalid update_schedule' }, { status: 400 });
    }
    setClauses.push('update_schedule = ?');
    binds.push(serializeUpdateSchedule(schedule));
  }
  if (body?.export_table_fqn !== undefined) {
    setClauses.push('export_table_fqn = ?');
    binds.push(body.export_table_fqn ? String(body.export_table_fqn).trim() : null);
  }
  if (body?.export_kind !== undefined && ['table', 'view', 'column'].includes(body.export_kind)) {
    // A pipeline may NOT be switched into Column mode here.
    //
    // Column mode is the one output kind that writes to the customer's own
    // source table, and POST /api/pipelines gates it behind three things:
    // an explicit `column_write_consent: true`, the companion-name conflict
    // guard (assertCompanionColumnAvailable), and per-table access
    // provisioning run with the creator's own credentials. This PATCH had
    // none of them — it just wrote the column straight into the row.
    //
    // Live-proven during the PRELAUNCH §1 run: a table pipeline was PATCHed to
    // export_kind='column' having never sent column_write_consent, and Prism
    // then performed ALTER TABLE … ADD COLUMN on the source table. Existing
    // data survived (the "never modify another column" promise held), but the
    // CONSENT promise did not. The route is requireValidSession, so any
    // authenticated user could do it; no UI path sends export_kind on PATCH,
    // so this was API-only and invisible to normal use.
    //
    // The only thing that stopped it going further on a real customer install
    // is warehouse default-deny — the exact property this checklist has NOT
    // yet been able to verify on Snowflake. Relying on it is precisely the
    // assumption the checklist exists to remove.
    //
    // Switching AWAY from column mode is allowed: it stops Prism writing to
    // the source and leaves the companion column in place for the customer to
    // drop (Prism must never drop a column it cannot prove it owns).
    const currentKind = asExportKind(
      (getDb().prepare(`SELECT export_kind FROM pipelines WHERE pipeline_id = ?`).get(pid) as any)?.export_kind,
    );
    if (body.export_kind === 'column' && currentKind !== 'column') {
      return Response.json(
        {
          error:
            'A pipeline cannot be switched to Column output after creation. Column mode writes a ' +
            'standardized column onto your source table, so it requires the explicit consent step ' +
            'and per-table access setup that only the create flow performs. Create a new ' +
            'column-mode pipeline for this column instead.',
          code: 'column_mode_requires_creation',
        },
        { status: 400 },
      );
    }
    setClauses.push('export_kind = ?');
    binds.push(body.export_kind);
  }
  // Editable post-creation from the card's Settings tab. The stored value only
  // shapes the NEXT export build — the client triggers one refresh-export after
  // saving so the change lands immediately (for views that recreates the view).
  if (body?.export_unmapped_rows !== undefined) {
    setClauses.push('export_unmapped_rows = ?');
    binds.push(body.export_unmapped_rows === true ? 1 : 0);
  }
  if (body?.status !== undefined && ['active', 'paused', 'pending_baseline'].includes(body.status)) {
    setClauses.push('status = ?');
    binds.push(body.status);
    // Resuming clears any block reason; the next healthy poll would clear it too,
    // but doing it here avoids showing a stale message in the gap before that poll.
    if (body.status === 'active') {
      setClauses.push('status_message = NULL');
      // Reset stale mssql detection bookkeeping (no-op for Snowflake pipelines,
      // where these columns are already NULL). A pause can be caused by the
      // source table having been dropped; if it was recreated before resuming,
      // any stored ct_version/diff state still refers to the OLD object and
      // would otherwise cause an avoidable extra error/self-heal cycle on the
      // next poll. Forcing initDetection() to re-run fresh is cheap either way.
      setClauses.push('detection_mode = NULL');
      setClauses.push('detection_state = NULL');
      // Automatically stamp last_polled_at when transitioning to active
      if (body?.last_polled_at === undefined) {
        setClauses.push(`last_polled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
      }
    }
  }
  if (body?.last_polled_at !== undefined) {
    setClauses.push(`last_polled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  }
  if (body?.clear_queue === true) {
    setClauses.push('queue_size = 0');
    setClauses.push(`last_queue_empty_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  }
  if (typeof body?.increment_new_values === 'number' && body.increment_new_values > 0) {
    setClauses.push(`total_new_values = total_new_values + ${Math.floor(body.increment_new_values)}`);
    setClauses.push(`queue_size = queue_size + ${Math.floor(body.increment_new_values)}`);
  } else if (typeof body?.total_new_values === 'number') {
    setClauses.push('total_new_values = ?');
    binds.push(Math.max(0, Math.floor(body.total_new_values)));
  }

  if (setClauses.length === 0) {
    return Response.json({ error: 'No fields to update' }, { status: 400 });
  }

  setClauses.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  binds.push(pid);

  const activating = body?.status === 'active';

  interface PipelineRef {
    table_fqn:        string;
    column_name:      string;
    export_table_fqn: string | null;
    export_kind:      ExportKind;
    domain_id:        number | null;
  }

  try {
    const { httpResponse, pfe } = await (async () => {
      getDb()
        .prepare(`UPDATE pipelines SET ${setClauses.join(', ')} WHERE pipeline_id = ?`)
        .run(...binds);

      let pfe: PipelineRef | null = null;
      if (activating) {
        const r = getDb()
          .prepare(
            `SELECT table_fqn, column_name, export_table_fqn, export_kind, domain_id
             FROM pipelines WHERE pipeline_id = ?`,
          )
          .get(pid) as any;
        if (r) {
          pfe = {
            table_fqn:        String(r.table_fqn        ?? ''),
            column_name:      String(r.column_name      ?? ''),
            export_table_fqn: r.export_table_fqn ?? null,
            export_kind:      asExportKind(r.export_kind),
            domain_id:        r.domain_id != null ? Number(r.domain_id) : null,
          };
        }
      }

      return { httpResponse: Response.json({ ok: true }), pfe };
    })();

    // Refresh the export object fire-and-forget when the pipeline is re-activated.
    // For a view this (re)creates it (cheap, metadata-only); it never needs the
    // periodic rebuild a table does. Because activation is a VIEW's ONLY
    // creation point (the poller/tick deliberately skip views), a failure here
    // must not stay silent — flag it on the card so the user knows the view
    // doesn't exist and can repair it ("Recreate view now" in Settings).
    if (pfe && pfe.export_table_fqn) {
      const exportRef = pfe;
      refreshExportTable(exportRef.table_fqn, exportRef.column_name, exportRef.export_table_fqn!, exportRef.domain_id, pid, exportRef.export_kind).catch(err => {
        console.error(`[ExportTable] Background refresh failed for pipeline ${pid}:`, err);
        // Curated messages (thrown by the column-mode sync) carry the exact fix
        // SQL — show them as-is. Anything else gets a per-kind message with the
        // likely fix, never raw driver text.
        const curated = err instanceof Error && err.message.startsWith('Prism ') ? err.message : null;
        // Name the exact schema in the fix SQL so the admin can copy-paste it.
        const isMssql   = getWarehouseAdapter().kind === 'mssql';
        const expParts  = String(exportRef.export_table_fqn ?? '').split('.');
        const [expDb, expSch] = expParts.length === 3 ? [expParts[0], expParts[1]] : ['<database>', '<schema>'];
        const expSchema = isMssql ? expSch : `${expDb}.${expSch}`;
        const fallback = exportRef.export_kind === 'view'
          ? (isMssql
              // Views are refused on the mssql adapter — this branch shouldn't
              // fire in practice, but keep a sane message rather than none.
              ? `The export view ${exportRef.export_table_fqn} could not be created. SQL Server exports don't support the View output — switch this pipeline to Table or Column in the card's Settings tab.`
              : `The export view ${exportRef.export_table_fqn} could not be created. Run in Snowflake: GRANT CREATE VIEW ON SCHEMA ${expSchema} TO ROLE PRISM_SERVICE; then use "Recreate view now" in the card's Settings tab.`)
          : exportRef.export_kind === 'column'
          ? (isMssql
              ? `The standardized column(s) on ${exportRef.table_fqn} could not be updated. Run against the SQL Server as a sysadmin: ${columnModeSetupSql(exportRef.table_fqn, exportRef.column_name)} then use "Sync standardized columns now" in the card's Settings tab.`
              : `The standardized column(s) on ${exportRef.table_fqn} could not be updated. Run in Snowflake: GRANT UPDATE ON TABLE ${exportRef.table_fqn} TO ROLE PRISM_SERVICE; then use "Sync standardized columns now" in the card's Settings tab.`)
          : (isMssql
              // Grant to the prism_svc LOGIN directly, not the PRISM_SERVICE
              // ROLE — that role only exists in PRISM_DB; source databases
              // (where a table-mode export usually lives, alongside the
              // source table) only ever get prism_svc granted directly, per
              // Part B's own "for each source database" instructions.
              // Grantee resolved from the CONFIGURED login (KI-61/KI-215) — the
              // wizard's username field only DEFAULTS to prism_svc, and SQL an
              // admin is told to run verbatim must name the login that actually
              // needs the permission.
              ? `The export table ${exportRef.export_table_fqn} could not be built. Run against the SQL Server as a sysadmin: ${tableModeSetupSql(exportRef.export_table_fqn!)} then use "Rebuild export table now" in the card's Settings tab.`
              : `The export table ${exportRef.export_table_fqn} could not be built. Run in Snowflake: GRANT CREATE TABLE ON SCHEMA ${expSchema} TO ROLE PRISM_SERVICE; then use "Rebuild export table now" in the card's Settings tab.`);
        flagPipelineMessage(pid, curated ?? fallback, 'error').catch(() => {});
      });
    }

    // On re-activation, recover any source values that arrived while the
    // pipeline was paused.  The APPEND_ONLY stream may have gone stale (and be
    // recreated empty) over a long pause, so reconcile from the source table
    // directly instead of waiting for the next hourly sweep.  Fire-and-forget.
    if (pfe) {
      reconcilePipelineQueue({
        pipeline_id: pid,
        table_fqn:   pfe.table_fqn,
        column_name: pfe.column_name,
        domain_id:   pfe.domain_id,
      }).catch(err => {
        console.error(`[Reconcile] Reactivation reconcile failed for pipeline ${pid}:`, err);
      });
    }

    return httpResponse;
  } catch (err) {
    return warehouseErrorResponse(err, 'Failed to update pipeline');
  }
}

/**
 * DELETE /api/pipelines/[pipeline_id]
 * Permanently removes the pipeline record. Auth required.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ pipeline_id: string }> },
) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  const { pipeline_id } = await params;
  const pid = Number(pipeline_id);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Response.json({ error: 'Invalid pipeline_id' }, { status: 400 });
  }

  try {
    const response = (() => {
      // For Sheets pipelines: all columns for the same tab share the same
      // table_fqn (created in one batch). Delete all siblings so the per-tab
      // duplicate check doesn't block re-creation after a delete.
      const db = getDb();
      const fqnRow = db
        .prepare(`SELECT table_fqn, source_type FROM pipelines WHERE pipeline_id = ?`)
        .get(pid) as any;
      const fqn        = String(fqnRow?.table_fqn ?? '');
      const sourceType = String(fqnRow?.source_type ?? '');
      // Collect the pipeline_ids we're about to delete so their per-column specs
      // go with them. (Sheets: all columns for the tab share one table_fqn.)
      // The columns' confirmed lookup rows (scoped by spec_id) are left in
      // Snowflake — an orphaned spec_id is never joined again, so it's harmless
      // and non-destructive; hard-deleting them would be a separate opt-in.
      const pidRows = fqn && sourceType === 'sheets'
        ? db.prepare(`SELECT pipeline_id FROM pipelines WHERE table_fqn = ?`).all(fqn) as any[]
        : [{ pipeline_id: pid }];
      const pids = pidRows.map(r => Number(r.pipeline_id));
      if (pids.length > 0) {
        const ph = pids.map(() => '?').join(', ');
        db.prepare(`DELETE FROM column_specs WHERE pipeline_id IN (${ph})`).run(...pids);
        db.prepare(`DELETE FROM pipelines WHERE pipeline_id IN (${ph})`).run(...pids);
      }
      return Response.json({ ok: true });
    })();

    dropPipelineStream(pid);

    return response;
  } catch (err) {
    return warehouseErrorResponse(err, 'Failed to delete pipeline');
  }
}
