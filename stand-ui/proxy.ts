import { NextRequest, NextResponse } from 'next/server';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';

// The proxy always runs on the Node.js runtime in Next.js 16, so SESSION_SECRET
// and full crypto are available. Route segment config (e.g. `export const
// runtime`) is not allowed in this file.

// Paths that are always accessible without a session
function isPublicPath(pathname: string): boolean {
  if (pathname === '/login')          return true;
  if (pathname === '/accept-invite')  return true;
  if (pathname === '/terms')          return true;  // linked from the login page
  if (pathname === '/privacy')        return true;  // linked from the login page
  if (pathname === '/api/debug-sentry') return true; // monitoring self-test; 404s unless SENTRY_DSN is set
  if (pathname.startsWith('/api/auth/login'))  return true;
  if (pathname.startsWith('/api/auth/google')) return true;
  return false;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) return NextResponse.next();

  const sessionValue = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = sessionValue ? await decodeSession(sessionValue) : null;

  if (session) return NextResponse.next();

  // API routes: return 401 JSON rather than an HTML redirect
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Pages: redirect to /login, preserving the intended destination
  const loginUrl = new URL('/login', request.url);
  const returnTo = pathname + request.nextUrl.search;
  if (returnTo !== '/') loginUrl.searchParams.set('returnTo', returnTo);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
