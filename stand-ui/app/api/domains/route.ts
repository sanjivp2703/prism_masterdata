import { cookies } from 'next/headers';
import { withSnowflake, snowflakeErrorResponse } from '@/app/api/_lib/snowflake';
import { decodeSession, SESSION_COOKIE_NAME } from '@/app/api/_lib/session';
import { sanitizeConventionRules, hasAnyRule } from '@/app/api/_lib/convention-rules';

async function exec(conn: any, sqlText: string, binds?: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText, binds,
      complete: (err: any, _s: any, rows: any[]) => (err ? reject(err) : resolve(rows || [])),
    });
  });
}

function row2domain(r: any) {
  return {
    domain_id:             Number(r.DOMAIN_ID   ?? r.domain_id),
    name:                  String(r.NAME        ?? r.name        ?? ''),
    description:           r.DESCRIPTION           ?? r.description           ?? null,
    standardization_rules: r.STANDARDIZATION_RULES ?? r.standardization_rules ?? null,
    convention_type:       r.CONVENTION_TYPE  ?? r.convention_type  ?? null,
    convention_value:      r.CONVENTION_VALUE ?? r.convention_value ?? null,
    convention_rules:      r.CONVENTION_RULES ?? r.convention_rules ?? null,
    usage_count:           Number(r.USAGE_COUNT ?? r.usage_count ?? 0),
    last_used_at:          r.LAST_USED_AT ?? r.last_used_at ?? null,
    created_at:            r.CREATED_AT  ?? r.created_at  ?? null,
  };
}

/**
 * GET /api/domains
 * Returns all domains sorted by recency then usage. No auth required beyond session.
 */
export async function GET() {
  try {
    return await withSnowflake(async (conn) => {
      const rows = await exec(
        conn,
        `SELECT domain_id, name, description, standardization_rules, convention_type, convention_value, convention_rules, usage_count, last_used_at, created_at
         FROM STAND_DB.STAND_INTERNAL.DOMAINS
         ORDER BY last_used_at DESC NULLS LAST,
                  usage_count   DESC,
                  name          ASC`,
      );
      return Response.json({ domains: rows.map(row2domain) });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to fetch domains');
  }
}

/**
 * POST /api/domains
 * Body: { name, convention_type?: 'regex'|'examples'|'natural', convention_value?: string }
 * Creates a new domain with an optional naming convention. Any authenticated user
 * can create one. When the convention is 'examples', each example is seeded into
 * the lookup as a confirmed self-mapping (literal_value === alias_name).
 */
export async function POST(request: Request) {
  const cookieStore = await cookies();
  const session = await decodeSession(cookieStore.get(SESSION_COOKIE_NAME)?.value ?? '');
  if (!session) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  const name = String(body?.name ?? '').trim();
  if (!name)             return Response.json({ error: 'name is required' }, { status: 400 });
  if (name.length > 500) return Response.json({ error: 'name too long (max 500 chars)' }, { status: 400 });

  // ── Naming convention (optional) ──────────────────────────────────────────
  const rawType = String(body?.convention_type ?? '').trim().toLowerCase();
  const conventionType: 'regex' | 'examples' | 'natural' | null =
    rawType === 'regex' || rawType === 'examples' || rawType === 'natural' ? rawType : null;
  const conventionValue = conventionType ? String(body?.convention_value ?? '').trim() : '';

  if (conventionType && !conventionValue) {
    return Response.json({ error: 'A naming convention value is required for the selected type.' }, { status: 400 });
  }
  if (conventionType === 'regex') {
    try { new RegExp(conventionValue); }
    catch { return Response.json({ error: 'The regex pattern is not valid.' }, { status: 400 }); }
  }
  // Parsed example list (one per non-empty line), used both as the stored value and to seed the lookup.
  const examples = conventionType === 'examples'
    ? conventionValue.split('\n').map(s => s.trim()).filter(Boolean)
    : [];
  if (conventionType === 'examples' && examples.length === 0) {
    return Response.json({ error: 'Provide at least one example (one per line).' }, { status: 400 });
  }
  const storedConventionValue = conventionType === 'examples' ? examples.join('\n') : (conventionType ? conventionValue : null);

  // Structured naming rules (case, spaces, suffixes, length, …) — independent of
  // the regex/examples/natural type; a domain can carry only rules.
  const conventionRules = sanitizeConventionRules(body?.convention_rules);
  const storedConventionRules = hasAnyRule(conventionRules) ? JSON.stringify(conventionRules) : null;

  // Description and free-text standardization rules
  const description = String(body?.description ?? '').trim() || null;
  const rawStdRules: string[] = Array.isArray(body?.standardization_rules)
    ? (body.standardization_rules as unknown[]).map(r => String(r).trim()).filter(Boolean)
    : [];
  const storedStdRules = rawStdRules.length > 0 ? JSON.stringify(rawStdRules) : null;

  try {
    return await withSnowflake(async (conn) => {
      // Check uniqueness before insert for a cleaner error message
      const existing = await exec(
        conn,
        `SELECT domain_id FROM STAND_DB.STAND_INTERNAL.DOMAINS WHERE name = ?`,
        [name],
      );
      if (existing.length > 0) {
        return Response.json({ error: `A domain named "${name}" already exists.` }, { status: 409 });
      }

      await exec(
        conn,
        `INSERT INTO STAND_DB.STAND_INTERNAL.DOMAINS (name, description, standardization_rules, convention_type, convention_value, convention_rules)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [name, description, storedStdRules, conventionType, storedConventionValue, storedConventionRules],
      );

      // name is UNIQUE — safe to fetch back by name
      const rows = await exec(
        conn,
        `SELECT domain_id, name, description, standardization_rules, convention_type, convention_value, convention_rules, usage_count, last_used_at, created_at
         FROM STAND_DB.STAND_INTERNAL.DOMAINS
         WHERE name = ?`,
        [name],
      );

      if (!rows.length) {
        return Response.json({ error: 'Domain was created but could not be retrieved.' }, { status: 500 });
      }
      const domain = row2domain(rows[0]);

      // Seed each example into the lookup as a confirmed self-mapping
      // (literal_value === alias_name) so it becomes an approved canonical name.
      if (examples.length > 0) {
        const did = domain.domain_id;
        for (const ex of examples) {
          await exec(conn,
            `INSERT INTO STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES (alias_name, domain_id)
             SELECT ?, ?
             WHERE NOT EXISTS (
               SELECT 1 FROM STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES
               WHERE alias_name = ? AND domain_id = ?
             )`,
            [ex, did, ex, did]);
          await exec(conn,
            `INSERT INTO STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES (literal_value, normalized_value, alias_id, domain_id, run_id)
             SELECT ?, PRISM_NORMALIZE(?), a.alias_id, ?, 0
             FROM STAND_DB.STAND_INTERNAL.APPROVED_ALIAS_NAMES a
             WHERE a.alias_name = ? AND a.domain_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM STAND_DB.STAND_INTERNAL.LITERAL_ALIAS_MATCHES m
                 WHERE m.normalized_value = PRISM_NORMALIZE(?) AND m.domain_id = ?
               )`,
            [ex, ex, did, ex, did, ex, did]);
        }
      }

      return Response.json({ domain }, { status: 201 });
    });
  } catch (err) {
    return snowflakeErrorResponse(err, 'Failed to create domain');
  }
}
