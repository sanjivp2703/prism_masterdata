/**
 * Snowflake masking policy management for Prism pipelines.
 *
 * ⚠️  REQUIRES SNOWFLAKE ENTERPRISE EDITION (or higher).
 * Masking policies are not available on Standard Edition — attempting to use
 * them produces error 0A000 "Unsupported feature".  All public functions in
 * this module detect that error and skip gracefully so pipelines still work
 * on Standard Edition accounts without the transparent-standardization layer.
 *
 * When a pipeline is activated on an Enterprise account, Prism:
 *   1. Creates (or replaces) a shared scalar SQL UDF:
 *        STAND_DB.STAND_INTERNAL.PRISM_STANDARDIZE(LITERAL_VALUE VARCHAR, P_DOMAIN_ID NUMBER)
 *      The UDF looks up LITERAL_VALUE in LITERAL_ALIAS_MATCHES for the given domain
 *      and returns the canonical alias name, or the original value when no mapping exists.
 *
 *   2. Creates (or replaces) a pipeline-specific masking policy:
 *        STAND_DB.STAND_INTERNAL.PRISM_MASK_PIPELINE_<pipeline_id>
 *      The policy body calls the UDF with the pipeline's domain_id hardcoded, because
 *      Snowflake masking policies only receive the column value as an argument.
 *
 *   3. Applies the masking policy to the watched column:
 *        ALTER TABLE <table_fqn> MODIFY COLUMN <column_name> SET MASKING POLICY ...
 *
 * When a pipeline is deleted, the policy is unset from the column and dropped.
 *
 * Required Snowflake privileges (Enterprise Edition only):
 *   - CREATE FUNCTION           on schema STAND_DB.STAND_INTERNAL
 *   - CREATE MASKING POLICY     on schema STAND_DB.STAND_INTERNAL  (Enterprise only)
 *   - APPLY MASKING POLICY      on ACCOUNT                         (Enterprise only)
 *   - USAGE on DATABASE/SCHEMA  for each source database and schema
 *
 * Note: Snowflake tables have no "ALTER" privilege. The right to attach
 * masking policies comes solely from APPLY MASKING POLICY ON ACCOUNT.
 */

import 'server-only';
import { withSnowflake } from './snowflake';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds,
      complete: (err: any, _s: any, rows: any[]) =>
        err ? reject(err) : resolve(rows || []),
    });
  });
}

/**
 * Returns true ONLY for Snowflake error 0A000 ("Unsupported feature"), which
 * is what Standard Edition accounts return for masking-policy DDL.
 *
 * We intentionally do NOT match on message text like "masking policy" because
 * that would swallow real permission errors such as:
 *   "Insufficient privileges to operate on masking policy ..."
 * Those should be re-thrown so they appear in the server log.
 */
function isUnsupportedFeature(err: unknown): boolean {
  const msg  = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const code = String((err as any)?.code ?? '');
  return code === '0A000' || msg.startsWith('unsupported feature');
}

function quoteIdent(ident: string): string {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

function parseFqn(fqn: string): { db: string; schema: string; table: string } {
  const parts = String(fqn).split('.').map(p => p.trim());
  if (parts.length !== 3) throw new Error(`Expected DB.SCHEMA.TABLE, got: ${fqn}`);
  return { db: parts[0], schema: parts[1], table: parts[2] };
}

const UDF_FQN       = 'STAND_DB.STAND_INTERNAL.PRISM_STANDARDIZE';
const POLICY_PREFIX = 'STAND_DB.STAND_INTERNAL.PRISM_MASK_PIPELINE_';

function maskingPolicyFqn(pipeline_id: number): string {
  return `${POLICY_PREFIX}${pipeline_id}`;
}

/**
 * Creates (or replaces) the shared lookup UDF.
 * Idempotent — safe to call on every pipeline activation.
 *
 * The UDF uses LIMIT 1 in the subquery because each (literal_value, domain_id)
 * pair should have at most one row, but guards against any data anomalies.
 */
async function ensureUdf(conn: any): Promise<void> {
  // IMPORTANT: parameter is named INPUT_VAL (not LITERAL_VALUE) to avoid a
  // name collision with the column lam.literal_value in the lookup join.
  // If the parameter shared the column name, Snowflake would resolve the WHERE
  // clause as `lam.literal_value = lam.literal_value` (always true), causing
  // every input to return the first alias in the domain instead of the correct one.
  await exec(conn, `
    CREATE OR REPLACE FUNCTION ${UDF_FQN}(INPUT_VAL VARCHAR, P_DOMAIN_ID NUMBER)
    RETURNS VARCHAR
    LANGUAGE SQL
    COMMENT = 'Prism: maps a raw literal to its canonical alias for the given domain. Returns the original value when no mapping exists.'
    AS
    $$
      SELECT COALESCE(
        (
          SELECT MIN(aan.alias_name)
          FROM   STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
          JOIN   STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES  aan
                   ON aan.alias_id = lam.alias_id
          WHERE  lam.literal_value = INPUT_VAL
            AND  (
                   (P_DOMAIN_ID IS NULL AND lam.domain_id IS NULL)
                   OR lam.domain_id = P_DOMAIN_ID
                 )
        ),
        INPUT_VAL
      )
    $$
  `);
}

/**
 * Creates (or replaces) the pipeline-specific masking policy and applies it to
 * the source column.  Idempotent — safe to call on re-activation.
 *
 * Silently skips on Snowflake Standard Edition (error 0A000) so pipelines
 * still function — they just won't have transparent column-level standardization.
 */
export async function applyMaskingPolicy(
  pipeline_id: number,
  table_fqn:   string,
  column_name: string,
  domain_id:   number | null,
): Promise<void> {
  const { db, schema, table } = parseFqn(table_fqn);
  const tableRef  = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
  const colRef    = quoteIdent(column_name);
  const policy    = maskingPolicyFqn(pipeline_id);

  // Hardcode the domain_id in the masking policy body — masking policies only
  // receive the column value, so the domain must be a compile-time constant.
  const domainArg = domain_id != null ? `${Number(domain_id)}::NUMBER` : `NULL::NUMBER`;

  try {
    await withSnowflake(async (conn) => {
      // 1. Ensure the shared UDF is current (idempotent CREATE OR REPLACE)
      await ensureUdf(conn);

      // 2. Create or replace the per-pipeline masking policy
      await exec(conn, `
        CREATE OR REPLACE MASKING POLICY ${policy}
        AS (val VARCHAR) RETURNS VARCHAR ->
          ${UDF_FQN}(val, ${domainArg})
      `);

      // 3. Unset any existing masking policy on the column before re-applying.
      //    Snowflake rejects SET when a policy is already attached, so we always
      //    UNSET first. Ignore errors — the column may not have had a policy yet.
      try {
        await exec(conn, `
          ALTER TABLE ${tableRef}
          MODIFY COLUMN ${colRef}
          UNSET MASKING POLICY
        `);
      } catch {
        // no policy was attached — not an error
      }

      // 4. Apply the new policy to the column
      await exec(conn, `
        ALTER TABLE ${tableRef}
        MODIFY COLUMN ${colRef}
        SET MASKING POLICY ${policy}
      `);
    });

    console.log(`[MaskingPolicy] Applied ${policy} → ${table_fqn}.${column_name} (domain_id=${domain_id ?? 'null'})`);
  } catch (err) {
    if (isUnsupportedFeature(err)) {
      console.warn(
        `[MaskingPolicy] Skipped — Snowflake masking policies require Enterprise Edition. ` +
        `Pipeline ${pipeline_id} will still standardize via Prism but reads of ` +
        `${table_fqn}.${column_name} will return raw values until upgraded.`,
      );
      return;
    }
    throw err;
  }
}

/**
 * Unsets the masking policy from the source column WITHOUT dropping the policy
 * object.  Used when a pipeline is paused — the policy stays in
 * STAND_DB.STAND_INTERNAL so re-activation can SET it again without a CREATE.
 * Non-throwing — errors are logged but never propagate.
 */
export async function unsetColumnMasking(
  pipeline_id: number,
  table_fqn:   string,
  column_name: string,
): Promise<void> {
  try {
    const { db, schema, table } = parseFqn(table_fqn);
    const tableRef = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
    const colRef   = quoteIdent(column_name);

    await withSnowflake(async (conn) => {
      await exec(conn, `
        ALTER TABLE ${tableRef}
        MODIFY COLUMN ${colRef}
        UNSET MASKING POLICY
      `);
    });

    console.log(`[MaskingPolicy] Unset masking from ${table_fqn}.${column_name} (pipeline ${pipeline_id})`);
  } catch (err) {
    if (isUnsupportedFeature(err)) return;
    console.warn(`[MaskingPolicy] Could not unset masking for pipeline ${pipeline_id}:`, err);
  }
}

/**
 * Unsets the masking policy from the source column and drops the policy object.
 * Non-throwing — errors are logged but do not propagate, so pipeline deletion
 * always succeeds even when the source table has been dropped by the user.
 */
export async function dropMaskingPolicy(
  pipeline_id: number,
  table_fqn:   string,
  column_name: string,
): Promise<void> {
  const policy = maskingPolicyFqn(pipeline_id);

  try {
    const { db, schema, table } = parseFqn(table_fqn);
    const tableRef = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
    const colRef   = quoteIdent(column_name);

    await withSnowflake(async (conn) => {
      // 1. Unset from column first (required before DROP; ignore if table/column gone)
      try {
        await exec(conn, `
          ALTER TABLE ${tableRef}
          MODIFY COLUMN ${colRef}
          UNSET MASKING POLICY
        `);
      } catch {
        // source table may have been dropped, or Standard Edition — not an error
      }

      // 2. Drop the policy object itself
      await exec(conn, `DROP MASKING POLICY IF EXISTS ${policy}`);
    });

    console.log(`[MaskingPolicy] Dropped ${policy}`);
  } catch (err) {
    if (isUnsupportedFeature(err)) {
      // Standard Edition — nothing to drop, silently skip
      return;
    }
    console.warn(`[MaskingPolicy] Could not drop policy for pipeline ${pipeline_id}:`, err);
  }
}
