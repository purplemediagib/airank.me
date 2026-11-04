import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrations} from '../src/migrate.mjs';
import {migrateApp} from '../src/app/migration.mjs';
import {migrateProjectScans} from '../src/app/scan-migration.mjs';
import {migrateMonitoring} from '../src/monitoring/migration.mjs';
import {migrateResearch} from '../src/research/migration.mjs';
import {researchService,frozenCohort,redact,candidateNames} from '../src/research/service.mjs';
import {migrateSuggestions} from '../src/monitoring/suggestions-migration.mjs';
import {migrateContextDrafts} from '../src/common/context-migration.mjs';
export async function fixture(){
 const sql=new DatabaseSync(':memory:');for(const s of migrations)sql.exec(s);
 const execute=async q=>{const text=typeof q==='string'?q:q.sql,args=typeof q==='string'?[]:q.args||[],s=sql.prepare(text);return /^\s*SELECT|RETURNING/i.test(text)?{rows:s.all(...args)}:{rows:[],rowsAffected:Number(s.run(...args).changes)};};
 let tail=Promise.resolve();
 const db={execute,transaction:async()=>{let release;const next=new Promise(r=>release=r),last=tail;tail=next;await last;sql.exec('BEGIN');return{execute,commit:async()=>sql.exec('COMMIT'),rollback:async()=>sql.exec('ROLLBACK'),close:release};}};
 await migrateApp(db);await migrateProjectScans(db);await migrateMonitoring(db);await migrateResearch(db);await migrateContextDrafts(db);await migrateSuggestions(db);
 const identity={brandName:'Example',aliases:[],ownedDomains:['example.fi'],categoryFi:'palvelut'};
 sql.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run('alice','a','a@test.test','A','',1,1);
 sql.prepare('INSERT INTO app_projects VALUES (?,?,?,?,?)').run('project','alice','active',1,1);
 sql.prepare('INSERT INTO app_identity_versions VALUES (?,?,?,?)').run('project',1,JSON.stringify(identity),1);
 const snapshot={identity,identityVersion:1,kind:'neutral',prompts:[],routes:[],methodology:'test',market:'FI',language:'fi'};
 sql.prepare('INSERT INTO mon_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('run','project','alice','submission','hash','neutral','completed',JSON.stringify(snapshot),1,1,2,null);
 sql.prepare('INSERT INTO mon_tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('e','run','p',1,'Mitkä palvelut ovat hyviä?','openai','{}','done',null,null);
 const e={id:'e',runId:'run',promptId:'p',promptVersion:1,text:'Mitkä palvelut ovat hyviä?',provider:'openai',model:'fixture',status:'success',observedAt:1,answer:'1. Rival — palvelu\n2. Other — vaihtoehto\n<script>alert(1)</script>',citations:[{url:'https://sub.example.fi/a#x'},{url:'https://sub.example.fi/a#y'},{url:'javascript:alert(1)'}]};
 sql.prepare('INSERT INTO mon_evidence VALUES (?,?,?,?)').run('e','run',JSON.stringify(e),1);
 const request=(body,userId='alice',path='/v1/projects/project/research')=>researchService({db,method:body?'POST':'GET',body,userId,path});
 return{db,sql,identity,request};
}
test('research CRUD, provenance, cohort snapshots, duplicates, private raw and owner isolation',async()=>{
 const f=await fixture();try{
 let a=(await f.request()).data;assert.equal(a.candidates.length,2);assert.equal(a.sources.length,1);assert.equal(a.sources[0].answers,1);assert.equal(a.sources[0].owned,true);
 const rival=a.candidates.find(c=>c.name==='Rival');
 a=(await f.request({action:'accept',id:rival.id,expectedVersion:0,name:'Rival',aliases:[],domains:[]})).data;
 assert.equal(a.version,1);assert.equal(a.competitors[0].domains.length,0);assert.equal(a.candidates.find(c=>c.id===rival.id).status,'accepted');
 const frozen=await frozenCohort(f.db,'project',f.identity);
 await assert.rejects(f.request({action:'create',expectedVersion:1,name:'Rival',aliases:[],domains:[]}),e=>e.status===409);
 a=(await f.request({action:'archive',id:a.competitors[0].id,expectedVersion:1})).data;
 assert.equal(frozen.brands.length,2);assert.equal((await frozenCohort(f.db,'project',f.identity)).brands.length,1);
 assert.equal((await f.db.execute({sql:'SELECT COUNT(*) n FROM app_cohorts',args:[]})).rows[0].n,2);
 await assert.rejects(f.request(null,'bob'),e=>e.status===404);
 await assert.rejects(f.request(null,'bob','/v1/projects/project/evidence/e'),e=>e.status===404);
 const raw=(await f.request(null,'alice','/v1/projects/project/evidence/e')).data;
 assert.ok(raw.raw.answer.includes('<script>'));assert.equal(raw.evidence.citations.length,2); // literal data, never HTML.
 assert.deepEqual(redact({headers:{Authorization:'secret'},apiKey:'secret',ok:'Bearer abc123'}),{ok:'[REDACTED]'});
 assert.deepEqual(candidateNames('This could be any Company. No structured label.'),[]);
 }finally{f.sql.close();}
});

test('research deduplicates run snapshots, while answer detail reads only its authorized row',async()=>{
 const f=await fixture();try{
  const calls=[];const execute=f.db.execute;
  f.db.execute=async q=>{calls.push(q);return execute(q);};
  const original=(await f.request()).data;
  assert.equal(original.evidence.length,1);
  const texts=calls.map(q=>typeof q==='string'?q:q.sql);
  assert.ok(texts.some(s=>s.startsWith('SELECT r.id,r.snapshot FROM mon_runs')));
  assert.ok(texts.some(s=>s.startsWith('SELECT e.run_id,e.payload FROM mon_evidence')));
  assert.equal(texts.some(s=>s.startsWith('SELECT e.payload,r.snapshot FROM mon_evidence')),false);
  // An unrelated malformed answer must never make an existing answer unreadable.
  f.sql.prepare('INSERT INTO mon_tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('broken','run','other-prompt',1,'Question','openai','{}','done',null,null);
  f.sql.prepare('INSERT INTO mon_evidence VALUES (?,?,?,?)').run('broken','run','not-json',2);
  calls.length=0;
  const detail=(await f.request(null,'alice','/v1/projects/project/evidence/e')).data;
  assert.deepEqual(detail.evidence,original.evidence[0]);
  const targeted=calls.filter(q=>typeof q!=='string'&&q.sql.startsWith('SELECT e.payload,r.snapshot'));
  assert.equal(targeted.length,1);
  assert.deepEqual(targeted[0].args,['project','e']);
  assert.ok(targeted[0].sql.includes('AND e.id=?'));
  await assert.rejects(f.request(null,'alice','/v1/projects/project/evidence/missing'),e=>e.status===404);
  await assert.rejects(f.request(null,'bob','/v1/projects/project/evidence/e'),e=>e.status===404);
 }finally{f.sql.close();}
});

test('a concurrently completed first answer cannot appear without its snapshot',async()=>{
 const f=await fixture();try{
  const execute=f.db.execute;let inserted=false;
  f.db.execute=async q=>{
   const result=await execute(q);
   if(!inserted&&q.sql.startsWith('SELECT e.run_id,e.payload')){
    inserted=true;
    const snapshot=f.sql.prepare('SELECT snapshot FROM mon_runs WHERE id=?').get('run').snapshot;
    f.sql.prepare('INSERT INTO mon_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('new-run','project','alice','new-submission','new-hash','neutral','completed',snapshot,1,3,4,null);
    f.sql.prepare('INSERT INTO mon_tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('new-answer','new-run','p',1,'Question','openai','{}','done',null,null);
    const raw=JSON.parse(f.sql.prepare('SELECT payload FROM mon_evidence WHERE id=?').get('e').payload);
    f.sql.prepare('INSERT INTO mon_evidence VALUES (?,?,?,?)').run('new-answer','new-run',JSON.stringify({...raw,id:'new-answer',runId:'new-run'}),3);
   }
   return result;
  };
  const first=(await f.request()).data;assert.equal(first.evidence.length,1);assert.ok(inserted);
  const next=(await f.request()).data;assert.equal(next.evidence.length,2);
  assert.ok(next.evidence.some(e=>e.id==='new-answer'));
 }finally{f.sql.close();}
});
