// SQL Server data-access SQL generator — the engine behind the setup wizard's
// step 2 Part C AND the connect form's inline "ask your admin to run this"
// panel (owner request 2026-08-17: an access error must hand the user the
// exact grant SQL, not just point at the wizard). Pure module, client-safe.
//
// Entry forms:
//   DATABASE.SCHEMA        → Change Tracking on EVERY table in the schema
//                            that has a primary key (server-side loop;
//                            PK-less tables are PRINTed and skipped)
//   DATABASE.SCHEMA.TABLE  → Change Tracking on that table only (repeatable)
// Statements are idempotent, and each block ends in GO so the output runs
// as-is in sqlcmd as well as SSMS. Returns null when any entry isn't a 2- or
// 3-part dotted name or uses characters we won't embed in SQL text.
export function buildMssqlDataAccessSql(input: string): string | null {
  interface Scope { db: string; schema: string; tables: string[]; allTables: boolean }
  const ID = /^[\w$#@ -]+$/;
  const scopes = new Map<string, Scope>();
  for (const s of input.split(',').map(x => x.trim()).filter(Boolean)) {
    const parts = s.split('.').map(p => p.trim()).filter(Boolean);
    if (parts.length !== 2 && parts.length !== 3) return null;
    if (!parts.every(p => ID.test(p))) return null;
    const key = `${parts[0].toUpperCase()}.${parts[1].toUpperCase()}`;
    const scope = scopes.get(key) ?? { db: parts[0], schema: parts[1], tables: [], allTables: false };
    if (parts.length === 2) scope.allTables = true;
    else scope.tables.push(parts[2]);
    scopes.set(key, scope);
  }
  if (scopes.size === 0) return null;
  const pairs = [...scopes.values()];
  const blocks = pairs.map(({ db, schema, tables, allTables }) => {
    const wholeSchema = allTables || tables.length === 0;
    const ctSection = wholeSchema
      ? `-- Change Tracking (recommended — Prism detects changes within about a
-- minute) for EVERY table in [${schema}] that has a primary key. Tables
-- without one are listed and skipped — Change Tracking requires a primary
-- key; re-run this after adding tables and only the new ones are touched.
IF NOT EXISTS (SELECT 1 FROM sys.change_tracking_databases WHERE database_id = DB_ID('${db}'))
  ALTER DATABASE [${db}] SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON);
DECLARE @ct nvarchar(max) = N'';
SELECT @ct = @ct + N'ALTER TABLE [${schema}].' + QUOTENAME(t.name) + N' ENABLE CHANGE_TRACKING;'
FROM sys.tables t
WHERE t.schema_id = SCHEMA_ID('${schema}')
  AND EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = t.object_id AND i.is_primary_key = 1)
  AND NOT EXISTS (SELECT 1 FROM sys.change_tracking_tables c WHERE c.object_id = t.object_id);
EXEC sp_executesql @ct;
DECLARE @skipped nvarchar(max) = N'';
SELECT @skipped = @skipped + QUOTENAME(t.name) + N' '
FROM sys.tables t
WHERE t.schema_id = SCHEMA_ID('${schema}')
  AND NOT EXISTS (SELECT 1 FROM sys.indexes i WHERE i.object_id = t.object_id AND i.is_primary_key = 1);
IF LEN(@skipped) > 0 PRINT N'Skipped (no primary key — Change Tracking needs one): ' + @skipped;`
      : `-- Change Tracking (recommended — Prism detects changes within about a
-- minute) for the specific table(s) you listed. Each needs a primary key.
IF NOT EXISTS (SELECT 1 FROM sys.change_tracking_databases WHERE database_id = DB_ID('${db}'))
  ALTER DATABASE [${db}] SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 2 DAYS, AUTO_CLEANUP = ON);
${tables.map(t =>
`IF NOT EXISTS (SELECT 1 FROM sys.change_tracking_tables c WHERE c.object_id = OBJECT_ID('[${schema}].[${t}]'))
  ALTER TABLE [${schema}].[${t}] ENABLE CHANGE_TRACKING;`).join('\n')}`;
    return `-- ── ${db}.${schema} ─────────────────────────────────────────────────────
USE [${db}];
-- Read access for Prism's service login (safe to re-run):
IF DATABASE_PRINCIPAL_ID('prism_svc') IS NULL EXEC('CREATE USER prism_svc FOR LOGIN prism_svc');
GRANT SELECT ON SCHEMA::[${schema}] TO prism_svc;

${ctSection}

-- One grant lets Prism READ the change data, and covers every current AND
-- future table in the schema:
GRANT VIEW CHANGE TRACKING ON SCHEMA::[${schema}] TO prism_svc;
GO`;
  });
  blocks.push(
`-- ── Export area (recommended) ───────────────────────────────────────────
-- A schema used ONLY for Prism's standardized output tables. Controlling
-- this ONE schema lets Prism re-apply your readers' permissions after each
-- rebuild — SQL Server reports a table's permissions only to a schema's
-- controller, so without this every rebuild silently drops them. Prism gets
-- no rights outside this schema.
USE [${pairs[0].db}];
IF SCHEMA_ID('PRISM_OUT') IS NULL EXEC('CREATE SCHEMA PRISM_OUT');
GRANT CONTROL ON SCHEMA::PRISM_OUT TO prism_svc;
-- Database-level permission to CREATE the standardized output tables.
-- SQL Server needs this PLUS rights on the target schema — and Prism's
-- schema rights are confined to PRISM_OUT above, so this cannot be used
-- to create objects anywhere else.
GRANT CREATE TABLE TO prism_svc;
GO

-- Note: nothing above gives Prism write access to YOUR tables. The one
-- feature that writes to a source table — the "Column" output mode — asks
-- for your consent when you set it up, and UPDATE is granted for that
-- specific table only at that moment.`);
  return blocks.join('\n\n');
}
