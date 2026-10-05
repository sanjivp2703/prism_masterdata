/**
 * Canonical normalization for literal MATCHING only.
 *
 * Mirrors the internal schema's PRISM_NORMALIZE Snowflake JavaScript UDF
 * EXACTLY (same JS engine semantics) so in-memory matching/dedup agrees with the
 * SQL match/join. If you change one, change the other (see 01_internal_tables.sql).
 *
 * Folds case, normalizes Unicode to NFC, strips control characters, and
 * collapses/trims whitespace, so byte-variant spellings of the same value
 * ("AT&T " vs "at&t", NFD vs NFC, stray control chars) compare equal.
 *
 * The ORIGINAL value is always what gets stored/displayed (so the LLM still sees
 * casing — useful for acronyms); this is applied only when comparing/deduping.
 */
export function normalizeLiteral(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value).normalize('NFC');
  // strip control chars (C0 0-31, DEL 127, C1 128-159) via char codes
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 31 || c === 127 || (c >= 128 && c <= 159)) continue;
    out += s.charAt(i);
  }
  // collapse whitespace runs, trim, case-fold
  return out.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A source value Prism treats like NULL: nothing to standardize. True for NULL,
 * '' and anything that normalizes to '' (whitespace-only, control-char-only).
 *
 * Why this exists (live-found 2026-09-14 on the first client-test install):
 * every SQL path counted such a value as a source value (`col IS NOT NULL` —
 * '' is NOT NULL on every warehouse), while every app-side path dropped it
 * (`filter(Boolean)`, `if (!val)`, the alias-name filter). The value therefore
 * sat in the "Unstandardized" stat forever with no path that could ever write
 * it to the lookup, and both standardize buttons were no-ops. The SQL
 * predicates (`notBlankSql` / the dialects' `notBlankPredicate`) and this
 * helper are the ONE definition of "blank"; keep them in agreement.
 */
export function isBlankLiteral(value: string | null | undefined): boolean {
  return normalizeLiteral(value) === '';
}

/**
 * Escape a string for safe interpolation inside a single-quoted Snowflake SQL
 * string literal (e.g. `column_data['<here>']`). Escapes backslashes FIRST,
 * then single quotes — escaping quotes alone is bypassable via a trailing
 * backslash (`foo\` + `'` → `foo\\'` breaks out of the literal).
 *
 * Prefer bind parameters wherever possible; use this only where the SQL shape
 * requires literal interpolation (VARIANT key access, etc.).
 */
export function sqlStringLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
