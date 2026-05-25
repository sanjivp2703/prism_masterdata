import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import InviteForm from './InviteForm';

export default async function InvitePage() {
  const cookieStore  = await cookies();
  const sessionValue = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const session      = sessionValue ? await decodeSession(sessionValue) : null;

  if (!session) redirect('/login?returnTo=/invite');

  if (session.role !== 'admin') {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ backgroundColor: 'var(--page-bg)', padding: '24px' }}
      >
        <div style={{ maxWidth: 400, textAlign: 'center' }}>
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
          <p className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
            Admin access required
          </p>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Only admins can invite new users. Contact your workspace admin if you need to add someone.
          </p>
        </div>
      </div>
    );
  }

  return <InviteForm />;
}
