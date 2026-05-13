/**
 * GET /api/run/[run_id]/unassigned-grouping/candidate-pairs
 *
 * Phase 0 of the unassigned-item grouping procedure.
 *
 * Fetches all unassigned run items (group_id IS NULL), computes a PairScore
 * for every distinct pair, and returns the list sorted by pair_score DESC.
 * Each (a, b) pair is returned exactly once (run_item_id_a < run_item_id_b).
 *
 * Query params:
 *   min_score      Float [0, 1]. Only return pairs at or above this threshold.
 *                  Default: 0 (return all pairs).
 *   include_details Boolean ("true"). Include full sub-component breakdown.
 *                  Default: false.
 */

import { NextRequest } from 'next/server';
import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import {
  computeAllPairScores,
  type RunItemForPairing,
  type PairScoreResult,
} from '@/app/api/_lib/pairscore';

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

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ run_id: string }> }
) {
  const { run_id } = await params;
  const { searchParams } = request.nextUrl;

  const minScore = Math.max(0, Math.min(1, Number(searchParams.get('min_score') ?? '0')));
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

      // ── 2. Fetch all unassigned run items (group_id IS NULL) ─────────────
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
              pair_count: 0,
              pairs: [],
            },
          },
          { headers: NO_CACHE_HEADERS }
        );
      }

      // ── 3. Map DB rows → RunItemForPairing ───────────────────────────────
      const runItems: RunItemForPairing[] = itemRows.map((row) => ({
        run_item_id: Number((row as any).RUN_ITEM_ID),
        literal_value: String((row as any).LITERAL_VALUE ?? ''),
        cleaned_value:
          (row as any).CLEANED_VALUE == null ? null : String((row as any).CLEANED_VALUE),
        normalization_value:
          (row as any).NORMALIZATION_VALUE == null
            ? null
            : String((row as any).NORMALIZATION_VALUE),
        std_tokens: tokensFromVariant((row as any).TOKENS),
        norm_tokens: tokensFromVariant((row as any).NORMALIZED_TOKENS),
      }));

      // ── 4. Compute all pair scores ───────────────────────────────────────
      // O(N²) — each (a, b) pair is scored once (a.id < b.id by convention).
      const allPairs: PairScoreResult[] = computeAllPairScores(runItems);

      // ── 5. Filter + sort ──────────────────────────────────────────────────
      const literalById = new Map<number, string>(
        runItems.map((ri) => [ri.run_item_id, ri.literal_value])
      );

      const filtered = allPairs
        .filter((p) => p.pair_score >= minScore)
        .sort((a, b) => b.pair_score - a.pair_score);

      // ── 6. Shape response ────────────────────────────────────────────────
      const pairs = filtered.map((p) => {
        const base = {
          run_item_id_a: p.run_item_id_a,
          run_item_id_b: p.run_item_id_b,
          literal_value_a: literalById.get(p.run_item_id_a) ?? null,
          literal_value_b: literalById.get(p.run_item_id_b) ?? null,
          pair_score: p.pair_score,
        };
        return includeDetails ? { ...base, details: p.details } : base;
      });

      return Response.json(
        {
          data: {
            run_id: Number(run_id),
            unassigned_count: runItems.length,
            pair_count: pairs.length,
            pairs,
          },
        },
        { headers: NO_CACHE_HEADERS }
      );
    });
  } catch (error) {
    console.error('[candidate-pairs] error:', error);
    return snowflakeErrorResponse(error, 'Failed to compute candidate pairs');
  }
}

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
};
