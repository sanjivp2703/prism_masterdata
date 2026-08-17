'use client';

// Clickwrap interstitial: every account must explicitly accept the current
// terms once before using the app. Reached from the OAuth callback (all
// sign-ins) and the /home gate (pre-existing sessions). Acceptance is
// recorded server-side (accounts.terms_accepted_version, migration 017).

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { isNativeEdition } from '@/app/api/_lib/edition';

// Same open-redirect guard idea as sanitizeReturnTo (which is server-only):
// only same-origin relative paths are honored.
function safeNext(raw: string | null): string {
  if (!raw) return '/home';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/home';
  return raw;
}

function AcceptTermsInner() {
  const next = safeNext(useSearchParams().get('next'));
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    if (!checked || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/accounts/accept-terms', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.location.href = next;
    } catch {
      setBusy(false);
      setError('Something went wrong saving your acceptance. Please try again.');
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center px-6"
      style={{ backgroundColor: 'var(--page-bg)' }}
    >
      <div className="flex flex-col items-center">
        <div
          className="w-full rounded-card"
          style={{
            maxWidth: 440,
            backgroundColor: 'var(--surface)',
            border: '0.5px solid var(--border)',
            padding: 32,
          }}
        >
          <h1
            className="text-lg font-semibold text-center mb-2"
            style={{ color: 'var(--text-primary)' }}
          >
            One more thing before you start
          </h1>
          <p
            className="text-sm text-center mb-6"
            style={{ color: 'var(--text-muted)' }}
          >
            Please review and accept our terms to use Prism.
          </p>

          <div
            className="rounded-button text-sm mb-6"
            style={{
              border: '0.5px solid var(--border)',
              backgroundColor: 'var(--surface-hover)',
              padding: '14px 16px',
              color: 'var(--text-secondary)',
              lineHeight: 1.55,
            }}
          >
            Prism standardizes data from sources your workspace connects. By
            continuing you agree to the{' '}
            <a
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--accent)', textDecoration: 'underline' }}
            >
              Terms of service
            </a>{' '}
            and the{' '}
            <a
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--accent)', textDecoration: 'underline' }}
            >
              Privacy policy
            </a>
            , which describe how Prism connects to your data warehouse, what
            data is processed during standardization, and your
            responsibilities as a user. Both open in a new tab.
            {' '}Two things to know before you start:
            {' '}<strong>Prism is a shared workspace</strong> — everyone in it
            sees all pipelines, mappings, and standardized values, including
            values from tables that person couldn&apos;t open directly in
            Snowflake.
            {' '}<strong>Prism uses AI</strong>{isNativeEdition()
              ? <> — Claude models running on Snowflake Cortex inside your company&apos;s own Snowflake account. Your data never leaves Snowflake, and the AI compute bills to your company&apos;s Snowflake account (no separate AI subscription).</>
              : <> — the AI provider your workspace admin configured (such as Claude). Distinct column values are sent to that provider during standardization, billed to your company&apos;s provider account.</>}
          </div>

          <label
            className="flex items-start gap-3 text-sm cursor-pointer select-none mb-6"
            style={{ color: 'var(--text-secondary)' }}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-0.5"
              style={{ width: 16, height: 16, accentColor: 'var(--accent)' }}
            />
            <span>
              I have read and agree to the Terms of service and Privacy policy.
            </span>
          </label>

          {error && (
            <div
              className="mb-4 rounded-button px-4 py-3 text-sm"
              style={{
                backgroundColor: '#FEF2F2',
                border: '0.5px solid #FECACA',
                color: '#991B1B',
              }}
            >
              {error}
            </div>
          )}

          <button
            onClick={accept}
            disabled={!checked || busy}
            className="w-full rounded-button text-sm font-medium transition-colors"
            style={{
              height: 44,
              backgroundColor: checked ? 'var(--accent)' : 'var(--accent-tint)',
              color: checked ? '#FFFFFF' : 'var(--accent-strong)',
              border: '0.5px solid',
              borderColor: checked ? 'var(--accent)' : 'var(--accent-border)',
              cursor: checked && !busy ? 'pointer' : 'not-allowed',
              opacity: busy ? 0.7 : 1,
            }}
          >
            {busy ? 'Saving…' : 'Agree and continue'}
          </button>
        </div>

        <p className="mt-6 text-xs text-center" style={{ color: 'var(--text-hint)' }}>
          Don&apos;t agree?{' '}
          <a
            href="/api/auth/logout"
            style={{ color: 'var(--text-hint)', textDecoration: 'underline' }}
          >
            Sign out
          </a>
          .
        </p>
      </div>
    </div>
  );
}

// useSearchParams() requires a Suspense boundary in the App Router.
export default function AcceptTermsPage() {
  return (
    <Suspense>
      <AcceptTermsInner />
    </Suspense>
  );
}
