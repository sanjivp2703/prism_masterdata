import { warehouseErrorResponse, withWarehouse, withUserWarehouse, hasUserWarehouseConfig, isWarehouseAccessError, executeQuery as exec, getWarehouseAdapter, resolveSourceReference } from '@/app/api/_lib/warehouse';
import { quoteIdent as myQuoteIdent } from '@/app/api/_lib/warehouse/mysql/dialect';
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
    // Postgres accepts the 2-part SCHEMA.TABLE form (the db part is implied by
    // the connection and never emitted in the reference below).
    const parts = String(table_fqn).split('.').map(p => p.trim());
    if (getWarehouseAdapter().kind === 'postgres' && parts.length === 2 && parts.every(Boolean)) {
      db = ''; schema = parts[0]; table = parts[1];
    } else if (getWarehouseAdapter().kind === 'mysql' && parts.length === 2 && parts.every(Boolean)) {
      // MySQL: DATABASE.TABLE — the db part IS emitted (cross-database reads
      // work there); the schema slot stays empty (no schema level).
      db = parts[0]; schema = ''; table = parts[1];
    } else {
      const fqn = parseFqn(table_fqn);
      db = fqn.db; schema = fqn.schema; table = fqn.table;
    }
  } catch {
    return Response.json(
      { error: `Invalid table_fqn format. Expected DB.SCHEMA.TABLE, got: ${table_fqn}` },
      { status: 400 }
    );
  }

  if ((db !== '' && !isSimpleIdent(db)) || (schema !== '' && !isSimpleIdent(schema)) || !isSimpleIdent(table) || !isSimpleIdent(column_name)) {
    return Response.json(
      { error: 'Table or column name contains unsupported characters.' },
      { status: 400 }
    );
  }

  try {
    // Same connection ladder as /api/columns (finding #29): the service login
    // first, then — only when it is refused for ACCESS reasons — the
    // creator's own saved credentials. Without this, connecting a pipeline to
    // a table only the user can see reported "Failed to fetch source values"
    // on the setup screen, even though creation itself would have succeeded
    // via the same fallback.
    const runProbe = async <T,>(fn: (connection: any) => Promise<T>): Promise<T> => {
      try {
        return await withWarehouse(fn);
      } catch (serviceErr) {
        if (!isWarehouseAccessError(serviceErr)) throw serviceErr;
        if (!(await hasUserWarehouseConfig(Number(authz.accountId)))) throw serviceErr;
        return await withUserWarehouse(Number(authz.accountId), fn);
      }
    };

    return await runProbe(async (connection) => {
      // Postgres: 2-part reference — a connection is bound to one database,
      // and a 3-part form naming another database can't be honored anyway
      // (pgTableRef validates that upstream surfaces; here the db part is
      // simply not emitted).
      const tableRef = getWarehouseAdapter().kind === 'postgres'
        ? `${quoteIdent(schema)}.${quoteIdent(table)}`
        : getWarehouseAdapter().kind === 'mysql'
        // Backticks — double quotes are STRING literals on MySQL.
        ? `${myQuoteIdent(db)}.${myQuoteIdent(table)}`
        // Snowflake: a native-edition source granted through the permission UI
        // (manifest reference) is only reachable via the reference form on the
        // SERVICE connection; resolution returns null everywhere else (and on
        // the caller-fallback attempt), leaving the quoted FQN.
        : (await resolveSourceReference(connection, { db, schema, table }))?.refSql
          ?? `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
      const colRef   = getWarehouseAdapter().kind === 'mysql' ? myQuoteIdent(column_name) : quoteIdent(column_name);

      let rows: any[];
      try {
        // SQL Server / Postgres: columns are already text-typed (the picker
        // gates on that) and TO_VARCHAR doesn't exist — select directly.
        rows = await exec(
          connection,
          getWarehouseAdapter().kind !== 'snowflake'
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
