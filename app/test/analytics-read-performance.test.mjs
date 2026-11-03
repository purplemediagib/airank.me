import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrations} from '../src/migrate.mjs';
import {appDDL} from '../src/app/migration.mjs';
import {ddl as monitoringDDL} from '../src/monitoring/migration.mjs';
import {ddl as intelligenceDDL} from '../src/intelligence/migration.mjs';
import {ddl as sentimentDDL} from '../src/sentiment/migration.mjs';
import {migrateAnalyticsReads,id,checksum} from '../src/analytics/read-migration.mjs';
import {loadJobs,indexJobs,attachSentiment} from '../src/sentiment/read.mjs';
import {config,inputHash} from '../src/sentiment/core.mjs';

function fixture(){
 const sql=new DatabaseSync(':memory:');
 for(const q of [...migrations,...appDDL,...monitoringDDL,...intelligenceDDL,...sentimentDDL])sql.exec(q);
 sql.exec('CREATE TABLE app_migrations (id TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
 const execute=async q=>{const text=typeof q==='string'?q:q.sql,args=typeof q==='string'?[]:q.args||[],s=sql.prepare(text);return /^\s*(SELECT|PRAGMA|EXPLAIN)/.test(text)?{rows:s.all(...args)}:{rows:[],rowsAffected:Number(s.run(...args).changes)};};
 const db={execute,transaction:async()=>{sql.exec('BEGIN');return {execute,commit:async()=>sql.exec('COMMIT'),rollback:async()=>sql.exec('ROLLBACK'),close:()=>{}};}};
 sql.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run('alice','alice','alice@example.test','Alice','',1,1);
 sql.prepare('INSERT INTO app_projects VALUES (?,?,?,?,?)').run('project','alice','active',1,'2026-01-01');
 const run=(id,createdAt)=>{
  sql.prepare('INSERT INTO mon_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'project','alice',id,id,'neutral','complete','{}',1,createdAt,createdAt+1000,null);
  sql.prepare('INSERT INTO mon_tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,id,'p',1,'Question','openai','{}','done',null,null);
  sql.prepare('INSERT INTO mon_evidence VALUES (?,?,?,?)').run(id,id,'{"answer":"preserve me"}',createdAt);
 };
 const job=(id,runId,createdAt)=>sql.prepare('INSERT INTO sentiment_jobs (evidence_id,run_id,analysis_version,requested_model,input_hash,status,created_at) VALUES (?,?,?,?,?,?,?)').run(id,runId,'v','fixture','fixture','queued',createdAt);
 return {sql,db,run,job};
}

test('sentiment window uses inclusive run time, not analysis time, and retains access checks',async()=>{
 const f=fixture();try{
  for(const [id,at] of [['old',99],['previous',100],['current',200],['last',299],['future',300]]){f.run(id,at);f.job(id,id,500-at);}
  const all=await loadJobs(f.db,'project','alice');
  assert.equal(all.length,5);
  const bounded=await loadJobs(f.db,'project','alice',null,{from:100,to:299});
  assert.deepEqual(bounded.map(j=>j.evidence_id),['previous','current','last']);
  assert.deepEqual((await loadJobs(f.db,'project','alice',['old','current'],{from:100,to:299})).map(j=>j.evidence_id),['current']);
  assert.deepEqual(await loadJobs(f.db,'project','alice',[]),[]);
  await assert.rejects(loadJobs(f.db,'project','bob',null,{from:100,to:299}),e=>e.status===404);
 }finally{f.sql.close();}
});

test('indexed sentiment lookup matches the first-row/version fallback exactly',()=>{
 const env={SENTIMENT_ENABLED:'true'},version=config(env).version;
 const identity={brandName:'Example',aliases:[],ownedDomains:['example.test']};
 const snapshot={identity,kind:'neutral',language:'en',cohort:{brands:[identity]}};
 const e={id:'e',answer:'Example is useful.',status:'success'};
 const row=(analysis_version,error)=>({evidence_id:'e',analysis_version,error,status:'failed',input_hash:inputHash(e,snapshot)});
 const jobs=[row('other','NEWEST_FALLBACK'),row(version,'PREFERRED_VERSION'),row(version,'TIED_LATER_ROW')];
 for(const rows of [jobs,jobs.filter(j=>j.analysis_version!==version),[],null]){
  assert.deepEqual(attachSentiment(e,snapshot,indexJobs(rows),env),attachSentiment(e,snapshot,rows,env));
 }
 assert.equal(attachSentiment(e,snapshot,indexJobs(jobs),env).sentimentAnalysis.error,'PREFERRED_VERSION');
 assert.equal(indexJobs(null),null);
});

test('additive analytics migration is idempotent, preserves data, and adds selective plans',async()=>{
 const f=fixture();try{
  f.run('r',100);f.job('r','r',200);
  const before=f.sql.prepare('SELECT * FROM mon_evidence').all();
  const evidence='EXPLAIN QUERY PLAN SELECT e.payload FROM mon_evidence e JOIN mon_runs r ON r.id=e.run_id WHERE r.project_id=? AND r.created_at>=? AND r.created_at<=?';
  const intelligence='EXPLAIN QUERY PLAN SELECT * FROM intelligence_jobs WHERE analysis_version=? AND run_id IN (?,?)';
  assert.ok(f.sql.prepare(evidence).all('project',0,200).some(r=>r.detail==='SCAN e'));
  assert.ok(f.sql.prepare(intelligence).all('v','r','s').some(r=>r.detail==='SCAN intelligence_jobs'));
  await migrateAnalyticsReads(f.db);await migrateAnalyticsReads(f.db);
  assert.deepEqual(f.sql.prepare('SELECT * FROM mon_evidence').all(),before);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM app_migrations WHERE id=?').get(id).n,1);
  assert.equal(f.sql.prepare('SELECT checksum FROM app_migrations WHERE id=?').get(id).checksum,checksum);
  assert.ok(f.sql.prepare(evidence).all('project',0,200).some(r=>/USING INDEX mon_evidence_run/.test(r.detail)));
  assert.ok(f.sql.prepare(intelligence).all('v','r','s').some(r=>/USING INDEX intelligence_run_analysis/.test(r.detail)));
  assert.ok(f.sql.prepare('EXPLAIN QUERY PLAN SELECT * FROM mon_runs WHERE project_id=? ORDER BY created_at,id').all('project').some(r=>/USING INDEX mon_runs_project_created/.test(r.detail)));
  f.sql.prepare('UPDATE app_migrations SET checksum=? WHERE id=?').run('changed',id);
  await assert.rejects(migrateAnalyticsReads(f.db),/checksum mismatch/);
 }finally{f.sql.close();}
});

test('failed migration rolls back partial indexes and never marks success',async()=>{
 const f=fixture();try{
  f.sql.exec('DROP TABLE intelligence_jobs');
  await assert.rejects(migrateAnalyticsReads(f.db),/no such table/);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='mon_evidence_run'").get().n,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM app_migrations WHERE id=?').get(id).n,0);
 }finally{f.sql.close();}
});
