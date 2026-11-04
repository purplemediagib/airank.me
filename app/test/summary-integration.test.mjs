import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createClient} from '@libsql/client';
import {migrations} from '../src/migrate.mjs';
import {appDDL,migrationId as appId,checksum as appChecksum} from '../src/app/migration.mjs';
import {scanDDL} from '../src/app/scan-migration.mjs';
import {ddl as monitoringDDL} from '../src/monitoring/migration.mjs';
import {ddl as sentimentDDL} from '../src/sentiment/migration.mjs';
import {ddl as intelligenceDDL,id as intelligenceId,checksum as intelligenceChecksum} from '../src/intelligence/migration.mjs';
import {ddl as tokenDDL,id as tokenId,checksum as tokenChecksum} from '../src/app/report-token-migration.mjs';
import {ddl as teamDDL} from '../src/app/team-migration.mjs';
import {migrateAnalyticsSummary} from '../src/analytics/summary-migration.mjs';
import {analyticsService} from '../src/analytics/service.mjs';
import {summaryService,summaryEvidenceService} from '../src/analytics/summary-service.mjs';
import {projectSummaryOnce} from '../src/analytics/summary-projector.mjs';
import {claimSummary,publishSummary,failSummary,renewSummaryLease,cleanupSummaries,demandSummary} from '../src/analytics/summary-store.mjs';
import {canonicalQuery,queryKey,formatVersion,LEASE_MS,GENERATION_TTL,DEMAND_TTL,MAX_VARIANTS} from '../src/analytics/summary-contract.mjs';
import {scopeEvidence,matchEvidence,matchesEvidenceBrand} from '../src/analytics/summary-overview.mjs';
import {createAppService} from '../src/app/service.mjs';
import {hashToken} from '../src/common/utils.mjs';

const DAY=86400000,stamp=Date.parse('2026-11-03T12:00:00Z');
const query=()=>new URLSearchParams({from:'2026-11-03',to:'2026-11-03'});
const env={AIRANK_ANALYTICS_SUMMARY_ENABLED:'true',AIRANK_BUILD_REVISION:'integration-fixture',SENTIMENT_ENABLED:'true',ENTITY_ANALYSIS_ENABLED:'true',ENTITY_ANALYSIS_MODEL:'fixture-entity-model'};
const identity={brandName:'Example',aliases:['Example Oy'],ownedDomains:['example.test'],market:'FI',promptLanguage:'en'};
const snapshot={identity,identityVersion:1,kind:'neutral',market:'FI',language:'en',methodology:'tracked-fi-evidence-v1',prompts:[{id:'pa',version:1,text:'Which service?',topic:'Price',tags:['pricing','research']}],routes:[{provider:'openai',model:'fixture'}]};

async function fixture({file=':memory:'}={}){
 const sql=new DatabaseSync(file);sql.exec('PRAGMA foreign_keys=ON');if(file!==':memory:')sql.exec('PRAGMA journal_mode=WAL');
 for(const statement of [...migrations,...appDDL,scanDDL,...monitoringDDL,...sentimentDDL,...intelligenceDDL,...tokenDDL])sql.exec(statement);
 sql.exec('CREATE TABLE app_migrations(id TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
 sql.prepare('INSERT INTO app_migrations VALUES (?,?,?)').run(appId,appChecksum,'date');
 sql.prepare('INSERT INTO app_migrations VALUES (?,?,?)').run(intelligenceId,intelligenceChecksum,'date');
 sql.prepare('INSERT INTO app_migrations VALUES (?,?,?)').run(tokenId,tokenChecksum,'date');
 for(const id of ['alice','bob','guest']){
  sql.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(id,id,`${id}@example.test`,id,'',1,1);
  sql.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hashToken(`token-${id}`),id,stamp+30*DAY,1);
 }
 for(const [id,owner] of [['a','alice'],['b','bob']]){
  sql.prepare('INSERT INTO app_projects VALUES (?,?,?,?,?)').run(id,owner,'active',1,'2026-11-01');
  sql.prepare('INSERT INTO app_identity_versions VALUES (?,?,?,?)').run(id,1,JSON.stringify(identity),'2026-11-01');
  sql.prepare('INSERT INTO mon_prompts VALUES (?,?,?,?,?,?)').run(`p${id}`,id,1,'active',`p${id}`,1);
  sql.prepare('INSERT INTO mon_prompt_versions VALUES (?,?,?,?)').run(`p${id}`,1,JSON.stringify({...snapshot.prompts[0],status:'active'}),1);
 }
 sql.exec('CREATE TABLE content_members(project_id TEXT,user_id TEXT,role TEXT)');
 for(const statement of teamDDL)sql.exec(statement);
 let clock=stamp;
 const queries=[];
 const execute=async q=>{
  const text=typeof q==='string'?q:q.sql,args=typeof q==='string'?[]:q.args||[];queries.push(text);
  const statement=sql.prepare(text);
  return /^\s*(SELECT|PRAGMA|EXPLAIN)/.test(text)||/RETURNING/i.test(text)?{rows:statement.all(...args)}:{rows:[],rowsAffected:Number(statement.run(...args).changes)};
 };
 // Serialize transactions like SQLite's writer lock; the adapter is also used
 // to deterministically interleave source changes around projection computation.
 let writer=Promise.resolve();
 const db={execute,transaction:async(mode)=>{
  let release;const next=new Promise(resolve=>{release=resolve;});const prior=writer;writer=writer.then(()=>next);await prior;
  sql.exec(mode==='read'?'BEGIN':'BEGIN IMMEDIATE');let completed=false;
  const end=command=>{if(!completed){sql.exec(command);completed=true;release();}};
  return {execute,commit:async()=>end('COMMIT'),rollback:async()=>end('ROLLBACK'),close:()=>{if(!completed)end('ROLLBACK');}};
 }};
 const add=(id,{project='a',at=stamp,answer='Example is useful.',status='success',setup=snapshot,recorded=true,observedAt=at,citations=[]}={})=>{
  const owner=project==='a'?'alice':'bob',s={...setup,prompts:setup.prompts.map(p=>({...p,id:`p${project}`}))};
  sql.prepare('INSERT INTO mon_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,project,owner,id,id,'neutral',recorded?'complete':'queued',JSON.stringify(s),1,at,at+1000,null);
  sql.prepare('INSERT INTO mon_tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,id,`p${project}`,1,'Which service?','openai','{}',recorded?'done':'queued',null,null);
  if(recorded)sql.prepare('INSERT INTO mon_evidence VALUES (?,?,?,?)').run(id,id,JSON.stringify({id,runId:id,promptId:`p${project}`,promptVersion:1,text:'Which service?',provider:'openai',model:'fixture',status,observedAt,answer,citations}),observedAt);
 };
 add('prior',{at:stamp-DAY});
 add('other-setup',{at:stamp-10000,setup:{...snapshot,identityVersion:2},answer:'Rival and Example.'});
 add('one',{at:stamp,answer:'I recommend Example.',citations:[{url:'https://example.test/source'}]});
 add('two',{at:stamp+1000,answer:'Recommendations\n1. Example\n2. Rival'});
 add('three',{at:stamp+2000,answer:'Rival is useful.'});
 add('four',{at:stamp+3000,answer:'Example has a distinctive Ünicode offer.'});
 add('five',{at:stamp+4000,answer:'',status:'failed'});
 add('unfinished',{at:stamp-5000,recorded:false});
 add('other-tenant',{project:'b'});
 await migrateAnalyticsSummary(db);
 const origin='https://app.example.test';
 const app=createAppService({db,env,now:()=>clock,clients:{fixture:{origin,redirectUri:`${origin}/callback`}}});
 const call=(path='/v1/projects/a/analytics/summary',q=query(),user='alice',headers={})=>app({method:'GET',path,query:q,headers:{'x-airank-client':'fixture',origin,cookie:`__Host-airank_session=token-${user}`,...headers}});
 const summary=(q=query(),userId='alice',project='a',extra={})=>summaryService({db,path:`/v1/projects/${project}/analytics/summary`,userId,query:q,env,now:()=>clock,...extra});
 const evidence=(generation,options={},project='a',userId='alice',item=null)=>summaryEvidenceService({db,path:`/v1/projects/${project}/analytics/evidence${item?`/${item}`:''}`,userId,query:new URLSearchParams({generation,...options}),env,now:()=>clock});
 const build=options=>projectSummaryOnce({db,env,now:()=>clock,...options});
 const baseline=()=>analyticsService({db,path:'/v1/projects/a/analytics',userId:'alice',query:query(),env});
 const row=(text,...args)=>sql.prepare(text).get(...args);
 return {sql,db,queries,add,call,summary,evidence,build,baseline,row,now:()=>clock,advance:ms=>{clock+=ms;},close:()=>sql.close()};
}
const rejectsCode=(promise,code)=>assert.rejects(promise,error=>error.code===code);
async function ready(f){assert.equal((await f.summary()).status,202);assert.equal((await f.build()).state,'published');return f.summary();}

// These are synthetic, local-only fixtures. The real application router,
// access checks, canonical calculator, projector, SQL storage and read routes
// are exercised without importing or invoking any provider worker.
test('authenticated app route cold/prepared/warm flow preserves every canonical response field',async()=>{
 const f=await fixture();try{
  await rejectsCode(f.call(undefined,undefined,'alice',{cookie:''}),'AUTH_REQUIRED');
  await rejectsCode(f.call(undefined,undefined,'bob'),'NOT_FOUND');
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_requests').n,0);
  const baseline=(await f.baseline()).data;
  const counts=['mon_runs','mon_tasks','mon_evidence','sentiment_jobs','intelligence_jobs'].map(t=>f.row(`SELECT COUNT(*) n FROM ${t}`).n);
  assert.equal((await f.call()).status,202);
  assert.equal((await f.build()).state,'published');
  f.queries.length=0;const result=await f.call();
  assert.equal(result.status,200);assert.equal(result.headers['cache-control'],'private, no-store');
  assert.equal(result.data.readModel.isStale,false);assert.equal(result.data.intelligence.model,env.ENTITY_ANALYSIS_MODEL);
  const {evidence,...expected}=baseline,{ui,readModel,...actual}=result.data;
  assert.deepEqual(actual,expected);assert.ok(ui.daily);assert.equal(readModel.evidenceCount,evidence.length);
  assert.ok(!f.queries.some(q=>/\bFROM (?:mon_runs|mon_tasks|mon_evidence|sentiment_jobs|intelligence_jobs)\b/.test(q)),'warm read must not query canonical evidence tables');
  assert.deepEqual(['mon_runs','mon_tasks','mon_evidence','sentiment_jobs','intelligence_jobs'].map(t=>f.row(`SELECT COUNT(*) n FROM ${t}`).n),counts);
  const page=await f.call('/v1/projects/a/analytics/evidence',new URLSearchParams({generation:readModel.generation,pageSize:'2'}));
  assert.equal(page.status,200);assert.equal(page.data.items.length,2);
 }finally{f.close();}
});

test('warm summaries and pinned evidence recheck guest and workspace revocation',async()=>{
 const f=await fixture();try{
  const {data}=await ready(f),generation=data.readModel.generation;
  f.sql.exec("INSERT INTO app_project_guests VALUES ('a','guest','viewer',1)");
  assert.equal((await f.summary(query(),'guest')).status,200);
  assert.equal((await f.evidence(generation,{},'a','guest')).status,200);
  const before=f.row("SELECT revision FROM analytics_project_revisions WHERE project_id='a'").revision;
  f.sql.exec("DELETE FROM app_project_guests WHERE project_id='a' AND user_id='guest'");
  assert.equal(f.row("SELECT revision FROM analytics_project_revisions WHERE project_id='a'").revision,before,'authorization is independent of content revision');
  await rejectsCode(f.summary(query(),'guest'),'NOT_FOUND');
  await rejectsCode(f.evidence(generation,{},'a','guest'),'NOT_FOUND');
  f.sql.exec("INSERT INTO app_workspace_members VALUES ('ws_alice','guest','viewer',1)");
  assert.equal((await f.summary(query(),'guest')).status,200);
  f.sql.exec("DELETE FROM app_workspace_members WHERE user_id='guest'");
  await rejectsCode(f.summary(query(),'guest'),'NOT_FOUND');
 }finally{f.close();}
});

test('cross-project generation IDs and evidence IDs do not bypass current authorization',async()=>{
 const f=await fixture();try{
  const generation=(await ready(f)).data.readModel.generation;
  await rejectsCode(f.evidence(generation,{},'b','bob'),'NOT_FOUND');
  await rejectsCode(f.evidence(generation,{},'a','bob'),'NOT_FOUND');
  await rejectsCode(f.evidence(generation,{},'a','alice','other-tenant'),'NOT_FOUND');
  await rejectsCode(f.summary(query(),'alice','b'),'NOT_FOUND');
 }finally{f.close();}
});

test('old generation is explicitly stale, refreshed output is exact, and config changes cannot reuse it',async()=>{
 const f=await fixture();try{
  const first=(await ready(f)).data;
  f.sql.exec("UPDATE mon_evidence SET payload=json_set(payload,'$.answer','Example changed after projection.') WHERE id='three'");
  const stale=(await f.summary()).data;assert.equal(stale.readModel.isStale,true);assert.equal(stale.readModel.generation,first.readModel.generation);
  assert.equal((await f.build()).state,'published');
  const current=(await f.summary()).data;assert.equal(current.readModel.isStale,false);assert.notEqual(current.readModel.generation,first.readModel.generation);
  assert.ok(current.readModel.sourceRevision>first.readModel.sourceRevision);
  assert.equal((await f.evidence(first.readModel.generation)).data.readModel.isStale,true);
  const changed={...env,SENTIMENT_MODEL:'different-model'};
  assert.equal((await f.summary(query(),'alice','a',{env:changed})).status,202);
  await rejectsCode(summaryEvidenceService({db:f.db,path:'/v1/projects/a/analytics/evidence',userId:'alice',query:new URLSearchParams({generation:first.readModel.generation}),env:changed,now:f.now}),'ANALYTICS_GENERATION_EXPIRED');
 }finally{f.close();}
});

test('source change during computation fences publication and requeues instead of publishing mixed data',async()=>{
 const f=await fixture();try{
  await f.summary();
  const result=await f.build({compute:async args=>{
   const data=await analyticsService(args);
   f.sql.exec("UPDATE mon_evidence SET payload=json_set(payload,'$.answer','Late evidence') WHERE id='one'");
   return data;
  }});
  assert.deepEqual({state:result.state,reason:result.reason},{state:'retry',reason:'source_changed'});
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_heads').n,0);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_generations').n,0);
  assert.equal(f.row('SELECT lease_token FROM analytics_summary_requests').lease_token,null);
  f.advance(1001);assert.equal((await f.build()).state,'published');
 }finally{f.close();}
});

test('concurrent claims coalesce, expired leases recover, and stale workers cannot publish or clear newer leases',async()=>{
 const f=await fixture();try{
  await f.summary();const format=formatVersion(env);
  const jobs=await Promise.all([claimSummary(f.db,format,f.now()),claimSummary(f.db,format,f.now())]);
  assert.equal(jobs.filter(Boolean).length,1);const old=jobs.find(Boolean);
  assert.equal(await renewSummaryLease(f.db,old,f.now()+1),true);
  f.advance(LEASE_MS+2);const next=await claimSummary(f.db,format,f.now());assert.ok(next);assert.notEqual(next.lease_token,old.lease_token);
  assert.equal(await renewSummaryLease(f.db,old,f.now()),false);
  assert.deepEqual(await publishSummary(f.db,old,{},[],f.now()),{published:false,reason:'lease_lost'});
  await failSummary(f.db,old,{code:'INVALID_FILTER'},f.now());
  assert.equal(f.row('SELECT lease_token FROM analytics_summary_requests').lease_token,next.lease_token);
  assert.equal((await publishSummary(f.db,next,{},[],f.now())).published,true);
  assert.equal((await publishSummary(f.db,next,{},[],f.now())).published,false);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_generations').n,1);
 }finally{f.close();}
});

test('evidence pagination, all flag filters, search and brand filters exactly match preserved UI rules',async()=>{
 const f=await fixture();try{
  const baseline=(await f.baseline()).data;
  const expected=scopeEvidence(baseline,Object.fromEntries(query()));assert.equal(expected.length,5);
  const generation=(await ready(f)).data.readModel.generation;
  for(const filter of ['all','mentioned','recommended','cited','ordered','first','excluded'])for(const q of ['', 'Example', 'ÜNICODE', 'source', 'price'])for(const brand of ['', 'Example']){
   const selected=expected.filter(e=>matchEvidence(e,filter,q)&&matchesEvidenceBrand(e,brand));
   const items=[];let cursor,offset=0;
   do{
    const response=await f.evidence(generation,{filter,q,evidenceBrand:brand,pageSize:'2',...(cursor?{cursor}:{})});
    assert.equal(response.data.total,selected.length);assert.equal(response.data.offset,offset);
    items.push(...response.data.items);offset+=response.data.items.length;cursor=response.data.nextCursor;
   }while(cursor);
   assert.deepEqual(items,selected,JSON.stringify({filter,q,brand}));
  }
 }finally{f.close();}
});

test('cursor is bound to its immutable generation and filter, and detail navigation uses the same filtered order',async()=>{
 const f=await fixture();try{
  const generation=(await ready(f)).data.readModel.generation;
  const first=(await f.evidence(generation,{pageSize:'2'})).data;assert.ok(first.nextCursor);
  await rejectsCode(f.evidence(generation,{pageSize:'2',q:'Example',cursor:first.nextCursor}),'INVALID_CURSOR');
  await rejectsCode(f.evidence(generation,{pageSize:'2',filter:'mentioned',cursor:first.nextCursor}),'INVALID_CURSOR');
  await rejectsCode(f.evidence(generation,{cursor:'not-json'}),'INVALID_CURSOR');
  const second=(await f.evidence(generation,{pageSize:'2',cursor:first.nextCursor})).data;
  const detail=(await f.evidence(generation,{pageSize:'2'},'a','alice',second.items[0].id)).data;
  assert.equal(detail.index,2);assert.equal(detail.prevId,first.items[1].id);assert.equal(detail.nextId,second.items[1].id);
  assert.equal(detail.pageCursor,first.nextCursor);
  f.sql.exec("UPDATE mon_runs SET status='partial' WHERE id='one'");await f.build();
  const newGeneration=(await f.summary()).data.readModel.generation;
  await rejectsCode(f.evidence(newGeneration,{cursor:first.nextCursor}),'INVALID_CURSOR');
 }finally{f.close();}
});

test('failed publication rolls back every new row and leaves the previous head intact',async()=>{
 const f=await fixture();try{
  const old=(await ready(f)).data.readModel.generation;
  const row=(await f.evidence(old)).data.items[0];
  f.sql.exec("UPDATE mon_runs SET status='partial' WHERE id='one'");
  const job=await claimSummary(f.db,formatVersion(env),f.now());
  const counts=['analytics_summary_generations','analytics_summary_evidence','analytics_summary_payloads'].map(t=>f.row(`SELECT COUNT(*) n FROM ${t}`).n);
  await assert.rejects(publishSummary(f.db,job,{},[row,row],f.now()),/UNIQUE/);
  assert.equal(f.row('SELECT generation_id FROM analytics_summary_heads').generation_id,old);
  assert.deepEqual(['analytics_summary_generations','analytics_summary_evidence','analytics_summary_payloads'].map(t=>f.row(`SELECT COUNT(*) n FROM ${t}`).n),counts);
  assert.equal(await failSummary(f.db,job,{code:'unsafe',message:'secret user answer and token'},f.now()),'ANALYTICS_BUILD_FAILED');
  assert.equal(f.row('SELECT last_error FROM analytics_summary_requests').last_error,'ANALYTICS_BUILD_FAILED');
  assert.equal(await claimSummary(f.db,formatVersion(env),f.now()),null);
 }finally{f.close();}
});

test('generation expiration and demand retention recover without raw fallback or orphan references',async()=>{
 const f=await fixture();try{
  const generation=(await ready(f)).data.readModel.generation;
  f.advance(GENERATION_TTL+1);
  await rejectsCode(f.evidence(generation),'ANALYTICS_GENERATION_EXPIRED');
  await cleanupSummaries(f.db,f.now());
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_generations').n,0);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_evidence').n,0);
  assert.equal((await f.summary()).status,202);assert.equal((await f.build()).state,'published');
  f.advance(DEMAND_TTL+GENERATION_TTL+1);await cleanupSummaries(f.db,f.now());
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_requests').n,0);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_evidence').n,0);
  assert.equal((await f.build()).state,'idle');
 }finally{f.close();}
});

test('projection errors are sanitized and invalid filters surface honestly after background validation',async()=>{
 const f=await fixture();try{
  const invalid=query();invalid.set('provider','does-not-exist');assert.equal((await f.summary(invalid)).status,202);
  assert.deepEqual(await f.build(),{state:'failed',code:'INVALID_FILTER',phase:'aggregate',projectId:'a',durationMs:0});
  await rejectsCode(f.summary(invalid),'INVALID_FILTER');
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_generations').n,0);
  const good=query();await f.summary(good);
  assert.deepEqual(await f.build({compute:async()=>{throw Object.assign(Error('secret token and raw answer'),{code:'SECRET_PROVIDER_ERROR'});}}),{state:'failed',code:'ANALYTICS_BUILD_FAILED',phase:'aggregate',projectId:'a',durationMs:0});
  assert.ok(f.sql.prepare('SELECT last_error FROM analytics_summary_requests').all().every(r=>!String(r.last_error).includes('secret')));
 }finally{f.close();}
});

test('variant admission cap applies under concurrent cold requests and to reactivation of retained expired demand',async()=>{
 const f=await fixture();try{
  const format=formatVersion(env),q=canonicalQuery(query());
  for(let i=0;i<MAX_VARIANTS-1;i++)await demandSummary(f.db,'a',`key-${i}`,q,format,f.now());
  const settled=await Promise.allSettled([demandSummary(f.db,'a','last-one',q,format,f.now()),demandSummary(f.db,'a','last-two',q,format,f.now())]);
  assert.equal(settled.filter(s=>s.status==='fulfilled').length,1);
  assert.equal(settled.find(s=>s.status==='rejected').reason.code,'ANALYTICS_FILTER_LIMIT');
  // Retained expired demand can exist while its previous immutable generation
  // is still pinned. Reviving it must pass the same cap as a brand-new key.
  f.sql.prepare('INSERT INTO analytics_summary_requests(project_id,query_key,query_json,format_version,requested_at,last_requested_at) VALUES (?,?,?,?,?,?)').run('a','expired-retained',q.toString(),format,f.now()-DEMAND_TTL-1,f.now()-DEMAND_TTL-1);
  await rejectsCode(demandSummary(f.db,'a','expired-retained',q,format,f.now()),'ANALYTICS_FILTER_LIMIT');
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_requests WHERE last_requested_at>?',f.now()-DEMAND_TTL).n,MAX_VARIANTS);
 }finally{f.close();}
});


test('immutable payloads deduplicate across refreshed generations and GC retains any live references',async()=>{
 const f=await fixture();try{
  const old=(await ready(f)).data.readModel.generation;
  const payloads=f.row('SELECT COUNT(*) n FROM analytics_summary_payloads').n;assert.equal(payloads,5);
  f.advance(1000);f.sql.exec("UPDATE mon_runs SET status='partial' WHERE id='one'");await f.build();
  const next=(await f.summary()).data.readModel.generation;assert.notEqual(next,old);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_payloads').n,payloads);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_evidence').n,10);
  f.sql.prepare('UPDATE analytics_summary_generations SET expires_at=? WHERE id=?').run(f.now(),old);
  await cleanupSummaries(f.db,f.now());
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_payloads').n,payloads);
  assert.equal((await f.evidence(next)).data.items.length,5);
  f.sql.prepare('UPDATE analytics_summary_generations SET expires_at=? WHERE id=?').run(f.now(),next);
  await cleanupSummaries(f.db,f.now());
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_payloads').n,0);
 }finally{f.close();}
});

test('summary and evidence endpoints stay outside report bearer-token scope even with an owner cookie',async()=>{
 const f=await fixture();try{
  const generation=(await ready(f)).data.readModel.generation;
  const token=`airank_rt_${'x'.repeat(43)}`;
  f.sql.prepare('INSERT INTO app_report_tokens VALUES (?,?,?,?,?,?,?,?)').run('report',hashToken(token),'alice','Fixture',f.now()-1,f.now()+DAY,null,null);
  const headers={authorization:`Bearer ${token}`};
  assert.equal((await f.call('/v1/projects/a/analytics',query(),'alice',headers)).status,200);
  await rejectsCode(f.call('/v1/projects/a/analytics/summary',query(),'alice',headers),'SCOPE_DENIED');
  await rejectsCode(f.call('/v1/projects/a/analytics/evidence',new URLSearchParams({generation}),'alice',headers),'SCOPE_DENIED');
  await rejectsCode(f.call('/v1/projects/a/analytics/evidence/one',new URLSearchParams({generation}),'alice',headers),'SCOPE_DENIED');
 }finally{f.close();}
});

test('UTC midnight marks time-dependent daily trends stale and refreshes without a source mutation',async()=>{
 const f=await fixture();try{
  const first=(await ready(f)).data.readModel;
  f.advance(12*60*60*1000+1);
  const stale=(await f.summary()).data.readModel;
  assert.equal(stale.sourceRevision,first.sourceRevision);assert.equal(stale.isStale,true);
  assert.equal((await f.build()).state,'published');
  const fresh=(await f.summary()).data.readModel;
  assert.equal(fresh.sourceRevision,first.sourceRevision);assert.equal(fresh.isStale,false);assert.notEqual(fresh.generation,first.generation);
 }finally{f.close();}
});

test('an evidence read holds one snapshot while another connection expires its generation and payloads',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'analytics-summary-read-race-'));
 const file=join(directory,'fixture.db');let f,writer;
 try{
  f=await fixture({file});const generation=(await ready(f)).data.readModel.generation;
  writer=new DatabaseSync(file);writer.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
  let deleted=false,modeSeen;
  const db={...f.db,transaction:async mode=>{
   modeSeen=mode;const tx=await f.db.transaction(mode);
   return {...tx,execute:async q=>{
    const result=await tx.execute(q);
    if(!deleted&&typeof q!=='string'&&q.sql.includes('WHERE g.id=? AND g.project_id=?')){
     writer.prepare('DELETE FROM analytics_summary_generations WHERE id=?').run(generation);
     writer.exec('DELETE FROM analytics_summary_payloads WHERE NOT EXISTS (SELECT 1 FROM analytics_summary_evidence e WHERE e.payload_hash=analytics_summary_payloads.hash)');
     deleted=true;
    }
    return result;
   }};
  }};
  const result=await summaryEvidenceService({db,path:'/v1/projects/a/analytics/evidence',userId:'alice',query:new URLSearchParams({generation}),env,now:f.now});
  assert.equal(modeSeen,'read');assert.equal(deleted,true);assert.equal(result.data.total,5);assert.equal(result.data.items.length,5);
  assert.equal(writer.prepare('SELECT COUNT(*) n FROM analytics_summary_generations').get().n,0);
  await rejectsCode(f.evidence(generation),'NOT_FOUND');
 }finally{writer?.close();f?.close();rmSync(directory,{recursive:true,force:true});}
});

test('staged generations remain invisible even with persisted pages and expire without affecting published data',async()=>{
 const f=await fixture();try{
  const published=(await ready(f)).data.readModel.generation;
  f.sql.prepare(`INSERT INTO analytics_summary_generations(id,project_id,query_key,source_revision,format_version,generated_at,expires_at,evidence_count,summary_json,published_at)
   SELECT 'staged-generation',project_id,query_key,source_revision,format_version,generated_at,expires_at,evidence_count,summary_json,NULL FROM analytics_summary_generations WHERE id=?`).run(published);
  f.sql.prepare("INSERT INTO analytics_summary_evidence SELECT 'staged-generation',position,id,payload_hash FROM analytics_summary_evidence WHERE generation_id=?").run(published);
  await rejectsCode(f.evidence('staged-generation'),'NOT_FOUND');
  assert.equal((await f.summary()).data.readModel.generation,published);
  f.sql.exec("UPDATE analytics_summary_generations SET expires_at=0 WHERE id='staged-generation'");
  await cleanupSummaries(f.db,f.now());
  assert.equal(f.row("SELECT COUNT(*) n FROM analytics_summary_generations WHERE id='staged-generation'").n,0);
  assert.equal((await f.evidence(published)).data.items.length,5);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_payloads').n,5);
 }finally{f.close();}
});

function observeTransactions(f,{afterChunk,failFinalCommit=false}={}){
 let chunks=0;
 const db={...f.db,transaction:async mode=>{
  const tx=await f.db.transaction(mode);let isChunk=false,isFinal=false;
  return {...tx,execute:async q=>{
   const sql=typeof q==='string'?q:q.sql;
   if(sql.includes('INSERT INTO analytics_summary_evidence'))isChunk=true;
   if(sql.includes('SET published_at='))isFinal=true;
   return tx.execute(q);
  },commit:async()=>{
   if(isFinal&&failFinalCommit)throw Error('fixture final commit failed before execution');
   await tx.commit();if(isChunk){chunks++;await afterChunk?.(chunks);}
  }};
 }};
 return {db,chunks:()=>chunks};
}
async function nextLargeProjection(f){
 const head=(await ready(f)).data.readModel.generation;
 const base=(await f.evidence(head)).data.items[0];
 f.sql.exec("UPDATE mon_runs SET status='partial' WHERE id='one'");
 const job=await claimSummary(f.db,formatVersion(env),f.now());
 const evidence=Array.from({length:101},(_,i)=>({...base,id:`large-${String(i).padStart(3,'0')}`}));
 return {head,job,evidence};
}

test('source mutation between committed staging chunks stays invisible and prevents final publication',async()=>{
 const f=await fixture();try{
  const {head,job,evidence}=await nextLargeProjection(f);
  const observed=observeTransactions(f,{afterChunk:async count=>{
   if(count!==1)return;
   const stage=f.row('SELECT id FROM analytics_summary_generations WHERE published_at IS NULL');assert.ok(stage);
   assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_evidence WHERE generation_id=?',stage.id).n,50);
   await rejectsCode(f.evidence(stage.id),'NOT_FOUND');
   assert.equal((await f.summary()).data.readModel.generation,head);
   f.sql.exec("UPDATE mon_runs SET status='complete' WHERE id='one'");
  }});
  assert.deepEqual(await publishSummary(observed.db,job,{},evidence,f.now),{published:false,reason:'source_changed'});
  assert.equal(observed.chunks(),1);
  assert.equal(f.row('SELECT generation_id FROM analytics_summary_heads').generation_id,head);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_generations WHERE published_at IS NULL').n,0);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_evidence').n,5);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_payloads').n,55);
  await cleanupSummaries(f.db,f.now());assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_payloads').n,5);
 }finally{f.close();}
});

test('actual clock expiry between staging chunks loses the lease despite the original start timestamp',async()=>{
 const f=await fixture();try{
  const {head,job,evidence}=await nextLargeProjection(f);
  const observed=observeTransactions(f,{afterChunk:count=>{if(count===1)f.advance(LEASE_MS+1);}});
  assert.deepEqual(await publishSummary(observed.db,job,{},evidence,f.now),{published:false,reason:'lease_lost'});
  assert.equal(observed.chunks(),1);assert.equal(f.row('SELECT generation_id FROM analytics_summary_heads').generation_id,head);
  const recovered=await claimSummary(f.db,formatVersion(env),f.now());assert.ok(recovered);assert.notEqual(recovered.lease_token,job.lease_token);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_generations WHERE published_at IS NULL').n,0);
 }finally{f.close();}
});

test('a failed final staging chunk removes all staging references while keeping the old published generation',async()=>{
 const f=await fixture();try{
  const {head,job,evidence}=await nextLargeProjection(f);evidence[100]={...evidence[0]};
  const observed=observeTransactions(f);
  await assert.rejects(publishSummary(observed.db,job,{},evidence,f.now),/UNIQUE/);
  assert.equal(observed.chunks(),2);assert.equal(f.row('SELECT generation_id FROM analytics_summary_heads').generation_id,head);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_generations WHERE published_at IS NULL').n,0);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_evidence').n,5);
  assert.equal((await f.evidence(head)).data.items.length,5);
  await cleanupSummaries(f.db,f.now());assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_payloads').n,5);
 }finally{f.close();}
});

test('a definite final publication commit failure cannot leave a visible or pinned incomplete generation',async()=>{
 const f=await fixture();try{
  const {head,job,evidence}=await nextLargeProjection(f);
  const observed=observeTransactions(f,{failFinalCommit:true});
  await assert.rejects(publishSummary(observed.db,job,{},evidence,f.now),/fixture final commit failed/);
  assert.equal(observed.chunks(),3);assert.equal(f.row('SELECT generation_id FROM analytics_summary_heads').generation_id,head);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_generations WHERE published_at IS NOT NULL').n,1);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_generations WHERE published_at IS NULL').n,0);
  assert.equal((await f.evidence(head)).data.items.length,5);
  await cleanupSummaries(f.db,f.now());assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_payloads').n,5);
 }finally{f.close();}
});


test('a new executable/configuration format has its own bounded demand admission during rollout',async()=>{
 const f=await fixture();try{
  const oldFormat=formatVersion(env),nextFormat=formatVersion({...env,AIRANK_BUILD_REVISION:'next-fixture-build'}),q=canonicalQuery(query());
  assert.notEqual(oldFormat,nextFormat);
  for(let i=0;i<MAX_VARIANTS;i++)await demandSummary(f.db,'a',`old-${i}`,q,oldFormat,f.now());
  await rejectsCode(demandSummary(f.db,'a','old-overflow',q,oldFormat,f.now()),'ANALYTICS_FILTER_LIMIT');
  const key=queryKey(q,nextFormat);await demandSummary(f.db,'a',key,q,nextFormat,f.now());
  const job=await claimSummary(f.db,nextFormat,f.now());assert.equal(job.query_key,key);assert.equal(job.format_version,nextFormat);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_requests WHERE format_version=?',oldFormat).n,MAX_VARIANTS);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_requests WHERE format_version=?',nextFormat).n,1);
 }finally{f.close();}
});

test('real local libSQL client completes demand, asynchronous staged chunks, publication and snapshot evidence reads',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'analytics-summary-libsql-')),file=join(directory,'fixture.db');
 let f,client;
 try{
  f=await fixture({file});
  for(let i=0;i<60;i++)f.add(`libsql-${String(i).padStart(3,'0')}`,{at:stamp+6000+i*1000,answer:'Example says "great". Unicode 👋 and a newline\nremain intact.'});
  f.close();f=null;
  client=createClient({url:`file:${file}`});let chunks=0;
  const execute=(cx,q)=>{if((typeof q==='string'?q:q.sql).includes('INSERT INTO analytics_summary_evidence'))chunks++;return cx.execute(q);};
  const db={execute:q=>execute(client,q),transaction:async mode=>{
   const tx=await client.transaction(mode);return {execute:q=>execute(tx,q),commit:()=>tx.commit(),rollback:()=>tx.rollback(),close:()=>tx.close()};
  }};
  const context={db,path:'/v1/projects/a/analytics/summary',userId:'alice',query:query(),env,now:()=>stamp};
  assert.equal((await summaryService(context)).status,202);
  assert.equal((await projectSummaryOnce({db,env,now:()=>stamp})).state,'published');assert.equal(chunks,2);
  const result=await summaryService(context);assert.equal(result.status,200);assert.equal(result.data.readModel.evidenceCount,65);
  const original=(await analyticsService({...context,path:'/v1/projects/a/analytics'})).data;
  const {evidence,...expected}=original,{ui,readModel,...actual}=result.data;assert.deepEqual(actual,expected);
  const page=await summaryEvidenceService({...context,path:'/v1/projects/a/analytics/evidence',query:new URLSearchParams({generation:readModel.generation,pageSize:'100'})});
  assert.deepEqual(page.data.items,scopeEvidence(original,Object.fromEntries(query())));assert.equal(page.data.total,65);
  assert.equal((await client.execute('SELECT COUNT(*) n FROM analytics_summary_generations WHERE published_at IS NULL')).rows[0].n,0);
  assert.equal((await client.execute('PRAGMA foreign_key_check')).rows.length,0);
 }finally{client?.close();f?.close();rmSync(directory,{recursive:true,force:true});}
});

test('permanent validation failures do not churn until source revision changes',async()=>{
 const f=await fixture();try{
  const q=query();q.set('topic','missing-topic');
  assert.equal((await f.summary(q)).status,202);
  assert.equal((await f.build()).code,'INVALID_FILTER');
  f.advance(600000);
  assert.equal((await f.build()).state,'idle');
  f.sql.prepare("UPDATE mon_runs SET status='recorded' WHERE id='one'").run();
  assert.equal((await f.build()).code,'INVALID_FILTER');
 }finally{f.close();}
});

test('detail routing accepts the same bounded evidence identifiers as the frontend contract',async()=>{
 const f=await fixture();try{
  const evidenceId='evidence_'+('x'.repeat(100));f.add(evidenceId);
  const r=await ready(f);
  const q=new URLSearchParams({generation:r.data.readModel.generation,pageSize:'10'});
  const detail=await f.call(`/v1/projects/a/analytics/evidence/${evidenceId}`,q);
  assert.equal(detail.status,200);assert.equal(detail.data.item.id,evidenceId);
 }finally{f.close();}
});

test('complete analytics evidence is opt-in, generation-isolated and preserves run-date semantics',async()=>{
 const f=await fixture();try{
  // A run started inside the period but its answer was observed on the next day.
  // Raw analytics includes it; the Overview drawer intentionally does not.
  f.add('late-answer',{at:stamp+10_000,observedAt:stamp+DAY});
  const raw=(await f.baseline()).data;
  const overview=(await ready(f)).data;
  const oldPage=(await f.evidence(overview.readModel.generation,{pageSize:'100'})).data;
  assert.equal(oldPage.items.some(e=>e.id==='late-answer'),false);
  const q=query();q.set('evidenceScope','analytics');
  assert.equal((await f.summary(q)).status,202);
  assert.equal((await f.build()).state,'published');
  const saved=(await f.summary(q)).data;
  assert.equal(saved.evidenceScope,'analytics');
  assert.notEqual(saved.readModel.generation,overview.readModel.generation);
  const page=(await f.evidence(saved.readModel.generation,{pageSize:'100'})).data;
  assert.deepEqual(page.items,raw.evidence);
  assert.equal(page.total,raw.evidence.length);
  assert.equal(saved.readModel.evidenceCount,raw.evidence.length);
  assert.deepEqual(saved.overview,raw.overview);
  assert.equal((await f.summary()).data.readModel.generation,overview.readModel.generation);
  await assert.rejects(f.evidence(saved.readModel.generation,{},'a','bob'),e=>e.status===404);
  const invalid=query();invalid.set('evidenceScope','all-tenants');
  await assert.rejects(f.summary(invalid),e=>e.status===422);
 }finally{f.close();}
});
