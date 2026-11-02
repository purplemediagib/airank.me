import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrations} from '../src/migrate.mjs';
import {migrateApp} from '../src/app/migration.mjs';
import {migrateEmailAuth} from '../src/app/email-migration.mjs';
import {migrateSignupNotifications} from '../src/app/signup-notification-migration.mjs';
import {createAppService} from '../src/app/service.mjs';
import {dispatchSignupNotification,renderSignupNotification,signupNotificationsConfigured,sendSignupNotification,OWNER_EMAIL} from '../src/app/signup-notifications.mjs';
const env={SIGNUP_NOTIFICATIONS_ENABLED:'true',RESEND_API_KEY:'mock',AUTH_EMAIL_FROM:'AI Rank <accounts@example.test>',EMAIL_AUTH_ENABLED:'true',RATE_LIMIT_SECRET:'offline-test-secret-at-least-24-chars',GOOGLE_CLIENT_ID:'test',GOOGLE_CLIENT_SECRET:'test'};
const origin='https://app.example.test';
async function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const sql of migrations)sqlite.exec(sql);
 const execute=async q=>{const sql=typeof q==='string'?q:q.sql,args=q.args||[],s=sqlite.prepare(sql);return /^(SELECT|PRAGMA)|RETURNING/i.test(sql.trim())?{rows:s.all(...args)}:{rows:[],rowsAffected:Number(s.run(...args).changes)};};
 const db={execute,transaction:async()=>{sqlite.exec('BEGIN IMMEDIATE');return {execute,commit:async()=>sqlite.exec('COMMIT'),rollback:async()=>sqlite.exec('ROLLBACK'),close(){}};}};
 const insert=(id,sub=`google-${id}`)=>sqlite.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run(id,sub,`${id}@example.test`,'<script>Person</script>',null,1000,1000);
 insert('historical');await migrateApp(db);await migrateEmailAuth(db);await migrateSignupNotifications(db);await migrateSignupNotifications(db);
 let time=2000;const mails=[];
 const service=createAppService({db,env,now:()=>time,clients:{app:{origin,redirectUri:`${origin}/api/airank/v1/app/google/callback`}},sendMail:async m=>mails.push(m),exchange:async()=>'',verify:async()=>({googleSub:'new-google',email:'google@example.test',name:'Google Person',picture:''})});
 const call=(action,body)=>service({method:'POST',path:`/v1/app/email/${action}`,headers:{'x-airank-client':'app',origin,'content-type':'application/json'},body});
 const rows=()=>sqlite.prepare('SELECT * FROM app_signup_notifications').all();
 return {sqlite,db,insert,service,call,mails,rows,now:()=>time,advance:n=>time+=n};
}
test('email account creation (not challenge/login/reset/replay) queues one committed event; no backfill',async()=>{
 const f=await fixture();try{
 assert.equal(f.rows().length,0);
 const password='a safe fixture password';
 const challenge=await f.call('sign-up',{email:'new@example.test',name:'New Person',password,locale:'en'});
 assert.equal(f.rows().length,0);
 const verify={challengeId:challenge.data.challengeId,code:f.mails[0].code,locale:'en'};
 await f.call('verify',verify);assert.equal(f.rows().length,1);
 assert.equal(JSON.parse(f.rows()[0].snapshot_json).method,'Email/password');
 assert.equal(JSON.parse(f.rows()[0].snapshot_json).locale,'en');
 await assert.rejects(f.call('verify',verify));
 await f.call('sign-in',{email:'new@example.test',password,locale:'en'});
 const reset=await f.call('reset-request',{email:'new@example.test',locale:'en'});
 await f.call('reset',{challengeId:reset.data.challengeId,code:f.mails.at(-1).code,password:'another safe password'});
 assert.equal(f.rows().length,1);
 }finally{f.sqlite.close();}
});
test('app Google new account queues once; repeated logins and callback replay do not',async()=>{
 const f=await fixture();try{
 for(let i=0;i<2;i++){
 const headers={'x-airank-client':'app'};
 const start=await f.service({method:'GET',path:'/v1/app/google/start',headers});
 const state=new URL(start.headers.location).searchParams.get('state');
 const request={method:'GET',path:'/v1/app/google/callback',headers:{...headers,cookie:`__Host-airank_app_oauth=${state}`},query:new URLSearchParams({state,code:'mock'})};
 const result=await f.service(request);assert.ok(!result.headers.location.includes('error='));
 await f.service(request);assert.equal(f.rows().length,1);
 }
 assert.equal(JSON.parse(f.rows()[0].snapshot_json).method,'Google');
 }finally{f.sqlite.close();}
});
test('legacy insertion is covered, rollback is invisible, UPDATE/link and UPSERT do not create new events',async()=>{
 const f=await fixture();try{
 f.sqlite.exec('BEGIN');f.insert('rollback');f.sqlite.exec('ROLLBACK');assert.equal(f.rows().length,0);
 f.insert('legacy');
 f.sqlite.prepare('UPDATE users SET google_sub=? WHERE id=?').run('linked-google','legacy');
 f.sqlite.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?) ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email').run('unused','linked-google','updated@example.test','Name',null,1000,2000);
 assert.equal(f.rows().length,1);
 }finally{f.sqlite.close();}
});
test('concurrent dispatch is atomically leased, successful event is never resent, payload escapes and minimizes',async()=>{
 const f=await fixture();try{
 f.insert('new');let calls=0,release;const gate=new Promise(r=>release=r);
 const send=async p=>{calls++;assert.equal(p.to[0],OWNER_EMAIL);assert.ok(p.html.includes('&lt;script&gt;'));assert.ok(!p.html.includes('<script>'));await gate;return 'provider-id';};
 const a=dispatchSignupNotification({db:f.db,env,now:f.now,send});
 await new Promise(r=>setImmediate(r));
 assert.equal((await dispatchSignupNotification({db:f.db,env,now:f.now,send})).status,'idle');release();await a;
 assert.equal(calls,1);assert.equal(f.rows()[0].status,'sent');assert.equal(f.rows()[0].snapshot_json,null);assert.equal(f.rows()[0].payload_json,null);
 assert.equal((await dispatchSignupNotification({db:f.db,env,now:f.now,send})).status,'idle');
 }finally{f.sqlite.close();}
});
test('provider failure is separate from account; bounded retries keep exact payload/key then dead-letter',async()=>{
 const f=await fixture();try{
 f.insert('retry');const payloads=[],keys=[],logs=[];
 const send=async(p,{key})=>{payloads.push(JSON.stringify(p));keys.push(key);throw Error('secret PII never logged');};
 for(let n=0;n<6;n++){await dispatchSignupNotification({db:f.db,env:{...env,AUTH_EMAIL_FROM:n?'changed@example.test':env.AUTH_EMAIL_FROM},now:f.now,send,log:e=>logs.push(e)});f.advance(3600000);}
 assert.equal(f.rows()[0].status,'dead');assert.equal(f.rows()[0].attempts,6);assert.equal(new Set(payloads).size,1);assert.equal(new Set(keys).size,1);
 assert.ok(!JSON.stringify(logs).includes('secret'));assert.ok(f.sqlite.prepare("SELECT id FROM users WHERE id='retry'").get());
 }finally{f.sqlite.close();}
});
test('crash recovery reuses idempotency key; no uncertain send after provider dedupe window',async()=>{
 const f=await fixture();try{
 f.insert('crash');
 f.sqlite.exec("UPDATE app_signup_notifications SET status='sending',attempts=1,first_attempt_at=2000,lease_until=3000,lease_token='dead-process'");
 f.advance(60001);let key;
 await dispatchSignupNotification({db:f.db,env,now:f.now,send:async(p,o)=>{key=o.key;return 'ok';}});assert.equal(key,'signup-owner/crash');
 f.insert('old');f.sqlite.exec("UPDATE app_signup_notifications SET first_attempt_at=1,attempts=1 WHERE user_id='old'");f.advance(24*3600000);
 const r=await dispatchSignupNotification({db:f.db,env,now:f.now,send:()=>{throw Error('must not send');},log:()=>{}});assert.equal(r.status,'idle');assert.equal(f.rows().find(r=>r.user_id==='old').status,'dead');
 }finally{f.sqlite.close();}
});
test('disabled or invalid destination sends nothing; HTTP includes provider dedupe and fixed recipient',async()=>{
 assert.equal(signupNotificationsConfigured({...env,SIGNUP_NOTIFICATION_TO:'other@example.test'}),false);
 assert.equal(signupNotificationsConfigured({...env,SIGNUP_NOTIFICATIONS_ENABLED:'false'}),false);
 const p=renderSignupNotification({id:'id',email:'example@test.test',createdAt:1000,method:'Google'},env.AUTH_EMAIL_FROM);
 await sendSignupNotification(p,{env,key:'signup-owner/id',fetcher:async(url,o)=>{assert.equal(url,'https://api.resend.com/emails');assert.equal(o.headers['Idempotency-Key'],'signup-owner/id');assert.deepEqual(JSON.parse(o.body).to,[OWNER_EMAIL]);return {ok:true,json:async()=>({id:'ok'})};}});
});

test('stale lease or suspended worker cannot send after the retry deadline',async()=>{
 const f=await fixture();try{
 f.insert('stale');const original=f.db.execute;
 f.db.execute=async q=>{const result=await original(q);if(q.sql?.includes('RETURNING *'))f.advance(24*3600000);return result;};
 const r=await dispatchSignupNotification({db:f.db,env,now:f.now,send:async()=>{assert.fail('stale worker sent');}});assert.equal(r.status,'lease_lost');
 }finally{f.sqlite.close();}
});
test('corrupted outbox schema rolls back account creation rather than losing the event',async()=>{
 const f=await fixture();try{
 f.sqlite.exec('DROP TABLE app_signup_notifications');
 assert.throws(()=>f.insert('not-committed'));
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM users WHERE id='not-committed'").get().n,0);
 }finally{f.sqlite.close();}
});
test('existing same-email password account is not linked by current Google callback (separate actual account IDs)',async()=>{
 const f=await fixture();try{
 const challenge=await f.call('sign-up',{email:'google@example.test',name:'Email Person',password:'fixture safe password',locale:'en'});
 await f.call('verify',{challengeId:challenge.data.challengeId,code:f.mails[0].code,locale:'en'});
 const headers={'x-airank-client':'app'};
 const start=await f.service({method:'GET',path:'/v1/app/google/start',headers});
 const state=new URL(start.headers.location).searchParams.get('state');
 const result=await f.service({method:'GET',path:'/v1/app/google/callback',headers:{...headers,cookie:`__Host-airank_app_oauth=${state}`},query:new URLSearchParams({state,code:'mock'})});
 assert.ok(!result.headers.location.includes('error='));
 assert.equal(f.sqlite.prepare("SELECT count(DISTINCT id) n FROM users WHERE email='google@example.test'").get().n,2);
 assert.equal(f.rows().length,2);
 }finally{f.sqlite.close();}
});

test('narrow migration startup opt-in precedes API listening for direct and wrapper entrypoints',()=>{
 const api=readFileSync(new URL('../src/api/server.mjs',import.meta.url),'utf8');
 const wrapper=readFileSync(new URL('../src/app/start-release.mjs',import.meta.url),'utf8');
 const block=api.match(/if\(process.env.AIRANK_RUN_SIGNUP_NOTIFICATION_MIGRATION==='true'\)\{[^\n]+\}/)?.[0];
 assert.ok(block);assert.match(block,/await migrateSignupNotifications\(await getDb\(\)\)/);
 assert.ok(!block.includes('migrateApp('));assert.ok(api.indexOf(block)<api.indexOf('server.listen('));
 assert.match(wrapper,/await import\('..\/api\/server.mjs'\)/);
});
