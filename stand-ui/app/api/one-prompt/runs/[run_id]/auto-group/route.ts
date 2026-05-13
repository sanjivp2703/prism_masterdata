import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import { runOpAutoGroup, saveOpRunState } from '@/app/api/_lib/op-auto-group';

async function exec(connection: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete: (err: any, _stmt: any, rows: any[]) => {
        if (err) reject(err);
        else     resolve(rows ?? []);
      },
    });
  });
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ run_id: string }> },
) {
  const { run_id } = await params;
  const runId = Number(run_id);
  if (!Number.isFinite(runId) || runId <= 0) {
    return Response.json({ error: 'Invalid run_id' }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'ANTHROPIC_API_KEY is not configured on the server.' },
      { status: 500 },
    );
  }

  try {
    return await withSnowflake(async (connection) => {
      // Verify the run exists in the standard RUNS table.
      const runRows = await exec(
        connection,
        `SELECT run_status FROM STAND_DB.STAND_INTERNAL.RUNS WHERE run_id = ?`,
        [runId],
      );

      if (!runRows.length) {
        return Response.json({ error: `Run ${runId} not found` }, { status: 404 });
      }

      // Run steps 3–7.  State is initialised from RUN_ITEMS if no blob exists yet.
      const finalState = await runOpAutoGroup(connection, runId, apiKey);

      // Write final state blob (step 7).
      await saveOpRunState(connection, runId, finalState);

      return Response.json({ data: finalState }, { status: 200 });
    });
  } catch (error) {
    console.error(`[one-prompt] Auto-group error for run ${runId}:`, error);
    return snowflakeErrorResponse(error, 'Auto-grouping failed');
  }
}
