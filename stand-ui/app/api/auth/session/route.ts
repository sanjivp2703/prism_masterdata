import { cookies } from 'next/headers';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';

export async function GET() {
  const cookieStore  = await cookies();
  const sessionValue = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const session      = sessionValue ? await decodeSession(sessionValue) : null;

  if (!session) return Response.json({ authenticated: false }, { status: 401 });

  return Response.json({
    authenticated: true,
    accountId:     session.accountId,
    role:          session.role,
    email:         session.email,
    name:          session.name,
  });
}
