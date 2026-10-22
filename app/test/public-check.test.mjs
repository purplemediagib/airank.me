import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'node:http';
import {randomUUID,createHmac} from 'node:crypto';
import {migrations} from '../src/migrate.mjs';
import {migratePublicCheck} from '../src/public-check/migration.mjs';
import {publicCheckService} from '../src/public-check/service.mjs';
import {publicCheckHttp} from '../src/public-check/http.mjs';
import {digest,mac,verifyProxy,unseal} from '../src/public-check/security.mjs';
import {handleDeliveryWebhook,CONSENT_TEXT} from '../src/public-check/delivery.mjs';
import {renderReportEmail} from '../src/public-check/email.mjs';
import {assertPublicWebsite} from '../src/website-profile/providers.mjs';
const secret='isolated-fixture-secret-never-a-real-credential-48';
const env={PUBLIC_CHECK_ENABLED:'true',PUBLIC_CHECK_PROXY_SECRET:secret,RATE_LIMIT_SECRET:secret,RESEND_API_KEY:'fixture-only',PUBLIC_CHECK_EMAIL_FROM:'reports@example.test',PUBLIC_CHECK_PRIVACY_URL:'https://airank.me/privacy',RESEND_MARKETING_SEGMENT_ID:'fixture-segment'};
const config={enabledProviders:['openai','claude'],scanPrompts:3};
const profile={domain:'www.example.fi',brand_name:'EXAMPLE',aliases:[],category_fi:'business accounting services',market:'FI',language:'en'};
async function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
 const execute=async q=>{const s=typeof q==='string'?q:q.sql,args=typeof q==='string'?[]:q.args||[],stmt=sqlite.prepare(s);
  if(/^\s*(SELECT|PRAGMA)|RETURNING/i.test(s))return {rows:stmt.all(...args)};
  return {rows:[],rowsAffected:Number(stmt.run(...args).changes)};};
 const db={execute,transaction:async()=>{sqlite.exec('BEGIN IMMEDIATE');return {execute,commit:async()=>sqlite.exec('COMMIT'),rollback:async()=>sqlite.exec('ROLLBACK'),close(){}};}};
 for(const sql of migrations)sqlite.exec(sql);
 sqlite.exec('CREATE TABLE app_migrations(id TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
 await migratePublicCheck(db);let time=1791900000000;
 const options={db,env,config,now:()=>time,fingerprint:digest('fixture-visitor'),deps:{validateWebsite:async()=>({})}};
 const call=async(method,suffix,body,extra={})=>(await publicCheckService({...options,method,path:'/v1/public-check'+suffix,body,...extra})).data;
 async function start(extra={},identity=profile){
  const preview=await call('POST','/preview',identity,extra);
  const body={...preview.profile,preview_hash:preview.preview_hash,methodology:preview.methodology,profile_confirmed:true,submission_id:randomUUID()};
  return {scan:await call('POST','/scans',body,extra),body,preview};
 }
 function finish(scan,valid=2){
  const prompts=sqlite.prepare('SELECT * FROM scan_prompts WHERE scan_id=? ORDER BY sequence').all(scan.id);
  for(const [i,prompt] of prompts.entries())for(const provider of config.enabledProviders){
   const ok=provider==='openai'&&i<valid;
   sqlite.prepare('INSERT INTO observations(id,scan_id,prompt_id,provider,provider_status,model,answer_text,citations_json,brand_mentioned,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(),scan.id,prompt.id,provider,ok?'success':'failed',ok?'actual-model-fixture':null,ok?'Measured answer':null,'[{"url":"javascript:alert(1)"},{"url":"https://example.fi/about"}]',ok&&i===0?1:0,time);
  }
  sqlite.prepare("UPDATE scan_jobs SET status=?,finished_at=? WHERE id=?").run(valid?'completed':'no_measurements',time,scan.id);
 }
 return {db,sqlite,options,call,start,finish,advance:n=>time+=n,close:()=>sqlite.close()};
}
test('expanded dashboard providers do not expand guest preview, queue snapshot or quotas',async()=>{
 const f=await fixture();try{
  const extra={config:{enabledProviders:['openai','claude','gemini','grok','perplexity','google_aio'],scanPrompts:3}};
  const caps=await f.call('GET','/capabilities',undefined,extra);
  assert.deepEqual(caps.providers,['openai','claude']);
  assert.deepEqual(caps.limits,{guestScansPerDay:1,domainScansPerWeek:5});
  const {scan,preview}=await f.start(extra);
  assert.deepEqual(preview.providers,caps.providers);
  const saved=JSON.parse(f.sqlite.prepare('SELECT profile_json FROM scan_profiles WHERE scan_id=?').get(scan.id).profile_json);
  assert.deepEqual(saved.providers,caps.providers);
 }finally{f.close();}
});
test('guest preview/start use existing queue, preserve context, casing and quotas; retries reuse token and scan',async()=>{
 const f=await fixture();try{
  const caps=await f.call('GET','/capabilities');assert.equal(caps.enabled,true);assert.deepEqual(caps.limits,{guestScansPerDay:1,domainScansPerWeek:5});assert(!caps.markets.some(m=>m.code==='RU'));
  const {scan,body,preview}=await f.start();assert.equal(preview.paid_calls,0);assert(preview.prompts.every(t=>t.includes('Finland')&&!t.includes('EXAMPLE')));
  const retry=await f.call('POST','/scans',body);assert.deepEqual(retry,scan);
  const duplicate=await f.call('POST','/scans',{...body,submission_id:randomUUID()});assert.deepEqual(duplicate,scan);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM scan_jobs').get().n,1);
  const frozenProfile=JSON.parse(f.sqlite.prepare('SELECT profile_json FROM scan_profiles').get().profile_json);
  assert.equal(frozenProfile.market,'FI');assert.equal(frozenProfile.language,'en');assert.equal(frozenProfile.brand_name,'EXAMPLE');
  await assert.rejects(f.call('POST','/preview',{...profile,domain:'different.fi'}),e=>e.code==='RATE_LIMIT');
  await assert.rejects(f.call('POST','/preview',{...profile,market:'RU'}),e=>e.code==='MARKET_EXCLUDED');
  await assert.rejects(f.call('POST','/scans',{...body,profile_confirmed:false}),e=>e.code==='CONFIRMATION_REQUIRED');
 }finally{f.close();}
});
test('five-per-domain cap includes legacy requests and cannot be bypassed by the public adaptor',async()=>{
 const f=await fixture();try{
  for(let i=0;i<5;i++)f.sqlite.prepare('INSERT INTO rate_events VALUES (?,?,?,?)').run(randomUUID(),digest('other'+i),'example.fi',f.options.now());
  await assert.rejects(f.call('POST','/preview',profile),e=>e.code==='DOMAIN_RATE_LIMIT');
 }finally{f.close();}
});
test('selected Swedish and Bulgarian question context uses existing generator; preview is cached and requires review',async()=>{
 const f=await fixture();try{
  let calls=0;const deps={...f.options.deps,generate:async(identity,context)=>{calls++;assert.equal(context.language,'sv');assert.equal(context.market,'FI');return Array.from({length:6},(_,i)=>`Vilka tjänster passar behov nummer ${i+1}?`);}};
  const body={...profile,language:'sv',category_fi:'redovisningstjänster för företag'};
  const a=await f.call('POST','/preview',body,{deps}),b=await f.call('POST','/preview',body,{deps});assert.deepEqual(a,b);assert.equal(calls,1);assert.equal(a.paid_calls,1);
  const caps=await f.call('GET','/capabilities');assert(caps.markets.some(m=>m.code==='BG'));assert(caps.languages.some(m=>m.code==='bg'));
 }finally{f.close();}
});
test('progress, actual provider models, partial/zero scores and immutable evidence are isolated by guest token',async()=>{
 const f=await fixture();try{
  const {scan}=await f.start();const extra={scanToken:scan.scan_token};
  const pending=await f.call('GET','/scans/'+scan.id,undefined,extra);assert.equal(pending.status,'queued');assert.equal(pending.score.value,null);assert.deepEqual(pending.progress,{completed:0,expected:6});
  await assert.rejects(f.call('GET','/scans/'+scan.id,undefined,{scanToken:'x'.repeat(43)}),e=>e.code==='SCAN_NOT_FOUND');
  f.finish(scan);const done=await f.call('GET','/scans/'+scan.id,undefined,extra);
  assert.equal(done.status,'partial');assert.equal(done.score.value,5);assert.equal(done.score.valid_answers,2);
  assert.deepEqual(done.providers[0].models,['actual-model-fixture']);assert.equal(done.providers[1].score,null);assert.equal(done.observations[0].citations.length,1);
  f.sqlite.prepare('UPDATE observations SET brand_mentioned=1').run();
  assert.deepEqual(await f.call('GET','/scans/'+scan.id,undefined,extra),done);
 }finally{f.close();}
 const z=await fixture();try{const {scan}=await z.start();z.finish(scan,0);const r=await z.call('GET','/scans/'+scan.id,undefined,{scanToken:scan.scan_token});assert.equal(r.status,'failed');assert.equal(r.score.value,null);}finally{z.close();}
});
test('optional email is normalized/idempotent, consent is separate, token is hashed/encrypted and expires',async()=>{
 const f=await fixture();try{
  const {scan}=await f.start();f.finish(scan);let sends=0,subs=0,mail;
  const deps={...f.options.deps,send:async m=>{sends++;mail=m;return 'email-fixture';},subscribe:async()=>{subs++;return true;}};
  const extra={scanToken:scan.scan_token,deps},body={email:'  Person@Example.COM ',locale:'en',marketingConsent:false};
  const sent=await f.call('POST','/scans/'+scan.id+'/email',body,extra);assert.equal(sent.status,'sent');assert.equal(sent.marketingStatus,'not_requested');
  assert.deepEqual(await f.call('POST','/scans/'+scan.id+'/email',body,extra),sent);assert.equal(sends,1);assert.equal(subs,0);
  const token=mail.text.match(/\/report\/([A-Za-z0-9_-]{43})/)[1],row=f.sqlite.prepare('SELECT * FROM public_check_deliveries').get();
  assert.equal(row.email,'person@example.com');assert.equal(row.report_token_hash,digest(token));assert.notEqual(row.report_token_cipher,token);assert.equal(row.consent_text,CONSENT_TEXT.en);
  const report=await f.call('POST','/reports/open',{token});assert.equal(report.id,scan.id);
  await assert.rejects(f.call('POST','/reports/open',{token:'x'.repeat(43)}),e=>e.code==='REPORT_NOT_FOUND');
  const opt=await f.call('POST','/scans/'+scan.id+'/email',{...body,email:'optin@example.com',marketingConsent:true},extra);assert.equal(opt.marketingStatus,'subscribed');assert.equal(subs,1);
  f.advance(31*86400000);await assert.rejects(f.call('POST','/reports/open',{token}),e=>e.code==='REPORT_EXPIRED');
 }finally{f.close();}
});
test('mail failure retains report; unknown sends never retry automatically; missing marketing fails explicitly',async()=>{
 const f=await fixture();try{
  const {scan}=await f.start();f.finish(scan);let sends=0;
  const extra={scanToken:scan.scan_token,deps:{...f.options.deps,send:async()=>{sends++;throw Error('network uncertain');}}},body={email:'uncertain@example.com',locale:'fi',marketingConsent:false};
  assert.equal((await f.call('POST','/scans/'+scan.id+'/email',body,extra)).status,'uncertain');
  await f.call('POST','/scans/'+scan.id+'/email',{...body,resend:true},extra);assert.equal(sends,1);
  assert.equal((await f.call('GET','/scans/'+scan.id,undefined,extra)).status,'partial');
  await assert.rejects(f.call('POST','/scans/'+scan.id+'/email',{...body,marketingConsent:true},{...extra,env:{...env,RESEND_MARKETING_SEGMENT_ID:''}}),e=>e.code==='MARKETING_UNAVAILABLE');
  await assert.rejects(f.call('POST','/scans/'+scan.id+'/email',{...body,email:'evil\n@example.com'},extra),e=>e.code==='EMAIL_INVALID');
 }finally{f.close();}
});
test('Resend webhook signature, replay idempotency and terminal bounce precedence',async()=>{
 const f=await fixture();try{
  const {scan}=await f.start();f.finish(scan);
  await f.call('POST','/scans/'+scan.id+'/email',{email:'person@example.com',locale:'en',marketingConsent:false},{scanToken:scan.scan_token,deps:{...f.options.deps,send:async()=> 'provider-fixture'}});
  const key=Buffer.from('webhook-fixture-not-real'),hookEnv={...env,PUBLIC_CHECK_RESEND_WEBHOOK_SECRET:'whsec_'+key.toString('base64')};
  const raw=JSON.stringify({type:'email.bounced',data:{email_id:'provider-fixture'}}),ts=String(Math.floor(f.options.now()/1000)),id='event-fixture';
  const signature=createHmac('sha256',key).update(`${id}.${ts}.${raw}`).digest('base64');
  const headers={'svix-id':id,'svix-timestamp':ts,'svix-signature':'v1,'+signature};
  await assert.rejects(handleDeliveryWebhook({db:f.db,raw,headers:{...headers,'svix-signature':'v1,fake'},env:hookEnv,now:f.options.now}),e=>e.code==='WEBHOOK_INVALID');
  await handleDeliveryWebhook({db:f.db,raw,headers,env:hookEnv,now:f.options.now});
  await handleDeliveryWebhook({db:f.db,raw,headers,env:hookEnv,now:f.options.now});
  assert.equal(f.sqlite.prepare('SELECT status FROM public_check_deliveries').get().status,'bounced');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM public_check_webhooks').get().n,1);
 }finally{f.close();}
});
test('SSRF targets rejected, email safely escapes HTML, and proxy proofs bind method/path/body/time',async()=>{
 for(const website of ['http://localhost','http://127.0.0.1','http://169.254.169.254','file:///etc/passwd','https://user:pass@example.fi'])
  await assert.rejects(assertPublicWebsite(website,async()=>['127.0.0.1']));
 await assert.rejects(assertPublicWebsite('example.fi',async()=>['93.184.216.34','10.0.0.1']));
 const f=await fixture();try{
  const {scan}=await f.start();f.finish(scan);const report=await f.call('GET','/scans/'+scan.id,undefined,{scanToken:scan.scan_token});
  const mail=renderReportEmail({...report,brand_name:'<img src=x onerror=alert(1)>'},{locale:'en',reportUrl:'https://app.airank.me/en/report/'+ 'x'.repeat(43),env});
  assert(mail.html.includes('&lt;img'));assert(!mail.html.includes('<img src=x'));assert(!mail.html.includes('display:flex'));assert(mail.text.includes('5.0 / 10'));
 }finally{f.close();}
 const method='POST',path='/v1/public-check/preview',body='{}',time=String(Date.now()),address='203.0.113.5',fingerprint=mac(address,secret);
 const headers={'x-check-address':address,'x-check-time':time,'x-check-visitor':fingerprint,'x-check-proof':mac([method,path,time,fingerprint,digest(body)].join('\n'),secret)};
 assert.equal(verifyProxy({method,path,body,headers,env}),fingerprint);assert.equal(verifyProxy({method,path,body:'{"bad":true}',headers,env}),null);
});
test('actual public HTTP entrypoint returns usable preview/start/status without account dispatch and rejects unsigned writes',async()=>{
 const f=await fixture(),server=createServer((req,res)=>publicCheckHttp(req,res,f.options));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const base=`http://127.0.0.1:${server.address().port}`;
  const req=async(method,suffix,data,token)=>{
   const path='/v1/public-check'+suffix,body=data?JSON.stringify(data):'',time=String(Date.now()),address='203.0.113.5',fingerprint=mac(address,secret);
   return fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Check-Address':address,'X-Check-Time':time,'X-Check-Visitor':fingerprint,'X-Check-Proof':mac([method,path,time,fingerprint,digest(body)].join('\n'),secret),...(token?{'X-Scan-Token':token}:{})},...(body?{body}:{})});
  };
  assert.equal((await fetch(base+'/v1/public-check/preview',{method:'POST',body:'{}'})).status,403);
  const previewResponse=await req('POST','/preview',profile);assert.equal(previewResponse.status,200);const preview=await previewResponse.json();
  const start=await req('POST','/scans',{...preview.profile,methodology:preview.methodology,preview_hash:preview.preview_hash,profile_confirmed:true,submission_id:randomUUID()});assert.equal(start.status,202);
  const scan=await start.json(),status=await req('GET','/scans/'+scan.id,null,scan.scan_token);assert.equal(status.status,200);assert.match(status.headers.get('x-robots-tag'),/noindex/);
 }finally{await new Promise(r=>server.close(r));f.close();}
});
