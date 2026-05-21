import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import { runOpExport } from '@/app/api/_lib/op-export';

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
        `SELECT run_status FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_RUNS WHERE run_id = ?`,
        [runId],
      );

      if (!runRows.length) {
        return Response.json({ error: `Run ${runId} not found` }, { status: 404 });
      }

      const runStatus = String(
        (runRows[0] as any).RUN_STATUS ?? (runRows[0] as any).run_status ?? '',
      ).toLowerCase();

      // Always export the run's groupings regardless of status.
      // Backend table writes are only initiated on the first export (handled inside runOpExport).
      const result = await runOpExport(connection, runId, apiKey, runStatus);

      return Response.json({ data: result }, { status: 200 });
    });
  } catch (error) {
    console.error(`[one-prompt] Export error for run ${runId}:`, error);
    return snowflakeErrorResponse(error, 'Export failed');
  }
}
