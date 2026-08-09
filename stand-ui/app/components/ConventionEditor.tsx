'use client';

import { useState, useMemo } from 'react';
import { RULE_GROUPS, hasAnyRule, type ConventionRules, type RuleGroup } from '@/app/api/_lib/convention-rules';

// ── Draft model ─────────────────────────────────────────────────────────────
// The editor keeps separate text per tab so switching tabs restores what was
// typed. `rules` holds the structured single-select selections.

type ConvType = 'none' | 'regex' | 'examples' | 'natural';

export interface ConventionDraft {
  type:     ConvType;
  regex:    string;
  examples: string;
  natural:  string;
  rules:    ConventionRules;
  prestandardizedValues: string[];
}

export function emptyConventionDraft(): ConventionDraft {
  return { type: 'none', regex: '', examples: '', natural: '', rules: {}, prestandardizedValues: [] };
}

function conventionDraftActiveValue(d: ConventionDraft): string {
  return d.type === 'regex' ? d.regex : d.type === 'examples' ? d.examples : d.type === 'natural' ? d.natural : '';
}

/** True if the draft carries any convention content (a type+value, any rule, or pre-standardized values). */
export function conventionDraftHasContent(d: ConventionDraft): boolean {
  return (d.type !== 'none' && !!conventionDraftActiveValue(d).trim()) || hasAnyRule(d.rules) || d.prestandardizedValues.length > 0;
}

/**
 * Max regex-convention length, mirroring the server cap. Kept here (a pure
 * module shared with the client) so the form and the API cannot disagree — the
 * client previously enforced NO length rule at all, so a 5000-char pattern left
 * Save enabled and only failed once it reached the server (SPEC-03).
 */
export const MAX_CONVENTION_REGEX_LEN = 500;

/** null = valid / not applicable; false = invalid regex; true = valid regex. */
export function conventionRegexValid(d: ConventionDraft): boolean | null {
  if (d.type !== 'regex' || !d.regex.trim()) return null;
  if (d.regex.length > MAX_CONVENTION_REGEX_LEN) return false;
  try { new RegExp(d.regex); return true; } catch { return false; }
}

/** Normalize to the shape the APIs accept (type/value/rules/prestandardized_values). */
export function conventionDraftToConvention(d: ConventionDraft): {
  type: 'regex' | 'examples' | 'natural' | null;
  value: string;
  rules: ConventionRules | null;
  prestandardized_values: string[] | null;
} {
  const type = d.type === 'none' ? null : d.type;
  const value = type ? conventionDraftActiveValue(d).trim() : '';
  const pv = d.prestandardizedValues.map(s => s.trim()).filter(Boolean);
  return { type, value, rules: hasAnyRule(d.rules) ? d.rules : null, prestandardized_values: pv.length > 0 ? pv : null };
}

// ── Structured rule rows ────────────────────────────────────────────────────

const RULE_SECTIONS: ('Content' | 'Form' | 'Constraints')[] = ['Form', 'Content', 'Constraints'];

const TYPE_OPTIONS: { id: ConvType; label: string }[] = [
  { id: 'none',     label: 'None' },
  { id: 'regex',    label: 'Regex' },
  { id: 'examples', label: 'Examples' },
  { id: 'natural',  label: 'Description' },
];

/**
 * Which convention types Prism can mechanically CHECK, not merely ask the AI for.
 *
 * A regex can be tested against a name; so can the structured rules. "Follows
 * these examples" and a free-text description cannot — there is no mechanical
 * test, so for those types Prism tells the AI and nothing verifies the result:
 * no post-grouping check, no name-fix repair pass, and no rename guard in the
 * review UI.
 *
 * That distinction used to be invisible. Someone could paste five example names
 * and reasonably assume they were enforced, when they were guidance only
 * (SPEC-04). Modern models follow examples well, so it rarely bites — but
 * "rarely bites" is a different promise from "enforced", and the UI should not
 * imply the stronger one.
 */
export const ENFORCEABLE_CONVENTION_TYPES: ConvType[] = ['regex'];

export function isConventionEnforced(d: ConventionDraft): boolean {
  return ENFORCEABLE_CONVENTION_TYPES.includes(d.type) || hasAnyRule(d.rules);
}

/** One single-select rule group rendered as checkboxes. */
function RuleGroupRow({ group, rules, setRules }: { group: RuleGroup; rules: ConventionRules; setRules: (r: ConventionRules) => void }) {
  const sel = rules[group.id];
  function choose(optId: string) {
    const next = { ...rules };
    if (sel?.value === optId) delete next[group.id];
    else next[group.id] = { value: optId };
    setRules(next);
  }
  function setParam(p: 'n' | 'min' | 'max', val: string) {
    const next = { ...rules };
    const cur = { ...(next[group.id] ?? { value: sel?.value ?? '' }) };
    const n = Number(val);
    if (val === '' || !Number.isFinite(n)) delete (cur as any)[p];
    else (cur as any)[p] = Math.max(1, Math.floor(n));
    next[group.id] = cur as any;
    setRules(next);
  }
  return (
    <div className="py-1">
      <p className="text-[11px] font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{group.label}</p>
      <div className="flex flex-col gap-0.5">
        {group.options.map(o => {
          const on = sel?.value === o.id;
          return (
            <div key={o.id}>
              <label className="flex items-start gap-2 cursor-pointer py-0.5">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => choose(o.id)}
                  style={{ accentColor: 'var(--accent)', width: 13, height: 13, marginTop: 1, flexShrink: 0, cursor: 'pointer' }}
                />
                <span className="text-[11px] leading-snug" style={{ color: on ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                  {o.label}
                </span>
              </label>
              {on && o.params && o.params.length > 0 && (
                <div className="flex items-center gap-2 mt-0.5" style={{ marginLeft: 21 }}>
                  {o.params.map(p => (
                    <label key={p} className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {p === 'n' ? 'words' : p === 'min' ? 'min' : 'max'}
                      <input
                        type="number" min={1}
                        value={(sel as any)?.[p] ?? ''}
                        onChange={e => setParam(p, e.target.value)}
                        className="w-16 text-[11px] px-2 py-1 rounded-button border-[0.5px] outline-none"
                        style={{ borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Pre-standardized values — tag/chip list input ────────────────────────────
// Typing + Enter/comma commits one chip at a time; pasting a multi-line or
// comma-separated blob explodes it into many chips at once instead of landing
// as one literal string in the text field.

function splitPastedValues(text: string): string[] {
  return text.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
}

function TagListInput({
  values, onChange, disabled, inputStyle,
}: {
  values:     string[];
  onChange:   (v: string[]) => void;
  disabled?:  boolean;
  inputStyle: React.CSSProperties;
}) {
  const [draft, setDraft] = useState('');

  function addValues(raw: string[]) {
    const seen = new Set(values);
    const additions = raw.filter(v => {
      if (!v || seen.has(v)) return false;
      seen.add(v);
      return true;
    });
    if (additions.length > 0) onChange([...values, ...additions]);
  }

  function commitDraft() {
    if (!draft.trim()) return;
    addValues([draft]);
    setDraft('');
  }

  function removeAt(i: number) {
    onChange(values.filter((_, idx) => idx !== i));
  }

  return (
    <div
      className="w-full flex flex-wrap items-center gap-1.5 px-2.5 py-2 rounded-button border-[0.5px]"
      style={{ ...inputStyle, minHeight: 38 }}
      onClick={e => {
        if (e.target === e.currentTarget) (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus();
      }}
    >
      {values.map((v, i) => (
        <span
          key={`${v}-${i}`}
          className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-pill text-xs font-medium"
          style={{ backgroundColor: 'var(--accent-tint)', color: 'var(--accent-strong)' }}
        >
          {v}
          {!disabled && (
            <button
              type="button"
              onClick={() => removeAt(i)}
              aria-label={`Remove ${v}`}
              className="flex items-center justify-center rounded-full"
              style={{ width: 14, height: 14, color: 'var(--accent-strong)', background: 'none', border: 'none', cursor: 'pointer', opacity: 0.7 }}
            >
              <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </span>
      ))}
      <input
        type="text"
        value={draft}
        disabled={disabled}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
            if (draft.trim()) {
              e.preventDefault();
              commitDraft();
            }
          } else if (e.key === 'Backspace' && !draft && values.length > 0) {
            removeAt(values.length - 1);
          }
        }}
        onPaste={e => {
          const text = e.clipboardData.getData('text');
          if (/[\n,]/.test(text)) {
            e.preventDefault();
            addValues(splitPastedValues(text));
          }
          // Single-value paste (no newline/comma) falls through to normal paste
          // behavior — it just lands in the text field like typed text.
        }}
        onBlur={commitDraft}
        placeholder={values.length === 0 ? 'AT&T, Verizon, T-Mobile…' : ''}
        className="flex-1 min-w-[120px] text-sm outline-none font-mono bg-transparent disabled:opacity-50"
        style={{ color: 'var(--text-primary)' }}
      />
    </div>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────────

export default function ConventionEditor({
  value,
  onChange,
  disabled = false,
}: {
  value:     ConventionDraft;
  onChange:  (d: ConventionDraft) => void;
  disabled?: boolean;
}) {
  const [showMore, setShowMore] = useState(false);
  const inputStyle: React.CSSProperties = {
    borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)',
  };

  const regexValid = useMemo(() => conventionRegexValid(value), [value]);

  const set = (patch: Partial<ConventionDraft>) => onChange({ ...value, ...patch });

  return (
    <div>
      {/* Set Naming Conventions — structured formatting rules */}
      <div className="rounded-button border-[0.5px] mb-4 overflow-hidden" style={{ borderColor: 'var(--border)' }}>
        <button
          type="button"
          onClick={() => setShowMore(s => !s)}
          disabled={disabled}
          className="w-full flex items-center justify-between px-3 py-2.5 text-left disabled:opacity-50"
          style={{ background: 'none', border: 'none', cursor: 'pointer' }}
        >
          <div>
            <p className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
              Set naming conventions
              {hasAnyRule(value.rules) && (
                <span className="ml-1.5 font-normal" style={{ color: 'var(--accent)' }}>
                  ({Object.keys(value.rules).length} set)
                </span>
              )}
            </p>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-hint)' }}>
              Formatting rules for canonical names — casing, structure, special characters.
            </p>
          </div>
          <svg
            width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true"
            style={{ color: 'var(--text-muted)', transform: showMore ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0, marginLeft: 12 }}
          >
            <path d="M4 2.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {showMore && (
          <div className="px-3 py-2" style={{ borderTop: '0.5px solid var(--border)', backgroundColor: 'var(--page-bg)' }}>
            {RULE_SECTIONS.map(section => (
              <div key={section} className="mb-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide mb-0.5" style={{ color: 'var(--text-muted)' }}>{section}</p>
                {RULE_GROUPS.filter(g => g.section === section).map(g => (
                  <RuleGroupRow key={g.id} group={g} rules={value.rules} setRules={r => set({ rules: r })} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Additional Naming Conventions — regex / examples / natural-language directive */}
      <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Additional naming conventions</label>
      <div className="inline-flex rounded-button overflow-hidden border-[0.5px] w-full mb-3" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--page-bg)' }}>
        {TYPE_OPTIONS.map(({ id, label }, i) => (
          <button
            key={id}
            type="button"
            onClick={() => set({ type: id })}
            disabled={disabled}
            className="flex-1 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
            style={{
              backgroundColor: value.type === id ? 'var(--accent)' : 'transparent',
              color:           value.type === id ? 'white' : 'var(--text-muted)',
              borderRight:     i < TYPE_OPTIONS.length - 1 ? '0.5px solid var(--border)' : undefined,
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {value.type !== 'none' && (
        <p className="text-[11px] mb-3 -mt-2" style={{ color: 'var(--text-hint)' }}>
          {ENFORCEABLE_CONVENTION_TYPES.includes(value.type)
            ? 'Enforced — Prism checks every name against this and fixes ones that don\u2019t match.'
            : 'Guidance for the AI — Prism asks the AI to follow this, but can\u2019t mechanically check the result. Use Regex or the rules below if you need it enforced.'}
        </p>
      )}

      {value.type === 'regex' && (
        <div>
          <input
            type="text" value={value.regex} onChange={e => set({ regex: e.target.value })}
            placeholder="^[A-Z][A-Za-z0-9 &.\\-]+$"
            maxLength={MAX_CONVENTION_REGEX_LEN}
            autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
            disabled={disabled}
            className="w-full text-sm px-3 py-2 rounded-button border-[0.5px] outline-none font-mono disabled:opacity-50"
            style={inputStyle}
          />
          <p className="text-[11px] mt-1" style={{ color: regexValid === false ? 'var(--confidence-low)' : 'var(--text-hint)' }}>
            {regexValid === false
              ? (value.regex.length > MAX_CONVENTION_REGEX_LEN
                  ? `Pattern too long (max ${MAX_CONVENTION_REGEX_LEN} characters).`
                  : 'Not a valid regular expression.')
              : 'Every canonical name must fully match this pattern (anchored). Names that can\'t be made to match are left unstandardized.'}
          </p>
        </div>
      )}
      {value.type === 'examples' && (
        <div>
          <textarea
            value={value.examples} onChange={e => set({ examples: e.target.value })}
            placeholder={'AT&T\nVerizon\nT-Mobile'}
            rows={4}
            disabled={disabled}
            className="w-full text-sm px-3 py-2 rounded-button border-[0.5px] outline-none font-mono disabled:opacity-50"
            style={inputStyle}
          />
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-hint)' }}>
            One canonical example per line — these guide how names are written.
          </p>
        </div>
      )}
      {value.type === 'natural' && (
        <div>
          <textarea
            value={value.natural} onChange={e => set({ natural: e.target.value })}
            placeholder="e.g. Use the short, commonly-used brand name in title case; never include legal suffixes."
            rows={3}
            disabled={disabled}
            className="w-full text-sm px-3 py-2 rounded-button border-[0.5px] outline-none disabled:opacity-50"
            style={inputStyle}
          />
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-hint)' }}>Plain-language description of how canonical names should be written.</p>
        </div>
      )}

      {/* Pre-standardized values */}
      <div className="mt-4">
        <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          Pre-standardized values <span style={{ color: 'var(--text-hint)', fontWeight: 400 }}>(optional)</span>
        </label>
        <TagListInput
          values={value.prestandardizedValues}
          onChange={v => set({ prestandardizedValues: v })}
          disabled={disabled}
          inputStyle={inputStyle}
        />
        <p className="text-[11px] mt-1" style={{ color: 'var(--text-hint)' }}>
          Type a value and press Enter, or paste a list — these canonical names will be used exactly as written when matching groups.
        </p>
      </div>
    </div>
  );
}
