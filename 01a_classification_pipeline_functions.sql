USE DATABASE STAND_DB;
USE SCHEMA STAND_INTERNAL;

-- ============================================================================
-- CLASSIFICATION METADATA GENERATION (UDF)
-- Central place to compute classification metadata from raw strings.
--
-- Current algorithm (v1):
--  1) Unicode NFKC normalization
--  2) Unicode hygiene: remove invisible "format" characters (category Cf)
--  3) Whitespace normalization: replace each whitespace char with ASCII space (' ')
--  4) Trim leading/trailing spaces
--  5) Collapse internal whitespace: multiple spaces -> single space
--  6) Normalize quotes: curly/typographic quote variants -> straight ASCII ' and "
--
-- Notes:
-- - Deterministic + idempotent
-- - Null-safe: NULL in -> NULL out
-- - No casing / punctuation logic beyond the steps above
-- ============================================================================

-- Apply a profile ruleset (ordered list) to compute classification metadata.
--
-- Returns: { normalization_value, cleaned_value, tokens, tokens_count,
--            normalized_tokens, normalized_tokens_count }
--
-- Ruleset JSON shape (v2 — preferred):
-- {
--   "cleaning": {
--     "rules": [
--       -- Text-hygiene rules applied before tokenization (unicode, punctuation, whitespace).
--       -- Casing is preserved in stored metadata by default. Scoring comparisons should
--       -- lower/case-fold at comparison time when case should be ignored.
--     ]
--   },
--   "normalization": {
--     "rules": [
--       -- Deterministic rewrites and stopword-style rules applied after cleaning + tokenization.
--       -- cleaned_value is set before this pass; normalization_value reflects its output.
--     ]
--   },
--   "tokenization":      { "config": { ... }, "rules": [ ... ] },
--   "token_normalization": { "config": { "stopword_sets": { ... }, ... }, "rules": [ ... ] }
-- }
--
-- Back-compat (v1): if no "cleaning" section, reads normalization.rules using the
-- pre_tokenization flag (true = pre-tokenize, false = post-tokenize). lowercase in
-- normalization.rules with pre_tokenization:false is still applied to the string (not tokens).
CREATE OR REPLACE FUNCTION APPLY_CLASSIFICATION_PIPELINE(literal_value VARCHAR, ruleset VARIANT)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
AS
$$
// Snowflake uppercases JavaScript UDF parameter names; alias to lowercase for readability.
const literal_value = LITERAL_VALUE;
const ruleset   = RULESET;

// Null-safe
if (literal_value === null) {
  return {
    normalization_value: null,
    cleaned_value: null,
    tokens: null,
    tokens_count: null,
    normalized_tokens: null,
    normalized_tokens_count: null
  };
}

let s = String(literal_value);
let caseFoldAlreadyApplied = false;

// Extract ruleset sections
let normalizationRules = [];
// cleaning.rules: all pre-tokenization text hygiene rules.
// If a legacy profile lists 'lowercase' here, it is deferred to after tokenization so
// tokenization rules (e.g. split_camel_pascal) can still see the original casing.
let cleaningRules = [];
let cleaningLowercaseEnabled = false;
let tokenizationRules = [];
let tokenNormalizationRules = [];
let tokenizationConfig = null;
let tokenNormalizationConfig = null;
let tokenNormalizationDoNotTouch = null;
let topLevelDoNotTouch = null;
let tokenNormalizationStopwordSets = null;
let topLevelStopwordSets = null;
try {
  if (ruleset && typeof ruleset === 'object') {
    // Back-compat: allow bare array or {rules:[...]} as normalization section
    if (Array.isArray(ruleset)) normalizationRules = ruleset;
    else if (Array.isArray(ruleset.rules)) normalizationRules = ruleset.rules;
    else if (ruleset.normalization && Array.isArray(ruleset.normalization.rules)) {
      normalizationRules = ruleset.normalization.rules;
    }
    // New: cleaning section (pre-tokenization hygiene rules + deferred lowercase).
    if (ruleset.cleaning && Array.isArray(ruleset.cleaning.rules)) {
      cleaningRules = ruleset.cleaning.rules;
      for (const r of cleaningRules) {
        const isObj = r && typeof r === 'object' && !Array.isArray(r);
        const name = (typeof r === 'string') ? r : (isObj ? String(r.name || '') : '');
        const enabled = isObj && Object.prototype.hasOwnProperty.call(r, 'enabled') ? Boolean(r.enabled) : true;
        if (name === 'lowercase' && enabled) { cleaningLowercaseEnabled = true; break; }
      }
    }
    if (ruleset.tokenization && Array.isArray(ruleset.tokenization.rules)) {
      tokenizationRules = ruleset.tokenization.rules;
    }
    if (ruleset.token_normalization && Array.isArray(ruleset.token_normalization.rules)) {
      tokenNormalizationRules = ruleset.token_normalization.rules;
    } else if (ruleset.token_nomalization && Array.isArray(ruleset.token_nomalization.rules)) {
      // Tolerate common misspelling
      tokenNormalizationRules = ruleset.token_nomalization.rules;
    }
    if (ruleset.tokenization && ruleset.tokenization.config && typeof ruleset.tokenization.config === 'object') {
      tokenizationConfig = ruleset.tokenization.config;
    }
    const tnSection =
      (ruleset.token_normalization && typeof ruleset.token_normalization === 'object')
        ? ruleset.token_normalization
        : ((ruleset.token_nomalization && typeof ruleset.token_nomalization === 'object')
          ? ruleset.token_nomalization
          : null);
    if (tnSection && tnSection.config && typeof tnSection.config === 'object') {
      const cfg = tnSection.config;
      tokenNormalizationConfig = cfg;

      // Parallel config: used while rules run
      const parallel = (cfg.parallel && typeof cfg.parallel === 'object') ? cfg.parallel : null;
      if (parallel && Object.prototype.hasOwnProperty.call(parallel, 'do_not_touch')) {
        tokenNormalizationDoNotTouch = parallel.do_not_touch;
      } else if (Object.prototype.hasOwnProperty.call(cfg, 'do_not_touch')) {
        // Back-compat
        tokenNormalizationDoNotTouch = cfg.do_not_touch;
      }

      // Post config: applied at the very end, in listed order
      const post = (cfg.post && typeof cfg.post === 'object') ? cfg.post : null;
      if (post && Object.prototype.hasOwnProperty.call(post, 'stopword_sets')) {
        tokenNormalizationStopwordSets = post.stopword_sets;
      } else if (Object.prototype.hasOwnProperty.call(cfg, 'stopword_sets')) {
        // Back-compat
        tokenNormalizationStopwordSets = cfg.stopword_sets;
      }
    }

    if (Object.prototype.hasOwnProperty.call(ruleset, 'do_not_touch')) {
      topLevelDoNotTouch = ruleset.do_not_touch;
    }
    if (Object.prototype.hasOwnProperty.call(ruleset, 'stopword_sets')) {
      topLevelStopwordSets = ruleset.stopword_sets;
    }
  }
} catch (e) {
  normalizationRules = [];
  cleaningRules = [];
  cleaningLowercaseEnabled = false;
  tokenizationRules = [];
  tokenNormalizationRules = [];
  tokenizationConfig = null;
  tokenNormalizationConfig = null;
  tokenNormalizationDoNotTouch = null;
  topLevelDoNotTouch = null;
  tokenNormalizationStopwordSets = null;
  topLevelStopwordSets = null;
}

// Helpers
const isUnicodeWhitespaceOrSeparator = (ch) => {
  // JS \s covers most whitespace; we also treat common separators similarly.
  // We don't collapse here; each matching char becomes a single ASCII space.
  return /\\s/u.test(ch);
};

// Tokenization rules can request protected patterns to preserve separators during punctuation-to-space.
const extraProtected = [];
for (const r of tokenizationRules) {
  const isObj = r && typeof r === 'object' && !Array.isArray(r);
  const name = (typeof r === 'string') ? r : (isObj ? String(r.name || '') : '');
  const enabled = isObj && Object.prototype.hasOwnProperty.call(r, 'enabled') ? Boolean(r.enabled) : true;
  const params = isObj ? (r.params || {}) : {};
  if (!name || !enabled) continue;

  if (name === 'preserve_important_separators') {
    const patterns = Array.isArray(params.patterns) ? params.patterns : [];
    const flags = typeof params.flags === 'string' ? params.flags : 'gu';
    for (const p of patterns) {
      const pat = String(p ?? '');
      if (pat) extraProtected.push({ pattern: pat, flags });
    }
  }
}

// If either tokenization OR token_normalization uses digit_grouping_normalization,
// preserve comma-grouped numbers so punctuation_to_space doesn't split them.
let usesDigitGrouping = false;
for (const rules of [tokenizationRules, tokenNormalizationRules]) {
  if (!Array.isArray(rules)) continue;
  for (const r of rules) {
    const isObj = r && typeof r === 'object' && !Array.isArray(r);
    const name = (typeof r === 'string') ? r : (isObj ? String(r.name || '') : '');
    const enabled = isObj && Object.prototype.hasOwnProperty.call(r, 'enabled') ? Boolean(r.enabled) : true;
    if (enabled && name === 'digit_grouping_normalization') usesDigitGrouping = true;
  }
}
if (usesDigitGrouping) {
  extraProtected.push({ pattern: '\\\\b\\\\d{1,3}(?:,\\\\d{3})+\\\\b', flags: 'gu' });
}

// ── Shared number-to-words tables (used by both Stage 3 and Stage 4) ─────────
const NUM_ONES = {
  zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9
};
const NUM_TEENS = {
  ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,
  sixteen:16,seventeen:17,eighteen:18,nineteen:19
};
const NUM_TENS = {
  twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90
};
const NUM_DIGIT_TO_WORD = [
  'zero','one','two','three','four','five','six','seven','eight','nine',
  'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'
];
const NUM_TENS_WORD = {
  20:'twenty',30:'thirty',40:'forty',50:'fifty',60:'sixty',70:'seventy',80:'eighty',90:'ninety'
};

// Converts an integer 0–9999 to an array of word parts (e.g. 22 → ["twenty","two"]).
// Returns null if out of supported range.
const numberToWordParts = (n) => {
  if (!Number.isFinite(n) || n < 0 || n > 9999 || Math.trunc(n) !== n) return null;
  if (n < 20) return [NUM_DIGIT_TO_WORD[n]];
  if (n < 100) {
    const tens = Math.trunc(n / 10) * 10;
    const ones = n % 10;
    return ones === 0 ? [NUM_TENS_WORD[tens]] : [NUM_TENS_WORD[tens], NUM_DIGIT_TO_WORD[ones]];
  }
  if (n < 1000) {
    const h = Math.trunc(n / 100);
    const rem = n % 100;
    const out = [NUM_DIGIT_TO_WORD[h], 'hundred'];
    if (rem > 0) out.push(...numberToWordParts(rem));
    return out;
  }
  const th = Math.trunc(n / 1000);
  const rem = n % 1000;
  const out = [NUM_DIGIT_TO_WORD[th], 'thousand'];
  if (rem > 0) out.push(...numberToWordParts(rem));
  return out;
};

// Converts a numeric string to a single joined word token (no spaces), first letter capitalised.
// E.g. "22" → "Twentytwo",  "1" → "One",  "101" → "Onehundredone".
// Returns null if not supported.
const numericTokenToWord = (t) => {
  if (!/^\d+$/.test(t)) return null;
  const parts = numberToWordParts(Number(t));
  if (!parts) return null;
  const joined = parts.join('');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
};

// Applies a single normalization rule to `s`.
// Captures `s` and `caseFoldAlreadyApplied` from the outer scope via closure.
function applyNormRule(name, params) {
  switch (name) {
    case 'unicode_nfkc':
      // Deterministic, idempotent
      s = s.normalize('NFKC');
      break;

    case 'remove_invisible_format':
      // Remove common invisible Unicode format characters (Cf category).
      // Covers: ZWSP, ZWNJ, ZWJ, Word Joiner, BOM, Soft Hyphen, Left-to-Right/Right-to-Left marks, etc.
      // (Unicode property escape \p{Cf} is not supported in Snowflake's JS runtime, so we enumerate explicitly.)
      s = s.replace(/[\u00AD\u200B\u200C\u200D\u200E\u200F\u2060\u2061\u2062\u2063\u2064\uFEFF]/g, '');
      break;

    case 'normalize_whitespace_to_space': {
      // Replace each whitespace char with ASCII space, 1:1 (no collapsing, no trimming)
      let out = '';
      for (const ch of s) out += (isUnicodeWhitespaceOrSeparator(ch) ? ' ' : ch);
      s = out;
      break;
    }

    case 'remove_all_spaces': {
      // Remove ALL whitespace/separator characters (useful when you want "Metro PCS" -> "MetroPCS").
      // Deterministic + idempotent. Does not insert whitespace.
      //
      // Note: if you only want to remove ASCII spaces, prefer a dedicated rule; this one removes any
      // char matched by isUnicodeWhitespaceOrSeparator (currently JS \s).
      let out = '';
      for (const ch of s) if (!isUnicodeWhitespaceOrSeparator(ch)) out += ch;
      s = out;
      break;
    }

    case 'normalize_ampersands':
      // Normalize ampersands to a word boundary token.
      // Deterministic + idempotent. Does not collapse whitespace (handled by later rules).
      // Includes fullwidth ampersand U+FF06.
      s = s.replace(/[&\uFF06]/g, ' and ');
      break;

    case 'drop_ampersands':
      // Drop ampersands entirely (contradicts normalize_ampersands if both enabled;
      // ordering in the ruleset determines the effective behavior).
      // Includes fullwidth ampersand U+FF06.
      s = s.replace(/[&\uFF06]/g, '');
      break;

    case 'slash_to_space':
      // Replace slash characters with a single ASCII space.
      // Deterministic + idempotent. Does not collapse whitespace (handled by later rules).
      // Includes:
      // - '/' U+002F
      // - '／' U+FF0F (fullwidth solidus)
      // - '∕' U+2215 (division slash)
      s = s.replace(/[\/\uFF0F\u2215]/g, ' ');
      break;

    case 'underscore_to_space':
      // Convert underscores to spaces.
      // Includes '_' U+005F and fullwidth underscore '＿' U+FF3F.
      s = s.replace(/[_\uFF3F]/g, ' ');
      break;

    case 'brackets_to_space':
      // Convert common brackets/parentheses/braces to spaces.
      // This is intentionally ASCII-focused; broader punctuation handling is covered by punctuation_to_space.
      s = s.replace(/[()[\]{}]/g, ' ');
      break;

    case 'normalize_at':
      // Normalize @ to the word 'at' (boundary-friendly).
      // Includes '@' U+0040 and fullwidth '＠' U+FF20.
      s = s.replace(/[@\uFF20]/g, ' at ');
      break;

    case 'strip_emojis_pictographs': {
      // Strip emojis / pictographs entirely.
      // Deterministic + idempotent. Does not insert whitespace.
      //
      // Preferred: Unicode property escapes for Extended_Pictographic.
      // Also remove emoji variation selectors (FE0E/FE0F) which can appear adjacent to pictographs.
      try {
        // Use new RegExp() so Snowflake's JS engine doesn't fail at compile time on \p{}.
        s = s.replace(new RegExp('\\p{Extended_Pictographic}', 'gu'), '');
      } catch (e) {
        // Fallback: BMP symbol/emoji block (U+2600-U+27BF).
        // Supplementary-plane emoji (U+1F000+) require surrogate pairs without the u flag
        // and cannot be reliably matched in a character class range in this engine.
        s = s.replace(/[\u2600-\u27BF]/g, '');
      }
      s = s.replace(/[\uFE0E\uFE0F]/g, '');
      break;
    }

    case 'deterministic_rewrites': {
      // Deterministic rewrites that must run BEFORE punctuation-to-space so meaning isn't lost.
      // Params:
      // - map: object of literal string -> replacement string
      const m = (params && typeof params === 'object') ? params.map : null;
      if (m && typeof m === 'object') {
        const keys = Object.keys(m);
        // Stable deterministic order: longer keys first, then lexicographic
        keys.sort((a, b) => (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0));
        for (const k of keys) {
          const v = m[k];
          if (typeof k !== 'string' || k.length === 0) continue;
          const rep = (v === null || v === undefined) ? '' : String(v);
          // Literal global replacement
          s = s.split(k).join(rep);
        }
      }
      break;
    }

    case 'stopword_removal': {
      // Remove stopwords from the space-separated token string.
      // Intended for normalization.rules (runs on the lowercased cleaned string after
      // tokenization), so comparisons are case-insensitive regardless of casing in params.
      //
      // Params mirror token_normalization.config.post.stopword_sets for consistency:
      //   enabled: string[] — names of the sets to activate
      //   sets:    Record<string, string[]> — named lists of stopwords
      const swEnabled = Array.isArray(params && params.enabled) ? params.enabled : [];
      const swSets = (params && typeof params.sets === 'object' && !Array.isArray(params.sets))
        ? params.sets : null;
      if (swEnabled.length === 0 || !swSets) break;

      const stopSet = new Set();
      for (const setName of swEnabled) {
        const words = Array.isArray(swSets[setName]) ? swSets[setName] : [];
        for (const w of words) {
          const sw = String(w ?? '').trim().toLowerCase();
          if (sw) stopSet.add(sw);
        }
      }
      if (stopSet.size === 0) break;

      // Split on single spaces (cleaning pass normalises whitespace),
      // drop stopwords, then rejoin. Trim to handle leading/trailing spaces
      // that could appear if a boundary token is removed.
      const kept = s.split(' ').filter(function(t) {
        return t.length > 0 && !stopSet.has(t.toLowerCase());
      });
      s = kept.join(' ');
      break;
    }

    case 'punctuation_to_space': {
      // Replace punctuation (and optionally symbol punctuation) with a single ASCII space.
      // Does NOT collapse whitespace or trim; those are separate rules.
      //
      // Params:
      // - include_symbols: boolean (default true) - if true, also treat Unicode symbols as punctuation boundaries
      // - protected_patterns: array of regex strings; matches are protected from punctuation spacing
      const includeSymbols = params && Object.prototype.hasOwnProperty.call(params, 'include_symbols')
        ? Boolean(params.include_symbols)
        : true;

      const protectedPatterns = Array.isArray(params && params.protected_patterns) ? params.protected_patterns : [];
      const mergedProtected = protectedPatterns.slice();
      for (const ep of extraProtected) mergedProtected.push(ep);
      const placeholders = [];
      let work = s;

      // Protect spans (profile-controlled exception)
      if (mergedProtected.length > 0) {
        for (let i = 0; i < mergedProtected.length; i++) {
          const item = mergedProtected[i];
          const pat = typeof item === 'string' ? String(item) : String(item?.pattern ?? '');
          if (!pat) continue;
          const flags = typeof item === 'string' ? 'gu' : String(item?.flags ?? 'gu');
          let rx;
          try {
            rx = new RegExp(pat, flags);
          } catch (e) {
            continue;
          }
          work = work.replace(rx, (m) => {
            const idx = placeholders.length;
            placeholders.push(m);
            return '\uE000' + String(idx) + '\uE001';
          });
        }
      }

      // Replace punctuation with space
      const replaceWithSpace = (rx) => (work = work.replace(rx, ' '));
      try {
        // Unicode properties (preferred)
        const cls = includeSymbols ? '[\\p{P}\\p{S}]' : '[\\p{P}]';
        // Ensure we include U+2212 (minus sign) even when symbols are excluded
        const rx = new RegExp(cls + '|\\u2212', 'gu');
        replaceWithSpace(rx);
      } catch (e) {
        // Fallback: ASCII punctuation + common Unicode dashes + minus sign.
        // Hyphen placed first in the class to avoid being treated as a range operator.
        // \[ and \] are escaped to avoid ambiguity; \\ matches a literal backslash.
        const rx = includeSymbols
          ? /[-!"#$%&'()*+,./:;<=>?@\[\\\]^_`{|}~\u2010-\u2015\u2212]/g
          : /[-!"#$%&'()*+,./:;<=>?@\[\\\]^_`{}~\u2010-\u2015\u2212]/g;
        // Note: fallback may not include all Unicode punctuation, but is deterministic.
        // Replace each punctuation char occurrence with a space (no collapsing here; Step 2 handles collapse/trim).
        work = work.replace(rx, ' ');
      }

      // Restore protected spans
      if (placeholders.length > 0) {
        work = work.replace(/\uE000(\d+)\uE001/g, (_, n) => {
          const idx = Number(n);
          return Number.isFinite(idx) && placeholders[idx] !== undefined ? placeholders[idx] : '';
        });
      }

      s = work;
      break;
    }

    case 'drop_apostrophes': {
      // Drop/normalize apostrophes in a subject-dependent way.
      // Examples:
      // - mode='remove':  o'neill -> oneill
      // - mode='space':   o'neill -> o neill
      //
      // Params:
      // - mode: 'remove' | 'space' (default 'remove')
      const mode = String((params && params.mode) ? params.mode : 'remove').toLowerCase();
      const replacement = (mode === 'space') ? ' ' : '';

      // Target common apostrophe characters (do not touch other punctuation here).
      // Note: if you want apostrophes handled *before* punctuation_to_space, include this rule earlier in the ruleset.
      s = s.replace(/['\u2019\u02BC\uFF07]/g, replacement);
      break;
    }

    case 'trim':
      // Trim only ASCII spaces (since whitespace step maps to ' ')
      s = s.replace(/^ +| +$/g, '');
      break;

    case 'collapse_internal_spaces':
      // Collapse runs of ASCII spaces to one
      s = s.replace(/ {2,}/g, ' ');
      break;

    case 'collapse_repeated_letters':
      // Collapse repeated ASCII letters: if a letter (a-z) repeats 3+ times, reduce to 1.
      // Example: verizonnnn -> verizon
      // Deterministic + idempotent.
      // Note: this targets only ASCII letters (a-z), per spec.
      s = s.replace(/([a-z])\1{2,}/gi, '$1');
      break;

    case 'drop_punctuation_runs_len_ge_2':
      // If punctuation length >= 2 (i.e., runs of 2+ punctuation chars), delete the punctuation run.
      // Example: "hello!!" -> "hello", "a--b" -> "ab", "x..." -> "x"
      // Deterministic + idempotent.
      try {
        // Unicode property escapes (preferred): all punctuation chars.
        // Use new RegExp() (not a regex literal) so Snowflake's JS engine doesn't fail at compile time.
        s = s.replace(new RegExp('\\p{P}{2,}', 'gu'), '');
      } catch (e) {
        // Fallback: ASCII punctuation only
        s = s.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]{2,}/g, '');
      }
      break;

    case 'normalize_quotes':
      // Replace only quote variants; do not remove quotes.
      // Singles -> '
      s = s.replace(/['\u2018\u2019\u201A\u201B\u02BC\uFF07]/g, "'");
      // Doubles -> "
      s = s.replace(/["\u201C\u201D\u201E\u201F\u00AB\u00BB\u2039\u203A\uFF02]/g, '"');
      break;

    case 'lowercase':
      // Explicit lowercase rule (UI-friendly alias).
      // Equivalent to case_fold: Unicode-aware lowercasing, not locale-specific.
      if (!caseFoldAlreadyApplied) s = s.toLowerCase();
      caseFoldAlreadyApplied = true;
      break;

    case 'diacritics_fold_latin': {
      // Remove diacritical marks from Latin letters only (é→e, ñ→n, ü→u).
      // - Deterministic + idempotent
      // - Null-safe at function boundary
      // - Does NOT transliterate across scripts; non-Latin scripts remain unchanged.

      // Helpers with Unicode-property support when available.
      // Use new RegExp() instead of regex literals so Snowflake's JS engine doesn't
      // fail at compile time on \p{} or treat {X} as an invalid quantifier in u-mode.
      const isMark = (ch) => {
        try { return new RegExp('\\p{M}', 'u').test(ch); } catch (e) {
          // Fallback: common combining mark blocks (single \u escapes = Unicode codepoint in regex).
          return /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]/.test(ch);
        }
      };
      const isLetter = (ch) => {
        try { return new RegExp('\\p{L}', 'u').test(ch); } catch (e) {
          // Heuristic: letters have case mappings
          return ch.toLowerCase() !== ch.toUpperCase();
        }
      };
      const isLatin = (ch) => {
        try { return new RegExp('\\p{Script=Latin}', 'u').test(ch); } catch (e) {
          // Approximate Latin ranges (covers most extended Latin).
          return /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF\u2C60-\u2C7F\uA720-\uA7FF]/.test(ch);
        }
      };

      const decomposed = s.normalize('NFD');
      let out = '';
      let lastBaseIsLatinLetter = false;

      for (const ch of decomposed) {
        if (isMark(ch)) {
          // Drop mark only if it applies to a Latin letter base character.
          if (lastBaseIsLatinLetter) continue;
          out += ch;
          continue;
        }

        out += ch;
        lastBaseIsLatinLetter = isLatin(ch) && isLetter(ch);
      }

      // Recompose to keep representation stable for non-Latin scripts / remaining marks.
      s = out.normalize('NFC');
      break;
    }

    case 'number_word_digit_rewrite': {
      // String-level numeric→word rewrite for normalization.rules (Stage 3).
      // Splits `s` on spaces, converts each purely-numeric token to its joined
      // word form (e.g. "22" → "twentytwo", "101" → "onehundredone"), then
      // rejoins. Multi-word numbers become a single contiguous token with no
      // internal spaces so they are unambiguously one token in later stages.
      // Only the numeric→words direction is supported here (words_to_numeric
      // is deferred to Stage 4 where token parsing is available).
      const parts = s.split(' ');
      const converted = [];
      for (const part of parts) {
        if (part.length === 0) continue;
        const word = numericTokenToWord(part);
        converted.push(word !== null ? word : part);
      }
      s = converted.join(' ');
      break;
    }

    default:
      // Unknown rule: ignore (forward-compatible)
      break;
  }
}

// ── Cleaning pass (pre-tokenization) ────────────────────────────────────────
// When a 'cleaning' section exists in the ruleset, all cleaning.rules are applied here
// EXCEPT 'lowercase', which is supported for legacy profiles and deferred until after
// tokenization so that tokenization rules (split_camel_pascal, split_alpha_numeric_boundary,
// etc.) can still see the original casing. The standard seeded profile does not use it,
// so cleaned_value and standard tokens preserve capitalization.
//
// Back-compat: if no cleaning section is present, falls back to normalization.rules
// filtered to those with pre_tokenization:true (the legacy behaviour).
if (cleaningRules.length > 0) {
  for (const r of cleaningRules) {
    const isObj = r && typeof r === 'object' && !Array.isArray(r);
    const name = (typeof r === 'string') ? r : (isObj ? String(r.name || '') : '');
    const enabled = isObj && Object.prototype.hasOwnProperty.call(r, 'enabled') ? Boolean(r.enabled) : true;
    const params = isObj ? (r.params || {}) : {};
    if (!name || !enabled || name === 'lowercase') continue; // lowercase deferred
    applyNormRule(name, params);
  }
} else {
  // Back-compat: run normalization rules flagged as pre-tokenization.
  for (const r of normalizationRules) {
    const isObj = r && typeof r === 'object' && !Array.isArray(r);
    const name = (typeof r === 'string') ? r : (isObj ? String(r.name || '') : '');
    const enabled = isObj && Object.prototype.hasOwnProperty.call(r, 'enabled') ? Boolean(r.enabled) : true;
    const params = isObj ? (r.params || {}) : {};
    const preTokenization = isObj && Object.prototype.hasOwnProperty.call(r, 'pre_tokenization')
      ? Boolean(r.pre_tokenization) : true;
    if (!name || !enabled || !preTokenization) continue;
    applyNormRule(name, params);
  }
}

// =========================
// TOKENIZATION (section)
// =========================
let tokenList = null;
let normalizedTokenList = null;

const splitOnSpaces = (txt) => txt.split(' ').filter((t) => t.length > 0);

const extractPostConfig = (cfg) => {
  if (!cfg || typeof cfg !== 'object') return null;
  if (cfg.post && typeof cfg.post === 'object') return cfg.post;
  // Back-compat: treat flat config object as "post"
  return cfg;
};

// Token "do_not_touch" support (applied during token normalization).
// Schema (supported in either location):
// - ruleset.token_normalization.config.parallel.do_not_touch: { enabled: [...], sets: { name: [...] } }
// - ruleset.do_not_touch (back-compat): same shape
const doNotTouchSet = (() => {
  try {
    const src = (tokenNormalizationDoNotTouch && typeof tokenNormalizationDoNotTouch === 'object')
      ? tokenNormalizationDoNotTouch
      : ((topLevelDoNotTouch && typeof topLevelDoNotTouch === 'object') ? topLevelDoNotTouch : null);
    if (!src) return new Set();

    const enabled = Array.isArray(src.enabled) ? src.enabled : [];
    const sets = (src && typeof src.sets === 'object') ? src.sets : null;
    const out = new Set();

    if (!sets || enabled.length === 0) return out;
    for (const setNameRaw of enabled) {
      const setName = String(setNameRaw ?? '');
      const words = Array.isArray(sets[setName]) ? sets[setName] : [];
      for (const w of words) {
        const sww = String(w ?? '').trim();
        if (sww) out.add(sww.toLowerCase());
      }
    }
    return out;
  } catch (e) {
    return new Set();
  }
})();

const isDoNotTouchToken = (t) => {
  try { return doNotTouchSet.has(String(t ?? '').toLowerCase()); } catch (e) { return false; }
};

const applyPostTokenConfig = (list, cfg, opts) => {
  try {
    if (!Array.isArray(list) || list.length === 0) return list;
    const post = extractPostConfig(cfg);
    if (!post || typeof post !== 'object') return list;

    const isProtected = (opts && typeof opts.isProtected === 'function') ? opts.isProtected : (() => false);
    const fallbackStopwordSets = (opts && Object.prototype.hasOwnProperty.call(opts, 'fallbackStopwordSets'))
      ? opts.fallbackStopwordSets
      : null;

    let out = list;

    let keys = Object.keys(post);
    if (fallbackStopwordSets && keys.indexOf('stopword_sets') === -1) {
      keys = ['stopword_sets', ...keys];
    }

    for (const k of keys) {
      if (k === 'stopword_sets') {
        const sw = Object.prototype.hasOwnProperty.call(post, 'stopword_sets') ? post.stopword_sets : fallbackStopwordSets;
        const enabled = Array.isArray(sw?.enabled) ? sw.enabled : [];
        const sets = (sw && typeof sw.sets === 'object') ? sw.sets : null;
        if (enabled.length > 0 && sets) {
          const stop = new Set();
          for (const setNameRaw of enabled) {
            const setName = String(setNameRaw ?? '');
            const words = Array.isArray(sets[setName]) ? sets[setName] : [];
            for (const w of words) {
              const sww = String(w ?? '').trim();
              if (sww) stop.add(sww.toLowerCase());
            }
          }
          out = out.filter((tRaw) => {
            const t = String(tRaw ?? '');
            if (isProtected(t)) return true;
            return !stop.has(t.toLowerCase());
          });
        }
        continue;
      }

      if (k === 'token_deduplication') {
        const on = Boolean(post.token_deduplication);
        if (on) {
          const deduped = [];
          let prev = null;
          let prevProtected = false;
          for (const tRaw of out) {
            const t = String(tRaw);
            const prot = isProtected(t);
            if (prot) {
              deduped.push(tRaw);
              prev = t;
              prevProtected = true;
              continue;
            }
            if (deduped.length === 0) deduped.push(tRaw);
            else if (!prevProtected && t === prev) {
              // drop
            } else deduped.push(tRaw);
            prev = t;
            prevProtected = false;
          }
          out = deduped;
        }
        continue;
      }

      if (k === 'max_token_frequency') {
        const v = post.max_token_frequency;
        if (v === null || v === undefined || v === '') continue;
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) {
          const limit = Math.trunc(n);
          const counts = new Map();
          const limited = [];
          for (const tRaw of out) {
            const t = String(tRaw);
            if (isProtected(t)) {
              limited.push(tRaw);
              continue;
            }
            const key = t;
            const c = (counts.get(key) || 0) + 1;
            counts.set(key, c);
            if (c <= limit) limited.push(tRaw);
          }
          out = limited;
        }
        continue;
      }
    }

    return out;
  } catch (e) {
    return list;
  }
};

for (const r of tokenizationRules) {
  const isObj = r && typeof r === 'object' && !Array.isArray(r);
  const name = (typeof r === 'string') ? r : (isObj ? String(r.name || '') : '');
  const enabled = isObj && Object.prototype.hasOwnProperty.call(r, 'enabled') ? Boolean(r.enabled) : true;
  if (!name || !enabled) continue;

  if (name === 'word_tokenize') {
    tokenList = splitOnSpaces(s);
    continue;
  }

  if (!Array.isArray(tokenList) || tokenList.length === 0) continue;

  if (name === 'split_alpha_numeric_boundary') {
    const out = [];
    for (const t of tokenList) {
      let x = t;
      try {
        x = x.replace(new RegExp('(\\p{L})(\\p{N})', 'gu'), '$1 $2');
      } catch (e) {
        x = x.replace(/([A-Za-z])(\d)/g, '$1 $2');
      }
      out.push(...splitOnSpaces(x));
    }
    tokenList = out;
    continue;
  }

  if (name === 'split_camel_pascal') {
    const out = [];
    for (const t of tokenList) {
      let x = t;
      try {
        x = x
          .replace(new RegExp('(\\p{Ll})(\\p{Lu})', 'gu'), '$1 $2')
          .replace(new RegExp('(\\p{Lu}+)(\\p{Lu}\\p{Ll})', 'gu'), '$1 $2');
      } catch (e) {
        x = x
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
      }
      out.push(...splitOnSpaces(x));
    }
    tokenList = out;
    continue;
  }

  if (name === 'digit_grouping_normalization') {
    // Moved to token_normalization.rules (token-level), so keep this as a no-op for forward-compat
    // if older profiles still reference it here.
    continue;
  }
}

// ── Deferred lowercase (cleaning section) ────────────────────────────────────
// When 'lowercase' is enabled in the cleaning section, apply it to each token now
// (after tokenization so CamelCase / alpha-numeric splitting saw the original casing).
// Rejoining the lowercased tokens updates s, which becomes cleaned_value.
if (cleaningLowercaseEnabled && Array.isArray(tokenList)) {
  tokenList = tokenList.map(function(t) { return String(t).toLowerCase(); });
  s = tokenList.join(' ');
}

// cleaned_value: string after cleaning pass. Capitalization is preserved unless a legacy
// lowercase rule is explicitly enabled.
// Stored on RUN_ITEMS / ALIAS_ITEMS and used for 'clean value' alias summary lookups
// and step-1 exact-match scoring.
const cleanedValue = s;

// ── Sync s to post-tokenization form ─────────────────────────────────────────
// Tokenization rules (split_alpha_numeric_boundary, split_camel_pascal, etc.) only
// update tokenList, not s. Rejoin now so the normalization pass and normalization_value
// both operate on the fully-split token stream (e.g. "C1" → "C 1", "MetroPCS" → "Metro PCS").
// cleanedValue is already captured above so this does not affect it.
if (cleaningRules.length > 0 && Array.isArray(tokenList)) {
  s = tokenList.join(' ');
}

// ── Normalization pass (post-tokenization) ────────────────────────────────────
// When a 'cleaning' section is present: all normalization.rules are deterministic
// rewrites / stopword-style rules that run here (after cleaning + tokenization).
// Back-compat: if no cleaning section, only rules with pre_tokenization:false run here.
for (const r of normalizationRules) {
  const isObj = r && typeof r === 'object' && !Array.isArray(r);
  const name = (typeof r === 'string') ? r : (isObj ? String(r.name || '') : '');
  const enabled = isObj && Object.prototype.hasOwnProperty.call(r, 'enabled') ? Boolean(r.enabled) : true;
  const params = isObj ? (r.params || {}) : {};
  if (!name || !enabled) continue;
  // Back-compat: when no cleaning section exists, skip pre-tokenization rules here.
  if (cleaningRules.length === 0) {
    const preTokenization = isObj && Object.prototype.hasOwnProperty.call(r, 'pre_tokenization')
      ? Boolean(r.pre_tokenization) : true;
    if (preTokenization) continue;
  }
  applyNormRule(name, params);
}

// Final normalization value: string after cleaning + normalization passes.
const normalizationValue = s;

// =========================
// TOKENIZATION CONFIG (profile-configured)
// Stored under ruleset.tokenization.config, applied after tokenization rules.
// =========================
tokenList = applyPostTokenConfig(tokenList, tokenizationConfig, null);

// =========================
// TOKEN NORMALIZATION (section)
// Stored under ruleset.token_normalization.rules (or token_nomalization.rules).
// Seeds from normalization_value (Stage 3 output) so that stopword removal and
// deterministic rewrites are inherited from Stage 3 rather than repeated here.
// Only purely token-level transforms (number rewrites, collapse, join, etc.) run here.
// Post-config: token_deduplication and max_token_frequency only (no stopword_sets).
// =========================
try {
  // Re-tokenize the normalized string: split on whitespace, drop empty segments.
  normalizedTokenList = normalizationValue.trim().length > 0
    ? normalizationValue.trim().split(/\s+/)
    : [];

  if (Array.isArray(normalizedTokenList) && normalizedTokenList.length > 0) {
    for (const r of tokenNormalizationRules) {
      const isObj = r && typeof r === 'object' && !Array.isArray(r);
      const name = (typeof r === 'string') ? r : (isObj ? String(r.name || '') : '');
      const enabled = isObj && Object.prototype.hasOwnProperty.call(r, 'enabled') ? Boolean(r.enabled) : true;
      const params = isObj ? (r.params || {}) : {};
      if (!name || !enabled) continue;

      switch (name) {
        case 'digit_grouping_normalization': {
          // Token-level numeric normalization:
          // - Remove comma thousands separators inside numeric-ish tokens (1,234 -> 1234)
          // - Normalize pure digits: 01 -> 1
          normalizedTokenList = normalizedTokenList.map((tRaw) => {
            let x = String(tRaw);
            if (isDoNotTouchToken(x)) return x;
            x = x.replace(/,(?=\\d{3}\\b)/g, '');
            if (/^\\d+$/.test(x)) {
              try {
                x = BigInt(x).toString();
              } catch (e) {
                x = x.replace(/^0+(\\d)/, '$1');
              }
            }
            return x;
          });
          break;
        }

        case 'number_word_digit_rewrite': {
          // Token-level bidirectional rewrite between spelled-out English numbers and digits.
          // Uses shared numberToWordParts / numericTokenToWord helpers defined at UDF top level.
          //
          // Params:
          // - words_to_numeric (boolean):
          //    - true  => rewrite number-word tokens -> a single numeric token
          //              ("one" -> "1"; consecutive words like "twenty","two" -> "22")
          //    - false => rewrite numeric tokens -> a single joined word token with no spaces
          //              ("1" -> "one", "22" -> "twentytwo", "101" -> "onehundredone")
          //
          // Supported (numeric→words): integers 0..9999.
          // Supported (words→numeric): English phrases using zero..nineteen, twenty..ninety,
          //   hundred, thousand, and (optional).
          const wordsToNumeric =
            params && typeof params === 'object' && Object.prototype.hasOwnProperty.call(params, 'words_to_numeric')
              ? Boolean(params.words_to_numeric)
              : true;

          const parseNumberWordsAt = (tokens, startIdx) => {
            let i = startIdx;
            let total = 0;
            let current = 0;
            let consumed = 0;
            let sawAny = false;
            while (i < tokens.length) {
              const raw = String(tokens[i] ?? '');
              if (isDoNotTouchToken(raw)) break;
              const w = raw.toLowerCase();
              if (w === 'and') { if (!sawAny) break; i++; consumed++; continue; }
              if (Object.prototype.hasOwnProperty.call(NUM_ONES, w))  { current += NUM_ONES[w];  sawAny = true; i++; consumed++; continue; }
              if (Object.prototype.hasOwnProperty.call(NUM_TEENS, w)) { current += NUM_TEENS[w]; sawAny = true; i++; consumed++; continue; }
              if (Object.prototype.hasOwnProperty.call(NUM_TENS, w))  { current += NUM_TENS[w];  sawAny = true; i++; consumed++; continue; }
              if (w === 'hundred')  { if (!sawAny) break; current = current * 100;          i++; consumed++; continue; }
              if (w === 'thousand') { if (!sawAny) break; total += current * 1000; current = 0; i++; consumed++; continue; }
              break;
            }
            if (!sawAny) return null;
            return { value: total + current, consumed };
          };

          if (wordsToNumeric) {
            const out = [];
            for (let i = 0; i < normalizedTokenList.length; ) {
              if (isDoNotTouchToken(normalizedTokenList[i])) { out.push(String(normalizedTokenList[i])); i++; continue; }
              const parsed = parseNumberWordsAt(normalizedTokenList, i);
              if (parsed && parsed.consumed > 0) { out.push(String(parsed.value)); i += parsed.consumed; }
              else { out.push(String(normalizedTokenList[i])); i++; }
            }
            normalizedTokenList = out;
          } else {
            // numeric→words: each numeric token becomes one joined word token (no spaces).
            const out = [];
            for (let i = 0; i < normalizedTokenList.length; ) {
              const t = String(normalizedTokenList[i]);
              if (isDoNotTouchToken(t)) { out.push(t); i++; continue; }

              // Merge a run of consecutive single-digit tokens: ["1","0","1"] -> "onehundredone"
              if (/^\d$/.test(t)) {
                let j = i;
                let digits = '';
                while (j < normalizedTokenList.length) {
                  const tj = String(normalizedTokenList[j]);
                  if (isDoNotTouchToken(tj) || !/^\d$/.test(tj)) break;
                  digits += tj; j++;
                }
                if (j > i + 1) {
                  const word = numericTokenToWord(digits);
                  if (word) { out.push(word); i = j; continue; }
                }
              }

              // Single multi-digit numeric token: "22" -> "twentytwo"
              if (/^\d+$/.test(t)) {
                const word = numericTokenToWord(t);
                if (word) { out.push(word); i++; continue; }
              }

              out.push(t); i++;
            }
            normalizedTokenList = out;
          }
          break;
        }

        case 'lowercase': {
          // Token-level: lowercase each token using Unicode-aware toLocaleLowerCase.
          normalizedTokenList = normalizedTokenList.map((tRaw) => {
            const t = String(tRaw);
            if (isDoNotTouchToken(t)) return t;
            return t.toLocaleLowerCase();
          });
          break;
        }

        case 'collapse_repeated_letters': {
          // Token-level: collapse repeated ASCII letters (3+ -> 1)
          normalizedTokenList = normalizedTokenList.map((tRaw) => {
            const t = String(tRaw);
            if (isDoNotTouchToken(t)) return t;
            return t.replace(/([a-z])\1{2,}/gi, '$1');
          });
          break;
        }

        case 'deterministic_rewrites': {
          // Token-level deterministic rewrites / synonym expansion.
          // Params:
          // - map: object of token -> replacement string (may contain spaces to expand into multiple tokens)
          const m = (params && typeof params === 'object') ? params.map : null;
          if (m && typeof m === 'object') {
            const out = [];
            for (const tRaw of normalizedTokenList) {
              const t = String(tRaw);
              if (isDoNotTouchToken(t)) {
                out.push(t);
                continue;
              }
              if (Object.prototype.hasOwnProperty.call(m, t)) {
                const v = m[t];
                const rep = (v === null || v === undefined) ? '' : String(v);
                if (rep.trim().length === 0) continue; // delete token
                out.push(...splitOnSpaces(rep));
              } else {
                out.push(t);
              }
            }
            normalizedTokenList = out;
          }
          break;
        }

        case 'join_tokens': {
          // Join all tokens into a single token (profile-scoped replacement for remove_all_spaces).
          const sep = String((params && params.separator !== undefined) ? params.separator : '');
          // Respect do_not_touch tokens by joining only runs of non-protected tokens.
          const out = [];
          let buf = [];
          for (const tRaw of normalizedTokenList) {
            const t = String(tRaw);
            if (isDoNotTouchToken(t)) {
              if (buf.length > 0) out.push(buf.join(sep));
              buf = [];
              out.push(t);
            } else {
              buf.push(t);
            }
          }
          if (buf.length > 0) out.push(buf.join(sep));
          normalizedTokenList = out;
          break;
        }

        case 'remove_all_spaces': {
          // Back-compat: treat as join_tokens with separator ''
          // Respect do_not_touch tokens by joining only runs of non-protected tokens.
          const out = [];
          let buf = [];
          for (const tRaw of normalizedTokenList) {
            const t = String(tRaw);
            if (isDoNotTouchToken(t)) {
              if (buf.length > 0) out.push(buf.join(''));
              buf = [];
              out.push(t);
            } else {
              buf.push(t);
            }
          }
          if (buf.length > 0) out.push(buf.join(''));
          normalizedTokenList = out;
          break;
        }

        default:
          // Unknown rule: ignore
          break;
      }
    }
  }
} catch (e) {
  // ignore
}

// =========================
// TOKEN NORMALIZATION CONFIG (profile-configured)
// Stored under ruleset.token_normalization.config (or token_nomalization.config).
// Applied after token_normalization.rules.
// =========================
normalizedTokenList = applyPostTokenConfig(normalizedTokenList, tokenNormalizationConfig, {
  isProtected: isDoNotTouchToken,
  fallbackStopwordSets: (tokenNormalizationStopwordSets && typeof tokenNormalizationStopwordSets === 'object')
    ? tokenNormalizationStopwordSets
    : ((topLevelStopwordSets && typeof topLevelStopwordSets === 'object') ? topLevelStopwordSets : null)
});

return {
  normalization_value: normalizationValue,
  cleaned_value: cleanedValue,
  tokens: tokenList,
  tokens_count: Array.isArray(tokenList) ? tokenList.length : null,
  normalized_tokens: normalizedTokenList,
  normalized_tokens_count: Array.isArray(normalizedTokenList) ? normalizedTokenList.length : null
};
$$;

-- Back-compat: return normalization_value only (string)
CREATE OR REPLACE FUNCTION APPLY_CLASSIFICATION_RULESET(literal_value VARCHAR, ruleset VARIANT)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
  SELECT STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(literal_value, ruleset):normalization_value::VARCHAR
$$;

-- Back-compat convenience: standard profile normalization_value from literal_value
CREATE OR REPLACE FUNCTION CLASSIFICATION_NORMALIZATION_VALUE(literal_value VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
  SELECT STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(
    literal_value,
    (SELECT ruleset FROM STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES WHERE profile_id = 1)
  ):normalization_value::VARCHAR
$$;

-- ============================================================================
-- ENRICH_RULESET_STOPWORDS
-- Merges table-driven stopword lists into a base profile ruleset before the
-- pipeline runs, implementing two-tier stopword scoping:
--
--   generic_words  — apply to every run, regardless of concept
--   concept_words  — apply only when the run belongs to a specific concept
--
-- The function locates (or creates) the `stopword_removal` rule inside
-- ruleset.normalization.rules and:
--   • writes generic_words  into params.sets.generic (when non-empty)
--   • writes concept_words  into params.sets.concept_specific (when non-empty)
--   • sets params.enabled   to every tier that still has words after merge
--
-- If LKP_STOPWORDS returns no rows, ARRAY_AGG yields NULL / empty arrays.
-- In that case we keep the profile's inline lists (and legacy `carriers`
-- becomes concept_specific when concept_specific would otherwise be empty)
-- so CREATE_RUN still strips stopwords without requiring a seeded table.
--
-- Callers can use view STAND_INTERNAL.ENRICHED_CONCEPT_RULESETS (01_internal_tables.sql)
-- so subqueries against LKP_STOPWORDS are not repeated at every call site.
-- ============================================================================
CREATE OR REPLACE FUNCTION ENRICH_RULESET_STOPWORDS(
    base_ruleset    VARIANT,
    generic_words   ARRAY,
    concept_words   ARRAY
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
AS $$
  const ruleset = JSON.parse(JSON.stringify(BASE_RULESET ?? {}));
  const gWords = Array.isArray(GENERIC_WORDS)  ? GENERIC_WORDS.filter(w => w != null).map(String)  : [];
  const cWords = Array.isArray(CONCEPT_WORDS) ? CONCEPT_WORDS.filter(w => w != null).map(String) : [];

  // Locate the stopword_removal rule in normalization.rules; create it if absent.
  if (!ruleset.normalization)                          ruleset.normalization = {};
  if (!Array.isArray(ruleset.normalization.rules))     ruleset.normalization.rules = [];
  let swRule = ruleset.normalization.rules.find(r => r && r.name === 'stopword_removal');
  if (!swRule) {
    swRule = { name: 'stopword_removal', enabled: true, params: { enabled: [], sets: {} } };
    ruleset.normalization.rules.push(swRule);
  }
  if (!swRule.params)       swRule.params = {};
  if (!swRule.params.sets)  swRule.params.sets = {};

  const sets = swRule.params.sets;
  const inlineGeneric = Array.isArray(sets.generic)
    ? sets.generic.filter((w) => w != null).map(String)
    : [];
  const inlineCarriers = Array.isArray(sets.carriers)
    ? sets.carriers.filter((w) => w != null).map(String)
    : [];
  const inlineConceptSpecific = Array.isArray(sets.concept_specific)
    ? sets.concept_specific.filter((w) => w != null).map(String)
    : [];

  // Table-driven lists win when Snowflake passed a non-empty array; otherwise
  // fall back to inline profile tiers (and carriers → concept_specific).
  sets.generic =
    gWords.length > 0 ? gWords : inlineGeneric;
  sets.concept_specific =
    cWords.length > 0
      ? cWords
      : inlineConceptSpecific.length > 0
        ? inlineConceptSpecific
        : inlineCarriers;

  const active = [];
  if ((sets.generic || []).length > 0) active.push('generic');
  if ((sets.concept_specific || []).length > 0) active.push('concept_specific');
  swRule.params.enabled = active;

  return ruleset;
$$;

-- ENRICHED_CONCEPT_RULESETS view: defined in 01_internal_tables.sql (after
-- LKP_STOPWORDS DDL + seed). Deploy 01a_classification_pipeline_functions.sql
-- before 01_internal_tables.sql so ENRICH_RULESET_STOPWORDS exists.
