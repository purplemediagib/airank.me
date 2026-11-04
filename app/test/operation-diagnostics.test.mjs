import test from 'node:test';
import assert from 'node:assert/strict';
import {operationDiagnostic,operationDiagnosticFields,operationFailure} from '../src/common/operation-diagnostics.mjs';
import {safeProviderMeta} from '../src/providers/diagnostics.mjs';
import {createCollectorClient} from '../src/collectors/client.mjs';
import {createEntityTick,reportEntityFailure} from '../src/intelligence/runtime.mjs';
import {createEntityEngine} from '../src/intelligence/engine.mjs';
import {checksum} from '../src/intelligence/migration.mjs';
import {workerConfiguration} from '../src/worker/config-check.mjs';
import {collectorFixture} from './collector-fixture.mjs';
import {createMonitoringEngine} from '../src/monitoring/engine.mjs';

const privateText='private-person@example.test Bearer sk-private https://private.test/?token=private SELECT private_answer';
const fail=(code,name='Error')=>Object.assign(new Error(privateText),{code,name,stack:privateText});
const clean=value=>assert.ok(!/private|SELECT|Bearer|https?:|@/.test(JSON.stringify(value)),JSON.stringify(value));
const env={ENTITY_ANALYSIS_ENABLED:'true'};
const migrationDb={execute:async()=>({rows:[{checksum}]})};

test('operation diagnostics use closed stages/codes and bounded numeric statuses only',()=>{
 const error=operationFailure('entity_migration_read',fail('SQLITE_BUSY'),{http_status:503,upstream_error_code:50000});
 assert.deepEqual(operationDiagnostic(error),{failure_stage:'entity_migration_read',diagnostic_code:'DATABASE_BUSY',http_status:503,upstream_error_code:'50000'});
 assert.deepEqual(operationDiagnostic(fail(privateText),'entity_tick'),{failure_stage:'entity_tick',diagnostic_code:'OPERATION_FAILED'});
 assert.deepEqual(operationDiagnosticFields({failure_stage:privateText,diagnostic_code:privateText,http_status:999,upstream_error_code:privateText}),{});
 for(const value of [-1,60001,NaN,Infinity,20000.5,{},'20000\n','SELECT'])assert.equal(operationDiagnosticFields({upstream_error_code:value}).upstream_error_code,undefined);
 assert.equal(operationDiagnostic({cause:{code:'ECONNRESET'}},'collector_locations').diagnostic_code,'NETWORK_ERROR');
 assert.deepEqual(operationDiagnostic(Object.assign(fail('SERVER_ERROR'),{cause:{status:503,message:privateText}}),'entity_migration_read'),{failure_stage:'entity_migration_read',diagnostic_code:'DATABASE_UNAVAILABLE',http_status:503});
 assert.equal(operationDiagnostic(fail('unknown','TimeoutError'),'collector_languages').diagnostic_code,'TIMEOUT');
 clean(operationDiagnostic(error));
 const meta=safeProviderMeta({failure_stage:'collector_languages',diagnostic_code:'SUPPLIER_ERROR',submission_attempted:false,headers:privateText,stack:privateText});
 assert.deepEqual(meta,{submission_attempted:false,failure_stage:'collector_languages',diagnostic_code:'SUPPLIER_ERROR'});
 assert.deepEqual(safeProviderMeta({failure_stage:privateText,diagnostic_code:privateText}),{});
});

async function runtimeFailure(options){
 const events=[];
 await createEntityTick({env,getDatabase:async()=>migrationDb,makeEngine:()=>({tick:async()=>{}}),...options})().catch(error=>reportEntityFailure(error,(event,fields)=>events.push({event,...fields})));
 assert.equal(events.length,1);clean(events);return events[0];
}
test('entity runtime distinguishes database, migration and engine stages without copying exceptions',async()=>{
 assert.deepEqual(await runtimeFailure({getDatabase:async()=>{throw fail('SQLITE_AUTH');}}),{event:'entity_analysis_unavailable',failure_stage:'entity_database_connect',diagnostic_code:'DATABASE_AUTHENTICATION_FAILED'});
 assert.equal((await runtimeFailure({getDatabase:async()=>({execute:async()=>{throw fail('SQLITE_ERROR');}})})).failure_stage,'entity_migration_read');
 assert.equal((await runtimeFailure({getDatabase:async()=>({execute:async()=>({rows:[]})})})).diagnostic_code,'MIGRATION_NOT_READY');
 assert.equal((await runtimeFailure({makeEngine:()=>{throw fail(privateText);}})).failure_stage,'entity_engine_initialize');
 assert.equal((await runtimeFailure({makeEngine:()=>({tick:async()=>{throw fail('CONNECTION_CLOSED');}})})).failure_stage,'entity_tick');
 assert.equal((await runtimeFailure({makeEngine:()=>({tick:async()=>{throw operationFailure('entity_queue_claim',fail('TRANSACTION_TIMEOUT'));}})})).failure_stage,'entity_queue_claim');
 assert.doesNotThrow(()=>reportEntityFailure(fail(privateText),()=>{throw fail(privateText);}));
});

test('disabled entity runtime stays silent and successful ticks retain one initialized engine',async()=>{
 let dbCalls=0,engines=0,ticks=0;
 const opts={getDatabase:async()=>{dbCalls++;return migrationDb;},makeEngine:()=>{engines++;return {tick:async()=>{ticks++;}};}};
 await createEntityTick({env:{},...opts})();assert.equal(dbCalls,0);
 const tick=createEntityTick({env,...opts});await tick();await tick();
 assert.deepEqual([dbCalls,engines,ticks],[1,1,2]);
 assert.equal(workerConfiguration({ENTITY_ANALYSIS_ENABLED:'true'}).entity_analysis_enabled,true);
 assert.equal(workerConfiguration({ENTITY_ANALYSIS_ENABLED:privateText}).entity_analysis_enabled,false);
});

test('entity queue seed and claim errors retain their stage without launching a provider call',async()=>{
 for(const claim of [false,true]){
  let transactions=0,providerCalls=0;
  const db={transaction:async()=>{
   transactions++;
   if(!claim||transactions===2)throw fail('SQLITE_BUSY');
   return {execute:async q=>({rows:q.sql.startsWith('SELECT value')?[{value:'0'}]:[],rowsAffected:0}),commit:async()=>{},rollback:async()=>{},close(){}};
  }};
  const engine=createEntityEngine({db,env,call:async()=>{providerCalls++;}});
  await assert.rejects(engine.tick(),error=>{
   assert.deepEqual(operationDiagnostic(error),{failure_stage:claim?'entity_queue_claim':'entity_queue_seed',diagnostic_code:'DATABASE_BUSY'});return true;
  });
  assert.equal(providerCalls,0);
 }
});

const route={transport:'dataforseo_scraper',model:'consumer-auto',measurement_surface:'consumer_web'};
const valid=url=>({status_code:20000,tasks:[{status_code:20000,result:url.endsWith('/languages')?[{language_code:'en'}]:[{country_iso_code:'US',location_type:'Country',location_code:2840}]}]});
async function catalogFailure(which,respond){
 const requests=[];
 const client=createCollectorClient({env:{CONSUMER_COLLECTION_ENABLED:'true',DATAFORSEO_LOGIN:privateText,DATAFORSEO_PASSWORD:privateText},transport:async(url,init)=>{
  requests.push({url,method:init.method});
  return url.includes(`/${which}`)?respond(url):new Response(JSON.stringify(valid(url)));
 }});
 const result=await client.submit({provider:'openai',route,context:{market:'US',language:'en'},prompt:privateText,taskId:'existing-task'});
 assert.equal(result.result.status,'provider_failed');assert.equal(result.result.meta.failure_code,'COLLECTOR_LOCALE_CATALOG_UNAVAILABLE');
 assert.equal(requests.length,2);assert.ok(requests.every(x=>x.method==='GET'));
 assert.equal(result.result.meta.failure_stage,`collector_${which}`);assert.equal(result.result.meta.submission_attempted,false);
 clean(result);return result.result.meta;
}
test('collector catalog failures expose precise safe stage and numeric status without retries',async()=>{
 for(const which of ['locations','languages']){
  const http=await catalogFailure(which,()=>new Response(JSON.stringify({status_code:40100,status_message:privateText}),{status:401}));
  assert.equal(http.diagnostic_code,'HTTP_ERROR');assert.equal(http.http_status,401);assert.equal(http.upstream_error_code,'40100');
  const supplier=await catalogFailure(which,()=>new Response(JSON.stringify({status_code:20000,tasks:[{status_code:40401,status_message:privateText}]})));
  assert.equal(supplier.diagnostic_code,'SUPPLIER_ERROR');assert.equal(supplier.upstream_error_code,'40401');
  assert.equal((await catalogFailure(which,()=>{throw fail(privateText,'TimeoutError');})).diagnostic_code,'TIMEOUT');
  assert.equal((await catalogFailure(which,()=>new Response(privateText))).diagnostic_code,'INVALID_RESPONSE');
  assert.equal((await catalogFailure(which,()=>new Response(privateText,{status:403}))).diagnostic_code,'HTTP_ERROR');
  assert.equal((await catalogFailure(which,()=>new Response('null'))).diagnostic_code,'INVALID_RESPONSE');
 }
 const oversized=await catalogFailure('locations',()=>new Response('x'.repeat(8000001)));
 assert.equal(oversized.diagnostic_code,'RESPONSE_TOO_LARGE');
 const streamFailure=await catalogFailure('languages',()=>new Response(new ReadableStream({start(c){c.error(fail('ECONNRESET'));}})));
 assert.equal(streamFailure.diagnostic_code,'NETWORK_ERROR');assert.equal(streamFailure.http_status,200);
});

test('collector diagnostics persist and log only the existing task ID; logger failure cannot block receipt',async()=>{
 for(const loggerThrows of [false,true]){
  const f=await collectorFixture({ENABLED_PROVIDERS:'openai',CONSUMER_COLLECTION_PROVIDERS:'openai',CONSUMER_UNIT_COSTS_JSON:'{"openai":0.01}',DATAFORSEO_LOGIN:'fixture',DATAFORSEO_PASSWORD:'fixture'});
  try{
   const events=[],client=createCollectorClient({env:f.env,transport:async()=>new Response(JSON.stringify({status_code:40100,status_message:privateText}),{status:401})});
   await f.run();const task=f.sqlite.prepare('SELECT id FROM mon_tasks').get().id;
   await createMonitoringEngine({db:f.db,env:f.env,now:f.now,collectorClient:client,logger:(event,fields)=>{if(event==='collector_preflight_failed'){events.push({event,...fields});if(loggerThrows)throw fail(privateText);}}}).tick();
   const saved=JSON.parse(f.sqlite.prepare('SELECT payload FROM mon_evidence').get().payload);
   assert.equal(saved.meta.failure_stage,'collector_locations');assert.equal(saved.meta.http_status,401);assert.equal(saved.meta.submission_attempted,false);
   assert.equal(events.length,1);assert.equal(events[0].event,'collector_preflight_failed');assert.equal(events[0].task_id,task);
   assert.deepEqual(Object.keys(events[0]).sort(),['diagnostic_code','event','failure_code','failure_stage','http_status','submission_attempted','task_id','upstream_error_code'].sort());
   clean(events);clean(saved.meta);
  }finally{f.close();}
 }
});
