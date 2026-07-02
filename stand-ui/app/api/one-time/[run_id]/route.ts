/**
 * GET   /api/one-time/[run_id]  — current mappings + accepted flag (hydration)
 * PATCH /api/one-time/[run_id]  — overwrite groups and/or set the accepted flag
 *
 * Scoped to the creating user. Touches no lookup tables.
 */

import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { loadOpRunState, saveOpRunState, type OpRunState, type OpGroup } from '@/app/api/_lib/op-auto-group';
import { loadOneTimeMeta, saveOneTimeMeta } from '@/app/api/_lib/op-one-time';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({ sqlText, binds, complete: (e: any, _s: any, r: any[]) => (e ? reject(e) : resolve(r || [])) });
  });
}

async function loadRunMeta(conn: any, runId: number, accountId: number) {
  const rows = await exec(
    conn,
    `SELECT source_relation, source_column, run_status
     FROM STAND_DB.STAND_INTERNAL.RUNS
     WHERE run_id = ? AND run_type = 'one_time' AND created_by = ?`,
    [runId, accountId],
  );
  if (!rows.length) return null;
  const r = rows[0] as any;
  return {
    source_relation: String(r.SOURCE_RELATION ?? r.source_relation ?? ''),
    source_column:   String(r.SOURCE_COLUMN ?? r.source_column ?? ''),
    run_status:      String(r.RUN_STATUS ?? r.run_status ?? ''),
  };
}

function serializeGroups(state: OpRunState | null) {
  return (state?.groups ?? []).map((g) => ({
    group_id:     g.group_id,
    alias_name:   g.alias_name,
    confidence:   g.confidence,
    needs_review: g.needs_review === true,
    items:        g.items.map((it) => ({ literal_value: it.literal_value })),
  }));
}

export async function GET(_request: Request, { params }: { params: Promise<{ run_id: string }> }) {
  const cookieStore = await cookies();
  const session = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { run_id } = await params;
  const runId = Number.parseInt(String(run_id), 10);
  if (!Number.isFinite(runId)) return Response.json({ error: 'Invalid run_id' }, { status: 400 });

  try {
    return await withSnowflake(async (conn) => {
      const meta = await loadRunMeta(conn, runId, Number(session.accountId));
      if (!meta) return Response.json({ error: 'Not found' }, { status: 404 });
      const state = await loadOpRunState(conn, runId);
      const otMeta = await loadOneTimeMeta(conn, runId);
      return Response.json({
        run_id:          runId,
        source_relation: meta.source_relation,
        source_column:   meta.source_column,
        run_status:      meta.run_status,
        grouped:         (state?.groups?.length ?? 0) > 0 || meta.run_status !== 'created',
        accepted:        otMeta?.accepted === true,
        groups:          serializeGroups(state),
      });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to load one-time run');
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ run_id: string }> }) {
  const cookieStore = await cookies();
  const session = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { run_id } = await params;
  const runId = Number.parseInt(String(run_id), 10);
  if (!Number.isFinite(runId)) return Response.json({ error: 'Invalid run_id' }, { status: 400 });

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  try {
    return await withSnowflake(async (conn) => {
      const meta = await loadRunMeta(conn, runId, Number(session.accountId));
      if (!meta) return Response.json({ error: 'Not found' }, { status: 404 });

      const state = await loadOpRunState(conn, runId);
      if (!state) return Response.json({ error: 'Run state not found' }, { status: 404 });

      // Overwrite groups from the client's full edited set (raw → standardized).
      if (Array.isArray(body?.groups)) {
        const groups: OpGroup[] = [];
        let gid = 1;
        for (const g of body.groups) {
          const aliasName = String(g?.alias_name ?? '').trim();
          const items = Array.isArray(g?.items)
            ? g.items
                .map((it: any) => String(it?.literal_value ?? '').trim())
                .filter(Boolean)
                .map((lv: string) => ({ literal_value: lv, matched_from_lookup: false }))
            : [];
          if (!aliasName || items.length === 0) continue;
          groups.push({
            group_id:          gid++,
            alias_name:        aliasName,
            alias_name_source: 'user_override',
            confidence:        (['h', 'm', 'l'] as const).includes(g?.confidence) ? g.confidence : 'h',
            from_lookup_chunk: false,
            needs_review:      g?.needs_review === true,
            items,
          });
        }
        const newState: OpRunState = { status: state.status, items: state.items, groups, ungrouped: [] };
        await saveOpRunState(conn, runId, newState);
      }

      if (typeof body?.accepted === 'boolean') {
        const otMeta = (await loadOneTimeMeta(conn, runId)) ?? { one_time_session: '', convention: null, accepted: false };
        await saveOneTimeMeta(conn, runId, { ...otMeta, accepted: body.accepted });
      }

      const finalState = await loadOpRunState(conn, runId);
      const otMeta = await loadOneTimeMeta(conn, runId);
      return Response.json({
        run_id:   runId,
        accepted: otMeta?.accepted === true,
        groups:   serializeGroups(finalState),
      });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to save one-time run');
  }
}
