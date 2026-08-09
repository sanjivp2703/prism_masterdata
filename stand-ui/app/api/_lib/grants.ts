import 'server-only';

/**
 * Generates the ordered list of SQL grant statements that must be applied to a
 * Snowflake account for Prism to function. These mirror the ROLES AND GRANTS
 * block at the bottom of 01_internal_tables.sql — keep the two in sync.
 *
 * @param serviceUser  The Snowflake username the app service role is granted to.
 *                     Omit to skip the GRANT ROLE … TO USER statement.
 */
export function buildGrantStatements(serviceUser?: string): string[] {
  const stmts: string[] = [
    // Roles
    `CREATE ROLE IF NOT EXISTS PRISM_SERVICE`,
    `CREATE ROLE IF NOT EXISTS PRISM_DATA_ADMIN`,
    `CREATE ROLE IF NOT EXISTS PRISM_USER`,
    `CREATE ROLE IF NOT EXISTS PRISM_READONLY`,
    // Role hierarchy
    `GRANT ROLE PRISM_USER TO ROLE PRISM_SERVICE`,
    `GRANT ROLE PRISM_READONLY TO ROLE PRISM_USER`,
    // Dedicated warehouse (CREATE WAREHOUSE is an account-level privilege —
    // fails gracefully for non-ACCOUNTADMIN roles; run 01_internal_tables.sql
    // manually in that case)
    `CREATE WAREHOUSE IF NOT EXISTS PRISM_WH WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 60 AUTO_RESUME = TRUE INITIALLY_SUSPENDED = TRUE STATEMENT_TIMEOUT_IN_SECONDS = 600 COMMENT = 'Dedicated warehouse for the Prism standardization service'`,
    `GRANT USAGE, OPERATE ON WAREHOUSE PRISM_WH TO ROLE PRISM_SERVICE`,
    `GRANT USAGE ON WAREHOUSE PRISM_WH TO ROLE PRISM_DATA_ADMIN`,
    // DB visibility for PRISM_USER / PRISM_READONLY (INTERNAL stays private)
    `GRANT USAGE ON DATABASE PRISM_DB TO ROLE PRISM_USER`,
    `GRANT USAGE ON DATABASE PRISM_DB TO ROLE PRISM_READONLY`,
    // PRISM_DB / INTERNAL — service role
    `GRANT USAGE ON DATABASE PRISM_DB TO ROLE PRISM_SERVICE`,
    `GRANT USAGE ON SCHEMA PRISM_DB.INTERNAL TO ROLE PRISM_SERVICE`,
    `GRANT ALL PRIVILEGES ON SCHEMA PRISM_DB.INTERNAL TO ROLE PRISM_SERVICE`,
    // Default destination schema for lookup-table exports
    `GRANT USAGE ON SCHEMA PRISM_DB.PUBLIC TO ROLE PRISM_SERVICE`,
    `GRANT CREATE TABLE ON SCHEMA PRISM_DB.PUBLIC TO ROLE PRISM_SERVICE`,
    `GRANT CREATE VIEW ON SCHEMA PRISM_DB.PUBLIC TO ROLE PRISM_SERVICE`,
    // Current tables
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE PRISM_DB.INTERNAL.PIPELINE_QUEUE TO ROLE PRISM_SERVICE`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE PRISM_DB.INTERNAL.PIPELINE_FILE_ROWS TO ROLE PRISM_SERVICE`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES TO ROLE PRISM_SERVICE`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE PRISM_DB.INTERNAL.LITERAL_ALIAS_MATCHES TO ROLE PRISM_SERVICE`,
    // Future tables / UDFs
    `GRANT SELECT, INSERT, UPDATE, DELETE ON FUTURE TABLES IN SCHEMA PRISM_DB.INTERNAL TO ROLE PRISM_SERVICE`,
    `GRANT CREATE FUNCTION ON SCHEMA PRISM_DB.INTERNAL TO ROLE PRISM_SERVICE`,
    `GRANT ALL PRIVILEGES ON FUTURE FUNCTIONS IN SCHEMA PRISM_DB.INTERNAL TO ROLE PRISM_SERVICE`,
    `GRANT USAGE ON ALL FUNCTIONS IN SCHEMA PRISM_DB.INTERNAL TO ROLE PRISM_SERVICE`,
    `GRANT USAGE ON FUNCTION PRISM_DB.INTERNAL.PRISM_NORMALIZE(VARCHAR) TO ROLE PRISM_SERVICE`,
    // PRISM_DATA_ADMIN
    `GRANT USAGE ON DATABASE PRISM_DB TO ROLE PRISM_DATA_ADMIN`,
    `GRANT USAGE ON SCHEMA PRISM_DB.INTERNAL TO ROLE PRISM_DATA_ADMIN`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE PRISM_DB.INTERNAL.LITERAL_ALIAS_MATCHES TO ROLE PRISM_DATA_ADMIN`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE PRISM_DB.INTERNAL.APPROVED_ALIAS_NAMES TO ROLE PRISM_DATA_ADMIN`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE PRISM_DB.INTERNAL.PIPELINE_FILE_ROWS TO ROLE PRISM_DATA_ADMIN`,
    `GRANT USAGE ON FUNCTION PRISM_DB.INTERNAL.PRISM_NORMALIZE(VARCHAR) TO ROLE PRISM_DATA_ADMIN`,
  ];

  if (serviceUser) {
    const u = serviceUser.replace(/"/g, '""');
    stmts.push(`GRANT ROLE PRISM_SERVICE TO USER "${u}"`);
    stmts.push(`GRANT ROLE PRISM_DATA_ADMIN TO USER "${u}"`);
  }

  return stmts;
}

export interface GrantResult {
  sql:     string;
  ok:      boolean;
  /** Object already exists (created at install time) — nothing to do. */
  skipped?: boolean;
  error:   string | null;
}

async function execRows(conn: any, sqlText: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

/** Names of visible objects of a kind ('ROLES' | 'WAREHOUSES'), uppercased. */
async function fetchExistingNames(conn: any, kind: 'ROLES' | 'WAREHOUSES'): Promise<Set<string>> {
  try {
    const rows = await execRows(conn, `SHOW ${kind}`);
    return new Set(rows.map((r: any) => String(r.name ?? r.NAME ?? '').toUpperCase()).filter(Boolean));
  } catch {
    return new Set(); // can't check — fall back to attempting the statement
  }
}

/**
 * Run all grant statements on an open Snowflake connection.
 *
 * Account-level CREATE statements (roles, warehouse) are pre-checked against
 * SHOW ROLES / SHOW WAREHOUSES: when the object already exists (normal for
 * script-first installs where 01_internal_tables.sql ran as ACCOUNTADMIN),
 * the statement is reported as ok+skipped instead of failing on privileges.
 */
export async function applyGrants(
  conn: any,
  serviceUser?: string,
): Promise<GrantResult[]> {
  const statements = buildGrantStatements(serviceUser);
  const results: GrantResult[] = [];

  const existingRoles      = await fetchExistingNames(conn, 'ROLES');
  const existingWarehouses = await fetchExistingNames(conn, 'WAREHOUSES');

  // Role GRANTS need their own pre-check, same as role/warehouse CREATION.
  //
  // `GRANT ROLE x TO ROLE y` is idempotent, so on a script-first install (the
  // normal case — the customer ran 01_internal_tables.sql by hand) these four
  // statements succeed and land in the plain "applied" bucket. The panel then
  // reports "N grants applied · M already in place" with those four counted as
  // newly applied, implying Prism just changed something it did not. Only
  // CREATE ROLE / CREATE WAREHOUSE were pre-checked, so the two halves of the
  // same install told different stories (SET-S16).
  //
  // SHOW GRANTS TO ROLE is metadata-layer (free, no warehouse resume), matching
  // the SHOW ROLES / SHOW WAREHOUSES calls above.
  const existingRoleGrants = new Set<string>();
  // Both grantee kinds: `TO ROLE x` and `TO USER x`. Covering only roles left
  // the two TO USER statements still reporting as freshly "applied" on an
  // already-configured install — the same half-truth this pre-check exists to
  // remove, just in a smaller place (SET-S16). SHOW GRANTS TO USER is the
  // matching metadata-layer call.
  const grantees: Array<{ kind: 'ROLE' | 'USER'; name: string }> = [];
  for (const sql of statements) {
    // The grantee may be quoted — buildGrantStatements emits
    // `TO USER "${u}"` (a username is free text and can need quoting), so a
    // regex anchored on \w+$ matched the ROLE statements and silently never
    // matched a USER one. The pre-check then covered only half the statements
    // it was written for (SET-S16).
    const m = sql.match(/^GRANT ROLE (\w+) TO (ROLE|USER) "?([^"]+)"?$/);
    if (m && !grantees.some(g => g.kind === m[2] && g.name === m[3])) {
      grantees.push({ kind: m[2] as 'ROLE' | 'USER', name: m[3] });
    }
  }
  for (const { kind, name: roleName } of grantees) {
    try {
      // Reuses the file's existing execRows helper rather than hand-rolling the
      // same promise wrapper again.
      const rows = await execRows(conn, `SHOW GRANTS TO ${kind} ${roleName}`);
      for (const r of rows) {
        const priv = String(r.privilege ?? r.PRIVILEGE ?? '').toUpperCase();
        const on   = String(r.granted_on ?? r.GRANTED_ON ?? '').toUpperCase();
        const name = String(r.name ?? r.NAME ?? '').toUpperCase();
        if (priv === 'USAGE' && on === 'ROLE') existingRoleGrants.add(`${name}->${roleName.toUpperCase()}`);
      }
    } catch { /* not permitted to inspect — fall through and just run the GRANT */ }
  }

  for (const sql of statements) {
    const roleMatch = sql.match(/^CREATE ROLE IF NOT EXISTS (\w+)$/);
    if (roleMatch && existingRoles.has(roleMatch[1].toUpperCase())) {
      results.push({ sql, ok: true, skipped: true, error: null });
      continue;
    }
    const whMatch = sql.match(/^CREATE WAREHOUSE IF NOT EXISTS (\w+)\b/);
    if (whMatch && existingWarehouses.has(whMatch[1].toUpperCase())) {
      results.push({ sql, ok: true, skipped: true, error: null });
      continue;
    }
    const roleGrantMatch = sql.match(/^GRANT ROLE (\w+) TO (?:ROLE|USER) "?([^"]+)"?$/);
    if (roleGrantMatch
        && existingRoleGrants.has(`${roleGrantMatch[1].toUpperCase()}->${roleGrantMatch[2].toUpperCase()}`)) {
      results.push({ sql, ok: true, skipped: true, error: null });
      continue;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        conn.execute({
          sqlText: sql,
          complete: (err: any) => (err ? reject(err) : resolve()),
        });
      });
      results.push({ sql, ok: true, error: null });
    } catch (err: any) {
      results.push({ sql, ok: false, error: String(err?.message ?? err) });
    }
  }

  return results;
}
