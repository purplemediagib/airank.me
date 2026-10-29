import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchRateLimited,retryAfterMs} from '../src/providers/rate-limit.mjs';
import {requestJson,requestMeta} from '../src/providers/common.mjs';
import {openrouterSearch} from '../src/providers/openrouter.mjs';
import {providerFailure} from '../src/providers/diagnostics.mjs';
import {providerConcurrency} from '../src/monitoring/provider-concurrency.mjs';
import {collectorFixture} from './collector-fixture.mjs';
import {fixtureBudgetConfig} from './api-budget-fixture.mjs';
import {migrateApiBudget} from '../src/monitoring/budget-migration.mjs';
import {createMonitoringEngine} from '../src/monitoring/engine.mjs';
import {apiObservation,deepseekCollectionMethodVersion,collectionMethodVersion,observationContextKey,methodFor} from '../src/common/observations.mjs';
import {routesFromEnv} from '../src/providers/routing.mjs';
import {apiBudgetPlan} from '../src/providers/budget-config.mjs';
import {openaiSearch} from '../src/providers/openai.mjs';
import {claudeSearch} from '../src/providers/claude.mjs';
import {grokSearch,perplexitySearch} from '../src/providers/grounded-responses.mjs';
import {geminiSearch} from '../src/providers/gemini.mjs';
import {googleAioSearch} from '../src/providers/google-aio.mjs';

const model='deepseek/deepseek-v4-pro';
const answer={model,choices:[{finish_reason:'stop',message:{content:'Example is available.',annotations:[{type:'url_citation',url_citation:{url:'https://example.com/'}}]}}]};
const response=(status=200,body=answer,headers={})=>new Response(JSON.stringify(body),{status,headers});
function clock(){let time=1700000000000;const waits=[];return {waits,now:()=>time,random:()=>0,sleep:async ms=>{waits.push(ms);time+=ms;}};}

test('Retry-After accepts seconds and HTTP dates, rejects malformed values',()=>{
 const now=Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
 for(const [value,expected] of [['2',2000],['0',0],['0.5',500],['Wed, 21 Oct 2026 07:28:09 GMT',9000],['Tue, 20 Oct 2026 07:28:00 GMT',0],['-1',null],['',null],['garbage',null],[null,null]])assert.equal(retryAfterMs(value,now),expected);
});

test('429 retries use three total attempts, exponential jitter and the exact same body/signal',async()=>{
 const c=clock(),calls=[];
 const r=await fetchRateLimited('https://fixture.test',{method:'POST',body:'private'}, {...c,random:()=>1,fetchImpl:async(url,init)=>{calls.push(init);return response(calls.length<3?429:200);}});
 assert.equal(r.response.status,200);assert.deepEqual(c.waits,[2500,7500]);
 assert.deepEqual(r.meta,{request_attempts:3,rate_limit_retries:2});
 assert.ok(calls.every(call=>call.body==='private'&&call.signal===calls[0].signal));
});

test('Retry-After takes priority over fallback jitter',async()=>{
 const c=clock();let calls=0;
 await fetchRateLimited('https://fixture.test',{}, {...c,fetchImpl:async()=>response(++calls<3?429:200,{}, {'retry-after':calls===1?'4':new Date(c.now()+9000).toUTCString()})});
 assert.deepEqual(c.waits,[4000,9000]);assert.equal(calls,3);
});

test('deadline does not shorten Retry-After or launch a late retry',async()=>{
 const c=clock();let calls=0;
 const r=await fetchRateLimited('https://fixture.test',{}, {...c,timeoutMs:1000,fetchImpl:async()=>{calls++;return response(429,{}, {'retry-after':'20'});}});
 assert.equal(r.response.status,429);assert.equal(calls,1);assert.deepEqual(c.waits,[]);
 const late=clock();calls=0;
 const result=await fetchRateLimited('https://fixture.test',{}, {...late,timeoutMs:5000,sleep:()=>late.sleep(6000),fetchImpl:async()=>{calls++;return response(429);}});
 assert.equal(result.response.status,429);assert.equal(calls,1);
});

test('aborting a retry wait stops the request before another attempt',async()=>{
 let calls=0;
 await assert.rejects(fetchRateLimited('https://fixture.test',{}, {timeoutMs:1000,fetchImpl:async()=>{calls++;return response(429,{}, {'retry-after':'0'});},sleep:async()=>{throw new DOMException('fixture abort','AbortError');}}),e=>e.name==='AbortError'&&e.providerMeta.request_attempts===1);
 assert.equal(calls,1);
});

test('payment/auth/server errors, network errors and partial HTTP 200 output are not retried',async()=>{
 for(const status of [400,401,402,403,500,503,200]){
  let calls=0;const c=clock();
  const result=await fetchRateLimited('https://fixture.test',{}, {...c,fetchImpl:async()=>{calls++;return response(status,{error:{code:429}});}});
  assert.equal(result.response.status,status);assert.equal(calls,1);assert.deepEqual(c.waits,[]);
 }
 let calls=0;await assert.rejects(fetchRateLimited('https://fixture.test',{}, {fetchImpl:async()=>{calls++;throw Error('network');}}),/network/);assert.equal(calls,1);
});

test('direct API helper retries non-JSON 429, preserves metadata and reports exhausted rate limits safely',async()=>{
 const c=clock();let calls=0;
 const j=await requestJson('https://fixture.test',{body:{prompt:'private'},retryOptions:c,fetchImpl:async()=>++calls<3?new Response('limited',{status:429}):response(200,{ok:true})});
 assert.deepEqual(j,{ok:true});assert.equal(requestMeta(j).request_attempts,3);
 let failure;
 try{await requestJson('https://fixture.test',{retryOptions:clock(),fetchImpl:async()=>response(429,{error:{code:'rate_limit',message:'private-secret'}})});}catch(e){failure=providerFailure(e);}
 assert.equal(failure.meta.failure_code,'RATE_LIMITED');assert.equal(failure.meta.http_status,429);assert.equal(failure.meta.request_attempts,3);assert.equal(failure.meta.rate_limit_retries,2);
 assert.ok(!JSON.stringify(failure).includes('private-secret'));
});

test('DeepSeek fallback retains price ceilings and shares 4096 output tokens with the reservation',async()=>{
 const env={ENABLED_PROVIDERS:'deepseek',OPENROUTER_MODELS_JSON:JSON.stringify({deepseek:model}),OPENROUTER_SEARCH_ENGINE:'exa'};
 env.API_BUDGET_CONFIG_JSON=fixtureBudgetConfig(env,{dailyUsd:null});
 const route=routesFromEnv(env).deepseek,budget=apiBudgetPlan({provider:'deepseek',route,prompt:'Question',context:{},env});
 const calls=[],result=await openrouterSearch('Question',{model,searchEngine:'exa',apiKey:'fixture',budget,retryOptions:clock(),fetchImpl:async(url,init)=>{calls.push(JSON.parse(init.body));return response(calls.length<3?429:200);}});
 assert.equal(budget.maxTokens,4096);assert.equal(budget.maxRequests,1);
 assert.equal(calls.length,3);assert.deepEqual(calls[0],calls[2]);assert.equal(calls[0].max_tokens,4096);
 assert.deepEqual(calls[0].provider,{allow_fallbacks:true,require_parameters:true,sort:'throughput',max_price:{prompt:2,completion:3}});
 assert.equal(result.status,'success');assert.equal(result.meta.request_attempts,3);assert.equal(result.meta.rate_limit_retries,2);
 assert.equal(route.collection_method,deepseekCollectionMethodVersion);assert.equal(result.meta.collection_method,deepseekCollectionMethodVersion);
 const old={collectionMethod:collectionMethodVersion},row={provider:'deepseek'};
 assert.equal(methodFor(old,row),collectionMethodVersion);
 assert.notEqual(observationContextKey(row,old),observationContextKey({...row,meta:result.meta},old));
});

test('OpenRouter only records RATE_LIMITED after its final allowed attempt',async()=>{
 const c=clock();let calls=0;
 const result=await openrouterSearch('Question',{model,apiKey:'fixture',retryOptions:c,fetchImpl:async()=>{calls++;return response(429,{error:{code:429,message:'private'}});}});
 assert.equal(calls,3);assert.deepEqual(c.waits,[2000,6000]);assert.equal(result.meta.failure_code,'RATE_LIMITED');assert.equal(result.meta.request_attempts,3);
});

test('all direct API adapters recover HTTP 429 and keep final evidence metadata',async()=>{
 const old=globalThis.fetch;
 const grounded={status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Example is available.',annotations:[{type:'url_citation',url:'https://example.com/'}]}]}]};
 try{
  for(const [call,payload] of [[openaiSearch,grounded],[grokSearch,grounded],[perplexitySearch,grounded],
   [claudeSearch,{stop_reason:'end_turn',content:[{type:'text',text:'Example is available.',citations:[{url:'https://example.com/'}]}]}],
   [geminiSearch,{candidates:[{finishReason:'STOP',content:{parts:[{text:'Example is available.'}]},groundingMetadata:{webSearchQueries:['query'],groundingChunks:[{web:{uri:'https://example.com/'}}]}}]}]]){
   let calls=0;globalThis.fetch=async()=>response(++calls===1?429:200,payload,{'retry-after':'0'});
   const result=await call('Question');assert.equal(calls,2);assert.equal(result.status,'success');assert.equal(result.meta.request_attempts,2);assert.equal(result.meta.rate_limit_retries,1);
  }
 }finally{globalThis.fetch=old;}
});

test('AI Overview HTTP rejection retries do not multiply its two paid supplier attempts',async()=>{
 const old=globalThis.fetch;let calls=0;
 const catalog={locations:[{country_iso_code:'US',location_type:'Country',location_code:2840,location_name:'United States'}],languages:[{language_code:'en'}]};
 globalThis.fetch=async()=>{
  calls++;
  if(calls===1||calls===3)return response(429,{}, {'retry-after':'0'});
  return response(200,{tasks:[calls===2?{status_code:50301,cost:0.01}:{status_code:20000,cost:0.01,result:[{items:[{type:'ai_overview',text:'Example is available.',references:[{url:'https://example.com/'}]}]}]}]});
 };
 try{
  const result=await googleAioSearch('Question',{catalog,context:{market:'US',language:'en'},budget:{maxRequests:2},sleep:async()=>{}});
  assert.equal(calls,4);assert.equal(result.status,'success');assert.equal(result.meta.request_attempts,4);assert.equal(result.meta.rate_limit_retries,2);assert.equal(result.meta.cost,0.02);
  calls=0;globalThis.fetch=async()=>{calls++;return response(429,{}, {'retry-after':'0'});};
  await assert.rejects(googleAioSearch('Question',{catalog,context:{market:'US',language:'en'},sleep:()=>assert.fail('no supplier retry after HTTP exhaustion')}),e=>e.providerMeta.failure_code==='RATE_LIMITED'&&e.providerMeta.request_attempts===3);
  assert.equal(calls,3);
 }finally{globalThis.fetch=old;}
});

test('per-provider config has conservative defaults and rejects unsafe limits',()=>{
 assert.deepEqual(providerConcurrency({}),{deepseek:2,kimi:3,default:6});
 assert.deepEqual(providerConcurrency({PROVIDER_CONCURRENCY_JSON:'{"default":4,"openai":1}'}),{deepseek:2,kimi:3,default:4,openai:1});
 for(const raw of ['', '[]','null','{"deepseek":0}','{"default":9}','{"kimi":1.5}','{"kimi":"2"}','{"bad-key":2}'])assert.throws(()=>providerConcurrency({PROVIDER_CONCURRENCY_JSON:raw}),/PROVIDER_CONCURRENCY_JSON/);
});

async function fixture(overrides={}){
 const f=await collectorFixture({ENABLED_PROVIDERS:'deepseek,kimi,openai',CONSUMER_COLLECTION_PROVIDERS:'',OPENROUTER_MODELS_JSON:JSON.stringify({deepseek:model,kimi:'moonshotai/kimi-k3'}),OPENROUTER_SEARCH_ENGINE:'exa',MONITORING_CONCURRENCY:'8',MONITORING_PROVIDER_TIMEOUT_MS:'5000',MAX_DAILY_PROVIDER_CALLS:'unlimited',...overrides});
 await migrateApiBudget(f.db);f.env.API_BUDGET_CONFIG_JSON=fixtureBudgetConfig(f.env,{dailyUsd:null});return f;
}
const success=()=>({status:'success',answer:'Example is available.',citations:[],observation:apiObservation({complete:true})});

test('two workers share atomic provider caps, skip saturated queues and keep one reservation per task',async()=>{
 const f=await fixture({PROVIDER_CONCURRENCY_JSON:'{"deepseek":2,"kimi":3,"default":1}'});
 let release;const gate=new Promise(r=>release=r),counts={},peaks={};let active=0,max=0,calls=0;
 const call=async provider=>{calls++;active++;counts[provider]=(counts[provider]||0)+1;peaks[provider]=Math.max(peaks[provider]||0,counts[provider]);max=Math.max(max,active);await gate;counts[provider]--;active--;return success();};
 const make=()=>createMonitoringEngine({db:f.db,env:f.env,now:f.now,logger:()=>{},available:()=>true,call});
 try{
  for(let i=0;i<5;i++)await f.api('POST','prompts',{text:`Which tools suit business group ${i}?`,kind:'neutral',topic:'',tags:[]});
  await f.run();const a=make(),b=make();
  const ticking=Promise.all([a.tick(),b.tick()]);
  for(let i=0;i<100&&calls<6;i++)await new Promise(r=>setImmediate(r));
  assert.equal(calls,6);assert.deepEqual(peaks,{...peaks,deepseek:2,kimi:3,openai:1});assert.equal(max,6);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_api_reservations').get().n,6);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM mon_tasks WHERE status='queued'").get().n,12);
  release();await ticking;
  for(let i=0;i<10;i++)await Promise.all([a.tick(),b.tick()]);
  assert.equal(calls,18);assert.ok(peaks.deepseek<=2&&peaks.kimi<=3&&peaks.openai<=1&&max<=8);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_budget').get().n,18);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_api_reservations').get().n,18);
  assert.equal(f.sqlite.prepare('SELECT status FROM mon_runs').get().status,'complete');
 }finally{release();f.close();}
});

test('global concurrency remains the stricter cap',async()=>{
 const f=await fixture({MONITORING_CONCURRENCY:'2'});let calls=0,active=0,max=0;
 try{
  await f.run();const w=createMonitoringEngine({db:f.db,env:f.env,now:f.now,logger:()=>{},available:()=>true,call:async()=>{calls++;active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;return success();}});
  await w.tick();assert.equal(calls,2);assert.equal(max,2);await w.tick();assert.equal(calls,3);
 }finally{f.close();}
});

test('real DeepSeek worker retries within one reservation and never replays completed evidence',async()=>{
 const f=await fixture({ENABLED_PROVIDERS:'deepseek'}),oldFetch=globalThis.fetch,oldKey=process.env.OPENROUTER_API_KEY;let calls=0;
 process.env.OPENROUTER_API_KEY='fixture';
 globalThis.fetch=async()=>{
  calls++;assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_api_reservations').get().n,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_budget').get().n,1);
  return response(calls<3?429:200,calls<3?{error:{code:429}}:answer,{'retry-after':'0'});
 };
 try{
  await f.run();const w=createMonitoringEngine({db:f.db,env:f.env,now:f.now,logger:()=>{},available:()=>true});await w.tick();await w.tick();
  const e=JSON.parse(f.sqlite.prepare('SELECT payload FROM mon_evidence').get().payload);
  assert.equal(calls,3);assert.equal(e.status,'success');assert.equal(e.meta.request_attempts,3);assert.equal(e.meta.rate_limit_retries,2);
  assert.equal(e.meta.max_tokens_requested,4096);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_evidence').get().n,1);
 }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=oldKey;f.close();}
});
