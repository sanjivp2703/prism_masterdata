import { snowflakeErrorResponse, withSnowflake } from '@/app/api/_lib/snowflake';
import {
  hasBaseline,
  initBaseline,
  diffAndUpdate,
} from '@/app/api/_lib/auto-export-seen';

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

/**
 * POST /api/auto-export/poll
 * Body: { table_fqn: string, column_name: string, domain_id?: number | null }
 *
 * 1. Fetches all distinct non-null values from the Snowflake column.
 * 2. Checks the Redis seen-set for this source:
 *    - If no baseline exists yet: seeds it and returns isBaseline=true.
 *    - If baseline exists: diffs against it, updates the set.
 * 3. Filters Redis-new values against LITERAL_ALIAS_MATCHES for the domain —
 *    values that already have a confirmed mapping are not re-queued.
 * 4. Falls back gracefully if Redis is unavailable.
 */
export async function POST(request: Request) {
  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const table_fqn   = String(body?.table_fqn   ?? '').trim();
  const column_name = String(body?.column_name  ?? '').trim();
  const domain_id: number | null = body?.domain_id != null ? Number(body.domain_id) : null;
  const pipeline_id: number | null = body?.pipeline_id != null ? Number(body.pipeline_id) : null;

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
    return await withSnowflake(async (connection) => {
      const tableRef = `${quoteIdent(db)}.${quoteIdent(schema)}.${quoteIdent(table)}`;
      const colRef   = quoteIdent(column_name);

      // ── Fetch current distinct values from Snowflake ──────────────────
      let rows: any[];
      try {
        rows = await exec(
          connection,
          `SELECT DISTINCT TO_VARCHAR(${colRef}) AS literal_value
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

      const currentValues = rows.map(r => String(r.LITERAL_VALUE ?? r.literal_value ?? ''));

      // ── Check Redis baseline ──────────────────────────────────────────
      const baselineExists = await hasBaseline(table_fqn, column_name);

      if (!baselineExists) {
        // First ever poll for this source: seed the baseline, return metadata
        await initBaseline(table_fqn, column_name, currentValues);
        console.log(
          `[Auto Export] Baseline established — ${currentValues.length} existing value(s) in ${table_fqn}.${column_name}`
        );
        return Response.json({
          isBaseline:  true,
          count:       currentValues.length,
          newValues:   [],
        });
      }

      // Subsequent poll: diff against Redis, returns null if Redis unavailable
      const newValues = await diffAndUpdate(table_fqn, column_name, currentValues);

      if (newValues === null) {
        // Redis unavailable — can't safely diff. Return empty to avoid flooding.
        console.warn(
          `[Auto Export] Redis unavailable during poll of ${table_fqn}.${column_name} — skipping diff`
        );
        return Response.json({
          isBaseline:      false,
          newValues:       [],
          redisUnavailable: true,
        });
      }

      // ── Filter out values already mapped in LITERAL_ALIAS_MATCHES ──────
      // A value that already has a confirmed alias for this domain is not a
      // new item — it was either in the initial run or a previous auto-group.
      let queueValues = newValues;
      if (newValues.length > 0) {
        const placeholders  = newValues.map(() => '?').join(', ');
        const domainFilter  = domain_id != null
          ? `AND lam.domain_id = ${Number(domain_id)}`
          : `AND lam.domain_id IS NULL`;

        const mappedRows = await exec(
          connection,
          `SELECT lam.literal_value
           FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES lam
           WHERE lam.literal_value IN (${placeholders})
           ${domainFilter}`,
          newValues,
        );
        const alreadyMapped = new Set(
          mappedRows.map(r => String(r.LITERAL_VALUE ?? r.literal_value ?? '')),
        );
        queueValues = newValues.filter(v => !alreadyMapped.has(v));

        if (alreadyMapped.size > 0) {
          console.log(
            `[Auto Export] Filtered out ${alreadyMapped.size} already-mapped value(s) for domain ${domain_id ?? 'global'}`,
          );
        }
      }

      if (queueValues.length > 0) {
        console.log(
          `[Auto Export] ${queueValues.length} new unmapped value(s) in ${table_fqn}.${column_name}:`,
          queueValues,
        );

        // Persist new values to PIPELINE_QUEUE if pipeline_id was supplied
        if (pipeline_id) {
          const placeholders = queueValues.map(() => `(?, ?)` ).join(', ');
          const binds: any[] = [];
          for (const v of queueValues) { binds.push(pipeline_id, v); }
          try {
            await exec(
              connection,
              `INSERT INTO STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE (pipeline_id, literal_value)
               VALUES ${placeholders}
               ON CONFLICT DO NOTHING`,
              binds,
            );
          } catch {
            // Snowflake doesn't support ON CONFLICT — fall back to per-row upsert via MERGE
            for (const v of queueValues) {
              await exec(
                connection,
                `MERGE INTO STAND_DB.STAND_INTERNAL.PIPELINE_QUEUE AS tgt
                 USING (SELECT ? AS pipeline_id, ? AS literal_value) AS src
                   ON tgt.pipeline_id = src.pipeline_id AND tgt.literal_value = src.literal_value
                 WHEN NOT MATCHED THEN
                   INSERT (pipeline_id, literal_value) VALUES (src.pipeline_id, src.literal_value)`,
                [pipeline_id, v],
              );
            }
          }
        }
      } else if (pipeline_id) {
        // Zero new values — mark the queue as empty (last_queue_empty_at)
        await exec(
          connection,
          `UPDATE STAND_DB.STAND_INTERNAL.PIPELINES
           SET last_queue_empty_at = CURRENT_TIMESTAMP(), updated_at = CURRENT_TIMESTAMP()
           WHERE pipeline_id = ? AND queue_size = 0`,
          [pipeline_id],
        );
      }

      return Response.json({
        isBaseline: false,
        newValues:  queueValues,
      });
    });
  } catch (error) {
    return snowflakeErrorResponse(error, 'Poll failed');
  }
}
