import test from 'node:test';
import assert from 'node:assert/strict';
import {planFixture,identity,prompt,providers,secret} from './plan-fixture.mjs';
import {PLANS,TRIAL_MS,WEEK_MS,projectPlan} from '../src/common/plans.mjs';
import {migratePlans,checksum} from '../src/app/plan-migration.mjs';
import {appError,isAppPath} from '../src/app/http.mjs';
import {monitoringService} from '../src/monitoring/service.mjs';
import {selectedRoutes} from '../src/reports/service.mjs';
import {createMonitoringEngine} from '../src/monitoring/engine.mjs';
import {tickProjects,scheduleService} from '../src/scheduling/projects.mjs';
import {tickImmediate} from '../src/monitoring/immediate.mjs';
import {access} from '../src/content/store.mjs';
import {schedule as scheduleContent} from '../src/content/worker.mjs';
import {createAppService} from '../src/app/service.mjs';
const withFixture=fn=>async()=>{const f=await planFixture();try{await fn(f);}finally{f.close();}};
const denied=(p,status,code='PLAN_LIMIT')=>assert.rejects(p,e=>e.status===status&&e.code===code);
const run=(f,p,submissionId,kind='neutral')=>monitoringService({db:f.db,method:'POST',path:`/v1/projects/${p}/monitoring-runs`,body:{kind,submissionId},userId:'alice',env:f.env,now:f.now});

test('migration preserves existing limits until billing sync and is repeatable with checksums',withFixture(async f=>{
 const old=f.sql.prepare('SELECT * FROM app_workspaces WHERE id=?').get('ws_legacy');assert.equal(old.plan,null);assert.equal(old.plan_status,'legacy');
 const before=f.sql.prepare('SELECT * FROM app_migrations ORDER BY id').all();await migratePlans(f.db);assert.deepEqual(f.sql.prepare('SELECT * FROM app_migrations ORDER BY id').all(),before);
 assert.equal(f.sql.prepare('SELECT checksum FROM app_migrations WHERE id=?').get('app-022-plan-limits').checksum,checksum);
 f.seed('legacy',55);await denied(f.add('legacy','Which design tools suit businesses?','old'),422,'PROMPT_LIMIT_REACHED');
 await f.push('ws_legacy','pro');assert.equal((await f.add('legacy','Which design tools suit businesses?','old')).status,'active');
}));

test('new signup receives Pro for exactly seven days from account creation, not first brand',withFixture(async f=>{
 const signup=f.now();f.advance(2*86400000);
 const p=await f.create();const plan=await projectPlan(f.db,p.id);assert.equal(plan.plan,'pro');assert.equal(plan.status,'trialing');assert.equal(plan.trialEndsAt,signup+TRIAL_MS);assert.equal(plan.trialStartedAt,signup);
 assert.deepEqual(plan.limits,PLANS.pro);assert.equal(Object.keys(await selectedRoutes(f.db,p.id,f.env)).length,5);
 const detail=(await f.call('GET',`/v1/projects/${p.id}`)).data;assert.equal(detail.workspaceId,p.workspaceId);
 const settings=(await f.call('GET',`/v1/projects/${p.id}/monitoring`)).data;assert.equal(settings.trialEndsAt,signup+TRIAL_MS);assert.equal(settings.planStatus,'trialing');
}));

test('trial expires at the boundary without webhook, preserves reads and cleanup; payment restores changes',withFixture(async f=>{
 const p=await f.create();f.advance(TRIAL_MS-1);await f.add(p.id);
 f.advance(1);
 const error=await f.add(p.id,'Which analytics tools suit small businesses?').catch(e=>e);
 assert.equal(error.status,402);assert.deepEqual(appError(error),{error:{code:'PLAN_LIMIT',limit:0,upgradeTo:'pro',reason:'TRIAL_EXPIRED'}});
 await denied(f.call('POST',`/v1/projects/${p.id}/monitoring-runs`,{kind:'neutral',submissionId:'expired-trial-attempt-001'}),402);
 await denied(f.call('POST',`/v1/projects/${p.id}/content/jobs`,{kind:'research'}),402);
 await denied(f.call('PATCH',`/v1/projects/${p.id}`,{...identity,expectedVersion:1}),402);
 for(const suffix of ['','/analytics','/prompts','/content'])assert.equal((await f.call('GET',`/v1/projects/${p.id}${suffix}`)).status,200);
 await f.push(p.workspaceId,'pro');assert.equal((await f.add(p.id,'Which analytics tools suit small businesses?')).status,'active');
 await f.push(p.workspaceId,'pro',2,'inactive');await denied(f.add(p.id,'Which CRM tools suit businesses?'),402);
 assert.equal((await f.call('POST',`/v1/projects/${p.id}/archive`,{expectedVersion:1})).status,200);
}));

test('ownership transfer and creating another workspace cannot restart the original signup trial',withFixture(async f=>{
 const p=await f.create();
 f.sql.prepare('INSERT INTO app_workspace_members VALUES(?,?,?,?)').run(p.workspaceId,'bob','admin',f.now());
 await f.call('POST',`/v1/projects/${p.id}/team/transfer`,{userId:'bob'});
 const next=await f.create();assert.notEqual(next.workspaceId,p.workspaceId);
 assert.equal((await projectPlan(f.db,next.id)).trialEndsAt,(await projectPlan(f.db,p.id)).trialEndsAt);
 f.advance(TRIAL_MS);await denied(f.create(),402);await denied(f.create('bob'),402);
}));

test('billing push needs its secret, validates lifecycle/revisions, and cannot be spoofed with sessions',withFixture(async f=>{
 const p=await f.create(),path=`/v1/internal/workspaces/${p.workspaceId}/plan`,body={plan:'custom',revision:1,status:'active'};
 assert.equal(isAppPath(path),true);
 for(const authorization of [undefined,'Bearer wrong-secret-012345678901234567890','Bearer airank_rt_'+'a'.repeat(43)])await denied(f.service({method:'POST',path,body,headers:{authorization,'content-type':'application/json',cookie:'__Host-airank_session=session-alice'}}),401,'AUTH_REQUIRED');
 await denied(f.service({method:'GET',path,body,headers:{authorization:'Bearer '+secret}}),405,'METHOD_NOT_ALLOWED');
 for(const bad of [{plan:'enterprise'}, {plan:['pro']}, {revision:0},{revision:1.5},{status:undefined},{status:'trialing',plan:'starter'},{limit:9999},{trialEndsAt:f.now()+TRIAL_MS*2,status:'trialing',plan:'pro'}])await assert.rejects(f.push(p.workspaceId,'pro',1,'active',bad),e=>e.status===422);
 await denied(f.push('ws_absent','pro'),404,'NOT_FOUND');
 const applied=(await f.push(p.workspaceId,'pro',3)).data;assert.equal(applied.changed,true);assert.equal((await f.push(p.workspaceId,'pro',3)).data.changed,false);
 await denied(f.push(p.workspaceId,'starter',2),409,'PLAN_REVISION_CONFLICT');await denied(f.push(p.workspaceId,'custom',3),409,'PLAN_REVISION_CONFLICT');
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM app_plan_events').get().n,1);assert.ok(!JSON.stringify(f.sql.prepare('SELECT * FROM app_plan_events').all()).includes(secret));
}));

test('billing trial sync cannot extend beyond signup plus seven days or silently become permanent Pro',withFixture(async f=>{
 const p=await f.create(),end=f.now()+TRIAL_MS;
 await f.push(p.workspaceId,'pro',1,'trialing');f.advance(3*86400000);
 await denied(f.push(p.workspaceId,'pro',2,'trialing',{trialEndsAt:f.now()+TRIAL_MS}),422,'INVALID_TRIAL_END');
 assert.equal((await f.push(p.workspaceId,'pro',2,'trialing')).data.trialEndsAt,end);
 f.advance(4*86400000);await denied(f.add(p.id),402);
 assert.equal((await f.push(p.workspaceId,'pro',3,'active')).data.status,'active');assert.equal((await f.add(p.id)).status,'active');
}));

for(const [plan,limit,upgradeTo] of [['starter',60,'pro'],['pro',175,'advanced'],['advanced',400,'custom']])test(`${plan} prompt cap is atomic and returns the exact app error shape`,withFixture(async f=>{
 const p=await f.create();await f.push(p.workspaceId,plan);f.seed(p.id,limit-1);
 const result=await Promise.allSettled([f.add(p.id,'Which email marketing tools suit small teams?'),f.add(p.id,'Which design tools suit small teams?')]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);const rejected=result.find(r=>r.status==='rejected').reason;assert.deepEqual(appError(rejected),{error:{code:'PLAN_LIMIT',limit,upgradeTo}});
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM mon_prompts WHERE project_id=? AND status='active'").get(p.id).n,limit);
}));

for(const [plan,limit] of [['starter',1],['pro',3],['advanced',10]])test(`${plan} brand cap shares the workspace and archived brands release capacity`,withFixture(async f=>{
 const p=await f.create();await f.push(p.workspaceId,plan);
 for(let n=1;n<limit;n++)assert.equal((await f.create()).workspaceId,p.workspaceId);
 await denied(f.create(),402);await f.call('POST',`/v1/projects/${p.id}/archive`,{expectedVersion:1});assert.equal((await f.create()).workspaceId,p.workspaceId);
}));

test('concurrent brand creation cannot exceed Starter quota',withFixture(async f=>{
 const p=await f.create();await f.push(p.workspaceId,'starter');await f.call('POST',`/v1/projects/${p.id}/archive`,{expectedVersion:1});
 const results=await Promise.allSettled([f.create(),f.create()]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'PLAN_LIMIT');
}));

test('Custom removes commercial count caps while retaining operational run capacity limits',withFixture(async f=>{
 const p=await f.create();await f.push(p.workspaceId,'custom');f.seed(p.id,401);await f.add(p.id);
 for(let n=0;n<11;n++)await f.create();assert.equal(Object.keys(await selectedRoutes(f.db,p.id,f.env)).length,providers.length);
 const schedule=await scheduleService({db:f.db,method:'GET',path:`/v1/projects/${p.id}/schedule`,userId:'alice',env:f.env,now:f.now});
 assert.equal(schedule.data.promptLimit,null);assert.equal(schedule.data.promptUnlimited,true);assert.equal(schedule.data.status,'scheduled');
 const r=await monitoringService({db:f.db,method:'POST',path:`/v1/projects/${p.id}/monitoring-runs`,body:{kind:'neutral',submissionId:'custom-capacity-submission'},userId:'alice',env:{...f.env,MONITORING_MAX_TASKS_PER_RUN:'1'},now:f.now});
 assert.equal(r.data.status,'capacity_blocked');
}));

test('members and guests consume the project workspace allowance, with no stale env override',withFixture(async f=>{
 const p=await f.create(),other=await f.create('bob');await f.push(p.workspaceId,'pro');await f.push(other.workspaceId,'custom');
 f.sql.prepare('INSERT INTO app_workspace_members VALUES(?,?,?,?)').run(p.workspaceId,'member','member',f.now());
 f.sql.prepare('INSERT INTO app_project_guests VALUES(?,?,?,?)').run(p.id,'bob','member',f.now());
 f.seed(p.id,174);await f.add(p.id,'Which small business email tools are best?','member');
 await denied(f.add(p.id,'Which software supports marketing teams?','bob'),402);
 f.seed(other.id,180);assert.equal((await f.add(other.id,'Which software supports marketing teams?','bob')).status,'active');
}));

test('model cap applies on old and new settings routes, and defaults to the allowed number',withFixture(async f=>{
 const p=await f.create();await f.push(p.workspaceId,'starter');assert.equal(Object.keys(await selectedRoutes(f.db,p.id,f.env)).length,3);
 for(const [method,suffix] of [['PUT','monitoring'],['PATCH','measurement-settings']]){
  const e=await f.call(method,`/v1/projects/${p.id}/${suffix}`,{providers:providers.slice(0,4),expectedVersion:0}).catch(e=>e);assert.deepEqual(appError(e),{error:{code:'PLAN_LIMIT',limit:3,upgradeTo:'pro'}});
 }
 assert.equal((await f.call('PUT',`/v1/projects/${p.id}/monitoring`,{providers:providers.slice(1,4)})).data.providers.length,3);
 await f.push(p.workspaceId,'pro',2);await denied(f.call('PUT',`/v1/projects/${p.id}/monitoring`,{providers}),402);
 await f.push(p.workspaceId,'advanced',3);assert.equal((await f.call('PUT',`/v1/projects/${p.id}/monitoring`,{providers})).data.providers.length,6);
 await f.push(p.workspaceId,'starter',4);await denied(selectedRoutes(f.db,p.id,f.env),402);
 assert.equal((await f.call('GET',`/v1/projects/${p.id}/measurement-settings`)).data.providers.length,6); // Preserve the user's choice; require explicit correction.
}));

test('downgrades preserve data but stop new runs until excess brands/prompts/models are resolved',withFixture(async f=>{
 const p=await f.create();await f.create();await f.push(p.workspaceId,'starter');await f.add(p.id);
 await denied(run(f,p.id,'over-brand-limit-submission'),402);
 const all=(await f.call('GET','/v1/projects')).data;assert.equal(all.length,2);
 for(const q of all.filter(q=>q.id!==p.id))await f.call('POST',`/v1/projects/${q.id}/archive`,{expectedVersion:1});
 f.seed(p.id,60);await denied(run(f,p.id,'over-prompt-limit-submission'),402);
 const seeded=p.id+'-prompt-0',data=JSON.parse(f.sql.prepare('SELECT payload FROM mon_prompt_versions WHERE prompt_id=?').get(seeded).payload);
 await f.call('PATCH',`/v1/projects/${p.id}/prompts/${seeded}`,{...data,status:'archived',expectedVersion:1});
 assert.equal((await run(f,p.id,'corrected-limit-submission')).status,202);
}));

test('Starter enforces a rolling seven-day interval on scheduled and immediate checks',withFixture(async f=>{
 const p=await f.create();await f.push(p.workspaceId,'starter');await f.add(p.id);
 const first=await run(f,p.id,'starter-first-submission');assert.equal(first.status,202);
 f.advance(WEEK_MS-1);await denied(run(f,p.id,'starter-too-early-submission'),402);
 await f.add(p.id,'Which design software suits small businesses?');
 await denied(f.call('POST',`/v1/projects/${p.id}/monitoring-runs`,{kind:'neutral',submissionId:'starter-immediate-too-early'}),402);
 await tickImmediate(f.db,{env:f.env,now:f.now});assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_runs').get().n,1);
 f.advance(1);assert.equal((await run(f,p.id,'starter-next-week-submission')).status,202);
}));

test('Pro runs daily and weekly scheduler skips early slots without blocking other workspaces',withFixture(async f=>{
 const p=await f.create(),q=await f.create('bob');await f.push(p.workspaceId,'starter');await f.push(q.workspaceId,'pro');await f.add(p.id);await f.add(q.id,undefined,'bob');
 await run(f,p.id,'starter-original-submission');
 await monitoringService({db:f.db,method:'POST',path:`/v1/projects/${q.id}/monitoring-runs`,body:{kind:'neutral',submissionId:'pro-original-submission'},userId:'bob',env:f.env,now:f.now});
 f.advance(86400000);
 for(const [project,user] of [[p,'alice'],[q,'bob']]){
  await scheduleService({db:f.db,method:'GET',path:`/v1/projects/${project.id}/schedule`,userId:user,env:f.env,now:f.now});f.sql.prepare('UPDATE app_project_schedules SET next_at=? WHERE project_id=?').run(f.now(),project.id);
 }
 await tickProjects(f.db,{env:f.env,now:f.now});
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_runs WHERE project_id=?').get(p.id).n,1);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_runs WHERE project_id=?').get(q.id).n,2);
 assert.equal(f.sql.prepare('SELECT reason FROM app_schedule_slots WHERE project_id=?').get(p.id).reason,'PLAN_FREQUENCY');
 const settings=(await scheduleService({db:f.db,method:'GET',path:`/v1/projects/${p.id}/schedule`,userId:'alice',env:f.env,now:f.now})).data;assert.equal(settings.frequency,'weekly');assert.ok(settings.nextAt>=f.now()+6*86400000);
}));

test('worker rechecks downgrade and trial expiration before spending on queued model tasks',withFixture(async f=>{
 const p=await f.create();await f.add(p.id);const queued=await run(f,p.id,'pro-queued-submission');assert.equal(queued.data.routes.length,5);
 await f.push(p.workspaceId,'starter');let calls=0;
 const worker=createMonitoringEngine({db:f.db,env:f.env,now:f.now,available:()=>true,call:async()=>{calls++;throw Error('must not spend');},logger:()=>{}});
 await worker.tick();assert.equal(calls,0);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_budget').get().n,0);assert.equal(f.sql.prepare('SELECT reason FROM mon_runs WHERE id=?').get(queued.data.id).reason,'PLAN_LIMIT');
 const q=await f.create('bob');f.advance(TRIAL_MS-60000);await f.add(q.id,undefined,'bob');
 await monitoringService({db:f.db,method:'POST',path:`/v1/projects/${q.id}/monitoring-runs`,body:{kind:'neutral',submissionId:'expiring-trial-queued-job'},userId:'bob',env:f.env,now:f.now});
 f.advance(60001);await worker.tick();assert.equal(calls,0);
 assert.ok(f.sql.prepare("SELECT payload FROM mon_evidence WHERE run_id IN (SELECT id FROM mon_runs WHERE project_id=?)").all(q.id).every(r=>JSON.parse(r.payload).status==='plan_blocked'));
}));

test('expired content access cannot launch jobs even when called outside the application router',withFixture(async f=>{
 const p=await f.create();f.sql.prepare('UPDATE app_workspaces SET trial_ends_at=? WHERE id=?').run(Date.now()-1,p.workspaceId);
 await denied(access(f.db,p.id,'alice','edit'),402);assert.equal((await access(f.db,p.id,'alice','read')).id,p.id);
}));

test('billing update and audit roll back together, and upgrades reset the next schedule safely',withFixture(async f=>{
 const p=await f.create();await f.push(p.workspaceId,'starter');await f.add(p.id);await run(f,p.id,'weekly-setup-submission');
 await scheduleService({db:f.db,method:'GET',path:`/v1/projects/${p.id}/schedule`,userId:'alice',env:f.env,now:f.now});
 const previous=f.sql.prepare('SELECT next_at FROM app_project_schedules WHERE project_id=?').get(p.id).next_at;assert.ok(previous>f.now()+6*86400000);
 f.sql.exec("CREATE TRIGGER fail_plan_audit BEFORE INSERT ON app_plan_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
 await assert.rejects(f.push(p.workspaceId,'pro',2),/audit unavailable/);assert.equal((await projectPlan(f.db,p.id)).plan,'starter');assert.equal(f.sql.prepare('SELECT next_at FROM app_project_schedules WHERE project_id=?').get(p.id).next_at,previous);
 f.sql.exec('DROP TRIGGER fail_plan_audit');await f.push(p.workspaceId,'pro',2);
 const next=(await scheduleService({db:f.db,method:'GET',path:`/v1/projects/${p.id}/schedule`,userId:'alice',env:f.env,now:f.now})).data.nextAt;assert.ok(next<f.now()+2*86400000);
}));

test('automatic Pro trial grants 175 prompts, three brands and five models without a billing push',withFixture(async f=>{
 const p=await f.create();await f.create();await f.create();await denied(f.create(),402);
 f.seed(p.id,174);await f.add(p.id);await denied(f.add(p.id,'Which analytics tools suit businesses?'),402);
 assert.equal((await f.call('GET',`/v1/projects/${p.id}/monitoring`)).data.providers.length,5);
}));

test('downgrade cannot execute an oversized frozen prompt snapshot even after active prompts are archived',withFixture(async f=>{
 const p=await f.create();await f.push(p.workspaceId,'pro');f.seed(p.id,61);
 await f.call('PUT',`/v1/projects/${p.id}/monitoring`,{providers:['openai']});
 await run(f,p.id,'frozen-prompt-cap-submission');
 f.sql.prepare("UPDATE mon_prompts SET status='archived' WHERE id=?").run(p.id+'-prompt-0');
 await f.push(p.workspaceId,'starter',2);
 let calls=0;await createMonitoringEngine({db:f.db,env:f.env,now:f.now,available:()=>true,call:async()=>{calls++;},logger:()=>{}}).tick();assert.equal(calls,0);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_budget').get().n,0);
}));

test('billing endpoint fails closed without a configured shared secret',withFixture(async f=>{
 const p=await f.create(),service=createAppService({db:f.db,clients:{},env:{},now:f.now});
 await denied(service({method:'POST',path:`/v1/internal/workspaces/${p.workspaceId}/plan`,headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:{plan:'custom',status:'active',revision:1}}),503,'BILLING_NOT_CONFIGURED');
 assert.equal((await projectPlan(f.db,p.id)).status,'trialing');
}));

test('content automation does not enqueue after trial expiry and resumes after activation',withFixture(async f=>{
 const p=await f.create();
 f.sql.prepare('INSERT INTO content_records VALUES(?,?,?,?,?,?)').run(p.id,'settings','automation',1,JSON.stringify({enabled:true,nextRunAt:f.now(),refreshHours:24,locale:'en'}),f.now());
 f.advance(TRIAL_MS);await scheduleContent(f.db,f.now());assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM content_jobs').get().n,0);
 await f.push(p.workspaceId,'pro');await scheduleContent(f.db,f.now());assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM content_jobs').get().n,1);
}));

test('weekly neutral and diagnostic sets both run once per seven days without starving either kind',withFixture(async f=>{
 const p=await f.create();await f.push(p.workspaceId,'starter');await f.add(p.id);
 await f.call('POST',`/v1/projects/${p.id}/prompts`,{...prompt('How does Example compare with other marketing software?'),kind:'diagnostic'});
 await scheduleService({db:f.db,method:'GET',path:`/v1/projects/${p.id}/schedule`,userId:'alice',env:f.env,now:f.now});
 f.sql.prepare('UPDATE app_project_schedules SET next_at=? WHERE project_id=?').run(f.now(),p.id);
 await tickProjects(f.db,{env:f.env,now:f.now});assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_runs WHERE project_id=?').get(p.id).n,2);
 f.advance(86400000);f.sql.prepare('UPDATE app_project_schedules SET next_at=? WHERE project_id=?').run(f.now(),p.id);
 await tickProjects(f.db,{env:f.env,now:f.now});assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_runs WHERE project_id=?').get(p.id).n,2);
 f.advance(6*86400000);f.sql.prepare('UPDATE app_project_schedules SET next_at=? WHERE project_id=?').run(f.now(),p.id);
 await tickProjects(f.db,{env:f.env,now:f.now});assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_runs WHERE project_id=?').get(p.id).n,4);
}));

test('weekly reservations serialize concurrent checks and tolerate a backwards application clock',withFixture(async f=>{
 const p=await f.create();await f.push(p.workspaceId,'starter');await f.add(p.id);
 const results=await Promise.allSettled([run(f,p.id,'weekly-concurrent-submission-one'),run(f,p.id,'weekly-concurrent-submission-two')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'PLAN_LIMIT');
 f.advance(-100);await denied(run(f,p.id,'weekly-skewed-clock-submission'),402);
}));
