import { NextRequest } from 'next/server';
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

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ run_id: string }> }
) {
  const { run_id } = await params;

  const runIdNum = Number.parseInt(String(run_id), 10);
  if (!Number.isFinite(runIdNum)) {
    return Response.json({ error: 'Invalid run_id' }, { status: 400 });
  }

  try {
    return await withSnowflake(async (connection) => {
      // Fetch run metadata (source type + stored table for paste runs)
      const runRows = await exec(
        connection,
        `SELECT source_relation, source_column, stats_snapshot
         FROM STAND_DB.STAND_INTERNAL.RUNS
         WHERE run_id = ?`,
        [runIdNum]
      );

      if (runRows.length === 0) {
        return Response.json({ error: 'Run not found' }, { status: 404 });
      }

      const runRow         = runRows[0];
      const sourceRelation = String(runRow.SOURCE_RELATION ?? runRow.source_relation ?? '');
      const sourceColumn   = String(runRow.SOURCE_COLUMN   ?? runRow.source_column   ?? '');
      const statsSnapshot  = runRow.STATS_SNAPSHOT ?? runRow.stats_snapshot ?? null;

      // Fetch original_value → standardized_value for all assigned items
      const mappingRows = await exec(
        connection,
        `
        SELECT
          ri.literal_value                                                AS original_value,
          COALESCE(rg.alias_name_literal_value, rg.initial_alias_name)   AS standardized_value
        FROM STAND_DB.STAND_INTERNAL.RUN_ITEMS  ri
        JOIN STAND_DB.STAND_INTERNAL.RUN_GROUPS rg
          ON  rg.run_id   = ri.run_id
          AND rg.group_id = ri.group_id
        WHERE ri.run_id   = ?
          AND ri.group_id IS NOT NULL
        ORDER BY standardized_value, original_value
        `,
        [runIdNum]
      );

      // Build a lookup for quick mapping
      const mapping: Record<string, string> = {};
      for (const r of mappingRows) {
        const orig = String(r.ORIGINAL_VALUE    ?? r.original_value    ?? '');
        const std  = String(r.STANDARDIZED_VALUE ?? r.standardized_value ?? '');
        mapping[orig] = std;
      }

      // ── Paste run: reconstruct the full original table + append standardized column ──
      if (sourceRelation === '__pasted__' && statsSnapshot) {
        // Snowflake returns VARIANT as a parsed JS object; guard against string form too
        const tableData: { title: string; headers: string[]; rows: string[][] } =
          typeof statsSnapshot === 'string' ? JSON.parse(statsSnapshot) : statsSnapshot;

        const colIdx     = tableData.headers.findIndex(
          h => h.toLowerCase() === sourceColumn.toLowerCase()
        );
        const stdColName = `standardized_${sourceColumn}`;
        // Insert stdCol immediately after the source column (not appended at end)
        const insertAt = colIdx >= 0 ? colIdx + 1 : tableData.headers.length;
        const headers  = [
          ...tableData.headers.slice(0, insertAt),
          stdColName,
          ...tableData.headers.slice(insertAt),
        ];

        const rows: Record<string, string>[] = tableData.rows.map((r) => {
          const originalVal = colIdx >= 0 ? (r[colIdx] ?? '') : '';
          const rowObj: Record<string, string> = {};
          tableData.headers.forEach((h, i) => { rowObj[h] = r[i] ?? ''; });
          rowObj[stdColName] = originalVal ? (mapping[originalVal] ?? '') : '';
          return rowObj;
        });

        return Response.json({
          rows,
          headers,
          title: tableData.title || null,
          sourceColumn,
        });
      }

      // ── Snowflake run: return the two-column mapping ──
      const rows = mappingRows.map(r => ({
        original_value:     String(r.ORIGINAL_VALUE    ?? r.original_value    ?? ''),
        standardized_value: String(r.STANDARDIZED_VALUE ?? r.standardized_value ?? ''),
      }));

      return Response.json({
        rows,
        headers: ['original_value', 'standardized_value'],
        title:   null,
        sourceColumn,
      });
    });
  } catch (error) {
    console.error('export-mapping error:', error);
    return snowflakeErrorResponse(error, 'Failed to load export mapping');
  }
}
