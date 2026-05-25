/**
 * GET  /api/admin/config   — returns current app mode
 * PATCH /api/admin/config  — updates NEXT_PUBLIC_APP_MODE in .env.local
 *
 * Writing to .env.local takes effect after the Next.js dev server is restarted.
 * Admin role required.
 */

import 'server-only';
import fs   from 'node:fs';
import path from 'node:path';
import { cookies } from 'next/headers';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { getAppMode, type AppMode } from '@/app/api/_lib/feature-flags';

const VALID_MODES: AppMode[] = ['basic', 'premium'];
const ENV_PATH = path.join(process.cwd(), '.env.local');

function readEnvLocal(): string {
  try { return fs.readFileSync(ENV_PATH, 'utf8'); } catch { return ''; }
}

function writeMode(mode: AppMode): void {
  const content  = readEnvLocal();
  const updated  = content.replace(
    /^NEXT_PUBLIC_APP_MODE=.*/m,
    `NEXT_PUBLIC_APP_MODE=${mode}`,
  );
  // If the key didn't exist yet, append it.
  const final = updated.includes('NEXT_PUBLIC_APP_MODE=')
    ? updated
    : `${updated}\nNEXT_PUBLIC_APP_MODE=${mode}\n`;
  fs.writeFileSync(ENV_PATH, final, 'utf8');
}

async function requireAdmin(): Promise<Response | null> {
  const cookieStore = await cookies();
  const session = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session)               return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (session.role !== 'admin') return Response.json({ error: 'Forbidden' },    { status: 403 });
  return null;
}

export async function GET() {
  const deny = await requireAdmin();
  if (deny) return deny;
  return Response.json({ mode: getAppMode() });
}

export async function PATCH(request: Request) {
  const deny = await requireAdmin();
  if (deny) return deny;

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const mode = body?.mode as AppMode | undefined;
  if (!mode || !VALID_MODES.includes(mode)) {
    return Response.json(
      { error: `mode must be one of: ${VALID_MODES.join(', ')}` },
      { status: 400 },
    );
  }

  try {
    writeMode(mode);
  } catch (err) {
    return Response.json(
      { error: `Could not write .env.local: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    );
  }

  return Response.json({ ok: true, mode, restartRequired: true });
}
