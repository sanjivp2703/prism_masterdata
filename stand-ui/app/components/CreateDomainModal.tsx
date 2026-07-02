'use client';

import { useState } from 'react';
import type { Domain } from './domain-types';
import ConventionEditor, {
  emptyConventionDraft, conventionDraftToConvention, conventionRegexValid,
  type ConventionDraft,
} from './ConventionEditor';

export default function CreateDomainModal({
  onClose,
  onCreated,
  initialName = '',
}: {
  onClose:     () => void;
  onCreated:   (d: Domain) => void;
  initialName?: string;
}) {
  const [name,          setName]          = useState(initialName);
  const [description,   setDescription]   = useState('');
  const [stdRules,      setStdRules]      = useState<string[]>(['']);
  const [convention,    setConvention]    = useState<ConventionDraft>(emptyConventionDraft());
  const [loading,       setLoading]       = useState(false);
  const [error,         setError]         = useState<string | null>(null);

  function setRule(i: number, val: string) {
    setStdRules(prev => prev.map((r, idx) => idx === i ? val : r));
  }
  function addRule() { setStdRules(prev => [...prev, '']); }
  function removeRule(i: number) { setStdRules(prev => prev.filter((_, idx) => idx !== i)); }

  const regexValid = conventionRegexValid(convention);

  const canSubmit =
    !loading &&
    !!name.trim() &&
    !!description.trim() &&
    (convention.type === 'none' || (!!(convention.type === 'regex' ? convention.regex : convention.type === 'examples' ? convention.examples : convention.natural).trim() && regexValid !== false));

  async function handleCreate() {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      const conv = conventionDraftToConvention(convention);
      const res = await fetch('/api/domains', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          standardization_rules: stdRules.map(r => r.trim()).filter(Boolean),
          convention_type:  conv.type,
          convention_value: conv.value || null,
          convention_rules: conv.rules,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? 'Failed to create domain');
      onCreated(body.domain as Domain);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    borderColor: 'var(--border)', backgroundColor: 'var(--surface)', color: 'var(--text-primary)',
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(26,26,46,0.35)' }}
      onClick={onClose}
    >
      <div
        className="rounded-card border-[0.5px] w-full max-w-lg mx-4 overflow-y-auto"
        style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: 'var(--card-padding)', maxHeight: '88vh' }}
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>New domain</h3>
        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
          A domain groups columns that standardize the same kind of value — confirmed mappings and naming conventions are shared across every column linked to it.
        </p>

        {/* Name */}
        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Name</label>
        <input
          type="text" value={name} onChange={e => setName(e.target.value)}
          placeholder="e.g. Company Names"
          autoFocus
          disabled={loading}
          className="w-full text-sm px-3 py-2 rounded-button border-[0.5px] outline-none mb-4 disabled:opacity-50"
          style={inputStyle}
          onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
          onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
        />

        {/* Description */}
        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
          Description
        </label>
        <textarea
          value={description} onChange={e => setDescription(e.target.value)}
          placeholder="e.g. Legal entity names of companies — includes subsidiaries and trading names."
          rows={2}
          disabled={loading}
          className="w-full text-sm px-3 py-2 rounded-button border-[0.5px] outline-none mb-4 resize-none disabled:opacity-50"
          style={{ ...inputStyle, lineHeight: 1.5 }}
          onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
          onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
        />

        {/* Standardization rules */}
        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
          Standardization rules <span style={{ color: 'var(--text-hint)', fontWeight: 400 }}>(optional)</span>
        </label>
        <p className="text-[11px] mb-2" style={{ color: 'var(--text-hint)' }}>
          Rules guide how values are grouped — e.g. "group subsidiaries under the parent company name".
        </p>
        <div className="flex flex-col gap-1.5 mb-3">
          {stdRules.map((rule, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={rule}
                onChange={e => setRule(i, e.target.value)}
                placeholder={`Rule ${i + 1}…`}
                disabled={loading}
                className="flex-1 text-sm px-3 py-1.5 rounded-button border-[0.5px] outline-none disabled:opacity-50"
                style={inputStyle}
                onFocus={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                onBlur={e  => { e.currentTarget.style.borderColor = 'var(--border)'; }}
              />
              {stdRules.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeRule(i)}
                  disabled={loading}
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
          disabled={loading}
          className="flex items-center gap-1.5 text-xs font-medium mb-4"
          style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          Add rule
        </button>

        {/* Naming conventions — structured rules + regex/examples/description */}
        <div className="mb-4">
          <ConventionEditor value={convention} onChange={setConvention} disabled={loading} />
        </div>

        {error && (
          <div className="rounded-button border-[0.5px] px-3 py-2 mb-3 text-xs" style={{ backgroundColor: '#FEF2F2', borderColor: '#FECACA', color: 'var(--confidence-low)' }}>
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="px-3 py-2 text-xs font-medium rounded-button border-[0.5px] transition-colors disabled:opacity-50"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!canSubmit}
            className="px-4 py-2 text-xs font-medium rounded-button text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ backgroundColor: 'var(--accent)' }}
            onMouseEnter={e => { if (canSubmit) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; }}
          >
            {loading ? 'Creating…' : 'Create domain'}
          </button>
        </div>
      </div>
    </div>
  );
}
