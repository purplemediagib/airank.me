import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrations } from '../src/migrate.mjs';
import { migrateApp } from '../src/app/migration.mjs';
import { migrateMonitoring } from '../src/monitoring/migration.mjs';
import {migrateApiBudget} from '../src/monitoring/budget-migration.mjs';
import {fixtureBudgetConfig} from './api-budget-fixture.mjs';
import {apiObservation} from '../src/common/observations.mjs';
import { monitoringService } from '../src/monitoring/service.mjs';
import { createMonitoringEngine } from '../src/monitoring/engine.mjs';
import { reserveQuickCall } from '../src/monitoring/budget.mjs';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {callRoute} from '../src/providers/dispatch.mjs';
import {attachHttpDetails} from '../src/providers/diagnostics.mjs';
import {migrateSuggestions} from '../src/monitoring/suggestions-migration.mjs';
import {migrateContextDrafts} from '../src/common/context-migration.mjs';
import {draftFixture} from './suggestion-fixture.mjs';

async function fixture(extra={},filename=':memory:'){
 let sqlite=new DatabaseSync(filename);sqlite.exec('PRAGMA foreign_keys=ON');
 for(const sql of migrations)sqlite.exec(sql);
 const execute=async q=>{
  const sql=typeof q==='string'?q:q.sql,args=typeof q==='string'?[]:q.args||[],s=sqlite.prepare(sql);
  if(/^\s*(SELECT|PRAGMA)|RETURNING/i.test(sql))return {rows:s.all(...args)};
  return {rows:[],rowsAffected:Number(s.run(...args).changes)};
 };
 let tail=Promise.resolve();
 const db={execute,transaction:async()=>{
  let release;const next=new Promise(r=>release=r),previous=tail;tail=next;await previous;sqlite.exec('BEGIN IMMEDIATE');
  return {execute,commit:async()=>sqlite.exec('COMMIT'),rollback:async()=>sqlite.exec('ROLLBACK'),close:release};
 }};
 sqlite.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run('alice','google-alice','alice@example.test','Alice','',1,1);
 await migrateApp(db);await migrateMonitoring(db);await migrateApiBudget(db);await migrateContextDrafts(db);await migrateSuggestions(db);
 sqlite.prepare('INSERT INTO app_projects VALUES (?,?,?,?,?)').run('project','alice','active',1,1);
 sqlite.prepare('INSERT INTO app_identity_versions VALUES (?,?,?,?)').run('project',1,JSON.stringify({brandName:'Example',aliases:['Example Oy'],ownedDomains:['example.fi'],categoryFi:'suomalaiset matkapuhelinliittymät'}),1);
 const env={TRACKED_PROMPT_LIMIT:'100',MONITORING_ENABLED:'true',ENABLED_PROVIDERS:'openai,claude',OPENAI_MODEL:'fixture-openai',CLAUDE_MODEL:'fixture-claude',MAX_DAILY_PROVIDER_CALLS:'200',MONITORING_PROVIDER_TIMEOUT_MS:'100',...extra};
 env.API_BUDGET_CONFIG_JSON=fixtureBudgetConfig(env);
 let clock=Date.now();
 const now=()=>clock;
 const api=(method,suffix,body,userId='alice',query)=>monitoringService({db,method,path:'/v1/projects/project/'+suffix,body,userId,query,env,now,generate:draftFixture});
 const prompt=(text='Mitkä liittymät sopivat suomalaiselle pienyritykselle?')=>api('POST','prompts',{text,topic:'Yritykset',tags:['hinta'],kind:'neutral'});
 const run=async(kind='neutral',submissionId=randomUUID())=>(await api('POST','monitoring-runs',{submissionId,kind})).data;
 return {db,get sqlite(){return sqlite;},env,now,api,prompt,run,advance:n=>{clock+=n;},close:()=>sqlite.close(),reopen:()=>{sqlite.close();sqlite=new DatabaseSync(filename);sqlite.exec('PRAGMA foreign_keys=ON');}};
}
const rejects=(promise,status)=>assert.rejects(promise,e=>e.status===status);
const success=async(_p,text,route)=>({status:'success',answer:`Example sopii: ${text}`,model:route.model,citations:[{url:'https://example.fi/source'}],observation:apiObservation({complete:true})});
const engine=(f,opts={})=>createMonitoringEngine({db:f.db,env:f.env,now:f.now,call:success,available:()=>true,...opts});

test('future complete uncited monitoring receipts are valid; legacy and failed/truncated receipts remain excluded',async()=>{
 const f=await fixture({ENABLED_PROVIDERS:'openai'});
 try{
  await f.prompt();
  for(const [label,status,complete,expected] of [
   ['complete','no_grounding',true,'success'],
   ['failed','failed',true,'failed'],
   ['truncated','no_grounding',false,'incomplete'],
   ['legacy','no_grounding',true,'no_grounding'],
  ]){
   const run=await f.run();
   const snapshot=JSON.parse(f.sqlite.prepare('SELECT snapshot FROM mon_runs WHERE id=?').get(run.id).snapshot);
   assert.equal(snapshot.collectionMethod,'complete-answer-visibility-v2');
   assert.equal(snapshot.routes[0].measurement_surface,'model_api');
   if(label==='legacy'){
    delete snapshot.collectionMethod;snapshot.methodology='tracked-fi-evidence-v1';
    f.sqlite.prepare('UPDATE mon_runs SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot),run.id);
   }
   await engine(f,{call:async()=>({status,answer:'Example is available.',citations:[],observation:apiObservation({complete})})}).tick();
   const result=(await f.api('GET','monitoring-runs/'+run.id)).data;
   assert.equal(result.evidence[0].status,expected);
   assert.equal(result.evidence[0].observation.complete,complete);
   assert.equal(result.run.valid,expected==='success'?1:0);
  }
 }finally{f.close();}
});

test('prompt versions/archive/restore, neutral validation, filters and owner isolation',async()=>{
 const f=await fixture();try{
  const p=(await f.prompt()).data;
  await rejects(f.prompt(),409);
  await rejects(f.api('POST','prompts',{text:'Onko Example hyvä liittymä?',topic:'',tags:[],kind:'neutral'}),422);
  await rejects(f.api('GET','prompts/'+p.id,undefined,'bob'),404);
  const edit={text:'Mitkä edulliset liittymät toimivat Suomessa?',topic:'Hinta',tags:['hinta'],kind:'neutral',status:'archived',expectedVersion:1};
  await f.api('PATCH','prompts/'+p.id,edit);
  let d=(await f.api('GET','prompts/'+p.id)).data;
  assert.equal(d.versions.length,2);assert.equal(d.versions[1].text,p.text);
  assert.equal((await f.api('GET','prompts',undefined,'alice',new URLSearchParams({status:'archived',tag:'hinta',search:'edulliset'}))).data.total,1);
  await rejects(f.api('PATCH','prompts/'+p.id,edit),409);
  await f.api('PATCH','prompts/'+p.id,{...edit,expectedVersion:2,status:'active'});
  d=(await f.api('GET','prompts/'+p.id)).data;assert.equal(d.versions.length,3);assert.equal(d.prompt.status,'active');
 }finally{f.close();}
});
test('suggestions require review, repeated generation/review deduplicates and rejection persists',async()=>{
 const f=await fixture();try{
  const a=(await f.api('POST','suggestions',{})).data;
  assert.equal(a.length,6);assert.equal((await f.api('GET','prompts')).data.total,0);
  const picked=(await f.api('POST','suggestions/'+a[0].id,{action:'accept'})).data;
  assert.equal((await f.api('POST','suggestions/'+a[0].id,{action:'accept'})).data.promptId,picked.promptId);
  await f.api('POST','suggestions/'+a[1].id,{action:'reject'});
  const again=(await f.api('POST','suggestions',{})).data;
  assert.equal(again.length,6);assert.equal(again.find(s=>s.id===a[1].id).status,'rejected');
  assert.equal((await f.api('GET','prompts')).data.total,1);
 }finally{f.close();}
});
test('run idempotency, immutable prompt/model snapshots and diagnostic separation',async()=>{
 const f=await fixture();try{
  const p=(await f.prompt()).data;
  const diagnostic=(await f.api('POST','prompts',{text:'Miksi Example sopii yritykselle?',topic:'Arviointi',tags:[],kind:'diagnostic'})).data;
  await rejects(f.api('POST','prompts',{text:'Mitkä palvelut sopivat yritykselle?',topic:'',tags:[],kind:'diagnostic'}),422);
  const key=randomUUID(),r=await f.run('neutral',key);
  assert.equal(r.expected,2);assert.equal((await f.run('neutral',key)).id,r.id);
  await rejects(f.run('diagnostic',key),409);
  await f.api('PATCH','prompts/'+p.id,{...p,text:'Mitkä vaihtoehdot sopivat perheille Suomessa?',expectedVersion:1,status:'archived'});
  const snapshot=JSON.parse(f.sqlite.prepare('SELECT snapshot FROM mon_runs WHERE id=?').get(r.id).snapshot);
  assert.equal(snapshot.prompts[0].text,p.text);assert.equal(snapshot.routes[0].model,'fixture-openai');
  const dr=await f.run('diagnostic');
  assert.equal(dr.expected,2);assert.equal(dr.kind,'diagnostic');
  await engine(f).tick();await engine(f).tick();
  const evidence=(await f.api('GET','prompts/'+diagnostic.id)).data.measurements;
  assert.equal(evidence.length,2);assert.ok(evidence.every(e=>e.answer.includes('Example')));
  await rejects(f.api('GET','monitoring-runs/'+r.id,undefined,'bob'),404);
 }finally{f.close();}
});
test('two workers atomically claim and reserve; configured providers overlap without duplicate calls',async()=>{
 const f=await fixture();try{
  await f.prompt();const r=await f.run();
  let active=0,max=0,calls=0;
  const call=async(...args)=>{active++;max=Math.max(max,active);calls++;await new Promise(resolve=>setTimeout(resolve,20));active--;return success(...args);};
  const a=engine(f,{call}),b=engine(f,{call});
  await Promise.all([a.tick(),b.tick()]);await b.tick();
  assert.equal(calls,2);assert.equal(max,2);
  const d=(await f.api('GET','monitoring-runs/'+r.id)).data;
  assert.equal(d.run.status,'complete');assert.equal(d.evidence.length,2);
  await a.tick();assert.equal(calls,2);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_budget').get().n,2);
 }finally{f.close();}
});
test('receipt survives engine restart/storage failure without repeating providers',async()=>{
 const f=await fixture();try{
  await f.prompt();const r=await f.run();let calls=0;
  await engine(f,{call:async(...args)=>{calls++;return success(...args);},storeEvidence:async()=>{throw Error('storage offline');}}).tick();
  assert.equal(calls,2);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_receipts').get().n,2);
  assert.equal((await f.api('GET','monitoring-runs/'+r.id)).data.run.reason,'evidence_storage_pending');
  await engine(f,{call:()=>{throw Error('MUST NOT CALL');}}).tick();
  assert.equal((await f.api('GET','monitoring-runs/'+r.id)).data.run.status,'complete');assert.equal(calls,2);
 }finally{f.close();}
});
test('interrupted executing lease is terminal unknown, not retried; run deadline terminates unstarted tasks',async()=>{
 const f=await fixture();try{
  await f.prompt();const r=await f.run();
  f.sqlite.prepare("UPDATE mon_tasks SET status='executing',lease_until=?,claim_token='crashed' WHERE provider='openai'").run(f.now()-1);
  f.sqlite.prepare('UPDATE mon_runs SET deadline_at=?').run(f.now()-1);
  let calls=0;await engine(f,{call:async()=>{calls++;return {status:'success'};}}).tick();
  const d=(await f.api('GET','monitoring-runs/'+r.id)).data;
  assert.equal(calls,0);assert.equal(d.run.status,'unavailable');
  assert.deepEqual(d.evidence.map(e=>e.status).sort(),['deadline_not_started','interrupted_unknown']);
 }finally{f.close();}
});
test('one provider deadline retains the other answer as partial',async()=>{
 const f=await fixture({MONITORING_PROVIDER_TIMEOUT_MS:'20'});try{
  await f.prompt();const r=await f.run();
  await engine(f,{call:(p,...args)=>p==='claude'?new Promise(()=>{}):success(p,...args)}).tick();
  const d=(await f.api('GET','monitoring-runs/'+r.id)).data;
  assert.equal(d.run.status,'partial');assert.equal(d.run.valid,1);
  assert.equal(d.evidence.find(e=>e.provider==='claude').status,'timeout_unknown');
 }finally{f.close();}
});
test('exhausted budget and oversized panels terminate honestly; panels above old 12-call cap execute',async()=>{
 const f=await fixture();try{
  for(let i=0;i<8;i++)await f.prompt(`Mitkä liittymät sopivat Suomen yritysryhmälle ${i}?`);
  const r=await f.run();assert.equal(r.expected,16);
  let calls=0;const worker=engine(f,{call:async(...args)=>{calls++;return success(...args);}});
  for(let i=0;i<8;i++)await worker.tick();
  assert.equal(calls,16);assert.equal((await f.api('GET','monitoring-runs/'+r.id)).data.run.status,'complete');
  f.env.MAX_DAILY_PROVIDER_CALLS='16';const blocked=await f.run();
  await engine(f,{call:()=>{throw Error('MUST NOT CALL');}}).tick();
  assert.equal((await f.api('GET','monitoring-runs/'+blocked.id)).data.run.status,'capacity_blocked');
  f.env.MONITORING_MAX_TASKS_PER_RUN='10';const large=await f.run();
  assert.equal(large.status,'capacity_blocked');assert.equal(large.reason,'panel_exceeds_monitoring_capacity');
 }finally{f.close();}
});
test('Gemini remains OpenRouter; Google AI Overviews enqueue only through DataForSEO',async()=>{
 const f=await fixture({ENABLED_PROVIDERS:'openai,claude,gemini',OPENROUTER_GEMINI_MODEL:'google/fixture-gemini'});try{
  await f.prompt();const r=await f.run();
  assert.equal(r.routes.find(x=>x.provider==='gemini').transport,'openrouter');
  f.env.ENABLED_PROVIDERS='openai,claude';assert.equal((await f.run()).expected,2);
  f.env.ENABLED_PROVIDERS='google_aio';
  const aio=await f.run();assert.equal(aio.routes[0].transport,'dataforseo');assert.equal(aio.expected,1);
 }finally{f.close();}
});
test('expanded monitoring gates unbounded Agent costs and excludes absent overviews',async()=>{
 const f=await fixture({ENABLED_PROVIDERS:'openai,claude,gemini,grok,perplexity,google_aio'});try{
  await f.prompt();const run=await f.run();assert.equal(run.expected,6);
  const seen=[];
  const worker=engine(f,{call:async(provider,...args)=>{
   seen.push(provider);
   return provider==='google_aio'?{status:'no_overview',answer:'',citations:[]}:success(provider,...args);
  }});
  for(let i=0;i<8;i++)await worker.tick();
  assert.deepEqual([...new Set(seen)].sort(),['claude','gemini','google_aio','grok','openai']);
  const done=(await f.api('GET','monitoring-runs/'+run.id)).data;
  assert.equal(done.run.valid,4);assert.equal(done.evidence.find(x=>x.provider==='google_aio').status,'no_overview');
  assert.equal(done.evidence.find(x=>x.provider==='perplexity').error,'API_BUDGET_UNBOUNDED_ROUTE');
 }finally{f.close();}
});
test('quick-check budget reserves atomically alongside monitoring reservations',async()=>{
 const f=await fixture();try{
  f.sqlite.prepare('INSERT INTO scan_jobs(id,domain,brand_name,status,requested_at) VALUES (?,?,?,?,?)').run('quick','example.fi','Example','queued',f.now());
  const attempt=()=>reserveQuickCall(f.db,{scanId:'quick',provider:'openai',daily:1,perRun:12,now:f.now()});
  const results=await Promise.all([attempt(),attempt()]);
  assert.equal(results.filter(Boolean).length,1);
  f.env.MAX_DAILY_PROVIDER_CALLS='1';await f.prompt();const r=await f.run();await engine(f).tick();
  assert.equal((await f.api('GET','monitoring-runs/'+r.id)).data.run.status,'capacity_blocked');
 }finally{f.close();}
});
test('monitoring migration is repeatable and detects drift',async()=>{
 const f=await fixture();try{
  await migrateMonitoring(f.db);await migrateMonitoring(f.db);
  f.sqlite.prepare("UPDATE app_migrations SET checksum='invalid' WHERE id='app-003-monitoring'").run();
  await assert.rejects(migrateMonitoring(f.db),/checksum mismatch/);
 }finally{f.close();}
});
test('database reopen retains journal and snapshot; fresh worker only flushes stored answers',async()=>{
 const dir=mkdtempSync(tmpdir()+'/airank-monitor-'),f=await fixture({},dir+'/db.sqlite');try{
  await f.prompt();const r=await f.run();
  await engine(f,{storeEvidence:async()=>{throw Error('storage down');}}).tick();
  f.reopen();
  await engine(f,{call:()=>assert.fail('must not reissue requests after restart')}).tick();
  const d=(await f.api('GET','monitoring-runs/'+r.id)).data;
  assert.equal(d.run.status,'complete');assert.equal(d.evidence.length,2);
  assert.equal(d.evidence[0].promptVersion,1);
 }finally{f.close();rmSync(dir,{recursive:true});}
});
test('receipt write failure retries storage with the in-memory response, not the model',async()=>{
 const f=await fixture();try{
  await f.prompt();const r=await f.run();let calls=0,down=true;
  const broken={execute:f.db.execute,transaction:async()=>{const tx=await f.db.transaction();return {...tx,execute:async q=>{
   if(down&&String(q.sql||q).startsWith('INSERT OR IGNORE INTO mon_receipts'))throw Error('receipt storage unavailable');
   return tx.execute(q);
  }};}};
  const worker=createMonitoringEngine({db:broken,env:f.env,now:f.now,available:()=>true,call:async(...args)=>{calls++;return success(...args);}});
  await worker.tick();assert.equal(calls,2);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_receipts').get().n,0);
  down=false;await worker.tick();
  assert.equal(calls,2);assert.equal((await f.api('GET','monitoring-runs/'+r.id)).data.run.status,'complete');
 }finally{f.close();}
});
test('empty provider answer is unavailable, and unsafe configuration cannot bypass limits',async()=>{
 const f=await fixture();try{
  await f.prompt();const r=await f.run();
  await engine(f,{call:async()=>({status:'success',answer:' ',observation:apiObservation({complete:true})})}).tick();
  const d=(await f.api('GET','monitoring-runs/'+r.id)).data;
  assert.equal(d.run.valid,0);assert.equal(d.run.status,'unavailable');
  assert.ok(d.evidence.every(e=>e.status==='no_valid_response'));
  f.env.MONITORING_MAX_TASKS_PER_RUN='not-a-number';await rejects(f.run(),503);
  f.env.MAX_DAILY_PROVIDER_CALLS='not-a-number';assert.throws(()=>engine(f),/APP_NOT_CONFIGURED/);
 }finally{f.close();}
});

test('provider HTTP diagnostics persist through receipt, evidence and owner API without secrets',async()=>{
 const f=await fixture();try{
  await f.prompt();const r=await f.run();const logs=[];
  const worker=engine(f,{logger:(event,data)=>logs.push({event,...data}),call:async(p,...args)=>{
   if(p==='claude')throw attachHttpDetails(Error('private prompt and secret'),403,{error:{type:'permission_error'}},new Headers({'request-id':'request-fixture'}));
   return {...await success(p,...args),meta:{response_id:'response-fixture',usage:{input_tokens:20,output_tokens:40},raw_secret:'hidden'}};
  }});
  await worker.tick();const result=(await f.api('GET','monitoring-runs/'+r.id)).data;
  assert.equal(result.run.status,'partial');assert.equal(result.run.valid,1);
  const failed=result.evidence.find(e=>e.provider==='claude');
  assert.equal(failed.error,'PERMISSION_DENIED');assert.equal(failed.meta.http_status,403);assert.equal(failed.meta.request_id,'request-fixture');
  const ok=result.evidence.find(e=>e.provider==='openai');assert.equal(ok.meta.usage.output_tokens,40);
  assert.ok(!JSON.stringify({result,logs}).includes('private prompt'));assert.ok(!JSON.stringify({result,logs}).includes('raw_secret'));
  assert.equal(logs.filter(e=>e.event==='provider_started').length,2);
 }finally{f.close();}
});

test('fast answer is visible in the database while another provider is still running',async()=>{
 const f=await fixture({MONITORING_PROVIDER_TIMEOUT_MS:'2000'});let release;
 const gate=new Promise(resolve=>release=resolve);
 try{
  await f.prompt();const r=await f.run();let saved;
  const published=new Promise(resolve=>saved=resolve);
  const worker=engine(f,{logger:(event)=>{if(event==='evidence_saved')saved();},call:async(p,...args)=>{
   if(p==='claude')await gate;return success(p,...args);
  }});
  const ticking=worker.tick();await published;
  const midway=(await f.api('GET','monitoring-runs/'+r.id)).data;
  assert.equal(midway.evidence.length,1);assert.equal(midway.evidence[0].provider,'openai');assert.equal(midway.run.status,'running');
  release();await ticking;
  assert.equal((await f.api('GET','monitoring-runs/'+r.id)).data.run.status,'complete');
 }finally{release();f.close();}
});

test('real bounded provider adapters save evidence; unbounded Perplexity is not sent',async()=>{
 const f=await fixture({ENABLED_PROVIDERS:'openai,claude,gemini,grok,perplexity',MONITORING_PROVIDER_TIMEOUT_MS:'2000'});
 const oldFetch=globalThis.fetch,oldKey=process.env.OPENROUTER_API_KEY,requests=[];
 process.env.OPENROUTER_API_KEY='fixture-key';
 globalThis.fetch=async(url,options)=>{
  requests.push({url,body:JSON.parse(options.body)});
  const grounded={id:'fixture-response',status:'completed',model:'returned-model',usage:{input_tokens:10,output_tokens:20},output:[{type:'message',status:'completed',content:[{type:'output_text',text:'Example offers a service.',annotations:[{type:'url_citation',url:'https://example.fi/'}]}]}]};
  const payload=url.includes('anthropic')?{id:'claude-fixture',model:'returned-claude',stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:20},content:[{type:'text',text:'Example offers a service.',citations:[{url:'https://example.fi/'}]}]}:
   url.includes('openrouter')?{id:'gemini-fixture',model:'google/returned-gemini',usage:{prompt_tokens:10,completion_tokens:20},choices:[{finish_reason:'stop',message:{content:'Example offers a service.',annotations:[{type:'url_citation',url_citation:{url:'https://example.fi/'}}]}}]}:grounded;
  return {ok:true,status:200,headers:new Headers(),json:async()=>payload,text:async()=>JSON.stringify(payload)};
 };
 try{
  await f.prompt();const r=await f.run();const worker=engine(f,{call:callRoute,logger:()=>{}});
  for(let i=0;i<3;i++)await worker.tick();
  const done=(await f.api('GET','monitoring-runs/'+r.id)).data;
  assert.equal(done.run.status,'partial');assert.equal(done.run.valid,4);assert.equal(requests.length,4);
  assert.ok(requests.some(r=>r.url==='https://api.x.ai/v1/responses'));
  assert.ok(requests.some(r=>r.url==='https://openrouter.ai/api/v1/chat/completions'));
  assert.ok(!requests.some(r=>r.url==='https://api.perplexity.ai/v1/agent'));
  assert.equal(done.evidence.find(e=>e.provider==='perplexity').error,'API_BUDGET_UNBOUNDED_ROUTE');
  assert.ok(done.evidence.filter(e=>e.provider!=='perplexity').every(e=>e.citations.length===1&&e.mentioned&&e.meta.usage&&e.meta.response_id));
 }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=oldKey;f.close();}
});
