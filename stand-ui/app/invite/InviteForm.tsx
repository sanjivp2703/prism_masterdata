'use client';

import { useState } from 'react';
import Link from 'next/link';

const DISCLOSURE = `By inviting a new user to this workspace, you acknowledge and agree to the following:

1. Data access. The invited user will gain access to this Prism workspace upon acceptance. This includes the ability to view run history, canonical mappings, raw literal values, and any other data that has been standardized within this workspace.

2. Your responsibility. You are solely responsible for ensuring that you have the necessary authority to grant the invited person access to the data contained in this workspace. You should not invite anyone unless you are certain that sharing the relevant data with that person is appropriate and permitted under any applicable legal, contractual, or organizational obligations.

3. No liability. Prism and its operators expressly disclaim all liability for any consequences — including, without limitation, data breaches, regulatory violations, contractual disputes, or commercial losses — arising from or related to your decision to invite a new user or that user's subsequent access to data on this platform.

By proceeding you confirm that you have read, understood, and agreed to the above.`;

const ROLE_INFO = {
  admin: {
    label: 'Admin',
    can:    ['View and standardize data', 'Create and review runs', 'Export canonical mappings', 'Invite new users', 'Remove accounts'],
    cannot: [] as string[],
  },
  user: {
    label: 'User',
    can:    ['View and standardize data', 'Create and review runs', 'Export canonical mappings'],
    cannot: ['Invite new users', 'Remove accounts'],
  },
};

export default function InviteForm() {
  const [email,        setEmail]        = useState('');
  const [role,         setRole]         = useState<'user' | 'admin'>('user');
  const [agreed,       setAgreed]       = useState(false);
  const [status,       setStatus]       = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errMsg,       setErrMsg]       = useState('');
  const [sentEmail,    setSentEmail]    = useState('');
  const [acceptUrl,    setAcceptUrl]    = useState('');
  const [emailSent,    setEmailSent]    = useState(true);
  const [copied,       setCopied]       = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!agreed || status === 'sending') return;
    setStatus('sending');
    setErrMsg('');

    try {
      const res  = await fetch('/api/invitations', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, role }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setErrMsg(body?.error || 'Something went wrong.'); setStatus('error'); return; }
      setSentEmail(email);
      setEmailSent(body.emailSent !== false);
      setAcceptUrl(body.acceptUrl ?? '');
      setStatus('sent');
    } catch {
      setErrMsg('Network error. Please try again.');
      setStatus('error');
    }
  }

  const selectedRole = ROLE_INFO[role];

  return (
    <div
      className="min-h-screen flex items-start justify-center"
      style={{ backgroundColor: 'var(--page-bg)', padding: '48px var(--page-padding-x)' }}
    >
      <div style={{ width: '100%', maxWidth: 560 }}>

        <Link href="/home" className="inline-flex items-center gap-1.5 text-sm mb-8" style={{ color: 'var(--text-muted)', textDecoration: 'none' }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M9 3L5 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to home
        </Link>

        <h1 className="text-[22px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Invite a teammate</h1>
        <p className="text-sm mb-8" style={{ color: 'var(--text-muted)' }}>
          Send an invitation to grant someone access to this Prism workspace.
        </p>

        {status === 'sent' ? (
          <div className="rounded-[12px] border-[0.5px] p-6" style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)' }}>
            <div className="flex items-start gap-3 mb-4">
              <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: emailSent ? '#D1FAE5' : '#FEF3C7', color: emailSent ? '#065F46' : '#92400E' }}>
                {emailSent ? (
                  <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                    <path d="M3.5 9.5l4 4 7-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13z" stroke="currentColor" strokeWidth="1.2" />
                    <path d="M8 5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    <circle cx="8" cy="11" r="0.75" fill="currentColor" />
                  </svg>
                )}
              </div>
              <div>
                <p className="text-sm font-semibold mb-0.5" style={{ color: 'var(--text-primary)' }}>
                  {emailSent ? 'Invitation sent' : 'Invitation created — share this link'}
                </p>
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  {emailSent
                    ? <><strong>{sentEmail}</strong> has been invited as <strong>{ROLE_INFO[role].label}</strong>. The link expires in 7 days. Invitation emails sometimes land in <strong>spam</strong> — if it hasn&apos;t arrived in a few minutes, ask them to check there, or send them the link below yourself.</>
                    : <>The email couldn&apos;t be sent, but the invitation is valid. Copy and share this link with <strong>{sentEmail}</strong>:</>
                  }
                </p>
              </div>
            </div>

            {/* Copy-link box — shown whenever a link exists, including after a
                successful send: the mail may be spam-filtered, and this is the
                inviter's only workaround (finding #24). */}
            {acceptUrl && (
              <div
                className="rounded-[8px] border-[0.5px] flex items-center gap-2 mb-4 overflow-hidden"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--page-bg)' }}
              >
                <span
                  className="flex-1 text-xs px-3 py-2.5 truncate select-all"
                  style={{ color: 'var(--text-secondary)', fontFamily: 'monospace' }}
                >
                  {acceptUrl}
                </span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(acceptUrl).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    });
                  }}
                  className="text-xs font-medium px-3 py-2.5 flex-shrink-0"
                  style={{
                    backgroundColor: copied ? '#D1FAE5' : 'var(--accent-tint)',
                    color: copied ? '#065F46' : 'var(--accent)',
                    border: 'none',
                    cursor: 'pointer',
                    borderLeft: '0.5px solid var(--border)',
                  }}
                >
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            )}

            {!emailSent && (
              <p className="text-xs mb-4" style={{ color: 'var(--text-hint)' }}>
                To enable automatic emails, set RESEND_API_KEY (an HTTPS email API — works on hosts that block SMTP, which most cloud providers do) or the SMTP_HOST / SMTP_USER / SMTP_PASS trio in .env.local.
              </p>
            )}

            <button
              onClick={() => { setEmail(''); setRole('user'); setAgreed(false); setStatus('idle'); setErrMsg(''); setSentEmail(''); setAcceptUrl(''); setEmailSent(true); setCopied(false); }}
              className="text-sm font-medium"
              style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              Invite another person
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>

            {/* Email */}
            <div className="rounded-[14px] border-[0.5px] mb-5" style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: '24px' }}>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>Email address</label>
              <input
                type="email" required value={email} onChange={e => setEmail(e.target.value)}
                placeholder="colleague@company.com"
                className="w-full rounded-[8px] border-[0.5px] text-sm px-3 py-2.5 outline-none"
                style={{ borderColor: 'var(--border)', backgroundColor: 'var(--page-bg)', color: 'var(--text-primary)' }}
                onFocus={e => { (e.target as HTMLInputElement).style.borderColor = 'var(--accent)'; }}
                onBlur={e  => { (e.target as HTMLInputElement).style.borderColor = 'var(--border)';  }}
              />
            </div>

            {/* Role selector */}
            <div className="rounded-[14px] border-[0.5px] mb-5" style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: '24px' }}>
              <p className="text-sm font-medium mb-3" style={{ color: 'var(--text-primary)' }}>Invite as</p>
              <div className="flex gap-3 mb-4">
                {(['user', 'admin'] as const).map(r => (
                  <button
                    key={r} type="button" onClick={() => setRole(r)}
                    className="flex-1 rounded-[8px] border py-2.5 text-sm font-medium transition-colors"
                    style={{
                      borderColor:     role === r ? 'var(--accent)' : 'var(--border)',
                      backgroundColor: role === r ? 'var(--accent-tint)' : 'transparent',
                      color:           role === r ? 'var(--accent)' : 'var(--text-muted)',
                    }}
                  >
                    {ROLE_INFO[r].label}
                  </button>
                ))}
              </div>

              {/* Role permissions preview */}
              <div className="rounded-[8px] px-4 py-3" style={{ backgroundColor: 'var(--page-bg)', border: '0.5px solid var(--border)' }}>
                <p className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>{selectedRole.label} permissions</p>
                <div className="flex flex-col gap-1">
                  {selectedRole.can.map(p => (
                    <div key={p} className="flex items-center gap-2 text-xs" style={{ color: '#374151' }}>
                      <span style={{ color: '#0F6E56' }}>✓</span>{p}
                    </div>
                  ))}
                  {selectedRole.cannot.map(p => (
                    <div key={p} className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-hint)' }}>
                      <span style={{ color: '#A32D2D' }}>✗</span>{p}
                    </div>
                  ))}
                </div>
                {/* Expiry stated BEFORE sending, not only on the confirmation
                    screen. The security doc credits "7-day expiry" as part of
                    what the admin is told at invite time, but it only rendered
                    after the invite had already gone out (SEC-07). */}
                <p className="text-[11px] mt-2" style={{ color: 'var(--text-hint)' }}>
                  The invitation link expires in 7 days.
                </p>
              </div>
            </div>

            {/* Disclosure */}
            <div className="rounded-[14px] border-[0.5px] mb-5" style={{ backgroundColor: '#FFFBEB', borderColor: '#FDE68A', padding: '20px 22px' }}>
              <div className="flex items-start gap-3 mb-3">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }}>
                  <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13z" stroke="#92400E" strokeWidth="1.2" />
                  <path d="M8 5.5v3.5" stroke="#92400E" strokeWidth="1.5" strokeLinecap="round" />
                  <circle cx="8" cy="11" r="0.75" fill="#92400E" />
                </svg>
                <p className="text-xs font-semibold" style={{ color: '#92400E' }}>Important disclosure — please read before proceeding</p>
              </div>
              <pre className="text-xs leading-relaxed whitespace-pre-wrap" style={{ color: '#78350F', fontFamily: 'inherit', margin: 0 }}>
                {DISCLOSURE}
              </pre>
            </div>

            {/* Checkbox */}
            <label className="flex items-start gap-3 mb-5 cursor-pointer">
              <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} style={{ accentColor: 'var(--accent)', width: 14, height: 14, marginTop: 2, flexShrink: 0 }} />
              <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                I have read the disclosure above and confirm that I have the authority to invite this person and share workspace data with them.
              </span>
            </label>

            {errMsg && (
              <div className="mb-4 rounded-[8px] px-4 py-2.5 text-sm" style={{ backgroundColor: '#FEF2F2', border: '0.5px solid #FECACA', color: '#991B1B' }}>
                {errMsg}
              </div>
            )}

            <button
              type="submit" disabled={!agreed || !email || status === 'sending'}
              className="w-full rounded-[8px] text-sm font-medium py-2.5"
              style={{
                backgroundColor: 'var(--accent)', color: '#FFFFFF', border: 'none',
                opacity: (!agreed || !email || status === 'sending') ? 0.45 : 1,
                cursor:  (!agreed || !email || status === 'sending') ? 'not-allowed' : 'pointer',
              }}
            >
              {status === 'sending' ? 'Sending…' : `Send invitation`}
            </button>

          </form>
        )}
      </div>
    </div>
  );
}
