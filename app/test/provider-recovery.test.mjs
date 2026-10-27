import test from 'node:test';
import assert from 'node:assert/strict';
import {collectorFixture} from './collector-fixture.mjs';
import {fixtureBudgetConfig} from './api-budget-fixture.mjs';
import {migrateApiBudget} from '../src/monitoring/budget-migration.mjs';
import {createMonitoringEngine} from '../src/monitoring/engine.mjs';
import {mistralCollectionMethodVersion,methodFor} from '../src/common/observations.mjs';

const saved=f=>JSON.parse(f.sqlite.prepare('SELECT payload FROM mon_evidence').get().payload);
async function fixture(provider){
 const f=await collectorFixture({ENABLED_PROVIDERS:provider,CONSUMER_COLLECTION_PROVIDERS:'',
  OPENROUTER_MODELS_JSON:'{"mistral":"mistralai/mistral-large-4-0"}',OPENROUTER_SEARCH_ENGINE:'exa',
  OPENROUTER_API_KEY:'fixture',DATAFORSEO_LOGIN:'fixture',DATAFORSEO_PASSWORD:'fixture',MAX_DAILY_PROVIDER_CALLS:'unlimited'});
 await migrateApiBudget(f.db);f.env.API_BUDGET_CONFIG_JSON=fixtureBudgetConfig(f.env,{dailyUsd:null});return f;
}

test('Mistral monitoring freezes the new method, reserves its limits and stores actual HTTP provenance',async()=>{
 const old=globalThis.fetch,oldKey=process.env.OPENROUTER_API_KEY;process.env.OPENROUTER_API_KEY='fixture';
 const f=await fixture('mistral');
 try{
  const requests=[];
  globalThis.fetch=async(url,init)=>{
   requests.push({url,body:JSON.parse(init.body)});
   return new Response(JSON.stringify({model:'mistralai/mistral-large-4-0',choices:[{finish_reason:'stop',message:{content:'Example is available.',annotations:[]}}]}));
  };
  await f.run();await createMonitoringEngine({db:f.db,env:f.env,now:f.now,logger:()=>{}}).tick();
  const snapshot=JSON.parse(f.sqlite.prepare('SELECT snapshot FROM mon_runs').get().snapshot);
  const plan=JSON.parse(f.sqlite.prepare('SELECT config_json FROM mon_api_reservations').get().config_json);
  assert.equal(snapshot.routes[0].collection_method,mistralCollectionMethodVersion);
  assert.equal(plan.maxTokens,12000);assert.equal(plan.maxSearches,2);assert.equal(plan.maxRequests,1);
  assert.equal(requests.length,1);assert.equal(requests[0].body.max_tokens,plan.maxTokens);
  const e=saved(f);assert.equal(e.status,'success');assert.equal(e.meta.collection_method,mistralCollectionMethodVersion);
  assert.equal(methodFor(snapshot,e),mistralCollectionMethodVersion);
 }finally{f.close();globalThis.fetch=old;if(oldKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=oldKey;}
});

test('AI Overview reserves both requests before dispatch, recovers once and never replays the finished task',async()=>{
 const old=globalThis.fetch,f=await fixture('google_aio');
 try{
  const paid=[];
  globalThis.fetch=async(url,init)=>{
   if(url.endsWith('/locations'))return new Response(JSON.stringify({tasks:[{status_code:20000,result:[{country_iso_code:'US',location_type:'Country',location_code:2840,location_name:'United States'}]}]}));
   if(url.endsWith('/languages'))return new Response(JSON.stringify({tasks:[{status_code:20000,result:[{language_code:'en'}]}]}));
   paid.push(JSON.parse(init.body));
   const plan=JSON.parse(f.sqlite.prepare('SELECT config_json FROM mon_api_reservations').get().config_json);
   assert.equal(plan.maxRequests,2);assert.equal(plan.reservedNano,100000000);
   const task=paid.length===1?{status_code:40101,cost:0.05}:{status_code:20000,cost:0.05,id:'recovered',result:[{items:[{type:'ai_overview',text:'Example is available.',references:[{url:'https://example.com/'}]}]}]};
   return new Response(JSON.stringify({status_code:20000,tasks:[task]}));
  };
  await f.run();const w=createMonitoringEngine({db:f.db,env:f.env,now:f.now,logger:()=>{}});
  await w.tick();await w.tick();
  assert.equal(paid.length,2);assert.deepEqual(paid[0],paid[1]);
  const e=saved(f);assert.equal(e.status,'success');assert.equal(e.meta.request_attempts,2);
  assert.equal(e.meta.initial_upstream_error_code,'40101');assert.equal(e.meta.cost,0.1);
  assert.equal(e.meta.api_reserved_nano_usd,100000000);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_api_reservations').get().n,1);
 }finally{f.close();globalThis.fetch=old;}
});

test('AI Overview blocks before dispatch if the finite daily budget cannot cover both attempts',async()=>{
 const f=await fixture('google_aio');
 try{
  f.env.API_BUDGET_CONFIG_JSON=fixtureBudgetConfig(f.env,{dailyUsd:0.075,requestUsd:0.05});
  await f.run();await createMonitoringEngine({db:f.db,env:f.env,now:f.now,logger:()=>{},call:()=>assert.fail('must reserve both requests')}).tick();
  assert.equal(saved(f).error,'API_BUDGET_EXHAUSTED');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_api_reservations').get().n,0);
 }finally{f.close();}
});
