import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createClient} from '@libsql/client';
import {migrations} from '../src/migrate.mjs';
import {appDDL} from '../src/app/migration.mjs';
import {scanDDL} from '../src/app/scan-migration.mjs';
import {ddl as monitoringDDL} from '../src/monitoring/migration.mjs';
import {ddl as intelligenceDDL} from '../src/intelligence/migration.mjs';
import {ddl as sentimentDDL} from '../src/sentiment/migration.mjs';
import {ddl as researchDDL} from '../src/research/migration.mjs';
import {ddl as reportsDDL} from '../src/reports/migration.mjs';
import {migrateAnalyticsSummary,id,checksum,ddl} from '../src/analytics/summary-migration.mjs';

function fixture(){
 const sql=new DatabaseSync(':memory:');
 sql.exec('PRAGMA foreign_keys=OFF');
 for(const statement of [...migrations,...appDDL,scanDDL,...monitoringDDL,...intelligenceDDL,...sentimentDDL,...researchDDL,...reportsDDL])sql.exec(statement);
 sql.exec('CREATE TABLE app_migrations(id TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
 sql.exec(`INSERT INTO users VALUES ('alice','alice','alice@example.test','Alice','',1,1);
 INSERT INTO app_projects VALUES ('a','alice','active',1,'2026-01-01'),('b','alice','active',1,'2026-01-01');
 INSERT INTO app_identity_versions VALUES ('a',1,'{}','2026-01-01'),('b',1,'{}','2026-01-01');
 INSERT INTO mon_prompts VALUES ('pa','a',1,'active','pa',1),('pb','b',1,'active','pb',1);
 INSERT INTO mon_runs VALUES ('ra','a','alice','ra','ra','neutral','complete','{}',1,1,2,NULL),('rb','b','alice','rb','rb','neutral','complete','{}',1,1,2,NULL);
 INSERT INTO mon_tasks VALUES ('ta','ra','pa',1,'Question','openai','{}','done',NULL,NULL),('tb','rb','pb',1,'Question','openai','{}','done',NULL,NULL);
 INSERT INTO app_migrations VALUES ('app-001-identity-projects','original-checksum','2026-01-01')`);
 const execute=async q=>{
  const statement=typeof q==='string'?q:q.sql,args=typeof q==='string'?[]:q.args||[],prepared=sql.prepare(statement);
  return /^\s*(SELECT|PRAGMA|EXPLAIN)/.test(statement)?{rows:prepared.all(...args)}:{rows:[],rowsAffected:Number(prepared.run(...args).changes)};
 };
 const db={execute,transaction:async()=>{sql.exec('BEGIN');return {execute,commit:async()=>sql.exec('COMMIT'),rollback:async()=>sql.exec('ROLLBACK'),close:()=>{}};}};
 const revision=project=>sql.prepare('SELECT revision FROM analytics_project_revisions WHERE project_id=?').get(project)?.revision;
 return {sql,db,revision};
}
const sourceMutations=[
 ['app_identity_versions',"INSERT INTO app_identity_versions VALUES ('a',2,'{}','2026-01-01')","UPDATE app_identity_versions SET identity_json='{\"market\":\"FI\"}' WHERE project_id='a' AND version=2","DELETE FROM app_identity_versions WHERE project_id='a' AND version=2"],
 ['app_audit_events',"INSERT INTO app_audit_events VALUES ('audit','alice','a','updated',1,'2026-01-01')","UPDATE app_audit_events SET kind='changed' WHERE id='audit'","DELETE FROM app_audit_events WHERE id='audit'"],
 ['app_project_scans',"INSERT INTO app_project_scans VALUES ('scan','a',1,'alice','scan','hash',1)","UPDATE app_project_scans SET created_at=2 WHERE scan_id='scan'","DELETE FROM app_project_scans WHERE scan_id='scan'"],
 ['mon_runs',"INSERT INTO mon_runs VALUES ('r','a','alice','r','r','neutral','queued','{}',1,1,2,NULL)","UPDATE mon_runs SET status='complete' WHERE id='r'","DELETE FROM mon_runs WHERE id='r'"],
 ['mon_tasks',"INSERT INTO mon_tasks VALUES ('t','ra','other',1,'Question','openai','{}','queued',NULL,NULL)","UPDATE mon_tasks SET status='done' WHERE id='t'","DELETE FROM mon_tasks WHERE id='t'"],
 ['mon_evidence',"INSERT INTO mon_evidence VALUES ('ta','ra','{}',1)","UPDATE mon_evidence SET payload='{\"answer\":\"new\"}' WHERE id='ta'","DELETE FROM mon_evidence WHERE id='ta'"],
 ['sentiment_jobs',"INSERT INTO sentiment_jobs(evidence_id,run_id,analysis_version,requested_model,input_hash,status,created_at) VALUES ('ta','ra','v','m','h','queued',1)","UPDATE sentiment_jobs SET status='done',result_json='{}' WHERE evidence_id='ta'","DELETE FROM sentiment_jobs WHERE evidence_id='ta'"],
 ['intelligence_jobs',"INSERT INTO intelligence_jobs(evidence_id,run_id,analysis_version,requested_model,input_hash,status,created_at) VALUES ('ta','ra','v','m','h','queued',1)","UPDATE intelligence_jobs SET status='done',result_json='{}' WHERE evidence_id='ta'","DELETE FROM intelligence_jobs WHERE evidence_id='ta'"],
 ['mon_prompts',"INSERT INTO mon_prompts VALUES ('p','a',1,'active','p',1)","UPDATE mon_prompts SET version=2 WHERE id='p'","DELETE FROM mon_prompts WHERE id='p'"],
 ['mon_prompt_versions',"INSERT INTO mon_prompt_versions VALUES ('pa',1,'{}',1)","UPDATE mon_prompt_versions SET payload='{\"tags\":[\"new\"]}' WHERE prompt_id='pa'","DELETE FROM mon_prompt_versions WHERE prompt_id='pa'"],
 ['intelligence_reviews',"INSERT INTO intelligence_reviews VALUES ('a','source','example.test','corporate',1)","UPDATE intelligence_reviews SET value='editorial' WHERE project_id='a'","DELETE FROM intelligence_reviews WHERE project_id='a'"],
 ['intelligence_review_audit',"INSERT INTO intelligence_review_audit VALUES ('review','a','source','example.test','corporate',1)","UPDATE intelligence_review_audit SET value='editorial' WHERE project_id='a'","DELETE FROM intelligence_review_audit WHERE project_id='a'"],
 ['app_cohorts',"INSERT INTO app_cohorts VALUES ('a',1,'[]',1)","UPDATE app_cohorts SET payload='[{}]' WHERE project_id='a'","DELETE FROM app_cohorts WHERE project_id='a'"],
 ['app_brand_reviews',"INSERT INTO app_brand_reviews VALUES ('a','brand','{}')","UPDATE app_brand_reviews SET payload='{\"status\":\"accepted\"}' WHERE project_id='a'","DELETE FROM app_brand_reviews WHERE project_id='a'"],
 ['app_measurement_settings',"INSERT INTO app_measurement_settings VALUES ('a',1,'[]',1)","UPDATE app_measurement_settings SET version=2,providers='[\"openai\"]' WHERE project_id='a'","DELETE FROM app_measurement_settings WHERE project_id='a'"],
];

test('summary migration is additive, explicit, checksummed and idempotent',async()=>{
 const f=fixture();try{
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'analytics_%'").get().n,0);
  const before=f.sql.prepare('SELECT * FROM mon_runs').all(),history=f.sql.prepare('SELECT * FROM app_migrations').all();
  await migrateAnalyticsSummary(f.db);await migrateAnalyticsSummary(f.db);
  assert.deepEqual(f.sql.prepare('SELECT * FROM mon_runs').all(),before);
  assert.deepEqual(f.sql.prepare('SELECT * FROM app_migrations WHERE id<>?').all(id),history);
  assert.equal(f.sql.prepare('SELECT checksum FROM app_migrations WHERE id=?').get(id).checksum,checksum);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM app_migrations WHERE id=?').get(id).n,1);
  assert.equal(f.revision('a'),1);assert.equal(f.revision('b'),1);
  f.sql.prepare('UPDATE app_migrations SET checksum=? WHERE id=?').run('drift',id);
  await assert.rejects(migrateAnalyticsSummary(f.db),/checksum mismatch/);
 }finally{f.sql.close();}
});

const unrelatedTables=new Set(['intelligence_review_audit','app_cohorts','app_brand_reviews','app_measurement_settings']);
for(const [table,...mutations] of sourceMutations.filter(([table])=>!unrelatedTables.has(table)))test(`${table} insert/update/delete atomically invalidate only its project`,async()=>{
 const f=fixture();try{
  await migrateAnalyticsSummary(f.db);
  for(const mutation of mutations){
   const before=f.revision('a'),unrelated=f.revision('b');
   f.sql.exec(mutation);
   assert.equal(f.revision('a'),before+1,mutation);
   assert.equal(f.revision('b'),unrelated,mutation);
  }
 }finally{f.sql.close();}
});

test('project insertion, identity/version, status and owner updates invalidate',async()=>{
 const f=fixture();try{
  await migrateAnalyticsSummary(f.db);
  f.sql.exec("INSERT INTO app_projects VALUES ('c','alice','active',1,'2026-01-01')");
  assert.equal(f.revision('c'),1);
  for(const update of ["version=2","status='archived'","owner_id='bob'"]){
   const before=f.revision('c');f.sql.exec(`UPDATE app_projects SET ${update} WHERE id='c'`);assert.equal(f.revision('c'),before+1);
  }
  assert.equal(f.revision('a'),1);assert.equal(f.revision('b'),1);
 }finally{f.sql.close();}
});

for(const table of ['sentiment_state','intelligence_state'])test(`${table} worker bookkeeping does not invalidate projects`,async()=>{
 const f=fixture();try{
  await migrateAnalyticsSummary(f.db);
  for(const mutation of [`INSERT INTO ${table} VALUES ('enabled_since','1')`,`UPDATE ${table} SET value='2'`,`DELETE FROM ${table}`]){
   const before=['a','b'].map(f.revision);f.sql.exec(mutation);
   assert.deepEqual(['a','b'].map(f.revision),before);
  }
 }finally{f.sql.close();}
});

test('annotation migration availability changes invalidate, unrelated history does not',async()=>{
 const f=fixture();try{
  await migrateAnalyticsSummary(f.db);
  for(const mutation of ["INSERT INTO app_migrations VALUES ('app-015-evidence-intelligence','v','date')","UPDATE app_migrations SET checksum='other' WHERE id='app-015-evidence-intelligence'","DELETE FROM app_migrations WHERE id='app-015-evidence-intelligence'"]){
   const before=['a','b'].map(f.revision);f.sql.exec(mutation);
   assert.deepEqual(['a','b'].map(f.revision),before.map(n=>n+1));
  }
  const before=['a','b'].map(f.revision);
  f.sql.exec("INSERT INTO app_migrations VALUES ('unrelated','v','date')");
  assert.deepEqual(['a','b'].map(f.revision),before);
 }finally{f.sql.close();}
});

test('ownership moves invalidate old and new projects exactly once',async()=>{
 const f=fixture();try{
  await migrateAnalyticsSummary(f.db);
  for(const [setup,move] of [
   ["INSERT INTO app_audit_events VALUES ('audit','alice','a','kind',1,'date')","UPDATE app_audit_events SET project_id='b' WHERE id='audit'"],
   ["INSERT INTO mon_prompt_versions VALUES ('pa',1,'{}',1)","UPDATE mon_prompt_versions SET prompt_id='pb' WHERE prompt_id='pa'"],
   ["INSERT INTO mon_evidence VALUES ('ta','ra','{}',1)","UPDATE mon_evidence SET run_id='rb' WHERE id='ta'"],
   ["INSERT INTO sentiment_jobs(evidence_id,run_id,analysis_version,requested_model,input_hash,status,created_at) VALUES ('ta','ra','v','m','h','queued',1)","UPDATE sentiment_jobs SET run_id='rb' WHERE evidence_id='ta'"],
   [null,"UPDATE mon_tasks SET run_id='rb' WHERE id='ta'"],
   [null,"UPDATE mon_runs SET project_id='b' WHERE id='ra'"],
   [null,"UPDATE mon_prompts SET project_id='b' WHERE id='pa'"],
  ]){
   if(setup)f.sql.exec(setup);
   const before=['a','b'].map(f.revision);f.sql.exec(move);
   assert.deepEqual(['a','b'].map(f.revision),before.map(n=>n+1),move);
  }
 }finally{f.sql.close();}
});

test('source transaction rollback also rolls back invalidation',async()=>{
 const f=fixture();try{
  await migrateAnalyticsSummary(f.db);
  const before=f.revision('a');
  f.sql.exec("BEGIN; UPDATE mon_runs SET status='running' WHERE id='ra'");
  assert.equal(f.revision('a'),before+1);
  f.sql.exec('ROLLBACK');
  assert.equal(f.revision('a'),before);
  assert.equal(f.sql.prepare("SELECT status FROM mon_runs WHERE id='ra'").get().status,'complete');
 }finally{f.sql.close();}
});

function seedProjection(sql,project='a',query='q',generation='g'){
 sql.prepare('INSERT INTO analytics_summary_requests(project_id,query_key,query_json,format_version,requested_at,last_requested_at) VALUES (?,?,?,?,?,?)').run(project,query,'{}','v',1,1);
 sql.prepare('INSERT INTO analytics_summary_generations VALUES (?,?,?,?,?,?,?,?,?,?)').run(generation,project,query,1,'v',1,100,1,'{}',1);
 sql.prepare('INSERT INTO analytics_summary_heads VALUES (?,?,?)').run(project,query,generation);
 sql.prepare('INSERT OR IGNORE INTO analytics_summary_payloads VALUES (?,?,?,?,?,?,?,?,?,?)').run('payload','{}','answer','[]',0,0,0,0,0,0);
 sql.prepare('INSERT INTO analytics_summary_evidence VALUES (?,?,?,?)').run(generation,0,'answer','payload');
}

for(const foreignKeys of [false,true])for(const target of ['project','request','generation'])test(`deleting ${target} cleans read model with foreign_keys=${foreignKeys}`,async()=>{
 const f=fixture();try{
  await migrateAnalyticsSummary(f.db);
  seedProjection(f.sql);seedProjection(f.sql,'b','q','other');
  if(foreignKeys){
   // Remove legacy rows whose original FKs intentionally do not cascade.
   f.sql.exec("DELETE FROM mon_tasks WHERE run_id='ra'; DELETE FROM mon_runs WHERE id='ra'; DELETE FROM mon_prompts WHERE id='pa'; DELETE FROM app_identity_versions WHERE project_id='a'; PRAGMA foreign_keys=ON");
  }
  f.sql.exec(target==='project'?"DELETE FROM app_projects WHERE id='a'":target==='request'?"DELETE FROM analytics_summary_requests WHERE project_id='a'":"DELETE FROM analytics_summary_generations WHERE id='g'");
  for(const table of ['analytics_summary_generations','analytics_summary_heads'])assert.equal(f.sql.prepare(`SELECT COUNT(*) n FROM ${table} WHERE project_id='a'`).get().n,0);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM analytics_summary_evidence WHERE generation_id='g'").get().n,0);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM analytics_summary_evidence WHERE generation_id='other'").get().n,1);
  if(target==='project')assert.equal(f.revision('a'),undefined);
  if(target!=='generation')assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM analytics_summary_requests WHERE project_id='a'").get().n,0);
 }finally{f.sql.close();}
});

test('head cannot reference another project/query generation when foreign keys are enforced',async()=>{
 const f=fixture();try{
  await migrateAnalyticsSummary(f.db);seedProjection(f.sql);seedProjection(f.sql,'b','q','other');
  f.sql.exec('PRAGMA foreign_keys=ON');
  assert.throws(()=>f.sql.exec("UPDATE analytics_summary_heads SET generation_id='other' WHERE project_id='a'"),/FOREIGN KEY/);
  assert.throws(()=>f.sql.exec("INSERT INTO analytics_summary_heads VALUES ('a','another','g')"),/FOREIGN KEY/);
  assert.throws(()=>f.sql.exec("INSERT INTO analytics_summary_evidence SELECT generation_id,1,id,payload_hash FROM analytics_summary_evidence WHERE generation_id='g'"),/UNIQUE/);
  const plans=f.sql.prepare('EXPLAIN QUERY PLAN SELECT payload_hash FROM analytics_summary_evidence WHERE generation_id=? AND id=?').all('g','answer');
  assert.ok(plans.some(p=>/USING INDEX.*generation_id=\? AND id=\?/.test(p.detail)));
 }finally{f.sql.close();}
});

test('missing dependency rolls migration back without partial schema, triggers or history',async()=>{
 const f=fixture();try{
  f.sql.exec('DROP TABLE intelligence_reviews');
  await assert.rejects(migrateAnalyticsSummary(f.db),/no such table/);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'analytics_%'").get().n,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM app_migrations WHERE id=?').get(id).n,0);
  // A missing prerequisite cannot accidentally leave source writes coupled to
  // an uninstalled read model after a failed rollout.
  f.sql.exec("UPDATE mon_runs SET status='queued' WHERE id='ra'");
 }finally{f.sql.close();}
});

test('invalidation counter never silently overflows JavaScript-safe revisions',async()=>{
 const f=fixture();try{
  await migrateAnalyticsSummary(f.db);
  f.sql.exec("UPDATE analytics_project_revisions SET revision=9007199254740991 WHERE project_id='a'");
  assert.throws(()=>f.sql.exec("UPDATE mon_runs SET status='queued' WHERE id='ra'"),/CHECK constraint/);
  assert.equal(f.sql.prepare("SELECT status FROM mon_runs WHERE id='ra'").get().status,'complete');
 }finally{f.sql.close();}
});

test('migration declares invalidators for every persisted canonical dependency',()=>{
 for(const table of ['app_identity_versions','app_audit_events','app_project_scans','mon_runs','mon_tasks','mon_evidence','mon_prompts','mon_prompt_versions','sentiment_jobs','intelligence_jobs','intelligence_reviews','app_migrations']){
  for(const action of ['INSERT','UPDATE','DELETE'])assert.ok(ddl.some(sql=>sql.startsWith(`CREATE TRIGGER analytics_revision_${table}_${action.toLowerCase()}`)),`${table} ${action}`);
 }
});


test('migration and atomic revision writes work with the local libSQL client',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'analytics-summary-migration-'));
 const db=createClient({url:`file:${join(directory,'fixture.db')}`});
 try{
  for(const statement of [...migrations,...appDDL,scanDDL,...monitoringDDL,...intelligenceDDL,...sentimentDDL,...researchDDL,...reportsDDL])await db.execute(statement);
  await db.execute('CREATE TABLE app_migrations(id TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
  await db.execute("INSERT INTO users VALUES ('alice','alice','alice@example.test','Alice','',1,1)");
  await db.execute("INSERT INTO app_projects VALUES ('a','alice','active',1,'date')");
  await migrateAnalyticsSummary(db);await migrateAnalyticsSummary(db);
  const tx=await db.transaction('write');
  try{
   await tx.execute("UPDATE app_projects SET version=2 WHERE id='a'");
   assert.equal((await tx.execute('SELECT revision FROM analytics_project_revisions')).rows[0].revision,2);
   await tx.rollback();
  }finally{tx.close();}
  assert.equal((await db.execute('SELECT revision FROM analytics_project_revisions')).rows[0].revision,1);
  await db.execute("UPDATE app_projects SET version=2 WHERE id='a'");
  assert.equal((await db.execute('SELECT revision FROM analytics_project_revisions')).rows[0].revision,2);
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});


test('unchanged blocked annotations and source updates do not churn revisions',async()=>{
 const f=fixture();try{
  await migrateAnalyticsSummary(f.db);
  for(const [table,insert] of sourceMutations){
   f.sql.exec(insert);
   const before=['a','b'].map(f.revision);
   const column=f.sql.prepare(`PRAGMA table_info(${table})`).all()[0].name;
   f.sql.exec(`UPDATE ${table} SET ${column}=${column}`);
   assert.deepEqual(['a','b'].map(f.revision),before,table);
  }
  f.sql.exec("UPDATE sentiment_jobs SET error='BUDGET_WAIT'");
  const before=f.revision('a');
  f.sql.exec("UPDATE sentiment_jobs SET error='BUDGET_WAIT'");
  assert.equal(f.revision('a'),before);
  f.sql.exec("UPDATE sentiment_jobs SET error=NULL");
  assert.equal(f.revision('a'),before+1);
 }finally{f.sql.close();}
});


for(const [table,...mutations] of sourceMutations.filter(([table])=>unrelatedTables.has(table)))test(`${table} is not a canonical read dependency and does not invalidate`,async()=>{
 const f=fixture();try{
  await migrateAnalyticsSummary(f.db);
  for(const mutation of mutations){
   const before=['a','b'].map(f.revision);f.sql.exec(mutation);
   assert.deepEqual(['a','b'].map(f.revision),before);
  }
 }finally{f.sql.close();}
});
