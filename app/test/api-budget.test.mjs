import test from 'node:test';
import assert from 'node:assert/strict';
import {collectorFixture} from './collector-fixture.mjs';
import {fixtureBudgetConfig} from './api-budget-fixture.mjs';
import {migrateApiBudget,id,checksum} from '../src/monitoring/budget-migration.mjs';
import {apiBudgetPlan,completionLimit} from '../src/providers/budget-config.mjs';
import {reserveApiBudget} from '../src/monitoring/budget.mjs';
import {transaction} from '../src/monitoring/shared.mjs';
import {createMonitoringEngine} from '../src/monitoring/engine.mjs';
import {claudeSearch,claudeOutputBudget} from '../src/providers/claude.mjs';
import {callRoute} from '../src/providers/dispatch.mjs';
import {routesFromEnv} from '../src/providers/routing.mjs';
import {apiObservation,collectionMethodVersion} from '../src/common/observations.mjs';

async function fixture(overrides={},migrate=true){
 const f=await collectorFixture({ENABLED_PROVIDERS:'claude',CONSUMER_COLLECTION_PROVIDERS:'',
  CLAUDE_MODEL:'fixture-claude',CLAUDE_MAX_TOKENS:'4096',MONITORING_PROVIDER_TIMEOUT_MS:'500',
  MAX_DAILY_PROVIDER_CALLS:'100',...overrides});
 if(migrate)await migrateApiBudget(f.db);
 if(!Object.hasOwn(overrides,'API_BUDGET_CONFIG_JSON'))f.env.API_BUDGET_CONFIG_JSON=fixtureBudgetConfig(f.env);
 return f;
}
const rows=f=>f.sqlite.prepare('SELECT * FROM mon_api_reservations ORDER BY task_id').all();
const success=async(_p,_text,route)=>({status:'success',model:route.model,answer:'Example is cited.',citations:[{url:'https://example.com'}],observation:apiObservation({complete:true})});
const worker=(f,options={})=>createMonitoringEngine({db:f.db,env:f.env,now:f.now,available:()=>true,call:success,logger:()=>{},...options});
const evidence=f=>f.sqlite.prepare('SELECT payload FROM mon_evidence').all().map(r=>JSON.parse(r.payload));
async function mockFetch(replies,fn){
 const old=globalThis.fetch,requests=[];
 globalThis.fetch=async(url,init)=>{
  requests.push({url,body:JSON.parse(init.body)});
  assert.ok(replies.length,'Unexpected paid request');
  const reply=replies.shift();if(reply instanceof Error)throw reply;
  return {ok:true,status:200,text:async()=>JSON.stringify(reply),json:async()=>reply,headers:new Headers()};
 };
 try{return await fn(requests);}finally{globalThis.fetch=old;}
}
const response=(stop_reason,text='Example answer')=>({stop_reason,usage:{output_tokens:400},model:'fixture-claude',content:[{type:'text',text,citations:[{url:'https://example.com'}]}]});

test('reservation includes two full input contexts, both output allowances and six searches before dispatch',async()=>{
 const f=await fixture();try{
  await f.run();let paid=0;
  await worker(f,{call:async(...args)=>{
   paid++;const [reservation]=rows(f),plan=JSON.parse(reservation.config_json);
   assert.equal(reservation.reserved_nano_usd,884576000);
   assert.equal(plan.maxRequests,2);assert.equal(plan.maxTokens,4096);assert.equal(plan.maxSearches,3);
   assert.equal(f.sqlite.prepare('SELECT status FROM mon_tasks').get().status,'executing');
   return success(...args);
  }}).tick();
  assert.equal(paid,1);assert.equal(rows(f).length,1);
  assert.equal(evidence(f)[0].meta.api_budget_mode,'monetary_reserved');
  assert.equal(evidence(f)[0].meta.api_reserved_nano_usd,884576000);
 }finally{f.close();}
});

test('two concurrent workers dispatch once; duplicate reservation never authorizes another request',async()=>{
 const f=await fixture();try{
  await f.run();let paid=0;
  const call=async(...args)=>{paid++;return success(...args);};
  await Promise.all([worker(f,{call}).tick(),worker(f,{call}).tick()]);
  const task=f.sqlite.prepare('SELECT t.*,r.snapshot FROM mon_tasks t JOIN mon_runs r ON r.id=t.run_id').get();
  const duplicate=await transaction(f.db,tx=>reserveApiBudget(tx,task,f.env,f.now()));
  assert.equal(duplicate.reason,'API_BUDGET_ALREADY_RESERVED');
  assert.equal(rows(f).length,1);assert.equal(paid,1);
 }finally{f.close();}
});

test('concurrent tasks cannot overspend the rolling monetary budget, independently of call caps',async()=>{
 const f=await fixture();try{
  f.env.API_BUDGET_CONFIG_JSON=fixtureBudgetConfig(f.env,{dailyUsd:1});
  await f.run();await f.run();let paid=0;
  await Promise.all([worker(f,{call:async(...args)=>{paid++;return success(...args);}}).tick(),worker(f).tick()]);
  assert.equal(rows(f).length,1);assert.ok(paid<=1);
  assert.equal(evidence(f).filter(e=>e.error==='API_BUDGET_EXHAUSTED').length,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_budget').get().n,1);
 }finally{f.close();}
});

test('each configured API route requires prices and a budget; no logical-call dollar fiction',async()=>{
 for(const provider of ['openai','claude','gemini','grok','perplexity','google_aio']){
  const f=await fixture({ENABLED_PROVIDERS:provider,API_BUDGET_CONFIG_JSON:''});try{
   await f.run();await worker(f,{call:()=>assert.fail('unpriced paid request')}).tick();
   assert.equal(rows(f).length,0);
   assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_budget').get().n,0);
   assert.equal(evidence(f)[0].error,'API_BUDGET_NOT_CONFIGURED');
  }finally{f.close();}
 }
});

test('legacy Claude <=1400 is explicitly call-cap-only, but higher tokens cannot bypass missing configuration',async()=>{
 const f=await fixture({CLAUDE_MAX_TOKENS:'1400',API_BUDGET_CONFIG_JSON:''},false);try{
  await f.run();await worker(f).tick();
  assert.equal(evidence(f)[0].meta.api_budget_mode,'legacy_call_cap_only');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_budget').get().n,1);
  f.env.CLAUDE_MAX_TOKENS='1401';await f.run();
  await worker(f,{call:()=>assert.fail('increased allowance without prices')}).tick();
  assert.equal(evidence(f).find(e=>e.status==='unconfigured').error,'API_BUDGET_NOT_CONFIGURED');
 }finally{f.close();}
 await mockFetch([],async requests=>{
  await assert.rejects(claudeSearch('Question',{maxTokens:4096}),/RESERVATION_REQUIRED/);
  assert.equal(requests.length,0);
 });
});

test('Claude reservation planning and adapter configuration share defaults and legacy alias precedence',()=>{
 const route={transport:'direct',model:'fixture-claude'};
 for(const env of [
  {},{CLAUDE_MAX_OUTPUT_TOKENS:'4096'},
  {CLAUDE_MAX_TOKENS:'1400',CLAUDE_MAX_OUTPUT_TOKENS:'8192'},
  {CLAUDE_MAX_TOKENS:'4096',CLAUDE_MAX_OUTPUT_TOKENS:'bad'},
 ]){
  assert.equal(completionLimit('claude',route,env),claudeOutputBudget(env));
 }
 assert.equal(completionLimit('claude',route,{}),1400);
 for(const env of [{CLAUDE_MAX_OUTPUT_TOKENS:'bad'},{CLAUDE_MAX_TOKENS:'',CLAUDE_MAX_OUTPUT_TOKENS:'4096'}])
  assert.throws(()=>completionLimit('claude',route,env),/API_BUDGET_INVALID_CONFIG/);
});

test('a high legacy alias cannot bypass prices and is frozen into the committed reservation',async()=>{
 const f=await fixture({CLAUDE_MAX_OUTPUT_TOKENS:'4096',API_BUDGET_CONFIG_JSON:''});try{
  delete f.env.CLAUDE_MAX_TOKENS;
  await f.run();await worker(f,{call:()=>assert.fail('unreserved legacy alias request')}).tick();
  assert.equal(rows(f).length,0);
  assert.equal(evidence(f)[0].error,'API_BUDGET_NOT_CONFIGURED');
  f.env.API_BUDGET_CONFIG_JSON=fixtureBudgetConfig(f.env);
  await f.run();
  await mockFetch([response('end_turn')],async requests=>{
   await worker(f,{call:async(...args)=>{
    f.env.CLAUDE_MAX_OUTPUT_TOKENS='16384';
    return callRoute(...args);
   }}).tick();
   assert.equal(requests.length,1);
   assert.equal(requests[0].body.max_tokens,4096);
  });
  assert.equal(JSON.parse(rows(f)[0].config_json).maxTokens,4096);
 }finally{f.close();}
});

test('migration is idempotent, checksum checked, and missing migration blocks paid requests',async()=>{
 const f=await fixture({},false);try{
  await f.run();await worker(f,{call:()=>assert.fail('migration missing')}).tick();
  assert.equal(evidence(f)[0].error,'API_BUDGET_MIGRATION_REQUIRED');
  await migrateApiBudget(f.db);await migrateApiBudget(f.db);
  assert.equal(f.sqlite.prepare('SELECT checksum FROM app_migrations WHERE id=?').get(id).checksum,checksum);
  f.sqlite.prepare("UPDATE app_migrations SET checksum='drift' WHERE id=?").run(id);
  await assert.rejects(migrateApiBudget(f.db),/checksum mismatch/);
  await f.run();await worker(f,{call:()=>assert.fail('checksum drift')}).tick();
  assert.equal(evidence(f).at(-1).error,'API_BUDGET_MIGRATION_REQUIRED');
 }finally{f.close();}
});

test('invalid config and wrong model/search route fail closed before dispatch',async()=>{
 const f=await fixture();try{
  const valid=JSON.parse(f.env.API_BUDGET_CONFIG_JSON);
  const changes=[
   c=>{c.dailyUsd=0;},c=>{c.dailyUsd='1';},c=>{c.dailyUsd=-1;},
   c=>{c.routes.claude.inputUsdPerMillion=-1;},c=>{delete c.routes.claude.outputUsdPerMillion;},
   c=>{c.routes.claude.searchUsdPerCall=null;},c=>{c.routes.claude.contextWindowTokens=1.5;},
   c=>{c.routes.claude.maxInputBytes=999999;},c=>{c.routes.claude.maxReplayBytes=0;},
   c=>{c.routes.claude.model='wrong';},c=>{c.routes=[];},
  ];
  for(const mutate of changes){
   const config=structuredClone(valid);mutate(config);f.env.API_BUDGET_CONFIG_JSON=JSON.stringify(config);
   await f.run();await worker(f,{call:()=>assert.fail('invalid configuration')}).tick();
  }
  for(const raw of ['broken','null','[]','{"dailyUsd":1,"routes":"bad"}']){
   f.env.API_BUDGET_CONFIG_JSON=raw;await f.run();await worker(f,{call:()=>assert.fail('invalid JSON')}).tick();
  }
  assert.equal(rows(f).length,0);
  assert.ok(evidence(f).every(e=>['API_BUDGET_INVALID_CONFIG','API_BUDGET_ROUTE_MISMATCH'].includes(e.error)));
  const route={transport:'openrouter',model:'google/test',search_engine:'native'};
  const env={API_BUDGET_CONFIG_JSON:JSON.stringify({dailyUsd:1,routes:{gemini:{...valid.routes.claude,transport:'openrouter',model:route.model,searchEngine:'exa'}}})};
  assert.throws(()=>apiBudgetPlan({provider:'gemini',route,prompt:'Question',context:{},env}),/ROUTE_MISMATCH/);
 }finally{f.close();}
});

test('initial input and continuation replay are byte bounded; no retry or extra continuation',async()=>{
 const f=await fixture();try{
  const config=JSON.parse(f.env.API_BUDGET_CONFIG_JSON);
  config.routes.claude.maxInputBytes=1;f.env.API_BUDGET_CONFIG_JSON=JSON.stringify(config);
  await f.run();await worker(f,{call:()=>assert.fail('input too large')}).tick();
  assert.equal(rows(f).length,0);assert.equal(evidence(f)[0].error,'API_INPUT_LIMIT');
  config.routes.claude.maxInputBytes=10000;config.routes.claude.maxReplayBytes=1;
  f.env.API_BUDGET_CONFIG_JSON=JSON.stringify(config);await f.run();
  await mockFetch([response('pause_turn')],async requests=>{
   await worker(f,{call:callRoute}).tick();
   assert.equal(requests.length,1);
   assert.equal(evidence(f).find(e=>e.status==='incomplete').error,'CONTINUATION_INPUT_LIMIT');
  });
  assert.equal(rows(f).length,1);
 }finally{f.close();}
 const f2=await fixture();try{
  await f2.run();
  await mockFetch([response('pause_turn'),response('pause_turn')],async requests=>{
   await worker(f2,{call:callRoute}).tick();await worker(f2,{call:callRoute}).tick();
   assert.equal(requests.length,2);assert.deepEqual(requests.map(r=>r.body.max_tokens),[4096,3696]);
   assert.deepEqual(requests.map(r=>r.body.tools[0].max_uses),[3,3]);
   assert.equal(evidence(f2)[0].error,'CONTINUATION_LIMIT');
  });
  assert.equal(rows(f2)[0].reserved_nano_usd,884576000);
 }finally{f2.close();}
});

test('configuration is frozen at claim despite live environment mutation',async()=>{
 const f=await fixture();try{
  await f.run();
  await mockFetch([response('pause_turn'),response('end_turn')],async requests=>{
   await worker(f,{call:async(...args)=>{
    f.env.CLAUDE_MAX_TOKENS='16384';f.env.API_BUDGET_CONFIG_JSON='broken';
    return callRoute(...args);
   }}).tick();
   assert.deepEqual(requests.map(r=>r.body.max_tokens),[4096,3696]);
  });
  assert.equal(JSON.parse(rows(f)[0].config_json).maxTokens,4096);
 }finally{f.close();}
});

test('failed and ambiguous calls retain full reservation and are never silently retried/refunded',async()=>{
 for(const result of ['throw','timeout_unknown','provider_failed','incomplete']){
  const f=await fixture();try{
   await f.run();let paid=0;
   const engine=worker(f,{call:async()=>{
    paid++;if(result==='throw')throw Error('request outcome unknown');
    return {status:result,answer:'Partial',citations:[]};
   }});
   await engine.tick();await engine.tick();await worker(f,{call:()=>assert.fail('reissued failure')}).tick();
   assert.equal(paid,1);assert.equal(rows(f)[0].reserved_nano_usd,884576000);
  }finally{f.close();}
 }
});

test('existing logical daily cap still blocks before monetary reservation',async()=>{
 const f=await fixture({MAX_DAILY_PROVIDER_CALLS:'0'});try{
  await f.run();await worker(f,{call:()=>assert.fail('logical cap bypass')}).tick();
  assert.equal(rows(f).length,0);assert.equal(evidence(f)[0].status,'budget_blocked');
 }finally{f.close();}
});

test('a failed claim rolls back monetary and logical reservations before any dispatch',async()=>{
 const f=await fixture();try{
  await f.run();
  const broken={execute:f.db.execute,transaction:async()=>{
   const tx=await f.db.transaction();
   return {...tx,execute:async query=>{
    if(String(query.sql||query).startsWith('INSERT INTO mon_budget'))throw Error('claim persistence failed');
    return tx.execute(query);
   }};
  }};
  await assert.rejects(worker(f,{db:broken,call:()=>assert.fail('uncommitted claim dispatched')}).tick(),/claim persistence failed/);
  assert.equal(rows(f).length,0);
  assert.equal(f.sqlite.prepare('SELECT status FROM mon_tasks').get().status,'queued');
  await worker(f).tick();assert.equal(rows(f).length,1);
 }finally{f.close();}
});

test('interrupted executing task with no receipt retains money and is never resubmitted',async()=>{
 const f=await fixture();try{
  await f.run();
  const task=f.sqlite.prepare('SELECT t.*,r.snapshot FROM mon_tasks t JOIN mon_runs r ON r.id=t.run_id').get();
  await transaction(f.db,async tx=>{
   const reservation=await reserveApiBudget(tx,task,f.env,f.now());
   const route={...JSON.parse(task.route),api_budget:reservation.plan};
   await tx.execute({sql:"UPDATE mon_tasks SET route=?,status='executing',claim_token='interrupted',lease_until=? WHERE id=?",args:[JSON.stringify(route),f.now()-1,task.id]});
   await tx.execute({sql:'INSERT INTO mon_budget VALUES (?,?)',args:[task.id,f.now()]});
  });
  await worker(f,{call:()=>assert.fail('reissued ambiguous task')}).tick();
  assert.equal(rows(f).length,1);assert.equal(rows(f)[0].reserved_nano_usd,884576000);
  assert.equal(evidence(f)[0].status,'interrupted_unknown');
 }finally{f.close();}
});

test('upward integer rounding never turns a positive explicitly-priced request into a zero reservation',()=>{
 const env={ENABLED_PROVIDERS:'claude',CLAUDE_MAX_TOKENS:'4096'};
 env.API_BUDGET_CONFIG_JSON=fixtureBudgetConfig(env,{inputUsdPerMillion:1e-20,outputUsdPerMillion:1e-20,searchUsdPerCall:1e-20});
 const plan=apiBudgetPlan({provider:'claude',route:routesFromEnv(env).claude,prompt:'Question',context:{},env});
 assert.equal(plan.reservedNano,6);
});

test('supported routes have explicit conservative plans; unbounded Agent fails closed',()=>{
 const env={ENABLED_PROVIDERS:'openai,claude,gemini,grok,perplexity,google_aio'};
 env.API_BUDGET_CONFIG_JSON=fixtureBudgetConfig(env);
 for(const [provider,route]of Object.entries(routesFromEnv(env))){
  const plan=()=>apiBudgetPlan({provider,route,prompt:'Question',context:{},env});
  if(provider==='perplexity')assert.throws(plan,/UNBOUNDED_ROUTE/);
  else{
   const budget=plan();assert.equal(budget.mode,'monetary_reserved');assert.ok(budget.reservedNano>0);
   assert.equal(budget.maxRequests,provider==='claude'?2:1);
  }
 }
});

test('engine persists reconciled observations alongside money labels without upgrading truncated or legacy answers',async()=>{
 for(const [method,answer,complete,expected]of [
  [collectionMethodVersion,'Finished uncited answer',true,'success'],
  [collectionMethodVersion,'Unfinished answer',false,'incomplete'],
  [collectionMethodVersion,'x'.repeat(100001),true,'incomplete'],
  ['citation-required-v1','Legacy uncited answer',true,'no_grounding'],
 ]){
  const f=await fixture();try{
   await f.run();
   const run=f.sqlite.prepare('SELECT id,snapshot FROM mon_runs').get();
   const snapshot={...JSON.parse(run.snapshot),collectionMethod:method};
   f.sqlite.prepare('UPDATE mon_runs SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot),run.id);
   await worker(f,{call:async()=>({status:'no_grounding',answer,citations:[],observation:apiObservation({complete})})}).tick();
   const [saved]=evidence(f);
   assert.equal(saved.status,expected);assert.ok(saved.answer.length<=100000);
   assert.equal(saved.observation.complete,complete&&answer.length<=100000);
   assert.equal(saved.meta.api_budget_mode,'monetary_reserved');
   assert.equal(rows(f).length,1);
  }finally{f.close();}
 }
});
