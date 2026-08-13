import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Native (Marketplace) edition: no operator ever provisions this install, so
 * SESSION_SECRET / PRISM_ENCRYPTION_KEY cannot come from a human. Generate
 * them once at first boot and persist beside the SQLite file on the app's
 * block volume (mode 600) — stable across restarts/upgrades, unique per
 * installation, and the service spec ships with NO secrets at all (which is
 * also what the marketplace security scan wants to see). Env values still
 * win when present and real ('change-me…' placeholders are treated as absent).
 */
export async function ensureNativeSecrets(): Promise<void> {
  const { isNativeEdition } = await import('./app/api/_lib/edition');
  if (!isNativeEdition()) return;
  const needs = (v?: string) => !v || v.trim() === '' || v.startsWith('change-me');
  if (!needs(process.env.SESSION_SECRET) && !needs(process.env.PRISM_ENCRYPTION_KEY)) return;
  const dir = path.dirname(process.env.PRISM_SQLITE_PATH?.trim() || './data/prism.db');
  const file = path.join(dir, 'app-secrets.json');
  let secrets: { session_secret?: string; encryption_key?: string } = {};
  try { secrets = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first boot */ }
  if (!secrets.session_secret || !secrets.encryption_key) {
    secrets = {
      session_secret: secrets.session_secret ?? crypto.randomBytes(32).toString('hex'),
      encryption_key: secrets.encryption_key ?? crypto.randomBytes(32).toString('hex'),
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 });
  }
  if (needs(process.env.SESSION_SECRET))       process.env.SESSION_SECRET       = secrets.session_secret;
  if (needs(process.env.PRISM_ENCRYPTION_KEY)) process.env.PRISM_ENCRYPTION_KEY = secrets.encryption_key;
}

