import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import { saveOpRunState, type OpRunState } from '@/app/api/_lib/op-auto-group';

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

  const concept_key   = 'mobile_carrier';
  const source_column = String(body?.source_column ?? '').trim();
  const table_json    = String(body?.table_json    ?? '').trim();

  if (!source_column) return Response.json({ error: 'source_column is required' }, { status: 400 });
  if (!table_json)    return Response.json({ error: 'table_json is required' },    { status: 400 });

  // Parse and validate the table.
  let tableData: PastedTable;
  try {
    tableData = JSON.parse(table_json) as PastedTable;
    if (!Array.isArray(tableData.headers) || !Array.isArray(tableData.rows)) {
      throw new Error('Invalid structure');
    }
  } catch {
    return Response.json({ error: 'Invalid table_json format' }, { status: 400 });
  }

  const colIdx = tableData.headers.findIndex(
    (h) => h.toLowerCase() === source_column.toLowerCase()
  );
  if (colIdx === -1) {
    return Response.json(
      { error: `Column "${source_column}" not found in table headers: ${tableData.headers.join(', ')}` },
      { status: 400 }
    );
  }

  // Distinct non-empty values in column order.
  const values = [
    ...new Set(
      tableData.rows
        .map((r) => (r[colIdx] ?? '').trim())
        .filter((v) => v !== '')
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
      // Look up concept_id.
      const conceptRows = await exec(
        connection,
        `SELECT concept_id FROM STAND_DB.STAND_INTERNAL.CONCEPTS WHERE concept_key = ? LIMIT 1`,
        [concept_key]
      );
      if (!conceptRows.length) {
        return Response.json({ error: `Concept "${concept_key}" not found.` }, { status: 400 });
      }
      const conceptId = Number(conceptRows[0].CONCEPT_ID ?? conceptRows[0].concept_id);

      // Build initial state from pasted values.
      const initialState: OpRunState = {
        status:    'created',
        items:     values.map((lv, idx) => ({
          run_item_id:         idx + 1,
          literal_value:       lv,
          matched_from_lookup: false,
        })),
        groups:    [],
        ungrouped: values.map((lv) => ({
          literal_value:       lv,
          matched_from_lookup: false,
        })),
      };

      // Create the run row.
      // Use SELECT instead of VALUES so PARSE_JSON(?) is allowed as an expression.
      const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      await exec(
        connection,
        `INSERT INTO STAND_DB.STAND_INTERNAL.ONE_PROMPT_RUNS
           (concept_id, source_relation, source_column, mode, run_status,
            state, stats_snapshot, creation_nonce, created_at, updated_at)
         SELECT ?, '__pasted__', ?, 'review', 'created',
                PARSE_JSON(?), PARSE_JSON(?), ?, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()`,
        [conceptId, source_column, JSON.stringify(initialState), table_json, nonce]
      );

      const runIdRows = await exec(
        connection,
        `SELECT run_id FROM STAND_DB.STAND_INTERNAL.ONE_PROMPT_RUNS
         WHERE creation_nonce = ? LIMIT 1`,
        [nonce]
      );
      if (!runIdRows.length) {
        return Response.json(
          { error: 'Run was created but the run ID could not be retrieved.' },
          { status: 500 }
        );
      }
      const run_id = Number(runIdRows[0].RUN_ID ?? runIdRows[0].run_id);

      return Response.json({ data: { run_id } }, { status: 201 });
    });
  } catch (error) {
    console.error('Create run from paste error:', error);
    return snowflakeErrorResponse(error, 'Failed to create run from paste');
  }
}
