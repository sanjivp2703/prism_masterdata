import 'server-only';

import fs from 'node:fs';
import { NextRequest } from 'next/server';

function safeBool(name: string) {
  const v = process.env[name];
  return Boolean(v && v.trim().length > 0);
}

function safePreviewFirstLine(path: string): string | null {
  try {
    const content = fs.readFileSync(path, 'utf8');
    const firstLine = content.split(/\r?\n/)[0]?.trim() ?? '';
    // Never return key material beyond the header line.
    return firstLine.slice(0, 80);
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const keyPath = process.env.SNOWFLAKE_PRIVATE_KEY_PATH?.trim() || '';

  let keyPathStat:
    | { exists: false }
    | { exists: true; isDirectory: boolean; sizeBytes?: number } = { exists: false };

  if (keyPath) {
    try {
      const st = fs.statSync(keyPath);
      keyPathStat = {
        exists: true,
        isDirectory: st.isDirectory(),
        sizeBytes: st.isFile() ? st.size : undefined,
      };
    } catch {
      keyPathStat = { exists: false };
    }
  }

  return Response.json({
    ok: true,
    required: {
      SNOWFLAKE_ACCOUNT: safeBool('SNOWFLAKE_ACCOUNT'),
      SNOWFLAKE_USER: safeBool('SNOWFLAKE_USER'),
      SNOWFLAKE_WAREHOUSE: safeBool('SNOWFLAKE_WAREHOUSE'),
    },
    auth: {
      SNOWFLAKE_PASSWORD: safeBool('SNOWFLAKE_PASSWORD'),
      SNOWFLAKE_PRIVATE_KEY: safeBool('SNOWFLAKE_PRIVATE_KEY'),
      SNOWFLAKE_PRIVATE_KEY_PATH: keyPath ? keyPath : null,
      SNOWFLAKE_PRIVATE_KEY_PATH_STAT: keyPathStat,
      SNOWFLAKE_PRIVATE_KEY_PATH_FIRST_LINE: keyPath
        ? safePreviewFirstLine(keyPath)
        : null,
    },
  });
}


