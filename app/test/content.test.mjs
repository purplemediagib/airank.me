import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrateContent} from '../src/content/migration.mjs';
import {contentService} from '../src/content/service.mjs';
import {get,put,enqueue,transaction,seal,unseal} from '../src/content/store.mjs';
import {tick,schedule} from '../src/content/worker.mjs';
import {publicUrl,parsePage,audit,robotsAllowed,fetchPage} from '../src/content/web.mjs';
import {documentInput,applyChanges,toHtml} from '../src/content/editor.mjs';
import {validateOutput,generate} from '../src/content/model.mjs';
import {googleReport,aggregateGsc,searchOpportunities} from '../src/content/google.mjs';
import {cmsItems} from '../src/content/publish.mjs';
import {runJob} from '../src/content/engine.mjs';

async function fixture(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(`PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT);CREATE TABLE app_migrations(id TEXT PRIMARY KEY,checksum TEXT,applied_at TEXT);CREATE TABLE app_projects(id TEXT PRIMARY KEY,owner_id TEXT,status TEXT,version INTEGER,created_at INTEGER);CREATE TABLE app_identity_versions(project_id TEXT,version INTEGER,identity_json TEXT);INSERT INTO users VALUES ('alice','alice@test.test'),('bob','bob@test.test'),('reviewer','review@test.test');`);
 sqlite.prepare('INSERT INTO app_projects VALUES (?,?,?,?,?)').run('project','alice','active',1,1);sqlite.prepare('INSERT INTO app_projects VALUES (?,?,?,?,?)').run('other','bob','active',1,1);
 for(const p of ['project','other'])sqlite.prepare('INSERT INTO app_identity_versions VALUES (?,?,?)').run(p,1,JSON.stringify({brandName:'Example',ownedDomains:['example.fi'],promptLanguage:'en'}));
 const execute=async q=>{const sql=typeof q==='string'?q:q.sql,args=q.args||[];const s=sqlite.prepare(sql);return /^\s*(SELECT|PRAGMA)|RETURNING/i.test(sql)?{rows:s.all(...args)}:{rows:[],rowsAffected:Number(s.run(...args).changes)};};
 let tail=Promise.resolve();const db={execute,transaction:async()=>{let release;const next=new Promise(r=>release=r),last=tail;tail=next;await last;sqlite.exec('BEGIN');return{execute,commit:async()=>sqlite.exec('COMMIT'),rollback:async()=>sqlite.exec('ROLLBACK'),close:release};}};
 await migrateContent(db);let time=Date.now();const env={CONTENT_ENCRYPTION_KEY:'ab'.repeat(32)};
 const call=(method,path='',body={},userId='alice')=>contentService({db,method,path:'/v1/projects/project/content'+path,body,userId,env,now:()=>time});
 const doc=async()=> put(db,'project','document','stored-document',documentInput({title:'A useful guide',markdown:'# A useful guide\n\nOriginal text with evidence.',locale:'en'}),0,'alice',time);
 const cms=async cfg=>sqlite.prepare('INSERT INTO content_cms VALUES(?,?,?,?)').run('project',1,seal(cfg,'project',env),JSON.stringify({type:cfg.type,configured:true}));
 const job=(id,kind='create',status='queued')=>sqlite.prepare('INSERT INTO content_jobs(id,project_id,actor,submission_id,input_hash,kind,input,status,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'project','alice',id,'hash',kind,'{}',status,0,1,1);
 return {db,sqlite,call,doc,cms,job,env,setTime:n=>time=n,close:()=>sqlite.close()};
}
test('content migration is repeatable and preserves existing project rows',async()=>{const f=await fixture();try{await migrateContent(f.db);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_projects').get().n,2);}finally{f.close();}});
test('owner boundaries and reviewer permissions are enforced',async()=>{const f=await fixture();try{await assert.rejects(f.call('GET','',{},'bob'),e=>e.status===404);await f.call('PUT','/access',{email:'review@test.test',role:'reviewer',expectedVersion:0});assert.equal((await f.call('GET','',{},'reviewer')).data.role,'reviewer');const d=await f.doc();await assert.rejects(f.call('PATCH','/documents/'+d.id,{expectedVersion:1,markdown:'No'},'reviewer'),e=>e.status===403);}finally{f.close();}});
test('editing requires an exact version and invalidates approval',async()=>{const f=await fixture();try{let d=await f.doc();await assert.rejects(f.call('PATCH','/documents/'+d.id,{markdown:'changed'}),e=>e.code==='EXPECTED_VERSION_REQUIRED');await assert.rejects(f.call('POST','/documents/'+d.id+'/review',{expectedVersion:1,status:'approved'}),e=>e.code==='FACT_REVIEW_REQUIRED');d=(await f.call('POST','/documents/'+d.id+'/review',{expectedVersion:1,status:'approved',factsChecked:true})).data;assert.equal(d.status,'approved');d=(await f.call('PATCH','/documents/'+d.id,{expectedVersion:2,markdown:'Changed'})).data;assert.equal(d.status,'draft');assert.equal(d.reviewedClaims,false);await assert.rejects(f.call('PATCH','/documents/'+d.id,{expectedVersion:2,markdown:'Overwrite'}),e=>e.status===409);}finally{f.close();}});
test('revision restore creates a new draft and retains history',async()=>{const f=await fixture();try{let d=await f.doc();await f.call('PATCH','/documents/'+d.id,{expectedVersion:1,markdown:'Second'});d=(await f.call('POST','/documents/'+d.id+'/restore',{expectedVersion:2,revision:1})).data;assert.equal(d.version,3);assert.match(d.markdown,/Original/);assert.equal((await f.call('GET','/documents/'+d.id+'/revisions')).data.length,3);}finally{f.close();}});
test('selected rewrites use unique original anchors and reject overlap',()=>{assert.equal(applyChanges('alpha beta',[{id:'a',original:'alpha',replacement:'new'}],['a']),'new beta');assert.throws(()=>applyChanges('aa aa',[{id:'x',original:'aa',replacement:'b'}],['x']));assert.throws(()=>applyChanges('alpha',[{id:'a',original:'alpha',replacement:'x'},{id:'b',original:'pha',replacement:'y'}],['a','b']));});
test('exports escape hostile HTML and unsupported URL schemes',()=>{const html=toHtml('# Heading\n<script>alert(1)</script>\n[evil](javascript:alert)\n[good](https://example.fi/)');assert.ok(!html.includes('<script>'));assert.ok(!html.includes('href="javascript:'));assert.match(html,/href="https:/);});
test('unsupported source references and fabricated perception quotes fail validation',()=>{assert.throws(()=>validateOutput('create',{title:'T',description:'D',markdown:'Text',claims:[{sourceIds:['invented']}],missingInformation:[]},{sources:[]}));assert.throws(()=>validateOutput('perception',{findings:[{evidenceId:'e',observedQuote:'fake',assessment:'inaccurate',verifiedFactId:'f'}],missingInformation:[]},{sources:[],brand:{facts:[{id:'f',verified:true}]},evidence:[{id:'e',answer:'Real answer'}]}));});
test('model requests reserve budget and retain uncertain charges on timeout',async()=>{const f=await fixture();try{const env={OPENROUTER_API_KEY:'secret',CONTENT_MODEL:'test/model',CONTENT_DAILY_BUDGET_USD:'0.5',CONTENT_PROJECT_DAILY_BUDGET_USD:'0.5',CONTENT_CALL_RESERVATION_USD:'0.5'};const args={db:f.db,job:{id:'job',project_id:'project'},kind:'create',input:{locale:'en',sources:[]},env,fetchFn:async()=>{throw Error('timeout');}};await assert.rejects(generate(args));assert.equal(f.sqlite.prepare('SELECT status FROM content_usage').get().status,'uncertain');await assert.rejects(generate(args),e=>e.code==='CONTENT_BUDGET_EXCEEDED');}finally{f.close();}});
test('CMS secrets are authenticated to the project and never returned by settings',async()=>{const f=await fixture();try{const value=seal({password:'secret'},'project',f.env);assert.equal(unseal(value,'project',f.env).password,'secret');assert.throws(()=>unseal(value,'other',f.env));await f.cms({type:'wordpress',baseUrl:'https://example.fi',username:'alice',password:'secret',expectedVersion:0});assert.ok(!JSON.stringify((await f.call('GET','/cms')).data).includes('secret'));}finally{f.close();}});
test('Google access uses operator mapping and paginates without accepting browser workspace IDs',async()=>{let calls=0;const report=await googleReport({projectId:'project',service:'gsc',view:'pages',startDate:'2026-01-01',endDate:'2026-01-02',env:{CONTENT_GOOGLE_WORKSPACES_JSON:'{"project":"trusted"}',GOOGLE_CONNECTOR_BASE_URL:'https://connector.example.org',GOOGLE_CONNECTOR_API_KEY:'key'},fetchFn:async(u,o)=>{assert.equal(o.headers['X-AIRank-Workspace-ID'],'trusted');calls++;return{ok:true,json:async()=>({rows:[{keys:['https://example.fi']}],nextOffset:calls===1?1:null,missingDates:[],metadata:[]})};}});assert.equal(calls,2);assert.equal(report.rows.length,2);assert.equal((await googleReport({projectId:'other',env:{}})).state,'not_connected');});
test('search metrics use impression weighting and overlap remains a candidate',()=>{const rows=[{keys:['p'],clicks:1,impressions:10,position:2},{keys:['p'],clicks:3,impressions:90,position:10}];assert.equal(aggregateGsc(rows)[0].position,9.2);assert.equal(aggregateGsc(rows)[0].ctr,0.04);const opportunities=searchOpportunities({rows}, {rows:[]},{rows:[{keys:['q','p'],impressions:40},{keys:['q','p2'],impressions:50}]});assert.ok(opportunities.some(o=>o.kind==='query_overlap'));});
test('public fetch rejects credentials, local hosts and non HTTPS input',()=>{for(const u of ['http://example.fi','https://127.0.0.1/','https://localhost/','https://user:pass@example.fi/','https://example.fi:8080/'])assert.throws(()=>publicUrl(u));});
test('robots matching respects specific agents and Allow precedence',()=>{assert.equal(robotsAllowed('User-agent: *\nDisallow: /private','/private/a'),false);assert.equal(robotsAllowed('User-agent: *\nDisallow: /\nAllow: /public','/public/a'),true);assert.equal(robotsAllowed('User-agent: *\nDisallow: /\nUser-agent: AIRankContent\nAllow: /','/a'),true);});
test('redirect destinations get their own robots check',async()=>{const calls=[];await assert.rejects(fetchPage('https://example.fi/a',{requestFn:async(u)=>{calls.push(u);if(u==='https://example.fi/robots.txt')return{status:404};if(u==='https://example.fi/a')return{status:302,headers:{location:'https://second.fi/a'}};return{status:200,text:'User-agent: *\nDisallow: /'};}}),e=>e.code==='ROBOTS_DISALLOWED');assert.ok(calls.includes('https://second.fi/robots.txt'));});
test('HTML audit exposes noindex and does not claim JS rendering',()=>{const p=parsePage('<html><title>A</title><meta content="noindex" name="robots"><main><h1>A</h1><p>Text</p><script>bad()</script></main></html>','https://example.fi/a');assert.ok(!p.markdown.includes('bad()'));assert.equal(p.renderedJavascript,false);assert.ok(audit(p).issues.some(i=>i.code==='noindex'));});
test('CMS selection returns remote modification values but never credentials',async()=>{const f=await fixture();try{await f.cms({type:'wordpress',baseUrl:'https://example.fi',username:'alice',password:'private-password',expectedVersion:0});const result=await cmsItems({db:f.db,projectId:'project',query:new URLSearchParams(),env:f.env,requestFn:async(u,o)=>{assert.ok(u.startsWith('https://example.fi/wp-json/wp/v2/posts?'));assert.ok(o.headers.authorization.startsWith('Basic '));return{status:200,headers:{'x-wp-totalpages':'2'},text:JSON.stringify([{id:12,title:{raw:'Existing article'},link:'https://example.fi/article',status:'publish',modified_gmt:'2026-10-21T10:00:00'}])};}});assert.equal(result.items[0].modified,'2026-10-21T10:00:00');assert.equal(result.totalPages,2);assert.ok(!JSON.stringify(result).includes('private-password'));}finally{f.close();}});

const retired=e=>e.status===410&&e.code==='LEGACY_CONTENT_RETIRED';
test('all legacy new-work routes are permanently retired, with no configuration opt-in',async()=>{
 const f=await fixture();try{
  for(const kind of ['import','sitemap','audit','research','rewrite','create','opportunities','perception','impact','publish'])await assert.rejects(f.call('POST','/jobs',{kind,input:{},submissionId:'retired-'+kind}),retired);
  for(const [method,path,body] of [['POST','/documents',{}],['POST','/bulk',{}],['POST','/jobs/old/retry',{}],['PUT','/settings',{enabled:true}],['PUT','/cms',{}]])await assert.rejects(f.call(method,path,body),retired);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM content_jobs').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM content_records').get().n,0);
  const caps=(await f.call('GET')).data.capabilities;assert.equal(caps.retired,true);assert.equal(caps.newWorkEnabled,false);
 }finally{f.close();}
});
test('retired enqueue and execution reject before any storage, source fetch, model or CMS call',async()=>{
 const forbidden=new Proxy({}, {get(){assert.fail('must not touch storage or dependencies');}});
 await assert.rejects(enqueue(forbidden,'project','alice','create',{},'new-request'),retired);
 await assert.rejects(runJob(forbidden),retired);
 assert.equal(await tick(forbidden,{run:()=>assert.fail('no run')}),false);await schedule(forbidden);
});
test('retired worker preserves every queued, running and uncertain job plus enabled automation unchanged',async()=>{
 const f=await fixture();try{
  for(const status of ['queued','running','uncertain','failed','completed'])f.job(status,status==='running'?'publish':'create',status);
  f.sqlite.exec("UPDATE content_jobs SET lease_until=0,attempt=2,checkpoint='{\"done\":true}'");
  await put(f.db,'project','settings','automation',{enabled:true,nextRunAt:0,refreshHours:24,locale:'en'},0,'alice');
  const before=f.sqlite.prepare('SELECT * FROM content_jobs ORDER BY id').all(),settings=await get(f.db,'project','settings','automation');
  await tick(f.db,{run:()=>assert.fail('must not run')});await schedule(f.db,Date.now());
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM content_jobs ORDER BY id').all(),before);assert.deepEqual(await get(f.db,'project','settings','automation'),settings);
 }finally{f.close();}
});
test('stored content remains readable, exportable and editable; queued work can still be cancelled',async()=>{
 const f=await fixture();try{
  const d=await f.doc();f.job('cancel-old');
  assert.equal((await f.call('GET','/documents')).data.length,1);
  assert.equal((await f.call('GET','/documents/'+d.id)).data.title,d.title);
  assert.equal((await f.call('GET','/documents/'+d.id+'/export')).status,200);
  assert.equal((await f.call('GET','/documents/'+d.id+'/revisions')).data.length,1);
  await f.call('PATCH','/documents/'+d.id,{expectedVersion:1,markdown:'Preserved edit'});
  await f.call('POST','/jobs/cancel-old/cancel',{});assert.equal(f.sqlite.prepare('SELECT status FROM content_jobs').get().status,'cancelled');
  assert.equal((await f.call('GET','/jobs/cancel-old')).data.status,'cancelled');
 }finally{f.close();}
});
test('uncertain publications remain manually reconcilable without replaying outbound publishing',async()=>{
 const f=await fixture();try{
  f.job('old-publish','publish','uncertain');await put(f.db,'project','publication','old-publish',{status:'uncertain',documentId:'stored-document'},0,'alice');
  const r=await f.call('POST','/publications/old-publish/reconcile',{expectedVersion:1,verifiedInCms:true,status:'not_published'});
  assert.equal(r.data.status,'not_published');assert.equal(f.sqlite.prepare('SELECT status FROM content_jobs').get().status,'completed');
  assert.equal((await f.call('GET','/publications')).data.length,1);
 }finally{f.close();}
});
