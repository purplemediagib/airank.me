import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrations} from '../src/migrate.mjs';
import {migrateApp} from '../src/app/migration.mjs';
import {scanDDL} from '../src/app/scan-migration.mjs';
import {migrateMonitoring} from '../src/monitoring/migration.mjs';
import {migrateSentiment} from '../src/sentiment/migration.mjs';
import {config,brandsFor,brandKey,validateAssessments,aggregateSentiment,rubricVersion} from '../src/sentiment/core.mjs';
import {analyse} from '../src/sentiment/provider.mjs';
import {createSentimentEngine} from '../src/sentiment/engine.mjs';
import {backfillService} from '../src/sentiment/service.mjs';
import {analyticsService} from '../src/analytics/service.mjs';
import {resultsService} from '../src/analytics/results.mjs';
import {createAppService,csrfFor} from '../src/app/service.mjs';
import {hashToken} from '../src/common/utils.mjs';

const identity={brandName:'Example',aliases:['Example Oy'],ownedDomains:['example.fi']};
const other={brandName:'Other',aliases:[],ownedDomains:['other.fi']};
const snapshot={identity,identityVersion:1,kind:'neutral',market:'FI',language:'en',methodology:'tracked-fi-evidence-v1',prompts:[{id:'p',version:1,text:'Which tools?',topic:'Tools'}],routes:[{provider:'openai',model:'fixture-search'}],cohort:{brands:[identity,other]}};
const quote=(text,polarity='positive',attribute='usability')=>({text,polarity,attribute});
const output=(quotes,extra={})=>({assessments:[{brandId:brandKey(identity),status:'assessed',quotes,...extra},{brandId:brandKey(other),status:'not_mentioned',quotes:[]}]});
const evidence=(answer='Example is easy to use.')=>({id:'e',runId:'run',promptId:'p',promptVersion:1,text:'Which tools?',provider:'openai',model:'fixture-search',status:'success',answer,citations:[{url:'https://example.fi/page'}],observedAt:1000000});
const response=(content,extra={})=>new Response(JSON.stringify({id:'analysis-1',model:'gpt-4.1-mini-2025-04-14',choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:20,completion_tokens:30,total_tokens:50},...extra}),{status:200,headers:{'Content-Type':'application/json'}});

async function fixture(extra={}){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');
 for(const q of migrations)sql.exec(q);
 const execute=async q=>{const text=typeof q==='string'?q:q.sql,args=typeof q==='string'?[]:q.args||[],s=sql.prepare(text);return /^\s*(SELECT|PRAGMA)/.test(text)?{rows:s.all(...args)}:{rows:[],rowsAffected:Number(s.run(...args).changes)};};
 let tail=Promise.resolve();
 const db={execute,transaction:async()=>{let release;const next=new Promise(r=>release=r),previous=tail;tail=next;await previous;sql.exec('BEGIN IMMEDIATE');return {execute,commit:async()=>sql.exec('COMMIT'),rollback:async()=>sql.exec('ROLLBACK'),close:release};}};
 sql.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run('alice','alice','alice@example.test','Alice','',1,1);
 await migrateApp(db);sql.exec(scanDDL);await migrateMonitoring(db);await migrateSentiment(db);
 sql.prepare('INSERT INTO app_projects VALUES (?,?,?,?,?)').run('project','alice','active',1,'2026-01-01T00:00:00Z');
 sql.prepare('INSERT INTO app_identity_versions VALUES (?,?,?,?)').run('project',1,JSON.stringify(identity),'2026-01-01T00:00:00Z');
 let clock=1000000;
 const env={SENTIMENT_ENABLED:'true',OPENAI_API_KEY:'secret-fixture',SENTIMENT_MAX_DAILY_CALLS:'100',...extra},now=()=>clock;
 const add=(id='run',answer='Example is easy to use.',s=snapshot,{status='success',pending=false,at=clock}={})=>{
  sql.prepare('INSERT INTO mon_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'project','alice',id,id,s.kind,pending?'running':'complete',JSON.stringify(s),1,at,at+1000,null);
  sql.prepare('INSERT INTO mon_tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,id,'p',1,'Which tools?','openai',JSON.stringify(s.routes[0]),pending?'queued':'done',null,null);
  if(!pending)sql.prepare('INSERT INTO mon_evidence VALUES (?,?,?,?)').run(id,id,JSON.stringify({...evidence(answer),id,runId:id,status,observedAt:at}),at);
 };
 const backfill=(runId='run',userId='alice')=>backfillService({db,path:'/v1/projects/project/sentiment-backfill',body:{runId},userId,env,now});
 const results=(query='',userId='alice',suffix='')=>resultsService({db,path:'/v1/projects/project/results'+suffix,query:new URLSearchParams(query),userId,env});
 const analytics=()=>analyticsService({db,path:'/v1/projects/project/analytics',userId:'alice',env});
 const logs=[];
 const worker=(opts={})=>createSentimentEngine({db,env,now,logger:(event,data)=>logs.push({event,...data}),call:async(e,s,c)=>analyse(e,s,c,{env,now,fetcher:async()=>response(output([quote(e.answer)]))}),...opts});
 return {sql,db,env,now,add,backfill,results,analytics,worker,logs,advance:n=>clock+=n,close:()=>sql.close()};
}

test('quotes determine scores, mixed evidence remains mixed, offsets match original answer',()=>{
 const e=evidence('Example is easy to use. Example is expensive.');
 const a=validateAssessments(output([quote('Example is easy to use.'),quote('Example is expensive.','negative','price')]),e,snapshot)[0];
 assert.equal(a.score,50);assert.equal(a.label,'mixed');
 for(const q of a.quotes)assert.equal(e.answer.slice(q.start,q.end),q.text);
 const fi=evidence('Example Oy on luotettava.');
 assert.equal(validateAssessments(output([quote(fi.answer,'positive','luotettavuus')]),fi,{...snapshot,language:'fi'})[0].score,75);
 assert.equal(validateAssessments(output([quote('Example is easy to use.','neutral','')]),e,snapshot)[0].score,50);
});
test('rejects fabricated quotes, duplicated/overlapping excerpts, wrong brands, false absence and missing brand context',()=>{
 const e=evidence('Example is easy to use.');
 for(const o of [output([quote('Invented praise.')]),output([quote(e.answer),quote(e.answer)]),output([quote(e.answer),quote('easy to use')]),output([quote('easy to use')]),output([],{status:'not_mentioned'}),{assessments:[output([quote(e.answer)]).assessments[0],output([quote(e.answer)]).assessments[0]]}])assert.throws(()=>validateAssessments(o,e,snapshot),/INVALID_SENTIMENT_OUTPUT/);
 assert.equal(validateAssessments(output([],{status:'unclassified'}),e,snapshot)[0].score,null);
 assert.throws(()=>validateAssessments(output([quote(e.answer)]),evidence('Other is good.'),snapshot));
});
test('OpenAI adapter uses structured output, treats answer as data, and handles refusal, truncation and HTTP failure',async()=>{
 let request;const env={OPENAI_API_KEY:'secret'},c=config(env),e=evidence();
 const r=await analyse(e,snapshot,c,{env,fetcher:async(url,options)=>{request={url,...options,body:JSON.parse(options.body)};return response(output([quote(e.answer)]));}});
 assert.equal(request.body.model,c.model);assert.equal(request.body.store,false);assert.equal(request.body.response_format.json_schema.strict,true);assert.equal(request.body.tools,undefined);
 assert.equal(JSON.parse(request.body.messages[1].content).answer,e.answer);assert.match(request.body.messages[0].content,/UNTRUSTED/);
 assert.equal(r.assessments[0].score,75);assert.equal(r.usage.total_tokens,50);assert.equal(JSON.stringify(r).includes('secret'),false);
 for(const [res,code] of [[new Response('private body',{status:429}),'SENTIMENT_HTTP_429'],[response(null,{choices:[{finish_reason:'stop',message:{refusal:'private refusal'}}]}),'SENTIMENT_REFUSED'],[response(null,{choices:[{finish_reason:'length',message:{content:'{}'}}]}),'SENTIMENT_INCOMPLETE'],[response(output([quote('fake quote')])),'INVALID_SENTIMENT_OUTPUT']])await assert.rejects(analyse(e,snapshot,c,{env,fetcher:async()=>res}),x=>x.code===code);
});
test('analysis persists once and is exposed in owner analytics, competitor metrics, paginated result and detail',async()=>{
 const f=await fixture();try{
  f.add();const w=f.worker();await w.tick();await w.tick();
  const a=(await f.analytics()).data;assert.equal(a.metrics.sentiment.score,75);assert.equal(a.metrics.sentiment.sampleSize,1);assert.equal(a.metrics.visibility,100);
  assert.equal(a.metrics.sentiment.attributes[0].attribute,'usability');assert.equal(a.metrics.sentiment.attributes[0].answers,1);
  assert.equal(a.competitors[0].metrics.sentiment.score,75);assert.equal(a.competitors[1].metrics.sentiment.score,null);
  const r=(await f.results()).data;assert.equal(r.items[0].sentiment.quotes[0].text,'Example is easy to use.');assert.equal(r.items[0].state,'success');
  assert.equal((await f.results('','alice','/run')).data.sentiment.score,75);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM sentiment_jobs WHERE started_at IS NOT NULL').get().n,1);
  assert.equal(f.logs.filter(x=>x.event==='sentiment_started').length,1);
  assert.equal(JSON.stringify(f.logs).includes('Example is easy'),false);assert.equal(JSON.stringify(f.logs).includes('secret-fixture'),false);
 }finally{f.close();}
});
test('both brands in the same response receive their own assessment, from one paid analysis',async()=>{
 const f=await fixture();try{
  f.add('run','Example is easy to use. Other is unreliable.');
  await f.worker({call:async(e,s,c)=>analyse(e,s,c,{env:f.env,fetcher:async()=>response({assessments:[{brandId:brandKey(identity),status:'assessed',quotes:[quote('Example is easy to use.')]},{brandId:brandKey(other),status:'assessed',quotes:[quote('Other is unreliable.','negative','reliability')]}]})})}).tick();
  const a=(await f.analytics()).data;assert.equal(a.competitors[0].metrics.sentiment.score,75);assert.equal(a.competitors[1].metrics.sentiment.score,25);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM sentiment_jobs WHERE started_at IS NOT NULL').get().n,1);
 }finally{f.close();}
});
test('absent brands, failed providers and unsupported language do not become sentiment zero or incur calls',async()=>{
 const f=await fixture();try{
  f.add('absent','Unrelated service.');f.add('failed','Example',{...snapshot},{status:'timeout_unknown'});f.add('sv','Example är bra.',{...snapshot,language:'sv'});
  const w=f.worker({call:()=>assert.fail('must not call')});for(let i=0;i<4;i++)await w.tick();
  const rows=(await f.results()).data.items;
  assert.equal(rows.find(x=>x.id==='absent').sentiment.status,'not_mentioned');assert.equal(rows.find(x=>x.id==='absent').sentiment.score,null);
  assert.equal(rows.find(x=>x.id==='failed').state,'failed');assert.equal(rows.find(x=>x.id==='failed').sentiment.status,'not_applicable');
  assert.equal(rows.find(x=>x.id==='sv').sentiment.status,'unsupported_language');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM sentiment_jobs WHERE started_at IS NOT NULL').get().n,0);
 }finally{f.close();}
});
test('activation avoids silent historical charges; owner-requested backfill is idempotent',async()=>{
 const f=await fixture();try{
  f.add('old','Example is easy to use.',snapshot,{at:f.now()-1000});const w=f.worker();await w.tick();
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM sentiment_jobs').get().n,0);
  assert.equal((await f.backfill('old')).data.queued,1);assert.equal((await f.backfill('old')).data.queued,0);await w.tick();
  assert.equal((await f.results()).data.items[0].sentiment.score,75);
  await assert.rejects(f.backfill('old','bob'),x=>x.status===404);await assert.rejects(f.results('','bob'),x=>x.status===404);
 }finally{f.close();}
});
test('budget is separate, shared atomically across replicas and resumes after rolling 24 hours',async()=>{
 const f=await fixture({SENTIMENT_MAX_DAILY_CALLS:'1'});try{
  f.add('a');f.add('b');let calls=0;
  const call=async(e,s,c)=>{calls++;await new Promise(r=>setTimeout(r,5));return analyse(e,s,c,{env:f.env,fetcher:async()=>response(output([quote(e.answer)]))});};
  const a=f.worker({call}),b=f.worker({call});await Promise.all([a.tick(),b.tick()]);await b.tick();
  assert.equal(calls,1);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_budget').get().n,0);
  assert.equal((await f.results()).data.items.find(x=>x.id==='b').sentiment.status,'budget_wait');
  f.advance(86400001);await b.tick();assert.equal(calls,2);
 }finally{f.close();}
});
test('missing credential and disabled feature do not consume budget or remove existing evidence',async()=>{
 const f=await fixture({OPENAI_API_KEY:''});try{
  f.add();await f.worker().tick();assert.equal((await f.results()).data.items[0].sentiment.status,'unconfigured');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM sentiment_jobs WHERE started_at IS NOT NULL').get().n,0);
  f.env.SENTIMENT_ENABLED='false';await f.worker({call:()=>assert.fail()}).tick();assert.equal((await f.results()).data.items[0].answer,'Example is easy to use.');
 }finally{f.close();}
});
test('storage retry preserves paid result without another analysis request',async()=>{
 const f=await fixture();try{
  f.add();let down=true,calls=0;
  const broken={...f.db,execute:async q=>{if(down&&q.sql?.includes('SET status=?,result_json='))throw Error('offline');return f.db.execute(q);}};
  const w=f.worker({db:broken,call:async(e,s,c)=>{calls++;return analyse(e,s,c,{env:f.env,fetcher:async()=>response(output([quote(e.answer)]))});}});
  await w.tick();assert.equal(calls,1);assert.equal((await f.results()).data.items[0].sentiment.status,'analysing');
  down=false;await w.tick();assert.equal(calls,1);assert.equal((await f.results()).data.items[0].sentiment.score,75);
 }finally{f.close();}
});
test('crashed or failed analysis is terminal and never silently replayed',async()=>{
 const f=await fixture();try{
  f.add();await f.backfill();
  f.sql.prepare("UPDATE sentiment_jobs SET status='running',started_at=?,lease_until=?,claim_token='crashed'").run(f.now()-100,f.now()-1);
  await f.worker({call:()=>assert.fail('must not replay')}).tick();assert.equal((await f.results()).data.items[0].sentiment.status,'interrupted_unknown');
  assert.equal((await f.backfill()).data.queued,0);
  f.add('bad');await f.worker({call:async()=>{throw Error('secret raw upstream error');}}).tick();
  await f.worker({call:()=>assert.fail('must not replay')}).tick();
  const bad=(await f.results()).data.items.find(x=>x.id==='bad');assert.equal(bad.sentiment.status,'failed');assert.equal(bad.sentiment.error,'SENTIMENT_FAILED');assert.equal(bad.sentiment.score,null);
 }finally{f.close();}
});
test('analysis versions and actual models cannot silently mix in sentiment averages',()=>{
 const row=(score,model='a',analysisVersion='v1')=>({mentioned:true,sentiment:{status:'assessed',score,label:'positive',model,analysisVersion}});
 assert.equal(aggregateSentiment([row(75),row(100)]).score,87.5);
 assert.equal(aggregateSentiment([row(75),row(100,'b')]).state,'incomparable');
 assert.equal(aggregateSentiment([row(75),row(100,'a','v2')]).score,null);
 assert.equal(aggregateSentiment([row(75),{mentioned:true,sentiment:{status:'failed'}}]).coverage,50);
});
test('changing analysis model preserves historical assessments and requires explicit reanalysis',async()=>{
 const f=await fixture();try{
  f.add();await f.worker().tick();const original=(await f.results()).data.items[0].sentiment.analysisVersion;
  f.env.SENTIMENT_MODEL='other-model';await f.worker({call:()=>assert.fail('model change must not replay historical answers')}).tick();
  const saved=(await f.results()).data.items[0];assert.equal(saved.sentiment.analysisVersion,original);assert.notEqual(saved.sentimentAnalysis.configuredAnalysisVersion,original);
  assert.equal(saved.sentiment.score,75);assert.equal((await f.backfill()).data.queued,1);
 }finally{f.close();}
});
test('untrusted model cannot turn an absent brand into scored sentiment; lengthy answers are skipped intact',async()=>{
 const f=await fixture();try{
  f.add('long','Example '+ 'x'.repeat(32000));await f.worker({call:()=>assert.fail('must not truncate and score')}).tick();
  const e=(await f.results()).data.items[0];assert.equal(e.sentiment.status,'answer_too_long');assert.equal(e.answer.length,32008);
  assert.throws(()=>validateAssessments(output([quote('Other is good.')]),evidence('Other is good.'),snapshot));
 }finally{f.close();}
});
test('results include pending tasks, paginate, filter and protect single-result ownership',async()=>{
 const f=await fixture();try{
  f.add('ready');f.add('pending','',snapshot,{pending:true});f.add('blocked','',snapshot,{status:'budget_blocked'});
  const r=(await f.results('pageSize=1')).data;assert.equal(r.total,3);assert.equal(r.items.length,1);assert.equal(r.hasMore,true);
  assert.equal((await f.results('state=queued')).data.items[0].id,'pending');assert.equal((await f.results('state=skipped')).data.items[0].id,'blocked');
  assert.equal((await f.results('topic=Tools&runId=ready&provider=openai')).data.total,1);
  await assert.rejects(f.results('pageSize=500'),x=>x.status===422);await assert.rejects(f.results('state=fake'),x=>x.status===422);await assert.rejects(f.results('','alice','/missing'),x=>x.status===404);
  await assert.rejects(f.results('','bob','/ready'),x=>x.status===404);
 }finally{f.close();}
});
test('schema migration is additive, repeatable and rejects checksum drift',async()=>{
 const f=await fixture();try{
  f.add();await migrateSentiment(f.db);assert.equal((await f.results()).data.total,1);
  f.sql.prepare("UPDATE app_migrations SET checksum='wrong' WHERE id='app-012-sentiment'").run();await assert.rejects(migrateSentiment(f.db),/checksum mismatch/);
 }finally{f.close();}
});
test('HTTP app dispatch requires session and CSRF for backfill, GET cannot start paid work',async()=>{
 const f=await fixture();try{
  f.add();const token='test-session';
  f.sql.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hashToken(token),'alice',f.now()+100000,f.now());
  const app=createAppService({db:f.db,clients:{web:{origin:'https://app.example.com',redirectUri:'https://app.example.com/api/airank/v1/app/google/callback'}},env:f.env,now:f.now});
  // Existing client routing, session ownership and CSRF contract.
  const headers={'x-airank-client':'web',cookie:`__Host-airank_session=${token}`,origin:'https://app.example.com','content-type':'application/json'};
  const req=(method,suffix,h=headers,body)=>app({method,path:'/v1/projects/project/'+suffix,headers:h,body,query:new URLSearchParams()});
  await req('GET','results');assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM sentiment_jobs').get().n,0);
  await assert.rejects(req('GET','results',{...headers,cookie:''}),x=>x.status===401);
  await assert.rejects(req('POST','sentiment-backfill',headers,{runId:'run'}),x=>x.status===403);
  const result=await req('POST','sentiment-backfill',{...headers,'x-csrf-token':csrfFor(token)},{runId:'run'});assert.equal(result.status,202);
 }finally{f.close();}
});
