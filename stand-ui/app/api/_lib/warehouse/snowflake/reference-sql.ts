// Pure helpers for the native edition's manifest REFERENCE to pipeline source
// tables (docs/NATIVE_APP_PLAN.md — access model revised 2026-09-01: the
// permission UI is back as a per-table grant path alongside the direct
// GRANT ... TO APPLICATION SQL).
//
// Background: when a consumer binds a table to the app's `source_table`
// reference (in Snowsight's Security tab, or via SYSTEM$REFERENCE SQL), the
// app does NOT gain FQN visibility — the object is reachable ONLY through the
// reference('source_table', '<alias>') form in SQL. These helpers parse the
// bindings reported by SYSTEM$GET_ALL_REFERENCES and build that SQL form.
//
// Deliberately NO `import 'server-only'`: pure string/JSON logic, exercised by
// scripts/parity-tests.ts like the other pure SQL-text modules.

/** The manifest reference name (native/manifest.yml `references:`). */
export const SOURCE_TABLE_REFERENCE = 'source_table';

export interface SourceReferenceBinding {
  /** System-generated alias identifying this binding of the multi-valued reference. */
  alias: string;
  db: string;
  schema: string;
  table: string;
}

/**
 * Parse the value returned by SYSTEM$GET_ALL_REFERENCES('source_table', true):
 * a JSON array of { alias, database, schema, name } objects (VARCHAR-encoded;
 * callers JSON.parse strings before passing them here). Tolerant of shape
 * drift — anything unrecognized yields [] rather than a throw, because a
 * parse failure must degrade to "no bindings" (direct grants keep working),
 * never take down a poll cycle.
 */
export function parseReferenceBindings(raw: unknown): SourceReferenceBinding[] {
  const wrapped = raw != null && typeof raw === 'object'
    ? (raw as Record<string, unknown>).references
    : null;
  const arr: unknown[] | null = Array.isArray(raw) ? raw : Array.isArray(wrapped) ? wrapped : null;
  if (!arr) return [];
  const out: SourceReferenceBinding[] = [];
  for (const entry of arr) {
    if (entry == null || typeof entry !== 'object') continue;
    const rec = entry as Record<string, unknown>;
    const alias  = String(rec.alias ?? '');
    const db     = String(rec.database ?? '');
    const schema = String(rec.schema ?? '');
    const table  = String(rec.name ?? '');
    if (alias && db && schema && table) out.push({ alias, db, schema, table });
  }
  return out;
}

/**
 * Find the binding for a pipeline's parsed source FQN. Matching is EXACT and
 * case-sensitive on every part — the same semantics as the rest of the app's
 * source addressing, which wraps each part in a quoted identifier
 * (`"db"."schema"."table"`). A binding that only matches case-insensitively
 * would resolve a table the quoted direct form could not, silently changing
 * which object a pipeline reads.
 */
export function matchSourceReference(
  parts: { db: string; schema: string; table: string },
  bindings: SourceReferenceBinding[],
): SourceReferenceBinding | null {
  for (const b of bindings) {
    if (b.db === parts.db && b.schema === parts.schema && b.table === parts.table) return b;
  }
  return null;
}

/** The SQL form that addresses a bound table: reference('source_table', '<alias>').
 *  Aliases are system-generated, but the quote-doubling keeps a hostile value
 *  from breaking out of the string literal. */
export function referenceSql(alias: string): string {
  return `reference('${SOURCE_TABLE_REFERENCE}', '${String(alias).replace(/'/g, "''")}')`;
}

/**
 * Normalize a DESCRIBE TABLE row's `type` (e.g. "VARCHAR(16777216)") to the
 * token vocabulary SHOW COLUMNS uses in its data_type JSON, where every string
 * type reports as 'TEXT'. Reference-granted tables have no FQN visibility, so
 * the reference path discovers columns via DESCRIBE TABLE reference(...) and
 * this keeps the downstream "is it a text column?" checks unchanged.
 */
export function describeTypeToken(rawType: string): string {
  const t = String(rawType).trim().toUpperCase();
  if (/^(VARCHAR|CHAR|CHARACTER|STRING|TEXT)\b/.test(t)) return 'TEXT';
  return t.replace(/\(.*$/, '').trim();
}

/** Extract the column rows (name + normalized type token, in table order)
 *  from a DESCRIBE TABLE result. Non-column rows (kind != 'COLUMN') are
 *  dropped; a missing kind field is treated as a column. */
export function describeRowsToColumns(rows: unknown[]): { name: string; typeToken: string }[] {
  const out: { name: string; typeToken: string }[] = [];
  for (const r of rows ?? []) {
    if (r == null || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    const kind = String(rec.kind ?? rec.KIND ?? 'COLUMN').toUpperCase();
    if (kind !== 'COLUMN') continue;
    const name = String(rec.name ?? rec.NAME ?? '');
    if (!name) continue;
    out.push({ name, typeToken: describeTypeToken(String(rec.type ?? rec.TYPE ?? '')) });
  }
  return out;
}
