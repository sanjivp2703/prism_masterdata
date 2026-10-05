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
import { normalizeLiteral, sqlStringLiteral, isBlankLiteral } from '../app/api/_lib/normalize';
import { notBlankPredicate as msNotBlank, isBlankPredicate as msIsBlank } from '../app/api/_lib/warehouse/mssql/dialect';
import { notBlankPredicate as pgNotBlank, isBlankPredicate as pgIsBlank } from '../app/api/_lib/warehouse/postgres/dialect';
import { notBlankPredicate as myNotBlank, isBlankPredicate as myIsBlank } from '../app/api/_lib/warehouse/mysql/dialect';
import { asExportKind, standardizedColumnName, assertCompanionColumnSafe } from '../app/api/_lib/export-kind';
import { isProbablyCatastrophicRegex } from '../app/api/_lib/convention-rules';
import { detectHeaderRow, columnLetter } from '../app/api/_lib/table-shape';
import { asPrismEdition } from '../app/api/_lib/edition';
import {
  parseReferenceBindings, matchSourceReference, referenceSql,
  describeTypeToken, describeRowsToColumns,
} from '../app/api/_lib/warehouse/snowflake/reference-sql';

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

// ── PostgreSQL dialect helpers ───────────────────────────────────────────────
import {
  quoteIdent as pgQuote, parseFqn as pgParseFqn, assertFqnInDatabase,
  translateBinds as pgTranslateBinds, classifyPgPollError, isPgAccessErrorShape,
  isScaleToZeroHost,
} from '../app/api/_lib/warehouse/postgres/dialect';

console.log('postgres dialect — quoteIdent:');
check('plain name', pgQuote('Company Name'), '"Company Name"');
check('embedded quote doubled', pgQuote('weird"name'), '"weird""name"');
check('control char rejected', (() => { try { pgQuote('a' + String.fromCharCode(1) + 'b'); return 'no-throw'; } catch { return 'threw'; } })(), 'threw');

console.log('postgres dialect — parseFqn (2- and 3-part; cross-db rejection):');
check('three parts', JSON.stringify(pgParseFqn('prism_dev.prism_internal.pipeline_queue')), JSON.stringify({ db: 'prism_dev', schema: 'prism_internal', table: 'pipeline_queue' }));
check('two parts → null db', JSON.stringify(pgParseFqn('public.orders')), JSON.stringify({ db: null, schema: 'public', table: 'orders' }));
check('one part rejected', (() => { try { pgParseFqn('orders'); return 'no-throw'; } catch { return 'threw'; } })(), 'threw');
check('empty part rejected', (() => { try { pgParseFqn('a..b'); return 'no-throw'; } catch { return 'threw'; } })(), 'threw');
check('same db passes (case-insensitive)', (() => { try { assertFqnInDatabase(pgParseFqn('Prism_Dev.public.t'), 'prism_dev'); return 'ok'; } catch { return 'threw'; } })(), 'ok');
check('2-part passes any db', (() => { try { assertFqnInDatabase(pgParseFqn('public.t'), 'prism_dev'); return 'ok'; } catch { return 'threw'; } })(), 'ok');
check('cross-database rejected', (() => { try { assertFqnInDatabase(pgParseFqn('other_db.public.t'), 'prism_dev'); return 'no-throw'; } catch (e) { return String((e as Error).message).includes('cannot query across databases') ? 'threw-right' : 'threw-wrong'; } })(), 'threw-right');

console.log('postgres dialect — translateBinds (? -> $n, quote/comment/dollar-aware):');
{
  const r = pgTranslateBinds('SELECT * FROM t WHERE a = ? AND b = ?');
  check('two binds text', r.text, 'SELECT * FROM t WHERE a = $1 AND b = $2');
  check('two binds count', r.count, 2);
}
{
  const r = pgTranslateBinds("SELECT 'lit?eral', c FROM t WHERE d = ?");
  check('? inside string untouched', r.text, "SELECT 'lit?eral', c FROM t WHERE d = $1");
}
{
  const r = pgTranslateBinds("SELECT 'it''s ?', ? FROM t");
  check('escaped quote handled', r.text, "SELECT 'it''s ?', $1 FROM t");
}
{
  const r = pgTranslateBinds('SELECT "odd?col" FROM t WHERE x = ? -- trailing ? comment');
  check('quoted ident + line comment untouched', r.text, 'SELECT "odd?col" FROM t WHERE x = $1 -- trailing ? comment');
}
{
  const r = pgTranslateBinds('/* block ? comment */ SELECT ?');
  check('block comment untouched', r.text, '/* block ? comment */ SELECT $1');
}
{
  const r = pgTranslateBinds('DO $$ BEGIN PERFORM 1 WHERE ,? > 0; END $$; SELECT ?');
  check('dollar-quoted body untouched', r.text, 'DO $$ BEGIN PERFORM 1 WHERE ,? > 0; END $$; SELECT $1');
}
{
  const r = pgTranslateBinds("SELECT $tag$has ? mark$tag$, ?");
  check('tagged dollar quote untouched', r.text, "SELECT $tag$has ? mark$tag$, $1");
}
{
  const r = pgTranslateBinds("SELECT E'esc\\'aped ?', ?");
  check('E-string backslash escape handled', r.text, "SELECT E'esc\\'aped ?', $1");
}

console.log('postgres dialect — classifyPgPollError / isPgAccessErrorShape:');
check('bad password → global', classifyPgPollError({ code: '28P01' }), 'global');
check('db missing → global', classifyPgPollError({ code: '3D000' }), 'global');
check('undefined table → table', classifyPgPollError({ code: '42P01' }), 'table');
check('permission denied → table', classifyPgPollError({ code: '42501' }), 'table');
check('watched column dropped → table', classifyPgPollError({ code: '42703' }), 'table');
check('deadlock → transient', classifyPgPollError({ code: '40P01' }), 'transient');
check('conn refused → transient', classifyPgPollError({ code: 'ECONNREFUSED' }), 'transient');
check('unknown → transient', classifyPgPollError(new Error('weird')), 'transient');
check('42501 is access error', isPgAccessErrorShape({ code: '42501' }), true);
check('relation-missing message is access error', isPgAccessErrorShape(new Error('relation "public.foo" does not exist')), true);
check('syntax error is not access error', isPgAccessErrorShape({ code: '42601', message: 'syntax error at or near' }), false);

console.log('postgres dialect — isScaleToZeroHost:');
check('neon host detected', isScaleToZeroHost('ep-cool-cloud-123.us-east-2.aws.neon.tech'), true);
check('rds host not flagged', isScaleToZeroHost('mydb.abc.us-east-1.rds.amazonaws.com'), false);
check('localhost not flagged', isScaleToZeroHost('localhost'), false);
check('null not flagged', isScaleToZeroHost(null), false);

// ── MySQL dialect helpers ────────────────────────────────────────────────────
import {
  quoteIdent as myQuote, parseFqn as myParseFqn, translateBinds as myTranslateBinds,
  binaryCompare, classifyMysqlPollError, isMysqlAccessErrorShape,
  isScaleToZeroHost as myScaleToZero,
} from '../app/api/_lib/warehouse/mysql/dialect';

console.log('mysql dialect — quoteIdent:');
check('plain name', myQuote('Company Name'), '`Company Name`');
check('embedded backtick doubled', myQuote('weird`name'), '`weird``name`');
check('control char rejected', (() => { try { myQuote('a' + String.fromCharCode(1) + 'b'); return 'no-throw'; } catch { return 'threw'; } })(), 'threw');

console.log('mysql dialect — parseFqn (2-part only; no schema level):');
check('two parts', JSON.stringify(myParseFqn('prism_internal.pipeline_queue')), JSON.stringify({ db: 'prism_internal', table: 'pipeline_queue' }));
check('three parts rejected (unconverted snowflake FQN)', (() => { try { myParseFqn('A.B.C'); return 'no-throw'; } catch { return 'threw'; } })(), 'threw');
check('one part rejected', (() => { try { myParseFqn('orders'); return 'no-throw'; } catch { return 'threw'; } })(), 'threw');

console.log('mysql dialect — translateBinds (native ?, count-only, quote/comment-aware):');
{
  const r = myTranslateBinds('SELECT * FROM t WHERE a = ? AND b = ?');
  check('text unchanged', r.text, 'SELECT * FROM t WHERE a = ? AND b = ?');
  check('two binds counted', r.count, 2);
}
check('? inside string not counted', myTranslateBinds("SELECT 'lit?eral' FROM t WHERE d = ?").count, 1);
check('backslash-escaped quote handled', myTranslateBinds("SELECT 'it\\'s ?', ? FROM t").count, 1);
check('doubled quote handled', myTranslateBinds("SELECT 'it''s ?', ? FROM t").count, 1);
check('backtick ident not counted', myTranslateBinds('SELECT `odd?col` FROM t WHERE x = ?').count, 1);
check('# comment not counted', myTranslateBinds('SELECT ? # trailing ? comment').count, 1);
check('-- comment not counted', myTranslateBinds('SELECT ? -- trailing ? comment').count, 1);
check('block comment not counted', myTranslateBinds('/* block ? */ SELECT ?').count, 1);
check('double-quoted string not counted', myTranslateBinds('SELECT "who?dis", ?').count, 1);

console.log('mysql dialect — binaryCompare (charset coercion, not bare COLLATE):');
check('wraps with CONVERT + utf8mb4_bin', binaryCompare('src.`carrier`'), 'CONVERT(src.`carrier` USING utf8mb4) COLLATE utf8mb4_bin');

console.log('mysql dialect — classifyMysqlPollError / isMysqlAccessErrorShape:');
check('auth failed → global', classifyMysqlPollError({ errno: 1045 }), 'global');
check('unknown database → global', classifyMysqlPollError({ errno: 1049 }), 'global');
check('table missing → table', classifyMysqlPollError({ errno: 1146 }), 'table');
check('command denied → table', classifyMysqlPollError({ errno: 1142 }), 'table');
check('watched column dropped → table', classifyMysqlPollError({ errno: 1054 }), 'table');
check('deadlock → transient', classifyMysqlPollError({ errno: 1213 }), 'transient');
check('conn refused → transient', classifyMysqlPollError({ code: 'ECONNREFUSED' }), 'transient');
check('unknown → transient', classifyMysqlPollError(new Error('weird')), 'transient');
check('1142 is access error', isMysqlAccessErrorShape({ errno: 1142 }), true);
check("table-missing message is access error", isMysqlAccessErrorShape(new Error("Table 'x.y' doesn't exist")), true);
check('syntax error is not access error', isMysqlAccessErrorShape({ errno: 1064, message: 'You have an error in your SQL syntax' }), false);

console.log('mysql dialect — isScaleToZeroHost:');
check('planetscale host detected', myScaleToZero('aws.connect.psdb.cloud'), true);
check('rds host not flagged', myScaleToZero('mydb.abc.us-east-1.rds.amazonaws.com'), false);
check('localhost not flagged', myScaleToZero('localhost'), false);

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
// never a raw source column, never an arbitrary name (docs/internal/PRELAUNCH_CHECKLIST.md §1).
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
  // The detected row must be SHOWN and CORRECTABLE on every source. It always
  // was for file uploads; Google Sheets detected silently, so a wrong guess was
  // invisible and uncorrectable — and since the row is persisted and drives what
  // gets read and standardized, that produced sessions which looked healthy and
  // standardized the wrong column (SHEETS-HDR-02).
  const sheetsCols = fs.readFileSync(
    path.join(repoRoot, 'stand-ui/app/api/sheets/columns/route.ts'), 'utf8');
  check('sheets/columns accepts a headerRow override',
        String(/searchParams\.get\('headerRow'\)/.test(sheetsCols)), 'true');
  check('sheets/columns reports what it DETECTED alongside the override',
        String(/detectedHeaderRow/.test(sheetsCols)), 'true');
  check('sheets/columns returns raw rows so the choice is visible',
        String(/sampleRows/.test(sheetsCols)), 'true');
  check('columns come from the RESOLVED row, not the detected one',
        String(/const columns: string\[\] = \(grid\[headerRow\]/.test(sheetsCols)), 'true');

  const otCard = fs.readFileSync(
    path.join(repoRoot, 'stand-ui/app/home/OneTimeStandardizationCard.tsx'), 'utf8');
  check('one-time card lets the user correct the Sheets header row',
        String(/Column headers are on row/.test(otCard)), 'true');
  check('one-time card re-reads the sheet when the row changes',
        String(/loadSheet\(sheetUrl\.trim\(\), sheetTab, idx\)/.test(otCard)), 'true');

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
// ── Column-mode failures are diagnosed, not guessed ──────────────────────────
// Every column-mode failure used to be reported as "adding a column requires
// ownership of the table". Live testing (OUT-08) hit two cases where that was
// actively misleading — the object was a VIEW, and the table did not exist —
// and in both the customer was sent to fix a permission that was not the
// problem. The write aborts safely either way, so this costs a support round
// trip rather than data; but the message IS the entire remedy they get
// (ERR-DIAG-01).
//
// These strings are the REAL ones the warehouses produced during that live run.
console.log('\ncolumn-mode failures are diagnosed by cause:');
{
  const src = fs.readFileSync(
    path.join(repoRoot, 'stand-ui/app/api/_lib/export-table.ts'), 'utf8');
  check('a failure classifier exists',
        String(/function classifyColumnModeFailure/.test(src)), 'true');
  check('the remedy is chosen from the classification',
        String(/columnModeRemedy\(classifyColumnModeFailure\(/.test(src)), 'true');

  // Re-implement the classifier's regexes here and pin them against captured
  // strings. A guard assertion below proves the patterns were actually found,
  // so a rename cannot turn this into a vacuous pass.
  const missing = /does not exist|invalid identifier|cannot be found|object .* not found/;
  const notTbl  = /is not a table|cannot alter view|not supported on view|is a view/;
  check('classifier regexes still present in the source',
        String(src.includes('does not exist|invalid identifier') &&
               src.includes('is not a table|cannot alter view')), 'true');

  const classify = (m: string) =>
    missing.test(m.toLowerCase()) ? 'missing'
    : notTbl.test(m.toLowerCase()) ? 'not_a_table'
    : 'privilege';

  const CASES: Array<[string, string]> = [
    // Snowflake, captured live
    ["SQL compilation error: Object 'TEST_DB.PUBLIC.OUT08E_GONE' does not exist or not authorized.", 'missing'],
    ["SQL access control error: Insufficient privileges to operate on table 'OUT08E_SRC'", 'privilege'],
    ["SQL access control error: Insufficient privileges to operate on account", 'privilege'],
    ["SQL compilation error: invalid identifier 'CARRIER'", 'missing'],
    // View target
    ["SQL compilation error: OUT08E_VIEW is not a table", 'not_a_table'],
    // SQL Server equivalents
    ["Invalid object name 'dbo.OUT08E_SRC'.", 'privilege'],   // no phrase match -> safe default
    ["ALTER TABLE permission was denied on object 'OUT08E_SRC'", 'privilege'],
  ];
  for (const [msg, want] of CASES) {
    check(`classify: ${msg.slice(0, 52)}…`, classify(msg), want);
  }
  // The default must be 'privilege': it is the only branch that emits runnable
  // GRANT SQL, so an unrecognised error still gives the admin something to do.
  check('unknown errors default to the privilege remedy', classify('something unexpected'), 'privilege');
}

// ── Edition switch (edition.ts) ──────────────────────────────────────────────
// The native (Marketplace) edition rides on this predicate; the ABSENT flag
// must resolve to 'standard' so the standard edition stays byte-identical
// (docs/NATIVE_APP_PLAN.md, Phase N1).
{
  console.log('\nedition switch (edition.ts):');
  check('absent → standard', asPrismEdition(undefined), 'standard');
  check('empty → standard', asPrismEdition(''), 'standard');
  check('junk → standard', asPrismEdition('nativ'), 'standard');
  check("'native' recognized", asPrismEdition('native'), 'native');
  check('case/whitespace tolerated', asPrismEdition('  Native '), 'native');
  check("'standard' explicit", asPrismEdition('standard'), 'standard');

  // edition.ts must stay importable from CLIENT components (it hides cut
  // surfaces in the UI), so it may never grow a 'server-only' import.
  const editionSrc = fs.readFileSync(path.join(here, '..', 'app', 'api', '_lib', 'edition.ts'), 'utf8');
  check("edition.ts has no 'server-only' import", editionSrc.includes("'server-only'"), false);
}

// ── Edit-in-place file patching (file-inplace.ts) ────────────────────────────
import { zipSync as fZip, unzipSync as fUnzip, strToU8 as fS2U, strFromU8 as fU2S } from 'fflate';
import { patchCsvInPlace, patchXlsxInPlace, extractCsvGrid, extractXlsxGrid } from '../app/api/_lib/file-inplace';

console.log('file-inplace — CSV patching:');
{
  // BOM + CRLF + quoted commas + quoted newline + blank row + title row above header.
  const csv = '﻿Customer Export\r\n\r\nName,Carrier,City\r\n"Acme, Inc",att,"Bos\nton"\r\n\r\nBeta,VZW,Erie\r\n';
  const out = patchCsvInPlace(csv, 2, [
    { dataRow: 0, column: 'Carrier', value: 'AT&T' },
    { dataRow: 1, column: 'Carrier', value: 'Verizon' },
  ]);
  check('quoted fields + blank rows addressed correctly', out,
    '﻿Customer Export\r\n\r\nName,Carrier,City\r\n"Acme, Inc",AT&T,"Bos\nton"\r\n\r\nBeta,Verizon,Erie\r\n');
  const out2 = patchCsvInPlace(csv, 2, [{ dataRow: 0, column: 'Name', value: 'Needs, quoting' }]);
  check('replacement needing quotes gets quoted', out2.includes('"Needs, quoting",att'), true);
  check('unrelated bytes untouched (BOM, CRLF, title, quoted newline)',
    out2.startsWith('﻿Customer Export\r\n\r\n') && out2.includes('"Bos\nton"'), true);
  check('unknown column throws (caller falls back)',
    (() => { try { patchCsvInPlace(csv, 2, [{ dataRow: 0, column: 'Nope', value: 'x' }]); return 'no-throw'; } catch { return 'threw'; } })(), 'threw');
  check('grid extraction matches parse', JSON.stringify(extractCsvGrid('a,b\n"x,y",z')[1]), JSON.stringify(['x,y', 'z']));
}

console.log('file-inplace — XLSX patching (handcrafted fixture):');
{
  const CT = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`;
  const wbRels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Accounts" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const shared = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="5" uniqueCount="5"><si><t>GUID</t></si><si><t>Name</t></si><si><t>Carrier</t></si><si><t>att</t></si><si><t>Title Row</t></si></sst>`;
  const styles = `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf/><xf applyFill="1"/></cellXfs></styleSheet>`;
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" hidden="1"/></cols><sheetData><row r="1"><c r="A1" t="s"><v>4</v></c></row><row r="3"><c r="A3" t="s"><v>0</v></c><c r="B3" t="s"><v>1</v></c><c r="C3" t="s"><v>2</v></c></row><row r="4"><c r="A4" t="str"><v>guid-1</v></c><c r="B4" t="inlineStr"><is><t>Acme &amp; Co</t></is></c><c r="C4" s="1" t="s"><v>3</v></c></row><row r="6"><c r="A6" t="str"><v>guid-2</v></c><c r="B6" t="str"><v>Beta</v></c><c r="C6" t="str"><v>VZW</v></c></row></sheetData></worksheet>`;
  const fixture = fZip({
    '[Content_Types].xml': fS2U(CT),
    'xl/workbook.xml': fS2U(workbook),
    'xl/_rels/workbook.xml.rels': fS2U(wbRels),
    'xl/sharedStrings.xml': fS2U(shared),
    'xl/styles.xml': fS2U(styles),
    'xl/worksheets/sheet1.xml': fS2U(sheet),
  });

  const grid = extractXlsxGrid(fixture, 'Accounts');
  check('fixture grid extracted (shared strings resolved)', grid[2]?.[2] === 'Carrier' && grid[3]?.[2] === 'att', true);

  const patched = patchXlsxInPlace(fixture, 'Accounts', 2, [
    { dataRow: 0, column: 'Carrier', value: 'AT&T' },
    { dataRow: 1, column: 'Carrier', value: 'Verizon' },
  ]);
  const outFiles = fUnzip(patched);
  const outSheet = fU2S(outFiles['xl/worksheets/sheet1.xml']);
  check('cell C4 patched to style-preserving inline string',
    outSheet.includes('<c r="C4" s="1" t="inlineStr"><is><t xml:space="preserve">AT&amp;T</t></is></c>'), true);
  check('cell C6 patched', outSheet.includes('<c r="C6" t="inlineStr"><is><t xml:space="preserve">Verizon</t></is></c>'), true);
  check('hidden-column definition untouched', outSheet.includes('<col min="1" max="1" hidden="1"/>'), true);
  check('GUID cells untouched', outSheet.includes('<c r="A4" t="str"><v>guid-1</v></c>') && outSheet.includes('<c r="A6" t="str"><v>guid-2</v></c>'), true);
  check('inline-string name cell untouched', outSheet.includes('<c r="B4" t="inlineStr"><is><t>Acme &amp; Co</t></is></c>'), true);
  check('styles.xml byte-identical', fU2S(outFiles['xl/styles.xml']), styles);
  check('sharedStrings byte-identical', fU2S(outFiles['xl/sharedStrings.xml']), shared);
  const reGrid = extractXlsxGrid(patched, 'Accounts');
  check('patched file re-extracts with new values (blank-row mapping held)', reGrid[3]?.[2] === 'AT&T' && reGrid[5]?.[2] === 'Verizon', true);
  check('GUID column edit resolves to a real cell (no-throw)',
    (() => { try { patchXlsxInPlace(fixture, 'Accounts', 2, [{ dataRow: 0, column: 'GUID', value: 'x' }]); return 'no-throw'; } catch { return 'threw'; } })(), 'no-throw');
}

// ── Internal-schema reference guard (native-edition sweep) ───────────────────
//
// Runtime data-plane SQL must reference the internal schema through the
// warehouse-tables helpers (internalTable / internalObject / internalSchemaFqn
// / prismNormalizeFn) so the native (Marketplace) edition can resolve them to
// its own schemas. A hardcoded literal anywhere else silently breaks the
// native edition only — the standard build keeps working, so nothing catches
// the regression. Allowlist: warehouse-tables.ts (the resolver itself), the
// standard-edition install/grant surfaces (they legitimately EMIT the standard
// schema's SQL), and the lookup-export route's refusal of the internal schema
// as a user-supplied target (a security check on user input, not a data-plane
// reference).
console.log('\ninternal-schema reference guard:');
{
  // Concatenated so this test file never matches its own needle.
  const needle = 'PRISM_DB' + '.INTERNAL';
  const INTERNAL_REF_ALLOWED = new Set([
    'app/api/_lib/warehouse-tables.ts',
    'app/api/_lib/grants.ts',
    'app/api/accounts/install-script/route.ts',
    'app/api/accounts/verify-install/route.ts',
    'app/api/global-standardizations/export/route.ts',
  ]);
  const apiRoot = path.join(repoRoot, 'stand-ui', 'app', 'api');
  const offending: string[] = [];
  (function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.ts$/.test(entry.name)) continue;
      const rel = path.relative(path.join(repoRoot, 'stand-ui'), full).split(path.sep).join('/');
      if (INTERNAL_REF_ALLOWED.has(rel)) continue;
      if (fs.readFileSync(full, 'utf8').includes(needle)) offending.push(rel);
    }
  })(apiRoot);
  check('no hardcoded internal-schema reference outside the allowlist',
    offending.join(', ') || '(none)', '(none)');
}

// ── Native-edition reference SQL helpers ────────────────────────────────────
// warehouse/snowflake/reference-sql.ts: pure mapping between the manifest's
// source_table reference bindings and the reference('source_table','<alias>')
// addressing form (docs/NATIVE_APP_PLAN.md, access model revised 2026-09-01).
console.log('\nnative reference-sql helpers:');
{
  const bindings = parseReferenceBindings([
    { alias: 'A1', database: 'TEST_DB', schema: 'PUBLIC', name: 'CARRIERS' },
    { alias: 'A2', database: 'Sales', schema: 'raw', name: 'My Table' },
    { alias: '',   database: 'X', schema: 'Y', name: 'Z' },           // incomplete → dropped
    { database: 'X', schema: 'Y', name: 'Z' },                        // no alias → dropped
    'garbage',
  ]);
  check('parseReferenceBindings keeps only complete entries', bindings.length, 2);
  check('parseReferenceBindings maps database/schema/name',
    JSON.stringify(bindings[0]),
    JSON.stringify({ alias: 'A1', db: 'TEST_DB', schema: 'PUBLIC', table: 'CARRIERS' }));
  check('parseReferenceBindings tolerates non-array garbage', parseReferenceBindings('nope').length, 0);
  check('parseReferenceBindings tolerates null', parseReferenceBindings(null).length, 0);

  check('matchSourceReference exact match',
    matchSourceReference({ db: 'TEST_DB', schema: 'PUBLIC', table: 'CARRIERS' }, bindings)?.alias, 'A1');
  check('matchSourceReference preserves verbatim case/spaces',
    matchSourceReference({ db: 'Sales', schema: 'raw', table: 'My Table' }, bindings)?.alias, 'A2');
  // Case-insensitive resolution would address a DIFFERENT object than the
  // quoted-identifier FQN path — must stay unmatched.
  check('matchSourceReference rejects case mismatch',
    matchSourceReference({ db: 'test_db', schema: 'PUBLIC', table: 'CARRIERS' }, bindings), null);

  check('referenceSql form',
    referenceSql('A1'), "reference('source_table', 'A1')");
  check('referenceSql escapes single quotes',
    referenceSql("A'1"), "reference('source_table', 'A''1')");

  check('describeTypeToken VARCHAR → TEXT', describeTypeToken('VARCHAR(16777216)'), 'TEXT');
  check('describeTypeToken STRING → TEXT', describeTypeToken('string'), 'TEXT');
  check('describeTypeToken NUMBER keeps its own token', describeTypeToken('NUMBER(38,0)'), 'NUMBER');

  const cols = describeRowsToColumns([
    { name: 'CARRIER', type: 'VARCHAR(200)', kind: 'COLUMN' },
    { name: 'ID', type: 'NUMBER(38,0)', kind: 'COLUMN' },
    { name: 'ignored', type: 'VARCHAR', kind: 'VIRTUAL_COLUMN' },
    { NAME: 'UPPERKEYS', TYPE: 'VARCHAR(50)' },                       // uppercase keys, no kind
  ]);
  check('describeRowsToColumns filters non-columns and keeps order',
    cols.map(c => c.name).join(','), 'CARRIER,ID,UPPERKEYS');
  check('describeRowsToColumns normalizes types',
    cols.map(c => c.typeToken).join(','), 'TEXT,NUMBER,TEXT');
}

// ── Blank source values (2026-09-14) ─────────────────────────────────────────
// "Blank" = normalizes to '' — treated like NULL on every path: not a source
// value, never queued, never standardized, passes through the export as-is.
// The app-side definition (isBlankLiteral) and each warehouse's SQL predicate
// must agree, or a value becomes permanently "Unstandardized" with no path
// that can ever write it (the live failure that motivated this).
{
  console.log('\nBlank source values (isBlankLiteral + per-warehouse SQL predicates):');
  check('isBlankLiteral: null', isBlankLiteral(null), true);
  check('isBlankLiteral: undefined', isBlankLiteral(undefined), true);
  check('isBlankLiteral: empty string', isBlankLiteral(''), true);
  check('isBlankLiteral: spaces only', isBlankLiteral('   '), true);
  check('isBlankLiteral: tab/newline only', isBlankLiteral('\t\n'), true);
  check('isBlankLiteral: control chars only', isBlankLiteral('\u0000\u001f\u0085'), true);
  check('isBlankLiteral: NBSP only is blank (\\s matches it)', isBlankLiteral('\u00a0'), true);
  check('isBlankLiteral: "n/a" is a real value', isBlankLiteral('n/a'), false);
  check('isBlankLiteral: "0" is a real value', isBlankLiteral('0'), false);
  check('isBlankLiteral: padded value is real', isBlankLiteral('  AT&T  '), false);

  check('mssql notBlankPredicate', msNotBlank('[Carrier]'), "([Carrier] IS NOT NULL AND LTRIM(RTRIM([Carrier])) <> '')");
  check('mssql isBlankPredicate',  msIsBlank('src.[Carrier]'), "(src.[Carrier] IS NULL OR LTRIM(RTRIM(src.[Carrier])) = '')");
  check('postgres notBlankPredicate', pgNotBlank('"carrier"'), `("carrier" IS NOT NULL AND BTRIM("carrier"::text, E' \\t\\n\\r') <> '')`);
  check('postgres isBlankPredicate',  pgIsBlank('src."carrier"'), `(src."carrier" IS NULL OR BTRIM(src."carrier"::text, E' \\t\\n\\r') = '')`);
  check('mysql notBlankPredicate', myNotBlank('`carrier`'), "(`carrier` IS NOT NULL AND TRIM(`carrier`) <> '')");
  check('mysql isBlankPredicate',  myIsBlank('src.`carrier`'), "(src.`carrier` IS NULL OR TRIM(src.`carrier`) = '')");
  // isBlank must be the exact negation of notBlank for the same column.
  for (const [name, nb, ib] of [['mssql', msNotBlank, msIsBlank], ['postgres', pgNotBlank, pgIsBlank], ['mysql', myNotBlank, myIsBlank]] as const) {
    const a = nb('c'), b = ib('c');
    check(`${name}: isBlank is the negation of notBlank`,
      a.replace(' IS NOT NULL AND ', ' IS NULL OR ').replace(" <> '')", " = '')"), b);
  }
}

// ── Result ───────────────────────────────────────────────────────────────────
// KEEP THIS BLOCK LAST. It used to sit above the file-inplace section, which
// meant every check added below it ran AFTER the exit decision — failures
// printed but could never fail the process (found 2026-08-12).
if (failures > 0) {
  console.error(`\n${failures} parity check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll parity checks passed.');
