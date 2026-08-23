import * as fs from 'node:fs';
const SP='/private/tmp/claude-501/-Users-sanjivp27-Documents-projects-data-match/437346b0-3307-449b-833c-8a6b09e3cc65/scratchpad/e2e';
const B='http://localhost:8021';
const COOKIE='prism_session=' + fs.readFileSync(SP+'/cookie.txt','utf8').trim();
let fail=0;
const ok=(n:string,c:boolean,d?:unknown)=>{ if(c) console.log(`E ok    ${n}`); else { fail++; console.log(`E FAIL  ${n}${d!==undefined?' — '+JSON.stringify(d).slice(0,220):''}`);} };
const api=async(p:string,i:any={})=>{const r=await fetch(B+p,{...i,headers:{'Content-Type':'application/json',Cookie:COOKIE,...(i.headers??{})}});const t=await r.text();let b:any=null;try{b=JSON.parse(t);}catch{b=t;}return{status:r.status,body:b};};

const session = fs.readFileSync(SP+'/session.txt','utf8').trim();

// ── OT-EXP-01: CSV ───────────────────────────────────────────────────────────
const csv = await api('/api/one-time/export',{method:'POST',body:JSON.stringify({session,target_fqn:'TEST_DB.PUBLIC.E2E_OT_OUT',mode:'create',format:'csv'})});
ok('OT-EXP-01 csv -> 200', csv.status===200, csv.body?.error ?? csv.status);
const H:string[]=csv.body?.headers??[]; const R:string[][]=csv.body?.rows??[];
ok('csv returns all source rows', R.length===15, R.length);
ok('csv headers preserved', JSON.stringify(H)==='["account_id","carrier","country"]', H);
const byId=(id:string)=>R.find(r=>r[0]===id)??[];
ok('att -> AT&T standardized', /at&t/i.test(String(byId('1002')[1])), byId('1002'));
ok('__proto__ row present and not corrupted', byId('1011').length===3 && String(byId('1011')[1])!=='[object Object]' && String(byId('1011')[1])!=='{}', byId('1011'));
ok('constructor row present and not corrupted', byId('1012').length===3 && String(byId('1012')[1])!=='{}', byId('1012'));
ok('comma value intact', /sprint/i.test(String(byId('1013')[1])), byId('1013'));
ok('empty carrier stays empty', String(byId('1014')[1])==='', JSON.stringify(byId('1014')));
ok('non-standardized column untouched (account_id)', byId('1001')[0]==='1001', byId('1001'));

// ── OT-EXP-01: Excel (same payload shape, client builds the workbook) ────────
const xl = await api('/api/one-time/export',{method:'POST',body:JSON.stringify({session,target_fqn:'TEST_DB.PUBLIC.E2E_OT_OUT',mode:'create',format:'excel'})});
ok('OT-EXP-01 excel -> 200', xl.status===200, xl.body?.error ?? xl.status);
ok('excel returns the same grid', (xl.body?.rows??[]).length===15, (xl.body?.rows??[]).length);

// ── OT-EXP-01: warehouse table ───────────────────────────────────────────────
const wh = await api('/api/one-time/export',{method:'POST',body:JSON.stringify({session,target_fqn:'TEST_DB.PUBLIC.E2E_OT_OUT',mode:'create',format:'warehouse'})});
ok('OT-EXP-01 warehouse -> 200', wh.status===200, wh.body?.error ?? wh.status);
ok('warehouse wrote 15 rows', wh.body?.rows_written===15, wh.body);

// ── OT-EXP-01: Sheets must ask for consent, not fail ─────────────────────────
const sh = await api('/api/one-time/export',{method:'POST',body:JSON.stringify({session,target_fqn:'TEST_DB.PUBLIC.E2E_OT_OUT',mode:'create',format:'sheets'})});
ok('OT-EXP-01 sheets returns needsAuth (401), not an error', sh.status===401 && sh.body?.needsAuth===true, {s:sh.status,b:sh.body});

// ── archive: one row per session even after 3 exports ────────────────────────
const arch = await api('/api/one-time/archive');
const mine=(arch.body?.items??arch.body?.archive??arch.body??[]).filter?.((x:any)=>String(x.source_relation??'').includes('ops07b'))??[];
ok('OT-DUP-01 one archive row despite 3 exports', mine.length===1, mine.length);

// ── OT-SRC-03: paste ─────────────────────────────────────────────────────────
const pasted=['AT&T','att','Verizon','VZW','__proto__','Sprint, Inc.','Télécom'].map(v=>{const o:Record<string,string>=Object.create(null);o['carrier']=v;return o;});
const pc = await api('/api/one-time/create',{method:'POST',body:JSON.stringify({
  source_type:'csv', source_relation:'Pasted values', rows:pasted,
  columns:[{column_name:'carrier',description:'Mobile network operator',standardization_rules:[]}]})});
ok('OT-SRC-03 paste create -> 201', pc.status===201, pc.body?.error ?? pc.status);
const pRun=pc.body?.runs?.[0]?.run_id;
const pg = await api(`/api/one-time/${pRun}/group`,{method:'POST',body:JSON.stringify({})});
ok('OT-SRC-03 paste groups', pg.status===200, pg.body?.error);
await api(`/api/one-time/${pRun}`,{method:'PATCH',body:JSON.stringify({accepted:true})});
const pe = await api('/api/one-time/export',{method:'POST',body:JSON.stringify({session:pc.body.session,target_fqn:'TEST_DB.PUBLIC.E2E_PASTE_OUT',mode:'create',format:'csv'})});
ok('OT-SRC-03 paste exports', pe.status===200 && (pe.body?.rows??[]).length===7, {s:pe.status,n:(pe.body?.rows??[]).length});
fs.writeFileSync(SP+'/session2.txt', String(pc.body?.session ?? ''));
console.log(fail===0?'E PHASE2 PASSED':`E PHASE2 ${fail} FAILED`);
process.exit(0);
