/**
 * Native-edition visibility scoping (owner decision 2026-08-28): "your role
 * defines your view." A pipeline is visible to a viewer when any of:
 *   1. the viewer created it,
 *   2. its source is an uploaded file (CSV/Excel) — file standardizations are
 *      visible to everyone with app access (there is no Snowflake object for
 *      RBAC to speak about), or
 *   3. the viewer's own Snowflake access can see the source table, checked on
 *      the viewer's caller-rights session.
 *
 * The probe is SHOW OBJECTS on the caller session — metadata-layer only, so
 * it never wakes a warehouse (the idle-cost-zero rule holds), and it answers
 * with exactly the caller's visibility: in a database without the caller
 * grant opt-in the session sees nothing, so the probe fails and the pipeline
 * stays creator-only. That collapse of "cannot verify" into "not visible" is
 * the decided fallback, not an accident.
 *
 * Results are cached per (viewer, table) for a few minutes on globalThis
 * (hot-reload-safe) so SSE-driven list refetches don't open a caller
 * connection per cycle. Standard edition: no scoping — every helper here
 * short-circuits to "visible" outside the native edition.
 */
import 'server-only';

import { getDb } from './sqlite';
import { isNativeEdition } from './edition';
import { withUserWarehouse, executeQuery } from './warehouse';
import { parseFqn } from './op-one-time';

const CACHE_TTL_MS = 5 * 60_000;

type CacheEntry = { ok: boolean; at: number };
const g = globalThis as unknown as { __prismVisibilityCache?: Map<string, CacheEntry> };
function cache(): Map<string, CacheEntry> {
  if (!g.__prismVisibilityCache) g.__prismVisibilityCache = new Map();
  return g.__prismVisibilityCache;
}

function ident(part: string): string {
  return `"${part.replace(/"/g, '""')}"`;
}
// SHOW ... LIKE patterns: single-quoted string; _ and % are wildcards, escape
// them so a literal table name matches only itself.
function likePattern(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/([_%])/g, '\\$1').replace(/'/g, "''");
}

/** Can this viewer's own Snowflake access see the table? Cached; never throws. */
export async function canViewerAccessTable(accountId: number, tableFqn: string): Promise<boolean> {
  if (!isNativeEdition()) return true;
  const key = `${accountId}|${tableFqn.toUpperCase()}`;
  const hit = cache().get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ok;
  let ok = false;
  try {
    const { db, schema, table } = parseFqn(tableFqn);
    const rows = await withUserWarehouse(accountId, (conn) =>
      executeQuery(
        conn,
        `SHOW OBJECTS LIKE '${likePattern(table)}' IN SCHEMA ${ident(db)}.${ident(schema)}`,
      ),
    );
    ok = Array.isArray(rows) && rows.length > 0;
  } catch {
    ok = false; // unverifiable = not visible (decided fallback)
  }
  cache().set(key, { ok, at: Date.now() });
  return ok;
}

interface PipelineVisibilityShape {
  created_by?: number | null;
  CREATED_BY?: number | null;
  source_type?: string | null;
  SOURCE_TYPE?: string | null;
  table_fqn?: string | null;
  TABLE_FQN?: string | null;
}

function rowCreator(r: PipelineVisibilityShape): number | null {
  const raw = r.CREATED_BY ?? r.created_by;
  return raw != null ? Number(raw) : null;
}
function rowIsFileBased(r: PipelineVisibilityShape): boolean {
  const t = String(r.SOURCE_TYPE ?? r.source_type ?? 'snowflake').toLowerCase();
  return t !== 'snowflake';
}
function rowTable(r: PipelineVisibilityShape): string {
  return String(r.TABLE_FQN ?? r.table_fqn ?? '');
}

/** Filter raw pipeline rows down to what this viewer may see (native only). */
export async function filterPipelineRowsForViewer<T extends PipelineVisibilityShape>(
  accountId: number,
  rows: T[],
): Promise<T[]> {
  if (!isNativeEdition()) return rows;
  const out: T[] = [];
  const pending: Array<{ row: T; fqn: string }> = [];
  for (const row of rows) {
    if (rowIsFileBased(row) || rowCreator(row) === accountId) { out.push(row); continue; }
    const fqn = rowTable(row);
    if (!fqn) continue; // no creator match, no table to check: hidden
    pending.push({ row, fqn });
  }
  // Deduplicate table probes; sequential is fine (cache absorbs repeats and
  // lists are small).
  const verdicts = new Map<string, boolean>();
  for (const { fqn } of pending) {
    if (!verdicts.has(fqn)) verdicts.set(fqn, await canViewerAccessTable(accountId, fqn));
  }
  for (const { row, fqn } of pending) if (verdicts.get(fqn)) out.push(row);
  return out;
}

/** May this viewer see this one pipeline? For detail/mutation route guards. */
export async function canViewerSeePipeline(accountId: number, pipelineId: number): Promise<boolean> {
  if (!isNativeEdition()) return true;
  // NO source_type here: pipelines dropped that column in migration 016
  // (warehouse-only) — selecting it throws "no such column", which 500'd
  // every route this guards (DELETE, mappings) since the RBAC commit
  // (live-found 2026-09-02 in the PRISM_TEST service logs). rowIsFileBased
  // defaults an absent field to 'snowflake', which is now always true.
  const row = getDb()
    .prepare(`SELECT created_by, table_fqn FROM pipelines WHERE pipeline_id = ?`)
    .get(pipelineId) as PipelineVisibilityShape | undefined;
  if (!row) return true; // absent: let the route produce its own 404
  const kept = await filterPipelineRowsForViewer(accountId, [row]);
  return kept.length > 0;
}

/**
 * Spec ids this viewer may see mappings for (native only; null = no scoping).
 * A spec follows its pipelines: visible if any referencing pipeline is
 * visible. A spec referenced by NO pipeline has no table for RBAC to speak
 * about (seeded/legacy) and stays visible.
 */
export async function visibleSpecIdsForViewer(accountId: number): Promise<Set<number> | null> {
  if (!isNativeEdition()) return null;
  const db = getDb();
  const specs = db.prepare(`SELECT spec_id FROM column_specs`).all() as Array<{ spec_id: number }>;
  const refs = db
    .prepare(`SELECT domain_id, created_by, table_fqn FROM pipelines WHERE domain_id IS NOT NULL`)
    .all() as Array<PipelineVisibilityShape & { domain_id: number }>;
  const referenced = new Set(refs.map((r) => Number(r.domain_id)));
  const visible = new Set<number>();
  for (const s of specs) if (!referenced.has(Number(s.spec_id))) visible.add(Number(s.spec_id));
  const kept = await filterPipelineRowsForViewer(accountId, refs);
  for (const r of kept) visible.add(Number(r.domain_id));
  return visible;
}
