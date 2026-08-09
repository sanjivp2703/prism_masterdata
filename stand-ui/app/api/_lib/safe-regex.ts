/**
 * Linear-time regex matching for user-authored naming conventions.
 *
 * WHY THIS EXISTS
 *
 * A column spec can carry a naming-convention regex, and Prism tests candidate
 * names against it during auto-group. JavaScript's engine backtracks, so some
 * patterns take exponential time: `(a+)+b` is six characters and never returns
 * on a 40-character input. Node runs on ONE thread and a running regex cannot
 * be interrupted — no timeout, no cancel — so such a pattern freezes the entire
 * installation: the UI stops responding, the poller stops detecting, every
 * pipeline stops standardizing. Nothing crashes and nothing logs; the process
 * just sits there, which makes it miserable to diagnose.
 *
 * Three mitigations existed and none of them was a bound: a save-time static
 * screen (its own docstring calls it conservative and "not a proof of safety"),
 * a 500-char cap on the pattern, and a 200-char cap on the input. That last one
 * was measured NOT to help — a catastrophic pattern against a 200-char input
 * had still not returned after 60 seconds, and these patterns hang at ~40
 * characters, so no cap that still admits real names can bound it (SPEC-03).
 *
 * RE2 removes the failure mode instead of narrowing it. It is a different
 * engine with no backtracking at all, so match time is linear in the input.
 * Measured on the pattern above against a 200-char input: 27 ms, versus JS not
 * finishing. Decision recorded 2026-08-08 (option A of four).
 *
 * THE TRADE-OFF, STATED HONESTLY
 *
 * RE2 cannot express backreferences (`\1`), lookahead (`(?!…)`) or lookbehind
 * (`(?<=…)`) — those features are what make backtracking necessary in the first
 * place. Naming conventions rarely need them, and `compileSafeRegex` returns a
 * clear error naming the construct so a user who tries gets told why rather
 * than seeing a silent failure.
 *
 * NEVER fall back to `new RegExp` when this returns null. That would reintroduce
 * exactly the hang this module exists to prevent.
 *
 * Server-only: this pulls in a wasm module and must not reach the browser
 * bundle. The client keeps a plain `new RegExp` check for live form feedback —
 * a hang there costs the user their own tab, not the installation — and the
 * server is the authority on what is actually accepted.
 */
import 'server-only';

import { RE2 } from 're2-wasm';

export interface SafeRegex {
  /** Whole-string match. Linear time — cannot hang. */
  test(value: string): boolean;
}

/**
 * Compile an ANCHORED matcher (the whole name must match, as the convention
 * intends). Returns null when the pattern cannot be compiled by RE2 — either
 * because it is malformed or because it uses a backtracking-only construct.
 */
export function compileSafeRegex(source: string): SafeRegex | null {
  const src = String(source ?? '').trim();
  if (!src) return null;
  try {
    const re = new RE2(`^(?:${src})$`, 'u');
    return { test: (value: string) => re.test(String(value ?? '')) };
  } catch {
    return null;
  }
}

/**
 * Save-time validation. Returns null when the pattern is fine, or a
 * user-facing explanation when it is not.
 *
 * Kept separate from compileSafeRegex so the save path can explain WHY, while
 * the runtime path only needs to know whether it can enforce.
 */
export function safeRegexError(source: string): string | null {
  const src = String(source ?? '').trim();
  if (!src) return null;
  try {
    new RE2(`^(?:${src})$`, 'u');
    return null;
  } catch (err) {
    const raw = String((err as { message?: unknown } | null)?.message ?? '');
    // Name the unsupported construct rather than leaking the engine's syntax
    // error, so the user knows what to change.
    if (/invalid escape sequence: \\\d/.test(raw)) {
      return 'This pattern uses a backreference (like \\1), which Prism cannot evaluate safely. Rewrite it by spelling out the repeated part.';
    }
    if (/\(\?<[=!]/.test(raw) || /invalid perl operator: \(\?</.test(raw)) {
      return 'This pattern uses lookbehind ((?<=…) or (?<!…)), which Prism cannot evaluate safely. Rewrite it without lookbehind.';
    }
    if (/invalid perl operator: \(\?[=!]/.test(raw)) {
      return 'This pattern uses lookahead ((?=…) or (?!…)), which Prism cannot evaluate safely. Rewrite it without lookahead — for a "must not contain" rule, use a character class or a naming rule instead.';
    }
    return 'The regex pattern is not valid, or uses a feature Prism cannot evaluate safely.';
  }
}
