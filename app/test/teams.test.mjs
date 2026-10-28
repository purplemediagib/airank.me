import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {migrations} from '../src/migrate.mjs';
import {migrateTeams,checksum} from '../src/app/team-migration.mjs';
import {createAppService,csrfFor} from '../src/app/service.mjs';
import {hashToken} from '../src/common/utils.mjs';
import {projectRole,scanReadAllowed} from '../src/common/access.mjs';
import {fixtureBudgetConfig} from './api-budget-fixture.mjs';
import {apiObservation} from '../src/common/observations.mjs';
const origin='https://preview.example.test';
const identity={brandName:'Acme',aliases:[],ownedDomains:['acme.com'],categoryFi:'marketing software',market:'US',promptLanguage:'en'};
async function fixture(){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');for(const s of migrations)sql.exec(s);
 const execute=async q=>{const s=sql.prepare(q.sql||q),args=q.args||[];if(s.columns().length)return {rows:s.all(...args)};return {rows:[],rowsAffected:Number(s.run(...args).changes)};};
 const db={execute,transaction:async()=>{sql.exec('BEGIN IMMEDIATE');return {execute,commit:async()=>sql.exec('COMMIT'),rollback:async()=>sql.exec('ROLLBACK'),close(){}};}};
 const startup=readFileSync(new URL('../src/app/start-release.mjs',import.meta.url),'utf8'),imported=new Map();
 for(const m of startup.matchAll(/const \{(migrate\w+)\}=await import\('([^']+)'\)/g))imported.set(m[1],m[2]);
 for(const m of startup.matchAll(/await (migrate\w+)\(db\)/g))if(!['migrateTeams','migratePlans'].includes(m[1])){const mod=await import(new URL(imported.get(m[1]),new URL('../src/app/start-release.mjs',import.meta.url)));await mod[m[1]](db);}
 let clock=Date.parse('2026-10-28T12:00:00Z');
 for(const u of ['owner','admin','admin2','member','viewer','guest','guestadmin','outsider','otherowner','invitee','legacy']){
  sql.prepare('INSERT INTO users(id,google_sub,email,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(u,u,u+'@example.test',u,clock,clock);
  sql.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hashToken('session-'+u),u,clock+30*86400000,clock);
 }
 for(const [p,o] of [['brand-one','owner'],['brand-two','owner'],['foreign','otherowner']]){
  sql.prepare('INSERT INTO app_projects VALUES(?,?,?,?,?)').run(p,o,'active',1,new Date(clock).toISOString());
  sql.prepare('INSERT INTO app_identity_versions VALUES(?,?,?,?)').run(p,1,JSON.stringify({...identity,brandName:p}),new Date(clock).toISOString());
 }
 sql.prepare('INSERT INTO content_members VALUES(?,?,?)').run('brand-one','legacy','reviewer');
 await migrateTeams(db);
 const member=(u,r)=>sql.prepare('INSERT INTO app_workspace_members VALUES(?,?,?,?)').run('ws_owner',u,r,clock);
 for(const u of ['admin','admin2','member','viewer'])member(u,u.startsWith('admin')?'admin':u);
 const guest=(u,r,p='brand-one')=>sql.prepare('INSERT INTO app_project_guests VALUES(?,?,?,?)').run(p,u,r,clock);
 guest('guest','viewer');guest('guestadmin','admin');
 const prompt={text:'Which tools help small businesses with marketing?',kind:'neutral',topic:'Tools',tags:[],market:'US',language:'en',status:'active'};
 sql.prepare('INSERT INTO mon_prompts VALUES(?,?,?,?,?,?)').run('prompt','brand-one',1,'active','fixture-hash',clock);
 sql.prepare('INSERT INTO mon_prompt_versions VALUES(?,?,?,?)').run('prompt',1,JSON.stringify(prompt),clock);
 const snapshot={identity,identityVersion:1,kind:'neutral',market:'US',language:'en',collectionMethod:'api-complete-answer-v2',methodology:'tracked-api-complete-answer-v2',prompts:[{...prompt,id:'prompt',version:1}],routes:[{provider:'openai',transport:'direct',model:'fixture'}]};
 sql.prepare('INSERT INTO mon_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('historic','brand-one','owner','old-submission','old-request','neutral','complete',JSON.stringify(snapshot),1,clock-86400000,clock-86000000,null);
 sql.prepare('INSERT INTO mon_tasks VALUES(?,?,?,?,?,?,?,?,?,?)').run('task','historic','prompt',1,prompt.text,'openai','{}','done',null,null);
 sql.prepare('INSERT INTO mon_evidence VALUES(?,?,?,?)').run('task','historic',JSON.stringify({id:'task',runId:'historic',promptId:'prompt',promptVersion:1,text:prompt.text,provider:'openai',model:'fixture',status:'success',answer:'Acme provides marketing tools.',citations:[],observation:apiObservation({complete:true}),observedAt:clock-86400000}),clock-86400000);
 const env={TRACKED_PROMPT_LIMIT:'55',MONITORING_ENABLED:'true',ENABLED_PROVIDERS:'openai',OPENAI_API_KEY:'offline-fixture',SENTIMENT_ENABLED:'true'};env.API_BUDGET_CONFIG_JSON=fixtureBudgetConfig(env);
 const service=createAppService({db,clients:{preview:{origin,redirectUri:origin+'/api/airank/v1/app/google/callback'}},env,now:()=>clock,sendMail:()=>assert.fail('Bunny must not send team email')});
 const call=(u,method,path,body={})=>service({method,path,body,headers:{'x-airank-client':'preview',cookie:'__Host-airank_session=session-'+u,origin,'content-type':'application/json','x-csrf-token':csrfFor('session-'+u)}});
 const team=(u,method,suffix='',body={})=>call(u,method,'/v1/projects/brand-one/team'+suffix,body);
 const machine=(token,path)=>service({method:'GET',path,headers:{'x-airank-client':'preview',authorization:'Bearer '+token}});
 const invite=async(body={},u='owner')=>(await team(u,'POST','/invites',{email:'invitee@example.test',role:'member',scope:'workspace',...body})).data;
 return {sql,db,call,team,machine,invite,member,guest,prompt,now:()=>clock,advance:n=>clock+=n,close:()=>sql.close()};
}
const denied=(p,status,code)=>assert.rejects(p,e=>e.status===status&&(!code||e.code===code));
const withFixture=fn=>async()=>{const f=await fixture();try{await fn(f);}finally{f.close();}};

test('team migration backfills owners/content guests, preserves old checksums and repeats safely',withFixture(async f=>{
 const before=f.sql.prepare('SELECT * FROM app_migrations').all();await migrateTeams(f.db);assert.deepEqual(f.sql.prepare('SELECT * FROM app_migrations').all(),before);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM app_workspaces').get().n,2);
 assert.equal(f.sql.prepare('SELECT workspace_id FROM app_projects WHERE id=?').get('brand-one').workspace_id,'ws_owner');
 assert.equal(await projectRole(f.db,'brand-one','legacy'),'member');assert.equal(await projectRole(f.db,'brand-two','legacy'),null);
 assert.equal(f.sql.prepare('SELECT checksum FROM app_migrations WHERE id=?').get('app-021-teams').checksum,checksum);
}));

test('project lists/details include roles; guests cannot read other brands, even via content/scans/results',withFixture(async f=>{
 const list=(await f.call('guest','GET','/v1/projects')).data;assert.deepEqual(list.map(p=>p.id),['brand-one']);assert.equal(list[0].myRole,'viewer');assert.equal(list[0].workspaceId,'ws_owner');assert.equal(list[0].ownerName,'owner');
 assert.equal((await f.call('member','GET','/v1/projects/brand-two')).data.myRole,'member');
 assert.equal((await f.call('member','GET','/v1/projects')).data.length,2);
 for(const suffix of ['','/analytics','/results','/monitoring-runs','/research','/reports','/scans','/content','/team'])await denied(f.call('guest','GET','/v1/projects/brand-two'+suffix),404,'NOT_FOUND');
 assert.deepEqual((await f.call('legacy','GET','/v1/app/content-projects')).data.map(p=>p.id),['brand-one']);
 f.guest('viewer','admin');assert.equal(await projectRole(f.db,'brand-one','viewer'),'admin');assert.equal(await projectRole(f.db,'brand-two','viewer'),'viewer');
}));

test('viewer reads analytics and downloads, member edits prompts but cannot change settings',withFixture(async f=>{
 const a=(await f.call('viewer','GET','/v1/projects/brand-one/analytics')).data;assert.equal(a.evidence.length,1);
 assert.equal((await f.call('viewer','GET','/v1/projects/brand-one/results')).data.total,1);
 const patch={...f.prompt,expectedVersion:1,tags:['updated']};
 await denied(f.call('viewer','PATCH','/v1/projects/brand-one/prompts/prompt',patch),403,'ROLE_FORBIDDEN');
 assert.equal((await f.call('member','PATCH','/v1/projects/brand-one/prompts/prompt',patch)).data.version,2);
 for(const [method,path,body] of [['PATCH','measurement-settings',{providers:['openai'],expectedVersion:0}],['PATCH','schedule',{}],['PATCH','',{}],['POST','archive',{expectedVersion:1}],['POST','reports',{}],['POST','connections/ga4/connect',{}]])await denied(f.call('member',method,'/v1/projects/brand-one'+(path?'/'+path:''),body),403,'ROLE_FORBIDDEN');
 for(const [method,path] of [['POST','research'],['POST','suggestions'],['POST','intelligence'],['POST','sentiment-backfill'],['POST','opportunities'],['POST','content/documents']])await denied(f.call('viewer',method,'/v1/projects/brand-one/'+path),403,'ROLE_FORBIDDEN');
 assert.equal((await f.call('admin','PATCH','/v1/projects/brand-one/measurement-settings',{providers:['openai'],expectedVersion:0})).status,200);
 assert.equal((await f.call('member','GET','/v1/projects/brand-one/content')).data.role,'editor');
 const doc=(await f.call('member','POST','/v1/projects/brand-one/content/documents',{title:'Example',markdown:'A reviewed document.',locale:'en'})).data;
 assert.equal((await f.call('viewer','GET',`/v1/projects/brand-one/content/documents/${doc.id}/export`)).status,200);
 await denied(f.call('admin','PUT','/v1/projects/brand-one/content/access',{expectedVersion:0,role:'editor',email:'outsider@example.test'}),410,'USE_TEAM_INVITES');
}));

test('member checks retain owner budget attribution and initiating actor',withFixture(async f=>{
 await f.call('member','POST','/v1/projects/brand-one/prompts',{text:'Which email tools suit small businesses?',kind:'neutral',topic:'Email',tags:[]});
 const r=await f.call('member','POST','/v1/projects/brand-one/monitoring-runs',{kind:'neutral',submissionId:'team-check-submission-001'});assert.equal(r.status,202);
 const run=f.sql.prepare('SELECT * FROM mon_runs WHERE id=?').get(r.data.id);assert.equal(run.owner_id,'owner');assert.equal(JSON.parse(run.snapshot).actorId,'member');
 await denied(f.call('viewer','POST','/v1/projects/brand-one/monitoring-runs',{kind:'neutral',submissionId:'team-check-submission-002'}),403,'ROLE_FORBIDDEN');
}));

test('owner/admin target rules and guest admin boundaries prevent escalation',withFixture(async f=>{
 for(const target of ['owner','admin2'])for(const method of ['PATCH','DELETE'])await denied(f.team('admin',method,'/members/'+target,method==='PATCH'?{role:'viewer'}:{}),403,'ROLE_FORBIDDEN');
 await denied(f.team('guestadmin','POST','/invites',{email:'outsider@example.test',role:'admin',scope:'workspace'}),403,'ROLE_FORBIDDEN');
 await denied(f.team('guestadmin','POST','/invites',{email:'outsider@example.test',role:'admin',scope:'project',projectIds:['brand-two']}),404,'NOT_FOUND');
 await denied(f.team('admin','POST','/invites',{email:'outsider@example.test',role:'admin',scope:'project',projectIds:['foreign']}),422,'INVALID_PROJECTS');
 await denied(f.team('guestadmin','DELETE','/members/member'),403,'ROLE_FORBIDDEN');
 assert.equal((await f.team('owner','PATCH','/members/admin2',{role:'member'})).status,200);
 assert.equal((await f.invite({role:'admin'},'admin')).invite.role,'admin');
 assert.equal((await f.team('viewer','GET')).data.invites.length,0);
 const guestView=(await f.team('guest','GET')).data;assert.ok(!JSON.stringify(guestView).includes('brand-two'));
}));

test('invites are hashed, email bound, expiring and single use with upgrade-only grants',withFixture(async f=>{
 const i=await f.invite();assert.match(i.token,/^airank_inv_[A-Za-z0-9_-]{43}$/);
 const row=f.sql.prepare('SELECT * FROM app_invites WHERE id=?').get(i.invite.id);assert.equal(row.token_hash,hashToken(i.token));assert.equal(row.expires_at-row.created_at,7*86400000);
 const stored=JSON.stringify(f.sql.prepare('SELECT * FROM app_invites').all())+JSON.stringify(f.sql.prepare('SELECT * FROM app_team_audit').all());assert.ok(!stored.includes(i.token));
 const url='/v1/app/invites/'+i.token;
 assert.equal((await f.call('invitee','GET',url)).data.expired,false);
 await denied(f.call('outsider','POST',url+'/accept'),403,'INVITE_EMAIL_MISMATCH');
 f.sql.prepare('UPDATE users SET email=? WHERE id=?').run('INVITEE@EXAMPLE.TEST','invitee');
 f.member('invitee','admin'); // An older lower-role invite must never downgrade an intervening grant.
 assert.equal((await f.call('invitee','POST',url+'/accept')).data.projectId,'brand-one');assert.equal(await projectRole(f.db,'brand-two','invitee'),'admin');
 await denied(f.call('invitee','POST',url+'/accept'),404,'NOT_FOUND');await denied(f.call('invitee','GET',url),404,'NOT_FOUND');
 const expired=await f.invite({email:'outsider@example.test'});f.advance(7*86400000);
 assert.equal((await f.call('outsider','GET','/v1/app/invites/'+expired.token)).data.expired,true);
 await denied(f.call('outsider','POST','/v1/app/invites/'+expired.token+'/accept'),410,'INVITE_EXPIRED');
}));

test('resend rotates tokens, revoke disables lookup, limits include resends and audit excludes secrets',withFixture(async f=>{
 const i=await f.invite(),rotated=(await f.team('admin','POST',`/invites/${i.invite.id}/resend`)).data;
 assert.notEqual(i.token,rotated.token);await denied(f.call('invitee','GET','/v1/app/invites/'+i.token),404);
 await f.team('admin','POST',`/invites/${i.invite.id}/revoke`);await denied(f.call('invitee','GET','/v1/app/invites/'+rotated.token),404);
 const next=await f.invite();for(let n=3;n<50;n++)await f.team('owner','POST',`/invites/${next.invite.id}/resend`);
 await denied(f.team('owner','POST',`/invites/${next.invite.id}/resend`),429,'INVITE_RATE_LIMIT');
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM app_team_audit WHERE kind='team.invited'").get().n,50);
}));

test('project invite grants only selected brands and a removed inviter cannot leave active grants',withFixture(async f=>{
 const i=await f.invite({scope:'project',projectIds:['brand-one'],role:'member'},'guestadmin');
 await f.call('invitee','POST','/v1/app/invites/'+i.token+'/accept');
 assert.equal(await projectRole(f.db,'brand-one','invitee'),'member');assert.equal(await projectRole(f.db,'brand-two','invitee'),null);
 await denied(f.invite({scope:'project',projectIds:['brand-one'],role:'member'}),409,'ALREADY_MEMBER');
 const pending=await f.invite({email:'outsider@example.test',scope:'project',projectIds:['brand-one']},'guestadmin');
 await f.team('owner','DELETE','/members/guestadmin');await denied(f.call('outsider','POST','/v1/app/invites/'+pending.token+'/accept'),404);
}));

test('removal revokes report access per project without breaking other workspaces or reviving on rejoin',withFixture(async f=>{
 await denied(f.call('viewer','POST','/v1/app/report-tokens'),403,'ROLE_FORBIDDEN');
 const token=(await f.call('admin','POST','/v1/app/report-tokens')).data.token;
 f.sql.prepare('INSERT INTO app_workspace_members VALUES(?,?,?,?)').run('ws_otherowner','admin','viewer',f.now());
 assert.equal((await f.machine(token,'/v1/projects/brand-one/analytics')).data.evidence.length,1);
 await f.team('owner','DELETE','/members/admin');await denied(f.machine(token,'/v1/projects/brand-one/analytics'),403,'SCOPE_DENIED');
 assert.deepEqual((await f.machine(token,'/v1/projects')).data.map(p=>p.id),['foreign']);assert.equal((await f.machine(token,'/v1/projects/foreign')).status,200);
 f.member('admin','admin');await denied(f.machine(token,'/v1/projects/brand-one'),403,'SCOPE_DENIED');
 const renewed=(await f.call('admin','POST','/v1/app/report-tokens')).data.token;assert.equal((await f.machine(renewed,'/v1/projects/brand-one')).status,200);
}));

test('ownership transfer is atomic, retains historical reads, and the old owner can create a new workspace',withFixture(async f=>{
 await denied(f.team('admin','POST','/transfer',{userId:'admin2'}),403,'ROLE_FORBIDDEN');
 await f.team('owner','POST','/transfer',{userId:'admin'});
 assert.equal(await projectRole(f.db,'brand-one','admin'),'owner');assert.equal(await projectRole(f.db,'brand-two','owner'),'admin');
 assert.deepEqual(f.sql.prepare('SELECT DISTINCT owner_id FROM app_projects WHERE workspace_id=?').all('ws_owner').map(r=>r.owner_id),['admin']);
 assert.equal((await f.call('admin','GET','/v1/projects/brand-one/analytics')).data.evidence.length,1);
 assert.equal((await f.call('admin','GET','/v1/projects/brand-one/monitoring-runs/historic')).data.evidence.length,1);
 const p=(await f.call('owner','POST','/v1/projects',identity)).data;assert.equal(p.myRole,'owner');assert.notEqual(p.workspaceId,'ws_owner');
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM app_projects WHERE workspace_id=?').get('ws_owner').n,2);
 f.sql.prepare("INSERT INTO app_workspace_members VALUES('ws_owner','otherowner','admin',?)").run(f.now());
 await denied(f.team('admin','POST','/transfer',{userId:'otherowner'}),409,'TARGET_ALREADY_WORKSPACE_OWNER');
 assert.equal(await projectRole(f.db,'brand-one','admin'),'owner');
}));

test('team writes enforce browser CSRF and bearer credentials never gain team privileges',withFixture(async f=>{
 const token=(await f.call('owner','POST','/v1/app/report-tokens')).data.token;
 await denied(f.machine(token,'/v1/projects/brand-one/team'),403,'SCOPE_DENIED');
 const service=createAppService({db:f.db,clients:{preview:{origin,redirectUri:origin+'/api/airank/v1/app/google/callback'}},env:{},now:f.now});
 const request={method:'POST',path:'/v1/projects/brand-one/team/invites',body:{email:'outsider@example.test',role:'member',scope:'workspace'},headers:{'x-airank-client':'preview',cookie:'__Host-airank_session=session-owner',origin,'content-type':'application/json'}};
 await denied(service(request),403,'CSRF_INVALID');
 await denied(service({...request,headers:{...request.headers,'x-csrf-token':csrfFor('session-owner'),origin:'https://evil.test'}}),403,'CSRF_INVALID');
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM app_invites').get().n,0);
}));

test('transfer and invitation acceptance roll back their grants when audit persistence fails',withFixture(async f=>{
 const invite=await f.invite();
 f.sql.exec("CREATE TRIGGER fail_team_audit BEFORE INSERT ON app_team_audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
 await assert.rejects(f.call('invitee','POST','/v1/app/invites/'+invite.token+'/accept'),/audit unavailable/);
 assert.equal(await projectRole(f.db,'brand-one','invitee'),null);assert.equal(f.sql.prepare('SELECT accepted_at FROM app_invites WHERE id=?').get(invite.invite.id).accepted_at,null);
 await assert.rejects(f.team('owner','POST','/transfer',{userId:'admin'}),/audit unavailable/);
 assert.equal(await projectRole(f.db,'brand-one','owner'),'owner');assert.equal(await projectRole(f.db,'brand-two','admin'),'admin');
}));

test('removed legacy content guests cannot regain access through the old content table',withFixture(async f=>{
 await f.team('owner','DELETE','/members/legacy');
 f.sql.prepare('INSERT INTO content_members VALUES(?,?,?)').run('brand-one','legacy','reviewer');
 await denied(f.call('legacy','GET','/v1/projects/brand-one/content'),404,'NOT_FOUND');
 assert.deepEqual((await f.call('legacy','GET','/v1/app/content-projects')).data,[]);
}));

test('shared stored reports remain readable after transfer and unrelated project report IDs stay hidden',withFixture(async f=>{
 const report=(await f.call('admin','POST','/v1/projects/brand-one/reports',{locale:'en',filters:{}})).data;
 assert.equal((await f.call('viewer','GET','/v1/projects/brand-one/reports/'+report.id)).status,200);
 await f.team('owner','POST','/transfer',{userId:'admin'});
 assert.equal((await f.call('admin','GET','/v1/projects/brand-one/reports/'+report.id)).data.snapshot.runSnapshots.length,1);
 await denied(f.call('otherowner','GET','/v1/projects/foreign/reports/'+report.id),404,'NOT_FOUND');
}));

test('legacy scan URLs use current team access while standalone guest scans keep their token',withFixture(async f=>{
 const job={id:'scan',owner_id:'owner',guest_token_hash:hashToken('public-token')};
 f.sql.prepare('INSERT INTO scan_jobs(id,domain,brand_name,owner_id,status,requested_at) VALUES(?,?,?,?,?,?)').run(job.id,'acme.com','Acme','owner','done',f.now());
 f.sql.prepare('INSERT INTO app_project_scans VALUES(?,?,?,?,?,?,?)').run(job.id,'brand-one',1,'owner','legacy-submission','hash',f.now());
 assert.equal(await scanReadAllowed(f.db,job,'viewer'),true);
 assert.equal(await scanReadAllowed(f.db,job,'outsider','public-token'),false);
 await f.team('owner','POST','/transfer',{userId:'admin'});await f.team('admin','DELETE','/members/owner');
 assert.equal(await scanReadAllowed(f.db,job,'owner'),false);
 assert.equal(await scanReadAllowed(f.db,{...job,id:'unlinked'},null,'public-token'),true);
 assert.equal(await scanReadAllowed(f.db,{...job,id:'unlinked'},'outsider','wrong-token'),false);
}));
