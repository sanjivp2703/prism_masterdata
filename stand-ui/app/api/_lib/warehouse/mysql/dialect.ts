// MySQL dialect helpers — pure functions, no driver dependency.
// Covered by scripts/parity-tests.ts (extend the tests when these change).
//
// MySQL-specific facts these helpers encode (docs/MYSQL_PORT_PLAN.md §2):
//   * Identifiers quote with BACKTICKS (`` ` `` doubled to escape).
//   * There is no schema level inside a database — names are two-part
//     `database.table` (CREATE SCHEMA is an alias for CREATE DATABASE), and
//     cross-database queries on one server work freely.
//   * Bind placeholders are natively `?` — the codebase convention — so
//     translateBinds only VALIDATES/counts; the text passes through unchanged.
//   * Byte-exact comparisons need charset conversion, not just a collation:
//     a legacy latin1 source column cannot take a bare COLLATE utf8mb4_bin.

/** Backtick-quote an identifier: `col name` → `` `col name` ``, backticks
 *  doubled. Rejects control characters (never legitimate in an identifier). */
export function quoteIdent(ident: string): string {
  const s = String(ident);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 31 || c === 127) {
      throw new Error(`Unsafe identifier: ${JSON.stringify(ident)}`);
    }
  }
  return `\`${s.replace(/`/g, '``')}\``;
}

export interface MysqlFqn { db: string; table: string }

/** Parse `database.table` (MySQL has no schema level; names with literal dots
 *  are not supported on any warehouse). A 3-part form is rejected loudly —
 *  it means a Snowflake/mssql-shaped FQN reached a MySQL path unconverted. */
export function parseFqn(fqn: string): MysqlFqn {
  const parts = String(fqn).split('.').map((p) => p.trim());
  if (parts.length === 2 && parts.every(Boolean)) {
    return { db: parts[0], table: parts[1] };
  }
  throw new Error(`Expected DATABASE.TABLE (MySQL has no schema level), got: ${fqn}`);
}

/**
 * Validate/count `?` placeholders. MySQL's driver takes `?` natively, so the
 * text is returned UNCHANGED — this exists so executeQuery can enforce the
 * same bind-count contract as every other adapter, with the same
 * quote/comment awareness (a `?` inside a string literal must not count).
 */
export function translateBinds(sqlText: string): { text: string; count: number } {
  let count = 0;
  let i = 0;
  const n = sqlText.length;

  while (i < n) {
    const c = sqlText[i];

    if (c === "'" || c === '"') {           // string literal ('' or \' escapes; MySQL allows both quote styles)
      i = scanQuoted(sqlText, i, c);
      continue;
    }
    if (c === '`') {                        // backtick identifier (`` escapes)
      i = scanQuoted(sqlText, i, '`');
      continue;
    }
    if (c === '-' && sqlText[i + 1] === '-') {  // line comment
      while (i < n && sqlText[i] !== '\n') i++;
      continue;
    }
    if (c === '#') {                        // MySQL # line comment
      while (i < n && sqlText[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sqlText[i + 1] === '*') {  // block comment
      const j = sqlText.indexOf('*/', i + 2);
      i = j === -1 ? n : j + 2;
      continue;
    }
    if (c === '?') count++;
    i++;
  }

  return { text: sqlText, count };
}

/** Scan a quoted span (opening quote at `start`): the quote char escapes by
 *  doubling, and — in MySQL string literals — backslash escapes the next
 *  character. Returns the index AFTER the closing quote (or end of string). */
function scanQuoted(s: string, start: number, quote: string): number {
  let j = start + 1;
  const n = s.length;
  const backslashEscapes = quote !== '`';
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

/**
 * Byte-exact comparison wrapper for a SOURCE-side expression
 * (docs/MYSQL_PORT_PLAN.md §2.3). The staging side is already
 * `utf8mb4 COLLATE utf8mb4_bin`; the source side must be CONVERTed first —
 * a legacy latin1/etc. column cannot take a bare `COLLATE utf8mb4_bin`
 * (error 1253, COLLATION not valid for CHARACTER SET). Every staging join
 * and byte-distinct GROUP BY goes through this helper; never hand-roll it.
 */
export function binaryCompare(expr: string): string {
  return `CONVERT(${expr} USING utf8mb4) COLLATE utf8mb4_bin`;
}

// ── Error classification (pure — errno-based) ────────────────────────────────
// mysql2 surfaces the server errno as `err.errno` (number) and driver/network
// failures as string codes on `err.code`.

/** Errnos that read as "no access / object not visible". 1146 (table missing)
 *  is included because missing and not-visible are indistinguishable to the
 *  caller — same rationale as mssql 208 / pg 42P01. */
export const MYSQL_ACCESS_ERRNOS = new Set([
  1044, // access denied to database
  1142, // command denied (table privilege)
  1143, // column privilege denied
  1146, // table doesn't exist
  1045, // access denied (auth)
  1049, // unknown database
]);

/* eslint-disable @typescript-eslint/no-explicit-any -- error shapes are untyped */
export function isMysqlAccessErrorShape(err: unknown): boolean {
  const errno = Number((err as any)?.errno ?? NaN);
  if (MYSQL_ACCESS_ERRNOS.has(errno)) return true;
  const msg = String((err as any)?.message ?? err ?? '').toLowerCase();
  return (
    msg.includes('access denied') ||
    msg.includes('command denied') ||
    /table .* doesn't exist/.test(msg) ||
    msg.includes('unknown database')
  );
}

const MYSQL_GLOBAL_ERRNOS = new Set([
  1045, // auth failed — the service login itself is broken
  1049, // unknown database
]);
const MYSQL_TABLE_ERRNOS = new Set([
  1044, // db access denied
  1142, // table command denied
  1143, // column privilege denied
  1146, // table doesn't exist
  1054, // unknown column (watched column dropped/renamed)
]);
const MYSQL_TRANSIENT_ERRNOS = new Set([
  1213, // deadlock
  1205, // lock wait timeout
  1040, // too many connections
]);

/** The poll-cycle triage: global infra (banner + auto-resume, no per-pipeline
 *  pause) vs per-table access (pause) vs transient (retry next cycle). */
export function classifyMysqlPollError(err: unknown): 'global' | 'table' | 'transient' {
  const errno = Number((err as any)?.errno ?? NaN);
  if (MYSQL_GLOBAL_ERRNOS.has(errno)) return 'global';
  if (MYSQL_TABLE_ERRNOS.has(errno)) return 'table';
  if (MYSQL_TRANSIENT_ERRNOS.has(errno)) return 'transient';
  const code = String((err as any)?.code ?? '');
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ENOTFOUND' || code === 'PROTOCOL_CONNECTION_LOST') {
    return 'transient';
  }
  const msg = String((err as any)?.message ?? err ?? '').toLowerCase();
  if (msg.includes('access denied for user') || msg.includes('unknown database')) return 'global';
  if (msg.includes('command denied') || /table .* doesn't exist/.test(msg)) return 'table';
  return 'transient';
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Best-effort detection of sleep-on-idle MySQL providers by hostname
 * (docs/MYSQL_PORT_PLAN.md §2.7): PlanetScale (`*.psdb.cloud`) sleeps idle
 * branches; Aurora Serverless v2 cannot be identified from the hostname
 * alone, so — as on Postgres — this is a heuristic backed by an onboarding
 * disclosure, not a guarantee.
 */
export function isScaleToZeroHost(host: string | null | undefined): boolean {
  if (!host) return false;
  return /\.psdb\.cloud$/i.test(String(host).trim());
}
