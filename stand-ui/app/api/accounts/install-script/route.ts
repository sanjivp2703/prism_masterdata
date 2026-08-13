import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { requireAdminSession } from '@/app/api/_lib/account-security';

/**
 * GET /api/accounts/install-script (admin only)
 *
 * Returns the Snowflake install SQL (00_bootstrap.sql + 01_internal_tables.sql,
 * concatenated) for the setup flow's "run this in a Snowflake worksheet" step.
 * The files live at the repo root, one level above the Next.js working
 * directory; a deploy that ships only stand-ui/ won't have them, so the client
 * falls back to pointing at the repo instead of showing an empty script.
 */
export async function GET(request: Request) {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;

  const warehouse = new URL(request.url).searchParams.get('warehouse') ?? 'snowflake';
  const candidates = [path.join(process.cwd(), '..'), process.cwd()];

  if (warehouse === 'postgres') {
    for (const dir of candidates) {
      try {
        // No truncation marker in the pg script — serve it whole (a file
        // without the marker is always served whole; see the Snowflake branch).
        const script = fs.readFileSync(path.join(dir, '01_internal_tables.postgres.sql'), 'utf8');
        return Response.json({
          ok: true,
          script:
            `-- Prism PostgreSQL install\n-- Run with psql against the database that holds your source tables, as a superuser:\n--   psql -h <host> -U postgres -d <database> -f 01_internal_tables.postgres.sql\n\n` +
            `${script.trim()}\n`,
        });
      } catch { /* try next candidate */ }
    }
    return Response.json({
      ok: false,
      error: 'Install script not found on this server. Use 01_internal_tables.postgres.sql from the Prism repository.',
    });
  }

  if (warehouse === 'mysql') {
    for (const dir of candidates) {
      try {
        // No truncation marker in the mysql script — serve it whole.
        const script = fs.readFileSync(path.join(dir, '01_internal_tables.mysql.sql'), 'utf8');
        return Response.json({
          ok: true,
          script:
            `-- Prism MySQL install\n-- Run with the mysql client as an admin account (root or equivalent):\n--   mysql -h <host> -u root -p < 01_internal_tables.mysql.sql\n\n` +
            `${script.trim()}\n`,
        });
      } catch { /* try next candidate */ }
    }
    return Response.json({
      ok: false,
      error: 'Install script not found on this server. Use 01_internal_tables.mysql.sql from the Prism repository.',
    });
  }

  if (warehouse === 'mssql') {
    for (const dir of candidates) {
      try {
        const script = fs.readFileSync(path.join(dir, '01_internal_tables.mssql.sql'), 'utf8');
        return Response.json({
          ok: true,
          script:
            `-- Prism SQL Server install\n-- Run against your SQL Server as a sysadmin (SSMS, Azure Data Studio, or sqlcmd).\n\n` +
            `${script.trim()}\n`,
        });
      } catch { /* try next candidate */ }
    }
    return Response.json({
      ok: false,
      error: 'Install script not found on this server. Use 01_internal_tables.mssql.sql from the Prism repository.',
    });
  }

  for (const dir of candidates) {
    try {
      // 00_bootstrap.sql carries a dev-only ONBOARDING MIRROR below this
      // marker (service-user creation + dev-schema grants for wizard-free
      // resets) — customers get only the portion above it. A file without the
      // marker is served whole.
      const bootstrap = fs
        .readFileSync(path.join(dir, '00_bootstrap.sql'), 'utf8')
        .split('-- PRISM:INSTALL-SCRIPT-END')[0];
      const internal  = fs.readFileSync(path.join(dir, '01_internal_tables.sql'), 'utf8');
      return Response.json({
        ok: true,
        script:
          `-- Prism Snowflake install\n-- Run in a Snowflake worksheet as ACCOUNTADMIN.\n\n` +
          `-- ============ 00_bootstrap.sql ============\n\n${bootstrap.trim()}\n\n` +
          `-- ============ 01_internal_tables.sql ============\n\n${internal.trim()}\n`,
      });
    } catch { /* try next candidate */ }
  }

  return Response.json({
    ok: false,
    error: 'Install scripts not found on this server. Use 00_bootstrap.sql and 01_internal_tables.sql from the Prism repository.',
  });
}
