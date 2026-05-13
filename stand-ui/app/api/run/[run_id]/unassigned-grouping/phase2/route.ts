/**
 * GET /api/run/[run_id]/unassigned-grouping/phase2
 *
 * Runs the full unassigned-grouping pipeline through Phase 2:
 *   Phase 0 — compute all pairscores for unassigned items
 *   Phase 1 — clique-based anchor detection
 *   Phase 2 — absorb remaining items (up to 3 order-independent passes)
 *
 * After Phase 2 the response reports:
 *   - groups        : final tentative groups (anchors + absorbed members)
 *   - still_unassigned : items that never qualified for any group
 *   - phase1 / phase2 diagnostics
 *
 * Query params:
 *   include_pairs    Boolean ("true"). Attach the full candidate-pair list.
 *   include_details  Boolean ("true"). Add per-pair sub-score breakdown
 *                    (only meaningful together with include_pairs=true).
 */

import { NextRequest } from 'next/server';
import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import { computeAllPairScores, type RunItemForPairing } from '@/app/api/_lib/pairscore';
import {
  buildPairMap,
  runPhase1,
  runPhase2,
  type ScoredPair,
} from '@/app/api/_lib/clique-detection';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tokensFromVariant = (v: unknown): string[] => {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((t) => t.length > 0);
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed))
        return parsed.map((x) => String(x).trim()).filter((t) => t.length > 0);
    } catch {
      /* ignore */
    }
  }
  return [];
};

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ run_id: string }> }
) {
  const { run_id } = await params;
  const { searchParams } = request.nextUrl;

  const includePairs   = searchParams.get('include_pairs')   === 'true';
  const includeDetails = searchParams.get('include_details') === 'true';

  try {
    return await withSnowflake(async (connection) => {
      // ── 1. Verify run exists ─────────────────────────────────────────────
      const runRows = await new Promise<any[]>((resolve, reject) => {
        connection.execute({
          sqlText: `
            SELECT run_id, run_status
            FROM STAND_DB.STAND_INTERNAL.RUNS
            WHERE run_id = ?
            LIMIT 1
          `,
          binds: [run_id],
          complete: (err, _stmt, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        });
      });

      if (runRows.length === 0) {
        return Response.json({ error: 'Run not found' }, { status: 404 });
      }

      // ── 2. Fetch all unassigned run items ────────────────────────────────
      const itemRows = await new Promise<any[]>((resolve, reject) => {
        connection.execute({
          sqlText: `
            SELECT
              run_item_id,
              literal_value,
              cleaned_value,
              normalization_value,
              tokens,
              normalized_tokens
            FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS
            WHERE run_id = ?
              AND group_id IS NULL
            ORDER BY run_item_id ASC
          `,
          binds: [run_id],
          complete: (err, _stmt, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          },
        });
      });

      if (itemRows.length === 0) {
        return Response.json(
          {
            data: {
              run_id: Number(run_id),
              unassigned_count: 0,
              groups: [],
              still_unassigned: [],
              phase1_diagnostics: {
                raw_clique_count:   0,
                valid_clique_count: 0,
                anchor_count:       0,
                anchored_count:     0,
                unanchored_count:   0,
              },
              phase2_diagnostics: {
                passes_run:             0,
                passes:                 [],
                total_absorbed:         0,
                still_unassigned_count: 0,
              },
              thresholds: {
                strong_edge:              0.12,
                two_node:                 0.15,
                external_sep_multiplier:  0.5,
                absorption_max:           0.18,
                absorption_min:           0.12,
                max_passes:               3,
              },
            },
          },
          { headers: NO_CACHE_HEADERS }
        );
      }

      // ── 3. Map DB rows → RunItemForPairing ───────────────────────────────
      const runItems: RunItemForPairing[] = itemRows.map((row) => ({
        run_item_id:         Number((row as any).RUN_ITEM_ID),
        literal_value:       String((row as any).LITERAL_VALUE ?? ''),
        cleaned_value:       (row as any).CLEANED_VALUE == null
                               ? null
                               : String((row as any).CLEANED_VALUE),
        normalization_value: (row as any).NORMALIZATION_VALUE == null
                               ? null
                               : String((row as any).NORMALIZATION_VALUE),
        std_tokens:  tokensFromVariant((row as any).TOKENS),
        norm_tokens: tokensFromVariant((row as any).NORMALIZED_TOKENS),
      }));

      const allIds = runItems.map((ri) => ri.run_item_id);
      const literalById = new Map<number, string>(
        runItems.map((ri) => [ri.run_item_id, ri.literal_value])
      );

      // ── 4. Phase 0 — compute all pair scores ─────────────────────────────
      const pairResults = computeAllPairScores(runItems);

      const candidatePairs: ScoredPair[] = pairResults.map((p) => ({
        run_item_id_a: p.run_item_id_a,
        run_item_id_b: p.run_item_id_b,
        pair_score:    p.pair_score,
      }));

      // Build the shared pair map once — reused by both Phase 1 and Phase 2.
      const pairMap = buildPairMap(candidatePairs);

      // ── 5. Phase 1 — clique detection ────────────────────────────────────
      const phase1 = runPhase1(allIds, candidatePairs);

      // ── 6. Phase 2 — absorb remaining items ──────────────────────────────
      const phase2 = runPhase2(phase1, pairMap);

      // ── 7. Enrich groups with literal values ──────────────────────────────
      const enrichedGroups = phase2.groups.map((g) => ({
        temp_group_id:      g.temp_group_id,
        member_ids:         g.member_ids,
        members: g.member_ids.map((id) => ({
          run_item_id:   id,
          literal_value: literalById.get(id) ?? null,
          // Tag whether this member is an original anchor or was absorbed.
          origin: g.anchor_member_ids.includes(id) ? 'anchor' : 'absorbed',
        })),
        anchor_member_ids:   g.anchor_member_ids,
        absorbed_member_ids: g.absorbed_member_ids,
        internal_scores:     g.internal_scores,
        avg_internal_score:  g.avg_internal_score,
        min_internal_score:  g.min_internal_score,
      }));

      const enrichedStillUnassigned = phase2.still_unassigned_ids.map((id) => ({
        run_item_id:   id,
        literal_value: literalById.get(id) ?? null,
      }));

      // ── 8. Phase 2 summary diagnostics ───────────────────────────────────
      const totalAbsorbed = phase2.groups.reduce(
        (sum, g) => sum + g.absorbed_member_ids.length,
        0
      );

      // ── 9. Optionally attach candidate-pair list ──────────────────────────
      let pairsPayload: unknown = undefined;
      if (includePairs) {
        pairsPayload = pairResults
          .sort((a, b) => b.pair_score - a.pair_score)
          .map((p) => {
            const base = {
              run_item_id_a:   p.run_item_id_a,
              run_item_id_b:   p.run_item_id_b,
              literal_value_a: literalById.get(p.run_item_id_a) ?? null,
              literal_value_b: literalById.get(p.run_item_id_b) ?? null,
              pair_score:      p.pair_score,
            };
            return includeDetails ? { ...base, details: p.details } : base;
          });
      }

      // ── 10. Respond ───────────────────────────────────────────────────────
      const body: Record<string, unknown> = {
        data: {
          run_id:           Number(run_id),
          unassigned_count: runItems.length,
          groups:           enrichedGroups,
          still_unassigned: enrichedStillUnassigned,
          phase1_diagnostics: {
            raw_clique_count:   phase1.raw_clique_count,
            valid_clique_count: phase1.valid_clique_count,
            anchor_count:       phase1.tentative_groups.length,
            anchored_count:     allIds.length - phase1.unanchored_ids.length,
            unanchored_count:   phase1.unanchored_ids.length,
          },
          phase2_diagnostics: {
            passes_run:             phase2.passes_run,
            passes:                 phase2.passes,
            total_absorbed:         totalAbsorbed,
            still_unassigned_count: phase2.still_unassigned_ids.length,
          },
          thresholds: {
            strong_edge:              0.12,
            two_node:                 0.15,
            external_sep_multiplier:  0.5,
            absorption_max:           0.18,
            absorption_min:           0.12,
            max_passes:               3,
          },
        },
      };

      if (includePairs) {
        (body.data as Record<string, unknown>).candidate_pairs = pairsPayload;
      }

      return Response.json(body, { headers: NO_CACHE_HEADERS });
    });
  } catch (error) {
    console.error('[phase2] error:', error);
    return snowflakeErrorResponse(error, 'Failed to run Phase 2 absorption');
  }
}
