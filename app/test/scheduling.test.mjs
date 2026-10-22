import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './research.test.mjs';
import {migrateScheduling} from '../src/scheduling/migration.mjs';
import {migrateDailyScheduling} from '../src/scheduling/daily-migration.mjs';
import {nextProjectSlot,scheduleService,tickProjects} from '../src/scheduling/projects.mjs';
import {industriesService} from '../src/scheduling/industries.mjs';
import {claim,enqueue} from '../src/benchmark/core.mjs';
const env={TRACKED_PROMPT_LIMIT:'100',APP_ADMIN_USER_IDS:'alice',PROJECT_SCHEDULER_ENABLED:'true',MONITORING_ENABLED:'true',BENCHMARK_ENABLED:'true',BENCHMARK_SCHEDULER_ENABLED:'true',ENABLED_PROVIDERS:'openai',BENCHMARK_MAX_CALLS_PER_RUN:'2',BENCHMARK_MAX_DAILY_CALLS:'3'};
const panel={id:'test-v1',industry:{id:'software',name:'Ohjelmistot'},version:'v1',country:'FI',language:'fi',brands:[{id:'rival',name:'Rival',domain:'rival.fi',aliases:[]}],prompts:[{id:'p',text:'Mitkä ohjelmistot ovat hyviä?',intent:'discovery'}]};
test('DST wall time, invalid dates, skipped nonexistent local times',()=>{
 const cfg={timezone:'Europe/Helsinki',hour:8,weekdays:[0]};
 assert.equal(new Date(nextProjectSlot(Date.parse('2026-03-28T10:00Z'),cfg)).toISOString(),'2026-03-29T05:00:00.000Z');
 assert.equal(new Date(nextProjectSlot(Date.parse('2026-10-24T10:00Z'),cfg)).toISOString(),'2026-10-25T06:00:00.000Z');
 assert.equal(new Date(nextProjectSlot(Date.parse('2026-03-28T10:00Z'),{...cfg,hour:3})).toISOString(),'2026-04-05T00:00:00.000Z');
});
test('project slots: duplicate workers, restart, pause/resume, missed window, ownership',async()=>{
 const f=await fixture();try{
  await migrateDailyScheduling(f.db);await migrateDailyScheduling(f.db);
 let now=Date.parse('2026-10-12T04:00Z');
 const request=(body,userId='alice')=>scheduleService({db:f.db,method:body?'PATCH':'GET',path:'/v1/projects/project/schedule',body,userId,env,now:()=>now});
  const body={expectedVersion:0,enabled:true,timezone:'Europe/Helsinki',hour:4,weekdays:[0,1,2,3,4,5,6]};
 await request(body);
 f.sql.prepare('INSERT INTO mon_prompts VALUES (?,?,?,?,?,?)').run('p','project',1,'active','h',1);
 f.sql.prepare('INSERT INTO mon_prompt_versions VALUES (?,?,?,?)').run('p',1,JSON.stringify({text:'Mitkä palvelut ovat hyviä?',topic:'',tags:[],kind:'neutral',status:'active'}),1);
  now=(await request()).data.nextAt;
 await Promise.all([tickProjects(f.db,{env,now:()=>now}),tickProjects(f.db,{env,now:()=>now})]);
 await tickProjects(f.db,{env,now:()=>now});
 let a=(await request()).data;assert.equal(a.slots.length,1);assert.equal(a.slots[0].state,'submitted');
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_runs').get().n,2);
 await request({...body,expectedVersion:1,enabled:false});
 await request({...body,expectedVersion:2});
 now=Date.parse('2026-10-16T20:00Z');await tickProjects(f.db,{env,now:()=>now});
 a=(await request()).data;assert.equal(a.slots[0].state,'skipped');
 await assert.rejects(request(null,'bob'),e=>e.status===404);
 }finally{f.sql.close();}
});
test('panel drafts, admin publication, immutable versions, capacity termination and stable slots',async()=>{
 const f=await fixture();try{
 await migrateScheduling(f.db);
 const req=(body,userId='alice',path='/v1/industries')=>industriesService({db:f.db,method:body?'POST':'GET',path,body,userId,env,now:()=>1});
 assert.equal((await req()).data.industries.length,12);
 await assert.rejects(req({action:'import',panel,verified:true,neutralConfirmed:true},'bob'),e=>e.status===403);
 await req({action:'import',panel,verified:true,neutralConfirmed:true});
 assert.equal((await req(null,'bob')).data.industries.find(i=>i.id==='software').panels.length,0);
 await req({action:'publish',panelId:panel.id,verified:true,neutralConfirmed:true});
 assert.equal((await req(null,'bob')).data.industries.find(i=>i.id==='software').panels.length,1);
 await assert.rejects(req({action:'import',panel:{...panel,prompts:[{...panel.prompts[0],text:'Mitä palvelua suosittelet yritykselle?'}]},verified:true,neutralConfirmed:true}),e=>e.status===409);
 const models={openai:'fixture',claude:'fixture',gemini:'fixture'};
 const routes=Object.fromEntries(Object.keys(models).map(p=>[p,{model:'fixture',transport:'direct'}]));
 const run=await enqueue(f.db,panel.id,'manual-token',models,10,routes);
 assert.equal(await enqueue(f.db,panel.id,'manual-token',models,10,routes),run);
 assert.equal(await claim(f.db,{daily:3,perRun:2},11),null);
 assert.equal(f.sql.prepare('SELECT status FROM bm_runs WHERE id=?').get(run).status,'capacity_blocked');
 }finally{f.sql.close();}
});
