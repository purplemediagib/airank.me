import test from 'node:test';
import assert from 'node:assert/strict';
import {collectorFixture} from './collector-fixture.mjs';
import {createMonitoringEngine} from '../src/monitoring/engine.mjs';
import {normalizeCollection} from '../src/collectors/normalization.mjs';
import {createCollectorClient} from '../src/collectors/client.mjs';
import {routesFromEnv,monitoringRoutesFromEnv} from '../src/providers/routing.mjs';
import {analyticsService} from '../src/analytics/service.mjs';
import {resultsService} from '../src/analytics/results.mjs';
import {extract,aggregate} from '../src/analytics/extraction.mjs';
const logger=()=>{};
const route={transport:'scrapeless',model:'consumer-auto',measurement_surface:'consumer_web'};
const prompt='Which marketing tools suit a small business?';
const raw={status:'success',task_result:{user_query:prompt,user_model:'fast',full_response:'Example is an option. ([Example][1])\n\n[1]: https://example.com/ "Example"',footnotes:{a:{url:'https://example.com/'},b:{url:'https://example.com/'}},web_search_results:[{url:'https://uncited.test/',title:'Uncited page'}]}};
const fake=()=>{let posts=0,gets=0;return {get posts(){return posts;},get gets(){return gets;},submit:async()=>{posts++;return {remoteId:'remote-test',meta:{}};},poll:async()=>{gets++;return {status:'ready',raw};}};};
const engine=(f,client,extra={})=>createMonitoringEngine({db:f.db,env:f.env,now:f.now,collectorClient:client,logger,...extra});
test('consumer routes are opt-in, guest routes remain unchanged, unsupported Claude cannot be relabelled',()=>{
 const env={ENABLED_PROVIDERS:'openai,claude,gemini,grok,perplexity',CONSUMER_COLLECTION_PROVIDERS:'openai,gemini,grok,perplexity'};
 assert.equal(routesFromEnv(env).openai.transport,'direct');
 assert.equal(monitoringRoutesFromEnv(env).openai.transport,'dataforseo_scraper');
 assert.equal(monitoringRoutesFromEnv(env).claude.transport,'direct');
 assert.equal(monitoringRoutesFromEnv(env).grok.transport,'scrapeless');
 assert.throws(()=>monitoringRoutesFromEnv({...env,CONSUMER_COLLECTION_PROVIDERS:'claude'}));
});
test('paid submit once, durable remote ID, restart GET recovery, real analytics/results and owner isolation',async()=>{
 const f=await collectorFixture();try{
  const client=fake(),r=(await f.run()).data,a=engine(f,client);await a.tick();
  assert.equal(client.posts,1);assert.equal(client.gets,0);
  assert.equal(f.sqlite.prepare('SELECT status FROM mon_tasks').get().status,'collecting');
  const pending=(await resultsService({db:f.db,path:'/v1/projects/project/results',userId:'alice',query:new URLSearchParams({state:'running'})})).data;
  assert.equal(pending.total,1);
  f.advance(5001);await engine(f,client).tick();await a.tick();
  assert.equal(client.posts,1);assert.equal(client.gets,1);
  const detail=(await f.api('GET','monitoring-runs/'+r.id)).data;
  assert.equal(detail.run.status,'complete');assert.equal(detail.evidence[0].answer,raw.task_result.full_response);
  assert.equal(detail.evidence[0].collection.surface,'consumer_web');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM mon_budget').get().n,1);
  assert.equal(JSON.parse(f.sqlite.prepare('SELECT raw_json FROM mon_collections').get().raw_json).task_result.full_response,raw.task_result.full_response);
  const analytics=(await analyticsService({db:f.db,path:'/v1/projects/project/analytics',userId:'alice'})).data;
  assert.equal(analytics.metrics.visibility,100);assert.equal(analytics.metrics.citationRate,100);
  const results=(await resultsService({db:f.db,path:'/v1/projects/project/results',userId:'alice'})).data;
  assert.equal(results.items[0].collection.sourceReferences.length,4);
  await assert.rejects(resultsService({db:f.db,path:'/v1/projects/project/results',userId:'bob'}),e=>e.status===404);
 }finally{f.close();}
});
test('multiple workers do not duplicate paid submissions or remote polls',async()=>{
 const f=await collectorFixture();try{await f.run();const c=fake(),a=engine(f,c),b=engine(f,c);await Promise.all([a.tick(),b.tick()]);assert.equal(c.posts,1);f.advance(5001);await Promise.all([a.tick(),b.tick()]);assert.equal(c.gets,1);}finally{f.close();}
});
test('disabled collection, missing money budget and exhausted cap block before any paid call',async()=>{
 for(const extra of [{CONSUMER_COLLECTION_ENABLED:'false'},{CONSUMER_MAX_DAILY_COST_USD:''},{CONSUMER_MAX_DAILY_COST_USD:'0.01'}]){
  const f=await collectorFixture(extra);try{const c=fake();await f.run();if(extra.CONSUMER_MAX_DAILY_COST_USD==='0.01'){const e=engine(f,c);await e.tick();f.advance(5001);await e.tick();await f.run();}await engine(f,c).tick();assert.equal(c.posts,extra.CONSUMER_MAX_DAILY_COST_USD==='0.01'?1:0);}finally{f.close();}
 }
});
test('terminal supplier failures persist as failures, not zeros and never re-submit',async()=>{
 const f=await collectorFixture();try{await f.run();const c=fake();c.poll=async()=>({status:'failed',code:'COLLECTOR_EXECUTION_FAILED',raw:{status:'failed'}});const e=engine(f,c);await e.tick();f.advance(5001);await e.tick();await e.tick();assert.equal(c.posts,1);const a=(await analyticsService({db:f.db,path:'/v1/projects/project/analytics',userId:'alice'})).data;assert.equal(a.metrics.visibility,null);}finally{f.close();}
});
test('crashed submission with no known remote ID becomes unknown, never re-posted',async()=>{
 const f=await collectorFixture();try{await f.run();f.sqlite.prepare("UPDATE mon_tasks SET status='executing',claim_token='lost',lease_until=?").run(f.now()-1);const c=fake();await engine(f,c).tick();assert.equal(c.posts,0);assert.equal(JSON.parse(f.sqlite.prepare('SELECT payload FROM mon_evidence').get().payload).status,'interrupted_unknown');}finally{f.close();}
});
test('normalization preserves occurrences, keeps retrieval separate, and rejects mismatched prompts',()=>{
 const r=normalizeCollection({provider:'grok',route,raw,context:{market:'US',language:'en'},prompt,remoteId:'test'});
 assert.equal(r.citations.length,1);assert.equal(r.collection.sourceReferences.length,4);
 assert.equal(r.collection.locationVerification,'unverified');
 assert.equal(normalizeCollection({provider:'grok',route,raw,context:{market:'US',language:'en'},prompt:'different',remoteId:'test'}).status,'provider_failed');
 const dfs=normalizeCollection({provider:'gemini',route:{transport:'dataforseo_scraper'},raw:{tasks:[{result:[{keyword:prompt,language_code:'en',location_code:2840,markdown:'Example is an option.',sources:[{url:'https://example.com/'}],items:[]}]}]},context:{market:'US',language:'en'},prompt,remoteId:'test',submissionMeta:{location_code:2840}});
 const row=extract(dfs,{kind:'neutral',identity:{brandName:'Example',aliases:[],ownedDomains:['example.com']}});
 assert.equal(aggregate([row],1).visibility,100);assert.equal(aggregate([row],1).citationRate,null);
});
test('Scrapeless non-2xx terminal failed result is recognized; 429 polling never submits',async()=>{
 const c=createCollectorClient({env:{SCRAPELESS_API_TOKEN:'fixture'},transport:async()=>new Response(JSON.stringify({status:'failed',message:'Execution failed'}),{status:500})});
 assert.equal((await c.poll({provider:'grok',route,remoteId:'test'})).status,'failed');
 const limited=createCollectorClient({transport:async()=>new Response('{}',{status:429})});
 assert.equal((await limited.poll({provider:'grok',route,remoteId:'test'})).status,'pending');
});
test('DataForSEO locale preflight refuses Gibraltar without issuing task_post',async()=>{
 const paths=[];
 const c=createCollectorClient({env:{CONSUMER_COLLECTION_ENABLED:'true',DATAFORSEO_LOGIN:'fixture',DATAFORSEO_PASSWORD:'fixture'},transport:async(url)=>{
  paths.push(url);return new Response(JSON.stringify({status_code:20000,tasks:[{status_code:20000,result:url.endsWith('languages')?[{language_code:'en'}]:[{country_iso_code:'US',location_type:'Country',location_code:2840}]}]}));
 }});
 const r=await c.submit({provider:'gemini',route:{transport:'dataforseo_scraper'},prompt,context:{market:'GI',language:'en'},taskId:'test'});
 assert.equal(r.result.status,'unsupported_context');assert.equal(paths.length,2);assert.ok(paths.every(p=>!p.includes('task_post')));
});
test('DataForSEO async contract encodes the exact prompt, freezes locale, and polls only the known ID',async()=>{
 const calls=[],question='What does C++ offer at 50% less cost?';
 const transport=async(url,options)=>{
  calls.push({url,method:options.method,body:options.body?JSON.parse(options.body):undefined});
  const task={id:'known-id',status_code:20100};
  const json=url.endsWith('/locations/FI')?{status_code:20000,tasks:[{status_code:20000,result:[{country_iso_code:'FI',location_type:'Country',location_code:2246}]}]}:
   url.endsWith('/languages')?{status_code:20000,tasks:[{status_code:20000,result:[{language_code:'sv'}]}]}:
   url.endsWith('/task_post')?{status_code:20000,tasks:[task]}:{status_code:20000,tasks:[{id:'known-id',status_code:20000,result:[{keyword:question,location_code:2246,language_code:'sv',markdown:'Example',model:'reported-model'}]}]};
  return new Response(JSON.stringify(json));
 };
 const client=createCollectorClient({env:{CONSUMER_COLLECTION_ENABLED:'true',DATAFORSEO_LOGIN:'fixture',DATAFORSEO_PASSWORD:'fixture'},transport});
 const r=await client.submit({provider:'openai',route:{transport:'dataforseo_scraper'},prompt:question,context:{market:'FI',language:'sv'},taskId:'local-task'});
 assert.equal(r.remoteId,'known-id');const posted=calls.find(c=>c.method==='POST').body[0];
 assert.equal(posted.keyword,encodeURIComponent(question));assert.equal(posted.force_web_search,false);assert.equal(posted.location_code,2246);assert.equal(posted.language_code,'sv');assert.equal(posted.priority,1);
 const polled=await client.poll({provider:'openai',route:{transport:'dataforseo_scraper'},remoteId:r.remoteId});assert.equal(polled.status,'ready');
 assert.ok(calls.at(-1).url.endsWith('/task_get/advanced/known-id'));
 assert.equal(normalizeCollection({provider:'openai',route:{transport:'dataforseo_scraper'},raw:polled.raw,context:{market:'FI',language:'sv'},prompt:question,remoteId:r.remoteId,submissionMeta:r.meta}).status,'success');
});
test('ambiguous POST failure consumes one attempt and never auto-retries',async()=>{
 let posts=0;const client=createCollectorClient({env:{CONSUMER_COLLECTION_ENABLED:'true',SCRAPELESS_API_TOKEN:'fixture'},transport:async()=>{posts++;throw Error('connection reset');}});
 const r=await client.submit({provider:'grok',route,prompt,context:{market:'US',language:'en'},taskId:'task'});
 assert.equal(r.result.status,'interrupted_unknown');assert.equal(posts,1);
});
test('raw-result receipt survives a parser restart without another GET or POST',async()=>{
 const f=await collectorFixture();try{
  await f.run();const c=fake();await engine(f,c).tick();
  f.sqlite.prepare("UPDATE mon_collections SET raw_json=?,phase='received'").run(JSON.stringify(raw));
  f.advance(5001);await engine(f,c).tick();
  assert.equal(c.posts,1);assert.equal(c.gets,0);assert.equal(f.sqlite.prepare('SELECT status FROM mon_tasks').get().status,'done');
 }finally{f.close();}
});
test('transient retrieval failure resumes GET, deadline ends safely, and metadata stays immutable',async()=>{
 const f=await collectorFixture();try{
  await f.run();const c=fake();const e=engine(f,c);await e.tick();c.poll=async()=>{throw Error('temporary network error');};
  f.advance(5001);await e.tick();assert.equal(c.posts,1);assert.equal(f.sqlite.prepare('SELECT status FROM mon_tasks').get().status,'collecting');
  f.advance(1800000);await e.tick();assert.equal(c.posts,1);assert.equal(JSON.parse(f.sqlite.prepare('SELECT payload FROM mon_evidence').get().payload).status,'timeout_unknown');
 }finally{f.close();}
});
test('polling continues to capture already-paid results when new collection is disabled',async()=>{
 const f=await collectorFixture();try{await f.run();const c=fake();await engine(f,c).tick();f.env.CONSUMER_COLLECTION_ENABLED='false';f.advance(5001);await engine(f,c).tick();assert.equal(c.posts,1);assert.equal(c.gets,1);assert.equal(f.sqlite.prepare('SELECT status FROM mon_tasks').get().status,'done');}finally{f.close();}
});
