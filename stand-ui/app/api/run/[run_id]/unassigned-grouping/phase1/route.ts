/**
 * GET /api/run/[run_id]/unassigned-grouping/phase1
 *
 * Phase 1 — Clique-based anchor detection.
 *
 * Fetches all unassigned run items (group_id IS NULL), computes all pairscores
 * (Phase 0), then runs the clique-detection algorithm to produce a set of
 * tentative anchor groups.
 *
 * The response includes:
 *   - tentative_groups : accepted anchor cliques with their members and scores
 *   - unanchored_ids   : items that did not land in any anchor (proceed to Phase 2)
 *   - candidate_pairs  : the full scored pair list (useful for debugging / Phase 2)
 *   - diagnostics      : clique counts, threshold values
 *
 * Query params:
 *   include_pairs   Boolean ("true"). Attach the full candidate-pair list.
 *                   Default: false.
 *   include_details Boolean ("true"). Attach per-pair sub-score breakdown
 *                   on pairs (only meaningful when include_pairs=true).
 *                   Default: false.
 */

import { NextRequest } from 'next/server';
import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import { computeAllPairScores, type RunItemForPairing } from '@/app/api/_lib/pairscore';
import { runPhase1, type ScoredPair } from '@/app/api/_lib/clique-detection';

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
              tentative_groups: [],
              unanchored_ids: [],
              diagnostics: {
                raw_clique_count: 0,
                valid_clique_count: 0,
                thresholds: {
                  strong_edge: 0.12,
                  two_node:    0.15,
                  external_sep_multiplier: 0.5,
                },
              },
            },
          },
          { headers: NO_CACHE_HEADERS }
        );
      }

      // ── 3. Map DB rows → RunItemForPairing ───────────────────────────────
      const runItems: RunItemForPairing[] = itemRows.map((row) => ({
        run_item_id:        Number((row as any).RUN_ITEM_ID),
        literal_value:      String((row as any).LITERAL_VALUE ?? ''),
        cleaned_value:      (row as any).CLEANED_VALUE == null
                              ? null
                              : String((row as any).CLEANED_VALUE),
        normalization_value:(row as any).NORMALIZATION_VALUE == null
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

      // Shape into ScoredPair (what Phase 1 needs) and preserve full results.
      const candidatePairs: ScoredPair[] = pairResults.map((p) => ({
        run_item_id_a: p.run_item_id_a,
        run_item_id_b: p.run_item_id_b,
        pair_score: p.pair_score,
      }));

      // ── 5. Phase 1 — clique detection and anchor resolution ───────────────
      const phase1 = runPhase1(allIds, candidatePairs);

      // ── 6. Enrich tentative groups with literal values ────────────────────
      const enrichedGroups = phase1.tentative_groups.map((g) => ({
        ...g,
        members: g.member_ids.map((id) => ({
          run_item_id:   id,
          literal_value: literalById.get(id) ?? null,
        })),
      }));

      const enrichedUnanchored = phase1.unanchored_ids.map((id) => ({
        run_item_id:   id,
        literal_value: literalById.get(id) ?? null,
      }));

      // ── 7. Optionally attach candidate-pair list ──────────────────────────
      let pairsPayload: unknown = undefined;
      if (includePairs) {
        pairsPayload = pairResults
          .sort((a, b) => b.pair_score - a.pair_score)
          .map((p) => {
            const base = {
              run_item_id_a:  p.run_item_id_a,
              run_item_id_b:  p.run_item_id_b,
              literal_value_a: literalById.get(p.run_item_id_a) ?? null,
              literal_value_b: literalById.get(p.run_item_id_b) ?? null,
              pair_score:     p.pair_score,
            };
            return includeDetails ? { ...base, details: p.details } : base;
          });
      }

      // ── 8. Respond ────────────────────────────────────────────────────────
      const body: Record<string, unknown> = {
        data: {
          run_id:           Number(run_id),
          unassigned_count: runItems.length,
          tentative_groups: enrichedGroups,
          unanchored:       enrichedUnanchored,
          diagnostics: {
            raw_clique_count:   phase1.raw_clique_count,
            valid_clique_count: phase1.valid_clique_count,
            anchor_count:       phase1.tentative_groups.length,
            anchored_count:     allIds.length - phase1.unanchored_ids.length,
            unanchored_count:   phase1.unanchored_ids.length,
            thresholds: {
              strong_edge:              0.12,
              two_node:                 0.15,
              external_sep_multiplier:  0.5,
            },
          },
        },
      };

      if (includePairs) {
        (body.data as Record<string, unknown>).candidate_pairs = pairsPayload;
      }

      return Response.json(body, { headers: NO_CACHE_HEADERS });
    });
  } catch (error) {
    console.error('[phase1] error:', error);
    return snowflakeErrorResponse(error, 'Failed to run Phase 1 clique detection');
  }
}
