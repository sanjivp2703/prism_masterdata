import 'server-only';
import { requireAdminSession } from '@/app/api/_lib/account-security';
import { getOptionalEnv, isFreshSetupSim } from '@/app/api/_lib/env';
import { withWarehouse, serviceConnectionSource, executeQuery as exec, getWarehouseAdapter } from '@/app/api/_lib/warehouse';
import { getLlmProviderConfig } from '@/app/api/_lib/anthropic-key';

/**
 * Detail text for a failed install check.
 *
 * The raw driver message is genuinely useful here — this is the setup wizard,
 * and an admin needs to tell "wrong password" apart from "database missing".
 * But it is still a driver message going to a browser, and Snowflake/SQL Server
 * errors routinely embed SQL fragments and object paths (a live capture during
 * QA: "The SELECT permission was denied on the object 'sysjobs', database
 * 'msdb', schema 'dbo'"). Every other client-facing path routes through
 * warehouseErrorResponse for exactly this reason; these 11 sites bypassed it
 * (SEC-04).
 *
 * So: classify into a short, actionable sentence by default, and pass the raw
 * text through only when PRISM_DEBUG_TOOLS is on (operator installs only —
 * the same flag that gates /debug and the table inspector).
 */
function checkDetail(err: unknown): string {
  const raw = String((err as any)?.message ?? err ?? '').trim();
  if (getOptionalEnv('PRISM_DEBUG_TOOLS') === 'true') return raw;
  if (!raw) return 'The check could not be completed.';
  const m = raw.toLowerCase();
  if (/password|authenticat|login failed|jwt|incorrect username/.test(m)) {
    return 'The service credentials were rejected.';
  }
  if (/does not exist|not authorized|insufficient privileges|permission was denied|cannot find/.test(m)) {
    return 'Not found, or the service identity has no access to it.';
  }
  if (/timeout|timed ?out|etimedout|econnrefused|enotfound|ehostunreach|network|socket/.test(m)) {
    return 'Could not reach the warehouse.';
  }
  if (/warehouse|suspended|cannot be resumed|credit|quota/.test(m)) {
    return 'The warehouse is unavailable (suspended, or out of credits).';
  }
  return 'The check failed. Turn on PRISM_DEBUG_TOOLS to see the raw error.';
}


/**
 * GET /api/accounts/verify-install (admin only)
 *
 * Verifies the Snowflake-side install (00_bootstrap.sql + 01_internal_tables.sql)
 * as seen by the SERVICE connection, and returns a per-item checklist the setup
 * flow renders green/red. Every probe is a metadata-layer command (SHOW /
 * scalar SELECT) — none of them wakes a warehouse, consistent with the
 * project's cost rules.
 */

interface CheckItem {
  key:    string;
  label:  string;
  ok:     boolean;
  /** ok but with a caveat worth reading (e.g. slow auto-suspend). */
  warning?: string;
  detail?: string;
  /** What to do when not ok. */
  fix?:   string;
}

const field = (row: any, name: string) => row?.[name] ?? row?.[name.toUpperCase()] ?? row?.[name.toLowerCase()];

/** Names from a SHOW result, uppercased. */
const names = (rows: any[]) =>
  new Set(rows.map(r => String(field(r, 'name') ?? '').toUpperCase()).filter(Boolean));

const RERUN_FIX = 'Run 00_bootstrap.sql and 01_internal_tables.sql in a Snowflake worksheet as ACCOUNTADMIN, then verify again.';

/** Active AI provider credential present + accepted by that provider (free
 *  list-models call, provider-specific). */
async function checkAnthropicKey(): Promise<CheckItem> {
  const cfg = getLlmProviderConfig();
  const providerName = cfg.provider === 'openai' ? 'OpenAI'
    : cfg.provider === 'gemini' ? 'Gemini (Google)'
    : 'Claude (Anthropic)';
  const base = { key: 'anthropic', label: `AI provider connected and credential valid (${providerName})` };
  // Fresh-install sim: an env-provided key doesn't count as configured.
  const hidden = isFreshSetupSim() && cfg.source === 'env';
  const apiKey = hidden ? null : cfg.apiKey;
  if (!apiKey) {
    return { ...base, label: 'AI provider connected and credential valid', ok: false, fix: 'Connect an AI provider in the previous step (or set ANTHROPIC_API_KEY on the server).' };
  }
  const notes: string[] = [];
  if (cfg.source === 'env') notes.push('Using the server’s ANTHROPIC_API_KEY.');
  if (cfg.provider !== 'anthropic') notes.push(`Model: ${cfg.model ?? 'provider default'}.`);
  const sourceNote = notes.length ? notes.join(' ') : undefined;
  const probe = cfg.provider === 'openai'
    ? { url: 'https://api.openai.com/v1/models',
        headers: { 'Authorization': `Bearer ${apiKey}` } as Record<string, string> }
    : cfg.provider === 'gemini'
    ? { url: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
        headers: { 'Authorization': `Bearer ${apiKey}` } as Record<string, string> }
    : { url: 'https://api.anthropic.com/v1/models?limit=1',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } as Record<string, string> };
  try {
    const res = await fetch(probe.url, { headers: probe.headers });
    const bodyText = res.ok ? '' : await res.text().catch(() => '');

    // Match the sibling llm-provider route's predicate, not just 401/403.
    // Google answers HTTP 400 INVALID_ARGUMENT for a bad key and 429 for an
    // exhausted quota — neither is 401/403, so a definitively unusable Gemini
    // key was reported as a soft "could not be confirmed right now" WARNING and
    // the setup checklist told the admin things were probably fine. The two
    // surfaces had simply drifted; llm-provider already had this right.
    const isKeyRejection = res.status === 401 || res.status === 403
      || /invalid.*api.?key|api.?key.*invalid|INVALID_ARGUMENT/i.test(bodyText);
    if (isKeyRejection) {
      return { ...base, ok: false, detail: `${providerName} rejected the configured credential.`, fix: 'Re-enter the credential in the previous step.' };
    }
    // Quota exhaustion is also a definite failure, not an inconclusive probe —
    // the key is valid but cannot serve a standardization run today.
    if (res.status === 429) {
      return {
        ...base, ok: false,
        detail: `${providerName} accepted the credential but its request quota is exhausted.`,
        fix: `Enable billing (or raise the rate limit) on the ${providerName} account — Prism's standardization runs need more than a free-tier allowance.`,
      };
    }
    if (!res.ok) {
      return { ...base, ok: true, warning: `Credential is configured, but validation returned HTTP ${res.status} — it could not be confirmed right now.`, detail: sourceNote };
    }
    return { ...base, ok: true, detail: sourceNote };
  } catch {
    return { ...base, ok: true, warning: `Credential is configured, but ${providerName} could not be reached to confirm it.`, detail: sourceNote };
  }
}

export async function GET(request: Request) {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;

  // ?scope=install skips the AI-provider probe — used by the install step's
  // post-script spot check, where only the warehouse objects matter.
  //
  // It does NOT and never did select a warehouse: the branch is chosen from the
  // ACTIVE adapter (workspace_config.warehouse_type). The old name for this was
  // `scope=snowflake`, which read as "check the Snowflake side" and was sent
  // verbatim by the SQL SERVER install step — misleading enough that a tester
  // filed it as a bug (SET-M02). Live-confirmed at the time: scope=snowflake and
  // scope=mssql returned byte-identical check sets, differing only in whether
  // the AI probe was appended. `snowflake` is still accepted so an older client
  // doesn't silently start paying for a network probe mid-wizard.
  const scope = new URL(request.url).searchParams.get('scope');
  const skipAiProbe = scope === 'install' || scope === 'snowflake';

  const database = getOptionalEnv('SNOWFLAKE_DATABASE') ?? 'PRISM_DB';
  // Fresh-install sim: env-only credentials don't count — the flow must save
  // workspace credentials before verification can run, same as a real install.
  let source = serviceConnectionSource();
  if (isFreshSetupSim() && source === 'env') source = 'none';

  if (source === 'none') {
    return Response.json({
      ok: false,
      source,
      connected: false,
      error: 'No service credentials configured yet. Save them in the previous step first.',
      checks: [],
    });
  }

  const checks: CheckItem[] = [];
  // LIKE treats '_' as a single-char wildcard, so patterns over-match
  // (PRISM_DB also matches PRISMXDB); every check compares exact names from
  // the result rows instead of trusting the pattern.
  const likePattern = (s: string) => s.replace(/'/g, "''");

  // ── Postgres installs: catalog probes (port Phase P4) ─────────────────────
  if (getWarehouseAdapter().kind === 'postgres') {
    const PG_FIX = 'Run 01_internal_tables.postgres.sql with psql against the database, as a superuser, then verify again.';
    try {
      await withWarehouse(async (conn) => {
        try {
          // EXISTS over pg_auth_members instead of pg_has_role(): the scalar
          // function throws when the role doesn't exist, which would turn
          // "install script not run yet" into a failed identity probe.
          const rows = await exec(
            conn,
            `SELECT current_user AS login_name, current_database() AS db,
                    EXISTS (
                      SELECT 1 FROM pg_auth_members m
                      JOIN pg_roles r ON r.oid = m.roleid
                      JOIN pg_roles g ON g.oid = m.member
                      WHERE r.rolname = 'prism_service' AND g.rolname = current_user
                    ) AS is_member`,
          );
          const login = String(field(rows[0] ?? {}, 'login_name') ?? '');
          const isMember = Boolean(field(rows[0] ?? {}, 'is_member'));
          checks.push({
            key: 'role',
            label: 'Connection runs as the service identity',
            ok: Boolean(login),
            ...(login && !isMember
              ? { warning: `Role ${login} is not a member of prism_service. That can work (e.g. a superuser in dev), but prism_service is the audited least-privilege identity.` }
              : {}),
            detail: login ? `Connected as: ${login}` : 'Could not read the session role.',
            fix: login ? undefined : 'Check the saved credentials.',
          });
        } catch (err) {
          checks.push({ key: 'role', label: 'Connection runs as the service identity', ok: false, detail: checkDetail(err), fix: 'Check the saved credentials.' });
        }

        try {
          // One-database scope is the pg install model — surface WHICH database
          // this installation standardizes (docs/POSTGRES_PORT_PLAN.md §2.1).
          const rows = await exec(conn, `SELECT current_database() AS db`);
          const dbName = String(field(rows[0] ?? {}, 'db') ?? '');
          checks.push({
            key: 'database',
            label: 'Connected to the installation database',
            ok: Boolean(dbName),
            detail: dbName ? `Database: ${dbName} — one Prism installation standardizes one Postgres database.` : undefined,
            fix: dbName ? undefined : 'Check the saved credentials.',
          });
        } catch (err) {
          checks.push({ key: 'database', label: 'Connected to the installation database', ok: false, detail: checkDetail(err), fix: 'Check the saved credentials.' });
        }

        try {
          // pg_namespace, not information_schema.schemata — the latter only
          // lists schemas the current role owns or can use, so a permission
          // problem would masquerade as "schema missing".
          const rows = await exec(conn, `SELECT nspname AS name FROM pg_catalog.pg_namespace WHERE nspname IN ('prism_internal', 'prism_exports')`);
          const have = new Set(rows.map((r) => String(field(r, 'name')).toLowerCase()));
          const ok = have.has('prism_internal') && have.has('prism_exports');
          checks.push({
            key: 'schemas', label: 'Schemas prism_internal and prism_exports exist', ok,
            detail: ok ? undefined : `Visible schemas: ${[...have].join(', ') || 'none'}`,
            fix: ok ? undefined : PG_FIX,
          });
        } catch (err) {
          checks.push({ key: 'schemas', label: 'Schemas prism_internal and prism_exports exist', ok: false, detail: checkDetail(err), fix: PG_FIX });
        }

        const EXPECTED_TABLES = ['pipeline_queue', 'approved_alias_names', 'literal_alias_matches', 'one_time_file_rows', 'run_state', 'validation_log'];
        try {
          const rows = await exec(
            conn,
            `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'prism_internal'`,
          );
          const have = new Set(rows.map((r) => String(field(r, 'name')).toLowerCase()));
          const missing = EXPECTED_TABLES.filter((t) => !have.has(t));
          checks.push({
            key: 'tables', label: 'Internal tables exist (6 expected)', ok: missing.length === 0,
            detail: missing.length ? `Missing: ${missing.join(', ')}` : undefined,
            fix: missing.length ? PG_FIX : undefined,
          });
        } catch (err) {
          checks.push({ key: 'tables', label: 'Internal tables exist (6 expected)', ok: false, detail: checkDetail(err), fix: PG_FIX });
        }

        try {
          const EXPECTED_ROLES = ['prism_service', 'prism_data_admin', 'prism_readonly'];
          // pg_roles is world-readable — no metadata-visibility trap here.
          const rows = await exec(conn, `SELECT rolname AS name FROM pg_roles WHERE rolname IN ('prism_service', 'prism_data_admin', 'prism_readonly')`);
          const have = new Set(rows.map((r) => String(field(r, 'name')).toLowerCase()));
          const found = EXPECTED_ROLES.filter((r) => have.has(r));
          const ok = found.length === EXPECTED_ROLES.length;
          checks.push({
            key: 'roles', label: 'Prism roles exist', ok,
            detail: `Found: ${found.join(', ') || 'none'}`,
            fix: ok ? undefined : PG_FIX,
          });
        } catch (err) {
          checks.push({ key: 'roles', label: 'Prism roles exist', ok: false, detail: checkDetail(err), fix: PG_FIX });
        }

        // Normalization is app-side on Postgres — nothing to verify in-database.
        checks.push({
          key: 'normalize',
          label: 'Value normalization (app-side on PostgreSQL)',
          ok: true,
          detail: 'Postgres installs normalize values in the app — no database function is required.',
        });
      });
    } catch (err) {
      return Response.json({
        ok: false, source, connected: false,
        error: 'Could not connect to PostgreSQL with the saved service credentials.',
        detail: checkDetail(err),
        checks,
      });
    }

    if (!skipAiProbe) checks.push(await checkAnthropicKey());
    const allOk = checks.every((c) => c.ok);
    return Response.json({ ok: allOk, source, connected: true, warehouse_type: 'postgres', checks });
  }

  // ── MySQL installs: catalog probes (port Phase M4) ────────────────────────
  if (getWarehouseAdapter().kind === 'mysql') {
    const MY_FIX = 'Run 01_internal_tables.mysql.sql with the mysql client as an admin account, then verify again.';
    try {
      await withWarehouse(async (conn) => {
        try {
          const rows = await exec(conn, `SELECT CURRENT_USER() AS login_name`);
          const login = String(field(rows[0] ?? {}, 'login_name') ?? '');
          checks.push({
            key: 'role',
            label: 'Connection runs as the service identity',
            ok: Boolean(login),
            detail: login ? `Connected as: ${login}` : 'Could not read the session account.',
            fix: login ? undefined : 'Check the saved credentials.',
          });
        } catch (err) {
          checks.push({ key: 'role', label: 'Connection runs as the service identity', ok: false, detail: checkDetail(err), fix: 'Check the saved credentials.' });
        }

        try {
          // On MySQL these are DATABASES (no schema level) — and NOT a scope:
          // sources may live in any database on the server the service
          // account can read (docs/MYSQL_PORT_PLAN.md §2.1).
          const rows = await exec(
            conn,
            `SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN ('prism_internal', 'prism_exports')`,
          );
          const have = new Set(rows.map((r) => String(field(r, 'name')).toLowerCase()));
          const ok = have.has('prism_internal') && have.has('prism_exports');
          checks.push({
            key: 'schemas', label: 'Databases prism_internal and prism_exports exist', ok,
            detail: ok ? undefined : `Visible: ${[...have].join(', ') || 'none'}`,
            fix: ok ? undefined : MY_FIX,
          });
        } catch (err) {
          checks.push({ key: 'schemas', label: 'Databases prism_internal and prism_exports exist', ok: false, detail: checkDetail(err), fix: MY_FIX });
        }

        const EXPECTED_TABLES = ['pipeline_queue', 'approved_alias_names', 'literal_alias_matches', 'one_time_file_rows', 'run_state', 'validation_log'];
        try {
          const rows = await exec(
            conn,
            `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'prism_internal'`,
          );
          const have = new Set(rows.map((r) => String(field(r, 'name')).toLowerCase()));
          const missing = EXPECTED_TABLES.filter((t) => !have.has(t));
          checks.push({
            key: 'tables', label: 'Internal tables exist (6 expected)', ok: missing.length === 0,
            detail: missing.length ? `Missing: ${missing.join(', ')}` : undefined,
            fix: missing.length ? MY_FIX : undefined,
          });
        } catch (err) {
          checks.push({ key: 'tables', label: 'Internal tables exist (6 expected)', ok: false, detail: checkDetail(err), fix: MY_FIX });
        }

        try {
          // mysql.role_edges needs SELECT on the mysql system database, which
          // the least-privilege service account typically lacks. A denied read
          // is a WARNING, never red: role membership is already proven
          // operationally — this session's grants come from prism_service.
          const EXPECTED_ROLES = ['prism_service', 'prism_data_admin', 'prism_readonly'];
          const rows = await exec(
            conn,
            `SELECT DISTINCT from_user AS name FROM mysql.role_edges WHERE from_user IN ('prism_service', 'prism_data_admin', 'prism_readonly')`,
          );
          const have = new Set(rows.map((r) => String(field(r, 'name')).toLowerCase()));
          const found = EXPECTED_ROLES.filter((r) => have.has(r));
          const ok = found.length === EXPECTED_ROLES.length;
          checks.push({
            key: 'roles', label: 'Prism roles exist', ok,
            detail: `Found: ${found.join(', ') || 'none'}`,
            fix: ok ? undefined : MY_FIX,
          });
        } catch (err) {
          checks.push({
            key: 'roles', label: 'Prism roles exist', ok: true,
            warning: 'Could not read the role catalog (needs SELECT on mysql.*). Membership is implied by this connection working under prism_service grants.',
            detail: checkDetail(err),
          });
        }

        // Normalization is app-side on MySQL — nothing to verify in-database.
        checks.push({
          key: 'normalize',
          label: 'Value normalization (app-side on MySQL)',
          ok: true,
          detail: 'MySQL installs normalize values in the app — no database function is required.',
        });
      });
    } catch (err) {
      return Response.json({
        ok: false, source, connected: false,
        error: 'Could not connect to MySQL with the saved service credentials.',
        detail: checkDetail(err),
        checks,
      });
    }

    if (!skipAiProbe) checks.push(await checkAnthropicKey());
    const allOk = checks.every((c) => c.ok);
    return Response.json({ ok: allOk, source, connected: true, warehouse_type: 'mysql', checks });
  }

  // ── SQL Server installs: catalog-view probes (port Phase 6) ────────────────
  if (getWarehouseAdapter().kind === 'mssql') {
    try {
      await withWarehouse(async (conn) => {
        const MSSQL_FIX = 'Run 01_internal_tables.mssql.sql against the SQL Server as a sysadmin, then verify again.';

        try {
          const rows = await exec(conn, `SELECT SUSER_SNAME() AS login_name, IS_ROLEMEMBER('PRISM_SERVICE') AS is_member`);
          const login = String(field(rows[0] ?? {}, 'login_name') ?? '');
          const isMember = Number(field(rows[0] ?? {}, 'is_member') ?? 0) === 1;
          checks.push({
            key: 'role',
            label: 'Connection runs as the service identity',
            ok: Boolean(login),
            ...(login && !isMember
              ? { warning: `Login ${login} is not a member of the PRISM_SERVICE database role. That can work (e.g. sysadmin in dev), but PRISM_SERVICE is the audited least-privilege identity.` }
              : {}),
            detail: login ? `Connected as: ${login}` : 'Could not read the session login.',
            fix: login ? undefined : 'Check the saved credentials.',
          });
        } catch (err) {
          checks.push({ key: 'role', label: 'Connection runs as the service identity', ok: false, detail: checkDetail(err), fix: 'Check the saved credentials.' });
        }

        try {
          const rows = await exec(conn, `SELECT DB_ID('PRISM_DB') AS db_id`);
          const ok = field(rows[0] ?? {}, 'db_id') != null;
          checks.push({ key: 'database', label: 'Database PRISM_DB exists and is visible', ok, fix: ok ? undefined : MSSQL_FIX });
        } catch (err) {
          checks.push({ key: 'database', label: 'Database PRISM_DB exists and is visible', ok: false, detail: checkDetail(err), fix: MSSQL_FIX });
        }

        try {
          const rows = await exec(conn, `SELECT name FROM PRISM_DB.sys.schemas WHERE name IN ('INTERNAL', 'EXPORTS')`);
          const have = new Set(rows.map((r) => String(field(r, 'name')).toUpperCase()));
          const ok = have.has('INTERNAL') && have.has('EXPORTS');
          checks.push({
            key: 'schemas', label: 'Schemas INTERNAL and EXPORTS exist', ok,
            detail: ok ? undefined : `Visible schemas: ${[...have].join(', ') || 'none'}`,
            fix: ok ? undefined : MSSQL_FIX,
          });
        } catch (err) {
          checks.push({ key: 'schemas', label: 'Schemas INTERNAL and EXPORTS exist', ok: false, detail: checkDetail(err), fix: MSSQL_FIX });
        }

        const EXPECTED_TABLES = ['PIPELINE_QUEUE', 'APPROVED_ALIAS_NAMES', 'LITERAL_ALIAS_MATCHES', 'ONE_TIME_FILE_ROWS', 'RUN_STATE', 'VALIDATION_LOG'];
        try {
          const rows = await exec(
            conn,
            `SELECT t.name FROM PRISM_DB.sys.tables t
             JOIN PRISM_DB.sys.schemas s ON s.schema_id = t.schema_id
             WHERE s.name = 'INTERNAL'`,
          );
          const have = new Set(rows.map((r) => String(field(r, 'name')).toUpperCase()));
          const missing = EXPECTED_TABLES.filter((t) => !have.has(t));
          checks.push({
            key: 'tables', label: 'Internal tables exist (6 expected)', ok: missing.length === 0,
            detail: missing.length ? `Missing: ${missing.join(', ')}` : undefined,
            fix: missing.length ? MSSQL_FIX : undefined,
          });
        } catch (err) {
          checks.push({ key: 'tables', label: 'Internal tables exist (6 expected)', ok: false, detail: checkDetail(err), fix: MSSQL_FIX });
        }

        try {
          // DATABASE_PRINCIPAL_ID(name), not a sys.database_principals SELECT:
          // SQL Server's metadata-visibility rules mean a login can only
          // enumerate roles it's a MEMBER of — the service login is only a
          // member of PRISM_SERVICE, so a `WHERE type = 'R'` scan would always
          // under-report the other two roles as "missing" even when they
          // exist. The scalar function checks a specific named principal
          // directly and isn't subject to that restriction (the install
          // script's own `IF DATABASE_PRINCIPAL_ID(...) IS NULL` guards rely
          // on the same fact).
          const EXPECTED_ROLES = ['PRISM_SERVICE', 'PRISM_DATA_ADMIN', 'PRISM_READONLY'];
          const rows = await exec(
            conn,
            `SELECT DATABASE_PRINCIPAL_ID('PRISM_SERVICE') AS PRISM_SERVICE,
                    DATABASE_PRINCIPAL_ID('PRISM_DATA_ADMIN') AS PRISM_DATA_ADMIN,
                    DATABASE_PRINCIPAL_ID('PRISM_READONLY') AS PRISM_READONLY`,
          );
          const row = rows[0] ?? {};
          const found = EXPECTED_ROLES.filter((r) => field(row, r) != null);
          const ok = found.length === EXPECTED_ROLES.length;
          checks.push({
            key: 'roles', label: 'Prism database roles exist', ok,
            detail: `Found: ${found.join(', ') || 'none'}`,
            fix: ok ? undefined : MSSQL_FIX,
          });
        } catch (err) {
          checks.push({ key: 'roles', label: 'Prism database roles exist', ok: false, detail: checkDetail(err), fix: MSSQL_FIX });
        }

        // Change Tracking — INFORMATIONAL, never a hard failure.
        //
        // Specified by docs/MSSQL_PORT_PLAN.md Phase 6 but never implemented, so
        // CT status only ever surfaced later and per-table via /api/columns'
        // ct_status — the admin got no setup-time confirmation that Part C
        // ("enable Change Tracking on the source database") had actually worked
        // (SET-M04). Step 5 doesn't know the customer's source database yet, so
        // list every CT-enabled database this login can see.
        //
        // ok:true regardless: CT is an optimisation, not a requirement. Without
        // it Prism falls back to tiered diff scans, which work — just slower.
        // Failing the install over a missing optimisation would be wrong.
        try {
          const ctRows = await exec(conn,
            `SELECT DB_NAME(database_id) AS name FROM sys.change_tracking_databases`);
          const names = ctRows.map((r: any) => String(r.name ?? r.NAME ?? '')).filter(Boolean);
          checks.push({
            key: 'change_tracking',
            label: 'Change Tracking (optional — faster detection)',
            ok: true,
            detail: names.length
              ? `Enabled on: ${names.join(', ')}`
              : 'Not enabled on any database this login can see. Pipelines will use scheduled scans instead, which work but are slower. To enable it later: ALTER DATABASE <db> SET CHANGE_TRACKING = ON;',
          });
        } catch (err) {
          checks.push({
            key: 'change_tracking',
            label: 'Change Tracking (optional — faster detection)',
            ok: true,
            detail: `Could not read Change Tracking status — ${checkDetail(err)} Pipelines will use scheduled scans if it is unavailable.`,
          });
        }

        // Normalization is app-side on SQL Server — nothing to verify in-database.
        checks.push({
          key: 'normalize',
          label: 'Value normalization (app-side on SQL Server)',
          ok: true,
          detail: 'SQL Server installs normalize values in the app — no database function is required.',
        });
      });
    } catch (err) {
      return Response.json({
        ok: false, source, connected: false,
        error: 'Could not connect to SQL Server with the saved service credentials.',
        detail: checkDetail(err),
        checks,
      });
    }

    if (!skipAiProbe) checks.push(await checkAnthropicKey());
    const allOk = checks.every((c) => c.ok);
    return Response.json({ ok: allOk, source, connected: true, warehouse_type: 'mssql', checks });
  }

  try {
    await withWarehouse(async (conn) => {
      // Session identity — which role/warehouse the service connection actually
      // activated (a bad role name can be silently ignored by some auth paths).
      let currentRole = '';
      let sessionWarehouse = '';
      try {
        const rows = await exec(conn, `SELECT CURRENT_ROLE() AS r, CURRENT_WAREHOUSE() AS w`);
        currentRole      = String(field(rows[0] ?? {}, 'r') ?? '');
        sessionWarehouse = String(field(rows[0] ?? {}, 'w') ?? '');
      } catch { /* covered by the checks below */ }

      checks.push({
        key: 'role',
        label: 'Connection runs as the service role',
        ok: Boolean(currentRole),
        ...(currentRole && currentRole.toUpperCase() !== 'PRISM_SERVICE'
          ? { warning: `Running as role ${currentRole}, not PRISM_SERVICE. That works, but PRISM_SERVICE is the audited least-privilege identity.` }
          : {}),
        detail: currentRole ? `Current role: ${currentRole}` : 'Could not read the session role.',
        fix: currentRole ? undefined : 'Check the saved credentials and role name.',
      });

      // Database visibility (visibility via SHOW implies USAGE).
      try {
        const rows = await exec(conn, `SHOW DATABASES LIKE '${likePattern(database)}'`);
        const ok = names(rows).has(database.toUpperCase());
        checks.push({
          key: 'database',
          label: `Database ${database} exists and is visible`,
          ok,
          fix: ok ? undefined : RERUN_FIX,
        });
      } catch (err) {
        checks.push({ key: 'database', label: `Database ${database} exists and is visible`, ok: false, detail: checkDetail(err), fix: RERUN_FIX });
      }

      // Schemas.
      try {
        const rows = await exec(conn, `SHOW SCHEMAS IN DATABASE "${database.replace(/"/g, '""')}"`);
        const have = names(rows);
        const ok = have.has('INTERNAL') && have.has('PUBLIC');
        checks.push({
          key: 'schemas',
          label: 'Schemas INTERNAL and PUBLIC exist',
          ok,
          detail: ok ? undefined : `Visible schemas: ${[...have].join(', ') || 'none'}`,
          fix: ok ? undefined : RERUN_FIX,
        });
      } catch (err) {
        checks.push({ key: 'schemas', label: 'Schemas INTERNAL and PUBLIC exist', ok: false, detail: checkDetail(err), fix: RERUN_FIX });
      }

      // Tables. SHOW TABLES only lists tables the role has some privilege on,
      // so a green here also confirms the grants block ran.
      const REQUIRED_TABLES = ['APPROVED_ALIAS_NAMES', 'LITERAL_ALIAS_MATCHES', 'PIPELINE_QUEUE', 'ONE_TIME_FILE_ROWS', 'RUN_STATE', 'VALIDATION_LOG'];
      try {
        const rows = await exec(conn, `SHOW TABLES IN SCHEMA "${database.replace(/"/g, '""')}".INTERNAL`);
        const have = names(rows);
        const missing = REQUIRED_TABLES.filter(t => !have.has(t));
        checks.push({
          key: 'tables',
          label: 'Internal tables exist and are accessible',
          ok: missing.length === 0,
          detail: missing.length ? `Missing or not granted: ${missing.join(', ')}` : undefined,
          fix: missing.length ? RERUN_FIX : undefined,
        });
      } catch (err) {
        checks.push({ key: 'tables', label: 'Internal tables exist and are accessible', ok: false, detail: checkDetail(err), fix: RERUN_FIX });
      }

      // PRISM_NORMALIZE UDF.
      try {
        const rows = await exec(conn, `SHOW USER FUNCTIONS IN SCHEMA "${database.replace(/"/g, '""')}".INTERNAL`);
        const ok = names(rows).has('PRISM_NORMALIZE');
        checks.push({
          key: 'udf',
          label: 'PRISM_NORMALIZE function exists and is granted',
          ok,
          fix: ok ? undefined : RERUN_FIX,
        });
      } catch (err) {
        checks.push({ key: 'udf', label: 'PRISM_NORMALIZE function exists and is granted', ok: false, detail: checkDetail(err), fix: RERUN_FIX });
      }

      // Warehouse: existence + auto-suspend (connecting with a nonexistent
      // warehouse succeeds — it's only a session default — so check for real).
      const expectedWh = sessionWarehouse || 'PRISM_WH';
      try {
        const rows = await exec(conn, `SHOW WAREHOUSES LIKE '${likePattern(expectedWh)}'`);
        const wh = rows.find(r => String(field(r, 'name') ?? '').toUpperCase() === expectedWh.toUpperCase());
        if (!wh) {
          checks.push({
            key: 'warehouse',
            label: `Warehouse ${expectedWh} exists and is usable`,
            ok: false,
            fix: RERUN_FIX,
          });
        } else {
          const autoSuspend = Number(field(wh, 'auto_suspend') ?? NaN);
          let warning: string | undefined;
          if (!Number.isFinite(autoSuspend) || autoSuspend <= 0) {
            warning = 'This warehouse never auto-suspends — it will bill continuously. Prism recommends AUTO_SUSPEND = 60.';
          } else if (autoSuspend > 60) {
            warning = `Auto-suspends after ${autoSuspend}s of inactivity; 60s is recommended to minimize cost.`;
          }
          checks.push({
            key: 'warehouse',
            label: `Warehouse ${expectedWh} exists and is usable`,
            ok: true,
            ...(warning ? { warning } : {}),
          });
        }
      } catch (err) {
        checks.push({ key: 'warehouse', label: `Warehouse ${expectedWh} exists and is usable`, ok: false, detail: checkDetail(err), fix: RERUN_FIX });
      }
    });
  } catch (err) {
    // Couldn't even open the service connection. Still report the Anthropic
    // check so the failure list is complete.
    console.error('[verify-install] service connection failed:', err);
    return Response.json({
      ok: false,
      source,
      connected: false,
      error: 'Could not connect to Snowflake with the service credentials. Check the previous step.',
      checks: skipAiProbe ? [] : [await checkAnthropicKey()],
    });
  }

  if (!skipAiProbe) checks.push(await checkAnthropicKey());

  return Response.json({
    ok: checks.every(c => c.ok),
    source,
    connected: true,
    // Always state which platform was actually verified. The branch above is
    // chosen by the ACTIVE adapter, not by the caller, so a caller that assumes
    // it got its own platform's checks can otherwise pass green off the wrong
    // platform's (non-overlapping) check keys.
    warehouse_type: 'snowflake',
    checks,
  });
}
