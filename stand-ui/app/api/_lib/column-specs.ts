import 'server-only';

/**
 * Per-column standardization specs — the replacement for the old shared
 * "domains" concept.
 *
 * A spec carries the metadata every standardization column needs: a MANDATORY
 * description (the LLM concept DEFINITION), optional free-text
 * standardization_rules, and an optional naming convention (structured rules +
 * regex/examples/natural). Its `spec_id` doubles as the per-column LOOKUP SCOPE
 * — it is stored into the historical `domain_id` integer slots on `pipelines`,
 * `runs`, `file_source_meta.columns[]`, and the Snowflake lookup tables, so the
 * ubiquitous scope-filter SQL never had to change; only the source of the
 * integer did (domains.domain_id → column_specs.spec_id).
 *
 * This module owns validation, the row shaper, insert/update, and seeding of
 * pre-standardized values / convention examples into the lookup — all lifted
 * from the deleted `/api/domains` POST so both the standalone `/api/column-specs`
 * routes and the pipeline-creation routes share one implementation.
 */

import { getDb, sqliteNow } from './sqlite';
import {
  withWarehouse, executeQuery as exec, getWarehouseAdapter,
} from './warehouse';
import { internalTable } from './warehouse-tables';
import {
  bulkUpsertApprovedAliasesMssql, bulkUpsertLiteralMatchesMssql,
} from './warehouse/mssql/mappings';
import { bulkUpsertApprovedAliasesPg, bulkUpsertLiteralMatchesPg } from './warehouse/postgres/mappings';
import { bulkUpsertApprovedAliasesMysql, bulkUpsertLiteralMatchesMysql } from './warehouse/mysql/mappings';
import { sanitizeConventionRules, hasAnyRule, isProbablyCatastrophicRegex } from './convention-rules';
import { safeRegexError } from './safe-regex';
import { normalizeLiteral } from './normalize';

export interface ColumnSpecRow {
  spec_id:               number;
  pipeline_id:           number | null;
  table_fqn:             string | null;
  column_name:           string;
  description:           string;
  standardization_rules: string | null;   // JSON array of strings
  convention_type:       string | null;    // 'regex' | 'examples' | 'natural' | null
  convention_value:      string | null;
  convention_rules:      string | null;    // JSON ConventionRules
  created_at:            string | null;
  updated_at:            string | null;
}

/** Snowflake returns UPPERCASE keys; SQLite returns lowercase. Coalesce both. */
export function row2spec(r: any): ColumnSpecRow {
  return {
    spec_id:               Number(r.spec_id ?? r.SPEC_ID),
    pipeline_id:           (r.pipeline_id ?? r.PIPELINE_ID) != null ? Number(r.pipeline_id ?? r.PIPELINE_ID) : null,
    table_fqn:             r.table_fqn ?? r.TABLE_FQN ?? null,
    column_name:           String(r.column_name ?? r.COLUMN_NAME ?? ''),
    description:           String(r.description ?? r.DESCRIPTION ?? ''),
    standardization_rules: r.standardization_rules ?? r.STANDARDIZATION_RULES ?? null,
    convention_type:       r.convention_type  ?? r.CONVENTION_TYPE  ?? null,
    convention_value:      r.convention_value ?? r.CONVENTION_VALUE ?? null,
    convention_rules:      r.convention_rules ?? r.CONVENTION_RULES ?? null,
    created_at:            r.created_at ?? r.CREATED_AT ?? null,
    updated_at:            r.updated_at ?? r.UPDATED_AT ?? null,
  };
}

/** Validated + normalized spec fields, ready to persist. */
export interface ValidatedSpec {
  description:         string;
  storedStdRules:      string | null;
  conventionType:      'regex' | 'examples' | 'natural' | null;
  storedConventionValue: string | null;
  storedConventionRules: string | null;
  /** Values to seed into the lookup as confirmed self-mappings (examples + pre-standardized). */
  valuesToSeed:        string[];
}

/**
 * Validate a spec payload (from a request body). Mirrors the old domain caps,
 * except the description is MANDATORY here. Returns either the validated fields
 * or a user-facing error string (the caller turns it into a 400).
 */

/**
 * Shared, reusable halves of validateSpecBody.
 *
 * These exist because the SAME rules were being enforced in three places with
 * three different behaviours: the column-spec routes refused loudly (400), the
 * one-time create route SILENTLY TRUNCATED (dropping rules past 20 and clipping
 * long ones mid-sentence, which can invert a rule's meaning before it goes
 * verbatim into an LLM prompt), and the client checked neither. Silent
 * truncation also contradicts CLAUDE.md's invariant that scale limits refuse
 * loudly and never drop data quietly. Exported so no fourth path can drift.
 */

/** Max free-text standardization rules, and max length of each. */
export const MAX_STD_RULES = 20;
export const MAX_STD_RULE_LEN = 500;
/** Max length of a naming-convention value, by type. */
export const MAX_CONVENTION_REGEX_LEN = 500;
export const MAX_CONVENTION_TEXT_LEN = 2_000;

/** Validate free-text standardization rules. Refuses; never truncates. */
export function validateStandardizationRules(
  raw: unknown,
): { ok: true; rules: string[] } | { ok: false; error: string } {
  const rules: string[] = Array.isArray(raw)
    ? (raw as unknown[]).map(r => String(r).trim()).filter(Boolean)
    : [];
  if (rules.length > MAX_STD_RULES) {
    return { ok: false, error: `Too many standardization rules (max ${MAX_STD_RULES}). Combine or trim them.` };
  }
  const oversized = rules.find(r => r.length > MAX_STD_RULE_LEN);
  if (oversized) {
    return { ok: false, error: `Standardization rule too long (max ${MAX_STD_RULE_LEN} characters): "${oversized.slice(0, 60)}…"` };
  }
  return { ok: true, rules };
}

/**
 * Validate a naming-convention value: length cap, and for regex both
 * compilability and the catastrophic-backtracking screen. The screen matters
 * because the cap does not bound backtracking — `(a+)+b` is six characters and
 * hangs on ~40-character input, and this pattern is later applied to raw source
 * literals on a single-process server, so a hang is a whole-installation outage.
 */
export function validateConventionValue(
  type: 'regex' | 'examples' | 'natural' | null,
  value: string,
): { ok: true } | { ok: false; error: string } {
  if (!type) return { ok: true };
  const cap = type === 'regex' ? MAX_CONVENTION_REGEX_LEN : MAX_CONVENTION_TEXT_LEN;
  if (value.length > cap) {
    return { ok: false, error: `Naming convention value too long (max ${cap} characters).` };
  }
  if (type === 'regex') {
    // TWO checks, and they are not redundant — they defend different engines.
    //
    // 1. RE2 (safeRegexError) is the authority on what Prism can ENFORCE. It is
    //    the same linear-time engine the server uses at runtime, so whatever is
    //    accepted here is exactly what can be evaluated later, and it cannot
    //    backtrack — the server-side hang is gone by construction.
    const regexErr = safeRegexError(value);
    if (regexErr) return { ok: false, error: regexErr };

    // 2. The static catastrophic-shape screen still runs, because the BROWSER
    //    does not use RE2. The review UI's rename guard compiles the stored
    //    pattern with plain `new RegExp` for instant feedback, so a pattern
    //    like `(a+)+b` — which RE2 evaluates in ~5 ms and would happily accept
    //    — could still lock up a reviewer's tab. Keeping such patterns OUT OF
    //    STORAGE is what protects that path. Shipping the wasm engine to the
    //    client is not worth the bundle size for a one-tab freeze, and a server
    //    round-trip per keystroke is worse.
    //
    //    Consequence to be aware of: this rejects a few patterns RE2 could
    //    safely run. That is the deliberate trade — a slightly stricter save
    //    rule in exchange for the browser path being safe too.
    if (isProbablyCatastrophicRegex(value)) {
      return {
        ok: false,
        error:
          'This regex nests one repetition inside another (e.g. "(a+)+"), which can lock up ' +
          'the review screen when names are checked against it. Rewrite it without nesting ' +
          'one repetition inside another.',
      };
    }
  }
  return { ok: true };
}

export function validateSpecBody(body: any): { ok: true; spec: ValidatedSpec } | { ok: false; error: string } {
  // Description — mandatory. Injected verbatim into every prompt as the column's
  // DEFINITION, so cap it.
  const description = String(body?.description ?? '').trim();
  if (!description)              return { ok: false, error: 'A description is required for every column.' };
  if (description.length > 1_000) return { ok: false, error: 'Description too long (max 1000 characters).' };

  // ── Naming convention (optional) ──────────────────────────────────────────
  const rawType = String(body?.convention_type ?? '').trim().toLowerCase();
  const conventionType: 'regex' | 'examples' | 'natural' | null =
    rawType === 'regex' || rawType === 'examples' || rawType === 'natural' ? rawType : null;
  const conventionValue = conventionType ? String(body?.convention_value ?? '').trim() : '';

  if (conventionType && !conventionValue) {
    return { ok: false, error: 'A naming convention value is required for the selected type.' };
  }
  // Cap the convention value: regex patterns are compiled and tested against
  // names, so an unbounded pattern is a catastrophic-backtracking (CPU hang)
  // risk on this single-process server; examples/natural text goes verbatim
  // into every prompt (bloat).
  const convCheck = validateConventionValue(conventionType, conventionValue);
  if (!convCheck.ok) return { ok: false, error: convCheck.error };
  const examples = conventionType === 'examples'
    ? conventionValue.split('\n').map(s => s.trim()).filter(Boolean)
    : [];
  if (conventionType === 'examples' && examples.length === 0) {
    return { ok: false, error: 'Provide at least one example (one per line).' };
  }
  const storedConventionValue = conventionType === 'examples'
    ? examples.join('\n')
    : (conventionType ? conventionValue : null);

  // Structured naming rules (case, spaces, suffixes, length, …) — independent of
  // the regex/examples/natural type; a column can carry only rules.
  const conventionRules = sanitizeConventionRules(body?.convention_rules);
  const storedConventionRules = hasAnyRule(conventionRules) ? JSON.stringify(conventionRules) : null;

  // Free-text standardization rules — injected verbatim into every LLM prompt.
  const stdCheck = validateStandardizationRules(body?.standardization_rules);
  if (!stdCheck.ok) return { ok: false, error: stdCheck.error };
  const rawStdRules = stdCheck.rules;
  const storedStdRules = rawStdRules.length > 0 ? JSON.stringify(rawStdRules) : null;

  // Pre-standardized values — seeded into the lookup as approved canonical names.
  const prestandardizedValues: string[] = Array.isArray(body?.prestandardized_values)
    ? (body.prestandardized_values as unknown[]).map(v => String(v).trim()).filter(Boolean)
    : [];
  if (prestandardizedValues.length + examples.length > 500) {
    return { ok: false, error: 'Too many pre-standardized values/examples (max 500 total).' };
  }
  const oversizedSeed = [...prestandardizedValues, ...examples].find(v => v.length > 200);
  if (oversizedSeed) {
    return { ok: false, error: `Pre-standardized value too long (max 200 characters): "${oversizedSeed.slice(0, 60)}…"` };
  }

  return {
    ok: true,
    spec: {
      description,
      storedStdRules,
      conventionType,
      storedConventionValue,
      storedConventionRules,
      valuesToSeed: [...examples, ...prestandardizedValues],
    },
  };
}

/**
 * Insert a validated spec row and return it. Pure SQLite — does NOT seed the
 * lookup (call seedSpecValues separately, which needs a warehouse connection).
 */
export function insertColumnSpec(
  spec: ValidatedSpec,
  meta: { pipeline_id?: number | null; table_fqn?: string | null; column_name: string },
): ColumnSpecRow {
  const db = getDb();
  const res = db
    .prepare(
      `INSERT INTO column_specs
         (pipeline_id, table_fqn, column_name, description, standardization_rules,
          convention_type, convention_value, convention_rules)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      meta.pipeline_id ?? null,
      meta.table_fqn ?? null,
      meta.column_name,
      spec.description,
      spec.storedStdRules,
      spec.conventionType,
      spec.storedConventionValue,
      spec.storedConventionRules,
    );
  return getColumnSpec(Number(res.lastInsertRowid))!;
}

/** Update an existing spec's metadata (description/rules/convention). */
export function updateColumnSpec(specId: number, spec: ValidatedSpec): ColumnSpecRow | null {
  const db = getDb();
  const info = db
    .prepare(
      `UPDATE column_specs
          SET description = ?, standardization_rules = ?,
              convention_type = ?, convention_value = ?, convention_rules = ?,
              updated_at = ?
        WHERE spec_id = ?`,
    )
    .run(
      spec.description,
      spec.storedStdRules,
      spec.conventionType,
      spec.storedConventionValue,
      spec.storedConventionRules,
      sqliteNow(),
      specId,
    );
  if (info.changes === 0) return null;
  return getColumnSpec(specId);
}

export function getColumnSpec(specId: number): ColumnSpecRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM column_specs WHERE spec_id = ?`)
    .get(specId) as any;
  return row ? row2spec(row) : null;
}

export function listColumnSpecs(pipelineId?: number | null): ColumnSpecRow[] {
  const db = getDb();
  const rows = (pipelineId != null
    ? db.prepare(`SELECT * FROM column_specs WHERE pipeline_id = ? ORDER BY spec_id`).all(pipelineId)
    : db.prepare(`SELECT * FROM column_specs ORDER BY spec_id`).all()) as any[];
  return rows.map(row2spec);
}

/** Repoint a spec at its owning pipeline once the pipeline row exists. */
export function setColumnSpecPipeline(specId: number, pipelineId: number, tableFqn?: string | null): void {
  getDb()
    .prepare(`UPDATE column_specs SET pipeline_id = ?, table_fqn = COALESCE(?, table_fqn), updated_at = ? WHERE spec_id = ?`)
    .run(pipelineId, tableFqn ?? null, sqliteNow(), specId);
}

/** Delete a spec row (lifecycle cleanup on column/pipeline delete). */
export function deleteColumnSpec(specId: number): void {
  getDb().prepare(`DELETE FROM column_specs WHERE spec_id = ?`).run(specId);
}

/**
 * Seed a spec's examples + pre-standardized values into the warehouse lookup as
 * confirmed self-mappings (literal_value === alias_name), scoped by specId.
 * Idempotent (MERGE / NOT EXISTS). Lifted verbatim from the old domains POST;
 * `did` is now the spec_id. Best-effort — throws on warehouse error so the
 * caller can decide how to surface it.
 */
export async function seedSpecValues(specId: number, valuesToSeed: string[]): Promise<void> {
  if (valuesToSeed.length === 0) return;
  await withWarehouse((conn) => seedSpecValuesOnConn(conn, specId, valuesToSeed));
}

/**
 * Same as seedSpecValues but reuses an already-open warehouse connection (for
 * callers, like pipeline creation, that are already inside a withWarehouse block
 * — avoids opening a second connection).
 */
export async function seedSpecValuesOnConn(conn: any, specId: number, valuesToSeed: string[]): Promise<void> {
  if (valuesToSeed.length === 0) return;
  {
    const did = specId;
    // Dedupe on the NORMALIZED form first (first occurrence wins): the
    // statement-level NOT EXISTS only guards against rows that existed before
    // the statement, so same-batch normalized duplicates ("AT&T" + "at&t ")
    // would otherwise both insert and break the one-row-per-normalized-value
    // assumption the lookup joins rely on.
    const seenNorm = new Set<string>();
    const seeded: string[] = [];
    for (const v of valuesToSeed) {
      const n = normalizeLiteral(v);
      if (!n || seenNorm.has(n)) continue;
      seenNorm.add(n);
      seeded.push(v);
    }

    // SQL Server: reuse the port's MERGE writers (HOLDLOCK, app-side
    // normalized_value, bind-budgeted batches). Update-on-match is a superset of
    // the NOT EXISTS guard — seeding stays idempotent.
    if (getWarehouseAdapter().kind === 'mssql') {
      const aliasIds = await bulkUpsertApprovedAliasesMssql(conn, seeded, did);
      await bulkUpsertLiteralMatchesMssql(
        conn,
        seeded.filter(v => aliasIds.has(v)).map(v => ({ literalValue: v, aliasId: aliasIds.get(v)! })),
        did, 0,
      );
      return;
    }
    // Postgres: same shape via the ON CONFLICT writers (app-side
    // normalized_value; upsert-on-match is a superset of the NOT EXISTS guard).
    if (getWarehouseAdapter().kind === 'postgres') {
      const aliasIds = await bulkUpsertApprovedAliasesPg(conn, seeded, did);
      await bulkUpsertLiteralMatchesPg(
        conn,
        seeded.filter(v => aliasIds.has(v)).map(v => ({ literalValue: v, aliasId: aliasIds.get(v)! })),
        did, 0,
      );
      return;
    }
    // MySQL: same shape via the row-alias ON DUPLICATE KEY writers.
    if (getWarehouseAdapter().kind === 'mysql') {
      const aliasIds = await bulkUpsertApprovedAliasesMysql(conn, seeded, did);
      await bulkUpsertLiteralMatchesMysql(
        conn,
        seeded.filter(v => aliasIds.has(v)).map(v => ({ literalValue: v, aliasId: aliasIds.get(v)! })),
        did, 0,
      );
      return;
    }

    const BATCH = 200;
    for (let i = 0; i < seeded.length; i += BATCH) {
      const batch = seeded.slice(i, i + BATCH);

      // 1. Ensure an alias row exists for every value (MERGE dedups).
      const namesSql = batch.map(() => '(?)').join(', ');
      await exec(conn,
        `MERGE INTO ${internalTable('APPROVED_ALIAS_NAMES')} AS t
         USING (SELECT DISTINCT column1 AS alias_name FROM VALUES ${namesSql}) AS s
           ON t.alias_name = s.alias_name AND t.domain_id = ?
         WHEN NOT MATCHED THEN INSERT (alias_name, domain_id)
           VALUES (s.alias_name, ?)`,
        [...batch, did, did]);

      // 2. Confirmed self-mappings (literal = alias name), skipping values whose
      //    normalized form is already mapped. normalized_value is precomputed in
      //    TS (UDFs are not allowed in VALUES clauses).
      const rowsSql = batch.map(() => '(?, ?)').join(', ');
      const rowBinds: any[] = [];
      for (const v of batch) rowBinds.push(v, normalizeLiteral(v));
      await exec(conn,
        `INSERT INTO ${internalTable('LITERAL_ALIAS_MATCHES')}
           (literal_value, normalized_value, alias_id, domain_id, run_id)
         SELECT v.column1, v.column2, a.alias_id, ?, 0
         FROM (SELECT DISTINCT column1, column2 FROM VALUES ${rowsSql}) v
         JOIN ${internalTable('APPROVED_ALIAS_NAMES')} a
           ON a.alias_name = v.column1 AND a.domain_id = ?
         WHERE NOT EXISTS (
           SELECT 1 FROM ${internalTable('LITERAL_ALIAS_MATCHES')} m
           WHERE m.normalized_value = v.column2 AND m.domain_id = ?
         )`,
        [did, ...rowBinds, did, did]);
    }
  }
}
