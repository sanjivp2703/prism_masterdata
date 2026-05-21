import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import { saveOpRunState, type OpRunState } from '@/app/api/_lib/op-auto-group';

function quoteIdent(ident: string) {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

function parseFqn(fqn: string) {
  const parts = String(fqn).split('.').map((p) => p.trim());
  if (parts.length !== 3) {
    throw new Error(`Expected DB.SCHEMA.TABLE, got: ${fqn}`);
  }
  return { db: parts[0], schema: parts[1], table: parts[2] };
}

function isSimpleIdent(s: string) {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(s);
}

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

  if (!table_fqn)   return Response.json({ error: 'table_fqn is required' },   { status: 400 });
  if (!column_name) return Response.json({ error: 'column_name is required' }, { status: 400 });

  // Validate FQN format
  let db: string, schema: string, table: string;
  try {
    const fqn = parseFqn(table_fqn);
    db = fqn.db; schema = fqn.schema; table = fqn.table;
  } catch {
    return Response.json(
      { error: `Invalid table_fqn format. Expected DB.SCHEMA.TABLE, got: ${table_fqn}` },
      { status: 400 }
    );
  }

  if (!isSimpleIdent(db) || !isSimpleIdent(schema) || !isSimpleIdent(table) || !isSimpleIdent(column_name)) {
    return Response.json({ error: 'Table or column name contains unsupported characters.' }, { status: 400 });
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

      // Probe the source table and fetch distinct values with frequencies.
      const tableRef = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
      const colRef   = quoteIdent(column_name);
      let valueRows: any[];
      try {
        valueRows = await exec(
          connection,
          `SELECT DISTINCT TO_VARCHAR(${colRef}) AS literal_value,
                  COUNT(*) AS source_frequency
           FROM ${tableRef}
           WHERE ${colRef} IS NOT NULL
           GROUP BY TO_VARCHAR(${colRef})
           ORDER BY source_frequency DESC`
        );
      } catch (e: any) {
        const msg = String(e?.message ?? e ?? '');
        if (/invalid identifier/i.test(msg)) {
          return Response.json(
            { error: `Column "${column_name}" was not found in table ${table_fqn}.` },
            { status: 400 }
          );
        }
        if (/does not exist|not found|unauthorized|object.*not.*found/i.test(msg)) {
          return Response.json(
            { error: `Table "${table_fqn}" does not exist or you do not have access.` },
            { status: 400 }
          );
        }
        throw e;
      }

      // Create the run row. Use a nonce so we can retrieve the auto-assigned run_id.
      const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      await exec(
        connection,
        `INSERT INTO STAND_DB.STAND_INTERNAL.ONE_PROMPT_RUNS
           (concept_id, source_relation, source_column, mode, run_status, creation_nonce, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'created', ?, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
        [conceptId, table_fqn, column_name, mode, nonce]
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

      // Build and persist the initial state blob.
      const initialState: OpRunState = {
        status:    'created',
        items:     valueRows.map((row, idx) => ({
          run_item_id:         idx + 1,
          literal_value:       String(row.LITERAL_VALUE ?? row.literal_value ?? ''),
          source_frequency:    Number(row.SOURCE_FREQUENCY ?? row.source_frequency ?? 1),
          matched_from_lookup: false,
        })),
        groups:    [],
        ungrouped: valueRows.map((row) => ({
          literal_value:       String(row.LITERAL_VALUE ?? row.literal_value ?? ''),
          matched_from_lookup: false,
        })),
      };
      await saveOpRunState(connection, run_id, initialState);

      return Response.json({ data: { run_id } }, { status: 201 });
    });
  } catch (error) {
    console.error('Create run error:', error);
    return snowflakeErrorResponse(error, 'Failed to create run');
  }
}
