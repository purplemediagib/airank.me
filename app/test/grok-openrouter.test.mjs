import test from 'node:test';
import assert from 'node:assert/strict';
import {collectorFixture} from './collector-fixture.mjs';
import {fixtureBudgetConfig} from './api-budget-fixture.mjs';
import {migrateApiBudget} from '../src/monitoring/budget-migration.mjs';
import {createMonitoringEngine} from '../src/monitoring/engine.mjs';

async function fixture(){
 const f=await collectorFixture({ENABLED_PROVIDERS:'grok',CONSUMER_COLLECTION_PROVIDERS:'',
  OPENROUTER_GROK_MODEL:'x-ai/grok-4.7',OPENROUTER_API_KEY:'fixture-openrouter-key',
  OPENROUTER_SEARCH_ENGINES_JSON:'{"grok":"native"}',MAX_DAILY_PROVIDER_CALLS:'unlimited'});
 await migrateApiBudget(f.db);
 f.env.API_BUDGET_CONFIG_JSON=fixtureBudgetConfig(f.env,{dailyUsd:null});
 return f;
}
const saved=f=>JSON.parse(f.sqlite.prepare('SELECT payload FROM mon_evidence').get().payload);

test('monitoring sends Grok once through OpenRouter and persists success or provider failure without fallback',async()=>{
 const oldFetch=globalThis.fetch,oldKey=process.env.OPENROUTER_API_KEY;
 process.env.OPENROUTER_API_KEY='fixture-openrouter-key';
 try{
  for(const scenario of ['success','payment','truncated']){
   const f=await fixture(),requests=[];try{
    globalThis.fetch=async(url,init)=>{
     requests.push({url,headers:init.headers,body:JSON.parse(init.body)});
     const response=scenario==='payment'?{error:{code:402,message:'private provider text'}}:{
      id:'grok-response-fixture',model:'x-ai/grok-4.7-20260916',provider:'xAI',
      choices:[{finish_reason:scenario==='truncated'?'length':'stop',message:{content:'Example is useful.',
       annotations:[{type:'url_citation',url_citation:{url:'https://example.com/',title:'Example'}}]}}],
      usage:{prompt_tokens:100,completion_tokens:50},
     };
     return new Response(JSON.stringify(response),{status:scenario==='payment'?402:200,headers:{'content-type':'application/json'}});
    };
    await f.run();
    const w=createMonitoringEngine({db:f.db,env:f.env,now:f.now,logger:()=>{}});
    await w.tick();await w.tick();
    assert.equal(requests.length,1);
    assert.equal(requests[0].url,'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(requests[0].headers.authorization,'Bearer fixture-openrouter-key');
    assert.equal(requests[0].body.model,'x-ai/grok-4.7');
    assert.equal(requests[0].body.tools[0].parameters.engine,'native');
    assert.equal(requests[0].body.max_tokens,8192);
    assert.equal(requests[0].body.provider.allow_fallbacks,false);
    assert.deepEqual(requests[0].body.provider.max_price,{prompt:2,completion:3});
    const reservation=f.sqlite.prepare('SELECT config_json FROM mon_api_reservations').all();
    assert.equal(reservation.length,1);assert.equal(JSON.parse(reservation[0].config_json).dailyNano,null);
    const e=saved(f);
    assert.equal(e.provider,'grok');assert.equal(e.meta.transport,'openrouter');
    assert.equal(e.meta.requested_model,'x-ai/grok-4.7');
    assert.equal(e.meta.measurement_surface,'model_api');
    assert.equal(e.meta.api_budget_mode,'monetary_reserved');
    if(scenario==='success'){
     assert.equal(e.status,'success');assert.equal(e.meta.returned_model,'x-ai/grok-4.7-20260916');
     assert.equal(e.answer,'Example is useful.');assert.equal(e.citations[0].url,'https://example.com/');
    }else{
     assert.equal(e.status,'failed');assert.equal(e.error,scenario==='payment'?'PAYMENT_REQUIRED':'OUTPUT_TOKEN_LIMIT');
     assert.equal(JSON.stringify(e).includes('private provider text'),false);
    }
   }finally{f.close();}
  }
 }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=oldKey;}
});

test('stale direct Grok budget fails before a paid OpenRouter request',async()=>{
 const f=await fixture();try{
  const budget=JSON.parse(f.env.API_BUDGET_CONFIG_JSON);
  budget.routes.grok.transport='direct';budget.routes.grok.model='grok-4.7';
  delete budget.routes.grok.searchEngine;
  f.env.API_BUDGET_CONFIG_JSON=JSON.stringify(budget);
  await f.run();
  await createMonitoringEngine({db:f.db,env:f.env,now:f.now,logger:()=>{},call:()=>assert.fail('stale budget must not dispatch')}).tick();
  assert.equal(saved(f).error,'API_BUDGET_ROUTE_MISMATCH');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_api_reservations').get().n,0);
 }finally{f.close();}
});
