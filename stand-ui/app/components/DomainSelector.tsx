'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

export interface Domain {
  domain_id:    number;
  name:         string;
  usage_count:  number;
  last_used_at: string | null;
  created_at:   string | null;
}

interface DomainSelectorProps {
  isAdmin:  boolean;
  value:    Domain | null;
  onChange: (domain: Domain | null) => void;
}

const PILL_THRESHOLD = 10;
const RECENT_COUNT   = 4;

// ── Spinner ───────────────────────────────────────────────────────────────────
function Spinner() {
  return (
    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

// ── Inline "create new domain" form ──────────────────────────────────────────
function CreateForm({
  onCreated,
  onCancel,
}: {
  onCreated: (d: Domain) => void;
  onCancel:  () => void;
}) {
  const [name,    setName]    = useState('');
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res  = await fetch('/api/domains', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: trimmed }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? 'Failed to create domain');
      onCreated(body.domain as Domain);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          ref={inputRef}
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Domain name…"
          disabled={saving}
          style={{
            flex:            1,
            padding:         '6px 10px',
            borderRadius:    6,
            border:          '0.5px solid var(--accent)',
            backgroundColor: 'var(--surface)',
            color:           'var(--text-primary)',
            fontSize:        13,
            outline:         'none',
          }}
        />
        <button
          type="submit"
          disabled={!name.trim() || saving}
          style={{
            padding:         '6px 12px',
            borderRadius:    6,
            border:          'none',
            backgroundColor: 'var(--accent)',
            color:           'white',
            fontSize:        12,
            fontWeight:      600,
            cursor:          saving || !name.trim() ? 'not-allowed' : 'pointer',
            opacity:         saving || !name.trim() ? 0.5 : 1,
            display:         'flex',
            alignItems:      'center',
            gap:             4,
          }}
        >
          {saving ? <Spinner /> : 'Create'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          style={{
            padding:         '6px 10px',
            borderRadius:    6,
            border:          '0.5px solid var(--border)',
            backgroundColor: 'transparent',
            color:           'var(--text-muted)',
            fontSize:        12,
            cursor:          'pointer',
          }}
        >
          Cancel
        </button>
      </div>
      {error && (
        <p style={{ fontSize: 12, color: 'var(--confidence-low)', marginTop: 6 }}>{error}</p>
      )}
    </form>
  );
}

// ── Edit form (inline rename) ─────────────────────────────────────────────────
function EditForm({
  domain,
  onSaved,
  onCancel,
}: {
  domain:    Domain;
  onSaved:   (d: Domain) => void;
  onCancel:  () => void;
}) {
  const [name,   setName]   = useState(domain.name);
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || saving || trimmed === domain.name) { onCancel(); return; }
    setSaving(true);
    setError(null);
    try {
      const res  = await fetch(`/api/domains/${domain.domain_id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: trimmed }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? 'Failed to rename domain');
      onSaved({ ...domain, name: trimmed });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} onClick={e => e.stopPropagation()}
      style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}
    >
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          ref={inputRef}
          value={name}
          onChange={e => setName(e.target.value)}
          disabled={saving}
          style={{
            flex:            1,
            padding:         '3px 8px',
            borderRadius:    5,
            border:          '0.5px solid var(--accent)',
            backgroundColor: 'var(--surface)',
            color:           'var(--text-primary)',
            fontSize:        13,
            outline:         'none',
          }}
        />
        <button type="submit" disabled={saving || !name.trim()}
          style={{ padding: '3px 8px', borderRadius: 5, border: 'none', backgroundColor: 'var(--accent)', color: 'white', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
          {saving ? '…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel}
          style={{ padding: '3px 8px', borderRadius: 5, border: '0.5px solid var(--border)', backgroundColor: 'transparent', color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer' }}>
          ✕
        </button>
      </div>
      {error && <p style={{ fontSize: 11, color: 'var(--confidence-low)' }}>{error}</p>}
    </form>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function DomainSelector({ isAdmin, value, onChange }: DomainSelectorProps) {
  const [domains,    setDomains]    = useState<Domain[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [creating,   setCreating]   = useState(false);
  const [editingId,  setEditingId]  = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  // Dropdown state (>10 domains)
  const [dropOpen,   setDropOpen]   = useState(false);
  const [search,     setSearch]     = useState('');
  const dropRef = useRef<HTMLDivElement>(null);

  // ── Fetch on mount ──────────────────────────────────────────────────────────
  const fetchDomains = useCallback(async () => {
    try {
      const res  = await fetch('/api/domains');
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? 'Failed to load domains');
      setDomains(body.domains ?? []);
      setFetchError(null);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Failed to load domains');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDomains(); }, [fetchDomains]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropOpen) return;
    function handleClick(e: MouseEvent) {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setDropOpen(false);
        setSearch('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [dropOpen]);

  // ── Handlers ────────────────────────────────────────────────────────────────
  function handleSelect(d: Domain) {
    onChange(d);
    setDropOpen(false);
    setSearch('');
  }

  function handleCreated(d: Domain) {
    setDomains(prev => [d, ...prev]);
    setCreating(false);
    onChange(d);
  }

  function handleSaved(updated: Domain) {
    setDomains(prev => prev.map(d => d.domain_id === updated.domain_id ? updated : d));
    if (value?.domain_id === updated.domain_id) onChange(updated);
    setEditingId(null);
  }

  async function handleDelete(d: Domain) {
    if (!confirm(`Delete domain "${d.name}"? This cannot be undone.`)) return;
    setDeletingId(d.domain_id);
    try {
      const res  = await fetch(`/api/domains/${d.domain_id}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? 'Failed to delete domain');
      setDomains(prev => prev.filter(x => x.domain_id !== d.domain_id));
      if (value?.domain_id === d.domain_id) onChange(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete domain');
    } finally {
      setDeletingId(null);
    }
  }

  // ── Loading / error states ──────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0', color: 'var(--text-muted)', fontSize: 13 }}>
        <Spinner /> Loading domains…
      </div>
    );
  }

  if (fetchError) {
    return (
      <div style={{ fontSize: 12, color: 'var(--confidence-low)', padding: '6px 0' }}>
        {fetchError}{' '}
        <button onClick={fetchDomains} style={{ textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 12 }}>
          Retry
        </button>
      </div>
    );
  }

  // ── PILL mode (≤ PILL_THRESHOLD domains) ────────────────────────────────────
  if (domains.length <= PILL_THRESHOLD) {
    return (
      <div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {domains.map(d => {
            const selected = value?.domain_id === d.domain_id;
            if (editingId === d.domain_id) {
              return (
                <div key={d.domain_id} style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                  <EditForm domain={d} onSaved={handleSaved} onCancel={() => setEditingId(null)} />
                </div>
              );
            }
            return (
              // Outer div is the visual pill; name button + admin buttons are siblings — no nested <button>.
              <div
                key={d.domain_id}
                style={{
                  display:         'inline-flex',
                  alignItems:      'center',
                  borderRadius:    20,
                  border:          `0.5px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                  backgroundColor: selected ? 'var(--accent-tint)' : 'transparent',
                  transition:      'all 0.12s',
                  overflow:        'hidden',
                }}
              >
                <button
                  onClick={() => handleSelect(d)}
                  style={{
                    padding:         '5px 12px',
                    border:          'none',
                    background:      'transparent',
                    color:           selected ? 'var(--accent)' : 'var(--text-secondary)',
                    fontSize:        13,
                    fontWeight:      selected ? 600 : 400,
                    cursor:          'pointer',
                  }}
                >
                  {d.name}
                </button>
                {isAdmin && (
                  <span style={{ display: 'inline-flex', gap: 2, paddingRight: 6 }} onClick={e => e.stopPropagation()}>
                    <button
                      title="Rename"
                      onClick={() => setEditingId(d.domain_id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', color: 'var(--text-muted)', fontSize: 11 }}
                    >
                      ✎
                    </button>
                    <button
                      title="Delete"
                      disabled={deletingId === d.domain_id}
                      onClick={() => handleDelete(d)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', color: 'var(--confidence-low)', fontSize: 11, opacity: deletingId === d.domain_id ? 0.4 : 1 }}
                    >
                      ✕
                    </button>
                  </span>
                )}
              </div>
            );
          })}

          {/* New domain pill button */}
          {!creating && (
            <button
              onClick={() => setCreating(true)}
              style={{
                display:         'inline-flex',
                alignItems:      'center',
                gap:             4,
                padding:         '5px 12px',
                borderRadius:    20,
                border:          '0.5px dashed var(--border)',
                backgroundColor: 'transparent',
                color:           'var(--text-muted)',
                fontSize:        13,
                cursor:          'pointer',
              }}
            >
              <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
              New domain
            </button>
          )}
        </div>

        {creating && (
          <CreateForm
            onCreated={handleCreated}
            onCancel={() => setCreating(false)}
          />
        )}
      </div>
    );
  }

  // ── DROPDOWN mode (> PILL_THRESHOLD domains) ─────────────────────────────────
  const recent       = domains.slice(0, RECENT_COUNT);
  const searchLower  = search.toLowerCase();
  const filtered     = domains
    .filter(d => d.name.toLowerCase().includes(searchLower))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div ref={dropRef} style={{ position: 'relative' }}>
      {/* Trigger button */}
      <button
        onClick={() => setDropOpen(o => !o)}
        style={{
          width:           '100%',
          display:         'flex',
          alignItems:      'center',
          justifyContent:  'space-between',
          padding:         '9px 12px',
          borderRadius:    8,
          border:          `0.5px solid ${dropOpen ? 'var(--accent)' : 'var(--border)'}`,
          backgroundColor: 'var(--surface)',
          color:           value ? 'var(--text-primary)' : 'var(--text-muted)',
          fontSize:        13,
          fontWeight:      value ? 500 : 400,
          cursor:          'pointer',
          textAlign:       'left',
        }}
      >
        <span>{value?.name ?? 'Select a domain…'}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"
          style={{ transform: dropOpen ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s', flexShrink: 0 }}>
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {/* Dropdown panel */}
      {dropOpen && (
        <div style={{
          position:        'absolute',
          top:             'calc(100% + 4px)',
          left:            0,
          right:           0,
          zIndex:          200,
          backgroundColor: 'var(--surface)',
          border:          '0.5px solid var(--border)',
          borderRadius:    10,
          boxShadow:       '0 4px 20px rgba(0,0,0,0.10)',
          overflow:        'hidden',
        }}>
          {/* Search bar */}
          <div style={{ padding: '8px 10px', borderBottom: '0.5px solid var(--border)' }}>
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search domains…"
              style={{
                width:           '100%',
                padding:         '5px 8px',
                borderRadius:    6,
                border:          '0.5px solid var(--border)',
                backgroundColor: 'var(--page-bg)',
                color:           'var(--text-primary)',
                fontSize:        12,
                outline:         'none',
              }}
            />
          </div>

          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {/* Recently used section (only when not searching) */}
            {!search && recent.length > 0 && (
              <>
                <p style={{ padding: '6px 12px 2px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Recently used
                </p>
                {recent.map(d => (
                  <DropRow key={`r-${d.domain_id}`} d={d} selected={value?.domain_id === d.domain_id}
                    onSelect={handleSelect} isAdmin={isAdmin}
                    editing={editingId === d.domain_id}
                    onEdit={() => setEditingId(d.domain_id)}
                    onSaved={handleSaved}
                    onCancelEdit={() => setEditingId(null)}
                    onDelete={handleDelete}
                    deleting={deletingId === d.domain_id}
                  />
                ))}
                <hr style={{ margin: '4px 12px', border: 'none', borderTop: '0.5px solid var(--border)' }} />
                <p style={{ padding: '6px 12px 2px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  All domains
                </p>
              </>
            )}

            {/* Full list / search results */}
            {filtered.map(d => (
              <DropRow key={d.domain_id} d={d} selected={value?.domain_id === d.domain_id}
                onSelect={handleSelect} isAdmin={isAdmin}
                editing={editingId === d.domain_id}
                onEdit={() => setEditingId(d.domain_id)}
                onSaved={handleSaved}
                onCancelEdit={() => setEditingId(null)}
                onDelete={handleDelete}
                deleting={deletingId === d.domain_id}
              />
            ))}

            {filtered.length === 0 && (
              <p style={{ padding: '12px', fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
                No domains match "{search}"
              </p>
            )}
          </div>

          {/* Create new */}
          <div style={{ borderTop: '0.5px solid var(--border)', padding: '8px 10px' }}>
            {creating ? (
              <CreateForm onCreated={d => { handleCreated(d); setDropOpen(false); }} onCancel={() => setCreating(false)} />
            ) : (
              <button
                onClick={() => setCreating(true)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: 13, fontWeight: 500, width: '100%', padding: '2px 0' }}
              >
                <span style={{ fontSize: 16 }}>+</span>
                New domain
              </button>
            )}
          </div>
        </div>
      )}

      {/* Outside-dropdown create form (not needed in this mode but keep creating state clean) */}
    </div>
  );
}

// ── Dropdown row (extracted to keep main component readable) ──────────────────
function DropRow({
  d, selected, onSelect, isAdmin, editing, onEdit, onSaved, onCancelEdit, onDelete, deleting,
}: {
  d:           Domain;
  selected:    boolean;
  onSelect:    (d: Domain) => void;
  isAdmin:     boolean;
  editing:     boolean;
  onEdit:      () => void;
  onSaved:     (d: Domain) => void;
  onCancelEdit:() => void;
  onDelete:    (d: Domain) => void;
  deleting:    boolean;
}) {
  return (
    <div
      onClick={() => !editing && onSelect(d)}
      style={{
        display:         'flex',
        alignItems:      'center',
        padding:         '7px 12px',
        cursor:          editing ? 'default' : 'pointer',
        backgroundColor: selected ? 'var(--accent-tint)' : 'transparent',
        gap:             6,
      }}
      onMouseEnter={e => { if (!selected && !editing) (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--page-bg)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.backgroundColor = selected ? 'var(--accent-tint)' : 'transparent'; }}
    >
      {editing ? (
        <EditForm domain={d} onSaved={onSaved} onCancel={onCancelEdit} />
      ) : (
        <>
          <span style={{ flex: 1, fontSize: 13, color: selected ? 'var(--accent)' : 'var(--text-primary)', fontWeight: selected ? 600 : 400 }}>
            {d.name}
          </span>
          {isAdmin && (
            <span style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
              <button title="Rename" onClick={onEdit}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', color: 'var(--text-muted)', fontSize: 11 }}>✎</button>
              <button title="Delete" disabled={deleting} onClick={() => onDelete(d)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', color: 'var(--confidence-low)', fontSize: 11, opacity: deleting ? 0.4 : 1 }}>✕</button>
            </span>
          )}
        </>
      )}
    </div>
  );
}
