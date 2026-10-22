import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrations} from '../src/migrate.mjs';
import {migrateApp} from '../src/app/migration.mjs';
import {migrateEmailAuth} from '../src/app/email-migration.mjs';
import {createAppService} from '../src/app/service.mjs';
import {verifyPassword} from '../src/app/password.mjs';
import {hashToken} from '../src/common/utils.mjs';
import {emailAuthConfiguration} from '../src/app/email-auth.mjs';

const origin='https://app.example.test',password='a unique fixture password';
async function fixture() {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
  for(const ddl of migrations)sqlite.exec(ddl);
  const execute=async q=>{
    const sql=typeof q==='string'?q:q.sql,args=typeof q==='string'?[]:q.args||[],s=sqlite.prepare(sql);
    return /SELECT|RETURNING/i.test(sql)?{rows:s.all(...args)}:{rows:[],rowsAffected:Number(s.run(...args).changes)};
  };
  const db={execute,transaction:async()=>{sqlite.exec('BEGIN IMMEDIATE');return {execute,commit:async()=>sqlite.exec('COMMIT'),rollback:async()=>sqlite.exec('ROLLBACK'),close:()=>{}};}};
  await migrateApp(db);await migrateEmailAuth(db);await migrateEmailAuth(db);
  const mails=[],env={EMAIL_AUTH_ENABLED:'true',RESEND_API_KEY:'offline-fake',AUTH_EMAIL_FROM:'AI Rank <accounts@example.test>',RATE_LIMIT_SECRET:'offline-auth-limit-secret-at-least-24'};
  let time=Date.now(),failMail=false;
  const service=createAppService({db,clients:{app:{origin,redirectUri:`${origin}/api/airank/v1/app/google/callback`}},env,now:()=>time,sendMail:async mail=>{if(failMail)throw Error('offline');mails.push(mail);}});
  const call=(action,body,extra={})=>service({method:'POST',path:`/v1/app/email/${action}`,headers:{'x-airank-client':'app',origin,'content-type':'application/json',...extra},body});
  return {sqlite,db,env,mails,call,service,advance:ms=>time+=ms,failMail:()=>failMail=true};
}
const denied=async(p,status,code)=>assert.rejects(p,e=>e.status===status&&(!code||e.code===code));
test('email readiness reports missing requirements without exposing secret values',async()=>{
 const f=await fixture();try{
  const good=await emailAuthConfiguration(f.db,f.env);
  assert.equal(good.available,true);assert.equal(good.migration_ready,true);
  assert.ok(!JSON.stringify(good).includes(f.env.RESEND_API_KEY));
  assert.equal((await emailAuthConfiguration(f.db,{...f.env,EMAIL_AUTH_ENABLED:'false'})).available,false);
  const missing=await emailAuthConfiguration(f.db,{...f.env,AUTH_EMAIL_FROM:'',RATE_LIMIT_SECRET:'short'});
  assert.equal(missing.available,false);assert.deepEqual(missing.missing_variables,['AUTH_EMAIL_FROM']);
  assert.equal(missing.rate_limit_secret_valid,false);
  f.sqlite.prepare("DELETE FROM app_migrations WHERE id LIKE '%email%'").run();
  assert.equal((await emailAuthConfiguration(f.db,f.env)).migration_ready,false);
 }finally{f.sqlite.close();}
});
async function register(f,email='new@example.test',locale='en') {
  const challenge=await f.call('sign-up',{email,name:'Fixture Person',password,locale});
  return f.call('verify',{challengeId:challenge.data.challengeId,code:f.mails.at(-1).code,locale});
}
test('verified email account can create and retain multiple owned workspaces',async()=>{
 const f=await fixture();try{
  const account=await register(f);
  const headers={'x-airank-client':'app',origin,'content-type':'application/json',
   cookie:account.headers['set-cookie'][0].split(';')[0],'x-csrf-token':account.data.csrfToken};
  const call=(method,path,body)=>f.service({method,path,headers,body});
  for(const brandName of ['First Business','Second Business']){
   assert.equal((await call('POST','/v1/projects',{brandName,aliases:[],ownedDomains:['example.fi'],categoryFi:'Business software services',market:'FI',promptLanguage:'fi'})).status,201);
  }
  const session=await call('GET','/v1/app/session');
  assert.equal(session.data.authenticated,true);assert.equal(session.data.emailLoginAvailable,true);
  assert.equal((await call('GET','/v1/projects')).data.length,2);
  assert.equal(f.sqlite.prepare('SELECT locale FROM app_preferences').get().locale,'en');
 }finally{f.sqlite.close();}
});
test('verified email registration, secure cookie, hashed password, name and EN preference survive login',async()=>{
  const f=await fixture(),challenge=await f.call('sign-up',{email:' NEW@EXAMPLE.TEST ',name:'Fixture Person',password,locale:'en'});
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM users').get().n,0);
  assert.equal(f.mails[0].locale,'en');
  await denied(f.call('verify',{challengeId:challenge.data.challengeId,code:'000000',locale:'en'}),400);
  const r=await f.call('verify',{challengeId:challenge.data.challengeId,code:f.mails[0].code,locale:'en'});
  assert.equal(r.data.user.name,'Fixture Person');assert.equal(r.data.user.email,'new@example.test');
  assert.match(r.headers['set-cookie'][0],/HttpOnly; Secure; SameSite=Lax/);
  const cred=f.sqlite.prepare('SELECT * FROM app_email_credentials').get();
  assert.notEqual(cred.password_hash,password);assert.equal(await verifyPassword(password,cred.password_hash),true);
  assert.equal(f.sqlite.prepare('SELECT locale FROM app_preferences').get().locale,'en');
  await denied(f.call('verify',{challengeId:challenge.data.challengeId,code:f.mails[0].code,locale:'en'}),400);
  await denied(f.call('sign-in',{email:'new@example.test',password:'wrong password',locale:'fi'}),401,'INVALID_CREDENTIALS');
  const login=await f.call('sign-in',{email:'new@example.test',password,locale:'fi'});
  assert.equal(login.data.user.id,r.data.user.id);assert.equal(f.sqlite.prepare('SELECT locale FROM app_preferences').get().locale,'fi');
  assert.notEqual(login.headers['set-cookie'][0],r.headers['set-cookie'][0]);
  f.sqlite.close();
});
test('verification uses current selected locale, expires, locks after five attempts and never creates accounts prematurely',async()=>{
  const f=await fixture(),a=await f.call('sign-up',{email:'a@example.test',name:'Test Name',password,locale:'fi'});
  const r=await f.call('verify',{challengeId:a.data.challengeId,code:f.mails[0].code,locale:'en'});
  assert.equal(r.data.locale,'en');
  const b=await f.call('sign-up',{email:'b@example.test',name:'Test Name',password,locale:'en'});
  for(let n=0;n<5;n++)await denied(f.call('verify',{challengeId:b.data.challengeId,code:'000000',locale:'en'}),400);
  await denied(f.call('verify',{challengeId:b.data.challengeId,code:f.mails[1].code,locale:'en'}),400);
  const c=await f.call('sign-up',{email:'c@example.test',name:'Test Name',password,locale:'fi'});
  f.advance(900001);await denied(f.call('verify',{challengeId:c.data.challengeId,code:f.mails[2].code,locale:'fi'}),400);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM users').get().n,1);f.sqlite.close();
});
test('password recovery stays generic, revokes sessions, accepts new password, rejects old password and replay',async()=>{
  const f=await fixture(),user=await register(f);
  const unknown=await f.call('reset-request',{email:'unknown@example.test',locale:'fi'});assert.equal(unknown.status,200);assert.equal(f.mails.length,1);
  const reset=await f.call('reset-request',{email:'new@example.test',locale:'en'});
  const code=f.mails.at(-1).code,next='a different unique password';
  await f.call('reset',{challengeId:reset.data.challengeId,code,password:next});
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM sessions WHERE user_id=?').get(user.data.user.id).n,0);
  await denied(f.call('reset',{challengeId:reset.data.challengeId,code,password:next}),400);
  await denied(f.call('sign-in',{email:'new@example.test',password,locale:'fi'}),401);
  assert.equal((await f.call('sign-in',{email:'new@example.test',password:next,locale:'en'})).data.authenticated,true);
  f.sqlite.close();
});
test('origin, strict field validation, rollout flag, delivery failure and persistent account rate limits fail explicitly',async()=>{
  const f=await fixture();
  await denied(f.call('sign-in',{email:'x@example.test',password,locale:'en'},{origin:'https://evil.test'}),403);
  await denied(f.call('sign-up',{email:'x@example.test',name:'X',password:'short',locale:'en'}),422);
  await denied(f.call('sign-up',{email:'x@example.test',name:'Test Name',password,locale:'en',admin:true}),422);
  f.env.EMAIL_AUTH_ENABLED='false';await denied(f.call('sign-in',{email:'x@example.test',password,locale:'en'}),503,'EMAIL_AUTH_NOT_CONFIGURED');
  f.env.EMAIL_AUTH_ENABLED='true';f.failMail();
  await denied(f.call('sign-up',{email:'fail@example.test',name:'Test Name',password,locale:'en'}),503,'AUTH_MAIL_UNAVAILABLE');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM app_email_challenges').get().n,0);
  for(let n=0;n<12;n++)await denied(f.call('sign-in',{email:'unknown@example.test',password,locale:'en'}),401);
  await denied(f.call('sign-in',{email:'unknown@example.test',password,locale:'en'}),429);
  f.sqlite.close();
});
test('Google identities cannot be taken over by registering their email or requesting password recovery',async()=>{
  const f=await fixture();f.sqlite.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run('google-owner','real-google-sub','google@example.test','Google Owner','',1,1);
  await denied(f.call('sign-up',{email:'google@example.test',name:'Attacker',password,locale:'en'}),409,'EMAIL_IN_USE');
  await f.call('reset-request',{email:'google@example.test',locale:'en'});assert.equal(f.mails.length,0);
  await denied(f.call('sign-in',{email:'google@example.test',password,locale:'en'}),401);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM app_email_credentials').get().n,0);f.sqlite.close();
});
