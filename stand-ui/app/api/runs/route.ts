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

export async function POST(request: Request) {
  let body: any = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const concept_key = String(body?.concept_key ?? 'mobile_carrier').trim();
  const table_fqn   = String(body?.table_fqn   ?? '').trim();
  const column_name = String(body?.column_name  ?? '').trim();
  const mode        = String(body?.mode         ?? 'review').trim();

  if (!table_fqn) {
    return Response.json({ error: 'table_fqn is required' }, { status: 400 });
  }
  if (!column_name) {
    return Response.json({ error: 'column_name is required' }, { status: 400 });
  }

  try {
    return await withSnowflake(async (connection) => {
      const rows = await exec(
        connection,
        `CALL STAND_DB.STAND.CREATE_RUN(?, ?, ?, ?)`,
        [concept_key, table_fqn, column_name, mode]
      );

      // The procedure returns a VARCHAR; the Snowflake driver surfaces it
      // under the procedure name as the column key (uppercase).
      const resultMsg = String(
        rows?.[0]?.CREATE_RUN ?? rows?.[0]?.create_run ?? ''
      );

      if (resultMsg.startsWith('ERROR:')) {
        let detail = resultMsg.replace(/^ERROR:\s*/i, '');

        // Parse the structured STEP=... SQLCODE=... SQLERRM=... format
        // from the stored procedure's catch-all exception handler and convert
        // known patterns into human-readable messages.
        const stepMatch = detail.match(/^STEP=(\S+)\s+SQLCODE=(\d+)\s+SQLERRM=(.*)/s);
        if (stepMatch) {
          const step     = stepMatch[1];
          const sqlcode  = stepMatch[2];
          const sqlerrm  = stepMatch[3].trim();

          if ((step === 'tmp_source_values_fill' || step === 'probe_column_access') && sqlcode === '904') {
            // Invalid identifier — the column name doesn't exist in the source table.
            const colMatch = sqlerrm.match(/invalid identifier '([^']+)'/i);
            const colName  = colMatch ? colMatch[1] : column_name;
            detail = `Column "${colName}" was not found in table ${table_fqn}. Please check the column name and try again.`;
          } else if (step === 'probe_table_access' || (sqlcode === '2003' || sqlcode === '90083')) {
            detail = `Table "${table_fqn}" does not exist or you do not have access.`;
          } else {
            // Generic structured error — still cleaner than raw STEP=... output.
            detail = `${sqlerrm} (step: ${step})`;
          }
        }

        return Response.json({ error: detail }, { status: 400 });
      }

      // Result message contains "Run ID: <n>" somewhere in its body.
      const match = resultMsg.match(/Run ID:\s*(\d+)/i);
      if (!match) {
        console.error('CREATE_RUN unexpected response:', resultMsg);
        return Response.json(
          { error: 'Run was created but the run ID could not be parsed from the response.' },
          { status: 500 }
        );
      }

      const run_id = Number(match[1]);
      return Response.json({ data: { run_id } }, { status: 201 });
    });
  } catch (error) {
    console.error('Create run error:', error);
    return snowflakeErrorResponse(error, 'Failed to create run');
  }
}
