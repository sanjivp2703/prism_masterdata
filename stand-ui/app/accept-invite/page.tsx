import { getDb } from '@/app/api/_lib/sqlite';

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4" />
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853" />
      <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05" />
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335" />
    </svg>
  );
}

const ERROR_MESSAGES: Record<string, string> = {
  invite_invalid:   'This invitation link is invalid or has already been used.',
  email_mismatch:   'The Google account you signed in with does not match the invited email address. Please sign in with the correct account.',
};

interface Props {
  searchParams: Promise<{ token?: string; error?: string }>;
}

type InviteStatus = 'valid' | 'invalid' | 'expired' | 'revoked' | 'already_accepted' | 'db_error';

export default async function AcceptInvitePage({ searchParams }: Props) {
  const { token, error: urlError } = await searchParams;

  if (!token) {
    return <ErrorState message="This invitation link is missing a token. Please use the link from your invitation email." />;
  }

  if (urlError) {
    return <ErrorState message={ERROR_MESSAGES[urlError] ?? 'Something went wrong. Please contact the person who invited you.'} />;
  }

  // Validate the token against the local SQLite invitations table.
  let invitedEmail = '';
  let inviteStatus: InviteStatus;
  try {
    const invite = getDb()
      .prepare(`SELECT invited_email, status, expires_at FROM invitations WHERE token = ?`)
      .get(token) as { invited_email: string; status: string; expires_at: string } | undefined;

    if (!invite) {
      inviteStatus = 'invalid';
    } else if (invite.status === 'accepted') {
      inviteStatus = 'already_accepted';
    } else if (invite.status === 'revoked') {
      inviteStatus = 'revoked';
    } else if (invite.status !== 'pending' || new Date(invite.expires_at) < new Date()) {
      inviteStatus = 'expired';
    } else {
      invitedEmail = String(invite.invited_email);
      inviteStatus = 'valid';
    }
  } catch {
    inviteStatus = 'db_error';
  }

  if (inviteStatus !== 'valid') {
    const messages: Record<string, string> = {
      invalid:          'This invitation link is invalid or has already been used.',
      expired:          'This invitation link has expired. Please ask the person who invited you to send a new one.',
      revoked:          'This invitation was revoked. Ask your admin for a new one.',
      already_accepted: 'This invitation has already been accepted. Try signing in instead.',
      db_error:         'Could not verify your invitation at this time. Please try again shortly.',
    };
    return <ErrorState message={messages[inviteStatus]} showLogin={inviteStatus === 'already_accepted'} />;
  }

  const loginHref = `/api/auth/login?inviteToken=${encodeURIComponent(token)}&returnTo=/home`;

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ backgroundColor: 'var(--page-bg)', padding: '24px' }}
    >
      <div style={{ width: '100%', maxWidth: 460 }}>

        {/* Brand */}
        <div className="flex items-center gap-2 mb-8 justify-center">
          <svg width="44" height="34" viewBox="0 0 44 34" fill="none" aria-hidden="true">
            <polygon points="0,0 0,34 22,17" fill="#1A1A2E" />
            <polygon points="44,0 44,34 22,17" fill="#378ADD" />
            <circle cx="22" cy="17" r="2.2" fill="white" />
          </svg>
          <span className="text-[28px] font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>Prism</span>
        </div>

        <div
          className="rounded-[14px] border-[0.5px]"
          style={{ backgroundColor: 'var(--surface)', borderColor: 'var(--border)', padding: '32px 28px' }}
        >
          <h1 className="text-[18px] font-semibold mb-1 text-center" style={{ color: 'var(--text-primary)' }}>
            You&apos;ve been invited
          </h1>
          <p className="text-sm text-center mb-6" style={{ color: 'var(--text-muted)' }}>
            Sign in with <strong>{invitedEmail}</strong> to accept your invitation and join Prism.
          </p>

          {/* Disclosure */}
          <div
            className="rounded-[10px] mb-6 text-xs leading-relaxed"
            style={{ backgroundColor: '#FFFBEB', border: '0.5px solid #FDE68A', padding: '14px 16px', color: '#78350F' }}
          >
            <p className="font-semibold mb-1.5" style={{ color: '#92400E' }}>Before you continue</p>
            By accepting this invitation you will gain access to the Prism workspace and may be
            able to view data standardized by other workspace members. Only proceed if you
            consent to this access.{' '}
            Signing in uses your Google account for identity only — Prism asks for
            spreadsheet access separately, and only if you later connect a Google Sheet.{' '}
            <strong>Prism is not liable for any consequences related to data shared on this platform.</strong>{' '}
            By continuing you agree to the{' '}
            <a href="/terms" style={{ color: '#78350F', textDecoration: 'underline' }}>Terms</a> and{' '}
            <a href="/privacy" style={{ color: '#78350F', textDecoration: 'underline' }}>Privacy policy</a>.
          </div>

          <a
            href={loginHref}
            className="flex items-center justify-center gap-3 w-full rounded-[8px] border text-sm font-medium"
            style={{
              height: 44,
              borderColor: 'var(--border)',
              backgroundColor: 'var(--surface)',
              color: 'var(--text-primary)',
              textDecoration: 'none',
            }}
          >
            <GoogleMark />
            Accept &amp; sign in with Google
          </a>
        </div>
      </div>
    </div>
  );
}

function ErrorState({ message, showLogin = false }: { message: string; showLogin?: boolean }) {
  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ backgroundColor: 'var(--page-bg)', padding: '24px' }}
    >
      <div style={{ width: '100%', maxWidth: 420, textAlign: 'center' }}>
        <div
          className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4"
          style={{ backgroundColor: '#FEE2E2', color: '#991B1B' }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M10 3a7 7 0 100 14A7 7 0 0010 3z" stroke="currentColor" strokeWidth="1.4" />
            <path d="M10 7v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="10" cy="13.5" r="0.75" fill="currentColor" />
          </svg>
        </div>
        <p className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Invitation issue</p>
        <p className="text-sm mb-5" style={{ color: 'var(--text-muted)' }}>{message}</p>
        {showLogin && (
          <a href="/login" className="text-sm font-medium" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
            Go to sign in
          </a>
        )}
      </div>
    </div>
  );
}
