'use client';

import { useState, useRef, useEffect } from 'react';
import { getAppMode, APP_MODE_CONFIG } from '@/app/api/_lib/feature-flags';

export default function ModeBadge() {
  const mode          = getAppMode();
  const cfg           = APP_MODE_CONFIG[mode];
  const [open, setOpen] = useState(false);
  const timerRef      = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
    >
      {/* Badge pill */}
      <span
        style={{
          display:         'inline-flex',
          alignItems:      'center',
          gap:             5,
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
        {/* dot indicator */}
        <span
          style={{
            width:           6,
            height:          6,
            borderRadius:    '50%',
            backgroundColor: cfg.color,
            flexShrink:      0,
          }}
        />
        {cfg.label}
      </span>

      {/* Tooltip */}
      {open && (
        <div
          style={{
            position:        'absolute',
            top:             36,
            right:           0,
            minWidth:        260,
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
          <p style={{ margin: '0 0 6px', fontSize: 12, fontWeight: 600, color: '#1A1A2E' }}>
            {cfg.label}
          </p>
          <p style={{ margin: 0, fontSize: 12, color: '#6B7280', lineHeight: '1.5' }}>
            {cfg.description}
          </p>
          <p style={{ margin: '10px 0 0', fontSize: 11, color: '#9CA3AF' }}>
            Set <code style={{ fontFamily: 'monospace', color: '#6B7280' }}>NEXT_PUBLIC_APP_MODE</code> in <code style={{ fontFamily: 'monospace', color: '#6B7280' }}>.env.local</code> to switch modes.
          </p>
        </div>
      )}
    </div>
  );
}
