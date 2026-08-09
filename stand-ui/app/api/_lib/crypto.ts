import 'server-only';

/**
 * Application-level secret encryption (AES-256-GCM).
 *
 * Protects secrets stored at rest in Snowflake VARIANT/VARCHAR columns:
 *   - sf_password           (Snowflake password auth fallback)
 *   - sf_private_key        (Snowflake key-pair PEM)
 *   - Google refresh_token  (per-user Sheets access, held in cookies)
 *
 * Key management:
 *   - Key lives in process.env.PRISM_ENCRYPTION_KEY — 64 hex chars (32 bytes).
 *   - Generate one per installation with: `openssl rand -hex 32`
 *   - Store it in a password manager alongside the installation's other secrets.
 *   - Losing the key means encrypted credentials cannot be recovered — users must
 *     re-enter Snowflake credentials and re-connect Google Sheets pipelines.
 *
 * Behavior without a key (graceful rollout):
 *   - encryptSecret() returns the plaintext unchanged and logs a one-time warning,
 *     so existing installs keep working before the key is provisioned.
 *   - decryptSecret() passes through anything not prefixed `enc:v1:`, so plaintext
 *     rows written before encryption was enabled still read correctly.
 *   - A MALFORMED key (present but not 64 hex chars) throws — that is a config
 *     error, not a missing feature.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const KEY_HEX_LENGTH = 64; // 32 bytes

let warnedUnencrypted = false;

/** Returns the key buffer, null if unset, or throws if set but malformed. */
function loadKey(): Buffer | null {
  const raw = process.env.PRISM_ENCRYPTION_KEY;
  if (!raw || raw.trim() === '') return null;

  const hex = raw.trim();
  if (hex.length !== KEY_HEX_LENGTH || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(
      `PRISM_ENCRYPTION_KEY is malformed: expected ${KEY_HEX_LENGTH} hex characters (32 bytes), ` +
      `got ${hex.length} characters. Generate a valid key with: openssl rand -hex 32`,
    );
  }
  return Buffer.from(hex, 'hex');
}

/** True when PRISM_ENCRYPTION_KEY is present and a valid 32-byte hex string. */
export function isEncryptionConfigured(): boolean {
  try {
    return loadKey() !== null;
  } catch {
    return false;
  }
}

/**
 * Encrypts a secret for storage. Returns a versioned compact string:
 *   enc:v1:<iv_base64>:<ciphertext_base64>:<authTag_base64>
 *
 * If PRISM_ENCRYPTION_KEY is unset, returns the plaintext unchanged (with a
 * one-time console warning) so installs work before the key is provisioned.
 * Throws if the key is present but malformed.
 */
export function encryptSecret(plaintext: string): string {
  const key = loadKey();
  if (!key) {
    if (!warnedUnencrypted) {
      warnedUnencrypted = true;
      console.warn(
        '[crypto] PRISM_ENCRYPTION_KEY is not set — secrets are being stored UNENCRYPTED. ' +
        'Generate a key with `openssl rand -hex 32` and set PRISM_ENCRYPTION_KEY to enable encryption at rest.',
      );
    }
    return plaintext;
  }

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('base64')}:${ciphertext.toString('base64')}:${authTag.toString('base64')}`;
}

/**
 * Decrypts a stored secret. Inputs without the `enc:v1:` prefix are returned
 * unchanged (pre-encryption plaintext rows). Throws if the stored value claims
 * to be encrypted but the key is missing/malformed, the payload is corrupt, or
 * the auth tag fails verification.
 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;

  const key = loadKey();
  if (!key) {
    throw new Error(
      '[crypto] Found an encrypted secret but PRISM_ENCRYPTION_KEY is not set. ' +
      'Restore the installation\'s key, or re-enter the credential to store it fresh.',
    );
  }

  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('[crypto] Encrypted secret is malformed: expected enc:v1:<iv>:<ciphertext>:<authTag>.');
  }

  const [ivB64, ciphertextB64, authTagB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');

  if (iv.length !== IV_BYTES) {
    throw new Error('[crypto] Encrypted secret is malformed: bad IV length.');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
