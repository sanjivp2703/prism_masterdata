/**
 * Warehouse parity tests — pure-logic checks that run with NO live database.
 *
 *   npm run test:parity
 *
 * Purpose (docs/MSSQL_PORT_PLAN.md, Phase 2): the highest-risk drift in the
 * warehouse layer is between implementations of the SAME logic that must agree
 * exactly. Today that is normalizeLiteral (TypeScript) vs the PRISM_NORMALIZE
 * Snowflake JavaScript UDF — a silent mismatch breaks lookup matching with no
 * error anywhere. This script extracts the UDF body from 01_internal_tables.sql
 * and runs both implementations over a fixture corpus.
 *
 * As the SQL Server adapter lands (Phase 3+), dialect tests join this file:
 * SQL text generation per warehouse, identifier quoting, FQN parsing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLiteral, sqlStringLiteral } from '../app/api/_lib/normalize';
import { asExportKind, standardizedColumnName, assertCompanionColumnSafe } from '../app/api/_lib/export-kind';
import { isProbablyCatastrophicRegex } from '../app/api/_lib/convention-rules';
import { detectHeaderRow, columnLetter } from '../app/api/_lib/table-shape';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
  }
}

// ── Extract the PRISM_NORMALIZE UDF body from the install script ────────────
const sqlPath = path.join(repoRoot, '01_internal_tables.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');
const udfMatch = sql.match(
  /CREATE OR REPLACE FUNCTION PRISM_DB\.INTERNAL\.PRISM_NORMALIZE\(V STRING\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/,
);
if (!udfMatch) {
  console.error('FAIL: could not find the PRISM_NORMALIZE UDF in 01_internal_tables.sql');
  process.exit(1);
}
// Snowflake JS UDFs run the body with the argument bound to V.
const udfNormalize = new Function('V', udfMatch[1]) as (v: unknown) => string | null;

// ── normalizeLiteral ⇄ PRISM_NORMALIZE parity ───────────────────────────────
console.log('normalizeLiteral vs PRISM_NORMALIZE UDF (extracted from 01_internal_tables.sql):');

const corpus: string[] = [
  'AT&T',
  'AT&T ',
  '  at&t',
  'a t and t',
  'T-Mobile',
  'VERIZON WIRELESS',
  'verizon\twireless',            // tab collapses to single space
  'verizon\n wireless',           // newline + space run
  'caf\u00E9',                  // e-acute precomposed (NFC)
  'cafe\u0301',                 // e + combining accent (NFD) - must equal the NFC form
  '\u212B',                     // angstrom sign - NFC-normalizes to U+00C5
  'foo\u0001bar',               // C0 control char stripped
  'foo\u007Fbar',               // DEL stripped
  'foo\u0085bar',               // C1 control char (NEL) stripped
  '   ',                          // whitespace-only -> empty
  '',
  '\u00FCn\u00EFcode \u00C7ASE', // unicode case folding
  'multi   space   runs',
  '\u65E5\u672C\u8A9E \u30C6\u30B9\u30C8', // Japanese text
  'emoji \u{1F680} value',       // rocket emoji passes through
  'trailing\u00A0nbsp',          // NBSP is whitespace in JS regex -> collapsed/trimmed
];

for (const value of corpus) {
  check(JSON.stringify(value), normalizeLiteral(value), udfNormalize(value));
}

// Known, deliberate divergence at the null boundary: SQL represents "no value"
// as NULL; the app side as ''. Encode it so an accidental change trips a test.
console.log('null-boundary semantics (deliberately different):');
check('UDF(null) is null', udfNormalize(null), null);
check("normalizeLiteral(null) is ''", normalizeLiteral(null), '');
check("normalizeLiteral(undefined) is ''", normalizeLiteral(undefined), '');

// ── sqlStringLiteral escaping ────────────────────────────────────────────────
console.log('sqlStringLiteral:');
check('plain string unchanged', sqlStringLiteral('Company Name'), 'Company Name');
check('single quote escaped', sqlStringLiteral("O'Brien"), "O\\'Brien");
check('backslash escaped first', sqlStringLiteral('a\\b'), 'a\\\\b');
check(
  'trailing backslash cannot break out',
  sqlStringLiteral("foo\\"),
  'foo\\\\',
);
check(
  'backslash-then-quote fully escaped',
  sqlStringLiteral("foo\\'"),
  "foo\\\\\\'",
);

// ── SQL Server dialect helpers ───────────────────────────────────────────────
import {
  quoteIdent as msQuote, parseFqn as msParseFqn, translateBinds, isServerlessAzureTier,
  computeScanTier, retuneScanTier, classifyMssqlPollError,
} from '../app/api/_lib/warehouse/mssql/dialect';

console.log('mssql dialect — quoteIdent:');
check('plain name', msQuote('Company Name'), '[Company Name]');
check('closing bracket doubled', msQuote('weird]name'), '[weird]]name]');
check('control char rejected', (() => { try { msQuote('a' + String.fromCharCode(1) + 'b'); return 'no-throw'; } catch { return 'threw'; } })(), 'threw');

console.log('mssql dialect — parseFqn:');
check('three parts', JSON.stringify(msParseFqn('PRISM_DB.INTERNAL.PIPELINE_QUEUE')), JSON.stringify({ db: 'PRISM_DB', schema: 'INTERNAL', table: 'PIPELINE_QUEUE' }));
check('two parts rejected', (() => { try { msParseFqn('A.B'); return 'no-throw'; } catch { return 'threw'; } })(), 'threw');

console.log('mssql dialect — translateBinds (? -> @pN, quote/comment-aware):');
{
  const r = translateBinds('SELECT * FROM t WHERE a = ? AND b = ?');
  check('two binds text', r.text, 'SELECT * FROM t WHERE a = @p1 AND b = @p2');
  check('two binds count', r.count, 2);
}
{
  const r = translateBinds("SELECT 'lit?eral', c FROM t WHERE d = ?");
  check('? inside string untouched', r.text, "SELECT 'lit?eral', c FROM t WHERE d = @p1");
  check('string-case count', r.count, 1);
}
{
  const r = translateBinds("SELECT 'it''s ?', ? FROM t");
  check('escaped quote handled', r.text, "SELECT 'it''s ?', @p1 FROM t");
}
{
  const r = translateBinds('SELECT [odd?col] FROM t WHERE x = ? -- trailing ? comment');
  check('bracket ident + line comment untouched', r.text, 'SELECT [odd?col] FROM t WHERE x = @p1 -- trailing ? comment');
}
{
  const r = translateBinds('/* block ? comment */ SELECT ?');
  check('block comment untouched', r.text, '/* block ? comment */ SELECT @p1');
}
{
  const r = translateBinds('SELECT "quoted?ident" WHERE y = ?');
  check('double-quoted ident untouched', r.text, 'SELECT "quoted?ident" WHERE y = @p1');
}

{
  console.log('mssql dialect — diff-scan tiers:');
  check('small table scans every pass', computeScanTier(500_000), 1);
  check('medium table every 2nd pass', computeScanTier(10_000_000), 2);
  check('huge table every 10th pass', computeScanTier(100_000_000), 10);
  check('serverless multiplies (capped 60)', computeScanTier(100_000_000, true), 60);
  check('fast scan earns every-pass tier', retuneScanTier(200), 1);
  check('slow scan backs off', retuneScanTier(20_000), 10);
  console.log('mssql dialect — classifyMssqlPollError:');
  check('login failed → global', classifyMssqlPollError({ number: 18456 }), 'global');
  check('invalid object → table', classifyMssqlPollError({ number: 208 }), 'table');
  check('socket reset → transient', classifyMssqlPollError({ code: 'ECONNRESET' }), 'transient');
  check('unknown → transient', classifyMssqlPollError(new Error('weird')), 'transient');
  check('CT not enabled (22105) → ct_reset', classifyMssqlPollError({ number: 22105 }), 'ct_reset');
  check('CT not enabled by message → ct_reset', classifyMssqlPollError(new Error("Change tracking is not enabled on table 'dbo.Foo'.")), 'ct_reset');
}

console.log('mssql dialect — isServerlessAzureTier:');
check('GP_S serverless', isServerlessAzureTier('GP_S_Gen5_2'), true);
check('HS_S serverless', isServerlessAzureTier('HS_S_Gen5_4'), true);
check('GP provisioned', isServerlessAzureTier('GP_Gen5_2'), false);
check('DTU tier', isServerlessAzureTier('S0'), false);
check('null (on-prem)', isServerlessAzureTier(null), false);

console.log('export-kind — asExportKind / standardizedColumnName:');
check('view preserved', asExportKind('view'), 'view');
check('column preserved', asExportKind('column'), 'column');
check('table preserved', asExportKind('table'), 'table');
check('unknown → table', asExportKind('weird'), 'table');
check('undefined → table', asExportKind(undefined), 'table');
check('null → table', asExportKind(null), 'table');
// Both warehouse column-sync implementations derive the companion column from
// this ONE helper — its shape is a customer-facing promise (shown in setup copy).
check('companion column name', standardizedColumnName('CARRIER'), 'CARRIER_STANDARDIZED');
check('companion name keeps spaces/case', standardizedColumnName('Company Name'), 'Company Name_STANDARDIZED');

// Guardrail: column mode may only ever write a watched column's companion —
// never a raw source column, never an arbitrary name (docs/PRELAUNCH_CHECKLIST.md §1).
const trips = (target: string, watched: string[]) => {
  try { assertCompanionColumnSafe(target, watched); return 'allowed'; } catch { return 'blocked'; }
};
console.log('export-kind — assertCompanionColumnSafe:');
check('companion of watched column allowed', trips('CARRIER_STANDARDIZED', ['CARRIER']), 'allowed');
check('case-insensitive companion allowed', trips('carrier_standardized', ['CARRIER']), 'allowed');
check('raw watched column blocked', trips('CARRIER', ['CARRIER']), 'blocked');
check('arbitrary column blocked', trips('AMOUNT', ['CARRIER']), 'blocked');
check('other pipeline companion-shaped name blocked', trips('AMOUNT_STANDARDIZED', ['CARRIER']), 'blocked');
check('companion colliding with a watched raw column blocked',
  trips('CARRIER_STANDARDIZED', ['CARRIER', 'CARRIER_STANDARDIZED']), 'blocked');

// ── Header-row detection (KI-219) ────────────────────────────────────────────
// Prism used to take row 1 as the header unconditionally. The first fixture is
// the REAL customer sheet that exposed it: a narrow summary row, three blank
// rows, then the actual header on row 5. Prism built a pipeline over "Number
// Sent"/"77"/"Number Emailed"/"54" — two of them bare numbers — and never
// offered the columns the user wanted.
console.log('\nheader-row detection:');
const hdr = (grid: unknown[][]) => detectHeaderRow(grid).headerRow;

check('customer sheet — header on row 5 (index 4)', hdr([
  ['Number Sent', '77', 'Number Emailed', '54'],
  [], [], [],
  ['Company', 'Description', 'Contact Name', 'Contact Linkedin', 'Example Column Name', 'Unstandardized Value 1', 'Unstandardized Value 2', 'Notes'],
  ['Addepar', 'Wealth Management', 'Madison', 'https://li/1', 'Asset Manager Names', 'BlackRock Inc', 'Blackrock', ''],
  ['Galaxy', 'Digital assets', 'Joe', 'https://li/2', 'Client Name', 'JP Morgan', 'JP Morgan Chase', ''],
]), 4);

check('ordinary sheet — header on row 1', hdr([
  ['Carrier', 'Region', 'Amount'],
  ['AT&T', 'East', '100'],
  ['Verizon', 'West', '200'],
]), 0);

check('leading blank rows skipped', hdr([
  [], ['', '', ''],
  ['Carrier', 'Region', 'Amount'],
  ['AT&T', 'East', '100'],
]), 2);

check('single-cell title row skipped', hdr([
  ['Q3 Sales Report', '', '', ''],
  [],
  ['Carrier', 'Region', 'Amount', 'Date'],
  ['AT&T', 'East', '100', '2026-01-01'],
]), 2);

check('numeric-heavy wide row is data, not header', hdr([
  ['1', '2', '3', '4'],
  ['Carrier', 'Region', 'Amount', 'Date'],
  ['AT&T', 'East', '100', '2026-01-01'],
]), 1);

check('all-blank grid falls back to 0', hdr([[], ['', '']]), 0);
check('empty grid falls back to 0', hdr([]), 0);
check('low confidence when nothing looks like a header',
  detectHeaderRow([['1', '2', '3'], ['4', '5', '6']]).confidence, 'low');
check('high confidence on the customer sheet',
  detectHeaderRow([
    ['Number Sent', '77', 'Number Emailed', '54'], [], [], [],
    ['Company', 'Description', 'Contact Name', 'Notes'],
    ['Addepar', 'Wealth', 'Madison', ''],
  ]).confidence, 'high');

// Column letters past Z — the old String.fromCharCode(65 + i) produced '[', '\', ']'.
console.log('spreadsheet column letters:');
check('index 0 → A',   columnLetter(0),  'A');
check('index 25 → Z',  columnLetter(25), 'Z');
check('index 26 → AA', columnLetter(26), 'AA');
check('index 27 → AB', columnLetter(27), 'AB');
check('index 51 → AZ', columnLetter(51), 'AZ');
check('index 52 → BA', columnLetter(52), 'BA');

// ── ReDoS screening for user regex conventions (KI-46) ───────────────────────
// The 500-char cap does NOT bound backtracking: `(a+)+b` is six characters and
// was measured at 246 ms / 698 ms / 11,311 ms on 23 / 27 / 31-char inputs.
// These patterns are applied to RAW SOURCE LITERALS, and Prism is one process,
// so a hang is an installation-wide outage. Both directions matter — a screen
// that rejects ordinary regexes would be worse than none.
console.log('\nconvention regex — catastrophic-backtracking screen:');
const bad = (p: string) => isProbablyCatastrophicRegex(p);
check('(a+)+b rejected            ', bad('(a+)+b'), true);
check('(a*)* rejected             ', bad('(a*)*'), true);
check('(a+)* rejected             ', bad('(a+)*'), true);
check('(\\d+)+ rejected            ', bad('(\\d+)+'), true);
check('nested via non-capturing   ', bad('(?:(a+))+'), true);
check('(a|a)* alternation rejected', bad('(a|a)*'), true);
check('{1,} nested rejected       ', bad('(a{1,}){2,}'), true);
// Legitimate patterns must still be accepted.
check('plain anchored word        ', bad('^[A-Z][a-z]+$'), false);
check('top-level quantifier ok    ', bad('[A-Za-z ]+'), false);
check('quantified group, plain body', bad('(abc)+'), false);
check('alternation, unquantified  ', bad('(cat|dog)'), false);
check('exact count {3} ok         ', bad('(a+){3}'), false);
check('quantifier in char class ok', bad('([a*+])+'), false);
check('escaped quantifier ok      ', bad('(a\\+)+'), false);
check('real-world carrier pattern ', bad('^(AT&T|Verizon|T-Mobile)$'), false);

// ── Provider-routing guard (KI-127) ──────────────────────────────────────────
// callAnthropicWithRetry is the SINGLE dispatch point that translates an
// Anthropic-shaped payload for whichever provider the workspace configured.
// A bare fetch to api.anthropic.com anywhere else sends the ACTIVE provider's
// credential to Anthropic — i.e. leaks an OpenAI/Gemini key to a provider the
// customer never configured. That is exactly how KI-127 happened, in
// callNameFixLLM, and it went unnoticed because the resulting 401 was swallowed.
// The ONLY sanctioned site is the dispatcher itself. The allowlist is
// deliberately minimal: the credential-validation probes in llm-provider /
// verify-install do not currently issue a bare Anthropic fetch, so listing
// them here would silently excuse one added later.
console.log('\nprovider routing — no bare Anthropic fetch outside the dispatcher:');
const ANTHROPIC_FETCH_ALLOWED = new Set([
  'app/api/_lib/llm-one-prompt-grouping.ts', // callAnthropicWithRetry itself
]);
const appRoot = path.join(repoRoot, 'stand-ui', 'app');
const offenders: string[] = [];
(function walk(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!/\.tsx?$/.test(entry.name)) continue;
    const rel = path.relative(path.join(repoRoot, 'stand-ui'), full).split(path.sep).join('/');
    if (ANTHROPIC_FETCH_ALLOWED.has(rel)) continue;
    const src = fs.readFileSync(full, 'utf8');
    if (/fetch\(\s*['"`]https:\/\/api\.anthropic\.com/.test(src)) offenders.push(rel);
  }
})(appRoot);
check('no unsanctioned api.anthropic.com fetch', offenders.join(',') || '(none)', '(none)');

// ── Standardization block gate (DET-S09) ─────────────────────────────────────
//
// A masking / row-access policy makes the service role see masked or filtered
// values. The poller detects this and flags the pipeline, but the flag used to
// be advisory prose only: the 10-minute tick and the hourly reconciliation
// sweep read PIPELINES without ever consulting it, so within about an hour the
// masked values were queued, LLM-standardized, and written PERMANENTLY into
// LITERAL_ALIAS_MATCHES — indistinguishable from real confirmed mappings.
//
// The gate is now a machine-readable status_reason. These checks pin the two
// things that make it work: every blocking reason is actually named in the SQL
// fragment, and the fragment lets an unflagged (NULL) pipeline through — a
// gate that accidentally excluded healthy pipelines would silently stop ALL
// automatic standardization, which is a worse failure than the one it fixes.
console.log('\nstandardization block gate:');
{
  const src = fs.readFileSync(
    path.join(repoRoot, 'stand-ui/app/api/_lib/pipeline-alerts.ts'), 'utf8');

  const reasons = (src.match(/PIPELINE_BLOCK_REASONS = \[([^\]]*)\]/)?.[1] ?? '')
    .split(',').map((r) => r.trim().replace(/^['"`]|['"`]$/g, '')).filter(Boolean);
  check('at least one blocking reason is defined', String(reasons.length > 0), 'true');

  // Capture by line rather than by backtick pair: the fragment contains a
  // NESTED template literal (`'${r}'`) whose backtick would truncate a naive
  // `[^`]*` capture.
  const sqlLine = (src.split('\n')
    .slice(src.split('\n').findIndex((l) => l.includes('NOT_BLOCKED_SQL =')))
    .slice(0, 3).join('\n'));
  // The fragment must be DERIVED from PIPELINE_BLOCK_REASONS, not a
  // hand-maintained copy of it. A duplicated list is the failure mode here:
  // adding a new blocking reason would compile, look correct, and silently not
  // gate anything.
  check('NOT_BLOCKED_SQL is derived from PIPELINE_BLOCK_REASONS',
        String(sqlLine.includes('PIPELINE_BLOCK_REASONS')), 'true');
  check('NOT_BLOCKED_SQL quotes each reason as a SQL literal',
        String(/PIPELINE_BLOCK_REASONS\.map\(.*\)\.join\(/.test(sqlLine)), 'true');
  // An unflagged pipeline (status_reason IS NULL) must pass the gate: in SQL,
  // `NULL NOT IN (...)` is NULL (not true), so the IS NULL arm is load-bearing.
  check('NOT_BLOCKED_SQL admits unflagged pipelines',
        String(/status_reason IS NULL/.test(sqlLine)), 'true');

  // BOTH pollers must set the machine-readable reason when they flag a
  // masking / row-access policy. A guard that exists on one adapter only is
  // not a guard — the mssql poller originally flagged with prose alone, so
  // mssql installs kept standardizing masked values after the Snowflake side
  // was fixed.
  for (const f of ['app/api/_lib/pipeline-poller.ts', 'app/api/_lib/pipeline-poller-mssql.ts']) {
    const src2 = fs.readFileSync(path.join(repoRoot, 'stand-ui', f), 'utf8');
    check(`${f}: policy block sets a machine-readable reason`,
          String(/policy_blocked/.test(src2)), 'true');
  }

  // Every automatic standardization entry point must carry the gate.
  for (const f of ['app/api/_lib/pipeline-hourly-processor.ts']) {
    const gated = fs.readFileSync(path.join(repoRoot, 'stand-ui', f), 'utf8');
    const activeQueries = (gated.match(/WHERE status = 'active'/g) ?? []).length;
    const gates         = (gated.match(/NOT_BLOCKED_SQL/g) ?? []).length - 1; // -1 for the import
    check(`${f}: every active-pipeline query is gated`,
          `${gates}/${activeQueries}`, `${activeQueries}/${activeQueries}`);
  }
}

// ── mssql export staging table DDL (OUT-14 / OUT-13) ─────────────────────────
//
// Two failure modes that both destroyed the WHOLE export rather than one row:
//
//  * A bare PRIMARY KEY is CLUSTERED, whose key is capped at 900 bytes = 450
//    NVARCHAR chars. raw_value is NVARCHAR(800) to match LITERAL_ALIAS_MATCHES,
//    so a single mapped literal longer than 450 chars aborted the entire
//    standardized-table rebuild. NONCLUSTERED raises the limit to 1700 bytes.
//  * An inner JOIN to sys.database_principals silently DROPPED any permission
//    whose grantee the service login cannot resolve, so the rebuild revoked a
//    downstream consumer's access and said nothing.
console.log('\nmssql export staging DDL:');
{
  const src = fs.readFileSync(
    path.join(repoRoot, 'stand-ui/app/api/_lib/warehouse/mssql/export.ts'), 'utf8');

  const stagingLen = Number(src.match(/STAGING_VALUE_LEN = (\d+)/)?.[1] ?? 0);
  check('staging raw_value length is known', String(stagingLen > 0), 'true');
  // NVARCHAR is 2 bytes/char. Clustered keys cap at 900 bytes, nonclustered at 1700.
  check('staging key exceeds the CLUSTERED limit (so it must be nonclustered)',
        String(stagingLen * 2 > 900), 'true');
  check('staging key fits the NONCLUSTERED limit',
        String(stagingLen * 2 <= 1700), 'true');
  check('staging PRIMARY KEY is declared NONCLUSTERED',
        String(/raw_value[^\n]*PRIMARY KEY NONCLUSTERED/.test(src)), 'true');

  // Grant capture must not inner-join the principal catalog.
  check('grant capture LEFT JOINs sys.database_principals',
        String(/LEFT JOIN \$\{quoteIdent\(exp\.db\)\}\.sys\.database_principals/.test(src)), 'true');
  check('unresolvable grantees are reported, not silently dropped',
        String(/unresolvedGrants/.test(src)), 'true');
}

// ── Column-mode privilege failures must stay classifiable (PRELAUNCH §1.4) ───
//
// Column mode is the only feature that writes to the customer's own table, so a
// privilege failure MUST reach the user. It did not on Snowflake: the builder
// caught the warehouse error and rethrew a NEW Error carrying curated fix text,
// whose message matched none of isSnowflakeAccessError's patterns. The rethrow
// silently de-classified the failure, withColumnModeFailureSurfaced never
// paused the pipeline, and the card kept showing "active" while the companion
// column went stale forever. It only worked on SQL Server because that builder
// rethrows the raw driver error.
//
// The rule this pins: classification travels by TYPE, never by matching text
// across a rethrow.
console.log('\ncolumn-mode privilege failures stay classifiable:');
{
  const src = fs.readFileSync(
    path.join(repoRoot, 'stand-ui/app/api/_lib/export-table.ts'), 'utf8');


  // BOTH builders, not just Snowflake. The first version of this check covered
  // only the Snowflake file, so when the mssql builder kept throwing a plain
  // Error for a denied ALTER, the suite stayed green while that failure silently
  // never paused the pipeline (OUT-15). A parity test that checks one adapter is
  // how a cross-warehouse gap survives a "fix".
  // Narrow to PRIVILEGE failures specifically — identified by the remediation
  // SQL they carry. Other bare throws in this function (the source==destination
  // data-loss refusal, "no columns found") are a different class and must stay
  // plain Errors; typing them as access errors would wrongly pause pipelines.
  // The messages are multi-line concatenated templates, so capture a window
  // after each `throw new X(` rather than a single backtick segment — matching
  // only the first segment silently found nothing (the vacuous-pass guard below
  // is what caught that).
  const mssqlSrc = fs.readFileSync(
    path.join(repoRoot, 'stand-ui/app/api/_lib/warehouse/mssql/export.ts'), 'utf8');
  const remediationThrows = [
    ...[...src.matchAll(/throw new (\w+)\(([\s\S]{0,700}?)\n\s*\);/g)],
    ...[...mssqlSrc.matchAll(/throw new (\w+)\(([\s\S]{0,700}?)\n\s*\);/g)],
  ].filter(([, , msg]) =>
    /GRANT UPDATE ON TABLE|requires ownership of the table|could not add the standardized column/.test(msg));
  check('privilege-failure throws were found in BOTH builders (guard against a vacuous pass)',
        String(remediationThrows.length >= 3), 'true');
  const untyped = remediationThrows.filter(([, cls]) => cls !== 'ColumnModeAccessError');
  check('every privilege-failure throw uses the typed error',
        String(untyped.length), '0');
  // And the class must live where both adapters can reach it.
  check('ColumnModeAccessError lives in the neutral adapter-contract module',
        String(/class ColumnModeAccessError extends Error/.test(
          fs.readFileSync(path.join(repoRoot, 'stand-ui/app/api/_lib/warehouse/types.ts'), 'utf8'))), 'true');

  // The wrapper must consult the type and the cause, not only the message.
  const wrapper = src.slice(src.indexOf('async function withColumnModeFailureSurfaced'));
  const guard = wrapper.slice(0, wrapper.indexOf('\n}'));
  check('wrapper classifies on the typed error',
        String(/ColumnModeAccessError/.test(guard)), 'true');
  check('wrapper also classifies on the original error (cause)',
        String(/cause/.test(guard)), 'true');
  check('wrapper still pauses the pipeline',
        String(/pausePipelineWithMessage/.test(guard)), 'true');
}

// ── Column mode cannot be entered after creation (PRELAUNCH §1.5) ────────────
//
// POST /api/pipelines gates column mode behind explicit consent, the
// companion-name conflict guard, and per-table access provisioning. PATCH had
// none of them and wrote export_kind straight into the row — live-proven to let
// Prism ALTER a customer's source table having never received consent. Only
// warehouse default-deny stood in the way, and that is the very property this
// checklist has not been able to verify on Snowflake.
console.log('\ncolumn mode is creation-only:');
{
  const src = fs.readFileSync(
    path.join(repoRoot, 'stand-ui/app/api/pipelines/[pipeline_id]/route.ts'), 'utf8');
  check('PATCH refuses a transition INTO column mode',
        String(/column_mode_requires_creation/.test(src)), 'true');
  check('the refusal compares against the CURRENT stored kind',
        String(/currentKind/.test(src)), 'true');
}

// ── Convention regexes must never use the backtracking engine (SPEC-03) ──────
//
// A user-authored naming-convention regex is matched against raw source
// literals on the single Node thread. `new RegExp` backtracks, so a pattern
// like `(a+)+b` never returns — measured still running after 60 s on a 200-char
// input — and a running regex cannot be interrupted, so it freezes the entire
// installation: UI, poller, every pipeline. Capping the input did NOT bound it.
//
// RE2 (safe-regex.ts) is linear-time and cannot backtrack: same pattern, 5 ms.
// These checks pin that the server never quietly reverts to `new RegExp`.
console.log('\nconvention regexes use the linear-time engine:');
{
  const safeRegexSrc = fs.readFileSync(
    path.join(repoRoot, 'stand-ui/app/api/_lib/safe-regex.ts'), 'utf8');
  check('safe-regex.ts uses RE2', String(/from 're2-wasm'/.test(safeRegexSrc)), 'true');
  // Strip comments first — this file DISCUSSES `new RegExp` at length in its
  // header (explaining why it must not be used), and matching prose would make
  // this check fail on its own documentation.
  const safeRegexCode = safeRegexSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  check('safe-regex.ts never falls back to new RegExp (code, not comments)',
        String(/new RegExp/.test(safeRegexCode)), 'false');

  // The SERVER-side match sites must go through compileSafeRegex.
  for (const f of ['app/api/_lib/op-auto-group-run.ts', 'app/api/_lib/llm-one-prompt-grouping.ts']) {
    const src = fs.readFileSync(path.join(repoRoot, 'stand-ui', f), 'utf8');
    check(`${f}: compiles convention regexes with RE2`,
          String(/compileSafeRegex/.test(src)), 'true');
    // No `new RegExp` anchoring a convention value anywhere in these files.
    check(`${f}: no backtracking-engine convention matcher`,
          String(/new RegExp\(`\^\(\?:/.test(src)), 'false');
  }

  // Save-time keeps BOTH checks: RE2 decides what the server can enforce, and
  // the static screen keeps catastrophic shapes out of storage so the BROWSER's
  // plain-RegExp rename guard cannot be locked up either.
  const specs = fs.readFileSync(
    path.join(repoRoot, 'stand-ui/app/api/_lib/column-specs.ts'), 'utf8');
  check('save-time validates with RE2', String(/safeRegexError/.test(specs)), 'true');
  check('save-time ALSO keeps the static screen (protects the browser path)',
        String(/isProbablyCatastrophicRegex/.test(specs)), 'true');
}

// ── mssql diff-scan cadence floor ────────────────────────────────────────────
// The scan tier NEVER defers on a small table: computeScanTier returns 1 for
// anything under 1M rows, and retuneScanTier returns 1 for any scan finishing
// in under a second. The only thing that skips a read on a small table is the
// heartbeat DMV — which needs VIEW SERVER STATE, an OPTIONAL grant. So without
// the floor below, an install that declines that grant runs a full distinct
// scan of the customer's production column every single minute forever
// (DET-M08). Diff mode is the least-privileged path, so it is exactly the
// install least likely to have the grant.
console.log('\nmssql diff scans are floored when the heartbeat is unavailable:');
{
  const src = fs.readFileSync(
    path.join(repoRoot, 'stand-ui/app/api/_lib/pipeline-poller-mssql.ts'), 'utf8');
  check('a no-heartbeat floor constant exists',
        String(/const DIFF_NO_HEARTBEAT_MIN_PASSES\s*=\s*(\d+)/.test(src)), 'true');
  const floor = Number(src.match(/const DIFF_NO_HEARTBEAT_MIN_PASSES\s*=\s*(\d+)/)?.[1] ?? 0);
  check('the floor actually defers (> 1 pass)', String(floor > 1), 'true');
  // The floor has to be APPLIED to the due-check, not merely declared. Pin that
  // the scan interval branches on heartbeat usability and uses the constant.
  const applied =
    /beatUsable[\s\S]{0,240}?DIFF_NO_HEARTBEAT_MIN_PASSES/.test(src) ||
    /DIFF_NO_HEARTBEAT_MIN_PASSES[\s\S]{0,240}?beatUsable/.test(src);
  check('the floor is applied to the scan-due interval', String(applied), 'true');
  // And it must raise, never lower, whatever the tier already asked for.
  check('the floor takes the MAX of tier and floor',
        String(/Math\.max\(DIFF_NO_HEARTBEAT_MIN_PASSES/.test(src)), 'true');

  // The customer-facing grant docs must state the consequence of declining,
  // not just list the grant as "optional".
  const installSql = fs.readFileSync(path.join(repoRoot, '01_internal_tables.mssql.sql'), 'utf8');
  check('install script explains the cost of skipping the heartbeat grant',
        String(/VIEW SERVER STATE[\s\S]{0,600}?5 minutes/.test(installSql)), 'true');
}

// ── User-keyed accumulators must not inherit from Object.prototype ───────────
// Maps keyed by CUSTOMER-CONTROLLED strings — alias names, raw literal values,
// column headers — must be built with Object.create(null), never {}.
//
// On a plain object literal the keys `__proto__` and `constructor` resolve to
// inherited members, and the two failure modes are both bad:
//   • `if (!m[key])` sees a truthy inherited value, skips creating the entry,
//     and the next `.push` throws — this 500'd GET /api/global-standardizations
//     for an ENTIRE install off one alias named __proto__ (live-reproduced).
//   • `m[key] = value` hits Object.prototype's __proto__ setter, which ignores a
//     string, so the write is SILENTLY dropped and the later read returns
//     Object.prototype — a truthy object that defeats `?? ''` and lands in the
//     customer's exported cell as {}. Silent data corruption, no error at all.
// Both were found live on 2026-08-09 across eight sites.
console.log('\nuser-keyed maps use null-prototype objects:');
{
  const SITES: Array<[string, string]> = [
    ['app/api/global-standardizations/route.ts',            'alias names'],
    ['app/api/run/[run_id]/export-mapping/route.ts',        'literal values + headers'],
    ['app/api/run/[run_id]/export-to-google-sheets/route.ts','literal values + headers'],
    ['app/api/_lib/op-one-time-file.ts',                    'literal values (one-time export)'],
    ['app/api/one-time/export/route.ts',                    'column names'],
    ['app/api/one-time/archive/route.ts',                   'column names'],
    ['app/api/columns/route.ts',                            'catalog column names'],
    ['app/one-time/[session]/OneTimeReviewClient.tsx',      'alias names (review UI)'],
    ['app/api/_lib/table-shape.ts',                         'file headers (shared parser)'],
  ];
  for (const [f, why] of SITES) {
    const src = fs.readFileSync(path.join(repoRoot, 'stand-ui', f), 'utf8');
    check(`${f} uses Object.create(null) (${why})`,
          String(/Object\.create\(null\)/.test(src)), 'true');
    // And must not reintroduce a bare `Record<string, X> = {}` accumulator.
    check(`${f}: no bare Record<string,…> = {} accumulator`,
          String(/Record<string, ?[^>]*> ?= ?\{\}/.test(src)), 'false');
  }
}

// ── The confirmed header row must reach every reader ─────────────────────────
// detectHeaderRow + the connect form's override answer "which row holds the
// column names". Getting this wrong is not cosmetic: a header-on-row-5 sheet
// once ingested the TITLE as its only column name, matched none of the chosen
// columns, reported 0 source values forever, and echoed the junk rows into the
// output (SHEETS-HDR-01, live-reproduced).
//
// Files and Sheets are now the ONE-TIME flow's business — pipelines are
// warehouse-only — so the contract is pinned there.
console.log('\nheader-row handling:');
{
  const shared = fs.readFileSync(
    path.join(repoRoot, 'stand-ui/app/api/_lib/table-shape.ts'), 'utf8');
  check('gridToRows is the single shared parser',
        String(/export function gridToRows/.test(shared)), 'true');
  // Data must start BELOW the header, wherever that is — never a hardcoded row 1.
  check('gridToRows slices data relative to the header row',
        String(/grid\.slice\(headerIdx \+ 1\)/.test(shared)), 'true');
  check('gridToRows disambiguates duplicate/empty headers',
        String(/collisions/.test(shared)), 'true');

  const sheetsIo = fs.readFileSync(
    path.join(repoRoot, 'stand-ui/app/api/_lib/sheets-io.ts'), 'utf8');
  check('sheets-io owns the paged reader',
        String(/export async function readAllSheetRows/.test(sheetsIo)), 'true');
  check('no reader in sheets-io hardcodes allRows[0]',
        String(/allRows\[0\]/.test(sheetsIo)), 'false');

  // The one-time create route reads a Sheet server-side and must honour the
  // confirmed header row rather than assuming row 0.
  const otCreate = fs.readFileSync(
    path.join(repoRoot, 'stand-ui/app/api/one-time/create/route.ts'), 'utf8');
  check('one-time Sheets ingest uses the confirmed header row',
        String(/gridToRows\(grid as unknown\[\]\[\], sheetHeaderRow\)/.test(otCreate)), 'true');
  check('one-time create refuses an oversized sheet cleanly',
        String(/SheetTooLargeError/.test(otCreate)), 'true');
}

// ── Pipelines are warehouse-only ─────────────────────────────────────────────
// Files and Google Sheets are one-shot by nature; a pipeline exists to keep a
// LIVE source standardized on a schedule, and a spreadsheet had to be polled
// every 60 seconds to pretend it was one. The file-pipeline path was removed
// wholesale — these checks stop it growing back by halves.
console.log('\npipelines are warehouse-only:');
{
  const gone = [
    'stand-ui/app/api/_lib/op-file-pipeline.ts',
    'stand-ui/app/home/FilePipelineConnectForm.tsx',
    'stand-ui/app/api/pipelines/file/route.ts',
  ];
  for (const f of gone) {
    check(`removed: ${f.replace('stand-ui/', '')}`,
          String(fs.existsSync(path.join(repoRoot, f))), 'false');
  }
  const poller = fs.readFileSync(
    path.join(repoRoot, 'stand-ui/app/api/_lib/pipeline-poller.ts'), 'utf8');
  check('poller has no file-pipeline branch',
        String(/pollOneFilePipeline|refreshSheetsFileRows/.test(poller)), 'false');
  const pipelinesRoute = fs.readFileSync(
    path.join(repoRoot, 'stand-ui/app/api/pipelines/route.ts'), 'utf8');
  check('GET /api/pipelines no longer virtually expands sheets rows',
        String(/source_type !== 'sheets'/.test(pipelinesRoute)), 'false');
}
// ── Result ───────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} parity check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll parity checks passed.');
