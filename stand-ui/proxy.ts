import { NextRequest, NextResponse } from 'next/server';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { isNativeEdition } from '@/app/api/_lib/edition';

// Native edition behind SPCS ingress: Snowflake authenticates the user before
// any request reaches the container and injects this header. Requests without
// a session cookie bounce through /api/auth/spcs, which VERIFIES the SPCS
// environment (the header alone is never trusted), provisions the account,
// and issues the normal session cookie — everything downstream is unchanged.
const SPCS_USER_HEADER = 'sf-context-current-user';

// The proxy always runs on the Node.js runtime in Next.js 16, so SESSION_SECRET
// and full crypto are available. Route segment config (e.g. `export const
// runtime`) is not allowed in this file.

// Paths that are always accessible without a session
function isPublicPath(pathname: string): boolean {
  if (pathname === '/login')          return true;
  if (pathname === '/accept-invite')  return true;
  if (pathname === '/terms')          return true;  // linked from the login page
  if (pathname === '/privacy')        return true;  // linked from the login page
  if (pathname === '/demo')           return true;  // sample-data demo; client-only, calls no API
  if (pathname === '/api/debug-sentry') return true; // monitoring self-test; 404s unless SENTRY_DSN is set
  if (pathname.startsWith('/api/auth/login'))  return true;
  if (pathname.startsWith('/api/auth/google')) return true;
  if (pathname === '/api/auth/spcs')   return true; // native: SPCS session bootstrap (self-guarding)
  if (pathname === '/api/auth/logout') return true; // must clear a stale/expired cookie unconditionally
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

  const returnTo = pathname + request.nextUrl.search;

  // Native edition with an ingress-authenticated user: bootstrap the cookie
  // instead of showing a login page. /api/auth/spcs re-verifies the SPCS
  // environment server-side; outside SPCS it 404s and the user lands on
  // /login as usual (local docker runs keep Google auth in N2).
  if (isNativeEdition() && request.headers.get(SPCS_USER_HEADER)) {
    const bootstrapUrl = new URL('/api/auth/spcs', request.url);
    if (returnTo !== '/') bootstrapUrl.searchParams.set('returnTo', returnTo);
    return NextResponse.redirect(bootstrapUrl);
  }

  // Pages: redirect to /login, preserving the intended destination
  const loginUrl = new URL('/login', request.url);
  if (returnTo !== '/') loginUrl.searchParams.set('returnTo', returnTo);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
