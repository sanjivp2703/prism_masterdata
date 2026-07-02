'use client';

import type { CSSProperties } from 'react';

/**
 * Persistent banner reminding the user that edits to standardizations are
 * domain-wide — every table with a pipeline in the domain shares the lookup.
 */
export function DomainScopeNotice({ style }: { style?: CSSProperties }) {
  return (
    <div
      className="rounded-button border-[0.5px] px-4 py-3 text-sm flex items-start gap-2.5"
      style={{ backgroundColor: '#FFFBEB', borderColor: '#FDE68A', color: '#92400E', ...style }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }}>
        <path d="M8 1.5l6.5 11.5h-13L8 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M8 6.2v3.1M8 11.2h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span>
        Changes here apply to the whole domain. Every table with a pipeline in this domain standardizes
        from the same shared lookup, so edits you accept will change their standardizations too.
      </span>
    </div>
  );
}

/**
 * Confirmation dialog shown before committing a change that affects every table
 * with a pipeline in the domain.
 */
export function DomainChangeConfirmModal({
  open,
  busy = false,
  onCancel,
  onConfirm,
  confirmLabel = 'Apply to all tables',
  body,
}: {
  open:         boolean;
  busy?:        boolean;
  onCancel:     () => void;
  onConfirm:    () => void;
  confirmLabel?: string;
  body?:        string;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center"
      style={{ backgroundColor: 'rgba(26,26,46,0.35)' }}
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="rounded-card border-[0.5px] w-full max-w-md mx-4"
        style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: 'var(--card-padding)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-2.5 mb-2">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0, marginTop: 1, color: '#B45309' }}>
            <path d="M8 1.5l6.5 11.5h-13L8 1.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            <path d="M8 6.2v3.1M8 11.2h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>Apply changes across the domain?</h3>
        </div>
        <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {body ?? 'This updates the shared lookup for this domain. Every other table with a pipeline in this domain will standardize using these mappings too.'}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-2 text-xs font-medium rounded-button border-[0.5px] transition-colors disabled:opacity-50"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="px-4 py-2 text-xs font-medium rounded-button text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ backgroundColor: 'var(--accent)' }}
            onMouseEnter={e => { if (!busy) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; }}
          >
            {busy ? 'Applying…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Small ghost "Undo" button wired to a page's undo handler. */
export function UndoButton({ onUndo, disabled }: { onUndo: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      onClick={onUndo}
      disabled={disabled}
      title="Undo last change (⌘Z)"
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-button text-sm font-medium border-[0.5px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }}
      onMouseEnter={e => { if (!disabled) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface-hover)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--surface)'; }}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M6.5 3.5L3 7l3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M3 7h6.5a3.5 3.5 0 010 7H7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Undo
    </button>
  );
}
