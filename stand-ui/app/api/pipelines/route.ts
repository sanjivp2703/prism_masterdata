/**
 * GET  /api/pipelines  — list all pipelines
 * POST /api/pipelines  — create or upsert a pipeline (+ its per-column spec)
 */

import { cookies } from 'next/headers';
import { withWarehouse, warehouseErrorResponse, executeQuery as exec, getWarehouseAdapter } from '@/app/api/_lib/warehouse';
import { internalTable } from '@/app/api/_lib/warehouse-tables';
import { getDb } from '@/app/api/_lib/sqlite';
import { requireValidSession } from '@/app/api/_lib/account-security';
import {
  refreshExportTable, assertCompanionColumnAvailable, CompanionColumnConflictError, provisionColumnModeAccess, columnModeSetupSql,
  provisionTableModeAccess, checkTableModeAccess, tableModeSetupSql, serviceCanSeeSourceMssql,
  checkColumnModeAccess,
} from '@/app/api/_lib/export-table';
import { flagPipelineMessage } from '@/app/api/_lib/pipeline-alerts';
import { findExportClaim, exportClaimError } from '@/app/api/_lib/export-claims';
import {
  validateSpecBody, insertColumnSpec, updateColumnSpec,
  seedSpecValuesOnConn, setColumnSpecPipeline, deleteColumnSpec,
} from '@/app/api/_lib/column-specs';
import {
  asUpdateSchedule,
  parseStoredSchedule,
  serializeUpdateSchedule,
  DEFAULT_UPDATE_SCHEDULE,
} from '@/app/api/_lib/update-schedule';
import { asExportKind } from '@/app/api/_lib/export-kind';
import { isNativeEdition } from '@/app/api/_lib/edition';
import { probeNativeSourceAccess } from '@/app/api/_lib/native-access';
import { filterPipelineRowsForViewer } from '@/app/api/_lib/native-visibility';

function parseMeta(v: any): Record<string, any> {
  if (typeof v === 'object' && v !== null) return v as Record<string, any>;
  try { return JSON.parse(String(v)); } catch { return {}; }
}

/** parseMeta, but preserves a genuine absence as null instead of {} — callers
 *  distinguish "no file meta" (a warehouse pipeline) from "empty meta". */
function parseMetaOrNull(v: any): Record<string, any> | null {
  if (v == null) return null;
  if (typeof v === 'object') return v as Record<string, any>;
  try { return JSON.parse(String(v)); } catch { return null; }
}

export function row2pipeline(r: any) {
  const rawUnmapped  = r.EXPORT_UNMAPPED_ROWS ?? r.export_unmapped_rows;
  // Coalesce BEFORE the null check — `r.DOMAIN_ID != null ? … : null` silently
  // nulled these for every SQLite row (lowercase keys), which blanked the
  // domain everywhere in the UI after the storage migration.
  const domainIdRaw  = r.DOMAIN_ID  ?? r.domain_id;
  const createdByRaw = r.CREATED_BY ?? r.created_by;
  return {
    pipeline_id:          Number(r.PIPELINE_ID         ?? r.pipeline_id),
    name:                 r.NAME                ?? r.name                ?? null,
    table_fqn:            String(r.TABLE_FQN           ?? r.table_fqn           ?? ''),
    column_name:          String(r.COLUMN_NAME         ?? r.column_name         ?? ''),
    export_table_fqn:     r.EXPORT_TABLE_FQN    ?? r.export_table_fqn    ?? null,
    export_kind:          asExportKind(r.EXPORT_KIND ?? r.export_kind),
    domain_id:            domainIdRaw != null ? Number(domainIdRaw) : null,
    domain_name:          r.DOMAIN_NAME         ?? r.domain_name         ?? null,
    status:               String(r.STATUS              ?? r.status              ?? 'active'),
    status_message:       r.STATUS_MESSAGE      ?? r.status_message      ?? null,
    status_reason:        r.STATUS_REASON       ?? r.status_reason       ?? null,
    update_schedule:      parseStoredSchedule(r.UPDATE_SCHEDULE ?? r.update_schedule),
    export_unmapped_rows: rawUnmapped !== false && rawUnmapped !== 'false' && rawUnmapped !== 0,
    queue_size:           Number(r.QUEUE_SIZE          ?? r.queue_size          ?? 0),
    total_new_values:     Number(r.TOTAL_NEW_VALUES     ?? r.total_new_values    ?? 0),
    last_polled_at:       r.LAST_POLLED_AT      ?? r.last_polled_at      ?? null,
    last_queue_empty_at:  r.LAST_QUEUE_EMPTY_AT ?? r.last_queue_empty_at ?? null,
    fully_synced_at:      r.FULLY_SYNCED_AT     ?? r.fully_synced_at     ?? null,
    created_by:           createdByRaw != null ? Number(createdByRaw) : null,
    created_at:           r.CREATED_AT          ?? r.created_at          ?? null,
    updated_at:           r.UPDATED_AT          ?? r.updated_at          ?? null,
    total_mapped:         Number(r.TOTAL_MAPPED         ?? r.total_mapped         ?? 0),
    total_source_values:  Number(r.TOTAL_SOURCE_VALUES  ?? r.total_source_values  ?? 0),
    // Change-detection mode (SQL Server port Phase 4): 'stream' (Snowflake),
    // 'ct' (Change Tracking) or 'diff' (tiered scan). detection_reason carries
    // the diff-mode cause for the UI upgrade nudge
    // ('no_pk' | 'ct_disabled' | 'ct_no_grant' | 'ct_error').
    detection_mode:       r.DETECTION_MODE      ?? r.detection_mode      ?? null,
    detection_reason:     parseDetectionReason(r.DETECTION_STATE ?? r.detection_state),
  };
}

function parseDetectionReason(stateJson: unknown): string | null {
  if (!stateJson) return null;
  try {
    const s = JSON.parse(String(stateJson));
    return s?.diff_reason ?? null;
  } catch {
    return null;
  }
}

// Domains were removed 2026-07-15, so `pipelines` has no domain_name column and
// a bare `SELECT p.*` left domain_name null for EVERY pipeline. Three consumers
// still read it (PipelinesView -> ExportLookupModal -> the lookup-export route),
// so every Sheets lookup export was titled with the null fallback "Global
// Standardizations", and — worse — every Snowflake lookup export defaulted to
// the SAME table, PRISM_DB.PUBLIC.GLOBAL_CANONICAL_MAPPINGS, so exporting a
// second spec silently overwrote the first.
//
// The display name now lives on the column spec, so resolve it from there:
// column_specs.spec_id is what the historically-named pipelines.domain_id slot
// actually holds (see CLAUDE.md "THE NAMING TRAP").
export const PIPELINE_SELECT = `SELECT p.*, cs.column_name AS domain_name
  FROM pipelines p
  LEFT JOIN column_specs cs ON cs.spec_id = p.domain_id`;

/**
 * GET /api/pipelines
 * Returns all pipelines. The per-column spec metadata (description / rules /
 * naming convention) is fetched separately by the client via /api/column-specs
 * keyed on the pipeline's `domain_id` slot (= spec_id); no domain name exists.
 */
export async function GET() {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;

  try {
    {
      const rows = getDb()
        .prepare(
          `${PIPELINE_SELECT}
           WHERE p.status != 'initializing'
           ORDER BY
             p.last_polled_at IS NULL,
             p.last_polled_at DESC,
             p.created_at     DESC`,
        )
        .all() as any[];
      // Native edition: scope the list to the viewer (creator + RBAC-readable
      // sources + file uploads). Standard edition passes through untouched.
      const visibleRows = await filterPipelineRowsForViewer(auth.accountId, rows);
      const pipelines = visibleRows.map(row2pipeline);

      // Expand multi-column Sheets pipelines into virtual per-column entries.
      // Each virtual entry shares the same pipeline_id but has a distinct
      // column_name / domain_id (= spec_id), so PipelinesView can render each
      // column in one card while groupKeyFor maps them all to the same key.

      // No virtual expansion any more: one pipeline row is one column. The
      // expansion existed because a Sheets pipeline packed every standardized
      // column of a tab into ONE row (file_source_meta.columns) and the UI had
      // to fan it back out. Warehouse pipelines have always been one row per
      // column.
      const expanded = pipelines;

      return Response.json({ pipelines: expanded });
    }
  } catch (err) {
    console.error('[pipelines] list failed:', err);
    return Response.json({ error: 'Failed to fetch pipelines' }, { status: 500 });
  }
}

/**
 * POST /api/pipelines
 * Body: { table_fqn, column_name, domain_id?, name?, status?, update_schedule?, export_table_fqn?, export_kind? }
 *
 * Upserts on the unique key (table_fqn, column_name, domain_id).
 * Returns the pipeline row (created or existing, with updated status).
 */
export async function POST(request: Request) {
  const auth = await requireValidSession();
  if (auth instanceof Response) return auth;
  const session = auth;

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const table_fqn           = String(body?.table_fqn        ?? '').trim();
  const column_name         = String(body?.column_name       ?? '').trim();
  // Only meaningful when export_table_fqn is set — 'table' (materialized copy,
  // rebuilt each pass), 'view' (live, created once), or 'column' (standardized
  // companion column maintained on the source table itself).
  const export_kind         = asExportKind(body?.export_kind);
  // Native edition: the Marketplace install grants a single read-only
  // reference on source tables, so column mode (which needs UPDATE on the
  // consumer's table) is not offered. The UI hides the option; this is the
  // real gate.
  if (export_kind === 'column' && isNativeEdition()) {
    return Response.json(
      { error: 'The Column output is not available in the Snowflake Native App edition — Prism only reads your tables. Choose Table, View, or Lookup table instead.' },
      { status: 400 },
    );
  }
  // Column mode's destination IS the source table — set server-side so all
  // rebuild triggers (keyed on export_table_fqn) fire for it, regardless of
  // what the client sent.
  const export_table_fqn    = export_kind === 'column'
    ? table_fqn
    : (body?.export_table_fqn ? String(body.export_table_fqn).trim() : null);
  const name                = body?.name ? String(body.name).trim() : null;
  // Update time window — when Prism may auto-standardize. Defaults to
  // business hours (Mon–Fri, 9 AM–5 PM) when the client doesn't send one.
  const update_schedule     = asUpdateSchedule(body?.update_schedule) ?? DEFAULT_UPDATE_SCHEDULE;
  // Default OFF — only rows with a confirmed standardization appear in the
  // export unless the creator explicitly opts in to raw passthrough.
  const export_unmapped_rows = body?.export_unmapped_rows === true;
  const status              = ['active', 'paused', 'pending_baseline'].includes(body?.status)
    ? String(body.status)
    : 'active';
  // SQL Server only — explicit consent before Prism attempts to enable Change
  // Tracking automatically (ALTER DATABASE/ALTER TABLE), set only after the
  // client shows the disclosure. Default false: no consent, no DDL attempt.
  const change_tracking_consent = body?.change_tracking_consent === true;
  // SQL Server only — same principle for table-mode export access (CREATE
  // TABLE + ALTER ON SCHEMA): only attempted with explicit consent from the
  // preflight popup, never silently.
  const table_mode_consent      = body?.table_mode_consent === true;

  if (!table_fqn)   return Response.json({ error: 'table_fqn is required' }, { status: 400 });
  if (!column_name) return Response.json({ error: 'column_name is required' }, { status: 400 });

  // Per-column spec — the mandatory description + optional standardization rules
  // and naming convention. Its spec_id becomes the pipeline's lookup scope
  // (stored in the historical `domain_id` slot). Fields may arrive under
  // `body.spec` or at the top level of the body.
  const validated = validateSpecBody(body?.spec ?? body);
  if (!validated.ok) return Response.json({ error: validated.error }, { status: 400 });

  try {
    return await withWarehouse(async (conn) => {
      // Native preflight (2026-09-02): interactive screens run with the
      // CALLER's access, so creation used to succeed on tables the APP can't
      // read — producing a pipeline guaranteed to pause on its first poll,
      // with resume flipping straight back. Refuse HERE, the one moment the
      // user can act, with the setup-page fix in hand. Metadata-layer probes.
      const accessProblem = await probeNativeSourceAccess(conn, table_fqn);
      if (accessProblem) {
        return Response.json({ error: accessProblem }, { status: 400 });
      }
      const db = getDb();
      // One spec (and one pipeline) per (table_fqn, column_name): per-column
      // isolation means the scope id no longer participates in the dedup key.
      const existingRow = db
        .prepare(
          `SELECT pipeline_id, status, domain_id, export_kind FROM pipelines
           WHERE table_fqn = ? COLLATE NOCASE AND column_name = ? COLLATE NOCASE
           LIMIT 1`,
        )
        .get(table_fqn, column_name) as any;

      // Column mode writes onto the customer's table — three gates before
      // anything is created:
      //   1. CONSENT — the client must send column_write_consent: true, set
      //      only after showing the source-table disclaimer. Write access is
      //      case-by-case: onboarding grants none; consent covers THIS table.
      //   2. GUARDRAIL — refuse if a `<col>_STANDARDIZED` column already
      //      exists on the source: Prism can't tell it apart from customer
      //      data, and column mode must never write into a column Prism
      //      didn't create.
      //   3. GRANT — attempt the per-table `GRANT UPDATE` with the creator's
      //      personal credentials (change-tracking-fix pattern); when that
      //      isn't possible the pipeline is flagged with the exact SQL.
      // Gates 1–2 are skipped only when this exact pipeline is already live
      // in column mode (consent was given and its companion column is
      // Prism's own by construction).
      const alreadyLiveColumnPipeline =
        export_kind === 'column' &&
        existingRow &&
        String(existingRow.status ?? '') !== 'pending_baseline' &&
        String(existingRow.export_kind ?? '') === 'column';
      if (export_kind === 'column' && !alreadyLiveColumnPipeline) {
        if (body?.column_write_consent !== true) {
          return Response.json(
            { error: 'The Column output edits the source table and requires explicit consent (column_write_consent).' },
            { status: 400 },
          );
        }
        // The consent checkbox tells the user that ticking it "grants Prism
        // update access to this specific table only". Prism can only make
        // that true when it has credentials able to issue the GRANT — with
        // none, creation used to succeed and the pipeline immediately paused
        // asking for SQL, i.e. the consent promised something the system
        // could not deliver (finding #31). Check BEFORE creating anything,
        // exactly like the table-mode gate, and refuse with the SQL instead
        // of leaving a pipeline that cannot write.
        const columnAccess = await checkColumnModeAccess(table_fqn, Number(session.accountId));
        if (columnAccess === 'needs_admin') {
          return Response.json(
            {
              error:
                `Prism can't grant itself write access to ${table_fqn}, so the standardized column ` +
                `can't be maintained yet. Either save your own SQL Server credentials in Setup (Prism ` +
                `then grants access to this one table for you), or ask a SQL Server admin to run: ` +
                `${columnModeSetupSql(table_fqn, column_name)} No pipeline was created.`,
              code: 'column_mode_needs_grant',
            },
            { status: 400 },
          );
        }
        try {
          await assertCompanionColumnAvailable(conn, table_fqn, column_name);
        } catch (e) {
          if (e instanceof CompanionColumnConflictError) {
            return Response.json({ error: e.message }, { status: 400 });
          }
          throw e;
        }
      }

      // mssql table-mode exports: verify Prism can actually BUILD at the
      // destination BEFORE creating anything (owner decision 2026-08-17,
      // client-sim finding #7). Previously an unbuildable destination still
      // created the pipeline and merely flagged it — the flag cleared on
      // resume, leaving an "active" pipeline whose standardized table never
      // existed. Now: missing access → try the consented automatic grant →
      // still unbuildable → 400 with the exact fix SQL and NO pipeline row.
      // Skipped when the service login can't read the SOURCE either: that's a
      // candidate user-connection pipeline (create-initial-run decides), whose
      // destination lives behind the creator's own access and is validated on
      // that connection instead.
      const creatingNew = !existingRow || String(existingRow.status ?? '') === 'pending_baseline';
      // Refuse a destination another SOURCE already owns (finding #21).
      // Rebuilds replace the whole table, so two sources pointed at one
      // destination overwrite each other silently, and a pipeline aimed at a
      // one-time export's table destroys it on the first rebuild. Columns of
      // the SAME source sharing one export table are the documented
      // multi-column design and stay allowed. Checked before ANY row is
      // written, so a refusal leaves nothing behind.
      if (creatingNew && export_kind !== 'column' && export_table_fqn) {
        const claim = findExportClaim(export_table_fqn, table_fqn);
        if (claim) {
          return Response.json(
            { error: `${exportClaimError(export_table_fqn, claim)} No pipeline was created.` },
            { status: 409 },
          );
        }
      }

      if (creatingNew && export_kind === 'table' && export_table_fqn && getWarehouseAdapter().kind === 'mssql') {
        if (await serviceCanSeeSourceMssql(table_fqn)) {
          let buildable = await checkTableModeAccess(export_table_fqn).catch(() => false);
          if (!buildable && table_mode_consent) {
            buildable = (await provisionTableModeAccess(export_table_fqn, Number(session.accountId))) === 'granted';
          }
          if (!buildable) {
            return Response.json(
              {
                error:
                  `Prism can't create the standardized table at ${export_table_fqn}: its service login needs ` +
                  `CREATE TABLE permission in that database plus ALTER on that schema (and the schema must exist). ` +
                  `Point the destination at the PRISM_OUT schema created during setup, or ask an admin to run: ` +
                  `${tableModeSetupSql(export_table_fqn)} No pipeline was created.`,
              },
              { status: 400 },
            );
          }
        }
      }

      if (existingRow && String(existingRow.status ?? '') !== 'pending_baseline') {
        // Active/paused re-save: update the existing spec's content and the
        // pipeline's settings in place (keep the same spec_id / lookup scope).
        const pid = Number(existingRow.pipeline_id);
        let specId = existingRow.domain_id != null ? Number(existingRow.domain_id) : null;
        if (specId != null) {
          updateColumnSpec(specId, validated.spec);
        } else {
          const created = insertColumnSpec(validated.spec, { pipeline_id: pid, table_fqn, column_name });
          specId = created.spec_id;
          db.prepare(`UPDATE pipelines SET domain_id = ? WHERE pipeline_id = ?`).run(specId, pid);
        }
        await seedSpecValuesOnConn(conn, specId, validated.spec.valuesToSeed);

        const setClauses = [`status = ?`, `update_schedule = ?`, `export_unmapped_rows = ?`, `updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`];
        const binds: any[] = [status, serializeUpdateSchedule(update_schedule), export_unmapped_rows ? 1 : 0];
        if (name)             { setClauses.push('name = ?');             binds.push(name); }
        if (export_table_fqn) {
          setClauses.push('export_table_fqn = ?'); binds.push(export_table_fqn);
          setClauses.push('export_kind = ?');      binds.push(export_kind);
        }
        binds.push(pid);
        db.prepare(`UPDATE pipelines SET ${setClauses.join(', ')} WHERE pipeline_id = ?`).run(...binds);
      } else {
        // No live pipeline for this column (or an abandoned pending_baseline
        // setup attempt). Clean up the stale attempt — including its queue and
        // orphaned spec — so the fresh create starts clean; otherwise the
        // previously-accepted lookup matches make every value look "already
        // standardized" and the review comes up empty.
        if (existingRow) {
          const pid = Number(existingRow.pipeline_id);
          const oldSpecId = existingRow.domain_id != null ? Number(existingRow.domain_id) : null;
          await exec(conn, `DELETE FROM ${internalTable('PIPELINE_QUEUE')} WHERE pipeline_id = ?`, [pid]);
          db.prepare(`DELETE FROM pipelines WHERE pipeline_id = ?`).run(pid);
          if (oldSpecId != null) {
            // The attempt's review runs die with its spec (finding #10): an
            // 'approved' run left behind here was resumed by the NEXT attempt's
            // create-initial-run and could never be accepted. 'abandoned' is
            // outside every reuse/commit status filter; the run row (metadata
            // only) stays for history.
            db.prepare(
              `UPDATE runs SET run_status = 'abandoned', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
               WHERE domain_id = ? AND run_type != 'one_time' AND run_status IN ('created', 'approved', 'in_progress')`,
            ).run(oldSpecId);
            deleteColumnSpec(oldSpecId);
          }
        }

        // Create the spec FIRST — its spec_id fills the pipeline's domain_id slot.
        const created = insertColumnSpec(validated.spec, { table_fqn, column_name });
        const specId = created.spec_id;
        await seedSpecValuesOnConn(conn, specId, validated.spec.valuesToSeed);

        const cols: string[] = ['table_fqn', 'column_name', 'name', 'status', 'update_schedule', 'export_unmapped_rows', 'created_by', 'domain_id', 'change_tracking_consent'];
        const vals: any[]    = [table_fqn, column_name, name, status, serializeUpdateSchedule(update_schedule), export_unmapped_rows ? 1 : 0, Number(session.accountId), specId, change_tracking_consent ? 1 : 0];
        if (export_table_fqn)   {
          cols.push('export_table_fqn'); vals.push(export_table_fqn);
          cols.push('export_kind');      vals.push(export_kind);
        }
        const insRes = db.prepare(
          `INSERT INTO pipelines (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        ).run(...vals);
        setColumnSpecPipeline(specId, Number(insRes.lastInsertRowid), table_fqn);
      }

      const row = db
        .prepare(
          `${PIPELINE_SELECT}
           WHERE p.table_fqn = ? COLLATE NOCASE AND p.column_name = ? COLLATE NOCASE
           LIMIT 1`,
        )
        .get(table_fqn, column_name) as any;

      if (!row) {
        return Response.json({ error: 'Pipeline was saved but could not be retrieved.' }, { status: 500 });
      }

      const pipeline = row2pipeline(row);

      // Gate 3 — consent-time provisioning: create the companion column and
      // grant UPDATE on this ONE table via the creator's personal credentials
      // (ALTER needs table ownership, which the service role never has).
      // Idempotent, so re-running for a sibling column on the same table is
      // harmless. On 'manual_required' the pipeline is created but flagged
      // with the exact SQL; the sync will also pause with the same fix if it
      // runs without access.
      let column_write_access: 'granted' | 'manual_required' | null = null;
      if (export_kind === 'column' && !alreadyLiveColumnPipeline) {
        column_write_access = await provisionColumnModeAccess(table_fqn, column_name, Number(session.accountId));
        if (column_write_access === 'manual_required') {
          flagPipelineMessage(
            pipeline.pipeline_id,
            `Prism needs its standardized column and update access set up on ${table_fqn} ` +
            `(it will not modify any other column). Ask an admin to run: ${columnModeSetupSql(table_fqn, column_name)}`,
            'warning',
          ).catch(() => {});
        }
      }

      // mssql only — table-mode exports need CREATE TABLE + ALTER ON SCHEMA on
      // the destination schema, a permission gap the mssql onboarding wizard
      // doesn't close up front (unlike Snowflake's Part D). Check first (cheap,
      // no elevated connection). Only ATTEMPT the grant with explicit consent
      // from the preflight popup (table_mode_consent) — same "never grant
      // without approval" principle as Change Tracking; without consent this
      // is a pure status check, so the pipeline still gets flagged with the
      // exact fix SQL, but nothing is altered on the customer's behalf.
      if (export_kind === 'table' && pipeline.export_table_fqn && getWarehouseAdapter().kind === 'mssql') {
        const alreadyOk = await checkTableModeAccess(pipeline.export_table_fqn).catch(() => false);
        if (!alreadyOk) {
          const granted = table_mode_consent
            ? await provisionTableModeAccess(pipeline.export_table_fqn, Number(session.accountId))
            : 'manual_required' as const;
          if (granted === 'manual_required') {
            flagPipelineMessage(
              pipeline.pipeline_id,
              `Prism needs CREATE TABLE and ALTER ON SCHEMA permissions to build ${pipeline.export_table_fqn}. Ask an admin to run: ${tableModeSetupSql(pipeline.export_table_fqn)}`,
              'warning',
            ).catch(() => {});
          }
        }
      }

      // If the pipeline was created as active and has an export table/view, build it
      // (a view is only created here, once — it never needs rebuilding after this).
      if (status === 'active' && pipeline.export_table_fqn) {
        refreshExportTable(
          pipeline.table_fqn,
          pipeline.column_name,
          pipeline.export_table_fqn,
          pipeline.domain_id,
          pipeline.pipeline_id,
          pipeline.export_kind,
        ).catch(err => {
          console.error(`[ExportTable] Background refresh failed for pipeline ${pipeline.pipeline_id}:`, err);
        });
      }

      return Response.json({ pipeline, column_write_access }, { status: 201 });
    });
  } catch (err) {
    return warehouseErrorResponse(err, 'Failed to save pipeline');
  }
}
