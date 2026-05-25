'use client';

import { useState, useRef, useEffect } from 'react';

const PERMISSIONS = {
  admin: {
    label:  'Admin',
    color:  '#185FA5',
    bg:     '#EAF1FE',
    border: '#C5D8FC',
    can:    ['View and standardise data', 'Create and review runs', 'Export canonical mappings', 'Invite new users (admin or user)', 'Remove accounts'],
    cannot: [] as string[],
  },
  user: {
    label:  'User',
    color:  '#374151',
    bg:     '#F3F4F6',
    border: '#E5E7EB',
    can:    ['View and standardise data', 'Create and review runs', 'Export canonical mappings'],
    cannot: ['Invite new users', 'Remove accounts'],
  },
} as const;

export default function RoleBadge({ role }: { role: 'admin' | 'user' }) {
  const [open, setOpen] = useState(false);
  const ref             = useRef<HTMLDivElement>(null);
  const timerRef        = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cfg             = PERMISSIONS[role];

  function showTooltip() {
    if (timerRef.current) clearTimeout(timerRef.current);
    setOpen(true);
  }
  function hideTooltip() {
    timerRef.current = setTimeout(() => setOpen(false), 120);
  }

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return (
    <div
      ref={ref}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
    >
      {/* Badge pill */}
      <span
        style={{
          display:         'inline-flex',
          alignItems:      'center',
          height:          28,
          padding:         '0 10px',
          borderRadius:    20,
          fontSize:        12,
          fontWeight:      600,
          letterSpacing:   '0.01em',
          color:           cfg.color,
          backgroundColor: cfg.bg,
          border:          `0.5px solid ${cfg.border}`,
          cursor:          'default',
          userSelect:      'none',
          whiteSpace:      'nowrap',
        }}
      >
        {cfg.label}
      </span>

      {/* Tooltip */}
      {open && (
        <div
          style={{
            position:        'absolute',
            top:             36,
            right:           0,
            minWidth:        230,
            backgroundColor: '#FFFFFF',
            border:          '0.5px solid #E5E7EB',
            borderRadius:    10,
            boxShadow:       '0 4px 20px rgba(0,0,0,0.10)',
            padding:         '14px 16px',
            zIndex:          9999,
          }}
          onMouseEnter={showTooltip}
          onMouseLeave={hideTooltip}
        >
          <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 600, color: '#1A1A2E' }}>
            {cfg.label} permissions
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {cfg.can.map(p => (
              <div key={p} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12, color: '#374151' }}>
                <span style={{ color: '#0F6E56', flexShrink: 0, lineHeight: '16px' }}>✓</span>
                <span>{p}</span>
              </div>
            ))}
            {cfg.cannot.map(p => (
              <div key={p} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12, color: '#9CA3AF' }}>
                <span style={{ color: '#A32D2D', flexShrink: 0, lineHeight: '16px' }}>✗</span>
                <span>{p}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
