import * as fs from 'node:fs';
const SP='/private/tmp/claude-501/-Users-sanjivp27-Documents-projects-data-match/437346b0-3307-449b-833c-8a6b09e3cc65/scratchpad/e2e';
const B='http://localhost:8021';
const COOKIE='prism_session=' + fs.readFileSync(SP+'/cookie.txt','utf8').trim();
let fail=0;
const ok=(n:string,c:boolean,d?:unknown)=>{ if(c) console.log(`E ok    ${n}`); else { fail++; console.log(`E FAIL  ${n}${d!==undefined?' — '+JSON.stringify(d).slice(0,200):''}`);} };
const api=async(path:string,init:any={})=>{
  const r=await fetch(B+path,{...init,headers:{'Content-Type':'application/json',Cookie:COOKIE,...(init.headers??{})}});
  const t=await r.text(); let b:any=null; try{b=JSON.parse(t);}catch{b=t;}
  return {status:r.status, body:b};
};

// ── Parse the fixture exactly as the browser does ────────────────────────────
const XLSX = await import('xlsx');
const { detectHeaderRow, gridToRows } = await import('../app/api/_lib/table-shape');
const wb = XLSX.read(fs.readFileSync('/Users/sanjivp27/Documents/projects/data_match/ops07b_test_sheet.csv'), { type:'buffer' });
const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header:1, blankrows:true, defval:'' }) as unknown[][];
const det = detectHeaderRow(grid);
ok('OT-SRC-01 header detected on row 5 (idx 4)', det.headerRow===4, det.headerRow);
const parsed = gridToRows(grid, det.headerRow);
ok('OT-SRC-01 headers parsed', JSON.stringify(parsed.headers)==='["account_id","carrier","country"]', parsed.headers);
ok('OT-SRC-01 junk rows excluded', parsed.rows.length===15, parsed.rows.length);

// ── OT-SRC-01: create a CSV-sourced session ──────────────────────────────────
const create = await api('/api/one-time/create',{method:'POST',body:JSON.stringify({
  source_type:'csv', source_relation:'ops07b_test_sheet.csv', rows:parsed.rows,
  columns:[{column_name:'carrier',description:'Mobile network operator',standardization_rules:[]},
           {column_name:'country',description:'Country name',standardization_rules:[]}],
})});
ok('OT-SRC-01 create returns 201', create.status===201, create.body);
const session=create.body?.session; const runs=create.body?.runs ?? [];
ok('OT-SRC-01 one run per column', runs.length===2, runs);
fs.writeFileSync(SP+'/session.txt', String(session ?? ''));

// ── session reports it as a file session ─────────────────────────────────────
const sess = await api(`/api/one-time/session/${session}`);
ok('session marked is_file_session', sess.body?.is_file_session===true, sess.body?.is_file_session);
ok('session lists both columns', (sess.body?.columns??[]).length===2, (sess.body?.columns??[]).length);

// ── group + accept each column ───────────────────────────────────────────────
for (const r of runs) {
  const g = await api(`/api/one-time/${r.run_id}/group`,{method:'POST',body:JSON.stringify({})});
  ok(`group ${r.column_name} -> 200`, g.status===200, g.body?.error ?? g.status);
  const a = await api(`/api/one-time/${r.run_id}`,{method:'PATCH',body:JSON.stringify({accepted:true})});
  ok(`accept ${r.column_name} -> 200`, a.status===200, a.body?.error ?? a.status);
}
// verify __proto__/constructor survived grouping
const one = await api(`/api/one-time/${runs[0].run_id}`);
const vals = JSON.stringify(one.body ?? {});
ok('OT-SRC-01 __proto__ survived grouping', vals.includes('__proto__'), vals.slice(0,120));
ok('OT-SRC-01 constructor survived grouping', vals.includes('constructor'), '');
console.log('E SESSION', session, 'RUNS', runs.map((r:any)=>r.run_id).join(','));
console.log(fail===0?'E PHASE1 PASSED':`E PHASE1 ${fail} FAILED`);
process.exit(0);
