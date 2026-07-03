'use client';

/**
 * Minimal, dependency-free toast system.
 *
 * Usage:
 *   import ToastHost, { showToast } from '@/app/components/Toast';
 *   // Mount <ToastHost /> once near the root of a page/view, then:
 *   showToast('Something went wrong.', 'error');
 *
 * Toasts render via a portal to document.body (fixed bottom-right), auto-dismiss
 * after ~6 s, and can be dismissed manually. If several ToastHosts are mounted
 * (nested views), only the first-registered one displays — no duplicates.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export type ToastVariant = 'error' | 'info';

interface ToastItem {
  id:      number;
  message: string;
  variant: ToastVariant;
}

type Listener = (t: ToastItem) => void;

// Module-level dispatcher — hosts subscribe, callers fire.
const listeners = new Set<Listener>();
let toastSeq = 0;

export function showToast(message: string, variant: ToastVariant = 'info') {
  const item: ToastItem = { id: ++toastSeq, message, variant };
  if (listeners.size === 0) {
    // No host mounted — don't lose the signal entirely.
    console.warn(`[toast:${variant}]`, message);
    return;
  }
  listeners.forEach((l) => l(item));
}

const AUTO_DISMISS_MS = 6000;

const ACCENT: Record<ToastVariant, string> = {
  error: 'var(--confidence-low)',  // muted red
  info:  'var(--confidence-high)', // muted green
};

export default function ToastHost() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [active, setActive] = useState(false);

  useEffect(() => {
    // Only the first-registered host displays toasts, so nested hosts
    // (e.g. a view inside a page that also mounts one) don't duplicate.
    if (listeners.size > 0) return;

    const timers = new Set<ReturnType<typeof setTimeout>>();
    const onToast: Listener = (t) => {
      setToasts((prev) => [...prev.slice(-3), t]);
      const timer = setTimeout(() => {
        timers.delete(timer);
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, AUTO_DISMISS_MS);
      timers.add(timer);
    };
    listeners.add(onToast);
    setActive(true);
    return () => {
      listeners.delete(onToast);
      timers.forEach(clearTimeout);
    };
  }, []);

  if (!active || toasts.length === 0 || typeof document === 'undefined') return null;

  return createPortal(
    <div
      style={{
        position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
        display: 'flex', flexDirection: 'column', gap: 8,
        width: 'min(380px, calc(100vw - 48px))',
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.variant === 'error' ? 'alert' : 'status'}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            backgroundColor: 'var(--surface)',
            border: '0.5px solid var(--border)',
            borderLeft: `2px solid ${ACCENT[t.variant]}`,
            borderRadius: 'var(--radius-button, 2px)',
            padding: '10px 12px',
          }}
        >
          <span className="text-sm" style={{ color: 'var(--text-secondary)', flex: 1, lineHeight: 1.45 }}>
            {t.message}
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 2,
              color: 'var(--text-hint)', flexShrink: 0, lineHeight: 1, marginTop: 1,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
