// Native-edition reference resolution (docs/NATIVE_APP_PLAN.md — access model
// revised 2026-09-01). Consumers bind source tables to the app's multi-valued
// `source_table` reference through Snowflake's permission UI; the app can then
// read each bound table ONLY via reference('source_table', '<alias>') — the
// FQN stays invisible. This module maps a pipeline's stored FQN to that SQL
// form, so every service-connection source read works whether access arrived
// as a direct GRANT (FQN path, unchanged) or as a reference binding.
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
 * Empty outside the native edition. ANY failure degrades to [] without
 * caching it — a package predating the reference, a caller's-rights session
 * (app system functions aren't available there), or a transient error must
 * leave the direct-grant path fully functional, and must not poison the
 * cache for the service connection.
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
