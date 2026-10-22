import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {version,configuration,inputHash,validateEntities,fanoutAnalytics,discoveryAnalytics,domainKey,sourceType} from '../src/intelligence/core.mjs';
import {migrateIntelligence} from '../src/intelligence/migration.mjs';
import {intelligenceService} from '../src/intelligence/service.mjs';
import {createEntityEngine,enqueue} from '../src/intelligence/engine.mjs';
import {readIntelligence} from '../src/intelligence/read.mjs';
import {analyse} from '../src/intelligence/provider.mjs';
import {createCollectorClient} from '../src/collectors/client.mjs';
const env={ENTITY_ANALYSIS_ENABLED:'true',OPENAI_API_KEY:'test-only',ENTITY_ANALYSIS_MAX_DAILY_CALLS:'1'};
const c=configuration(env),stamp=100000;
const snapshot={identity:{brandName:'Example',aliases:[],ownedDomains:['example.com']},providers:['openai'],prompts:[{id:'p',version:1,text:'Which tools?',kind:'neutral'}],market:'FI',language:'fi'};
function fixture(){
 const raw=new DatabaseSync(':memory:');
 raw.exec(`CREATE TABLE app_migrations(id TEXT PRIMARY KEY,checksum TEXT,applied_at TEXT);
 CREATE TABLE app_projects(id TEXT PRIMARY KEY,owner_id TEXT,status TEXT);
 CREATE TABLE mon_runs(id TEXT PRIMARY KEY,project_id TEXT,owner_id TEXT,snapshot TEXT);
 CREATE TABLE mon_evidence(id TEXT PRIMARY KEY,run_id TEXT,payload TEXT,observed_at INTEGER);
 INSERT INTO app_projects VALUES('project','owner','active'),('foreign','other','active');`);
 const db={execute:async q=>{const {sql,args=[]}=typeof q==='string'?{sql:q}:q;const s=raw.prepare(sql);return s.columns().length?{rows:s.all(...args)}:{rows:[],rowsAffected:s.run(...args).changes};},transaction:async()=>{raw.exec('BEGIN');return {...db,commit:async()=>raw.exec('COMMIT'),rollback:async()=>raw.exec('ROLLBACK'),close(){}};}};
 const evidence=(id='e',answer='Alpha then Beta.',project='project')=>{
  const run=`r-${id}`,e={id,runId:run,promptId:'p',promptVersion:1,provider:'openai',status:'success',answer,text:'Which tools?',observedAt:stamp};
  raw.prepare('INSERT INTO mon_runs VALUES(?,?,?,?)').run(run,project,project==='project'?'owner':'other',JSON.stringify(snapshot));
  raw.prepare('INSERT INTO mon_evidence VALUES(?,?,?,?)').run(id,run,JSON.stringify(e),stamp);
  return e;
 };
 return {raw,db,evidence};
}
const parsed=e=>validateEntities({complete:true,brands:[{name:'Alpha',kind:'company',ambiguous:false,quotes:['Alpha']},{name:'Beta',kind:'product',ambiguous:false,quotes:['Beta']}]},e);
test('locale preflight failure is distinct from an ambiguous paid submission',async()=>{
 let posts=0;
 const client=createCollectorClient({env:{CONSUMER_COLLECTION_ENABLED:'true'},transport:async(_url,init)=>{if(init.method==='POST')posts++;throw Error('metadata offline');}});
 const r=await client.submit({provider:'gemini',route:{transport:'dataforseo_scraper'},context:{market:'FI',language:'fi'},prompt:'Test',taskId:'test'});
 assert.equal(posts,0);assert.equal(r.result.status,'provider_failed');assert.equal(r.result.meta.submission_attempted,false);
});
test('extracts exact original offsets, Finnish forms and preserves originals',()=>{
 const e={answer:'Suosittelen Mailchimpia ja HubSpotin palvelua.'},copy=JSON.stringify(e);
 const result=validateEntities({complete:true,brands:[{name:'Mailchimp',kind:'product',ambiguous:false,quotes:['Mailchimpia']}]},e);
 // Canonical suffix must be a documented supported form, not an arbitrary word.
 assert.equal(JSON.stringify(e),copy);assert.equal(result.brands[0].spans[0].start,12);
});
test('rejects unsupported inferred names, URL-only entities and truncated outputs',()=>{
 for(const output of [
  {complete:false,brands:[]},
  {complete:true,brands:[{name:'Invented',kind:'company',ambiguous:false,quotes:['Invented']}]},
  {complete:true,brands:[{name:'Alpha',kind:'company',ambiguous:false,quotes:['Alpha']}]},
 ])assert.throws(()=>validateEntities(output,{answer:'https://Alpha.example/'}),/INVALID_ENTITY/);
});
test('compound product owns an overlapping mention; standalone parent stays separate',()=>{
 const r=validateEntities({complete:true,brands:[{name:'Alpha',kind:'company',ambiguous:false,quotes:['Alpha']},{name:'Alpha Suite',kind:'product',ambiguous:false,quotes:['Alpha Suite']}]},{answer:'Alpha Suite and Alpha.'});
 assert.equal(r.brands[0].spans.length,1);assert.equal(r.brands[0].spans[0].start,16);
 assert.equal(r.brands[1].spans[0].start,0);
});
test('model context quotes are not trusted spans; literal inflected names are resolved server-side',()=>{
 const answer='Brevosta voi aloittaa. Brevo tarjoaa sähköpostipalvelun.';
 const r=validateEntities({complete:true,brands:[{name:'Brevo',kind:'product',ambiguous:false,quotes:['Brevo tarjoaa','not a real quote']}]},{answer});
 assert.deepEqual(r.brands[0].spans.map(s=>s.text),['Brevosta','Brevo']);
 assert.equal(r.brands[0].spans[0].start,0);
});
test('skipped oversized answers cannot starve future automatic analysis',async()=>{
 const f=fixture();await migrateIntelligence(f.db);const e=f.evidence('long','x'.repeat(24001));
 assert.equal(await enqueue(f.db,[{payload:JSON.stringify(e),run_id:e.runId}],c,stamp),0);
 assert.equal(f.raw.prepare('SELECT status FROM intelligence_jobs').get().status,'skipped');
 assert.equal(configuration({ENTITY_ANALYSIS_MAX_DAILY_CALLS:'0'}).daily,0);
});
test('Finnish illative and consonant-brand case forms remain literal grounded mentions',()=>{
 for(const [name,form] of [['Canva','Canvaan'],['Brevo','Brevoon'],['HubSpot','HubSpotissa'],['HubSpot','HubSpotista'],['Shopify','Shopifyyn']]){
  const answer=`Siirry ${form}.`;
  const r=validateEntities({complete:true,brands:[{name,kind:'product',ambiguous:false,quotes:[name]}]},{answer});
  assert.equal(r.brands[0].spans[0].text,form);
  assert.equal(r.brands[0].spans[0].start,7);
 }
});
test('fanout deduplicates per answer; preserves variants/provenance; unknown is not zero',()=>{
 const rows=[
  {id:'a',provider:'openai',collection:{supplier:'dataforseo',searchQueries:[' Café tools ','café tools']}},
  {id:'b',provider:'gemini',collection:{supplier:'dataforseo',searchQueries:[]}},
  {id:'c',provider:'grok',collection:{follow_up_suggestions:['not a search']}},
  {id:'d',provider:'openai',exclusion:'failed',collection:{supplier:'dataforseo',searchQueries:['x']}},
 ];
 const a=fanoutAnalytics(rows);assert.equal(a.eligibleAnswers,3);assert.equal(a.observableAnswers,2);
 assert.equal(a.withQueries,1);assert.equal(a.queries[0].answers,1);assert.equal(a.queries[0].variants.length,2);
 assert.equal(fanoutAnalytics([{id:'x',collection:{supplier:'dataforseo',searchQueries:[{title:'not a query'}]}}]).observableAnswers,0);
});
test('publisher types are conservative, review overrides/reset and ownership are separate',()=>{
 assert.equal(sourceType('reddit.com').sourceType,'ugc');assert.equal(sourceType('random-news.test').sourceType,'unknown');
 assert.equal(sourceType('bbc.com').sourceType,'editorial');assert.equal(sourceType('stat.fi').sourceType,'institutional');
 assert.equal(sourceType('bbc.com',new Map([['bbc.com',{value:'unknown',updated_at:1}]])).sourceType,'unknown');
 assert.equal(domainKey('BBC.COM'),'bbc.com');assert.equal(domainKey('evil.test/path'),null);
});
test('ranking includes untracked brands, zero-brand answers in denominator, and excludes rejected/ambiguous positions',()=>{
 const rows=[{id:'e',answer:'Alpha then Beta.'},{id:'none',answer:'Generic advice.'}];
 const jobs=new Map(rows.map(e=>[e.id,{status:'done',input_hash:inputHash(e),result_json:JSON.stringify(e.id==='e'?parsed(e):{version,brands:[]})}]));
 const a=discoveryAnalytics(rows,jobs,new Map());assert.equal(a.analysedAnswers,2);assert.equal(a.rankings[0].visibility,50);assert.equal(a.rankings[0].winRate,50);
 assert.equal(a.rankings.find(b=>b.name==='Beta').averagePosition,2);
 const b=discoveryAnalytics(rows,jobs,new Map([['alpha',{value:'rejected'}]]));assert.equal(b.rankings.find(b=>b.name==='Beta').averagePosition,1);
 assert.equal(b.rankings.find(b=>b.name==='Alpha').visibility,null);
 rows[0].answer='Changed';assert.equal(discoveryAnalytics(rows,jobs,new Map()).analysedAnswers,1);
});
test('migration is idempotent; read is non-paying; ownership, annotation create/update/reset and audit',async()=>{
 const f=fixture();await migrateIntelligence(f.db);await migrateIntelligence(f.db);const e=f.evidence();
 const request=body=>intelligenceService({db:f.db,path:'/v1/projects/project/intelligence',body,userId:'owner',env,now:()=>stamp});
 await assert.rejects(()=>intelligenceService({db:f.db,path:'/v1/projects/project/intelligence',body:{},userId:'other',env}),e=>e.status===404);
 for(const value of ['corporate','editorial',null])await request({action:'source_review',domain:'example.com',sourceType:value});
 assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM intelligence_reviews').get().n,0);
 assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM intelligence_review_audit').get().n,3);
 const before=f.raw.prepare('SELECT COUNT(*) n FROM intelligence_jobs').get().n;
 const overview={sources:{items:[{domain:'bbc.com'}]}};
 const data=await readIntelligence(f.db,'project',[{id:e.runId,rows:[e]}],overview,env);
 assert.equal(data.available,true);assert.equal(data.jobs[0].state,'not_analysed');assert.equal(overview.sources.items[0].sourceType,'editorial');
 assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM intelligence_jobs').get().n,before);
 await request({action:'analyse',evidenceIds:['e']});assert.equal((await request({action:'analyse',evidenceIds:['e']})).data.queued,0);
 f.evidence('other','Other.','foreign');await assert.rejects(()=>request({action:'analyse',evidenceIds:['other']}),e=>e.status===404);
});
test('worker independent daily cap, exactly once enqueue, disabled flag, and no automatic retry',async()=>{
 const f=fixture();await migrateIntelligence(f.db);const e=f.evidence(),e2=f.evidence('e2');
 await enqueue(f.db,[e,e2].map(e=>({payload:JSON.stringify(e),run_id:e.runId})),c,stamp);
 let calls=0;const engine=createEntityEngine({db:f.db,env,now:()=>stamp+1,call:async e=>{calls++;return parsed(e);}});
 await engine.tick();await engine.tick();assert.equal(calls,1);
 assert.equal(f.raw.prepare("SELECT error FROM intelligence_jobs WHERE evidence_id='e2'").get().error,'BUDGET_WAIT');
 const disabled=createEntityEngine({db:f.db,env:{...env,ENTITY_ANALYSIS_ENABLED:'false'},call:async()=>{throw Error('must not call');}});await disabled.tick();
});
test('expired/unknown paid lease is never resubmitted',async()=>{
 const f=fixture();await migrateIntelligence(f.db);const e=f.evidence();
 await enqueue(f.db,[{payload:JSON.stringify(e),run_id:e.runId}],c,stamp);
 f.raw.prepare("UPDATE intelligence_jobs SET status='running',lease_until=1,claim_token='old'").run();
 let calls=0;await createEntityEngine({db:f.db,env,now:()=>stamp+1,call:async()=>{calls++;}}).tick();
 assert.equal(calls,0);assert.equal(f.raw.prepare('SELECT status FROM intelligence_jobs').get().status,'interrupted_unknown');
});
test('response finish length rejects without retry',async()=>{
 let calls=0;
 await assert.rejects(()=>analyse({answer:'Alpha'},c,{env,fetcher:async()=>{calls++;return new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{}'}}]}));}}),/ENTITY_INCOMPLETE/);
 assert.equal(calls,1);
});
