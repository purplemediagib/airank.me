import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './research.test.mjs';
import {migrateImmediate} from '../src/monitoring/immediate-migration.mjs';
import {tickImmediate} from '../src/monitoring/immediate.mjs';
import {monitoringService} from '../src/monitoring/service.mjs';
import {migrateDailyScheduling} from '../src/scheduling/daily-migration.mjs';
import {scheduleService,tickProjects} from '../src/scheduling/projects.mjs';
import {createMonitoringEngine} from '../src/monitoring/engine.mjs';
import {migrateApiBudget} from '../src/monitoring/budget-migration.mjs';
import {fixtureBudgetConfig} from './api-budget-fixture.mjs';
import {apiObservation} from '../src/common/observations.mjs';
import {createAppService,csrfFor} from '../src/app/service.mjs';
import {hashToken} from '../src/common/utils.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {draftFixture} from './suggestion-fixture.mjs';

const env={TRACKED_PROMPT_LIMIT:'20',MONITORING_ENABLED:'true',PROJECT_SCHEDULER_ENABLED:'false',ENABLED_PROVIDERS:'openai',OPENAI_API_KEY:'offline-test-key'};
env.API_BUDGET_CONFIG_JSON=fixtureBudgetConfig(env);
const payload=text=>({text,kind:'neutral',tags:[],topic:''});
async function setup(){
 const f=await fixture();
 await migrateApiBudget(f.db);
 await migrateDailyScheduling(f.db);await migrateImmediate(f.db);await migrateImmediate(f.db);
 let clock=Date.parse('2026-10-20T12:00:00Z');
 const now=()=>clock;
 const api=(method,suffix,body,e=env)=>monitoringService({db:f.db,method,path:`/v1/projects/project/${suffix}`,body,userId:'alice',env:e,now,generate:draftFixture});
 return {...f,api,now,advance:t=>{clock=t;},tick:e=>tickImmediate(f.db,{env:e||env,now}),
  rows:()=>f.sql.prepare("SELECT * FROM mon_runs WHERE id<>'run'").all(),
  queue:()=>f.sql.prepare('SELECT * FROM mon_immediate_outbox ORDER BY created_at,prompt_id').all()};
}
test('no account/project backfill or paid GET; created and accepted prompts enqueue atomically',async()=>{
 const f=await setup();try{
  await f.tick();assert.equal(f.queue().length,0);assert.equal(f.rows().length,0);
  const p=(await f.api('POST','prompts',payload('Which tools are suitable for small businesses?'))).data;
  assert.equal(f.queue().length,1);assert.equal(f.rows().length,0);
  await f.api('GET','prompts');
  await scheduleService({db:f.db,method:'GET',path:'/v1/projects/project/schedule',userId:'alice',env,now:f.now});
  assert.equal(f.rows().length,0);
  const suggestions=(await f.api('POST','suggestions',{})).data;
  const selected=suggestions.find(s=>s.kind==='neutral');
  await f.api('POST',`suggestions/${selected.id}`,{action:'accept'});
  await f.api('POST',`suggestions/${selected.id}`,{action:'accept'});
  assert.equal(f.queue().length,2);
  await Promise.all([f.tick(),f.tick()]);
  await f.tick();
  assert.equal(f.rows().length,1);
  const snapshot=JSON.parse(f.rows()[0].snapshot);
  assert.equal(snapshot.prompts.length,2);assert.equal(snapshot.collectionScope,'full');
  assert.ok(Object.hasOwn(snapshot,'cohort'));assert.equal(snapshot.prompts.find(x=>x.id===p.id).version,1);
  assert.ok(f.queue().every(r=>r.state==='submitted'));
 }finally{f.sql.close();}
});
test('metadata does not buy again; text/context edits do; archive, activation and current versions',async()=>{
 const f=await setup();try{
  let p=(await f.api('POST','prompts',payload('Which tools are suitable for small businesses?'))).data;
  p=(await f.api('PATCH',`prompts/${p.id}`,{...p,tags:['new'],topic:'new topic',expectedVersion:p.version})).data;
  assert.equal(f.queue().length,1);
  await f.tick();
  assert.equal(JSON.parse(f.rows()[0].snapshot).prompts[0].version,2);
  p=(await f.api('PATCH',`prompts/${p.id}`,{...p,tags:['again'],expectedVersion:p.version})).data;
  await f.tick();assert.equal(f.rows().length,1);
  p=(await f.api('PATCH',`prompts/${p.id}`,{...p,text:'Which tools are suitable for larger businesses?',expectedVersion:p.version})).data;
  await f.tick();assert.equal(f.rows().length,2);
  p=(await f.api('PATCH',`prompts/${p.id}`,{...p,status:'archived',expectedVersion:p.version})).data;
  await f.tick();assert.equal(f.rows().length,2);
  p=(await f.api('PATCH',`prompts/${p.id}`,{...p,status:'active',expectedVersion:p.version})).data;
  await f.tick();assert.equal(f.rows().length,2);
  let q=(await f.api('POST','prompts',payload('Which tools are accessible for everyone?'))).data;
  q=(await f.api('PATCH',`prompts/${q.id}`,{...q,status:'archived',expectedVersion:1})).data;
  await f.tick();assert.equal(f.queue().find(r=>r.prompt_id===q.id).state,'cancelled');
  await f.api('PATCH',`prompts/${q.id}`,{...q,status:'active',expectedVersion:q.version});
  await f.tick();assert.equal(f.rows().length,3);
  f.sql.prepare("UPDATE app_projects SET status='archived' WHERE id='project'").run();
  assert.equal(f.rows().length,3);
 }finally{f.sql.close();}
});
test('disabled monitoring and validation are durable blocked states; archived projects never enqueue',async()=>{
 const f=await setup();try{
  await f.api('POST','prompts',payload('Which tools are appropriate for teams?'));
  await f.tick({...env,MONITORING_ENABLED:'false'});
  assert.equal(f.queue()[0].reason,'MONITORING_NOT_ENABLED');assert.equal(f.rows().length,0);
  await f.tick({...env,TRACKED_PROMPT_LIMIT:undefined});
  assert.equal(f.queue()[0].reason,'PROMPT_LIMIT_NOT_CONFIGURED');
  await f.tick({...env,OPENAI_API_KEY:''});
  assert.equal(f.queue()[0].reason,'MONITORING_PROVIDERS_UNCONFIGURED');
  assert.equal(f.rows().length,0);
  await f.tick({...env,OPENROUTER_MODELS_JSON:'invalid'});
  assert.equal(f.queue()[0].reason,'APP_NOT_CONFIGURED');
  await f.tick({...env,MONITORING_MAX_TASKS_PER_RUN:'bad'});
  assert.equal(f.queue()[0].reason,'APP_NOT_CONFIGURED');
  f.sql.prepare("UPDATE app_projects SET status='archived' WHERE id='project'").run();
  await f.tick();assert.equal(f.queue()[0].state,'cancelled');assert.equal(f.rows().length,0);
 }finally{f.sql.close();}
});
test('daily first covers immediate without another reservation; incremental never suppresses daily full set',async()=>{
 for(const dailyFirst of [true,false]){
  const f=await setup();try{
   const e={...env,PROJECT_SCHEDULER_ENABLED:'true'};
   await f.api('POST','prompts',payload('Which tools are appropriate for teams?'));
   // Reserve an old prompt on a prior date so only the subsequently added one is new.
   await f.tick();
   await f.api('POST','prompts',payload('Which tools are appropriate for families?'));
   f.advance(f.now()+86400000);
   const s=await scheduleService({db:f.db,method:'GET',path:'/v1/projects/project/schedule',userId:'alice',env:e,now:f.now});
   f.advance(s.data.nextAt);
   if(dailyFirst){
    await tickProjects(f.db,{env:e,now:f.now});await f.tick();
    assert.equal(f.rows().length,2);
    assert.equal(f.queue().find(r=>r.state==='covered').reason,'already_reserved');
   }else{
    await f.tick();assert.equal(JSON.parse(f.rows()[1].snapshot).collectionScope,'incremental');
    await tickProjects(f.db,{env:e,now:f.now});assert.equal(f.rows().length,3);
   }
   const last=JSON.parse(f.rows().at(-1).snapshot);assert.equal(last.prompts.length,2);
  }finally{f.sql.close();}
 }
});
test('full initial run deduplicates same-day daily slot and worker budget failures are never retried',async()=>{
 const f=await setup();try{
  await f.api('POST','prompts',payload('Which tools are appropriate for teams?'));
  const e={...env,PROJECT_SCHEDULER_ENABLED:'true'};
  const s=await scheduleService({db:f.db,method:'GET',path:'/v1/projects/project/schedule',userId:'alice',env:e,now:f.now});
  f.advance(s.data.nextAt);
  await f.tick();await tickProjects(f.db,{env:e,now:f.now});
  assert.equal(f.rows().length,1);
  assert.equal(f.sql.prepare("SELECT reason FROM app_schedule_slots").get().reason,'DAILY_ALREADY_MEASURED');
  let paid=0;
  const engine=createMonitoringEngine({db:f.db,env:{...env,MAX_DAILY_PROVIDER_CALLS:'0'},now:f.now,available:()=>true,call:async()=>{paid++;throw Error('must not call');}});
  await engine.tick();await f.tick();await engine.tick();
  assert.equal(paid,0);assert.equal(f.rows().length,1);
 }finally{f.sql.close();}
});
test('authenticated explicit bootstrap seeds old sets only, returns normal run, rejects browser internals and never rebuys',async()=>{
 const f=await fixture();try{
  const p=(await monitoringService({db:f.db,method:'POST',path:'/v1/projects/project/prompts',
   body:payload('Which tools help small companies?'),userId:'alice',env})).data;
  await migrateDailyScheduling(f.db);await migrateImmediate(f.db);
  await tickImmediate(f.db,{env});
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_immediate_outbox').get().n,0);
  const origin='https://preview.example.test',token='bootstrap-session-token';
  f.sql.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hashToken(token),'alice',Date.now()+3600000,1);
  const service=createAppService({db:f.db,env,clients:{preview:{origin,redirectUri:`${origin}/callback`}}});
  const post=body=>service({method:'POST',path:'/v1/projects/project/monitoring-runs',body,
   headers:{'x-airank-client':'preview',origin,'content-type':'application/json',cookie:`__Host-airank_session=${token}`,'x-csrf-token':csrfFor(token)}});
  const body={kind:'neutral',submissionId:'explicit-bootstrap-submission'};
  await assert.rejects(post({...body,immediate:true}),e=>e.code==='VALIDATION_FAILED');
  const result=await post(body);
  assert.equal(result.status,202);assert.equal(result.data.expected,1);assert.ok(result.data.id);
  assert.equal(JSON.parse(f.sql.prepare('SELECT snapshot FROM mon_runs WHERE id=?').get(result.data.id).snapshot).prompts[0].id,p.id);
  await assert.rejects(post(body),e=>e.code==='NO_UNMEASURED_PROMPTS');
  await tickImmediate(f.db,{env});
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM mon_runs WHERE id<>'run'").get().n,1);
  const s=await scheduleService({db:f.db,method:'GET',path:'/v1/projects/project/schedule',userId:'alice',env});
  assert.deepEqual(s.data.immediate,{state:'submitted',reason:null,runId:result.data.id});
 }finally{f.sql.close();}
});
test('queued immediate work is checked for archive/current text before reserving supplier budget',async()=>{
 for(const archived of [true,false]){
  const f=await setup();try{
   const p=(await f.api('POST','prompts',payload('Which tools are appropriate for teams?'))).data;
   await f.tick();
   if(archived)f.sql.prepare("UPDATE app_projects SET status='archived' WHERE id='project'").run();
   else await f.api('PATCH',`prompts/${p.id}`,{...p,text:'Which tools are appropriate for multilingual teams?',expectedVersion:p.version});
   let calls=0;
   const engine=createMonitoringEngine({db:f.db,env,now:f.now,available:()=>true,call:async()=>{calls++;throw Error('must not call');}});
   await engine.tick();
   assert.equal(calls,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_budget').get().n,0);
  }finally{f.sql.close();}
 }
});
test('current context edits enqueue and supersede pending old context without a paid attempt',async()=>{
 const f=await setup();try{
  let p=(await f.api('POST','prompts',payload('Which tools are appropriate for teams?'))).data;
  f.sql.prepare("UPDATE app_identity_versions SET identity_json=? WHERE project_id='project'").run(JSON.stringify({...f.identity,market:'SE',promptLanguage:'sv'}));
  p=(await f.api('PATCH',`prompts/${p.id}`,{...p,expectedVersion:p.version})).data;
  assert.equal(p.market,'SE');assert.equal(f.queue().length,2);
  await f.tick();
  assert.equal(f.queue().filter(r=>r.state==='cancelled').length,1);
  assert.equal(f.rows().length,1);
  assert.equal(JSON.parse(f.rows()[0].snapshot).language,'sv');
 }finally{f.sql.close();}
});
test('daily and immediate workers racing on a full initial set share one reservation',async()=>{
 const f=await setup();try{
  await f.api('POST','prompts',payload('Which tools are appropriate for teams?'));
  const e={...env,PROJECT_SCHEDULER_ENABLED:'true'};
  const s=await scheduleService({db:f.db,method:'GET',path:'/v1/projects/project/schedule',userId:'alice',env:e,now:f.now});
  f.advance(s.data.nextAt);
  await Promise.all([tickProjects(f.db,{env:e,now:f.now}),f.tick(),f.tick()]);
  assert.equal(f.rows().length,1);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM mon_tasks WHERE run_id<>'run'").get().n,1);
 }finally{f.sql.close();}
});
test('durable outbox survives database reopen and fresh workers do not requeue reserved attempts',async()=>{
 const f=await setup(),dir=mkdtempSync(join(tmpdir(),'airank-immediate-')),file=join(dir,'db.sqlite');
 let sql;
 try{
  await f.api('POST','prompts',payload('Which tools are appropriate for teams?'));
  f.sql.prepare('VACUUM INTO ?').run(file);
  const open=()=>{
   sql=new DatabaseSync(file);
   const execute=async q=>{
    const text=typeof q==='string'?q:q.sql,args=typeof q==='string'?[]:q.args||[],s=sql.prepare(text);
    return /^\s*SELECT/i.test(text)?{rows:s.all(...args)}:{rows:[],rowsAffected:Number(s.run(...args).changes)};
   };
   return {execute,transaction:async()=>{
    sql.exec('BEGIN IMMEDIATE');
    return {execute,commit:async()=>sql.exec('COMMIT'),rollback:async()=>sql.exec('ROLLBACK'),close:()=>{}};
   }};
  };
  let db=open();
  await tickImmediate(db,{env,now:f.now});
  const run=sql.prepare("SELECT id FROM mon_runs WHERE id<>'run'").get().id;
  sql.close();db=open();
  await tickImmediate(db,{env,now:f.now});
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM mon_runs WHERE id<>'run'").get().n,1);
  assert.equal(sql.prepare('SELECT run_id FROM mon_immediate_outbox').get().run_id,run);
 }finally{sql?.close();f.sql.close();rmSync(dir,{recursive:true,force:true});}
});
test('API bootstrap without supplier credentials queues for credentialed worker; no browser bypass',async()=>{
 const f=await setup();try{
  await f.api('POST','prompts',payload('Which tools are appropriate for teams?'));
  const apiEnv={...env,OPENAI_API_KEY:undefined};
  const origin='https://preview.example.test',token='bootstrap-no-supplier-keys';
  f.sql.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hashToken(token),'alice',Date.now()+3600000,1);
  const service=createAppService({db:f.db,env:apiEnv,clients:{preview:{origin,redirectUri:`${origin}/callback`}}});
  const result=await service({method:'POST',path:'/v1/projects/project/monitoring-runs',
   body:{kind:'neutral',submissionId:'bootstrap-with-worker-only-credentials'},
   headers:{'x-airank-client':'preview',origin,'content-type':'application/json',cookie:`__Host-airank_session=${token}`,'x-csrf-token':csrfFor(token)}});
  assert.equal(result.status,202);assert.equal(result.data.status,'queued');
  let calls=0;
   const engine=createMonitoringEngine({db:f.db,env,now:f.now,call:async()=>{calls++;return {status:'success',answer:'A grounded supplier answer.',citations:[{url:'https://example.fi/source'}],observation:apiObservation({complete:true})};}});
  await engine.tick();
  assert.equal(calls,1);
  await f.tick();await engine.tick();assert.equal(calls,1);
 }finally{f.sql.close();}
});
test('capacity-only rejection is stable until config changes, then resumes without rewriting old run',async()=>{
 const f=await setup();try{
  await f.api('POST','prompts',payload('Which tools are appropriate for teams?'));
  await f.api('POST','prompts',payload('Which tools are appropriate for families?'));
  await f.tick({...env,MONITORING_MAX_TASKS_PER_RUN:'1'});
  assert.equal(f.rows().length,1);assert.equal(f.rows()[0].status,'capacity_blocked');
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM mon_tasks WHERE run_id<>'run'").get().n,0);
  await f.tick({...env,MONITORING_MAX_TASKS_PER_RUN:'1'});
  assert.equal(f.rows().length,1);
  await f.tick({...env,MONITORING_MAX_TASKS_PER_RUN:'2'});
  assert.equal(f.rows().length,2);
  assert.equal(f.rows()[0].status,'capacity_blocked');assert.equal(f.rows()[1].status,'queued');
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM mon_tasks WHERE run_id<>'run'").get().n,2);
  assert.ok(f.queue().every(r=>r.state==='submitted'));
 }finally{f.sql.close();}
});
