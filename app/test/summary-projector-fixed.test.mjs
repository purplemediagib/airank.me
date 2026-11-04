import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,evidence} from './summary-fixed-model.mjs';
import {projectSummaryOnce} from '../src/analytics/summary-projector.mjs';
import {createSummaryWorkerControl} from '../src/analytics/summary-worker-control.mjs';
import {assertPublicationSafe,cleanupSummaries} from '../src/analytics/summary-store.mjs';
import {id,checksum} from '../src/analytics/summary-migration.mjs';
import {formatVersion} from '../src/analytics/summary-contract.mjs';
const env={AIRANK_ANALYTICS_SUMMARY_ENABLED:'true'};
function projectorFixture(){
 const f=fixture();
 f.exec(`CREATE TABLE app_migrations(id TEXT,checksum TEXT);
 ALTER TABLE app_projects ADD COLUMN version INTEGER DEFAULT 1;
 CREATE TABLE app_identity_versions(project_id TEXT,version INTEGER,identity_json TEXT);
 INSERT INTO app_identity_versions VALUES('p',1,'{}');
 CREATE TABLE mon_evidence(run_id TEXT,payload TEXT);
 CREATE TABLE mon_runs(id TEXT,project_id TEXT,created_at INTEGER);`);
 f.db.prepare('INSERT INTO app_migrations VALUES(?,?)').run(id,checksum);
 f.db.prepare('UPDATE analytics_summary_requests SET format_version=?,query_json=?,lease_token=NULL,lease_until=NULL').run(formatVersion(env),'from=2026-11-03&to=2026-11-04');
 return f;
}
for(const phase of ['intent','compact','setup','stage','final'])for(const executed of [false,true])test(`projector and worker stop after unknown ${phase}, server executed=${executed}`,async()=>{
 const f=projectorFixture();try{
  let unknown=false,lateCalls=0,attempts=0;const logs=[];
  f.adapter.summaryAtomic=async plan=>{
   if(unknown){lateCalls++;throw Error('unexpected dependent mutation');}
   if(plan.phase===phase){
    attempts++;if(executed)await f.run(plan);
    unknown=true;return {outcome:'unknown'};
   }
   return f.run(plan);
  };
  const rows=evidence(['setup','stage','final'].includes(phase)?101:1);
  const project=options=>projectSummaryOnce({...options,compute:async()=>({data:{evidence:[],groups:[]}}),buildOverview:()=>({ui:{},evidence:rows})});
  const worker=createSummaryWorkerControl({db:f.adapter,env,now:()=>f.now,assertPublicationSafe,projectSummaryOnce:project,prewarmSummaries:async()=>{throw Error('prewarm disabled');},cleanupSummaries,log:x=>logs.push(x)});
  const result=await worker.tick();
  assert.deepEqual(result,{state:'blocked',code:'ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN'});
  assert.equal(attempts,1);assert.equal(lateCalls,0);
  const snapshot=f.snapshot();
  const restartedDb={...f.adapter,summaryAtomic:plan=>f.run(plan)};
  const restarted=createSummaryWorkerControl({db:restartedDb,env,now:()=>f.now,assertPublicationSafe,projectSummaryOnce:project,prewarmSummaries:async()=>{throw Error('prewarm disabled');},cleanupSummaries});
  const recovered=await restarted.tick();
  const marker=f.row('SELECT last_error FROM analytics_summary_requests').last_error;
  assert.equal(recovered.state,marker?'blocked':'idle');
  if(!marker&&executed&&['compact','final'].includes(phase))assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_heads').n,1);
  assert.deepEqual(f.snapshot(),snapshot);
  f.advance(86400000);
  for(let i=0;i<65;i++)await worker.tick();
  assert.equal(lateCalls,0);assert.deepEqual(f.snapshot(),snapshot);
  assert.equal(worker.status().ready,false);
  assert.equal(logs.length,1);assert.equal(logs[0].event,'analytics_publication_blocked');
  // No failure update, renewal, new generation or cleanup after uncertainty.
  const last=f.queries.at(-1);
  assert.ok(last);assert.doesNotMatch(JSON.stringify(logs),/Synthetic|owner|token|https/);
 }finally{f.close();}
});
