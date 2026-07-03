// Session utility — uses Web Crypto API so it works in both
// the Edge runtime (middleware) and Node.js API routes.

export interface SessionPayload {
  accountId: number;
  googleId: string;
  email: string;
  name: string;
  pictureUrl: string | null;
  role: 'admin' | 'user';
  /** Session version — must match ACCOUNTS.session_version to be accepted by
   *  version-checked routes. Bumped server-side to revoke live sessions. */
  v?: number;
  /** Expiry (epoch ms). Set on encode; sessions without it are rejected. */
  exp?: number;
}

export const SESSION_COOKIE_NAME = 'prism_session';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Mark cookies Secure in production (HTTPS); keep plain-http localhost dev working.
const SECURE_SUFFIX = process.env.NODE_ENV === 'production' ? '; Secure' : '';

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
  const full: SessionPayload = {
    ...payload,
    v:   payload.v   ?? 1,
    exp: payload.exp ?? Date.now() + SESSION_TTL_MS,
  };
  const data = encodePayload(full);
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
    const payload = decodePayload(data);
    // No/invalid exp = treat as expired (forces one re-login after deploy).
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function buildSessionCookie(payload: SessionPayload): Promise<string> {
  const value = await encodeSession(payload);
  return `${SESSION_COOKIE_NAME}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${SECURE_SUFFIX}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${SECURE_SUFFIX}`;
}

/**
 * Sanitize a user/state-supplied post-auth redirect target.
 * Only same-origin relative paths are allowed: must start with '/', must not
 * be protocol-relative ('//…') or contain a backslash (browsers normalize
 * '/\' to '//'). Anything else falls back to `fallback`.
 */
export function sanitizeReturnTo(value: unknown, fallback = '/home'): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//')) return fallback;
  if (value.includes('\\')) return fallback;
  return value;
}
