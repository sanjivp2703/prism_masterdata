import { NextRequest } from 'next/server';
import { warehouseErrorResponse, withWarehouse, executeQuery as exec } from '@/app/api/_lib/warehouse';
import { requireValidSession } from '@/app/api/_lib/account-security';
import { getDb } from '@/app/api/_lib/sqlite';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ run_id: string }> }
) {
  const authz = await requireValidSession();
  if (authz instanceof Response) return authz;
  const { run_id } = await params;

  const runIdNum = Number.parseInt(String(run_id), 10);
  if (!Number.isFinite(runIdNum)) {
    return Response.json({ error: 'Invalid run_id' }, { status: 400 });
  }

  try {
    return await withWarehouse(async (connection) => {
      // Fetch run metadata from RUNS.
      const runRowDb = getDb()
        .prepare(`SELECT source_relation, source_column, stats_snapshot FROM runs WHERE run_id = ?`)
        .get(runIdNum) as any;

      if (!runRowDb) {
        return Response.json({ error: 'Run not found' }, { status: 404 });
      }

      const runRow         = runRowDb;
      const sourceRelation = String(runRow.SOURCE_RELATION ?? runRow.source_relation ?? '');
      const sourceColumn   = String(runRow.SOURCE_COLUMN   ?? runRow.source_column   ?? '');
      const statsSnapshot  = runRow.STATS_SNAPSHOT ?? runRow.stats_snapshot ?? null;

      // Build the original → standardized mapping from LITERAL_ALIAS_MATCHES
      // (populated after export; empty before export).
      const mappingRows = await exec(
        connection,
        `SELECT lam.literal_value AS original_value, aan.alias_name AS standardized_value
         FROM PRISM_DB.INTERNAL.LITERAL_ALIAS_MATCHES  lam
         JOIN PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES   aan
           ON lam.alias_id = aan.alias_id
         WHERE lam.run_id = ?
         ORDER BY aan.alias_name, lam.literal_value`,
        [runIdNum]
      );

      // Object.create(null), NOT {} — and here the failure mode is WORSE than a
      // crash. This map is keyed by RAW CUSTOMER LITERAL VALUES. On a plain
      // object, `mapping['__proto__'] = std` invokes Object.prototype's
      // __proto__ SETTER, which ignores a string, so the entry is silently
      // dropped; the later read `mapping[originalVal] ?? ''` then returns
      // Object.prototype itself — a truthy object, so `??` never fires — and an
      // object is written into a Record<string,string> cell and serialized as
      // {} in the customer's export. Silent data corruption, no error anywhere.
      const mapping: Record<string, string> = Object.create(null);
      for (const r of mappingRows) {
        const orig = String(r.ORIGINAL_VALUE    ?? r.original_value    ?? '');
        const std  = String(r.STANDARDIZED_VALUE ?? r.standardized_value ?? '');
        mapping[orig] = std;
      }

      // ── Paste run: reconstruct the full original table + append standardized column ──
      if (sourceRelation === '__pasted__' && statsSnapshot) {
        const tableData: { title: string; headers: string[]; rows: string[][] } =
          typeof statsSnapshot === 'string' ? JSON.parse(statsSnapshot) : statsSnapshot;

        const colIdx     = tableData.headers.findIndex(
          (h) => h.toLowerCase() === sourceColumn.toLowerCase()
        );
        const stdColName = `standardized_${sourceColumn}`;
        const insertAt   = colIdx >= 0 ? colIdx + 1 : tableData.headers.length;
        const headers    = [
          ...tableData.headers.slice(0, insertAt),
          stdColName,
          ...tableData.headers.slice(insertAt),
        ];

        const rows: Record<string, string>[] = tableData.rows.map((r) => {
          const originalVal = colIdx >= 0 ? (r[colIdx] ?? '') : '';
          // Same reasoning as `mapping` above — these keys are the user's own
          // column headers, so a header named __proto__ or constructor would
          // corrupt that cell rather than fail loudly.
          const rowObj: Record<string, string> = Object.create(null);
          tableData.headers.forEach((h, i) => { rowObj[h] = r[i] ?? ''; });
          rowObj[stdColName] = originalVal ? (mapping[originalVal] ?? '') : '';
          return rowObj;
        });

        return Response.json({
          rows,
          headers,
          title:        tableData.title || null,
          sourceColumn,
        });
      }

      // ── Snowflake run: return the two-column mapping ──
      const rows = mappingRows.map((r) => ({
        original_value:     String(r.ORIGINAL_VALUE    ?? r.original_value    ?? ''),
        standardized_value: String(r.STANDARDIZED_VALUE ?? r.standardized_value ?? ''),
      }));

      return Response.json({
        rows,
        headers:      ['original_value', 'standardized_value'],
        title:        null,
        sourceColumn,
      });
    });
  } catch (error) {
    console.error('export-mapping error:', error);
    return warehouseErrorResponse(error, 'Failed to load export mapping');
  }
}
