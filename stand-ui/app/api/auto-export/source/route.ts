import { warehouseErrorResponse, withWarehouse, executeQuery as exec, getWarehouseAdapter } from '@/app/api/_lib/warehouse';
import { clearBaseline } from '@/app/api/_lib/auto-export-seen';
import { requireValidSession } from '@/app/api/_lib/account-security';

function quoteIdent(ident: string) {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

function parseFqn(fqn: string) {
  const parts = String(fqn).split('.').map(p => p.trim());
  if (parts.length !== 3) throw new Error(`Expected DB.SCHEMA.TABLE, got: ${fqn}`);
  return { db: parts[0], schema: parts[1], table: parts[2] };
}

function isSimpleIdent(s: string) {
  // Permissive: any non-empty name quoteIdent can safely wrap (spaces, hyphens,
  // leading digits, Unicode letters are all valid quoted identifiers). Reject
  // only control chars and quotes/backslash, which could break out of a quoted
  // identifier or a string literal built elsewhere.
  if (!s) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127 || c === 34 || c === 39 || c === 92) return false;
  }
  return true;
}

/**
 * GET /api/auto-export/source?table_fqn=DB.SCHEMA.TABLE&column_name=COL
 *
 * Returns all distinct non-null values for the specified column.
 * Used by the auto_export mode polling loop on the home page.
 */
export async function GET(request: Request) {
  const authz = await requireValidSession();
  if (authz instanceof Response) return authz;
  const { searchParams } = new URL(request.url);
  const table_fqn   = searchParams.get('table_fqn')?.trim()   ?? '';
  const column_name = searchParams.get('column_name')?.trim() ?? '';

  if (!table_fqn)   return Response.json({ error: 'table_fqn is required' },   { status: 400 });
  if (!column_name) return Response.json({ error: 'column_name is required' }, { status: 400 });

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
    return Response.json(
      { error: 'Table or column name contains unsupported characters.' },
      { status: 400 }
    );
  }

  try {
    return await withWarehouse(async (connection) => {
      const tableRef = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
      const colRef   = quoteIdent(column_name);

      let rows: any[];
      try {
        // SQL Server: columns are already text-typed (the picker gates on
        // that) and TO_VARCHAR doesn't exist — select the column directly.
        rows = await exec(
          connection,
          getWarehouseAdapter().kind === 'mssql'
            ? `SELECT DISTINCT ${colRef} AS literal_value
               FROM ${tableRef}
               WHERE ${colRef} IS NOT NULL
               ORDER BY literal_value`
            : `SELECT DISTINCT TO_VARCHAR(${colRef}) AS literal_value
               FROM ${tableRef}
               WHERE ${colRef} IS NOT NULL
               ORDER BY literal_value`
        );
      } catch (e: any) {
        const msg = String(e?.message ?? e ?? '');
        if (/invalid identifier/i.test(msg)) {
          return Response.json(
            { error: `Column "${column_name}" was not found in ${table_fqn}.` },
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

      const values = rows.map(r => String(r.LITERAL_VALUE ?? r.literal_value ?? ''));
      return Response.json({ values, count: values.length });
    });
  } catch (error) {
    return warehouseErrorResponse(error, 'Failed to fetch source values');
  }
}

/**
 * DELETE /api/auto-export/source?table_fqn=...&column_name=...
 *
 * Clears the Redis baseline for this source so the next poll re-establishes it.
 * Called when the user disconnects and wants to reset.
 */
export async function DELETE(request: Request) {
  const authz = await requireValidSession();
  if (authz instanceof Response) return authz;
  const { searchParams } = new URL(request.url);
  const table_fqn   = searchParams.get('table_fqn')?.trim()   ?? '';
  const column_name = searchParams.get('column_name')?.trim() ?? '';

  if (!table_fqn || !column_name) {
    return Response.json({ error: 'table_fqn and column_name are required' }, { status: 400 });
  }

  await clearBaseline(table_fqn, column_name);
  return Response.json({ ok: true });
}
