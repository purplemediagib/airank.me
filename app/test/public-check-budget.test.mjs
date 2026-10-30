import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrations} from '../src/migrate.mjs';
import {migratePublicCheckBudget} from '../src/public-check/budget-migration.mjs';
import {migratePublicCheckPrepBudget} from '../src/public-check/prep-migration.mjs';
import {maxHttpAttempts} from '../src/providers/rate-limit.mjs';
import {reserveGuestCall,executeGuestCall,guestBudgetReady,budgetedPublicProviders,readyPublicProviders,guestPlan} from '../src/public-check/guest-budget.mjs';
import {apiBudgetPlan,NANO_USD} from '../src/providers/budget-config.mjs';
import {routesFromEnv,GUEST_OPENROUTER_OUTPUT_TOKENS} from '../src/providers/routing.mjs';
import {fixtureGuestBudget} from './guest-budget-fixture.mjs';
import {fixtureBudgetConfig} from './api-budget-fixture.mjs';

const base={OPENAI_API_KEY:'fixture-only',OPENROUTER_API_KEY:'fixture-only',ENABLED_PROVIDERS:'openai,gemini'};
const routes=routesFromEnv(base);
const PROMPT='Which accounting firms in Finland are recommended?';
async function fixture({migrate=true}={}){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const sql of migrations)sqlite.exec(sql);
 sqlite.exec('CREATE TABLE IF NOT EXISTS app_migrations(id TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
 const execute=async q=>{const s=typeof q==='string'?q:q.sql,args=typeof q==='string'?[]:q.args||[],st=sqlite.prepare(s);
  if(/^\s*(SELECT|PRAGMA)|RETURNING/i.test(s))return {rows:st.all(...args)};return {rows:[],rowsAffected:Number(st.run(...args).changes)};};
 // Serialized write transactions, like libSQL's single writer.
 let tail=Promise.resolve();
 const db={execute,transaction:async()=>{let release;const next=new Promise(r=>release=r),prev=tail;tail=next;await prev;sqlite.exec('BEGIN IMMEDIATE');
  return {execute,commit:async()=>sqlite.exec('COMMIT'),rollback:async()=>sqlite.exec('ROLLBACK'),close:release};}};
 if(migrate){await migratePublicCheckBudget(db);await migratePublicCheckPrepBudget(db);}
 const scan=id=>sqlite.prepare('INSERT INTO scan_jobs(id,domain,brand_name,status,requested_at) VALUES (?,?,?,?,?)').run(id,'example.fi','Example','processing',1);
 return {db,sqlite,scan,close:()=>sqlite.close()};
}
const unit=provider=>guestPlan({provider,route:routes[provider],prompt:PROMPT,context:{},env:{...base,PUBLIC_CHECK_BUDGET_CONFIG_JSON:fixtureGuestBudget(base)}}).reservedNano;
const usd=nano=>nano/NANO_USD;
const reserve=(f,env,{scanId='s1',provider='openai',promptId='p1',now=1_000_000}={})=>reserveGuestCall(f.db,{scanId,provider,promptId,route:routes[provider],prompt:PROMPT,env,now});

function stubOpenRouter(){
 const original=globalThis.fetch,bodies=[];
 globalThis.fetch=async(_url,init)=>{bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({id:'r',model:routes.gemini.model,choices:[{finish_reason:'stop',message:{content:'Answer [1]',annotations:[{type:'url_citation',url_citation:{url:'https://example.fi/a',title:'A'}}]}}],usage:{prompt_tokens:10,completion_tokens:5}}),{status:200,headers:{'content-type':'application/json'}});};
 process.env.OPENROUTER_API_KEY='fixture-key';
 return {bodies,restore:()=>{globalThis.fetch=original;}};
}

test('no guest budget configured: nothing is listed and nothing is reserved or fetched (fail closed)',async()=>{
 const f=await fixture();const stub=stubOpenRouter();try{
  assert.equal(guestBudgetReady('openai',routes.openai,base),false);
  assert.deepEqual(budgetedPublicProviders({enabledProviders:['openai','gemini','claude']},base),[]);
  assert.equal((await reserve(f,base)).reason,'PUBLIC_CHECK_BUDGET_NOT_CONFIGURED');
  f.scan('s1');
  const r=await executeGuestCall({db:f.db,scanId:'s1',provider:'gemini',promptId:'p1',prompt:PROMPT,route:routes.gemini,env:base,timeoutMs:1000});
  assert.equal(r.reserved,false);assert.equal(stub.bodies.length,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM provider_calls').get().n,0);
 }finally{stub.restore();f.close();}
});
test('invalid guest caps are rejected: null, zero, or per-scan above daily',()=>{
 for(const caps of [{perScanUsd:null},{dailyUsd:null},{perScanUsd:0},{perScanUsd:5,dailyUsd:1}])
  assert.equal(guestBudgetReady('openai',routes.openai,{...base,PUBLIC_CHECK_BUDGET_CONFIG_JSON:fixtureGuestBudget(base,caps)}),false,JSON.stringify(caps));
 assert.equal(guestBudgetReady('openai',routes.openai,{...base,PUBLIC_CHECK_BUDGET_CONFIG_JSON:'{bad'}),false);
});
test('ceiling counts full input context, output tokens and web searches',()=>{
 const p=guestPlan({provider:'gemini',route:routes.gemini,prompt:PROMPT,context:{},env:{...base,PUBLIC_CHECK_BUDGET_CONFIG_JSON:fixtureGuestBudget(base)}});
 assert.equal(p.maxTokens,GUEST_OPENROUTER_OUTPUT_TOKENS);
 // Every 429 retry the adapter may make is reserved too.
 const expected=maxHttpAttempts*(Math.ceil(200000*2*NANO_USD/1e6)+Math.ceil(GUEST_OPENROUTER_OUTPUT_TOKENS*3*NANO_USD/1e6)+Math.ceil(p.maxSearches*0.01*NANO_USD));
 assert.equal(p.reservedNano,expected);assert.equal(p.scope,'public_check');
});
test('per-scan money cap stops the call that would exceed it',async()=>{
 const f=await fixture();try{
  f.scan('s1');const env={...base,PUBLIC_CHECK_BUDGET_CONFIG_JSON:fixtureGuestBudget(base,{perScanUsd:usd(unit('openai')*2.5),dailyUsd:1000})};
  assert.ok((await reserve(f,env,{promptId:'p1'})).plan);assert.ok((await reserve(f,env,{promptId:'p2'})).plan);
  assert.equal((await reserve(f,env,{promptId:'p3'})).reason,'GUEST_SCAN_BUDGET_EXHAUSTED');
 }finally{f.close();}
});
test('rolling 24 h guest money cap stops a second scan and frees up after 24 h',async()=>{
 const f=await fixture();try{
  f.scan('a');f.scan('b');const u=unit('openai');
  const env={...base,PUBLIC_CHECK_BUDGET_CONFIG_JSON:fixtureGuestBudget(base,{perScanUsd:usd(u*2),dailyUsd:usd(u*2.5)})};
  assert.ok((await reserve(f,env,{scanId:'a',promptId:'p1'})).plan);assert.ok((await reserve(f,env,{scanId:'a',promptId:'p2'})).plan);
  assert.equal((await reserve(f,env,{scanId:'b',promptId:'p1'})).reason,'GUEST_DAILY_BUDGET_EXHAUSTED');
  assert.ok((await reserve(f,env,{scanId:'b',promptId:'p1',now:1_000_000+86400001})).plan);
 }finally{f.close();}
});
test('concurrent reservations: same key wins once; parallel scans never overshoot the daily cap',async()=>{
 const f=await fixture();try{
  const u=unit('openai');
  const env={...base,PUBLIC_CHECK_BUDGET_CONFIG_JSON:fixtureGuestBudget(base,{perScanUsd:usd(u*2),dailyUsd:usd(u*3)})};
  f.scan('s1');
  const same=await Promise.all([reserve(f,env),reserve(f,env)]);
  assert.equal(same.filter(r=>r.plan).length,1);assert.equal(same.filter(r=>r.reason==='API_BUDGET_ALREADY_RESERVED').length,1);
  for(const id of ['x1','x2','x3','x4'])f.scan(id);
  const many=await Promise.all(['x1','x2','x3','x4'].map(scanId=>reserve(f,env,{scanId})));
  assert.equal(many.filter(r=>r.plan).length,2);// 1 already used + 2 = daily cap of 3
  const total=f.sqlite.prepare('SELECT SUM(reserved_nano_usd) s FROM public_check_api_reservations').get().s;
  assert.ok(total<=u*3);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM provider_calls').get().n,3);
 }finally{f.close();}
});
test('guest execution path makes at most 6 real provider requests per scan, each with the reserved limits',async()=>{
 const f=await fixture();const stub=stubOpenRouter();try{
  f.scan('s1');const env={...base,PUBLIC_CHECK_BUDGET_CONFIG_JSON:fixtureGuestBudget(base)};
  const outcomes=[];
  for(let i=1;i<=7;i++)outcomes.push(await executeGuestCall({db:f.db,scanId:'s1',provider:'gemini',promptId:'p'+i,prompt:PROMPT,route:routes.gemini,env,timeoutMs:1000,maxCalls:12}));
  assert.equal(stub.bodies.length,6);
  assert.equal(outcomes[6].reason,'GUEST_CALL_LIMIT');
  assert.ok(stub.bodies.every(b=>b.max_tokens===GUEST_OPENROUTER_OUTPUT_TOKENS));
  assert.ok(outcomes.slice(0,6).every(o=>o.result.status==='success'&&o.result.citations.length===1));
  // A retried task (same prompt) never dispatches a second paid request.
  const again=await executeGuestCall({db:f.db,scanId:'s1',provider:'gemini',promptId:'p1',prompt:PROMPT,route:routes.gemini,env,timeoutMs:1000});
  assert.equal(again.reason,'API_BUDGET_ALREADY_RESERVED');assert.equal(stub.bodies.length,6);
 }finally{stub.restore();f.close();}
});
test('missing Gemini price: Gemini is not listed and is never called; OpenAI still works',async()=>{
 const f=await fixture();const stub=stubOpenRouter();try{
  const env={...base,PUBLIC_CHECK_BUDGET_CONFIG_JSON:fixtureGuestBudget(base,{providers:['openai']})};
  assert.deepEqual(budgetedPublicProviders({enabledProviders:['openai','gemini']},env),['openai']);
  f.scan('s1');
  const r=await executeGuestCall({db:f.db,scanId:'s1',provider:'gemini',promptId:'p1',prompt:PROMPT,route:routes.gemini,env,timeoutMs:1000});
  assert.equal(r.reason,'API_BUDGET_NOT_CONFIGURED');assert.equal(stub.bodies.length,0);
 }finally{stub.restore();f.close();}
});
test('non-allowlisted providers (Claude) can never get a guest reservation',()=>{
 const env={ENABLED_PROVIDERS:'claude',CLAUDE_MODEL:'fixture-claude'};
 assert.throws(()=>guestPlan({provider:'claude',route:routesFromEnv(env).claude,prompt:PROMPT,context:{},env:{...env,PUBLIC_CHECK_BUDGET_CONFIG_JSON:fixtureGuestBudget(env,{providers:['claude']})}}),/API_BUDGET_UNBOUNDED_ROUTE/);
});
test('paid tracking plans are unchanged and ignore the guest budget',()=>{
 const env={...base,API_BUDGET_CONFIG_JSON:fixtureBudgetConfig(base)};
 for(const provider of ['openai','gemini']){
  const paid=apiBudgetPlan({provider,route:routes[provider],prompt:PROMPT,context:{},env});
  const withGuest=apiBudgetPlan({provider,route:routes[provider],prompt:PROMPT,context:{},env:{...env,PUBLIC_CHECK_BUDGET_CONFIG_JSON:fixtureGuestBudget(base,{inputUsdPerMillion:99})}});
  assert.deepEqual(withGuest,paid);assert.equal(paid.scope,undefined);
 }
 assert.equal(apiBudgetPlan({provider:'gemini',route:routes.gemini,prompt:PROMPT,context:{},env}).maxTokens,8192);
 // Guest config alone never authorises paid calls.
 assert.throws(()=>apiBudgetPlan({provider:'openai',route:routes.openai,prompt:PROMPT,context:{},env:{...base,PUBLIC_CHECK_BUDGET_CONFIG_JSON:fixtureGuestBudget(base)}}),/API_BUDGET_NOT_CONFIGURED/);
});
test('reservation refuses before migration; migration is repeatable and detects drift',async()=>{
 const f=await fixture({migrate:false});try{
  const env={...base,PUBLIC_CHECK_BUDGET_CONFIG_JSON:fixtureGuestBudget(base)};
  assert.equal((await reserve(f,env)).reason,'PUBLIC_CHECK_BUDGET_MIGRATION_REQUIRED');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM provider_calls').get().n,0);
  await migratePublicCheckBudget(f.db);await migratePublicCheckBudget(f.db);await migratePublicCheckPrepBudget(f.db);
  f.sqlite.prepare("UPDATE app_migrations SET checksum='drift' WHERE id='app-023-public-check-api-reservations'").run();
  await assert.rejects(migratePublicCheckBudget(f.db),/checksum mismatch/);
  f.scan('s1');assert.equal((await reserve(f,env)).reason,'PUBLIC_CHECK_BUDGET_MIGRATION_REQUIRED');
 }finally{f.close();}
});

test('API readiness fails closed for missing migration, credentials, provider list or invalid route',async()=>{
 const f=await fixture({migrate:false});try{
  const config={enabledProviders:['openai','gemini']};
  const env={...base,PUBLIC_CHECK_BUDGET_CONFIG_JSON:fixtureGuestBudget(base)};
  assert.deepEqual(await readyPublicProviders(f.db,config,env),[]);
  await migratePublicCheckBudget(f.db);await migratePublicCheckPrepBudget(f.db);
  assert.deepEqual(await readyPublicProviders(f.db,config,env),['openai','gemini']);
  assert.deepEqual(await readyPublicProviders(f.db,config,{...env,OPENAI_API_KEY:'',OPENROUTER_API_KEY:''}),[]);
  assert.deepEqual(await readyPublicProviders(f.db,config,{...env,OPENROUTER_API_KEY:''}),['openai']);
  assert.deepEqual(await readyPublicProviders(f.db,{enabledProviders:[]},env),[]);
  assert.deepEqual(await readyPublicProviders(f.db,config,{...env,OPENROUTER_GEMINI_MODEL:'invalid/model/route'}),[]);
 }finally{f.close();}
});
