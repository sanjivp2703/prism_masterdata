import { clearSessionCookie } from '@/app/api/_lib/session';

export async function GET() {
  return new Response(null, {
    status: 302,
    headers: {
      Location:   '/login',
      'Set-Cookie': clearSessionCookie(),
    },
  });
}
