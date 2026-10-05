// SQL Server dialect helpers — pure functions, no driver dependency.
// Covered by scripts/parity-tests.ts (extend the tests when these change).

/** Bracket-quote an identifier: `col name` → `[col name]`, `]` doubled.
 *  Rejects control characters (never legitimate in an identifier). */
export function quoteIdent(ident: string): string {
  const s = String(ident);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 31 || c === 127) {
      throw new Error(`Unsafe identifier: ${JSON.stringify(ident)}`);
    }
  }
  return `[${s.replace(/\]/g, ']]')}]`;
}

/** Parse DB.SCHEMA.TABLE (same three-part shape as the Snowflake side; names
 *  containing literal dots are not supported on either warehouse). */

/** SQL predicate for "this cell holds a standardizable value": not NULL and
 *  not blank. The app-side twin is `isBlankLiteral` (normalize.ts); with no
 *  SQL-side normalize on this warehouse the predicate trims ordinary
 *  whitespace only — exotic control-only values are still dropped app-side by
 *  `normalizeLiteral`, so they can at most be over-counted, never stuck. */
export function notBlankPredicate(colRef: string): string {
  return `(${colRef} IS NOT NULL AND LTRIM(RTRIM(${colRef})) <> '')`;
}

/** Negation of `notBlankPredicate`: NULL or blank — passes through as-is. */
export function isBlankPredicate(colRef: string): string {
  return `(${colRef} IS NULL OR LTRIM(RTRIM(${colRef})) = '')`;
}

export function parseFqn(fqn: string): { db: string; schema: string; table: string } {
  const parts = String(fqn).split('.').map(p => p.trim());
  if (parts.length !== 3 || parts.some(p => !p)) {
    throw new Error(`Expected DB.SCHEMA.TABLE, got: ${fqn}`);
  }
  return { db: parts[0], schema: parts[1], table: parts[2] };
}

/**
 * Translate `?` positional bind placeholders (the codebase convention, from
 * the Snowflake driver) to SQL Server's named `@p1, @p2, …`.
 *
 * Scanner-based so `?` inside string literals ('…' with '' escapes), bracket
 * identifiers ([…] with ]] escapes), double-quoted identifiers ("…"), line
 * comments (--) and block comments (/* … *​/) are left untouched.
 */
export function translateBinds(sqlText: string): { text: string; count: number } {
  let out = '';
  let count = 0;
  let i = 0;
  const n = sqlText.length;

  while (i < n) {
    const c = sqlText[i];

    if (c === "'") {                       // string literal ('' escapes)
      const end = scanQuoted(sqlText, i, "'");
      out += sqlText.slice(i, end); i = end; continue;
    }
    if (c === '[') {                       // bracket identifier (]] escapes)
      let j = i + 1;
      while (j < n) {
        if (sqlText[j] === ']') {
          if (sqlText[j + 1] === ']') { j += 2; continue; }
          j++; break;
        }
        j++;
      }
      out += sqlText.slice(i, j); i = j; continue;
    }
    if (c === '"') {                       // quoted identifier ("" escapes)
      const end = scanQuoted(sqlText, i, '"');
      out += sqlText.slice(i, end); i = end; continue;
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
      out += `@p${count}`; i++; continue;
    }
    out += c; i++;
  }

  return { text: out, count };
}

/** Scan a quoted span starting at `start` (which must be the opening quote),
 *  where the quote char escapes itself by doubling. Returns the index AFTER
 *  the closing quote (or end of string if unterminated). */
function scanQuoted(s: string, start: number, quote: string): number {
  let j = start + 1;
  const n = s.length;
  while (j < n) {
    if (s[j] === quote) {
      if (s[j + 1] === quote) { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return n;
}

// ── Detection tier logic (pure — used by ./detection.ts, parity-tested) ─────

/** Initial diff-scan tier from the table's row count: scan every Nth pass. */
export function computeScanTier(rowCount: number, serverless = false): number {
  const base = rowCount < 1_000_000 ? 1 : rowCount < 50_000_000 ? 2 : 10;
  return serverless ? Math.min(60, base * 10) : base;
}

/** Retune the tier from the measured scan duration — a fast scan earns the
 *  every-pass tier regardless of size (indexed column); a slow one backs off. */
export function retuneScanTier(durationMs: number, serverless = false): number {
  const base =
    durationMs < 1_000 ? 1 :
    durationMs < 5_000 ? 2 :
    durationMs < 15_000 ? 5 : 10;
  return serverless ? Math.min(60, base * 10) : base;
}

// ── Poll-error classification (pure) ─────────────────────────────────────────

const GLOBAL_ERROR_NUMBERS = new Set([18456, 4060, 916, 40613 /* Azure db unavailable */]);
const TABLE_ERROR_NUMBERS = new Set([208, 229, 230, 262, 297, 300]);
// "Change tracking is not enabled on table '...'" — thrown by CHANGETABLE()
// when a pipeline's stored ct_version/mode assumes CT is still active but it
// isn't anymore. Almost always means the table was DROPPED AND RECREATED
// (same name, new object — CT registration is tied to the object, not the
// name, so a fresh object never inherits it). Distinct from TABLE_ERROR_NUMBERS:
// the table exists and is readable, so this isn't an access problem — it's a
// stale-detection-state problem the poller can self-heal from (see
// pollOneMssqlPipeline's 'ct_reset' handling), never a reason to pause.
const CT_RESET_ERROR_NUMBERS = new Set([22105]);

/* eslint-disable @typescript-eslint/no-explicit-any -- error shapes are untyped */
export function classifyMssqlPollError(err: unknown): 'global' | 'table' | 'transient' | 'ct_reset' {
  const num = Number((err as any)?.number ?? (err as any)?.originalError?.info?.number ?? NaN);
  if (GLOBAL_ERROR_NUMBERS.has(num)) return 'global';
  if (CT_RESET_ERROR_NUMBERS.has(num)) return 'ct_reset';
  if (TABLE_ERROR_NUMBERS.has(num)) return 'table';
  const code = String((err as any)?.code ?? '');
  if (code === 'ELOGIN') return 'global';
  if (code === 'ETIMEOUT' || code === 'ESOCKET' || code === 'ECONNRESET') return 'transient';
  const msg = String((err as any)?.message ?? err ?? '').toLowerCase();
  if (msg.includes('login failed') || msg.includes('cannot open database')) return 'global';
  if (msg.includes('change tracking is not enabled')) return 'ct_reset';
  if (msg.includes('invalid object name') || msg.includes('permission was denied')) return 'table';
  return 'transient';
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * True when an Azure SQL service objective string identifies the SERVERLESS
 * tier (auto-pausing — polling cadence must stretch so Prism doesn't hold the
 * database awake; see docs/MSSQL_PORT_PLAN.md §2.3). Serverless objectives
 * carry an `_S_` compute marker: GP_S_Gen5_2, HS_S_Gen5_4, …
 * Provisioned tiers (GP_Gen5_2, S0, P1, Basic) and on-prem (null) are false.
 */
export function isServerlessAzureTier(serviceObjective: string | null | undefined): boolean {
  if (!serviceObjective) return false;
  return /^[A-Z]+_S_/i.test(String(serviceObjective).trim());
}
