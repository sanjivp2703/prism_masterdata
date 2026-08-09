/* eslint-disable @typescript-eslint/no-explicit-any */
// GET/POST /api/accounts/warehouse-type (admin only) — the installation's
// warehouse platform choice from the /setup step-1 picker (SQL Server port
// Phase 6). Single-tenant: one warehouse type per installation.
//
// GET  — { resolved, saved } (resolved includes the env/dev-switch fallback).
// POST — { type: 'snowflake' | 'mssql' } persists the choice. Saving SQL
//        Server credentials (workspace-mssql POST) also sets it implicitly.
import 'server-only';
import { requireAdminSession } from '@/app/api/_lib/account-security';
import { getDb } from '@/app/api/_lib/sqlite';
import { getWarehouseAdapter, invalidateWarehouseTypeCache } from '@/app/api/_lib/warehouse';

export async function GET() {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;
  const r = getDb().prepare(`SELECT warehouse_type FROM workspace_config WHERE id = 1`).get() as any;
  return Response.json({ resolved: getWarehouseAdapter().kind, saved: r?.warehouse_type ?? null });
}

export async function POST(request: Request) {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;
  let body: any = {};
  try { body = await request.json(); } catch { /* empty */ }
  const type = String(body?.type ?? '').toLowerCase();
  if (type !== 'snowflake' && type !== 'mssql') {
    return Response.json({ error: "type must be 'snowflake' or 'mssql'" }, { status: 400 });
  }
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO workspace_config (id, sf_account, sf_user, sf_warehouse) VALUES (1, '', '', '')`).run();
  db.prepare(`UPDATE workspace_config SET warehouse_type = ? WHERE id = 1`).run(type);
  invalidateWarehouseTypeCache();
  return Response.json({ ok: true, resolved: getWarehouseAdapter().kind, saved: type });
}
