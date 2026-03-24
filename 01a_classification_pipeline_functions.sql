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

-- Apply a profile ruleset (ordered list) to compute normalization_value.
--
-- ruleset JSON shape (v1-ish):
-- {
--   "normalization": { "rules": [ ... ] },
--   "tokenization": { "config": { ... }, "rules": [ ... ] },
--   "token_normalization": { "rules": [ ... ] },
--   "token_normalization": { "config": { "stopword_sets": { ... } }, "rules": [ ... ] }
-- }
CREATE OR REPLACE FUNCTION APPLY_CLASSIFICATION_PIPELINE(raw_value VARCHAR, ruleset VARIANT)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
AS
$$
// Snowflake uppercases JavaScript UDF parameter names; alias to lowercase for readability.
const raw_value = RAW_VALUE;
const ruleset   = RULESET;

// Null-safe
if (raw_value === null) {
  return {
    normalization_value: null,
    tokens: null,
    tokens_count: null,
    normalized_tokens: null,
    normalized_tokens_count: null
  };
}

let s = String(raw_value);
let caseFoldAlreadyApplied = false;

// Extract ruleset sections
let normalizationRules = [];
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

    default:
      // Unknown rule: ignore (forward-compatible)
      break;
  }
}

// Pre-tokenization normalization pass: run rules with pre_tokenization: true (the default).
for (const r of normalizationRules) {
  const isObj = r && typeof r === 'object' && !Array.isArray(r);
  const name = (typeof r === 'string') ? r : (isObj ? String(r.name || '') : '');
  const enabled = isObj && Object.prototype.hasOwnProperty.call(r, 'enabled') ? Boolean(r.enabled) : true;
  const params = isObj ? (r.params || {}) : {};
  // pre_tokenization defaults to true; rules with pre_tokenization: false are deferred until after tokenization.
  const preTokenization = isObj && Object.prototype.hasOwnProperty.call(r, 'pre_tokenization')
    ? Boolean(r.pre_tokenization) : true;
  if (!name || !enabled || !preTokenization) continue;
  applyNormRule(name, params);
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

// Post-tokenization normalization pass: run rules with pre_tokenization: false on the normalized string.
// These rules run after tokenization and their output becomes the final normalization_value saved to the DB.
for (const r of normalizationRules) {
  const isObj = r && typeof r === 'object' && !Array.isArray(r);
  const name = (typeof r === 'string') ? r : (isObj ? String(r.name || '') : '');
  const enabled = isObj && Object.prototype.hasOwnProperty.call(r, 'enabled') ? Boolean(r.enabled) : true;
  const params = isObj ? (r.params || {}) : {};
  const preTokenization = isObj && Object.prototype.hasOwnProperty.call(r, 'pre_tokenization')
    ? Boolean(r.pre_tokenization) : true;
  if (!name || !enabled || preTokenization) continue; // skip pre-tokenization rules
  applyNormRule(name, params);
}

// Final normalization value persisted to metadata-bearing rows (RUN_ITEMS / RAW_VALUES).
// Reflects all normalization rules (pre-tokenization pass + post-tokenization pass).
const normalizationValue = s;

// =========================
// TOKENIZATION CONFIG (profile-configured)
// Stored under ruleset.tokenization.config, applied after tokenization rules.
// =========================
tokenList = applyPostTokenConfig(tokenList, tokenizationConfig, null);

// =========================
// TOKEN NORMALIZATION (section)
// Stored under ruleset.token_normalization.rules (or token_nomalization.rules).
// Applied to tokens AFTER tokenization + tokenization.config.
// =========================
try {
  if (Array.isArray(tokenList)) normalizedTokenList = tokenList.slice();

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
          //
          // Params:
          // - words_to_numeric (boolean):
          //    - true  => rewrite number words -> numeric token (e.g., "one" -> "1", "twenty one" -> "21")
          //    - false => rewrite numeric token -> number words (e.g., "1" -> "one", "21" -> "twenty one")
          //
          // Notes:
          // - This is deterministic + idempotent for supported ranges.
          // - Supported (numeric->words): integers 0..9999 (inclusive).
          // - Supported (words->numeric): basic English number phrases using:
          //   zero..nineteen, twenty..ninety, hundred, thousand, and (optional).
          const wordsToNumeric =
            params && typeof params === 'object' && Object.prototype.hasOwnProperty.call(params, 'words_to_numeric')
              ? Boolean(params.words_to_numeric)
              : true;

          const ONES = {
            zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9
          };
          const TEENS = {
            ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
          };
          const TENS = {
            twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
          };
          const DIGIT_TO_WORD_0_19 = [
            'zero','one','two','three','four','five','six','seven','eight','nine',
            'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'
          ];
          const TENS_WORD = {
            20: 'twenty', 30: 'thirty', 40: 'forty', 50: 'fifty', 60: 'sixty', 70: 'seventy', 80: 'eighty', 90: 'ninety'
          };

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

              if (w === 'and') {
                // allow optional "and" inside number phrases ("one hundred and two")
                if (!sawAny) break;
                i++; consumed++;
                continue;
              }

              if (Object.prototype.hasOwnProperty.call(ONES, w)) {
                current += ONES[w];
                sawAny = true;
                i++; consumed++;
                continue;
              }
              if (Object.prototype.hasOwnProperty.call(TEENS, w)) {
                current += TEENS[w];
                sawAny = true;
                i++; consumed++;
                continue;
              }
              if (Object.prototype.hasOwnProperty.call(TENS, w)) {
                current += TENS[w];
                sawAny = true;
                i++; consumed++;
                continue;
              }

              if (w === 'hundred') {
                if (!sawAny) break;
                current = current * 100;
                i++; consumed++;
                continue;
              }
              if (w === 'thousand') {
                if (!sawAny) break;
                total += current * 1000;
                current = 0;
                i++; consumed++;
                continue;
              }

              break;
            }

            if (!sawAny) return null;
            return { value: total + current, consumed };
          };

          const numberToWordsTokens = (n) => {
            if (!Number.isFinite(n) || n < 0 || n > 9999 || Math.trunc(n) !== n) return null;
            if (n < 20) return [DIGIT_TO_WORD_0_19[n]];
            if (n < 100) {
              const tens = Math.trunc(n / 10) * 10;
              const ones = n % 10;
              if (ones === 0) return [TENS_WORD[tens]];
              return [TENS_WORD[tens], DIGIT_TO_WORD_0_19[ones]];
            }
            if (n < 1000) {
              const h = Math.trunc(n / 100);
              const rem = n % 100;
              const out = [DIGIT_TO_WORD_0_19[h], 'hundred'];
              if (rem > 0) out.push(...numberToWordsTokens(rem));
              return out;
            }
            // 1000..9999
            const th = Math.trunc(n / 1000);
            const rem = n % 1000;
            const out = [DIGIT_TO_WORD_0_19[th], 'thousand'];
            if (rem > 0) out.push(...numberToWordsTokens(rem));
            return out;
          };

          if (wordsToNumeric) {
            const out = [];
            for (let i = 0; i < normalizedTokenList.length; ) {
              if (isDoNotTouchToken(normalizedTokenList[i])) {
                out.push(String(normalizedTokenList[i]));
                i += 1;
                continue;
              }
              const parsed = parseNumberWordsAt(normalizedTokenList, i);
              if (parsed && parsed.consumed > 0) {
                out.push(String(parsed.value));
                i += parsed.consumed;
              } else {
                out.push(String(normalizedTokenList[i]));
                i += 1;
              }
            }
            normalizedTokenList = out;
          } else {
            const out = [];
            for (let i = 0; i < normalizedTokenList.length; ) {
              const t = String(normalizedTokenList[i]);
              if (isDoNotTouchToken(t)) {
                out.push(t);
                i += 1;
                continue;
              }

              // Merge longest span of consecutive single-digit numeric tokens: ["1","0","1"] -> "101"
              if (/^\d$/.test(t)) {
                let j = i;
                let digits = '';
                while (j < normalizedTokenList.length) {
                  const tj = String(normalizedTokenList[j]);
                  if (isDoNotTouchToken(tj)) break;
                  if (!/^\d$/.test(tj)) break;
                  digits += tj;
                  j++;
                }

                if (j > i + 1) {
                  const n = Number(digits);
                  const words = numberToWordsTokens(Number.isFinite(n) ? Math.trunc(n) : NaN);
                  if (words) {
                    // Emit as ONE token (contains spaces) per requirement.
                    out.push(words.join(' '));
                    i = j;
                    continue;
                  }
                }
              }

              // Single token numeric rewrite: "101" -> "one hundred one" (single token)
              if (/^\d+$/.test(t)) {
                const n = Number(t);
                const words = numberToWordsTokens(Number.isFinite(n) ? Math.trunc(n) : NaN);
                if (words) {
                  out.push(words.join(' '));
                  i += 1;
                  continue;
                }
              }

              out.push(t);
              i += 1;
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
  tokens: tokenList,
  tokens_count: Array.isArray(tokenList) ? tokenList.length : null,
  normalized_tokens: normalizedTokenList,
  normalized_tokens_count: Array.isArray(normalizedTokenList) ? normalizedTokenList.length : null
};
$$;

-- Back-compat: return normalization_value only (string)
CREATE OR REPLACE FUNCTION APPLY_CLASSIFICATION_RULESET(raw_value VARCHAR, ruleset VARIANT)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
  SELECT STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(raw_value, ruleset):normalization_value::VARCHAR
$$;

-- Back-compat convenience: standard profile normalization_value from raw_value
CREATE OR REPLACE FUNCTION CLASSIFICATION_NORMALIZATION_VALUE(raw_value VARCHAR)
RETURNS VARCHAR
LANGUAGE SQL
AS
$$
  SELECT STAND_DB.STAND_INTERNAL.APPLY_CLASSIFICATION_PIPELINE(
    raw_value,
    (SELECT ruleset FROM STAND_DB.STAND_INTERNAL.CLASSIFICATION_METADATA_PROFILES WHERE profile_id = 1)
  ):normalization_value::VARCHAR
$$;
