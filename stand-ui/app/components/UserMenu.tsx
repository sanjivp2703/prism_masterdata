'use client';

import { useState, useRef, useEffect } from 'react';
import { isNativeEdition } from '@/app/api/_lib/edition';

interface Props {
  name: string;
  email: string;
  pictureUrl: string | null;
}

export default function UserMenu({ name, email, pictureUrl }: Props) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // The layout only passes name/email/picture — fetch the session role
  // client-side so the Settings item can be admin-only.
  //
  // A 401 here means the session was REVOKED (member removed / role changed):
  // the cookie's signature still verifies, so pages render, but the account's
  // session_version no longer matches. Send them through logout — clears the
  // stale cookie and lands on /login — instead of leaving a zombie UI whose
  // API calls all fail.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/session', { cache: 'no-store' })
      .then((r) => {
        if (r.status === 401) {
          window.location.href = '/api/auth/logout';
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then((d) => { if (!cancelled && d) setRole(d.role ?? null); })
      .catch(() => { /* no role → no Settings item */ });
    return () => { cancelled = true; };
  }, []);

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
          // 0.5px per the design system — the two documented border exceptions
          // (drag-over left edge, featured-card accent) do not apply to an avatar
          // button, so 2px made this the heaviest border in the app (UI-01).
          border: '0.5px solid #E5E7EB',
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
            borderRadius: 'var(--radius-card)',   // was a hardcoded 12px — off-system (UI-01)
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

          {/* Settings (admins only) */}
          {role === 'admin' && (
            <a
              href="/settings"
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
                <circle cx="7.5" cy="7.5" r="2.2" stroke="currentColor" strokeWidth="1.4" />
                <path d="M7.5 1.5v2M7.5 11.5v2M1.5 7.5h2M11.5 7.5h2M3.26 3.26l1.41 1.41M10.33 10.33l1.41 1.41M3.26 11.74l1.41-1.41M10.33 4.67l1.41-1.41" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              Settings
            </a>
          )}

          {/* Data access (native, admins): the grant block lives on /setup,
              which after the one-time welcome modal had NO link from anywhere
              in the app — the "Admin" badge is a permissions tooltip, and the
              owner reasonably expected it to open setup (2026-10-04). */}
          {role === 'admin' && isNativeEdition() && (
            <a
              href="/setup?next=%2Fhome"
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
                <rect x="2" y="6.5" width="11" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
                <path d="M4.5 6.5V4.5a3 3 0 016 0v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
              Data access
            </a>
          )}

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
