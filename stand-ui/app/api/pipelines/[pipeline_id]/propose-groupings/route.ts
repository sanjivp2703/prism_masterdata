/**
 * POST /api/pipelines/[pipeline_id]/propose-groupings
 *
 * Premium only. Runs lookup + LLM grouping on the pipeline's current queue
 * items WITHOUT writing anything to the database. Used by the Update
 * Standardizations page to show proposed groupings before the user accepts.
 *
 * Returns: { groups: [{ alias_name: string, items: string[] }] }
 */

import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { fetchPipelineById, fetchQueueLiterals } from '@/app/api/_lib/pipeline-hourly-processor';
import { runOnePromptGrouping } from '@/app/api/_lib/llm-one-prompt-grouping';
import { normalizeLiteral } from '@/app/api/_lib/normalize';
import { sanitizeConventionRules, hasAnyRule } from '@/app/api/_lib/convention-rules';
import { pickBestAliasName } from '@/app/api/_lib/namescore';
import type { RunItemForPairing } from '@/app/api/_lib/grouping-types';
import type { NamingConvention } from '@/app/api/_lib/llm-one-prompt-grouping';

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ pipeline_id: string }> },
) {
  const cookieStore = await cookies();
  const session     = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { pipeline_id } = await params;
  const pid = Number(pipeline_id);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Response.json({ error: 'Invalid pipeline_id' }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'ANTHROPIC_API_KEY is not configured.' }, { status: 500 });
  }

  try {
    const pipeline = await fetchPipelineById(pid);
    if (!pipeline) {
      return Response.json({ error: `Pipeline ${pid} not found` }, { status: 404 });
    }

    const groups = await withSnowflake(async (conn) => {
      const literals = await fetchQueueLiterals(conn, pid);
      if (literals.length === 0) return [];

      const domainId = pipeline.domain_id;

      // ── Lookup pass ────────────────────────────────────────────────────────
      const normLiterals = Array.from(new Set(literals.map(normalizeLiteral))).filter(Boolean);
      const lookupMap = new Map<string, string>(); // norm_key → alias_name
      if (normLiterals.length > 0) {
        const ph = normLiterals.map(() => '?').join(', ');
        const domainFilter = domainId != null
          ? `AND lam.domain_id = ${Number(domainId)}`
          : `AND lam.domain_id IS NULL`;
        const lookupRows = await exec(conn, `
          SELECT lam.normalized_value AS norm_key, aan.alias_name
          FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES  lam
          JOIN STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES   aan
            ON lam.alias_id = aan.alias_id
          WHERE lam.normalized_value IN (${ph})
            ${domainFilter}
        `, normLiterals);
        for (const r of lookupRows) {
          const key = String(r.NORM_KEY   ?? r.norm_key   ?? '');
          const an  = String(r.ALIAS_NAME ?? r.alias_name ?? '');
          if (key && an) lookupMap.set(key, an);
        }
      }

      const matched   = literals.filter(lv =>  lookupMap.has(normalizeLiteral(lv)));
      const unmatched = literals.filter(lv => !lookupMap.has(normalizeLiteral(lv)));

      const groupMap = new Map<string, string[]>();

      for (const lv of matched) {
        const alias = lookupMap.get(normalizeLiteral(lv))!;
        if (!groupMap.has(alias)) groupMap.set(alias, []);
        groupMap.get(alias)!.push(lv);
      }

      // Track which items need human review (couldn't be confidently grouped)
      const reviewSet = new Set<string>();

      // ── LLM pass ──────────────────────────────────────────────────────────
      if (unmatched.length > 0) {
        // Fetch existing alias names for the domain (seeded into the prompt).
        const aliasFilter = domainId != null
          ? `WHERE domain_id = ${Number(domainId)}`
          : `WHERE domain_id IS NULL`;
        const aliasRows = await exec(conn, `
          SELECT alias_name FROM STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES
          ${aliasFilter}
          ORDER BY usage_count DESC NULLS LAST, last_used_at DESC NULLS LAST
          LIMIT 200
        `);
        const existingAliasNames = aliasRows
          .map((r: any) => String(r.ALIAS_NAME ?? r.alias_name ?? '').trim())
          .filter(Boolean);

        // Naming convention for this domain.
        let namingConvention: NamingConvention | null = null;
        if (domainId != null) {
          const convRows = await exec(conn,
            `SELECT convention_type, convention_value, convention_rules
             FROM STAND_DB.STAND_INTERNAL.DOMAINS WHERE domain_id = ?`,
            [domainId],
          );
          if (convRows.length > 0) {
            const ct  = String((convRows[0] as any).CONVENTION_TYPE  ?? (convRows[0] as any).convention_type  ?? '').toLowerCase();
            const cv  = String((convRows[0] as any).CONVENTION_VALUE ?? (convRows[0] as any).convention_value ?? '');
            const crR = (convRows[0] as any).CONVENTION_RULES ?? (convRows[0] as any).convention_rules ?? null;
            const rules = crR ? sanitizeConventionRules(typeof crR === 'string' ? safeJsonParse(crR) : crR) : null;
            const type  = (ct === 'regex' || ct === 'examples' || ct === 'natural') && cv.trim() ? ct : null;
            if (type || (rules && hasAnyRule(rules))) {
              namingConvention = { type, value: cv, rules: rules && hasAnyRule(rules) ? rules : null };
            }
          }
        }

        const conceptName = pipeline.domain_name ?? '';
        const runItems: RunItemForPairing[] = unmatched.map((lv, i) => ({
          run_item_id:         i,
          literal_value:       lv,
          cleaned_value:       null,
          normalization_value: null,
          std_tokens:          [],
          norm_tokens:         [],
        }));
        const runItemsById = new Map(runItems.map(ri => [ri.run_item_id, ri]));

        const llmResult = await runOnePromptGrouping(
          runItems, conceptName, '', existingAliasNames, namingConvention,
        );

        const orderedGroups = [
          ...llmResult.groups.filter(g => !g.is_singleton),
          ...llmResult.groups.filter(g =>  g.is_singleton),
        ];

        const placedIds = new Set<number>();
        for (const group of orderedGroups) {
          const proposed = (group.proposed_name ?? '').trim();
          const members  = group.member_ids.map(id => runItemsById.get(id)).filter((m): m is RunItemForPairing => m != null);
          const alias    = proposed || pickBestAliasName(members).literal_value || 'Unknown';
          const items    = members.map(m => m.literal_value);
          if (items.length === 0) continue;
          if (!groupMap.has(alias)) groupMap.set(alias, []);
          groupMap.get(alias)!.push(...items);
          group.member_ids.forEach(id => placedIds.add(id));
        }

        // Items the LLM left unassigned — create singleton groups and flag for review
        for (const id of llmResult.unassigned_ids) {
          if (placedIds.has(id)) continue;
          const ri = runItemsById.get(id);
          if (!ri) continue;
          const lv = ri.literal_value;
          // Use the literal value itself as the provisional alias (user will rename/move)
          if (!groupMap.has(lv)) groupMap.set(lv, []);
          groupMap.get(lv)!.push(lv);
          reviewSet.add(lv);
        }
      }

      return [...groupMap.entries()].map(([alias_name, items]) => ({
        alias_name,
        items,
        review_items: items.filter(lv => reviewSet.has(lv)),
      }));
    });

    return Response.json({ groups });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to propose groupings');
  }
}
