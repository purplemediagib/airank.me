import test from 'node:test';
import assert from 'node:assert/strict';
import {apiBudgetPlan} from '../src/providers/budget-config.mjs';
import {executeMonitoringCall} from '../src/monitoring/recovery.mjs';
import {createMonitoringEngine} from '../src/monitoring/engine.mjs';
import {usedCalls} from '../src/monitoring/budget.mjs';
import {collectorFixture} from './collector-fixture.mjs';
import {fixtureBudgetConfig} from './api-budget-fixture.mjs';
import {migrateApiBudget} from '../src/monitoring/budget-migration.mjs';
import {recoveryReason} from '../src/providers/recovery-policy.mjs';
import {fetchRateLimited} from '../src/providers/rate-limit.mjs';
import {providerFailure,safeProviderMeta} from '../src/providers/diagnostics.mjs';
import {claudeSearch} from '../src/providers/claude.mjs';
import {googleAioSearch} from '../src/providers/google-aio.mjs';
import {apiObservation} from '../src/common/observations.mjs';
import {callRoute} from '../src/providers/dispatch.mjs';

const route={transport:'openrouter',model:'deepseek/deepseek-v3.2',search_engine:'exa'};
const env={ENABLED_PROVIDERS:'deepseek',OPENROUTER_MODELS_JSON:JSON.stringify({deepseek:route.model}),OPENROUTER_SEARCH_ENGINE:'exa',MONITORING_RECOVERY_ENABLED:'true'};
env.API_BUDGET_CONFIG_JSON=fixtureBudgetConfig(env);
const plan=(overrides={})=>apiBudgetPlan({provider:'deepseek',route,prompt:'Which tools?',context:{},env:{...env,...overrides}});
const good={status:'success',answer:'Complete final answer.',citations:[{url:'https://example.com/'}],observation:apiObservation({complete:true}),meta:{request_attempts:1,usage:{input_tokens:20,output_tokens:30},cost:0.01}};
const failed=code=>({status:'failed',answer:'Partial first answer.',citations:[{url:'https://invalid.example/'}],observation:apiObservation({complete:false}),meta:{failure_code:code,request_attempts:1,usage:{input_tokens:10,output_tokens:20},cost:0.02}});
async function run(replies,extra={}){
 let clock=0;const calls=[];
 const result=await executeMonitoringCall({provider:'deepseek',prompt:'Which tools?',route:{...route,api_budget:plan()},context:{},timeoutMs:120000,deadline:302000,
  now:()=>clock,sleep:async ms=>{clock+=ms;},call:async(...args)=>{calls.push(args);const reply=replies.shift();if(reply instanceof Error)throw reply;return structuredClone(reply);},...extra});
 return {result,calls};
}

test('tracking recovery reserves the larger second sequence before dispatch and leaves explicit cap unchanged',()=>{
 const normal=plan({MONITORING_RECOVERY_ENABLED:'false'}),withRecovery=plan();
 assert.equal(normal.maxTokens,4096);assert.equal(withRecovery.maxTokens,4096);
 assert.equal(withRecovery.recovery.maxTokens,8192);assert.equal(withRecovery.recovery.recovery,undefined);
 assert.equal(withRecovery.reservedNano,normal.reservedNano+withRecovery.recovery.reservedNano);
 assert.equal(withRecovery.dailyNano,normal.dailyNano);
 assert.equal(plan({MONITORING_RECOVERY_ENABLED:undefined}).recovery,undefined);
 assert.throws(()=>plan({MONITORING_RECOVERY_ENABLED:'yes'}),/INVALID_CONFIG/);
 const config=JSON.parse(env.API_BUDGET_CONFIG_JSON);config.routes.deepseek.contextWindowTokens=5000;config.routes.deepseek.maxInputBytes=4000;
 assert.equal(plan({API_BUDGET_CONFIG_JSON:JSON.stringify(config)}).recovery.maxTokens,5000);
 assert.equal(plan({OPENROUTER_MAX_TOKENS:'12000'}).recovery.maxTokens,16384);
});

test('guest planning explicitly excludes recovery even when tracking is enabled',()=>{
 const e={...env,PUBLIC_CHECK_BUDGET_CONFIG_JSON:JSON.stringify({...JSON.parse(env.API_BUDGET_CONFIG_JSON),perScanUsd:20,dailyUsd:100})};
 const p=apiBudgetPlan({provider:'deepseek',route,prompt:'Which tools?',context:{},env:e,guest:{providers:['deepseek'],openrouterOutputTokens:2048}});
 assert.equal(p.scope,'public_check');assert.equal(p.maxTokens,2048);assert.equal(p.recovery,undefined);
});

test('only output truncation enlarges recovery tokens; final answer/citations never concatenate failed evidence',async()=>{
 const {result,calls}=await run([failed('OUTPUT_TOKEN_LIMIT'),good]);
 assert.deepEqual(calls.map(c=>c[2].api_budget.maxTokens),[4096,8192]);
 assert.deepEqual(calls.map(c=>c[2].model),[route.model,route.model]);
 assert.equal(result.answer,good.answer);assert.deepEqual(result.citations,good.citations);
 assert.equal(result.meta.answer_attempts,2);assert.equal(result.meta.request_attempts,2);assert.equal(result.meta.cost,0.03);
 assert.equal(result.meta.initial_failure_code,'OUTPUT_TOKEN_LIMIT');assert.equal(result.meta.usage.attempts.attempt_0.input_tokens,10);
 assert.equal(safeProviderMeta(result.meta).recovery_retries,1);
 for(const first of [failed('EMPTY_ANSWER'),{...failed('PROVIDER_UNAVAILABLE'),meta:{failure_code:'PROVIDER_UNAVAILABLE',http_status:503}},new DOMException('Expired','TimeoutError')]){
  const r=await run([first,good]);assert.equal(r.calls.length,2);assert.equal(r.calls[1][2].api_budget.maxTokens,4096);
  assert.equal(r.calls[0][3],120000);assert.equal(r.calls[1][3],180000);
 }
});

test('one retry only; auth/payment/refusal/unknown failures and valid uncited responses are terminal',async()=>{
 const two=await run([failed('EMPTY_ANSWER'),failed('EMPTY_ANSWER')]);assert.equal(two.calls.length,2);assert.equal(two.result.status,'failed');
 for(const first of [good,{...good,status:'no_grounding',citations:[]},{status:'no_overview'},...['AUTHENTICATION_FAILED','PAYMENT_REQUIRED','REFUSED','INVALID_REQUEST','RATE_LIMITED','PROVIDER_REQUEST_FAILED','INCOMPLETE_RESPONSE'].map(failed),
  {...failed('WEB_SEARCH_FAILED'),meta:{failure_code:'WEB_SEARCH_FAILED',upstream_error_code:'non_retryable_search_error'}}]){
  const r=await run([first]);assert.equal(r.calls.length,1);
 }
 const capped=await run([failed('OUTPUT_TOKEN_LIMIT')],{route:{...route,api_budget:plan({OPENROUTER_MAX_TOKENS:'16384'})}});
 assert.equal(capped.calls.length,1);assert.equal(capped.result.meta.retry_blocked,'OUTPUT_LIMIT_ALREADY_MAXIMUM');
});

test('unknown cost on either attempt is not presented as a known combined total',async()=>{
 const first=failed('EMPTY_ANSWER');delete first.meta.cost;
 const {result}=await run([first,good]);assert.equal(result.meta.cost,null);assert.equal(safeProviderMeta(result.meta).cost,undefined);
});

test('deadlines, ownership changes and unresolved watchdog prevent replay; late completion cannot change evidence',async()=>{
 const expired=await run([failed('EMPTY_ANSWER')],{deadline:1500});assert.equal(expired.calls.length,1);assert.equal(expired.result.meta.retry_blocked,'RUN_DEADLINE_EXCEEDED');
 const unowned=await run([failed('EMPTY_ANSWER')],{canRetry:async()=>false});assert.equal(unowned.calls.length,1);
 let count=0,release;
 const unresolved=await run([],{timeoutMs:10,deadline:Date.now()+4000,now:Date.now,call:()=>{count++;return new Promise(r=>release=r);}});
 assert.equal(count,1);assert.equal(unresolved.result.meta.retry_blocked,'ATTEMPT_UNSETTLED');
 release(good);await new Promise(r=>setImmediate(r));assert.equal(count,1);assert.equal(unresolved.result.status,'timeout_unknown');
});

test('HTTP 429 backoff timeout preserves rate-limit provenance and never launches outer recovery',async()=>{
 await assert.rejects(fetchRateLimited('https://fixture.test',{}, {fetchImpl:async()=>new Response('',{status:429}),sleep:async()=>{throw new DOMException('Expired','AbortError');}}),error=>{
  const failure=providerFailure(error);assert.equal(failure.meta.failure_code,'RATE_LIMITED');assert.equal(failure.meta.http_status,429);assert.equal(recoveryReason(failure),null);return true;
 });
});

async function fixture(extra={}){
 const f=await collectorFixture({...env,CONSUMER_COLLECTION_PROVIDERS:'',MONITORING_PROVIDER_TIMEOUT_MS:'500',MAX_DAILY_PROVIDER_CALLS:'100',...extra});
 await migrateApiBudget(f.db);return f;
}
const evidence=f=>JSON.parse(f.sqlite.prepare('SELECT payload FROM mon_evidence ORDER BY observed_at DESC LIMIT 1').get().payload);
test('engine enforces both upfront dollar and call ceilings; no paid attempt when either is insufficient',async()=>{
 for(const extra of [{API_BUDGET_CONFIG_JSON:fixtureBudgetConfig(env,{dailyUsd:0.6})},{MAX_DAILY_PROVIDER_CALLS:'1'}]){
  const f=await fixture(extra);try{
   await f.run();await createMonitoringEngine({db:f.db,env:f.env,now:f.now,available:()=>true,call:()=>assert.fail('unreserved paid call'),logger:()=>{}}).tick();
   assert.equal(evidence(f).status,'budget_blocked');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_api_reservations').get().n,0);
  }finally{f.close();}
 }
});

test('engine reserves once, retries once, counts both sequences, and never replays saved or interrupted work',async()=>{
 const f=await fixture();try{
  await f.run();let calls=0;
  const worker=createMonitoringEngine({db:f.db,env:f.env,now:f.now,available:()=>true,logger:()=>{},call:async()=>{
   const reservation=f.sqlite.prepare('SELECT * FROM mon_api_reservations').get();assert.equal(reservation.reserved_nano_usd,plan().reservedNano);
   return ++calls===1?failed('OUTPUT_TOKEN_LIMIT'):good;
  }});
  await worker.tick();await worker.tick();assert.equal(calls,2);assert.equal(evidence(f).status,'success');assert.equal(evidence(f).meta.answer_attempts,2);
  assert.equal(await usedCalls(f.db,f.now()-86400000),2);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_api_reservations').get().n,1);
  f.advance(1);await f.run();f.sqlite.prepare("UPDATE mon_tasks SET status='executing',claim_token='old',lease_until=? WHERE status='queued'").run(f.now()-1);
  await worker.tick();assert.equal(calls,2);assert.equal(evidence(f).error,'WORKER_INTERRUPTED');
 }finally{f.close();}
});

test('Claude continuation plus recovery stays within four reserved requests and transient tool failures are distinguished',async()=>{
 const e={...env,ENABLED_PROVIDERS:'claude',CLAUDE_MODEL:'fixture-claude',CLAUDE_MAX_TOKENS:'1400'};e.API_BUDGET_CONFIG_JSON=fixtureBudgetConfig(e);
 const r={transport:'direct',model:'fixture-claude'},budget=apiBudgetPlan({provider:'claude',route:r,prompt:'Which tools?',context:{},env:e});
 assert.equal(budget.maxRequests,2);assert.equal(budget.recovery.maxRequests,2);
 const old=globalThis.fetch,requests=[];
 const resp=(stop_reason,content)=>({stop_reason,model:r.model,usage:{output_tokens:100},content:content||[{type:'text',text:'Final.'}]});
 const replies=[resp('pause_turn'),resp('end_turn',[{type:'web_search_tool_result',content:{type:'web_search_tool_result_error',error_code:'internal_error'}}]),resp('pause_turn'),resp('end_turn')];
 globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return new Response(JSON.stringify(replies.shift()));};
 try{
  const result=await executeMonitoringCall({provider:'claude',prompt:'Which tools?',route:{...r,api_budget:budget},context:{},timeoutMs:120000,deadline:Date.now()+300000,call:callRoute,sleep:async()=>{}});
  assert.equal(requests.length,4);assert.deepEqual(requests.map(r=>r.max_tokens),[1400,1300,1400,1300]);assert.equal(result.meta.request_attempts,4);assert.equal(result.meta.recovery_retries,1);assert.equal(result.status,'no_grounding');
  globalThis.fetch=async()=>new Response(JSON.stringify(resp('end_turn',[{type:'web_search_tool_result',content:{type:'web_search_tool_result_error',error_code:'max_uses_exceeded'}}])));
  const bad=await claudeSearch('Which tools?');assert.equal(recoveryReason(bad),null);
 }finally{globalThis.fetch=old;}
});

test('Google uses one two-request counter for HTTP and supplier failures; absent overview is not retried',async()=>{
 const catalog={locations:[{country_iso_code:'US',location_type:'Country',location_code:2840,location_name:'United States'}],languages:[{language_code:'en'}]};
 const old=globalThis.fetch;
 const reply=task=>new Response(JSON.stringify({status_code:20000,tasks:[task]}));
 for(const sequence of [
  [new Response('{}',{status:503}),reply({status_code:50301,cost:0.01})],
  [reply({status_code:50301,cost:0.01}),new Response('{}',{status:503})],
  [new Response('{}',{status:503}),reply({status_code:20000,cost:0.01,result:[{items:[]}]})],
 ]){
  let calls=0;globalThis.fetch=async()=>{calls++;assert.ok(sequence.length);return sequence.shift();};
  try{const result=await googleAioSearch('Which tools?',{catalog,context:{market:'US',language:'en'},sleep:async()=>{}});assert.ok(['failed','no_overview'].includes(result.status));assert.equal(result.meta.cost,null);}catch(error){assert.equal(error.providerMeta.http_status,503);}finally{assert.equal(calls,2);}
 }
 let calls=0;globalThis.fetch=async()=>{calls++;return reply({status_code:20000,result:[{items:[]}]});};
 try{const result=await googleAioSearch('Which tools?',{catalog,context:{market:'US',language:'en'},sleep:async()=>{}});assert.equal(result.status,'no_overview');assert.equal(calls,1);}finally{globalThis.fetch=old;}
});

test('Claude failed continuations preserve HTTP status and all request counts for recovery decisions',async()=>{
 const e={...env,ENABLED_PROVIDERS:'claude',CLAUDE_MODEL:'fixture-claude',CLAUDE_MAX_TOKENS:'1400'};e.API_BUDGET_CONFIG_JSON=fixtureBudgetConfig(e);
 const r={transport:'direct',model:'fixture-claude'},budget=apiBudgetPlan({provider:'claude',route:r,prompt:'Which tools?',context:{},env:e});
 const old=globalThis.fetch;
 try{for(const status of [503,401,429]){
  let calls=0;
  globalThis.fetch=async()=>{
   calls++;
   if(calls===1)return new Response(JSON.stringify({stop_reason:'pause_turn',usage:{output_tokens:100},content:[]}));
   if(calls===2||status===429)return new Response('{}',{status,headers:{'retry-after':'0'}});
   return new Response(JSON.stringify({stop_reason:'end_turn',usage:{output_tokens:100},content:[{type:'text',text:'Final answer.'}]}));
  };
  const result=await executeMonitoringCall({provider:'claude',prompt:'Which tools?',route:{...r,api_budget:budget},context:{},timeoutMs:120000,deadline:Date.now()+300000,call:callRoute,sleep:async()=>{}});
  assert.equal(result.meta.request_attempts,calls);
  if(status===503){assert.equal(calls,3);assert.equal(result.meta.recovery_retries,1);assert.equal(result.status,'no_grounding');}
  else{assert.equal(calls,status===429?4:2);assert.equal(result.meta.recovery_retries,0);assert.equal(result.meta.http_status,status);}
 }}finally{globalThis.fetch=old;}
});
