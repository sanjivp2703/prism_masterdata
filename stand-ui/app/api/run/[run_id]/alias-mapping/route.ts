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

        // Populate a bucket per group.
        for (const group of state.groups) {
          const key = `g_${group.group_id}`;
          aliasMap[key] = {
            group_id:     group.group_id,
            display_name: group.alias_name,
            items:        group.items.map((gi) => ({
              run_item_id:     itemIdMap.get(gi.literal_value) ?? 0,
              literal_value:   gi.literal_value,
              confidence_score: null,
            })),
          };
        }

        // Build ungrouped bucket.
        const ungroupedItems = state.ungrouped.map((u) => ({
          run_item_id:     itemIdMap.get(u.literal_value) ?? 0,
          literal_value:   u.literal_value,
          confidence_score: null,
        }));

        aliasMap[UNGROUPED_KEY] = {
          group_id:     null,
          display_name: '',
          items:        ungroupedItems,
        };
      } else {
        // No state yet — return an empty ungrouped bucket so the UI renders.
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
