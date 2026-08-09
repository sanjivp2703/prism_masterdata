'use client';

/**
 * ColumnSpecEditor — the inline, per-column replacement for the old
 * CompactDomainPicker / CreateDomainModal. Every standardized column authors its
 * OWN spec: a mandatory description, optional free-text standardization rules,
 * and an optional naming convention (the shared ConventionEditor). It's a
 * controlled component — the parent connect form holds the draft and sends it in
 * the pipeline-create body.
 */

import ConventionEditor, {
  emptyConventionDraft, conventionDraftToConvention, conventionRegexValid,
  type ConventionDraft,
} from './ConventionEditor';
import type { ConventionRules } from '@/app/api/_lib/convention-rules';

export interface ColumnSpecDraft {
  description: string;
  stdRules:    string[];
  convention:  ConventionDraft;
}

export function emptyColumnSpecDraft(): ColumnSpecDraft {
  return { description: '', stdRules: [''], convention: emptyConventionDraft() };
}

/** Build a draft from an existing saved spec (for editing). */
export function columnSpecToDraft(spec: {
  description?:           string | null;
  standardization_rules?: string | null;
  convention_type?:       string | null;
  convention_value?:      string | null;
  convention_rules?:      string | null;
}): ColumnSpecDraft {
  let stdRules: string[] = [''];
  try {
    const p = spec.standardization_rules ? JSON.parse(spec.standardization_rules) : null;
    if (Array.isArray(p) && p.length > 0) stdRules = p.map(String);
  } catch { /* malformed → single empty rule */ }

  const convention = emptyConventionDraft();
  const ct = String(spec.convention_type ?? '');
  const cv = String(spec.convention_value ?? '');
  if (ct === 'regex')         { convention.type = 'regex';    convention.regex    = cv; }
  else if (ct === 'examples') { convention.type = 'examples'; convention.examples = cv; }
  else if (ct === 'natural')  { convention.type = 'natural';  convention.natural  = cv; }
  try {
    const r = spec.convention_rules ? JSON.parse(spec.convention_rules) : null;
    if (r && typeof r === 'object') convention.rules = r as ConventionRules;
  } catch { /* malformed → no structured rules */ }

  return { description: spec.description ?? '', stdRules, convention };
}

/** True when the draft is complete enough to submit (description required; regex valid; a chosen convention type has a value). */
export function columnSpecDraftValid(d: ColumnSpecDraft): boolean {
  if (!d.description.trim()) return false;
  if (d.convention.type === 'none') return true;
  const activeVal = d.convention.type === 'regex' ? d.convention.regex
    : d.convention.type === 'examples' ? d.convention.examples
    : d.convention.natural;
  return !!activeVal.trim() && conventionRegexValid(d.convention) !== false;
}

/** Serialize to the spec payload the create/patch APIs accept. */
export function columnSpecDraftToApiSpec(d: ColumnSpecDraft) {
  const conv = conventionDraftToConvention(d.convention);
  return {
    description:             d.description.trim(),
    standardization_rules:  d.stdRules.map(r => r.trim()).filter(Boolean),
    convention_type:        conv.type,
    convention_value:       conv.value || null,
    convention_rules:       conv.rules,
    prestandardized_values: conv.prestandardized_values,
  };
}

const inputStyle: React.CSSProperties = {
  borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)',
};

export default function ColumnSpecEditor({
  value,
  onChange,
  disabled = false,
}: {
  value:     ColumnSpecDraft;
  onChange:  (d: ColumnSpecDraft) => void;
  disabled?: boolean;
}) {
  function setRule(i: number, val: string) {
    onChange({ ...value, stdRules: value.stdRules.map((r, idx) => (idx === i ? val : r)) });
  }
  function addRule() { onChange({ ...value, stdRules: [...value.stdRules, ''] }); }
  function removeRule(i: number) { onChange({ ...value, stdRules: value.stdRules.filter((_, idx) => idx !== i) }); }

  return (
    <div>
      {/* Description — mandatory (the LLM concept definition for this column). */}
      <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
        Description
      </label>
      <p className="text-[11px] mb-2" style={{ color: 'var(--text-hint)' }}>
        What does this column represent? This defines the values for the AI — e.g. “Legal entity names of companies, including subsidiaries and trading names.”
      </p>
      <textarea
        value={value.description}
        onChange={e => onChange({ ...value, description: e.target.value })}
        placeholder="Describe what this column's values are…"
        rows={2}
        disabled={disabled}
        className="w-full text-sm px-3 py-2 rounded-button border-[0.5px] outline-none mb-4 resize-none disabled:opacity-50"
        style={{ ...inputStyle, lineHeight: 1.5 }}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
        onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
      />

      {/* Standardization rules (optional) */}
      <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
        Standardization rules <span style={{ color: 'var(--text-hint)', fontWeight: 400 }}>(optional)</span>
      </label>
      <p className="text-[11px] mb-2" style={{ color: 'var(--text-hint)' }}>
        Rules guide how values are grouped — e.g. “group subsidiaries under the parent company name”.
      </p>
      <div className="flex flex-col gap-1.5 mb-3">
        {value.stdRules.map((rule, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="text"
              value={rule}
              onChange={e => setRule(i, e.target.value)}
              placeholder={`Rule ${i + 1}…`}
              disabled={disabled}
              className="flex-1 text-sm px-3 py-1.5 rounded-button border-[0.5px] outline-none disabled:opacity-50"
              style={inputStyle}
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
              onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
            />
            {value.stdRules.length > 1 && (
              <button
                type="button"
                onClick={() => removeRule(i)}
                disabled={disabled}
                className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-button border-[0.5px] text-xs transition-colors"
                style={{ borderColor: 'var(--border)', color: 'var(--text-muted)', backgroundColor: 'transparent' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#FCA5A5'; (e.currentTarget as HTMLButtonElement).style.color = '#DC2626'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; }}
                title="Remove rule"
              >×</button>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={addRule}
        disabled={disabled}
        className="flex items-center gap-1.5 text-xs font-medium mb-4"
        style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        Add rule
      </button>

      {/* Naming convention (optional) */}
      <ConventionEditor
        value={value.convention}
        onChange={c => onChange({ ...value, convention: c })}
        disabled={disabled}
      />
    </div>
  );
}
