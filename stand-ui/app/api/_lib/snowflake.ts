import 'server-only';

import fs from 'node:fs';
import snowflake from 'snowflake-sdk';

type SnowflakeConnection = ReturnType<typeof snowflake.createConnection>;

export function getOptionalEnv(name: string): string | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const trimmed = v.trim();
  return trimmed.length ? trimmed : undefined;
}

function getRequiredEnv(name: string): string {
  const v = getOptionalEnv(name);
  if (!v) {
    throw new Error(
      `Missing required environment variable ${name}. Add it to stand-ui/.env.local`
    );
  }
  return v;
}

function getPrivateKeyFromEnv(): string | undefined {
  const key = getOptionalEnv('SNOWFLAKE_PRIVATE_KEY');
  if (!key) return undefined;
  // Allow env var to contain "\n" sequences.
  return key.includes('\\n') ? key.replace(/\\n/g, '\n') : key;
}

function getPrivateKeyFromPath(): string | undefined {
  const path = getOptionalEnv('SNOWFLAKE_PRIVATE_KEY_PATH');
  if (!path) return undefined;
  try {
    const stat = fs.statSync(path);
    if (stat.isDirectory()) {
      throw new Error(
        `SNOWFLAKE_PRIVATE_KEY_PATH points to a directory: ${path}. It must point to your private key file (e.g. .../rsa_key.p8).`
      );
    }
    return fs.readFileSync(path, 'utf8');
  } catch (e: any) {
    const code = e?.code ? String(e.code) : '';
    if (code === 'ENOENT') {
      throw new Error(
        `SNOWFLAKE_PRIVATE_KEY_PATH does not exist: ${path}. Set it to the full path of your private key file (e.g. /Users/sanjivp27/snowflake_keys/rsa_key.p8).`
      );
    }
    // Re-throw with original message for other cases (permissions, etc.)
    throw e;
  }
}

export function createSnowflakeConnection(): SnowflakeConnection {
  const account = getRequiredEnv('SNOWFLAKE_ACCOUNT');
  const username = getRequiredEnv('SNOWFLAKE_USER');
  const warehouse = getRequiredEnv('SNOWFLAKE_WAREHOUSE');

  const database = getOptionalEnv('SNOWFLAKE_DATABASE') ?? 'STAND_DB';
  const schema = getOptionalEnv('SNOWFLAKE_SCHEMA') ?? 'STAND_INTERNAL';
  const role = getOptionalEnv('SNOWFLAKE_ROLE');

  const privateKey = getPrivateKeyFromEnv() ?? getPrivateKeyFromPath();
  const privateKeyPass = getOptionalEnv('SNOWFLAKE_PRIVATE_KEY_PASSPHRASE');

  // If a private key is provided, default to JWT/key-pair auth unless explicitly overridden.
  const envAuthenticator = getOptionalEnv('SNOWFLAKE_AUTHENTICATOR');
  const authenticator = envAuthenticator ?? (privateKey ? 'SNOWFLAKE_JWT' : undefined);

  const password = getOptionalEnv('SNOWFLAKE_PASSWORD');
  const passcode = getOptionalEnv('SNOWFLAKE_PASSCODE');
  const passcodeInPassword =
    (getOptionalEnv('SNOWFLAKE_PASSCODE_IN_PASSWORD') ?? '').toLowerCase() ===
    'true';

  if (!privateKey && !password) {
    throw new Error(
      'Snowflake credentials missing. Set SNOWFLAKE_PASSWORD or SNOWFLAKE_PRIVATE_KEY/SNOWFLAKE_PRIVATE_KEY_PATH in stand-ui/.env.local'
    );
  }

  return snowflake.createConnection({
    account,
    username,
    warehouse,
    database,
    schema,
    ...(role ? { role } : {}),
    ...(authenticator ? { authenticator } : {}),
    ...(privateKey
      ? {
          privateKey,
          ...(privateKeyPass ? { privateKeyPass } : {}),
        }
      : {
          password: password ?? '',
          ...(passcode ? { passcode } : {}),
          ...(passcodeInPassword ? { passcodeInPassword } : {}),
        }),
  } as any);
}

async function connect(connection: SnowflakeConnection): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    connection.connect((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function destroy(connection: SnowflakeConnection): Promise<void> {
  await new Promise<void>((resolve) => {
    connection.destroy((err) => {
      // If connection failed earlier, snowflake-sdk often reports "Already disconnected".
      if (err && !String((err as any)?.message ?? err).includes('Already disconnected')) {
        console.error('Error closing connection:', err);
      }
      resolve();
    });
  });
}

export async function withSnowflake<T>(
  fn: (connection: SnowflakeConnection) => Promise<T>
): Promise<T> {
  const connection = createSnowflakeConnection();
  try {
    await connect(connection);
    return await fn(connection);
  } finally {
    await destroy(connection);
  }
}

// ── Per-account Snowflake config ──────────────────────────────────────────────

interface AccountSfConfig {
  account:    string;
  username:   string;
  warehouse:  string;
  role?:      string;
  password?:  string;
  privateKey?: string;
}

// In-process cache: accountId → config (null = no custom config, use env vars)
const _accountSfConfigCache = new Map<number, AccountSfConfig | null>();

function createConnectionFromConfig(cfg: AccountSfConfig): SnowflakeConnection {
  const privateKey = cfg.privateKey
    ? (cfg.privateKey.includes('\\n') ? cfg.privateKey.replace(/\\n/g, '\n') : cfg.privateKey)
    : undefined;
  const authenticator = privateKey ? 'SNOWFLAKE_JWT' : undefined;
  const database = getOptionalEnv('SNOWFLAKE_DATABASE') ?? 'STAND_DB';
  const schema   = getOptionalEnv('SNOWFLAKE_SCHEMA')   ?? 'STAND_INTERNAL';

  return snowflake.createConnection({
    account:   cfg.account,
    username:  cfg.username,
    warehouse: cfg.warehouse,
    database,
    schema,
    ...(cfg.role        ? { role: cfg.role }               : {}),
    ...(authenticator   ? { authenticator }                 : {}),
    ...(privateKey
      ? { privateKey }
      : { password: cfg.password ?? '' }),
  } as any);
}

export function invalidateAccountSfConfig(accountId: number): void {
  _accountSfConfigCache.delete(accountId);
}

async function loadAccountSfConfig(accountId: number): Promise<AccountSfConfig | null> {
  return withSnowflake(async (conn) => {
    const rows: any[] = await new Promise((resolve, reject) => {
      conn.execute({
        sqlText: `SELECT sf_account, sf_user, sf_warehouse, sf_role, sf_password, sf_private_key
                  FROM STAND_DB.STAND_INTERNAL.ACCOUNTS WHERE account_id = ? LIMIT 1`,
        binds: [accountId],
        complete: (err: any, _s: any, r: any[] | undefined) => err ? reject(err) : resolve(r ?? []),
      });
    });
    if (!rows.length) return null;
    const r = rows[0];
    const acc = r.SF_ACCOUNT ?? r.sf_account;
    if (!acc) return null;
    return {
      account:    String(acc),
      username:   String(r.SF_USER      ?? r.sf_user      ?? ''),
      warehouse:  String(r.SF_WAREHOUSE ?? r.sf_warehouse ?? ''),
      role:       r.SF_ROLE        ?? r.sf_role        ?? undefined,
      password:   r.SF_PASSWORD    ?? r.sf_password    ?? undefined,
      privateKey: r.SF_PRIVATE_KEY ?? r.sf_private_key ?? undefined,
    };
  });
}

export async function withSnowflakeForAccount<T>(
  accountId: number | null | undefined,
  fn: (connection: SnowflakeConnection) => Promise<T>
): Promise<T> {
  if (!accountId) return withSnowflake(fn);

  if (!_accountSfConfigCache.has(accountId)) {
    try {
      const cfg = await loadAccountSfConfig(accountId);
      _accountSfConfigCache.set(accountId, cfg);
    } catch {
      _accountSfConfigCache.set(accountId, null);
    }
  }

  const cfg = _accountSfConfigCache.get(accountId) ?? null;
  if (!cfg) return withSnowflake(fn);

  const connection = createConnectionFromConfig(cfg);
  try {
    await connect(connection);
    return await fn(connection);
  } finally {
    await destroy(connection);
  }
}

function normalizeError(error: unknown): { message: string; code?: unknown } {
  const message = (() => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  })();
  const code = (error as any)?.code;
  return { message, code };
}

export function snowflakeErrorResponse(
  error: unknown,
  fallbackPublicMessage: string
): Response {
  const { message, code } = normalizeError(error);

  if (message.includes('A password must be specified')) {
    return Response.json(
      {
        error:
          'Snowflake auth is not configured. Set SNOWFLAKE_PRIVATE_KEY_PATH (recommended) to your private key file (rsa_key.p8), or set SNOWFLAKE_PASSWORD.',
        details: message,
        code,
      },
      { status: 500 }
    );
  }

  // Snowflake error code for "MFA with TOTP is required" is commonly 394508
  if (String(code) === '394508' || message.includes('MFA with TOTP is required')) {
    return Response.json(
      {
        error:
          'Snowflake login blocked by MFA (TOTP). Use key-pair auth (recommended) or a user exempt from MFA for API access.',
        details: message,
        code,
      },
      { status: 401 }
    );
  }

  // Missing env / misconfiguration
  if (message.startsWith('Missing required environment variable') || message.startsWith('Snowflake credentials missing')) {
    return Response.json(
      { error: message },
      { status: 500 }
    );
  }

  return Response.json(
    { error: fallbackPublicMessage, details: message, code },
    { status: 500 }
  );
}


