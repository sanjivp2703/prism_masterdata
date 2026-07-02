'use client';

// Compact per-column domain picker: select an existing domain (with search once
// the list grows) or add a new one inline / via the create modal. Domains are
// passed in from the parent (no independent fetch) so several pickers share one
// list and a newly-created domain shows up everywhere via onDomainCreated.
// Shared by the new-pipeline setup (AutoExportHome) and the add-column modal
// (PipelinesView) so both use the exact same UI.
//
// The dropdown renders via a portal so it is never clipped by overflow:hidden
// ancestors (the column-picker rows use overflow:hidden for rounded corners).

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Domain } from './DomainSelector';
import CreateDomainModal from './CreateDomainModal';

export default function CompactDomainPicker({
  domains,
  isLoading,
  value,
  onChange,
  onDomainCreated,
  disabled,
}: {
  domains:          Domain[];
  isLoading:        boolean;
  value:            Domain | null;
  onChange:         (d: Domain | null) => void;
  onDomainCreated?: (d: Domain) => void;
  disabled?:        boolean;
}) {
  const [open,          setOpen]          = useState(false);
  const [search,        setSearch]        = useState('');
  const [creating,      setCreating]      = useState(false);
  const [newName,       setNewName]       = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [createError,   setCreateError]   = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0, width: 0 });

  const btnRef  = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const updatePos = useCallback(() => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setDropPos({ top: r.bottom + 4, left: r.left, width: r.width });
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        dropRef.current && !dropRef.current.contains(e.target as Node) &&
        btnRef.current  && !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setSearch('');
        setCreating(false);
        setNewName('');
        setCreateError(null);
      }
    }
    // Keep dropdown anchored to the button while scrolling
    function handleScroll() { updatePos(); }
    document.addEventListener('mousedown', handleClick);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [open, updatePos]);

  useEffect(() => {
    if (creating) nameRef.current?.focus();
  }, [creating]);

  async function handleCreate() {
    const name = newName.trim();
    if (!name || createLoading) return;
    setCreateLoading(true);
    setCreateError(null);
    try {
      const res  = await fetch('/api/domains', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? 'Failed to create domain');
      const d = body.domain as Domain;
      onDomainCreated?.(d);
      onChange(d);
      setOpen(false);
      setCreating(false);
      setNewName('');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setCreateLoading(false);
    }
  }

  const filtered = search
    ? domains.filter(d => d.name.toLowerCase().includes(search.toLowerCase()))
    : domains;

  const dropdown = open && typeof document !== 'undefined' ? createPortal(
    <div
      ref={dropRef}
      style={{
        position:        'fixed',
        top:             dropPos.top,
        left:            dropPos.left,
        width:           Math.max(dropPos.width, 200),
        zIndex:          9999,
        backgroundColor: 'var(--surface)',
        border:          '0.5px solid var(--border)',
        borderRadius:    10,
        boxShadow:       '0 4px 20px rgba(0,0,0,0.10)',
        overflow:        'hidden',
      }}
    >
      {domains.length > 6 && (
        <div style={{ padding: '8px 8px 4px' }}>
          <input
            autoFocus
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            style={{
              width:           '100%',
              padding:         '4px 8px',
              borderRadius:    6,
              border:          '0.5px solid var(--border)',
              backgroundColor: 'var(--page-bg)',
              color:           'var(--text-primary)',
              fontSize:        12,
              outline:         'none',
              boxSizing:       'border-box',
            }}
          />
        </div>
      )}

      {/* New domain — always at top */}
      <div style={{ borderBottom: '0.5px solid var(--border)', padding: '8px 10px' }}>
        {creating ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                ref={nameRef}
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCreate(); } }}
                placeholder="Domain name…"
                disabled={createLoading}
                style={{
                  flex:            1,
                  padding:         '5px 8px',
                  borderRadius:    6,
                  border:          '0.5px solid var(--accent)',
                  backgroundColor: 'var(--surface)',
                  color:           'var(--text-primary)',
                  fontSize:        12,
                  outline:         'none',
                }}
              />
              <button
                type="button"
                onClick={handleCreate}
                disabled={!newName.trim() || createLoading}
                style={{
                  padding:         '5px 10px',
                  borderRadius:    6,
                  border:          'none',
                  backgroundColor: 'var(--accent)',
                  color:           'white',
                  fontSize:        12,
                  fontWeight:      600,
                  cursor:          createLoading || !newName.trim() ? 'not-allowed' : 'pointer',
                  opacity:         createLoading || !newName.trim() ? 0.5 : 1,
                }}
              >
                {createLoading ? '…' : 'Create'}
              </button>
              <button
                type="button"
                onClick={() => { setCreating(false); setNewName(''); setCreateError(null); }}
                disabled={createLoading}
                style={{
                  padding:         '5px 8px',
                  borderRadius:    6,
                  border:          '0.5px solid var(--border)',
                  backgroundColor: 'transparent',
                  color:           'var(--text-muted)',
                  fontSize:        12,
                  cursor:          'pointer',
                }}
              >✕</button>
            </div>
            {createError && (
              <p style={{ fontSize: 11, color: 'var(--confidence-low)', margin: 0 }}>{createError}</p>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => { setOpen(false); setShowCreateModal(true); }}
            style={{
              display:    'flex',
              alignItems: 'center',
              gap:        6,
              background: 'none',
              border:     'none',
              cursor:     'pointer',
              color:      'var(--accent)',
              fontSize:   13,
              fontWeight: 500,
              width:      '100%',
              padding:    '2px 0',
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
            New domain
          </button>
        )}
      </div>

      <div style={{ maxHeight: 220, overflowY: 'auto' }}>
        {filtered.map(d => {
          const sel = value?.domain_id === d.domain_id;
          return (
            <button key={d.domain_id} type="button"
              onClick={() => { onChange(d); setOpen(false); setSearch(''); }}
              style={{
                display:    'block',
                width:      '100%',
                padding:    '7px 12px',
                background: sel ? 'var(--accent-tint)' : 'transparent',
                border:     'none',
                cursor:     'pointer',
                fontSize:   13,
                color:      sel ? 'var(--accent)' : 'var(--text-primary)',
                fontWeight: sel ? 600 : 400,
                textAlign:  'left',
              }}
              onMouseEnter={e => { if (!sel) (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--page-bg)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = sel ? 'var(--accent-tint)' : 'transparent'; }}
            >
              {d.name}
            </button>
          );
        })}

        {filtered.length === 0 && !creating && (
          <p style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
            {search ? 'No domains match' : 'No domains yet'}
          </p>
        )}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <div style={{ position: 'relative' }}>
      {showCreateModal && (
        <CreateDomainModal
          initialName={search}
          onClose={() => setShowCreateModal(false)}
          onCreated={(d) => { onDomainCreated?.(d); onChange(d); setShowCreateModal(false); }}
        />
      )}
      <button
        ref={btnRef}
        type="button"
        disabled={disabled || isLoading}
        onClick={() => { updatePos(); setOpen(o => !o); }}
        className="w-full flex items-center justify-between rounded-button border-[0.5px] outline-none transition-colors disabled:opacity-50"
        style={{
          padding:         '9px 12px',
          borderColor:     open ? 'var(--accent)' : 'var(--border)',
          backgroundColor: 'var(--surface)',
          color:           value ? 'var(--text-primary)' : 'var(--text-muted)',
          fontWeight:      value ? 500 : 400,
          fontSize:        13,
          textAlign:       'left',
          cursor:          disabled ? 'not-allowed' : 'pointer',
        }}
      >
        <span className="truncate">{isLoading ? 'Loading…' : (value?.name ?? 'Select domain…')}</span>
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none"
          style={{ flexShrink: 0, marginLeft: 6, transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : undefined }}>
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {dropdown}
    </div>
  );
}
