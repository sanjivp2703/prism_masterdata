// Native-edition reference resolution — DORMANT since 2026-09-02: the
// manifest no longer defines the `source_table` reference (owner decision —
// consumers must never see a per-table selection flow; database-scoped
// grants + the hourly refresh task are the single access path). The module
// and its call sites are retained because a table bound to a reference is
// readable ONLY as reference('source_table','<alias>') — never by FQN — and
// the recorded native-v1.1 column-mode path brings a reference back. With no
// reference defined, SYSTEM$GET_ALL_REFERENCES fails, the failure is cached,
// and every resolveSourceReference() call resolves null (FQN path).
//
// Standard edition and non-Snowflake warehouses: resolveSourceReference()
// returns null before touching the connection — zero behavior change.
import 'server-only';

import { isNativeEdition } from '../../edition';
import type { WarehouseConnection } from '../types';
import { snowflakeAdapter } from './connection';
import {
  SOURCE_TABLE_REFERENCE,
  parseReferenceBindings,
  matchSourceReference,
  referenceSql,
  type SourceReferenceBinding,
} from './reference-sql';

export interface ResolvedSourceReference {
  binding: SourceReferenceBinding;
  /** SQL fragment addressing the table: reference('source_table', '<alias>'). */
  refSql: string;
}

// Bindings change only when an admin edits them in the permission UI, but the
// poller asks once per pipeline per cycle — cache briefly. SELECT of a SYSTEM$
// function is metadata-layer (same class as SYSTEM$STREAM_HAS_DATA): it never
// wakes the warehouse, so the cache is about round-trips, not billing.
const CACHE_TTL_MS = 30_000;
let cache: { at: number; bindings: SourceReferenceBinding[] } | null = null;

export function invalidateSourceReferenceCache(): void {
  cache = null;
}

/**
 * All current bindings of the `source_table` reference, from
 * SYSTEM$GET_ALL_REFERENCES (details form: alias + database/schema/name).
 * Empty outside the native edition. ANY failure degrades to [] and is CACHED
 * like a result: with no reference in the manifest (the dormant state) this
 * call fails on every install, and an uncached failure would re-issue the
 * failing query on every poll/read — cached, dormancy costs one quiet
 * metadata query per TTL. The direct-grant FQN path is the fallback either
 * way.
 */
export async function listSourceTableBindings(conn: unknown): Promise<SourceReferenceBinding[]> {
  if (!isNativeEdition()) return [];
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.bindings;
  try {
    const rows = await snowflakeAdapter.executeQuery(
      conn as WarehouseConnection,
      `SELECT SYSTEM$GET_ALL_REFERENCES('${SOURCE_TABLE_REFERENCE}', true) AS REFS`,
    );
    const first = rows?.[0] as Record<string, unknown> | undefined;
    const raw = first?.REFS ?? first?.refs;
    const bindings = parseReferenceBindings(typeof raw === 'string' ? JSON.parse(raw) : raw);
    cache = { at: Date.now(), bindings };
    return bindings;
  } catch {
    cache = { at: Date.now(), bindings: [] };
    return [];
  }
}

/**
 * Resolve a parsed source FQN to its reference form, or null when no binding
 * matches (callers then use the quoted FQN exactly as before). Match is exact
 * per part — see matchSourceReference.
 */
export async function resolveSourceReference(
  conn: unknown,
  parts: { db: string; schema: string; table: string },
): Promise<ResolvedSourceReference | null> {
  if (!isNativeEdition()) return null;
  const binding = matchSourceReference(parts, await listSourceTableBindings(conn));
  return binding ? { binding, refSql: referenceSql(binding.alias) } : null;
}
