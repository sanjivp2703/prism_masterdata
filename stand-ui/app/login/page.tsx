import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';

// ── Prism mark (duplicated here so login page has no client imports) ──────
function PrismMark({ size = 40 }: { size?: number }) {
  const h = size;
  const w = Math.round(size * 1.28);
  const cx = w / 2;
  const cy = h / 2;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none" aria-hidden="true">
      <polygon points={`0,0 0,${h} ${cx},${cy}`} fill="#1A1A2E" />
      <polygon points={`${w},0 ${w},${h} ${cx},${cy}`} fill="#378ADD" />
      <circle cx={cx} cy={cy} r={size * 0.065} fill="white" />
    </svg>
  );
}

// ── Google "G" mark ───────────────────────────────────────────────────────
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
  oauth_denied:          'Sign-in was cancelled. Please try again.',
  no_code:               'No authorization code was received from Google.',
  token_exchange_failed: 'Could not exchange the Google code for tokens. Please try again.',
  no_profile:            'Could not retrieve your Google profile. Please try again.',
  no_access:             "This Google account hasn't been invited to this workspace. Ask an admin to send you an invite.",
};

interface Props {
  searchParams: Promise<{ returnTo?: string; error?: string }>;
}

export default async function LoginPage({ searchParams }: Props) {
  const { returnTo, error } = await searchParams;

  // If already logged in, go straight to the app
  const cookieStore = await cookies();
  const sessionValue = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (sessionValue) {
    const session = await decodeSession(sessionValue);
    if (session) redirect(returnTo || '/home');
  }

  const loginHref = returnTo
    ? `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`
    : '/api/auth/login';

  const errorMessage = error ? (ERROR_MESSAGES[error] ?? 'Something went wrong. Please try again.') : null;

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ backgroundColor: 'var(--page-bg)', padding: '24px' }}
    >
      <div
        className="w-full flex flex-col items-center"
        style={{ maxWidth: 400 }}
      >
        {/* Brand */}
        <div className="flex items-center gap-3 mb-8">
          <PrismMark size={44} />
          <span
            className="text-[30px] font-semibold tracking-tight"
            style={{ color: 'var(--text-primary)' }}
          >
            Prism
          </span>
        </div>

        {/* Card */}
        <div
          className="w-full rounded-[14px] border-[0.5px]"
          style={{
            backgroundColor: 'var(--surface)',
            borderColor: 'var(--border)',
            padding: '32px 28px',
          }}
        >
          <h1
            className="text-[18px] font-semibold mb-1 text-center"
            style={{ color: 'var(--text-primary)' }}
          >
            Sign in to Prism
          </h1>
          <p
            className="text-sm text-center mb-7"
            style={{ color: 'var(--text-muted)' }}
          >
            Use your Google account to continue
          </p>

          {errorMessage && (
            <div
              className="mb-5 rounded-[8px] px-4 py-3 text-sm"
              style={{
                backgroundColor: '#FEF2F2',
                border: '0.5px solid #FECACA',
                color: '#991B1B',
              }}
            >
              {errorMessage}
            </div>
          )}

          <a
            href={loginHref}
            className="flex items-center justify-center gap-3 w-full rounded-[8px] border text-sm font-medium transition-colors"
            style={{
              height: 44,
              borderColor: 'var(--border)',
              backgroundColor: 'var(--surface)',
              color: 'var(--text-primary)',
            }}
            onMouseEnter={undefined}
          >
            <GoogleMark />
            Continue with Google
          </a>
        </div>

        <p
          className="mt-6 text-xs text-center"
          style={{ color: 'var(--text-hint)', maxWidth: 320 }}
        >
          By signing in you agree to our{' '}
          <a href="/terms" style={{ color: 'var(--text-hint)', textDecoration: 'underline' }}>
            Terms
          </a>{' '}
          and{' '}
          <a href="/privacy" style={{ color: 'var(--text-hint)', textDecoration: 'underline' }}>
            Privacy policy
          </a>
          . Signing in uses your Google account for identity only. Prism asks for
          spreadsheet access separately, and only if you connect or export a Google Sheet.
        </p>
      </div>
    </div>
  );
}
