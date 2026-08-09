'use client';

/**
 * ColumnSpecField — the trigger-button + popup wrapper around ColumnSpecEditor.
 *
 * Instead of showing the spec editor inline under every checkmarked column, we
 * show a single button ("Add standardization specs"). The button's appearance
 * tells the user, gently, whether the column's MANDATORY description is filled:
 *   • incomplete → amber, dashed, "Required" chip (a nudge, never an error-red)
 *   • complete   → green check, "Standardization specs added · Edit"
 *
 * Clicking opens a modal (the old domain-popup shape) holding the full
 * ColumnSpecEditor. The modal edits a LOCAL copy of the draft — "Cancel"/backdrop
 * discards, "Save specs" commits via onChange. Save is disabled until the
 * description is filled, with an inline reason so the user knows what's missing.
 *
 * The parent still owns the committed draft and still gates its own submit on
 * columnSpecDraftValid(value); this component only changes HOW the spec is
 * authored, not the validation contract.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import ColumnSpecEditor, {
  columnSpecDraftValid,
  type ColumnSpecDraft,
} from './ColumnSpecEditor';

export default function ColumnSpecField({
  value,
  onChange,
  disabled = false,
  columnName,
  variant = 'block',
}: {
  value:      ColumnSpecDraft;
  onChange:   (d: ColumnSpecDraft) => void;
  disabled?:  boolean;
  /** Column name — shown as the modal subtitle so the user knows what they're describing. */
  columnName?: string;
  /** 'inline' = compact chip meant to sit on the column-name row; 'block' = full-width panel button. */
  variant?:   'block' | 'inline';
}) {
  const complete = columnSpecDraftValid(value);
  const [open, setOpen] = useState(false);
  // Local, editable copy — committed only on Save so Cancel truly discards.
  const [draft, setDraft] = useState<ColumnSpecDraft>(value);

  // Re-seed the local draft whenever the modal opens (picks up any external edits).
  function openModal() {
    if (disabled) return;
    setDraft(value);
    setOpen(true);
  }

  const CheckIcon = (
    <svg width="10" height="10" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2.5 7L5.5 10L11.5 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  // A small amber "attention" triangle — a gentle required marker, not an error-red alarm.
  const WarnIcon = (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M6 1.4l5 8.6H1z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      <path d="M6 4.9v2.3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <circle cx="6" cy="8.7" r="0.55" fill="currentColor" />
    </svg>
  );

  return (
    <>
      {variant === 'inline' ? (
        <button
          type="button"
          onClick={openModal}
          disabled={disabled}
          title={complete ? 'Edit standardization spec' : 'Standardization spec required — click to add a description'}
          className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-pill border-[0.5px] transition-colors flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
          style={
            complete
              ? { borderColor: '#BBF7D0', backgroundColor: '#F0FDF4', color: '#15803D' }
              : { borderColor: '#FCD34D', backgroundColor: '#FFFBEB', color: '#92400E' }
          }
        >
          {complete ? CheckIcon : WarnIcon}
          {complete ? 'Specs' : 'Add specs'}
        </button>
      ) : (
        <button
          type="button"
          onClick={openModal}
          disabled={disabled}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-button border-[0.5px] text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          style={
            complete
              ? { borderColor: '#BBF7D0', backgroundColor: '#F0FDF4' }
              : { borderColor: '#FCD34D', borderStyle: 'dashed', backgroundColor: '#FFFBEB' }
          }
        >
          {complete ? (
            <span
              className="flex items-center justify-center rounded-full flex-shrink-0"
              style={{ width: 18, height: 18, backgroundColor: '#16A34A', color: 'white' }}
            >
              {CheckIcon}
            </span>
          ) : (
            <span
              className="flex items-center justify-center flex-shrink-0"
              style={{ width: 18, height: 18, color: '#B45309' }}
            >
              {WarnIcon}
            </span>
          )}

          <span className="flex-1 min-w-0">
            <span
              className="block text-xs font-medium"
              style={{ color: complete ? '#15803D' : '#92400E' }}
            >
              {complete ? 'Standardization specs added' : 'Add standardization specs'}
            </span>
            {!complete && (
              <span className="block text-[10.5px] mt-0.5" style={{ color: '#B45309' }}>
                A description is required for this column
              </span>
            )}
          </span>

          {complete ? (
            <span className="text-[11px] font-medium flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
              Edit
            </span>
          ) : (
            <span
              className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-pill flex-shrink-0"
              style={{ backgroundColor: '#FEF3C7', color: '#92400E' }}
            >
              <span className="rounded-full" style={{ width: 5, height: 5, backgroundColor: '#F59E0B' }} />
              Required
            </span>
          )}
        </button>
      )}

      {open && (
        <ColumnSpecModal
          columnName={columnName}
          draft={draft}
          onDraftChange={setDraft}
          onCancel={() => setOpen(false)}
          onSave={() => { onChange(draft); setOpen(false); }}
        />
      )}
    </>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function ColumnSpecModal({
  columnName,
  draft,
  onDraftChange,
  onCancel,
  onSave,
}: {
  columnName?:   string;
  draft:         ColumnSpecDraft;
  onDraftChange: (d: ColumnSpecDraft) => void;
  onCancel:      () => void;
  onSave:        () => void;
}) {
  const ready = columnSpecDraftValid(draft);

  // Escape closes (discards).
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onCancel(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 80 }}
      onClick={onCancel}
    >
      <div className="absolute inset-0" style={{ backgroundColor: 'rgba(26,26,46,0.35)' }} />

      <div
        className="relative rounded-card border-[0.5px] w-full max-w-lg mx-4 flex flex-col"
        style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', maxHeight: '88vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-5 pb-4" style={{ borderBottom: '0.5px solid var(--border)' }}>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Standardization spec</h3>
            {columnName && (
              <p className="text-xs mt-0.5 font-mono truncate" style={{ color: 'var(--text-muted)' }} title={columnName}>{columnName}</p>
            )}
          </div>
          <button
            onClick={onCancel}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 overflow-y-auto">
          <ColumnSpecEditor value={draft} onChange={onDraftChange} />
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between gap-3 px-6 py-4"
          style={{ borderTop: '0.5px solid var(--border)' }}
        >
          <span className="flex items-center gap-1.5 text-[11px] min-w-0">
            {ready ? (
              <>
                <svg width="13" height="13" viewBox="0 0 14 14" fill="none" style={{ color: '#16A34A', flexShrink: 0 }} aria-hidden="true">
                  <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M4.3 7.2L6 8.9L9.7 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span style={{ color: '#15803D' }} className="truncate">Ready to save — applies to this column</span>
              </>
            ) : (
              <>
                <span className="rounded-full flex-shrink-0" style={{ width: 6, height: 6, backgroundColor: '#F59E0B' }} />
                <span style={{ color: '#92400E' }} className="truncate">Add a description to save</span>
              </>
            )}
          </span>

          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-2 text-xs font-medium rounded-button border-[0.5px] transition-colors"
              style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', backgroundColor: 'var(--surface)' }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!ready}
              className="px-4 py-2 text-xs font-medium rounded-button text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ backgroundColor: 'var(--accent)' }}
              onMouseEnter={e => { if (ready) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent-strong)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; }}
            >
              Save specs
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
