/**
 * N0 Cortex quality spike (docs/NATIVE_APP_PLAN.md §2.4, gate for the DECIDED
 * Cortex path): run the EXACT production chunk prompt through (a) the
 * Anthropic API production path and (b) Snowflake Cortex-served Claude, and
 * compare grouping quality + JSON validity.
 *
 *   NODE_OPTIONS='--conditions=react-server' npx tsx scripts/cortex-spike.mts
 *
 * Uses the demo table's two columns as fixtures. Read-only against the
 * warehouse (SELECTs + CORTEX.COMPLETE calls); writes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

// .env.local → process.env (before importing app modules that read env)
for (const line of fs.readFileSync(path.join(here, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
}

const { buildSystemPrompt, buildUserTurn, callAnthropicWithRetry, JSON_ONLY_REMINDER } =
  await import('../app/api/_lib/llm-one-prompt-grouping');
const require2 = createRequire(path.join(here, '..', 'package.json'));
const snowflake = require2('snowflake-sdk');

// ── Snowflake connection (key-pair, PRISM_SERVICE) ───────────────────────────
const keyPathRaw = process.env.SNOWFLAKE_PRIVATE_KEY_PATH!;
const keyPath = keyPathRaw.startsWith('/') ? keyPathRaw : path.join(repoRoot, keyPathRaw);
const conn = snowflake.createConnection({
  account: process.env.SNOWFLAKE_ACCOUNT, username: process.env.SNOWFLAKE_USER,
  warehouse: process.env.SNOWFLAKE_WAREHOUSE, role: 'PRISM_SERVICE',
  authenticator: 'SNOWFLAKE_JWT', privateKey: fs.readFileSync(keyPath, 'utf8'),
});
await new Promise<void>((res, rej) => conn.connect((e: unknown) => (e ? rej(e) : res())));
function q(sql: string, binds?: unknown[]): Promise<any[]> {
  return new Promise((res, rej) =>
    conn.execute({ sqlText: sql, binds, complete: (e: unknown, _s: unknown, r: any[]) => (e ? rej(e) : res(r ?? [])) }));
}

// ── Fixtures: the demo table's distinct values ───────────────────────────────
const COLUMNS: Array<{ col: string; concept: string; definition: string }> = [
  { col: 'RAW_CARRIER_VALUE', concept: 'RAW_CARRIER_VALUE', definition: 'Mobile phone carrier names' },
  { col: 'RAW_COMPANY_VALUE', concept: 'RAW_COMPANY_VALUE', definition: 'Company names' },
];

interface ParsedOut { g: Array<[number[], string, string]>; u: number[] }
function parseGrouping(text: string): ParsedOut | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const j = JSON.parse(stripped);
    if (!Array.isArray(j?.g)) return null;
    return { g: j.g, u: Array.isArray(j.u) ? j.u : [] };
  } catch { return null; }
}

/** item index → group id (its own index for ungrouped/missing). */
function partition(n: number, out: ParsedOut): Map<number, string> {
  const m = new Map<number, string>();
  out.g.forEach((grp, gi) => (grp[0] ?? []).forEach((idx) => m.set(idx, `g${gi}`)));
  for (let i = 1; i <= n; i++) if (!m.has(i)) m.set(i, `solo${i}`);
  return m;
}

/** Pairwise same-group agreement between two partitions of 1..n. */
function pairAgreement(n: number, a: Map<number, string>, b: Map<number, string>): number {
  let agree = 0, total = 0;
  for (let i = 1; i <= n; i++) for (let j = i + 1; j <= n; j++) {
    total++;
    if ((a.get(i) === a.get(j)) === (b.get(i) === b.get(j))) agree++;
  }
  return total ? agree / total : 1;
}

const CORTEX_CANDIDATES = ['claude-4-sonnet', 'claude-3-7-sonnet', 'claude-3-5-sonnet'];
let cortexModel: string | null = null;
for (const cand of CORTEX_CANDIDATES) {
  try {
    await q(`SELECT SNOWFLAKE.CORTEX.COMPLETE(?, 'Say OK') AS R`, [cand]);
    cortexModel = cand;
    break;
  } catch (e) {
    console.log(`  cortex model ${cand}: unavailable (${String((e as Error).message).slice(0, 80)})`);
  }
}
if (!cortexModel) {
  console.error('NO Cortex Claude model available in this region — spike result: BLOCKED (consider cross-region inference or option B).');
  process.exit(2);
}
console.log(`Cortex model: ${cortexModel}\n`);

for (const { col, concept, definition } of COLUMNS) {
  const rows = await q(
    `SELECT DISTINCT ${col} AS V FROM TEST_DB.PUBLIC.RAW_MOBILE_CARRIERS_SHORT WHERE ${col} IS NOT NULL`);
  const items = rows.map((r, i) => ({
    run_item_id: i + 1, literal_value: String(r.V),
    cleaned_value: null, normalization_value: null, std_tokens: [], norm_tokens: [],
  }));
  const n = items.length;
  const sys = buildSystemPrompt(concept, definition, null, null);
  const user = buildUserTurn(items as any, concept);

  // (a) production path — Anthropic API
  const t0 = Date.now();
  const anth = await callAnthropicWithRetry(process.env.ANTHROPIC_API_KEY!, {
    model: 'claude-sonnet-4-6', max_tokens: 4000,
    system: [{ type: 'text', text: sys }],
    messages: [{ role: 'user', content: user }],
  }, `spike-anthropic-${col}`);
  const anthMs = Date.now() - t0;
  const anthText = (anth as any).content?.map((b: any) => b.text ?? '').join('') ?? '';
  const anthOut = parseGrouping(anthText);

  // (b) Cortex-served Claude — same prompts
  const t1 = Date.now();
  const cortexRows = await q(`SELECT SNOWFLAKE.CORTEX.COMPLETE(?, PARSE_JSON(?), PARSE_JSON(?)) AS R`, [
    cortexModel,
    JSON.stringify([{ role: 'system', content: sys }, { role: 'user', content: user + JSON_ONLY_REMINDER }]),
    JSON.stringify({ temperature: 0, max_tokens: 4000 }),
  ]);
  const cortexMs = Date.now() - t1;
  const cortexRaw = cortexRows[0]?.R;
  const cortexBody = typeof cortexRaw === 'string' ? JSON.parse(cortexRaw) : cortexRaw;
  const cortexText = cortexBody?.choices?.[0]?.messages ?? cortexBody?.choices?.[0]?.message?.content ?? '';
  const cortexOut = parseGrouping(String(cortexText));

  console.log(`── ${col} (${n} distinct) ─────────────────────────`);
  console.log(`  anthropic: ${anthOut ? 'valid JSON' : 'PARSE FAIL'} · ${anthOut?.g.length ?? '-'} groups · ${anthMs} ms`);
  console.log(`  cortex:    ${cortexOut ? 'valid JSON' : 'PARSE FAIL'} · ${cortexOut?.g.length ?? '-'} groups · ${cortexMs} ms`);
  if (anthOut && cortexOut) {
    const agreement = pairAgreement(n, partition(n, anthOut), partition(n, cortexOut));
    console.log(`  pairwise same-group agreement: ${(agreement * 100).toFixed(1)}%`);
    const names = (o: ParsedOut) => o.g.map((g) => `"${g[1]}"(${(g[0] ?? []).length})`).join(' ');
    console.log(`  anthropic groups: ${names(anthOut)}`);
    console.log(`  cortex groups:    ${names(cortexOut)}`);
  } else if (cortexOut === null) {
    console.log(`  cortex raw head: ${String(cortexText).slice(0, 300)}`);
  }
  console.log('');
}

await new Promise<void>((res) => conn.destroy(() => res()));
