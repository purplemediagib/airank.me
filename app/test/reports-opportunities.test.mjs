import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './research.test.mjs';
import {migrateReports} from '../src/reports/migration.mjs';
import {migrateOpportunities} from '../src/opportunities/migration.mjs';
import {reportService,measurementSettingsService,selectedRoutes} from '../src/reports/service.mjs';
import {opportunityService} from '../src/opportunities/service.mjs';
test('opportunities keep completed actions, deduplicate refresh and require owned versioned updates',async()=>{
 const f=await fixture();try{
 await migrateOpportunities(f.db);
 // Complete run composition metadata in the common fixture.
 const s=JSON.parse(f.sql.prepare('SELECT snapshot FROM mon_runs').get().snapshot);
 s.prompts=[{id:'p',version:1,text:'Mitkä palvelut ovat hyviä?',topic:''}];s.routes=[{provider:'openai',model:'fixture'}];
 f.sql.prepare('UPDATE mon_runs SET snapshot=?').run(JSON.stringify(s));
 const call=(method,body,userId='alice',suffix='')=>opportunityService({db:f.db,method,path:'/v1/projects/project/opportunities'+suffix,body,userId,now:()=>1000});
 assert.deepEqual((await call('GET')).data,[]);
 let a=(await call('POST',{refresh:true})).data;assert.equal(a.length,1);assert.equal(a[0].kind,'visibility_gap');
 const id=a[0].id;
 await call('PATCH',{expectedVersion:1,status:'completed',notes:'Tarkistettu äö'},'alice','/'+id);
 a=(await call('POST',{refresh:true})).data;assert.equal(a.length,1);assert.equal(a[0].status,'completed');assert.equal(a[0].notes,'Tarkistettu äö');
 assert.equal(a[0].history.length,2);
 await assert.rejects(call('PATCH',{expectedVersion:1,status:'new',notes:''},'alice','/'+id),e=>e.status===409);
 await assert.rejects(call('GET',null,'bob'),e=>e.status===404);
 assert.equal(f.sql.prepare('SELECT status FROM mon_runs').get().status,'completed');
 }finally{f.sql.close();}
});
test('reports freeze full filtered evidence, locale, ownership and expiry; settings only affect future routes',async()=>{
 const f=await fixture();try{
 await migrateReports(f.db);await migrateReports(f.db);
 const s=JSON.parse(f.sql.prepare('SELECT snapshot FROM mon_runs').get().snapshot);s.prompts=[{id:'p',version:1,text:'Mitkä palvelut ovat hyviä?',topic:''}];s.routes=[{provider:'openai',model:'fixture'}];
 f.sql.prepare('UPDATE mon_runs SET snapshot=?').run(JSON.stringify(s));
 let now=1000;
 const call=(method,body,userId='alice',suffix='')=>reportService({db:f.db,method,path:'/v1/projects/project/reports'+suffix,body,userId,now:()=>now});
 const report=(await call('POST',{locale:'fi',filters:{},title:'Ääkköset – lokakuu',sections:['questions']})).data;
 assert.equal(report.title,'Ääkköset – lokakuu');assert.deepEqual(report.snapshot.sections,['questions']);
 assert.equal((await call('GET')).data[0].title,report.title);
 assert.equal(report.snapshot.runSnapshots.length,1);
 await assert.rejects(call('POST',{locale:'fi',filters:{},title:''}),e=>e.status===422);
 await assert.rejects(call('POST',{locale:'fi',filters:{},sections:['invented']}),e=>e.status===422);
 assert.equal(report.snapshot.analytics.metrics.eligible,1);assert.equal(report.snapshot.analytics.evidence.length,1);
 assert.ok(report.snapshot.analytics.evidence[0].text.includes('Mitkä'));
 f.sql.prepare("UPDATE mon_evidence SET payload=json_set(payload,'$.answer','Changed')").run();
 assert.notEqual((await call('GET',null,'alice','/'+report.id)).data.snapshot.analytics.evidence[0].answer,'Changed');
 assert.deepEqual((await call('GET',null,'alice','/'+report.id)).data,report);
 await assert.rejects(call('GET',null,'bob','/'+report.id),e=>e.status===404);
 now=report.expiresAt;await assert.rejects(call('GET',null,'alice','/'+report.id),e=>e.status===410);
 const env={ENABLED_PROVIDERS:'openai,claude'};
 const settings=body=>measurementSettingsService({db:f.db,method:body?'PATCH':'GET',path:'/v1/projects/project/measurement-settings',body,userId:'alice',env});
 assert.equal((await settings()).data.providers.length,2);
 await settings({expectedVersion:0,providers:['openai']});
 assert.deepEqual(Object.keys(await selectedRoutes(f.db,'project',env)),['openai']);
 assert.equal(JSON.parse(f.sql.prepare('SELECT snapshot FROM mon_runs').get().snapshot).routes[0].provider,'openai');
 await assert.rejects(settings({expectedVersion:0,providers:['claude']}),e=>e.status===409);
 await assert.rejects(settings({expectedVersion:1,providers:[]}),e=>e.status===422);
 }finally{f.sql.close();}
});
test('reports retain complete multi-tag filters and accept numeric prompt versions from generated clients',async()=>{
 const f=await fixture();try{
  await migrateReports(f.db);
  const tags=Array.from({length:12},(_,i)=>`tag-${i}-`+'x'.repeat(30));
  const s=JSON.parse(f.sql.prepare('SELECT snapshot FROM mon_runs').get().snapshot);
  s.language='en';s.prompts=[{id:'p',version:1,text:'Mitkä palvelut ovat hyviä?',topic:'',tags}];s.routes=[{provider:'openai',model:'fixture'}];
  f.sql.prepare('UPDATE mon_runs SET snapshot=?').run(JSON.stringify(s));
  f.sql.prepare('INSERT INTO mon_prompts VALUES (?,?,?,?,?,?)').run('p','project',1,'active','hash',1);
  const filters={tags:JSON.stringify(tags),tagMode:'and',market:'FI',language:'en',promptId:'p',promptVersion:1};
  const report=(await reportService({db:f.db,method:'POST',path:'/v1/projects/project/reports',userId:'alice',body:{locale:'en',filters},now:()=>1000})).data;
  assert.equal(report.snapshot.filters.tags,filters.tags);
  assert.equal(report.snapshot.filters.promptVersion,'1');
  assert.equal(report.snapshot.measurementLanguage,'en');
  assert.equal(report.snapshot.analytics.metrics.expected,1);
  assert.deepEqual(report.snapshot.analytics.evidence[0].tags,tags);
 }finally{f.sql.close();}
});
