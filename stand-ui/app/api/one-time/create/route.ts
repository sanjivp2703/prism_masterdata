/**
 * POST /api/one-time/create
 *
 * Body: { source_relation, columns: [{ column_name, convention? }] }
 * Creates one one-time RUNS row per column (run_type='one_time', domain_id NULL),
 * sharing a session nonce. Does NOT group yet — the client calls
 * /api/one-time/[run_id]/group per column to drive per-page progress.
 *
 * Returns { session, columns: [{ run_id, column_name }] }.
 */

import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { createOneTimeRun, isSimpleIdent, parseFqn } from '@/app/api/_lib/op-one-time';
import { sanitizeConventionRules, hasAnyRule } from '@/app/api/_lib/convention-rules';
import type { NamingConvention } from '@/app/api/_lib/llm-one-prompt-grouping';

function parseConvention(raw: any): NamingConvention | null {
  if (!raw || typeof raw !== 'object') return null;
  const ct = String(raw.type ?? '').toLowerCase();
  const cv = String(raw.value ?? '');
  const type = (ct === 'regex' || ct === 'examples' || ct === 'natural') && cv.trim() ? (ct as NamingConvention['type']) : null;
  const rules = raw.rules ? sanitizeConventionRules(raw.rules) : null;
  if (!type && !(rules && hasAnyRule(rules))) return null;
  return { type, value: cv, rules: rules && hasAnyRule(rules) ? rules : null };
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const session = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const source_relation = String(body?.source_relation ?? '').trim();
  const rawColumns = Array.isArray(body?.columns) ? body.columns : [];

  if (!source_relation) return Response.json({ error: 'source_relation is required' }, { status: 400 });
  try {
    const { db, schema, table } = parseFqn(source_relation);
    if (![db, schema, table].every(isSimpleIdent)) {
      return Response.json({ error: 'Table name contains unsupported characters.' }, { status: 400 });
    }
  } catch {
    return Response.json({ error: `Invalid source table. Expected DB.SCHEMA.TABLE, got: ${source_relation}` }, { status: 400 });
  }

  const columns = rawColumns
    .map((c: any) => ({ column_name: String(c?.column_name ?? '').trim(), convention: parseConvention(c?.convention) }))
    .filter((c: any) => c.column_name);

  if (columns.length === 0) return Response.json({ error: 'Select at least one column to standardize.' }, { status: 400 });
  for (const c of columns) {
    if (!isSimpleIdent(c.column_name)) {
      return Response.json({ error: `Column "${c.column_name}" contains unsupported characters.` }, { status: 400 });
    }
  }

  const sessionNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  try {
    return await withSnowflake(async (conn) => {
      const created: { run_id: number; column_name: string }[] = [];
      for (const c of columns) {
        const runId = await createOneTimeRun(conn, {
          source_relation,
          column_name:  c.column_name,
          createdBy:    Number(session.accountId),
          sessionNonce,
          convention:   c.convention,
        });
        created.push({ run_id: runId, column_name: c.column_name });
      }
      return Response.json({ session: sessionNonce, columns: created }, { status: 201 });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to create one-time standardization');
  }
}
