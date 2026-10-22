import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './research.test.mjs';
import {monitoringService} from '../src/monitoring/service.mjs';
import {migrateDailyScheduling} from '../src/scheduling/daily-migration.mjs';
import {migrateScheduling} from '../src/scheduling/migration.mjs';
import {scheduleService,tickProjects,dailyConfig,nextProjectSlot} from '../src/scheduling/projects.mjs';
const env={TRACKED_PROMPT_LIMIT:'2',MONITORING_ENABLED:'true',PROJECT_SCHEDULER_ENABLED:'true',ENABLED_PROVIDERS:'openai'};
const payload=text=>({text,kind:'neutral',tags:[],topic:''});
test('migration day cannot double measure an owner with an older submission key',async()=>{
 for(const withSlot of [false,true]){
  const f=await fixture();try{
   await migrateScheduling(f.db);
   // Helsinki 03:30, before the new daily 04:MM slot. The legacy key
   // does not match the daily submission hash.
   let clock=Date.parse('2026-10-16T00:30:00Z');
   const legacyAt=clock-30*60000;
   f.sql.prepare("UPDATE mon_runs SET created_at=? WHERE id='run'").run(withSlot?clock-86400000:legacyAt);
   if(withSlot)f.sql.prepare('INSERT INTO app_schedule_slots VALUES (?,?,?,?,?,?)').run('project','2026-10-16T03:00',legacyAt,'submitted','run',null);
   f.sql.prepare('INSERT INTO app_project_schedules VALUES (?,?,?,?,?,?,?)').run('project',1,1,'Europe/Helsinki',8,'[1,4]',clock);
   await monitoringService({db:f.db,method:'POST',path:'/v1/projects/project/prompts',body:payload('Which services are suitable?'),userId:'alice',env});
   await migrateDailyScheduling(f.db);
   await migrateDailyScheduling(f.db);
   const get=()=>scheduleService({db:f.db,method:'GET',path:'/v1/projects/project/schedule',userId:'alice',env,now:()=>clock});
   clock=(await get()).data.nextAt;
   await Promise.all([tickProjects(f.db,{env,now:()=>clock}),tickProjects(f.db,{env,now:()=>clock})]);
   assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_runs').get().n,1);
   assert.equal(f.sql.prepare("SELECT reason FROM app_schedule_slots WHERE slot='2026-10-16'").get().reason,'DAILY_ALREADY_MEASURED');
   assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_budget').get().n,0);
   // The following day remains eligible; no permanent lockout.
   clock=(await get()).data.nextAt;
   await tickProjects(f.db,{env,now:()=>clock});
   assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_runs').get().n,2);
  }finally{f.sql.close();}
 }
});
test('atomic account prompt cap survives multiple workspaces, restores and missing policy',async()=>{
 const f=await fixture();try{
  const call=(method,suffix,body,e=env)=>monitoringService({db:f.db,method,path:`/v1/projects/project/${suffix}`,body,userId:'alice',env:e});
  await assert.rejects(call('POST','prompts',payload('Which tools should a business compare?'),{}),e=>e.code==='PROMPT_LIMIT_NOT_CONFIGURED');
  const results=await Promise.allSettled(['Which tools are affordable?','Which tools are reliable?','Which tools are accessible?'].map(t=>call('POST','prompts',payload(t))));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'PROMPT_LIMIT_REACHED');
  const p=results.find(r=>r.status==='fulfilled').value.data;
  await call('PATCH',`prompts/${p.id}`,{...p,status:'archived',expectedVersion:1});
  await call('POST','prompts',payload('Which tools have transparent prices?'));
  await assert.rejects(call('PATCH',`prompts/${p.id}`,{...p,status:'active',expectedVersion:2}),e=>e.code==='PROMPT_LIMIT_REACHED');
  f.sql.prepare('INSERT INTO app_projects VALUES (?,?,?,?,?)').run('other','alice','active',1,1);
  await assert.rejects(call('POST','prompts',payload('Which tools offer multilingual support?')),e=>e.code==='PROMPT_LIMIT_REACHED');
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_runs').get().n,1);
 }finally{f.sql.close();}
});
test('multiple workspaces enroll independently and each measures once per Helsinki day',async()=>{
 const f=await fixture();try{
  await migrateDailyScheduling(f.db);
  f.sql.prepare('INSERT INTO app_projects VALUES (?,?,?,?,?)').run('other','alice','active',1,1);
  f.sql.prepare("INSERT INTO app_identity_versions SELECT 'other',version,identity_json,created_at FROM app_identity_versions WHERE project_id='project'").run();
  const e={...env,TRACKED_PROMPT_LIMIT:'4'};
  let clock=Date.parse('2026-10-20T12:00:00Z');
  for(const projectId of ['project','other']){
   await monitoringService({db:f.db,method:'POST',path:`/v1/projects/${projectId}/prompts`,body:payload(`Which services are reliable for ${projectId} users?`),userId:'alice',env:e});
   const s=await scheduleService({db:f.db,method:'GET',path:`/v1/projects/${projectId}/schedule`,userId:'alice',env:e,now:()=>clock});
   assert.equal(s.data.status,'scheduled');
  }
  clock=Number(f.sql.prepare("SELECT next_at FROM app_project_schedules WHERE project_id='project'").get().next_at);
  await tickProjects(f.db,{env:e,now:()=>clock});
  await tickProjects(f.db,{env:e,now:()=>clock});
  const runs=f.sql.prepare("SELECT project_id,submission_id FROM mon_runs WHERE id<>'run'").all();
  assert.equal(runs.length,2);assert.equal(new Set(runs.map(r=>r.project_id)).size,2);
  assert.equal(new Set(runs.map(r=>r.submission_id)).size,2);
  f.sql.prepare("UPDATE app_project_schedules SET enabled=0 WHERE project_id='project'").run();
  clock=Number(f.sql.prepare("SELECT next_at FROM app_project_schedules WHERE project_id='other'").get().next_at);
  await tickProjects(f.db,{env:e,now:()=>clock});
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM mon_runs WHERE project_id='other'").get().n,2);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM mon_runs WHERE project_id='project' AND id<>'run'").get().n,1);
  await assert.rejects(scheduleService({db:f.db,method:'GET',path:'/v1/projects/other/schedule',userId:'bob',env:e}),err=>err.code==='NOT_FOUND');
 }finally{f.sql.close();}
});
test('daily auto-enrollment, no paid read, stable DST, owner/day idempotency and missed pending window',async()=>{
 const f=await fixture();try{
  await migrateDailyScheduling(f.db);
  let clock=Date.parse('2026-03-28T12:00Z');
  await monitoringService({db:f.db,method:'POST',path:'/v1/projects/project/prompts',body:payload('Which services are reliable?'),userId:'alice',env});
  const get=()=>scheduleService({db:f.db,method:'GET',path:'/v1/projects/project/schedule',userId:'alice',env,now:()=>clock});
  const s=(await get()).data;
  assert.equal(s.status,'scheduled');assert.equal(s.hour,4);assert.equal(s.activePromptCount,1);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_runs').get().n,1);
  const c=dailyConfig('alice');
  assert.match(new Date(nextProjectSlot(clock,c)).toISOString(),/^2026-03-29T01:/);
  assert.match(new Date(nextProjectSlot(Date.parse('2026-10-24T12:00Z'),c)).toISOString(),/^2026-10-25T02:/);
  clock=s.nextAt;
  await Promise.all([tickProjects(f.db,{env,now:()=>clock}),tickProjects(f.db,{env,now:()=>clock})]);
  await tickProjects(f.db,{env,now:()=>clock});
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_runs').get().n,2);
  const r=f.sql.prepare("SELECT snapshot FROM mon_runs WHERE id<>'run'").get();
  assert.equal(JSON.parse(r.snapshot).prompts.length,1);
  assert.ok(JSON.parse(r.snapshot).prompts[0].id);
  f.sql.prepare("INSERT INTO app_schedule_slots VALUES ('project','old-slot',?,'pending',NULL,NULL)").run(clock-7*3600000);
  await tickProjects(f.db,{env,now:()=>clock});
  assert.equal(f.sql.prepare("SELECT state FROM app_schedule_slots WHERE slot='old-slot'").get().state,'skipped');
 }finally{f.sql.close();}
});
