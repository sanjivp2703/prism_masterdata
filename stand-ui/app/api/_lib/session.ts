// Session utility — uses Web Crypto API so it works in both
// the Edge runtime (middleware) and Node.js API routes.

export interface SessionPayload {
  accountId: number;
  googleId: string;
  email: string;
  name: string;
  pictureUrl: string | null;
  role: 'admin' | 'user';
}

export const SESSION_COOKIE_NAME = 'prism_session';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// ── Encoding helpers ──────────────────────────────────────────────────────

function toBase64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromBase64url(s: string): ArrayBuffer {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (b64.length % 4)) % 4;
  const padded = b64 + '='.repeat(padding);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function encodePayload(payload: SessionPayload): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  return toBase64url(bytes.buffer as ArrayBuffer);
}

function decodePayload(data: string): SessionPayload {
  const buf = fromBase64url(data);
  const json = new TextDecoder().decode(buf);
  return JSON.parse(json) as SessionPayload;
}

// ── HMAC helpers ──────────────────────────────────────────────────────────

function getSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set. Add it to stand-ui/.env.local');
  return s;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

// ── Public API ────────────────────────────────────────────────────────────

export async function encodeSession(payload: SessionPayload): Promise<string> {
  const data = encodePayload(payload);
  const key  = await importKey(getSecret());
  const sig  = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${toBase64url(sig)}`;
}

export async function decodeSession(cookie: string): Promise<SessionPayload | null> {
  try {
    const lastDot = cookie.lastIndexOf('.');
    if (lastDot === -1) return null;
    const data   = cookie.slice(0, lastDot);
    const sigStr = cookie.slice(lastDot + 1);
    const key    = await importKey(getSecret());
    const valid  = await crypto.subtle.verify(
      'HMAC',
      key,
      fromBase64url(sigStr),
      new TextEncoder().encode(data),
    );
    if (!valid) return null;
    return decodePayload(data);
  } catch {
    return null;
  }
}

export async function buildSessionCookie(payload: SessionPayload): Promise<string> {
  const value = await encodeSession(payload);
  return `${SESSION_COOKIE_NAME}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}
