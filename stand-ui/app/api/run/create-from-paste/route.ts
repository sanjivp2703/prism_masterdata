import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';

async function exec(connection: any, sqlText: string, binds?: any[]) {
  return await new Promise<any[]>((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete: (err: any, _stmt: any, rows: any[]) => {
        if (err) reject(err);
        else resolve(rows || []);
      },
    });
  });
}

interface PastedTable {
  title:   string;
  headers: string[];
  rows:    string[][];
}

export async function POST(request: Request) {
  let body: any = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  // Concept is hardcoded for now; will be parameterised when the concept selector is added.
  const concept_key   = 'mobile_carrier';
  const source_column = String(body?.source_column ?? '').trim();
  const table_json    = String(body?.table_json    ?? '').trim();

  if (!source_column) {
    return Response.json({ error: 'source_column is required' }, { status: 400 });
  }
  if (!table_json) {
    return Response.json({ error: 'table_json is required' }, { status: 400 });
  }

  // Parse and validate the table
  let tableData: PastedTable;
  try {
    tableData = JSON.parse(table_json) as PastedTable;
    if (!Array.isArray(tableData.headers) || !Array.isArray(tableData.rows)) {
      throw new Error('Invalid structure');
    }
  } catch {
    return Response.json({ error: 'Invalid table_json format' }, { status: 400 });
  }

  // Find source column (case-insensitive)
  const colIdx = tableData.headers.findIndex(
    h => h.toLowerCase() === source_column.toLowerCase()
  );
  if (colIdx === -1) {
    return Response.json(
      { error: `Column "${source_column}" not found in table headers: ${tableData.headers.join(', ')}` },
      { status: 400 }
    );
  }

  // Extract distinct, non-empty values from the source column
  const values = [
    ...new Set(
      tableData.rows
        .map(r => (r[colIdx] ?? '').trim())
        .filter(v => v !== '')
    ),
  ];
  if (values.length === 0) {
    return Response.json(
      { error: 'No non-empty values found in the specified column' },
      { status: 400 }
    );
  }

  try {
    return await withSnowflake(async (connection) => {
      // Create the run (seeding RUN_ITEMS from the distinct value list)
      const rows = await exec(
        connection,
        `CALL STAND_DB.STAND.CREATE_RUN(?, ?, ?, ?, ?, ?)`,
        [
          concept_key,
          '__pasted__',
          source_column,
          'review',
          'paste',
          JSON.stringify(values),
        ]
      );

      const resultMsg = String(
        rows?.[0]?.CREATE_RUN ?? rows?.[0]?.create_run ?? ''
      );

      if (resultMsg.startsWith('ERROR:')) {
        let detail = resultMsg.replace(/^ERROR:\s*/i, '');
        const stepMatch = detail.match(/^STEP=(\S+)\s+SQLCODE=(\d+)\s+SQLERRM=(.*)/s);
        if (stepMatch) {
          detail = `${stepMatch[3].trim()} (step: ${stepMatch[1]})`;
        }
        return Response.json({ error: detail }, { status: 400 });
      }

      const match = resultMsg.match(/Run ID:\s*(\d+)/i);
      if (!match) {
        console.error('CREATE_RUN (paste) unexpected response:', resultMsg);
        return Response.json(
          { error: 'Run was created but the run ID could not be parsed from the response.' },
          { status: 500 }
        );
      }

      const run_id = Number(match[1]);

      // Store the full pasted table in stats_snapshot so the export route can
      // reconstruct the original table and append the standardized column.
      await exec(
        connection,
        `UPDATE STAND_DB.STAND_INTERNAL.RUNS
         SET    stats_snapshot = PARSE_JSON(?)
         WHERE  run_id = ?`,
        [table_json, run_id]
      );

      return Response.json({ data: { run_id } }, { status: 201 });
    });
  } catch (error) {
    console.error('Create run from paste error:', error);
    return snowflakeErrorResponse(error, 'Failed to create run from paste');
  }
}
