import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
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
  return {execute,batch:async function(statements){const results=[];for(const q of statements)results.push(await this.execute(q));return results;},commit:async()=>end('COMMIT'),rollback:async()=>end('ROLLBACK'),close:()=>{if(!completed)end('ROLLBACK');}};
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
 const build=options=>runProjection({db,env,now:()=>clock,...options});
 const baseline=()=>analyticsService({db,path:'/v1/projects/a/analytics',userId:'alice',query:query(),env});
 const row=(text,...args)=>sql.prepare(text).get(...args);
 return {sql,db,queries,add,call,summary,evidence,build,baseline,row,now:()=>clock,advance:ms=>{clock+=ms;},close:()=>sql.close()};
}

// Local-only deterministic diagnostic. No production DB or provider calls.
// Optional third argument: absolute path to a baseline summary-projector.mjs.
const runProjection=process.argv[3]?(await import(pathToFileURL(process.argv[3]).href)).projectSummaryOnce:projectSummaryOnce;
const delayMs=Number(process.argv[2]||0);
if(!Number.isFinite(delayMs)||delayMs<0||delayMs>500)throw Error('delay must be 0..500ms');
const f=await fixture();
const profileEpoch=Date.now(),profileNow=()=>stamp+Date.now()-profileEpoch;
f.sql.exec('DELETE FROM mon_evidence; DELETE FROM mon_tasks; DELETE FROM mon_runs;');
for(let g=0;g<10;g++){
 const run=`profile-run-${g}`, at=stamp-g*1000;
 const prompts=Array.from({length:84},(_,i)=>({id:`profile-p-${i}`,version:1,text:`Which service for use ${i}?`,topic:'Price',tags:['pricing']}));
 const snap={...snapshot,prompts,identityVersion:g+1};
 f.sql.prepare('INSERT INTO mon_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(run,'a','alice',run,run,'neutral','complete',JSON.stringify(snap),84,at,at+1000,null);
 for(const p of prompts){const id=`${run}-${p.id}`;
  f.sql.prepare('INSERT INTO mon_tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,run,p.id,1,p.text,'openai','{}','done',null,null);
  f.sql.prepare('INSERT INTO mon_evidence VALUES (?,?,?,?)').run(id,run,JSON.stringify({id,runId:run,promptId:p.id,promptVersion:1,text:p.text,provider:'openai',model:'fixture',status:'success',observedAt:at,answer:'Example is a useful service.',citations:[{url:'https://example.test/source'}]}),at);
 }
}
const q=()=>new URLSearchParams({from:'2026-11-03',to:'2026-11-03',evidenceScope:'analytics'});
let phase='request', events=[];
const wait=async()=>{if(delayMs)await new Promise(r=>setTimeout(r,delayMs));};
const wrap=target=>({
 execute:async(q)=>{events.push({phase,kind:'execute',sql:typeof q==='string'?q:q.sql});await wait();return target.execute(q);},
 batch:async statements=>{events.push({phase,kind:'batch',statements:statements.map(q=>q.sql),binds:statements.reduce((n,q)=>n+(q.args?.length||0),0),argumentBytes:statements.reduce((n,q)=>n+Buffer.byteLength(JSON.stringify(q.args||[])),0)});await wait();return target.batch(statements);},
});
const orig={...f.db};
f.db.execute=wrap(orig).execute;
f.db.transaction=async mode=>{events.push({phase,kind:'begin'});await wait();const tx=await orig.transaction(mode);return {...wrap(tx),commit:async()=>{events.push({phase,kind:'commit'});await wait();return tx.commit();},rollback:async()=>tx.rollback(),close:()=>tx.close()};};
const {buildOverviewSummary}=await import('../src/analytics/summary-overview.mjs');
const rows=[];
async function build(){events=[];phase='claim';const times={};let last=performance.now();const mark=p=>{times[phase]=(times[phase]||0)+performance.now()-last;last=performance.now();phase=p;};
 const started=performance.now();const result=await f.build({now:profileNow,compute:async args=>{mark('aggregate');const x=await analyticsService(args);mark('identity');return x;},buildOverview:args=>{mark('overview');const x=buildOverviewSummary(args);mark('publish');return x;}});mark('done');
 if(result.state!=='published')throw Error(JSON.stringify(result));
 const byPhase={};for(const e of events){const x=byPhase[e.phase]??={execute:0,begin:0,commit:0};x[e.kind]=(x[e.kind]||0)+1;}
 const generation=f.row('SELECT summary_json FROM analytics_summary_generations WHERE id=?',result.generation);
 const saved=f.sql.prepare('SELECT p.payload FROM analytics_summary_evidence e JOIN analytics_summary_payloads p ON p.hash=e.payload_hash WHERE e.generation_id=? ORDER BY e.position').all(result.generation);
 const outputDigest=createHash('sha256').update(JSON.stringify({summary:JSON.parse(generation.summary_json),evidence:saved.map(r=>JSON.parse(r.payload))})).digest('hex');
 rows.push({outputDigest,sqlStatements:events.reduce((n,e)=>n+(e.kind==='execute'?1:e.statements?.length||0),0),maxBatchStatements:Math.max(0,...events.map(e=>e.statements?.length||0)),maxBatchBinds:Math.max(0,...events.map(e=>e.binds||0)),maxBatchArgumentBytes:Math.max(0,...events.map(e=>e.argumentBytes||0)),ms:Math.round(performance.now()-started),phaseMs:Object.fromEntries(Object.entries(times).map(([k,v])=>[k,Math.round(v)])),calls:byPhase,allWindowEvidenceReads:events.filter(e=>e.sql?.includes('SELECT e.payload FROM mon_evidence')).length});
}
// Anchor output to the fixture UTC day while leases advance by real elapsed time.
await f.summary(q());await build();const head=await f.summary(q());
for(const group of head.data.groups.filter(x=>x.id!==head.data.selectedGroup)){const query=q();query.set('group',group.id);await f.summary(query);}
for(let i=1;i<head.data.groups.length;i++)await build();
console.log(JSON.stringify({synthetic:true,baselineProjector:process.argv[3]||null,maxRssKiB:process.resourceUsage().maxRSS,delayPerDbOperationMs:delayMs,runs:10,tasks:840,groups:head.data.groups.length,serialBuildMs:rows.reduce((n,x)=>n+x.ms,0),projections:rows},null,2));
f.close();
