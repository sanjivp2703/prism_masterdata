// PostgreSQL dialect helpers — pure functions, no driver dependency.
// Covered by scripts/parity-tests.ts (extend the tests when these change).
//
// Postgres-specific facts these helpers encode (docs/POSTGRES_PORT_PLAN.md §2.5):
//   * Unquoted identifiers fold to LOWERCASE (the opposite of Snowflake).
//   * Quoted identifiers use `"…"` with `""` escaping.
//   * A connection is bound to ONE database — cross-database FQNs are invalid
//     and must be rejected loudly, never silently mis-resolved.
//   * Bind placeholders are `$1…$n` (the codebase convention is `?`).

/** Double-quote an identifier: `col name` → `"col name"`, `"` doubled.
 *  Rejects control characters (never legitimate in an identifier). */
export function quoteIdent(ident: string): string {
  const s = String(ident);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 31 || c === 127) {
      throw new Error(`Unsafe identifier: ${JSON.stringify(ident)}`);
    }
  }
  return `"${s.replace(/"/g, '""')}"`;
}

export interface PgFqn {
  /** null for the 2-part `schema.table` form (meaning: the connected DB). */
  db: string | null;
  schema: string;
  table: string;
}

/**
 * Parse `db.schema.table` OR `schema.table` (names containing literal dots are
 * not supported on any warehouse). Postgres cannot query across databases, so
 * the 3-part form is only valid when `db` matches the connected database —
 * callers that know the connected DB must follow up with
 * `assertFqnInDatabase`.
 */

/** SQL predicate for "this cell holds a standardizable value": not NULL and
 *  not blank. The app-side twin is `isBlankLiteral` (normalize.ts); with no
 *  SQL-side normalize on this warehouse the predicate trims ordinary
 *  whitespace only — exotic control-only values are still dropped app-side by
 *  `normalizeLiteral`, so they can at most be over-counted, never stuck. */
export function notBlankPredicate(colRef: string): string {
  return `(${colRef} IS NOT NULL AND BTRIM(${colRef}::text, E' \\t\\n\\r') <> '')`;
}

/** Negation of `notBlankPredicate`: NULL or blank — passes through as-is. */
export function isBlankPredicate(colRef: string): string {
  return `(${colRef} IS NULL OR BTRIM(${colRef}::text, E' \\t\\n\\r') = '')`;
}

export function parseFqn(fqn: string): PgFqn {
  const parts = String(fqn).split('.').map((p) => p.trim());
  if (parts.length === 2 && parts.every(Boolean)) {
    return { db: null, schema: parts[0], table: parts[1] };
  }
  if (parts.length === 3 && parts.every(Boolean)) {
    return { db: parts[0], schema: parts[1], table: parts[2] };
  }
  throw new Error(`Expected DB.SCHEMA.TABLE or SCHEMA.TABLE, got: ${fqn}`);
}

/**
 * Reject a 3-part FQN that names a DIFFERENT database than the connection —
 * Postgres cannot join across databases, and quietly reading a same-named
 * table in the connected DB would be worse than failing. Comparison is
 * case-insensitive (unquoted Postgres identifiers fold to lowercase, and both
 * sides of this comparison come from operator-typed config/FQN text).
 */
export function assertFqnInDatabase(fqn: PgFqn, connectedDb: string): void {
  if (fqn.db != null && fqn.db.toLowerCase() !== String(connectedDb).toLowerCase()) {
    throw new Error(
      `Postgres cannot query across databases: "${fqn.db}.${fqn.schema}.${fqn.table}" ` +
      `names database "${fqn.db}" but this installation is connected to "${connectedDb}". ` +
      `Connect a separate Prism installation for that database.`,
    );
  }
}

/**
 * Translate `?` positional bind placeholders (the codebase convention) to
 * Postgres's `$1, $2, …`.
 *
 * Scanner-based so `?` inside string literals ('…' with '' escapes, plus
 * backslash escapes in E'…' strings), double-quoted identifiers ("…"),
 * dollar-quoted strings ($tag$…$tag$), line comments (--) and block comments
 * are left untouched.
 */
export function translateBinds(sqlText: string): { text: string; count: number } {
  let out = '';
  let count = 0;
  let i = 0;
  const n = sqlText.length;

  while (i < n) {
    const c = sqlText[i];

    if (c === "'") {                       // string literal ('' escapes; E'…' adds \' escapes)
      const escapeString = /[eE]/.test(sqlText[i - 1] ?? '') && !/[A-Za-z0-9_]/.test(sqlText[i - 2] ?? '');
      const end = scanQuoted(sqlText, i, "'", escapeString);
      out += sqlText.slice(i, end); i = end; continue;
    }
    if (c === '"') {                       // quoted identifier ("" escapes)
      const end = scanQuoted(sqlText, i, '"', false);
      out += sqlText.slice(i, end); i = end; continue;
    }
    if (c === '$') {                       // dollar-quoted string ($$…$$ / $tag$…$tag$)
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sqlText.slice(i));
      if (m) {
        const tag = m[0];
        const close = sqlText.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        out += sqlText.slice(i, end); i = end; continue;
      }
      out += c; i++; continue;
    }
    if (c === '-' && sqlText[i + 1] === '-') {  // line comment
      let j = i;
      while (j < n && sqlText[j] !== '\n') j++;
      out += sqlText.slice(i, j); i = j; continue;
    }
    if (c === '/' && sqlText[i + 1] === '*') {  // block comment
      const j = sqlText.indexOf('*/', i + 2);
      const end = j === -1 ? n : j + 2;
      out += sqlText.slice(i, end); i = end; continue;
    }
    if (c === '?') {
      count++;
      out += `$${count}`; i++; continue;
    }
    out += c; i++;
  }

  return { text: out, count };
}

/** Scan a quoted span starting at `start` (the opening quote); the quote char
 *  escapes itself by doubling, and — when `backslashEscapes` (E'…' strings) —
 *  a backslash escapes the next character. Returns the index AFTER the closing
 *  quote (or end of string if unterminated). */
function scanQuoted(s: string, start: number, quote: string, backslashEscapes: boolean): number {
  let j = start + 1;
  const n = s.length;
  while (j < n) {
    if (backslashEscapes && s[j] === '\\') { j += 2; continue; }
    if (s[j] === quote) {
      if (s[j + 1] === quote) { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return n;
}

// ── Error classification (pure — SQLSTATE-based) ─────────────────────────────
// node-postgres surfaces the SQLSTATE as `err.code` (5-char string); network
// errors surface Node syscall codes there instead (ECONNREFUSED, …).

/** SQLSTATEs that read as "no access / object not visible". 42P01
 *  (undefined_table) is included because missing and not-visible are
 *  indistinguishable to the caller — same rationale as mssql error 208. */
export const PG_ACCESS_SQLSTATES = new Set([
  '42501', // insufficient_privilege
  '42P01', // undefined_table
  '3F000', // invalid_schema_name
  '3D000', // invalid_catalog_name (database does not exist)
  '28P01', // invalid_password
  '28000', // invalid_authorization_specification
]);

/* eslint-disable @typescript-eslint/no-explicit-any -- error shapes are untyped */
export function isPgAccessErrorShape(err: unknown): boolean {
  const code = String((err as any)?.code ?? '');
  if (PG_ACCESS_SQLSTATES.has(code)) return true;
  const msg = String((err as any)?.message ?? err ?? '').toLowerCase();
  return (
    msg.includes('permission denied') ||
    msg.includes('password authentication failed') ||
    /relation .* does not exist/.test(msg) ||
    /schema .* does not exist/.test(msg) ||
    /database .* does not exist/.test(msg)
  );
}

const PG_GLOBAL_SQLSTATES = new Set([
  '28P01', // bad password — the service login itself is broken
  '28000', // authorization failed
  '3D000', // database does not exist
  '57P03', // cannot_connect_now (starting up / shutting down)
  '53300', // too_many_connections
]);
const PG_TABLE_SQLSTATES = new Set([
  '42P01', // undefined_table
  '42501', // insufficient_privilege
  '3F000', // invalid_schema_name
  '42703', // undefined_column (watched column dropped/renamed)
]);
const PG_TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '57014', // query_canceled (statement_timeout)
  '08006', // connection_failure
  '08003', // connection_does_not_exist
]);

/** The poll-cycle triage: global infra (banner + auto-resume, no per-pipeline
 *  pause) vs per-table access (pause) vs transient (retry next cycle). */
export function classifyPgPollError(err: unknown): 'global' | 'table' | 'transient' {
  const code = String((err as any)?.code ?? '');
  if (PG_GLOBAL_SQLSTATES.has(code)) return 'global';
  if (PG_TABLE_SQLSTATES.has(code)) return 'table';
  if (PG_TRANSIENT_SQLSTATES.has(code)) return 'transient';
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ENOTFOUND') {
    return 'transient';
  }
  const msg = String((err as any)?.message ?? err ?? '').toLowerCase();
  if (msg.includes('password authentication failed') || /database .* does not exist/.test(msg)) return 'global';
  if (msg.includes('permission denied') || /relation .* does not exist/.test(msg)) return 'table';
  return 'transient';
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Best-effort detection of scale-to-zero Postgres providers by hostname.
 * Neon (`*.neon.tech`) pauses idle databases like a suspended Snowflake
 * warehouse — steady polling would hold it awake 24/7 and negate the
 * customer's savings (docs/POSTGRES_PORT_PLAN.md §2.4). Aurora Serverless
 * cannot be identified from the hostname alone, so this is a heuristic backed
 * by an onboarding disclosure, not a guarantee.
 */
export function isScaleToZeroHost(host: string | null | undefined): boolean {
  if (!host) return false;
  return /\.neon\.tech$/i.test(String(host).trim());
}
