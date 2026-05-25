'use client';

import { useState, useRef, useEffect } from 'react';

interface Props {
  name: string;
  email: string;
  pictureUrl: string | null;
}

export default function UserMenu({ name, email, pictureUrl }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {/* Avatar button */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          border: '2px solid #E5E7EB',
          overflow: 'hidden',
          cursor: 'pointer',
          padding: 0,
          background: '#EAF1FE',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          boxShadow: '0 1px 4px rgba(0,0,0,0.10)',
          transition: 'border-color 0.15s',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#378ADD'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#E5E7EB'; }}
      >
        {pictureUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={pictureUrl}
            alt={name || email}
            width={36}
            height={36}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            referrerPolicy="no-referrer"
          />
        ) : (
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: '#378ADD',
              lineHeight: 1,
              userSelect: 'none',
            }}
          >
            {(name || email).charAt(0).toUpperCase()}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 44,
            right: 0,
            minWidth: 220,
            backgroundColor: '#FFFFFF',
            border: '0.5px solid #E5E7EB',
            borderRadius: 12,
            boxShadow: '0 4px 20px rgba(0,0,0,0.10)',
            overflow: 'hidden',
            zIndex: 9999,
          }}
        >
          {/* User info header */}
          <div
            style={{
              padding: '14px 16px 12px',
              borderBottom: '0.5px solid #F3F4F6',
            }}
          >
            <p style={{ fontSize: 13, fontWeight: 600, color: '#1A1A2E', margin: 0, lineHeight: 1.3 }}>
              {name || 'User'}
            </p>
            <p style={{ fontSize: 12, color: '#6B7280', margin: '2px 0 0', lineHeight: 1.3 }}>
              {email}
            </p>
          </div>

          {/* Sign out */}
          <a
            href="/api/auth/logout"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 16px',
              fontSize: 13,
              color: '#374151',
              textDecoration: 'none',
              transition: 'background-color 0.12s',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.backgroundColor = '#F9FAFB'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.backgroundColor = 'transparent'; }}
          >
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
              <path d="M5.5 13H3a1 1 0 01-1-1V3a1 1 0 011-1h2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <path d="M10 10l3-2.5L10 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M13 7.5H6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            Sign out
          </a>
        </div>
      )}
    </div>
  );
}
