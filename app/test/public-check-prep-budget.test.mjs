import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrations} from '../src/migrate.mjs';
import {migratePublicCheck} from '../src/public-check/migration.mjs';
import {migratePublicCheckBudget} from '../src/public-check/budget-migration.mjs';
import {migratePublicCheckPrepBudget} from '../src/public-check/prep-migration.mjs';
import {publicCheckService} from '../src/public-check/service.mjs';
import {digest} from '../src/public-check/security.mjs';
import {prepPlan,prepReserver} from '../src/public-check/prep-budget.mjs';
import {reserveGuestCall,guestPlan} from '../src/public-check/guest-budget.mjs';
import {scrapeWebsite,inferProfile} from '../src/website-profile/providers.mjs';
import {generateContextQuestions} from '../src/common/context-prompts.mjs';
import {apiBudgetPlan,NANO_USD} from '../src/providers/budget-config.mjs';
import {routesFromEnv} from '../src/providers/routing.mjs';
import {maxHttpAttempts} from '../src/providers/rate-limit.mjs';
import {fixtureGuestBudget} from './guest-budget-fixture.mjs';
import {fixtureBudgetConfig} from './api-budget-fixture.mjs';

const captchaEnv={TURNSTILE_SITE_KEY:'fixture-site',TURNSTILE_SECRET_KEY:'fixture-secret',TURNSTILE_ALLOWED_HOSTNAMES:'app.example.test'};
const captchaFetch=async()=>new Response(JSON.stringify({success:true,action:'public_check',hostname:'app.example.test',challenge_ts:new Date(1791900000000).toISOString()}));
const secret='isolated-fixture-secret-never-a-real-credential-48';
const MODEL='gpt-4.1-mini';
// Synthetic prices exclusively for offline tests; never production values.
function budget({preparation={},...caps}={}){
 const g=JSON.parse(fixtureGuestBudget({ENABLED_PROVIDERS:'openai,gemini'},caps));
 g.preparation={maxStageUsd:1,visitorDailyUsd:5,firecrawl:{requestUsd:0.01},
  identity:{model:MODEL,contextWindowTokens:200000,maxInputBytes:100000,inputUsdPerMillion:0.4,outputUsdPerMillion:1.6},questions:{model:MODEL,contextWindowTokens:200000,maxInputBytes:100000,inputUsdPerMillion:0.4,outputUsdPerMillion:1.6},...preparation};
 for(const k of Object.keys(preparation))if(preparation[k]===undefined)delete g.preparation[k];
 return JSON.stringify(g);
}
const baseEnv={...captchaEnv,OPENROUTER_API_KEY:'fixture-only',PUBLIC_CHECK_ENABLED:'true',PUBLIC_CHECK_PROXY_SECRET:secret,RATE_LIMIT_SECRET:secret,WEBSITE_PROFILE_ENABLED:'true',
 FIRECRAWL_API_KEY:'fixture-only',OPENAI_API_KEY:'fixture-only',ENABLED_PROVIDERS:'openai,gemini'};
const config={enabledProviders:['openai','gemini'],scanPrompts:3};
const site={website:'https://www.example.fi',market:'FI',language:'fi'};
const svProfile={domain:'www.example.se',brand_name:'EXEMPEL',aliases:[],category_fi:'redovisningstjänster för småföretag',market:'SE',language:'sv'};

async function fixture(env={}){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const sql of migrations)sqlite.exec(sql);
 sqlite.exec('CREATE TABLE IF NOT EXISTS app_migrations(id TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
 const execute=async q=>{const s=typeof q==='string'?q:q.sql,args=typeof q==='string'?[]:q.args||[],st=sqlite.prepare(s);
  if(/^\s*(SELECT|PRAGMA)|RETURNING/i.test(s))return {rows:st.all(...args)};return {rows:[],rowsAffected:Number(st.run(...args).changes)};};
 let tail=Promise.resolve();
 const db={execute,transaction:async()=>{let release;const next=new Promise(r=>release=r),prev=tail;tail=next;await prev;sqlite.exec('BEGIN IMMEDIATE');
  return {execute,commit:async()=>sqlite.exec('COMMIT'),rollback:async()=>sqlite.exec('ROLLBACK'),close:release};}};
 await migratePublicCheck(db);await migratePublicCheckBudget(db);await migratePublicCheckPrepBudget(db);
 let time=1791900000000;const net={scrape:0,openai:0};
 const fullEnv={...baseEnv,PUBLIC_CHECK_BUDGET_CONFIG_JSON:budget(),...env};
 // Mirrors scrapeWebsite's contract (reserve, then one request) without DNS.
 const scrape=async(_input,io)=>{if(io.reserve)await io.reserve({stage:'scrape'});net.scrape++;return {text:'Example Oy provides accounting services for small companies in Finland. '.repeat(3),source:'https://www.example.fi/'};};
 const fetcher=async()=>{net.openai++;return new Response(JSON.stringify({model:MODEL,choices:[{message:{content:JSON.stringify({brandName:'Example',aliases:['Example Oy'],categoryFi:'tilitoimistopalvelut pienyrityksille'})}}],usage:{prompt_tokens:1,completion_tokens:1}}));};
 const call=(method,path,body,extra={})=>publicCheckService({db,env:fullEnv,config,now:()=>time,fingerprint:digest(extra.visitor||'visitor-a'),method,path:'/v1/public-check'+path,body:{captcha_token:'fixture-token',...body},deps:{captchaFetch,validateWebsite:async()=>({}),scrape,fetcher,...extra.deps},...(extra.env?{env:{...fullEnv,...extra.env}}:{})});
 const prepRows=()=>sqlite.prepare('SELECT stage,reserved_nano_usd n FROM public_check_prep_reservations ORDER BY rowid').all();
 return {db,sqlite,net,call,prepRows,env:fullEnv,advance:ms=>{time+=ms;},get time(){return time;},close:()=>sqlite.close()};
}
function stubOpenAIQuestions(){
 const original=globalThis.fetch;const calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),body:JSON.parse(init.body)});
  return new Response(JSON.stringify({model:MODEL,choices:[{message:{content:JSON.stringify({questions:['Vilka redovisningsbyråer passar småföretag i Sverige?','Vilka alternativ bör ett småföretag i Sverige jämföra för bokföring?','Vilka leverantörer av redovisningstjänster rekommenderas i Sverige?','Vilka byråer passar en nystartad firma i Sverige?','Hur skiljer sig redovisningstjänster åt i Sverige?','Vilka enkla bokföringstjänster finns i Sverige?']})}}]}),{status:200,headers:{'content-type':'application/json'}});};
 return {calls,restore:()=>{globalThis.fetch=original;}};
}

test('website-first extraction works when configured: one Firecrawl + one OpenAI call, both reserved, retries charge nothing',async()=>{
 const f=await fixture();try{
  const r=await f.call('POST','/prepare',site);
  assert.equal(r.data.draft.brand_name,'Example');
  assert.deepEqual(f.net,{scrape:1,openai:1});
  assert.deepEqual(f.prepRows().map(x=>x.stage),['scrape','identity']);
  await f.call('POST','/prepare',site);// cached draft: no new calls or reservations
  assert.deepEqual(f.net,{scrape:1,openai:1});assert.equal(f.prepRows().length,2);
 }finally{f.close();}
});
test('identity ceiling reserves verified model context plus700output; exact payload is locally bounded',async()=>{
 let seen;const reserve=async req=>{seen=req;return prepPlan(req,{PUBLIC_CHECK_BUDGET_CONFIG_JSON:budget()});};
 let sent;await inferProfile({...site,domain:'www.example.fi'},{text:'x'.repeat(100),source:'https://www.example.fi/'},{env:{OPENAI_API_KEY:'fixture-only'},reserve,
  fetcher:async(_u,init)=>{sent=init.body;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({brandName:'Example',aliases:[],categoryFi:'tilitoimistopalvelut pienyrityksille'})}}]}));}});
 assert.equal(seen.body,sent,'the reserved body is exactly the body sent');
 const p=prepPlan(seen,{PUBLIC_CHECK_BUDGET_CONFIG_JSON:budget()});
 const tokens=200000;
 assert.equal(p.reservedNano,Math.ceil(tokens*0.4*NANO_USD/1e6)+Math.ceil(700*1.6*NANO_USD/1e6));
 assert.equal(p.requests,1);
});
test('a failed preparation is not retried for free and does not double charge on retry or concurrency',async()=>{
 const f=await fixture();try{
  const fail=async()=>{f.net.openai++;return new Response('{}',{status:500});};
  await assert.rejects(f.call('POST','/prepare',site,{deps:{fetcher:fail}}));
  assert.equal(f.prepRows().length,2);
  f.advance(91000);// past the pending window: a retry is allowed by the draft cache
  await assert.rejects(f.call('POST','/prepare',site),e=>e.code==='AI_UNAVAILABLE');
  assert.equal(f.net.scrape,1,'retry did not scrape again');assert.equal(f.prepRows().length,2);
  // Direct concurrency on the stage reserver: one winner per stage key.
  const reserve=prepReserver({db:f.db,fingerprint:'v',requestKey:'k',env:f.env,now:()=>f.time});
  const out=await Promise.allSettled([reserve({stage:'scrape'}),reserve({stage:'scrape'}),reserve({stage:'scrape'})]);
  assert.equal(out.filter(x=>x.status==='fulfilled').length,1);
  assert.ok(out.filter(x=>x.status==='rejected').every(x=>x.reason.reason==='PREP_ALREADY_RESERVED'));
 }finally{f.close();}
});
test('missing preparation prices or caps refuse before any network request',async()=>{
 for(const env of [{PUBLIC_CHECK_BUDGET_CONFIG_JSON:''},{PUBLIC_CHECK_BUDGET_CONFIG_JSON:budget({preparation:{firecrawl:undefined}})},
  {PUBLIC_CHECK_BUDGET_CONFIG_JSON:budget({preparation:{maxStageUsd:null}})},{PUBLIC_CHECK_BUDGET_CONFIG_JSON:budget({preparation:{identity:{model:'other-model',inputUsdPerMillion:1,outputUsdPerMillion:1}}})}]){
  const f=await fixture(env);try{
   await assert.rejects(f.call('POST','/prepare',site),e=>['AI_UNAVAILABLE','APP_NOT_CONFIGURED'].includes(e.code),JSON.stringify(env).slice(0,80));
   if(JSON.parse(env.PUBLIC_CHECK_BUDGET_CONFIG_JSON||'{}').preparation?.firecrawl)assert.equal(f.net.openai,0);else assert.equal(f.net.scrape,0);
  }finally{f.close();}
 }
 // Real adapters: a refused reservation means zero fetches.
 let fetches=0;const refuse=async()=>{throw Object.assign(Error('AI_UNAVAILABLE'),{reason:'X'});};
 await assert.rejects(scrapeWebsite({website:'https://www.example.fi',domain:'www.example.fi'},{env:{FIRECRAWL_API_KEY:'fixture-only'},reserve:refuse,fetcher:async()=>{fetches++;}}));
 await assert.rejects(inferProfile({...site,domain:'www.example.fi'},{text:'x',source:'s'},{env:{OPENAI_API_KEY:'fixture-only'},reserve:refuse,fetcher:async()=>{fetches++;}}));
 const stub=stubOpenAIQuestions();try{await assert.rejects(generateContextQuestions({brandName:'A',aliases:[],ownedDomains:[],categoryFi:'x'},{market:'SE',language:'sv'},{OPENAI_API_KEY:'fixture-only'},{reserve:refuse}));assert.equal(stub.calls.length,0);}finally{stub.restore();}
 assert.equal(fetches,0);
});
test('AI question drafting (non EN/FI) is reserved for every 429 attempt and charged once per preview',async()=>{
 const f=await fixture();const stub=stubOpenAIQuestions();try{
  const r=await f.call('POST','/preview',svProfile);
  assert.equal(r.data.prompts.length,3);assert.equal(stub.calls.length,1);
  const row=f.prepRows();assert.deepEqual(row.map(x=>x.stage),['questions']);
  const p=JSON.parse(f.sqlite.prepare('SELECT plan_json FROM public_check_prep_reservations').get().plan_json);
  assert.equal(p.requests,maxHttpAttempts);assert.equal(p.maxTokens,1800);
  await f.call('POST','/preview',svProfile);assert.equal(stub.calls.length,1);assert.equal(f.prepRows().length,1);
 }finally{stub.restore();f.close();}
});
test('visitor and stage caps refuse before the network',async()=>{
 const f=await fixture({PUBLIC_CHECK_BUDGET_CONFIG_JSON:budget({preparation:{maxStageUsd:0.085,visitorDailyUsd:0.085}})});try{
  // scrape (0.01) fits, identity would exceed the visitor cap -> refused before OpenAI
  await assert.rejects(f.call('POST','/prepare',site),e=>e.code==='PREPARATION_RATE_LIMIT');
  assert.deepEqual(f.net,{scrape:1,openai:0});
 }finally{f.close();}
 const g=await fixture({PUBLIC_CHECK_BUDGET_CONFIG_JSON:budget({preparation:{maxStageUsd:0.005,visitorDailyUsd:5}})});try{
  await assert.rejects(g.call('POST','/prepare',site),e=>e.code==='AI_UNAVAILABLE');// one scrape costs more than a stage may
  assert.deepEqual(g.net,{scrape:0,openai:0});
 }finally{g.close();}
});
test('one rolling daily ceiling covers preparation and scans together',async()=>{
 const env0={ENABLED_PROVIDERS:'openai,gemini'},routes=routesFromEnv(env0);
 const unit=guestPlan({provider:'openai',route:routes.openai,prompt:'Q?',context:{},env:{...env0,PUBLIC_CHECK_BUDGET_CONFIG_JSON:budget()}}).reservedNano;
 // Daily cap = one scan call + 0.015 USD of preparation.
 const daily=(unit+0.015*NANO_USD)/NANO_USD;
 const f=await fixture({PUBLIC_CHECK_BUDGET_CONFIG_JSON:budget({perScanUsd:unit/NANO_USD,dailyUsd:daily,preparation:{visitorDailyUsd:daily}})});try{
  f.sqlite.prepare('INSERT INTO scan_jobs(id,domain,brand_name,status,requested_at) VALUES (?,?,?,?,?)').run('s1','example.fi','Example','processing',1);
  const reserve=prepReserver({db:f.db,fingerprint:'v',requestKey:'k1',env:f.env,now:()=>f.time});
  await reserve({stage:'scrape'});// 0.01 USD of preparation
  assert.ok((await reserveGuestCall(f.db,{scanId:'s1',provider:'openai',promptId:'p1',route:routes.openai,prompt:'Q?',env:f.env,now:f.time})).plan);
  const next=prepReserver({db:f.db,fingerprint:'w',requestKey:'k2',env:f.env,now:()=>f.time});
  await assert.rejects(next({stage:'scrape'}),e=>e.reason==='GUEST_DAILY_BUDGET_EXHAUSTED');
 }finally{f.close();}
});
test('paid/authenticated paths are unchanged: no reserve hook means no reservation and identical requests',async()=>{
 let body;await inferProfile({...site,domain:'www.example.fi'},{text:'x',source:'s'},{env:{OPENAI_API_KEY:'fixture-only'},fetcher:async(_u,i)=>{body=i.body;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({brandName:'E',aliases:[],categoryFi:'tilitoimistopalvelut pienyrityksille'})}}]}));}});
 assert.equal(JSON.parse(body).max_tokens,700);
 const env={OPENROUTER_API_KEY:'fixture-only',ENABLED_PROVIDERS:'openai,gemini'},routes=routesFromEnv(env);
 const paid=apiBudgetPlan({provider:'gemini',route:routes.gemini,prompt:'Q?',context:{},env:{...env,API_BUDGET_CONFIG_JSON:fixtureBudgetConfig(env)}});
 const same=apiBudgetPlan({provider:'gemini',route:routes.gemini,prompt:'Q?',context:{},env:{...env,API_BUDGET_CONFIG_JSON:fixtureBudgetConfig(env),PUBLIC_CHECK_BUDGET_CONFIG_JSON:budget()}});
 assert.deepEqual(same,paid);assert.equal(paid.maxTokens,8192);assert.equal(paid.httpAttempts,undefined);
});

test('autofill capability follows its separate preparation prices and model',async()=>{
 const f=await fixture();try{
  assert.equal((await f.call('GET','/capabilities')).data.autofillEnabled,true);
  const missing=await fixture({PUBLIC_CHECK_BUDGET_CONFIG_JSON:budget({preparation:{identity:undefined}})});
  try{
   const c=(await missing.call('GET','/capabilities')).data;
   assert.equal(c.enabled,true);assert.equal(c.autofillEnabled,false);
   await assert.rejects(missing.call('POST','/prepare',site),e=>e.code==='AI_UNAVAILABLE');
   assert.deepEqual(missing.net,{scrape:0,openai:0});
  }finally{missing.close();}
 }finally{f.close();}
});

test('unknown preparation context or excessive input fails before provider dispatch',async()=>{
 for(const identity of [
  {model:MODEL,inputUsdPerMillion:0.4,outputUsdPerMillion:1.6},
  {model:MODEL,contextWindowTokens:200000,maxInputBytes:1,inputUsdPerMillion:0.4,outputUsdPerMillion:1.6}
 ]){
  let calls=0;const env={...captchaEnv,OPENAI_API_KEY:'fixture-only',PUBLIC_CHECK_BUDGET_CONFIG_JSON:budget({preparation:{identity}})};
  await assert.rejects(inferProfile({...site,domain:'www.example.fi'},{text:'x'.repeat(100),source:'https://www.example.fi/'},{env,
   reserve:async req=>prepPlan(req,env),fetcher:async()=>{calls++;throw Error('must not fetch');}}));
  assert.equal(calls,0);
 }
});
test('guest PDF without parsed markdown stops before paid identity inference',async()=>{
 const f=await fixture();let fetches=0;
 try{
  await assert.rejects(f.call('POST','/prepare',site,{deps:{scrape:scrapeWebsite,fetcher:async(url,options)=>{
   fetches++;assert.equal(url,'https://api.firecrawl.dev/v2/scrape');assert.deepEqual(JSON.parse(options.body).parsers,[]);
   return new Response(JSON.stringify({success:true,data:{rawHtml:'JVBERi0xLjQ='}}),{status:200});
  }}}),/WEBSITE_UNAVAILABLE/);
  assert.equal(fetches,1);assert.deepEqual(f.prepRows().map(row=>row.stage),['scrape']);
 }finally{f.close();}
});

test('two completed guest admissions block a third website preparation before provider expense',async()=>{
 const f=await fixture();try{
  for(let i=0;i<2;i++)f.sqlite.prepare('INSERT INTO rate_events VALUES (?,?,?,?)').run('quota-'+i,digest('visitor-a'),'example.fi',f.time);
  await assert.rejects(f.call('POST','/prepare',site),e=>e.code==='RATE_LIMIT');
  assert.deepEqual(f.net,{scrape:0,openai:0});assert.equal(f.prepRows().length,0);
 }finally{f.close();}
});
