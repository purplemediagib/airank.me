import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrations} from '../src/migrate.mjs';
import {migrateApp} from '../src/app/migration.mjs';
import {migrateProjectScans} from '../src/app/scan-migration.mjs';
import {migrateMonitoring} from '../src/monitoring/migration.mjs';
import {migrateReportTokens,id as migrationId,checksum} from '../src/app/report-token-migration.mjs';
import {createAppService,csrfFor} from '../src/app/service.mjs';
import {hashToken} from '../src/common/utils.mjs';
import {apiObservation,collectionMethodVersion} from '../src/common/observations.mjs';

const origin='https://preview.example.com';
const clients={preview:{origin,redirectUri:origin+'/api/airank/v1/app/google/callback'}};
async function fixture({migrate=true,env={}}={}){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 for(const sql of migrations)sqlite.exec(sql);
 let clock=Date.parse('2026-10-27T12:00:00Z');const writes=[];
 const execute=async q=>{
  const sql=typeof q==='string'?q:q.sql,args=typeof q==='string'?[]:q.args||[],stmt=sqlite.prepare(sql);
  if(/^\s*(SELECT|PRAGMA)|RETURNING/i.test(sql))return {rows:stmt.all(...args)};
  const r=stmt.run(...args);if(r.changes)writes.push(sql);return {rows:[],rowsAffected:Number(r.changes)};
 };
 const db={execute,transaction:async()=>{
  sqlite.exec('BEGIN IMMEDIATE');return {execute,commit:async()=>sqlite.exec('COMMIT'),rollback:async()=>sqlite.exec('ROLLBACK'),close:()=>{}};
 }};
 for(const user of ['alice','bob']){
  sqlite.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(user,user,user+'@example.test',user,'',clock,clock);
  sqlite.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hashToken('session-'+user),user,clock+3600000,clock);
 }
 await migrateApp(db);await migrateProjectScans(db);await migrateMonitoring(db);if(migrate)await migrateReportTokens(db);
 for(const user of ['alice','bob']){
  const project='project-'+user,prompt='prompt-'+user,run='run-'+user,task='task-'+user;
  const identity={brandName:user,aliases:[],ownedDomains:[user+'.com'],categoryFi:'marketing software',market:'US',promptLanguage:'en'};
  sqlite.prepare('INSERT INTO app_projects VALUES (?,?,?,?,?)').run(project,user,'active',1,new Date(clock).toISOString());
  sqlite.prepare('INSERT INTO app_identity_versions VALUES (?,?,?,?)').run(project,1,JSON.stringify(identity),new Date(clock).toISOString());
  const snapshot={identity,identityVersion:1,kind:'neutral',market:'US',language:'en',collectionMethod:collectionMethodVersion,methodology:'tracked-api-complete-answer-v2',prompts:[{id:prompt,version:1,text:'Which marketing tools?',topic:'Tools',tags:[]}],routes:[{provider:'openai',transport:'direct',model:'fixture'}]};
  sqlite.prepare('INSERT INTO mon_prompts VALUES (?,?,?,?,?,?)').run(prompt,project,1,'active','hash',clock);
  sqlite.prepare('INSERT INTO mon_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(run,project,user,run,run,'neutral','complete',JSON.stringify(snapshot),1,clock,clock+60000,null);
  sqlite.prepare('INSERT INTO mon_tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run(task,run,prompt,1,'Which marketing tools?','openai','{}','done',null,null);
  sqlite.prepare('INSERT INTO mon_evidence VALUES (?,?,?,?)').run(task,run,JSON.stringify({id:task,runId:run,promptId:prompt,promptVersion:1,text:'Which marketing tools?',provider:'openai',model:'fixture',status:'success',answer:user+' provides tools.',citations:[{url:'https://'+user+'.com/'}],observation:apiObservation({complete:true}),observedAt:clock}),clock);
 }
 const service=createAppService({db,clients,env,now:()=>clock,sendMail:()=>assert.fail('report credential must not send mail')});
 const call=(method,path,body={},user='alice',headers={},query=new URLSearchParams())=>service({method,path,body,query,headers:{'x-airank-client':'preview',origin,'content-type':'application/json',cookie:'__Host-airank_session=session-'+user,'x-csrf-token':csrfFor('session-'+user),...headers}});
 const machine=(token,method,path,body={},headers={},query=new URLSearchParams())=>service({method,path,body,query,headers:{'x-airank-client':'preview',authorization:'Bearer '+token,...headers}});
 const mint=async(user='alice',body={label:'Weekly report'})=>(await call('POST','/v1/app/report-tokens',body,user)).data;
 return {sqlite,db,writes,call,machine,mint,now:()=>clock,advance:ms=>clock+=ms,close:()=>sqlite.close()};
}
const denied=(request,status,code)=>assert.rejects(request,e=>e.status===status&&e.code===code);

test('report tokens are random, hashed at rest and shown only on creation; lists are owner-scoped',async()=>{
 const f=await fixture();try{
  const a=await f.mint(),b=await f.mint(),c=await f.mint('bob');
  assert.match(a.token,/^airank_rt_[A-Za-z0-9_-]{43}$/);assert.notEqual(a.token,b.token);
  const row=f.sqlite.prepare('SELECT * FROM app_report_tokens WHERE id=?').get(a.id);
  assert.equal(row.token_hash,hashToken(a.token));assert.equal(row.user_id,'alice');assert.equal(row.last_used_at,null);
  assert.equal(row.expires_at,f.now()+180*86400000);assert.equal(Date.parse(a.expiresAt),row.expires_at);
  const list=(await f.call('GET','/v1/app/report-tokens')).data;
  assert.equal(list.length,2);assert.ok(list.every(x=>!('token' in x)&&!('token_hash' in x)&&!('user_id' in x)));
  assert.ok(!JSON.stringify(list).includes(c.id));
  const stored=JSON.stringify(f.sqlite.prepare('SELECT * FROM app_report_tokens').all())+JSON.stringify(f.sqlite.prepare('SELECT * FROM app_audit_events').all());
  assert.ok(!stored.includes(a.token));assert.ok(!stored.includes(b.token));assert.ok(!stored.includes(c.token));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM app_audit_events WHERE kind='report_token.created'").get().n,3);
 }finally{f.close();}
});

test('bearer reads match cookie report data, preserve filters and never read another owner',async()=>{
 const f=await fixture();try{
  const {token}=await f.mint();
  for(const path of ['/v1/projects','/v1/projects/project-alice','/v1/projects/project-alice/analytics']){
   const query=new URLSearchParams('from=2026-10-27&to=2026-10-27&provider=openai');
   const cookie=await f.call('GET',path,{},'alice',{},query),bearer=await f.machine(token,'GET',path,{}, {},query);
   assert.equal(bearer.status,200);assert.deepEqual(bearer.data,cookie.data);
   assert.equal(bearer.headers['set-cookie'],undefined);
   if(path.endsWith('analytics'))assert.equal(bearer.data.evidence.length,1);
  }
  for(const path of ['/v1/projects/project-bob','/v1/projects/project-bob/analytics'])await denied(f.machine(token,'GET',path),404,'NOT_FOUND');
  const forged=await f.machine(token,'GET','/v1/projects',{}, {},new URLSearchParams('userId=bob&owner_id=bob'));
  assert.deepEqual(forged.data.map(p=>p.id),['project-alice']);
  await denied(f.machine(token,'GET','/v1/projects/project-alice/analytics',{}, {},new URLSearchParams('runId=run-bob')),404,'NOT_FOUND');
  // Database activity during report reads is limited to the token's usage marker.
  f.writes.length=0;await f.machine(token,'GET','/v1/projects/project-alice/analytics');assert.deepEqual(f.writes,[]);
 }finally{f.close();}
});

test('report scope rejects all writes and every other protected route before CSRF or handler side effects',async()=>{
 const f=await fixture();try{
  const {token,id}=await f.mint();f.writes.length=0;
  for(const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS'])for(const path of ['/v1/projects','/v1/projects/project-alice','/v1/projects/project-alice/analytics'])await denied(f.machine(token,method,path),403,'SCOPE_DENIED');
  for(const [method,path] of [
   ['POST','/v1/projects/project-alice/monitoring-runs'],['POST','/v1/app/report-tokens'],
   ['GET','/v1/app/report-tokens'],['POST',`/v1/app/report-tokens/${id}/revoke`],['POST','/v1/app/logout'],
   ['GET','/v1/projects/project-alice/versions'],['GET','/v1/projects/project-alice/analytics/'],
   ['GET','/v1/projects/project-alice/analytics-extra'],['GET','/v1/projects/'],['GET','/v1/projects/project-alice/results'],
   ['GET','/v1/projects/project-alice/connections/ga4'],['GET','/v1/projects/project-alice/reports'],
   ['GET','/v1/me/preferences'],['GET','/v1/app/content-projects'],['POST','/v1/app/email/login'],
   ['GET','/v1/app/google/start'],['GET','/v1/app/google/callback'],['GET','/v1/industries'],
   ['GET','/v1/projects/project-alice%2Fanalytics'],['GET','/v1/projects/project-alice/../project-bob'],
  ])await denied(f.machine(token,method,path),403,'SCOPE_DENIED');
  assert.deepEqual(f.writes,[]);
  // A valid ambient session cannot upgrade an explicit restricted bearer.
  await denied(f.call('POST','/v1/app/report-tokens',{},'alice',{authorization:'Bearer '+token}),403,'SCOPE_DENIED');
 }finally{f.close();}
});

test('report credentials never expose CSRF, user identity, session cookies or signup claims via session endpoint',async()=>{
 const f=await fixture();try{
  const {token}=await f.mint();f.writes.length=0;
  for(const headers of [{},{cookie:'__Host-airank_session=session-alice'}]){
   const r=await f.machine(token,'GET','/v1/app/session',{},headers);
   assert.equal(r.data.authenticated,false);assert.equal(r.data.csrfToken,null);assert.equal(r.data.user,null);assert.equal(r.data.accountCreated,false);
   assert.equal(r.headers['set-cookie'],undefined);
  }
  assert.deepEqual(f.writes,[]);
  const r=await f.call('GET','/v1/app/session');assert.equal(r.data.authenticated,true);assert.equal(r.data.csrfToken,csrfFor('session-alice'));
 }finally{f.close();}
});

test('mint and revoke require a cookie session, registered client, matching origin and CSRF',async()=>{
 const f=await fixture();try{
  const {id}=await f.mint();
  for(const path of ['/v1/app/report-tokens',`/v1/app/report-tokens/${id}/revoke`]){
   await denied(f.call('POST',path,{},'alice',{cookie:''}),401,'AUTH_REQUIRED');
   for(const headers of [{origin:''},{origin:'https://evil.example'},{'x-csrf-token':''},{'x-csrf-token':csrfFor('session-bob')}])await denied(f.call('POST',path,{},'alice',headers),403,'CSRF_INVALID');
   await denied(f.call('POST',path,{},'alice',{'content-type':'text/plain'}),415,'JSON_REQUIRED');
  }
  const {token}=await f.mint();
  for(const client of ['',undefined,'unknown'])await denied(f.machine(token,'GET','/v1/projects',{}, {'x-airank-client':client}),503,'APP_NOT_CONFIGURED');
 }finally{f.close();}
});

test('revocation is owner-only and idempotent, and immediately prevents subsequent reads',async()=>{
 const f=await fixture();try{
  const {id,token}=await f.mint(),path=`/v1/app/report-tokens/${id}/revoke`;
  await denied(f.call('POST',path,{},'bob'),404,'NOT_FOUND');
  assert.equal((await f.machine(token,'GET','/v1/projects')).status,200);
  assert.deepEqual((await f.call('POST',path,{})).data,{ok:true});
  const stamp=f.now();f.advance(1000);await f.call('POST',path,{});
  assert.equal(f.sqlite.prepare('SELECT revoked_at FROM app_report_tokens WHERE id=?').get(id).revoked_at,stamp);
  await denied(f.machine(token,'GET','/v1/projects/project-alice/analytics'),401,'AUTH_REQUIRED');
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM app_audit_events WHERE kind='report_token.revoked'").get().n,1);
  assert.ok((await f.call('GET','/v1/app/report-tokens')).data[0].revokedAt);
 }finally{f.close();}
});

test('tokens expire exactly at their configured deadline and survive ordinary browser logout',async()=>{
 const f=await fixture({env:{REPORT_TOKEN_DAYS:'1'}});try{
  const {token}=await f.mint();await f.call('POST','/v1/app/logout',{});
  assert.equal((await f.machine(token,'GET','/v1/projects')).status,200);
  f.advance(86400000-1);assert.equal((await f.machine(token,'GET','/v1/projects')).status,200);
  f.advance(1);await denied(f.machine(token,'GET','/v1/projects'),401,'AUTH_REQUIRED');
 }finally{f.close();}
});

test('invalid report credentials fail closed and unrelated headers preserve existing cookie authentication',async()=>{
 const f=await fixture();try{
  const {token}=await f.mint();
  for(const authorization of ['Bearer '+token+'x','Bearer '+token+' ','Bearer '+token.toUpperCase(),'Bearer airank_rt_'+'A'.repeat(43),'Bearer  '+token]){
   await denied(f.call('GET','/v1/projects',{},'alice',{authorization}),401,'AUTH_REQUIRED');
  }
  for(const authorization of ['',token,'Basic '+token,'Bearer wrong',['Bearer '+token]])await denied(f.machine(token,'GET','/v1/projects',{}, {authorization}),401,'AUTH_REQUIRED');
  assert.equal((await f.call('GET','/v1/projects',{},'alice',{authorization:'Bearer unrelated-frontend-credential'})).status,200);
  assert.equal((await f.machine(token,'GET','/v1/projects',{}, {authorization:'bearer '+token})).status,200);
 }finally{f.close();}
});

test('usage timestamp updates once per minute and concurrent requests cannot duplicate the write',async()=>{
 const f=await fixture();try{
  const {token,id}=await f.mint();f.writes.length=0;
  await Promise.all(Array.from({length:5},()=>f.machine(token,'GET','/v1/projects')));
  assert.equal(f.writes.length,1);assert.match(f.writes[0],/^UPDATE app_report_tokens SET last_used_at/);
  assert.equal(f.sqlite.prepare('SELECT last_used_at FROM app_report_tokens WHERE id=?').get(id).last_used_at,f.now());
  f.advance(59999);await f.machine(token,'GET','/v1/projects');assert.equal(f.writes.length,1);
  f.advance(1);await f.machine(token,'GET','/v1/projects');assert.equal(f.writes.length,2);
 }finally{f.close();}
});

test('labels, bodies and token lifetime configuration are validated before creating credentials',async()=>{
 const f=await fixture();try{
  for(const body of [null,[],{label:1},{label:''},{label:'\n'},{label:'x'.repeat(61)},{label:'Weekly',user_id:'bob'},{expiresAt:1},{scope:'all'}])await denied(f.mint('alice',body),422,'VALIDATION_FAILED');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_report_tokens').get().n,0);
  const a=await f.mint('alice',{});assert.equal(a.label,'Weekly report');
  const b=await f.mint('alice',{label:'  Monthly report  '});assert.equal(b.label,'Monthly report');
  await denied(f.call('POST',`/v1/app/report-tokens/${a.id}/revoke`,{user_id:'bob'}),422,'VALIDATION_FAILED');
 }finally{f.close();}
 for(const value of ['','0','-1','366','Infinity','NaN','1.5',' 180 ','unlimited']){
  const bad=await fixture({env:{REPORT_TOKEN_DAYS:value}});try{
   await denied(bad.mint(),503,'REPORT_TOKEN_DAYS_INVALID');
   assert.equal(bad.sqlite.prepare('SELECT COUNT(*) n FROM app_report_tokens').get().n,0);
  }finally{bad.close();}
 }
});

test('additive migration preserves evidence, repeats safely, and detects checksum or schema conflicts',async()=>{
 const f=await fixture();try{
  const before=f.sqlite.prepare('SELECT * FROM mon_evidence ORDER BY id').all(),a=await f.mint();
  await migrateReportTokens(f.db);await migrateReportTokens(f.db);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM mon_evidence ORDER BY id').all(),before);
  assert.equal(f.sqlite.prepare('SELECT token_hash FROM app_report_tokens WHERE id=?').get(a.id).token_hash,hashToken(a.token));
  assert.equal(f.sqlite.prepare('SELECT checksum FROM app_migrations WHERE id=?').get(migrationId).checksum,checksum);
  f.sqlite.prepare('UPDATE app_migrations SET checksum=? WHERE id=?').run('wrong',migrationId);
  await assert.rejects(migrateReportTokens(f.db),/checksum mismatch/);
  await denied(f.mint(),503,'REPORT_TOKENS_NOT_CONFIGURED');
  await denied(f.machine(a.token,'GET','/v1/projects'),503,'REPORT_TOKENS_NOT_CONFIGURED');
 }finally{f.close();}
 const missing=await fixture({migrate:false});try{
  await denied(missing.mint(),503,'REPORT_TOKENS_NOT_CONFIGURED');
  assert.equal((await missing.call('GET','/v1/projects')).status,200);
  missing.sqlite.exec('CREATE TABLE app_report_tokens(unexpected TEXT)');
  await assert.rejects(migrateReportTokens(missing.db),/already exists/);
  assert.equal(missing.sqlite.prepare('SELECT COUNT(*) n FROM app_migrations WHERE id=?').get(migrationId).n,0);
 }finally{missing.close();}
});

test('token changes and audits roll back together when persistence fails',async()=>{
 const f=await fixture();try{
  const a=await f.mint();
  f.sqlite.exec("CREATE TRIGGER reject_report_audit BEFORE INSERT ON app_audit_events BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END");
  await assert.rejects(f.mint(),/fixture storage failure/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_report_tokens').get().n,1);
  await assert.rejects(f.call('POST',`/v1/app/report-tokens/${a.id}/revoke`,{}),/fixture storage failure/);
  assert.equal((await f.machine(a.token,'GET','/v1/projects')).status,200);
 }finally{f.close();}
});
