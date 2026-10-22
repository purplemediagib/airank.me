import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrations} from '../src/migrate.mjs';
import {appDDL} from '../src/app/migration.mjs';
import {scanDDL} from '../src/app/scan-migration.mjs';
import {ddl} from '../src/monitoring/migration.mjs';
import {migrateReports} from '../src/reports/migration.mjs';
import {apiObservation,responseOccurrences,reconcileObservation,collectionMethodVersion,completeAnswerMetricVersion,legacyMetricVersion} from '../src/common/observations.mjs';
import {extract,aggregate} from '../src/analytics/extraction.mjs';
import {analyticsService,composition,promptSummaries} from '../src/analytics/service.mjs';
import {competitorMeasurements} from '../src/analytics/competitors.mjs';
import {sourceAnalytics} from '../src/analytics/sources.mjs';
import {overviewInsights} from '../src/analytics/overview.mjs';
import {hash} from '../src/monitoring/shared.mjs';
import {extractionVersion} from '../src/analytics/extraction.mjs';
import {collectionSurface} from '../src/common/observations.mjs';
import {normalizeGroundedResponse} from '../src/providers/grounded-responses.mjs';
import {openaiSearch} from '../src/providers/openai.mjs';
import {openrouterSearch} from '../src/providers/openrouter.mjs';
import {geminiSearch} from '../src/providers/gemini.mjs';
import {reportService} from '../src/reports/service.mjs';
import {resultsService} from '../src/analytics/results.mjs';

const identity={brandName:'Example',aliases:[],ownedDomains:['example.test']};
const rival={brandName:'Rival',aliases:[],ownedDomains:['rival.test']};
const legacy={identity,identityVersion:1,kind:'neutral',market:'FI',language:'en',
 methodology:'tracked-fi-evidence-v1',cohort:{version:1,brands:[identity,rival]},
 prompts:[{id:'p',version:1,text:'Which services are available?',tags:[],topic:''}],
 routes:[{provider:'openai',model:'fixture',measurement_surface:'model_api'}]};
const future={...legacy,methodology:'tracked-api-complete-answer-v2',collectionMethod:collectionMethodVersion};
const evidence=(id,extra={})=>({id,runId:id,promptId:'p',promptVersion:1,text:legacy.prompts[0].text,
 provider:'openai',model:'fixture',status:'no_grounding',answer:'Example and Rival are available.',citations:[],
 observation:apiObservation({complete:true}),...extra});
const entry=(snapshot,rows)=>({id:'run',createdAt:1,kind:'neutral',status:'completed',snapshot,rows,
 rawRows:rows,tasks:rows.map(row=>({id:row.id,prompt_id:'p',prompt_version:1,text:row.text,provider:row.provider})),group:'fixture'});

test('only future complete API uncited answers are valid; legacy, failed, truncated and missing telemetry stay excluded',()=>{
 const original=evidence('uncited'),before=JSON.stringify(original);
 const current=extract(original,future),historical=extract(original,legacy);
 assert.equal(current.status,'success');assert.equal(current.mentioned,true);assert.equal(current.exclusion,null);
 assert.equal(current.metricVersion,completeAnswerMetricVersion);
 assert.equal(aggregate([current],1).visibility,100);assert.equal(aggregate([current],1).citationRate,0);
 assert.equal(historical.status,'no_grounding');assert.equal(historical.metricVersion,legacyMetricVersion);
 assert.equal(aggregate([historical],1).eligible,0);assert.equal(JSON.stringify(original),before);
 for(const status of ['failed','incomplete','timeout_unknown','provider_failed']){
  assert.ok(extract(evidence(status,{status}),future).exclusion);
 }
 for(const observation of [undefined,apiObservation({complete:false}),{version:'future-unknown',complete:true}]){
  assert.equal(extract(evidence('missing',{status:'success',observation}),future).status,'incomplete');
 }
 const truncated=reconcileObservation(original,future,{truncated:true});
 assert.equal(truncated.status,'incomplete');assert.equal(truncated.observation.complete,false);
 assert.equal(extract(evidence('empty',{answer:'   '}),future).mentioned,false);
 assert.equal(extract(original,{...future,kind:'diagnostic'}).exclusion,'diagnostic');
});

test('consumer originals and occurrence semantics are untouched even inside a new mixed-method snapshot',()=>{
 const collection={surface:'consumer_web',citationObservation:'not_observed',sourceReferences:[
  {url:'https://example.test/',kind:'source_reference',occurrences:2,provenance:'supplier_sources'}]};
 const consumer=evidence('consumer',{status:'success',collection,observation:undefined});
 const before=JSON.stringify(consumer);
 assert.equal(reconcileObservation(consumer,future),consumer);
 const parsed=extract(consumer,future);
 assert.equal(parsed.collection,collection);assert.equal(parsed.metricVersion,legacyMetricVersion);
 assert.equal(parsed.collectionMethod,'consumer-original-v1');assert.equal(parsed.mentioned,true);
 assert.equal(JSON.stringify(consumer),before);
 const uncited=evidence('consumer-no-grounding',{collection,observation:undefined});
 assert.equal(extract(uncited,future).status,'no_grounding');
});

const citation={type:'url_citation',url:'https://example.test/page',title:'Example',start_index:0,end_index:7};
const payload={status:'completed',model:'fixture',output:[{type:'message',status:'completed',content:[
 {type:'output_text',text:'Example and Example.',annotations:[citation,{...citation,start_index:12,end_index:19}]}
]}]};

test('repeated API annotations preserve provider-local spans without retrieval/fanout invention',()=>{
 const result=normalizeGroundedResponse(payload,{model:'fixture',surface:'API'});
 assert.equal(result.citations.length,1);assert.equal(result.observation.citationOccurrences.length,2);
 assert.deepEqual(result.observation.citationOccurrences.map(r=>[r.start,r.end,r.blockIndex]),[[0,7,0],[12,19,0]]);
 assert.equal(result.observation.retrievalObservation,'unavailable');
 assert.equal(result.observation.fanoutObservation,'unavailable');
 const row=extract(evidence('repeated',result),future),source=sourceAnalytics([entry(future,[row])]);
 assert.equal(source.items[0].answers,1);assert.equal(source.items[0].reportedOccurrences,2);
 assert.equal(source.coverage.find(c=>c.kind==='retrieval').observableAnswers,0);
 assert.equal(apiObservation({complete:true,occurrences:[{url:'javascript:bad'},{url:'https://u:p@example.test'}]}).citationOccurrences.length,0);
 assert.equal(Object.hasOwn(apiObservation({complete:true,occurrences:[{url:'https://example.test'}]}).citationOccurrences[0],'start'),false);
 assert.equal(responseOccurrences([{annotations:[{type:'url_citation',url_citation:{url:'https://example.test',start_index:1,end_index:4}}]}])[0].start,1);
});

test('non-Claude adapter observation hooks retain repeated annotations; refusal/tool failures and Gemini token limits remain incomplete',async()=>{
 const previous=globalThis.fetch;
 globalThis.fetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify(payload)});
 try{
  const openai=await openaiSearch('Fixture question');
  assert.equal(openai.observation.citationOccurrences.length,2);assert.equal(openai.observation.complete,true);
  const unfinished=structuredClone(payload);unfinished.output.push({type:'web_search_call',status:'failed'});
  globalThis.fetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify(unfinished)});
  assert.equal((await openaiSearch('Fixture question')).observation.complete,false);
  for(const finishReason of ['STOP','MAX_TOKENS',undefined]){
   const reply={candidates:[{finishReason,content:{parts:[{text:'Example'}]},groundingMetadata:{
    groundingChunks:[{web:{uri:'https://example.test'}}],
    groundingSupports:[{segment:{startIndex:0,endIndex:7},groundingChunkIndices:[0]},
     {segment:{startIndex:10,endIndex:17},groundingChunkIndices:[0]}]}}]};
   globalThis.fetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify(reply)});
   const gemini=await geminiSearch('Fixture question');
   assert.equal(gemini.observation.citationOccurrences.length,2);
   assert.equal(gemini.observation.complete,finishReason==='STOP');
  }
  const router=await openrouterSearch('Fixture question',{model:'google/fixture',apiKey:'fixture-not-a-secret',
   fetchImpl:async()=>({ok:true,status:200,json:async()=>({choices:[{finish_reason:'stop',message:{content:[
    {type:'text',text:'Example',annotations:[{type:'url_citation',url_citation:citation}]},
    {type:'text',text:'Example',annotations:[{type:'url_citation',url_citation:citation}]},
   ]}}]})})});
  assert.deepEqual(router.observation.citationOccurrences.map(r=>r.blockIndex),[0,1]);
 }finally{globalThis.fetch=previous;}
});

test('mixed surface/version aggregations fail closed, and incompatible frozen cohorts never borrow competitor identities',()=>{
 const api=extract(evidence('api'),future),old=extract(evidence('old',{status:'success'}),legacy);
 const consumer=extract(evidence('web',{status:'success',collection:{surface:'consumer_web'}}),future);
 assert.equal(aggregate([api,consumer],2).state,'incompatible');
 assert.equal(aggregate([api,old],2).eligible,0);
 const entries=[entry(future,[api]),entry(future,[consumer])];
 assert.equal(sourceAnalytics(entries).state,'incompatible');
 assert.equal(overviewInsights(entries).state,'incompatible');
 assert.deepEqual(competitorMeasurements(entries),[]);
 const edited={...future,cohort:{version:2,brands:[identity,{...rival,brandName:'Changed'}]}};
 assert.deepEqual(competitorMeasurements([entry(future,[api]),entry(edited,[extract(evidence('new'),edited)])]),[]);
 const tasks=entry(future,[api]).tasks;
 assert.notEqual(composition(future,tasks,[api]),composition(legacy,tasks,[old]));
 assert.notEqual(composition(future,tasks,[api]),composition(edited,tasks,[api]));
 const summaries=promptSummaries([{...entry(legacy,[old]),createdAt:1},{...entry(future,[api]),createdAt:2}]);
 assert.equal(summaries[0].groupCount,2);assert.equal(summaries[0].metrics.eligible,1);
});

async function fixture(){
 const sql=new DatabaseSync(':memory:');
 for(const q of [...migrations,...appDDL,scanDDL,...ddl])sql.exec(q);
 sql.exec('CREATE TABLE app_migrations (id TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
 const db={execute:async q=>{
  const text=typeof q==='string'?q:q.sql,args=typeof q==='string'?[]:q.args||[],statement=sql.prepare(text);
  return /^\s*SELECT/i.test(text)?{rows:statement.all(...args)}:{rows:[],rowsAffected:Number(statement.run(...args).changes)};
 }};
 db.transaction=async()=>{
  sql.exec('BEGIN');
  return {execute:db.execute,commit:async()=>sql.exec('COMMIT'),rollback:async()=>sql.exec('ROLLBACK'),close:()=>{}};
 };
 sql.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run('alice','alice','alice@example.test','Alice','',1,1);
 sql.prepare('INSERT INTO app_projects VALUES (?,?,?,?,?)').run('project','alice','active',1,1);
 sql.prepare('INSERT INTO app_identity_versions VALUES (?,?,?,?)').run('project',1,JSON.stringify(identity),1);
 await migrateReports(db);
 const add=(id,snapshot,values,stamp)=>{
  sql.prepare('INSERT INTO mon_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'project','alice',id,id,'neutral','completed',JSON.stringify(snapshot),values.length,stamp,stamp+1,null);
  for(const value of values){
   sql.prepare('INSERT INTO mon_tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run(value.id,id,'p',1,value.text,value.provider,'{}','done',null,null);
   sql.prepare('INSERT INTO mon_evidence VALUES (?,?,?,?)').run(value.id,id,JSON.stringify({...value,runId:id}),stamp);
  }
 };
 return {sql,db,add,get:query=>analyticsService({db,userId:'alice',path:'/v1/projects/project/analytics',query:new URLSearchParams(query)})};
}

test('result serialization preserves API observation occurrences and completion method versions',async()=>{
 const f=await fixture();
 try{
  const observation=apiObservation({complete:true,occurrences:[
   {url:'https://example.test/source',blockIndex:0,start:0,end:7},
   {url:'https://example.test/source',blockIndex:1,start:2,end:9},
  ]});
  f.add('api-run',future,[evidence('api-result',{observation})],100);
  const detail=(await resultsService({db:f.db,userId:'alice',path:'/v1/projects/project/results/api-result'})).data;
  assert.deepEqual(detail.observation,observation);
  assert.equal(detail.collectionMethod,collectionMethodVersion);
  assert.equal(detail.metricVersion,completeAnswerMetricVersion);
  const list=(await resultsService({db:f.db,userId:'alice',path:'/v1/projects/project/results'})).data;
  assert.deepEqual(list.items[0].observation,observation);
 }finally{f.sql.close();}
});

// Construct exactly the hash that saved links used before reconciliation,
// independently of the new compatibility helper.
const savedGroup=(s,values)=>hash({identity:s.identity,identityVersion:s.identityVersion,cohort:s.cohort||null,
 methodology:s.methodology,metrics:'neutral-valid-weighted-v2-citation-coverage',extraction:extractionVersion,
 market:s.market,language:s.language,kind:s.kind,
 prompts:values.map(v=>['p',1,v.text]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
 routes:s.routes,models:[...new Set(values.map(v=>`${v.provider}:${v.model||'unknown'}`))].sort()});

test('saved pre-reconciliation group links resolve without rewriting historical evidence',async()=>{
 const f=await fixture();
 try{
  const values=[evidence('saved-answer',{status:'success'})],group=savedGroup(legacy,values);
  f.add('saved-run',legacy,values,100);
  const before=f.sql.prepare('SELECT payload FROM mon_evidence').get().payload;
  const a=(await f.get(new URLSearchParams({group}))).data;
  assert.equal(a.metrics.expected,1);
  assert.equal(a.evidence[0].id,'saved-answer');
  assert.equal(a.groups.find(g=>g.id===a.selectedGroup).collectionMethod,'citation-required-v1');
  const results=(await resultsService({db:f.db,userId:'alice',path:'/v1/projects/project/results',query:new URLSearchParams({group})})).data;
  assert.equal(results.total,1);
  assert.equal(f.sql.prepare('SELECT payload FROM mon_evidence').get().payload,before);
  await assert.rejects(f.get('group=not-a-real-saved-id'),e=>e.code==='INVALID_FILTER');
 }finally{f.sql.close();}
});

test('saved legacy mixed groups resolve to one canonical partition, never pooled totals',async()=>{
 const f=await fixture();
 try{
  const snapshot={...legacy,routes:[...legacy.routes,{provider:'gemini',model:'consumer-auto',measurement_surface:'consumer_web'}]};
  const values=[evidence('legacy-api',{status:'success'}),evidence('legacy-web',{provider:'gemini',status:'success',collection:{surface:'consumer_web'}})];
  f.add('saved-mixed',snapshot,values,100);
  const a=(await f.get(new URLSearchParams({group:savedGroup(snapshot,values)}))).data;
  assert.equal(a.groups.length,2);
  assert.equal(a.metrics.expected,1);
  assert.equal(a.evidence.length,1);
  assert.ok(['model_api','consumer_web'].includes(a.metrics.measurementSurface));
 }finally{f.sql.close();}
});

test('Grok and AIO product metadata never becomes a filter surface; analytics-to-Results stays aligned',async()=>{
 for(const [provider,product] of [['grok','Grok API'],['google_aio','Google desktop SERP / DataForSEO']]){
  const f=await fixture();
  try{
   // Missing historical route surface and explicit future route surface both work.
   for(const [i,routeSurface] of [undefined,'model_api'].entries()){
    const snapshot={...legacy,routes:[{provider,model:'fixture',...(routeSurface?{measurement_surface:routeSurface}:{})}]};
    const row=evidence(`${provider}-${i}`,{provider,status:'success',meta:{measurement_surface:product}});
    f.add(`${provider}-run-${i}`,snapshot,[row],100+i);
   }
   const analytics=(await f.get('surface=model_api')).data;
   assert.deepEqual(analytics.availableSurfaces,['model_api']);
   assert.ok(analytics.evidence.every(e=>e.measurementSurface==='model_api'));
   const results=(await resultsService({db:f.db,userId:'alice',path:'/v1/projects/project/results',query:new URLSearchParams({surface:'model_api',group:analytics.selectedGroup})})).data;
   assert.equal(results.total,analytics.metrics.expected);
   assert.equal(results.items[0].meta.measurement_surface,product);
  }finally{f.sql.close();}
 }
 assert.equal(collectionSurface({provider:'grok',meta:{measurement_surface:'consumer_web'}},
  {routes:[{provider:'grok',measurement_surface:'model_api'}]}),'model_api');
});

test('mixed runs partition all expected populations; selected reports and historical groups stay aligned',async()=>{
 const f=await fixture();
 try{
  const mixed={...future,routes:[...future.routes,{provider:'gemini',model:'consumer-auto',measurement_surface:'consumer_web'}]};
  f.add('mixed',mixed,[evidence('api'),evidence('web',{provider:'gemini',status:'success',observation:undefined,collection:{surface:'consumer_web'}})],200);
  f.add('historical',legacy,[evidence('historical-uncited')],100);
  const before=f.sql.prepare("SELECT payload FROM mon_evidence WHERE id='historical-uncited'").get().payload;
  const all=(await f.get('')).data;
  assert.equal(all.groups.length,3);
  assert.equal(all.metrics.expected,1);assert.equal(all.metrics.eligible,1);
  const apiGroup=all.groups.find(g=>g.collectionMethod===collectionMethodVersion);
  const webGroup=all.groups.find(g=>g.measurementSurface==='consumer_web');
  const oldGroup=all.groups.find(g=>g.collectionMethod==='citation-required-v1');
  assert.ok(apiGroup&&webGroup&&oldGroup);
  const api=(await f.get(`runId=mixed&group=${apiGroup.id}`)).data;
  assert.equal(api.evidence.length,1);assert.equal(api.evidence[0].id,'api');
  assert.equal(api.providers.length,1);assert.equal(api.competitors[0].metrics.expected,1);
  assert.equal(api.overview.sources.eligibleAnswers,1);
  const web=(await f.get('runId=mixed&surface=consumer_web')).data;
  assert.equal(web.metrics.expected,1);assert.equal(web.evidence[0].id,'web');
  const old=(await f.get(`group=${oldGroup.id}`)).data;
  assert.equal(old.metrics.eligible,0);assert.equal(old.methodology,legacyMetricVersion);
  assert.equal(f.sql.prepare("SELECT payload FROM mon_evidence WHERE id='historical-uncited'").get().payload,before);
  const report=(await reportService({db:f.db,userId:'alice',method:'POST',path:'/v1/projects/project/reports',
   body:{locale:'en',filters:{runId:'mixed',surface:'consumer_web',group:webGroup.id}},now:()=>1000})).data.snapshot;
  assert.equal(report.analytics.metrics.expected,1);assert.equal(report.analytics.evidence[0].id,'web');
  assert.equal(report.runSnapshots.length,1);assert.equal(report.filters.surface,'consumer_web');
  assert.equal(report.analytics.groups.find(g=>g.id===report.analytics.selectedGroup).measurementSurface,'consumer_web');
  await assert.rejects(f.get(`runId=historical&group=${apiGroup.id}`),error=>error.code==='INVALID_FILTER');
 }finally{f.sql.close();}
});
