import { NextRequest } from 'next/server';
import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import { loadOpRunState } from '@/app/api/_lib/op-auto-group';

type AliasMap = Record<
  string,
  {
    group_id: number | null;
    display_name: string;
    items: Array<{
      run_item_id: number;
      literal_value: string;
      confidence_score: number | null;
      needs_review?: boolean;
    }>;
  }
>;

const UNGROUPED_KEY = '__UNGROUPED__';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ run_id: string }> }
) {
  const { run_id } = await params;

  try {
    return await withSnowflake(async (connection) => {
      // Verify run exists.
      const runRows = await new Promise<any[]>((resolve, reject) => {
        connection.execute({
          sqlText: `SELECT run_id FROM STAND_DB.STAND_INTERNAL.RUNS WHERE run_id = ? LIMIT 1`,
          binds:   [run_id],
          complete: (err, _stmt, rows) => {
            if (err) reject(err);
            else     resolve(rows || []);
          },
        });
      });

      if (runRows.length === 0) {
        return Response.json({ error: 'Run not found' }, { status: 404 });
      }

      // Load the state blob that is written at run-creation time and updated by
      // every auto-group call.  RUNS.state is the single source of
      // truth for items and groupings.
      const state = await loadOpRunState(connection, Number(run_id));

      const aliasMap: AliasMap = {};

      if (state) {
        // Build a lookup: literal_value → run_item_id (from the flat items array).
        const itemIdMap = new Map<string, number>();
        state.items.forEach((item, idx) => {
          itemIdMap.set(item.literal_value, item.run_item_id ?? (idx + 1));
        });

        // Populate a bucket per group. Singleton groups the LLM couldn't place
        // carry needs_review=true (self-mapped + written to the lookup, so the
        // pipeline queue stays empty) — flag their items so the UI highlights them.
        for (const group of state.groups) {
          const key = `g_${group.group_id}`;
          const groupNeedsReview = group.needs_review === true;
          aliasMap[key] = {
            group_id:     group.group_id,
            display_name: group.alias_name,
            items:        group.items.map((gi) => ({
              run_item_id:     itemIdMap.get(gi.literal_value) ?? 0,
              literal_value:   gi.literal_value,
              confidence_score: null,
              ...(groupNeedsReview ? { needs_review: true } : {}),
            })),
          };
        }

        // Ungrouped items become singleton review groups instead of a drop zone.
        // Each item gets its own group (keyed by run_item_id) with needs_review=true
        // so the UI can highlight them and prompt the user to confirm or move them.
        for (const u of state.ungrouped) {
          const run_item_id = itemIdMap.get(u.literal_value) ?? 0;
          const key = `__review_${run_item_id}__`;
          aliasMap[key] = {
            group_id:     null,
            display_name: u.literal_value,
            items: [{
              run_item_id,
              literal_value:    u.literal_value,
              confidence_score: null,
              needs_review:     true,
            }],
          };
        }

        // Empty ungrouped bucket for backwards compatibility with any code that reads it.
        aliasMap[UNGROUPED_KEY] = { group_id: null, display_name: '', items: [] };
      } else {
        aliasMap[UNGROUPED_KEY] = { group_id: null, display_name: '', items: [] };
      }

      return Response.json(
        { data: aliasMap },
        {
          headers: {
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            Pragma:          'no-cache',
            Expires:         '0',
          },
        }
      );
    });
  } catch (error) {
    console.error('Database error:', error);
    return snowflakeErrorResponse(error, 'Failed to fetch alias mapping');
  }
}
