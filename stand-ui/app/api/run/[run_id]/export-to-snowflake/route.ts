import { NextRequest } from 'next/server';
import snowflake from 'snowflake-sdk';

function createConnection() {
  return snowflake.createConnection({
    account: process.env.SNOWFLAKE_ACCOUNT || '',
    username: process.env.SNOWFLAKE_USER || '',
    password: process.env.SNOWFLAKE_PASSWORD || '',
    warehouse: process.env.SNOWFLAKE_WAREHOUSE || '',
    database: process.env.SNOWFLAKE_DATABASE || 'STAND_DB',
    schema: process.env.SNOWFLAKE_SCHEMA || 'STAND_INTERNAL',
  });
}

function quoteIdent(ident: string) {
  // Quote as a Snowflake identifier (handles reserved words / mixed case).
  // Assumes caller is trusted; still escapes quotes.
  return `"${String(ident).replace(/"/g, '""')}"`;
}

function parseFqn(fqn: string) {
  const parts = String(fqn).split('.').map((p) => p.trim());
  if (parts.length !== 3) {
    throw new Error(
      `Expected fully-qualified table name <DB>.<SCHEMA>.<TABLE>, got: ${fqn}`
    );
  }
  return { db: parts[0], schema: parts[1], table: parts[2] };
}

async function exec(
  connection: snowflake.Connection,
  sqlText: string,
  binds?: any[]
) {
  return await new Promise<any[]>((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      complete: (err, stmt, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      },
    });
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ run_id: string }> }
) {
  const { run_id } = await params;

  const connection = createConnection();

  try {
    const runIdNum = Number.parseInt(String(run_id), 10);
    if (!Number.isFinite(runIdNum)) {
      return Response.json({ error: 'Invalid run_id' }, { status: 400 });
    }

    // Optional: apply UI drag/drop moves before exporting.
    let moves: Array<{ run_item_id: number; group_id: number }> = [];
    let aliasNameChanges: Array<{ group_id: number; alias_name: string }> = [];
    try {
      const body = await request.json();
      if (Array.isArray(body?.moves)) {
        moves = body.moves
          .map((m: any) => ({
            run_item_id: Number.parseInt(String(m?.run_item_id), 10),
            group_id: Number.parseInt(String(m?.group_id), 10),
          }))
          .filter(
            (m: { run_item_id: number; group_id: number }) =>
              Number.isFinite(m.run_item_id) && Number.isFinite(m.group_id)
          );
      }
      if (Array.isArray(body?.alias_name_changes)) {
        aliasNameChanges = body.alias_name_changes
          .map((c: any) => ({
            group_id: Number.parseInt(String(c?.group_id), 10),
            alias_name: String(c?.alias_name ?? '').trim(),
          }))
          .filter(
            (c: { group_id: number; alias_name: string }) =>
              Number.isFinite(c.group_id) && c.alias_name.length > 0
          );
      }
    } catch {
      // ignore missing/invalid body
    }

    await new Promise<void>((resolve, reject) => {
      connection.connect((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Fetch run metadata (source table + column)
    const runRows = await exec(
      connection,
      `
        SELECT
          source_relation,
          source_column
        FROM STAND_DB.STAND_INTERNAL.RUNS
        WHERE run_id = ?
      `,
      [run_id]
    );

    if (runRows.length === 0) {
      return Response.json({ error: 'Run not found' }, { status: 404 });
    }

    const sourceRelation = runRows[0].SOURCE_RELATION as string;
    const sourceColumn = runRows[0].SOURCE_COLUMN as string;

    if (aliasNameChanges.length > 0) {
      const pairs = aliasNameChanges.map(() => '(?, ?)').join(', ');
      const binds: any[] = [];
      for (const c of aliasNameChanges) {
        binds.push(c.group_id, c.alias_name);
      }
      binds.push(run_id);

      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
          SET alias_name = mv.alias_name
          FROM (
            SELECT column1::NUMBER AS group_id, column2::VARCHAR AS alias_name
            FROM VALUES ${pairs}
          ) mv
          WHERE rg.run_id = ?
            AND rg.group_id = mv.group_id
        `,
        binds
      );
    }

    if (moves.length > 0) {
      const pairs = moves.map(() => '(?, ?)').join(', ');
      const binds: any[] = [];
      for (const m of moves) {
        binds.push(m.run_item_id, m.group_id);
      }
      // bind run_id twice: for validating group_id exists in run, and limiting updated items to run
      binds.push(run_id, run_id);

      // Update RUN_ITEMS.group_id for this run, only if the target group_id exists for the run.
      await exec(
        connection,
        `
          UPDATE STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
          SET group_id = mv.group_id
          FROM (
            SELECT column1::NUMBER AS run_item_id, column2::NUMBER AS group_id
            FROM VALUES ${pairs}
          ) mv
          JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
            ON rg.run_id = ?
           AND rg.group_id = mv.group_id
          WHERE ri.run_id = ?
            AND ri.run_item_id = mv.run_item_id
        `,
        binds
      );
    }

    // Create a view: source table + standardized column.
    // IMPORTANT: Views cannot safely depend on TEMP tables/stages (session-scoped).
    // So we use a stable mapping subquery from RUN_ITEMS + RUN_GROUPS for this run_id.
    const { db, schema, table } = parseFqn(sourceRelation);
    const standardizedCol = `${sourceColumn}_STANDARDIZED`;
    const viewName = `${table}_STANDARDIZED_RUN_${run_id}`;

    const tableFqn =
      `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
    const viewFqn =
      `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(viewName)}`;
    const colIdent = quoteIdent(sourceColumn);
    const standardizedIdent = quoteIdent(standardizedCol);

    await exec(
      connection,
      `
        CREATE OR REPLACE VIEW ${viewFqn} AS
        SELECT
          t.*,
          COALESCE(m.alias_value, TO_VARCHAR(t.${colIdent})) AS ${standardizedIdent}
        FROM ${tableFqn} t
        LEFT JOIN (
          SELECT
            ri.raw_value AS raw_value,
            COALESCE(rg.alias_name, rg.initial_alias_name) AS alias_value
          FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS ri
          JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
            ON rg.run_id = ri.run_id
           AND rg.group_id = ri.group_id
          WHERE ri.run_id = ${runIdNum}
        ) m
          ON TO_VARCHAR(t.${colIdent}) = m.raw_value
      `
    );

    const cntRows = await exec(
      connection,
      `
        SELECT COUNT(*) AS cnt
        FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS
        WHERE run_id = ?
      `,
      [run_id]
    );

    return Response.json({
      data: {
        run_id,
        source_relation: sourceRelation,
        source_column: sourceColumn,
        view_fqn: `${db}.${schema}.${viewName}`,
        standardized_column: standardizedCol,
        mapped_values_count: Number(cntRows?.[0]?.CNT ?? 0),
      },
    });
  } catch (error) {
    console.error('Export error:', error);
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to export to Snowflake',
      },
      { status: 500 }
    );
  } finally {
    connection.destroy((err) => {
      if (err) console.error('Error closing connection:', err);
    });
  }
}


