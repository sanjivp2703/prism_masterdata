/**
 * Structured naming-convention rules for a per-column standardization spec.
 *
 * Pure module (no server-only deps) — imported by both the ColumnSpecEditor UI
 * and the LLM grouping enforcement so the two always agree on the rule schema,
 * the prompt instructions, and the deterministic normalization.
 *
 * Each "group" is a single-select: the user picks 0 or 1 option. Some options
 * carry numeric params (max words, character limits). Enforcement is two-pronged,
 * mirroring the regex approach:
 *   1. describeConventionRules → instructions injected into the LLM prompt.
 *   2. applyConventionRules    → deterministic normalization of the model's output
 *      for the mechanical rules (case, spaces, special chars, etc.).
 *   3. validateConventionViolations → constraints that can't be safely auto-fixed
 *      (word count, length); failures trigger a correction LLM round, then drop.
 */

export interface RuleOption {
  id:     string;
  label:  string;
  params?: ('n' | 'min' | 'max')[];   // numeric inputs this option needs
}
export interface RuleGroup {
  id:      string;
  section: 'Content' | 'Form' | 'Constraints';
  label:   string;
  options: RuleOption[];
}

export const RULE_GROUPS: RuleGroup[] = [
  // ── Content ──────────────────────────────────────────────────────────────
  { id: 'leading_articles', section: 'Content', label: 'Articles & prepositions', options: [
    { id: 'strip', label: 'Strip leading articles (The Walt Disney Company → Walt Disney Company)' },
  ] },
  { id: 'corporate_suffix', section: 'Content', label: 'Corporate suffixes', options: [
    { id: 'strip',      label: 'Strip (AT&T Inc → AT&T)' },
    { id: 'normalize',  label: 'Normalize to standard form (Incorporated → Inc.)' },
  ] },
  { id: 'ampersand', section: 'Content', label: 'Ampersands', options: [
    { id: 'keep',      label: 'Keep as &' },
    { id: 'spell_out', label: 'Spell out as "and"' },
    { id: 'drop',      label: 'Drop' },
  ] },
  { id: 'abbreviation', section: 'Content', label: 'Abbreviations', options: [
    { id: 'expand', label: 'Always expand (AT&T → American Telephone and Telegraph)' },
    { id: 'short',  label: 'Always prefer short form' },
  ] },
  { id: 'numbers', section: 'Content', label: 'Numbers', options: [
    { id: 'digits',    label: 'Keep as digits (3M)' },
    { id: 'spell_out', label: 'Spell out (Three M)' },
  ] },
  // ── Form ─────────────────────────────────────────────────────────────────
  { id: 'case', section: 'Form', label: 'Case', options: [
    { id: 'lower', label: 'All lowercase' },
    { id: 'upper', label: 'All uppercase' },
    { id: 'title', label: 'Title case' },
  ] },
  { id: 'acronyms', section: 'Form', label: 'Acronyms (overrides case rule for acronyms)', options: [
    { id: 'force_caps',  label: 'Force all caps (ibm → IBM)' },
    { id: 'follow_case', label: 'Follow case rule (ibm, IBM, or Ibm)' },
  ] },
  { id: 'spaces', section: 'Form', label: 'Spaces', options: [
    { id: 'allow',       label: 'Allow spaces' },
    { id: 'underscore',  label: 'Replace with underscore' },
    { id: 'hyphen',      label: 'Replace with hyphen' },
    { id: 'concatenate', label: 'Concatenate (no spaces)' },
  ] },
  { id: 'special_chars', section: 'Form', label: 'Special characters (applied after spaces rule)', options: [
    { id: 'allow_all',        label: 'Allow all' },
    { id: 'alnum_periods',    label: 'Alphanumeric + periods (U.S.A.)' },
    { id: 'alnum_spaces',     label: 'Alphanumeric + spaces only' },
    { id: 'alnum_underscore', label: 'Alphanumeric + underscore only' },
    { id: 'alnum_only',       label: 'Alphanumeric only' },
  ] },
  { id: 'trailing_punct', section: 'Form', label: 'Trailing punctuation', options: [
    { id: 'strip', label: 'Strip' },
  ] },
  // ── Constraints ──────────────────────────────────────────────────────────
  { id: 'word_count', section: 'Constraints', label: 'Word count', options: [
    { id: 'single', label: 'Single word only' },
    { id: 'max',    label: 'Maximum words', params: ['n'] },
  ] },
  { id: 'length', section: 'Constraints', label: 'Length', options: [
    { id: 'min',   label: 'Minimum characters', params: ['min'] },
    { id: 'max',   label: 'Maximum characters', params: ['max'] },
    { id: 'range', label: 'Target range',       params: ['min', 'max'] },
  ] },
];

export interface RuleSelection { value: string; n?: number; min?: number; max?: number }
export type ConventionRules = Record<string, RuleSelection>;

/** True if any group has a selection. */
export function hasAnyRule(rules: ConventionRules | null | undefined): boolean {
  return !!rules && Object.values(rules).some(r => r && r.value);
}

/** Drop empty / invalid selections; keep only known groups/options. */
export function sanitizeConventionRules(input: unknown): ConventionRules {
  const out: ConventionRules = {};
  if (!input || typeof input !== 'object') return out;
  for (const group of RULE_GROUPS) {
    const sel = (input as any)[group.id];
    if (!sel || typeof sel !== 'object') continue;
    const opt = group.options.find(o => o.id === sel.value);
    if (!opt) continue;
    const entry: RuleSelection = { value: opt.id };
    for (const p of opt.params ?? []) {
      const raw = Number(sel[p]);
      if (Number.isFinite(raw) && raw > 0) entry[p] = Math.floor(raw);
    }
    out[group.id] = entry;
  }
  return out;
}

// ── Prompt instructions ───────────────────────────────────────────────────────

/** Human-readable instruction lines for the selected rules (for the LLM prompt). */
export function describeConventionRules(rules: ConventionRules | null | undefined): string[] {
  if (!rules) return [];
  const lines: string[] = [];
  const v = (id: string) => rules[id]?.value;

  if (v('leading_articles') === 'strip') lines.push('Remove any leading article ("The", "A", "An").');
  if (v('corporate_suffix') === 'strip')     lines.push('Remove corporate/legal suffixes (Inc, Corp, LLC, Ltd, Co, Company, Group, etc.).');
  if (v('corporate_suffix') === 'normalize') lines.push('Write corporate suffixes in standard abbreviated form (Incorporated→Inc., Corporation→Corp., Limited→Ltd., Company→Co.).');
  if (v('ampersand') === 'keep')      lines.push('Keep ampersands written as "&".');
  if (v('ampersand') === 'spell_out') lines.push('Spell out ampersands as the word "and".');
  if (v('ampersand') === 'drop')      lines.push('Drop ampersands entirely.');
  if (v('abbreviation') === 'expand') lines.push('Always EXPAND abbreviations/acronyms to the full name (e.g., "AT&T" → "American Telephone and Telegraph").');
  if (v('abbreviation') === 'short')  lines.push('Always prefer the SHORT/abbreviated form of a name when one exists.');
  if (v('numbers') === 'digits')      lines.push('Write numbers as digits (e.g., "3M").');
  if (v('numbers') === 'spell_out')   lines.push('Spell out numbers as words (e.g., "Three M").');

  if (v('case') === 'lower') lines.push('Write the entire name in lowercase.');
  if (v('case') === 'upper') lines.push('Write the entire name in UPPERCASE.');
  if (v('case') === 'title') lines.push('Write the name in Title Case.');
  if (v('acronyms') === 'force_caps')  lines.push('Always write acronyms in ALL CAPS (e.g., "ibm" → "IBM"), overriding the case rule for those tokens.');
  if (v('acronyms') === 'follow_case') lines.push('Acronyms follow the same case rule as the rest of the name.');
  if (v('spaces') === 'allow')       lines.push('Separate words with spaces.');
  if (v('spaces') === 'underscore')  lines.push('Replace spaces with underscores ("_").');
  if (v('spaces') === 'hyphen')      lines.push('Replace spaces with hyphens ("-").');
  if (v('spaces') === 'concatenate') lines.push('Use NO spaces — concatenate the words together.');
  if (v('special_chars') === 'alnum_periods')    lines.push('Use only letters, digits, and periods.');
  if (v('special_chars') === 'alnum_spaces')     lines.push('Use only letters, digits, and spaces.');
  if (v('special_chars') === 'alnum_underscore') lines.push('Use only letters, digits, and underscores.');
  if (v('special_chars') === 'alnum_only')       lines.push('Use only letters and digits (no spaces or punctuation).');
  if (v('trailing_punct') === 'strip') lines.push('The name must not end with punctuation.');

  const wc = rules['word_count'];
  if (wc?.value === 'single')          lines.push('The name MUST be a single word.');
  else if (wc?.value === 'max' && wc.n) lines.push(`The name MUST be at most ${wc.n} word(s).`);
  const len = rules['length'];
  if (len?.value === 'min' && len.min)        lines.push(`The name MUST be at least ${len.min} characters long.`);
  else if (len?.value === 'max' && len.max)   lines.push(`The name MUST be at most ${len.max} characters long.`);
  else if (len?.value === 'range' && len.min && len.max) lines.push(`The name MUST be between ${len.min} and ${len.max} characters long.`);

  return lines;
}

// ── Deterministic normalization ───────────────────────────────────────────────

// Conservative legal suffixes that are safe to strip mechanically. Ambiguous ones
// (Co, Company, Group, Partners) are left to the LLM prompt to avoid mangling
// names like "Boston Consulting Group" / "McKinsey & Company".
const SUFFIX_STRIP_RE = /[\s,]+(incorporated|inc|corporation|corp|l\.?l\.?c|l\.?l\.?p|p\.?l\.?c|l\.?p|limited|ltd|gmbh|ag|s\.?a|n\.?v|b\.?v|pty|plc)\.?\s*$/i;

const SUFFIX_NORMALIZE: [RegExp, string][] = [
  [/\bincorporated\b\.?/gi, 'Inc.'],
  [/\bcorporation\b\.?/gi,  'Corp.'],
  [/\blimited\b\.?/gi,      'Ltd.'],
  [/\bcompany\b\.?/gi,      'Co.'],
];

function applyCase(name: string, caseRule: string | undefined, acronymRule: string | undefined): string {
  if (!caseRule && acronymRule !== 'force_caps') return name;
  const forceCaps = acronymRule === 'force_caps';
  // Hyphens/underscores are word boundaries too — title-casing "t-mobile"
  // must yield "T-Mobile", not "T-mobile".
  return name.split(/([\s\-_]+)/).map(tok => {
    if (!tok || /^[\s\-_]+$/.test(tok)) return tok;
    const isAcronym = tok.length >= 2 && /[A-Z]/.test(tok) && tok === tok.toUpperCase();
    if (forceCaps && isAcronym) return tok.toUpperCase();   // override case rule for acronyms
    switch (caseRule) {
      case 'lower': return tok.toLowerCase();
      case 'upper': return tok.toUpperCase();
      case 'title': return tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase();
      default:      return tok;
    }
  }).join('');
}

/**
 * Apply the mechanical rules to a model-proposed name, in Content→Form order.
 * Semantic rules (abbreviation expand/short, number spell-out) are LLM-driven and
 * intentionally NOT applied here. Constraints (word count, length) are validated,
 * not mutated (truncating a name would corrupt it).
 */
export function applyConventionRules(name: string, rules: ConventionRules | null | undefined): string {
  if (!rules || !name) return name;
  let out = name.trim();
  const v = (id: string) => rules[id]?.value;

  // Content
  if (v('leading_articles') === 'strip') out = out.replace(/^(the|a|an)\s+/i, '');
  if (v('corporate_suffix') === 'strip') {
    let prev: string;
    do { prev = out; out = out.replace(SUFFIX_STRIP_RE, ''); } while (out !== prev);   // strip repeated suffixes
  } else if (v('corporate_suffix') === 'normalize') {
    for (const [re, rep] of SUFFIX_NORMALIZE) out = out.replace(re, rep);
  }
  if (v('ampersand') === 'spell_out') out = out.replace(/\s*&\s*/g, ' and ');
  else if (v('ampersand') === 'drop') out = out.replace(/\s*&\s*/g, ' ');

  // Form — case first (needs word boundaries), then spaces, then special chars.
  out = applyCase(out, v('case'), v('acronyms'));

  const sp = v('spaces');
  if (sp === 'underscore')       out = out.replace(/\s+/g, '_');
  else if (sp === 'hyphen')      out = out.replace(/\s+/g, '-');
  else if (sp === 'concatenate') out = out.replace(/\s+/g, '');
  else                           out = out.replace(/\s+/g, ' ');   // collapse

  const sc = v('special_chars');
  if (sc === 'alnum_periods')         out = out.replace(/[^A-Za-z0-9.]/g, '');
  else if (sc === 'alnum_spaces')     out = out.replace(/[^A-Za-z0-9 ]/g, '');
  else if (sc === 'alnum_underscore') out = out.replace(/[^A-Za-z0-9_]/g, '');
  else if (sc === 'alnum_only')       out = out.replace(/[^A-Za-z0-9]/g, '');

  if (v('trailing_punct') === 'strip') out = out.replace(/[^\p{L}\p{N})\]]+$/u, '');

  return out.trim();
}

/**
 * Return constraint violations that deterministic normalization can't fix
 * (word count + length). An empty array means the name satisfies them.
 */
export function validateConventionViolations(name: string, rules: ConventionRules | null | undefined): string[] {
  if (!rules) return [];
  // An empty name must be reported as a violation, never treated as "nothing to
  // check". Previously this short-circuited on `!name` too, so when a mechanical
  // rule reduced a typed name to '' (e.g. special_chars='alnum_only' applied to
  // '---') the caller got ZERO violations back and committed an empty group
  // name. Note the word-count and length checks below cannot catch it either:
  // an empty string trivially satisfies "at most N words", so a configured
  // length:{min} rule was skipped along with everything else. Flag it here.
  if (!name || !name.trim()) return ['must not be empty'];
  const out: string[] = [];

  // The name must ALREADY satisfy the mechanical rules — not merely be
  // fixable by them.
  //
  // Callers apply applyConventionRules first and fall back to the typed value
  // when the transform yields '' (`applyConventionRules(x, rules) || x`). That
  // fallback hands an UNTRANSFORMED name to this function, and the checks below
  // only cover word count and length — so a name like '---' under an
  // `alnum_only` convention produced zero violations and was committed as the
  // group's display name, in visible breach of the very rule that had just
  // emptied it (REV-11; reproduced with the real functions before fixing).
  //
  // Comparing against the transform catches EVERY mechanical rule rather than
  // special-casing special_chars: if normalizing would change the name, the
  // name does not currently conform. Cheap, and it cannot drift as rules are
  // added — a new mechanical rule is covered the day it ships.
  const normalized = applyConventionRules(name, rules);
  if (!normalized || !normalized.trim()) {
    // The rules strip the name to nothing — it contains NO conforming content
    // at all (e.g. '---' under alnum_only). Guarding this with a truthiness
    // check on `normalized` would skip exactly this case, which is the one that
    // started the bug.
    out.push('contains no characters allowed by this column\'s naming rules');
  } else if (normalized !== name) {
    out.push(`must be written as "${normalized}"`);
  }

  const wordCount = name.trim().split(/\s+/).filter(Boolean).length;

  const wc = rules['word_count'];
  if (wc?.value === 'single' && wordCount > 1) out.push('must be a single word');
  else if (wc?.value === 'max' && wc.n && wordCount > wc.n) out.push(`must be at most ${wc.n} word(s)`);

  const len = rules['length'];
  const L = name.length;
  if (len?.value === 'min' && len.min && L < len.min)      out.push(`must be at least ${len.min} characters`);
  else if (len?.value === 'max' && len.max && L > len.max) out.push(`must be at most ${len.max} characters`);
  else if (len?.value === 'range' && len.min && len.max && (L < len.min || L > len.max))
    out.push(`must be between ${len.min} and ${len.max} characters`);

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Catastrophic-backtracking (ReDoS) screening for user-supplied regex
// conventions.
//
// WHY A LENGTH CAP IS NOT ENOUGH: the spec route caps regex conventions at 500
// characters and credits that with bounding ReDoS exposure. It does not. The
// SIX-character pattern `(a+)+b` is accepted, and testing it took a measured
// 246 ms / 698 ms / 11,311 ms against 23 / 27 / 31-character inputs — growth is
// exponential in the INPUT length, not the pattern length, so ~40-50 characters
// hangs effectively forever. That matters because violatesConvention() applies
// the pattern to RAW SOURCE LITERALS, whose length the customer controls, and
// Prism is a single Node process: one hanging match is a whole-installation
// outage, not a slow request.
//
// This is a deliberately CONSERVATIVE static screen, not a proof of safety.
// It rejects the classic exponential shapes — a quantified group whose body is
// itself quantified, and a quantified group containing alternation plus a
// quantifier. It can miss exotic constructions, so treat it as defence in
// depth. The genuinely complete fix is a linear-time engine (RE2) or running
// every match in a killable worker; both are larger changes than this screen.

/** True when `src` compiles but has a shape known to backtrack exponentially. */
export function isProbablyCatastrophicRegex(src: string): boolean {
  // Walk the pattern tracking escapes, character classes and group nesting, so
  // a quantifier inside `[...]` or after `\` is never mistaken for a real one.
  interface Frame { bodyStart: number; hasQuantifier: boolean; hasAlternation: boolean }
  const stack: Frame[] = [];
  let inClass = false;

  const isQuantAt = (i: number): boolean => {
    const c = src[i];
    if (c === '*' || c === '+') return true;
    if (c === '{') {
      // {n,} / {n,m} with an upper bound > 1 (or none) can backtrack; {n} cannot.
      const close = src.indexOf('}', i);
      if (close === -1) return false;
      const body = src.slice(i + 1, close);
      if (!/^\d+(,\d*)?$/.test(body)) return false;
      const [, tail] = body.split(',');
      return tail !== undefined && (tail === '' || Number(tail) > 1);
    }
    return false;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }                 // escaped — skip the pair
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }

    if (c === '(') { stack.push({ bodyStart: i + 1, hasQuantifier: false, hasAlternation: false }); continue; }

    if (c === ')') {
      const frame = stack.pop();
      if (!frame) continue;                            // unbalanced — compile check catches it
      // Is this group itself quantified?
      let j = i + 1;
      if (j < src.length && isQuantAt(j)) {
        // Quantified group whose body also quantifies, or offers overlapping
        // alternatives — the two classic exponential shapes.
        if (frame.hasQuantifier || frame.hasAlternation) return true;
      }
      // A nested group's properties propagate outward: (?:(a+))+ is still bad.
      const parent = stack[stack.length - 1];
      if (parent) {
        if (frame.hasQuantifier) parent.hasQuantifier = true;
        if (frame.hasAlternation) parent.hasAlternation = true;
      }
      continue;
    }

    const top = stack[stack.length - 1];
    if (!top) continue;                                // top-level quantifiers are fine
    if (c === '|') { top.hasAlternation = true; continue; }
    if (isQuantAt(i)) top.hasQuantifier = true;
  }

  return false;
}

/**
 * Longest string a convention regex is ever run against.
 *
 * NO LONGER a ReDoS mitigation — that job moved to RE2 (see safe-regex.ts),
 * a linear-time engine that cannot backtrack, so match cost is bounded by
 * construction rather than by capping the input. This cap now serves only its
 * plain purpose: a name longer than 200 characters is not an acceptable alias
 * anyway (it matches the cap both review UIs and sanitizeProposedName already
 * enforce), so treating it as a violation routes it to the name-fix path.
 *
 * The history is kept because the reasoning was wrong once and should not be
 * re-adopted: capping the input was believed to bound the hazard, and it did
 * not.
 *
 * Backtracking cost grows with input length, so capping the input shrinks the
 * exposure, but it does NOT eliminate it: a classic catastrophic pattern was
 * measured against a 200-character input and had still not returned after 60
 * seconds (SPEC-03, empirically verified). Catastrophic patterns hang on inputs
 * of ~40 characters, so no cap that still admits real names can bound this.
 *
 * The genuinely complete fix is an execution-time bound at the match sites —
 * a killable worker thread, or a linear-time engine such as RE2 — which is an
 * open decision (new dependency vs. worker subsystem). Until then the layered
 * mitigations are: the save-time static screen (isProbablyCatastrophicRegex,
 * which its own docstring calls conservative and not a proof of safety), the
 * 500-char pattern cap, and this input cap. A regex whose shape evades the
 * screen can still hang the single Node process for the whole installation,
 * and POST /api/column-specs is requireValidSession, not admin-only. The save-time `isProbablyCatastrophicRegex`
 * screen is, by its own docstring, "a deliberately CONSERVATIVE static screen,
 * not a proof of safety" that "can miss exotic constructions" — and the runtime
 * `.test()` calls run synchronously on the single Node process, where a hang is
 * a whole-installation outage, not one slow request. So the screen alone is not
 * enough (SPEC-03).
 *
 * 200 matches the alias-name cap already enforced in both review UIs and
 * `sanitizeProposedName`, so no legitimate name is affected: a name longer than
 * this is already rejected elsewhere. The values being tested are raw source
 * literals, which have no length cap of their own.
 */
export const MAX_CONVENTION_TEST_LEN = 200;

/**
 * Whole-string convention match with the input length-capped.
 *
 * Returns false for over-long input rather than testing it — the caller treats
 * that as "violates the convention", which is both true (an over-long name is
 * not acceptable anyway) and the safe direction: it routes the value to the
 * name-fix path instead of running an unbounded match on it.
 */
export function conventionMatches(
  // Structurally typed so this pure module (shared with the browser) works with
  // BOTH engines: the server passes an RE2 matcher from safe-regex.ts, the
  // client passes a plain RegExp for live form feedback.
  re: { test(value: string): boolean } | null,
  value: string,
): boolean {
  if (!re) return true;
  if (!value || value.length > MAX_CONVENTION_TEST_LEN) return false;
  return re.test(value);
}
