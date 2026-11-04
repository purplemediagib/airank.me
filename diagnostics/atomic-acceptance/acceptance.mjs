// Synthetic-only acceptance of imported production publisher. No work on import.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {probe} from './absence-probe.mjs';
import {DDL} from './schema.mjs';
import {PREFIX,TABLES,CONFIRMATION,approvedWindow,fixedEndpoint,budget,boundedTransport} from './policy.mjs';
const SOURCE=new URL('../../app/src/analytics/',import.meta.url);
export async function loadCandidate({verify=true}={}){
 const manifest=JSON.parse(await readFile(new URL('./source-manifest.json',import.meta.url),'utf8'));
 if(verify){
  if(manifest.status!=='PINNED_OFFLINE_REVIEW'||!['summary-store.mjs','summary-fixed-store.mjs','summary-plans.mjs','summary-transport.mjs','summary-contract.mjs'].every(file=>/^[0-9a-f]{64}$/.test(manifest.files?.[file]||'')))throw Error('SOURCE_NOT_PINNED');
  for(const [file,digest] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(await readFile(new URL(file,SOURCE))).digest('hex'),digest);
 }
 const [store,plans,transport,contract]=await Promise.all(['summary-store.mjs','summary-plans.mjs','summary-transport.mjs','summary-contract.mjs'].map(file=>import(new URL(file,SOURCE))));
 return {...plans,...transport,publishSummary:store.publishSummary,evidenceMetadata:contract.evidenceMetadata};
}
export function evidence(count,name){return Array.from({length:count},(_,i)=>({id:`synthetic-${name}-${i}`,text:'Synthetic question?',answer:`Synthetic answer ${i}.`,provider:'synthetic',model:'no-provider-call',topic:'fixture',tags:['synthetic'],brandNames:['Fixture'],citations:['https://example.invalid/synthetic'],exclusion:null,mentioned:i%2===0,recommendation:i%3===0?'recommended':'none',ownedCitation:i%4===0,brandOrder:{state:'observed',targetPosition:1,mentions:[{brandName:'Fixture'}]}}));}
export async function createContext({candidate,endpoint,authorization,fetchImpl,expires,state=budget(),signal}){
 const wrapped=boundedTransport({endpoint,authorization,expires,state,fetchImpl,signal});
 const base=candidate.createSummaryDatabase({url:endpoint,authToken:'transport-injects-authorized-token',fetch:wrapped});
 // Unknown protocol results also latch the harness, not only fetch exceptions.
 const db={...base,async summaryAtomic(plan){const result=await base.summaryAtomic(plan);if(result.outcome==='unknown')state.unknown=true;return result;}};
 // Avoid the factory's closed-over execute path so every result shares the latch.
 db.execute=async input=>{
  const plan=candidate.atomicPlan([candidate.statement('execute',input.sql,input.args||[],true)]),result=await db.summaryAtomic(plan);
  if(result.outcome!=='committed')throw Error('QUERY_UNACKNOWLEDGED');
  return {rows:candidate.resultRows(plan,result,'execute'),rowsAffected:result.batch.step_results[1].affected_row_count};
 };
 const atomic=async(statements)=>{
  const plan=candidate.atomicPlan(statements),r=await db.summaryAtomic(plan);
  if(r.outcome!=='committed')throw Error('ATOMIC_UNACKNOWLEDGED');return {plan,result:r};
 };
 return {candidate,db,state,wrapped,endpoint,authorization,atomic};
}
export async function initialize(ctx){
 const {candidate,atomic,endpoint,authorization,wrapped,state}=ctx;
 const root=new URL('/',endpoint).href;
 const preflight=await probe({configuredURL:root,verifiedDatabaseURL:root,authorization,fetchImpl:wrapped});
 if(preflight.status!=='observed'||preflight.tables.length!==6||preflight.tables.some(t=>t.state!=='absent'))throw Error('NAMESPACE_NOT_CONFIRMED_ABSENT');
 const before=state.requests;
 await atomic(DDL.map((sql,i)=>candidate.statement(`create_${i}`,sql)));
 assert.equal(state.requests-before,1);return {preflight:'six_exact_names_absent',setupRequests:1};
}
export async function seed(ctx,name,{expired=false}={}){
 const {candidate:c,atomic}=ctx;
 const job={project_id:`synthetic-${name}`,query_key:`synthetic-query-${name}`,source_revision:1,format_version:'atomic-synthetic-v1',lease_token:`synthetic-token-${name}`};
 const lease=expired?-1:c.LEASE_MS;
 const {plan,result}=await atomic([
  c.statement('revision','INSERT INTO analytics_project_revisions(project_id,revision) VALUES (?,1)',[job.project_id]),
  c.statement('request',`INSERT INTO analytics_summary_requests(project_id,query_key,query_json,format_version,requested_at,last_requested_at,lease_token,lease_until,attempts,next_attempt_at) VALUES (?,?,?, ?,${c.CLOCK_SQL},${c.CLOCK_SQL},?,${c.CLOCK_SQL}+?,1,0)`,[job.project_id,job.query_key,'{}',job.format_version,job.lease_token,lease]),
  c.statement('lease','SELECT lease_until FROM analytics_summary_requests WHERE project_id=? AND query_key=?',[job.project_id,job.query_key],true),
 ]);
 job.lease_until=c.resultRows(plan,result,'lease')[0].lease_until;return job;
}
export async function snapshot(ctx,job,generation){
 const {candidate:c,atomic}=ctx;
 const {plan,result}=await atomic([
  c.statement('head',`SELECT g.* FROM analytics_summary_heads h JOIN analytics_summary_generations g ON g.id=h.generation_id WHERE h.project_id=? AND h.query_key=?`,[job.project_id,job.query_key],true),
  c.statement('evidence',`SELECT e.position,e.id,p.* FROM analytics_summary_evidence e JOIN analytics_summary_payloads p ON p.hash=e.payload_hash WHERE e.generation_id=? ORDER BY e.position LIMIT 252`,[generation],true),
  c.statement('request','SELECT lease_token,lease_until,attempts,last_error FROM analytics_summary_requests WHERE project_id=? AND query_key=?',[job.project_id,job.query_key],true),
 ]);
 return Object.fromEntries(['head','evidence','request'].map(label=>[label,c.resultRows(plan,result,label)]));
}
export async function exactOutput(ctx,job,result,summary,items){
 const saved=await snapshot(ctx,job,result.generation);assert.equal(saved.head.length,1);const g=saved.head[0];
 assert.equal(g.id,result.generation);assert.equal(g.summary_json,JSON.stringify(summary));assert.equal(g.source_revision,1);assert.equal(g.format_version,job.format_version);assert.equal(g.evidence_count,items.length);assert.ok(g.published_at>0);assert.ok(g.expires_at>g.published_at);
 assert.equal(saved.evidence.length,items.length);
 saved.evidence.forEach((r,i)=>{
  const item=items[i],json=JSON.stringify(item),m=ctx.candidate.evidenceMetadata(item);
  assert.equal(r.position,i);assert.equal(r.id,item.id);assert.equal(r.payload,json);assert.equal(r.hash,createHash('sha256').update(json).digest('hex'));
  for(const [column,key] of [['search_text','search'],['brands_json','brands'],['mentioned','mentioned'],['recommended','recommended'],['cited','cited'],['ordered','ordered'],['first_rank','first'],['excluded','excluded']])assert.equal(r[column],m[key]);
 });
 assert.deepEqual(saved.request,[{lease_token:null,lease_until:null,attempts:0,last_error:null}]);return saved;
}
export async function runSuite(ctx,{emit=()=>{}}={}){
 const {candidate:c,db,state,atomic}=ctx;const checks=[];
 const pass=name=>{checks.push(name);emit({event:'atomic_synthetic_check',name,status:'passed'});};
 await initialize(ctx);pass('atomic_schema_setup');
 for(const [name,count,expected] of [['empty',0,2],['compact_100',100,2],['staged_101',101,6],['bounded_251',251,9]]){
  const job=await seed(ctx,name),items=evidence(count,name),summary={synthetic:true,name,count};const before=state.requests;
  const result=await c.publishSummary(db,job,summary,items,()=>-1);
  assert.equal(result.published,true);assert.equal(state.requests-before,expected);
  await exactOutput(ctx,job,result,summary,items);pass(`${name}_exact_output_and_request_count`);
 }
 for(const name of ['stale_token','stale_revision','expired_lease']){
  const job=await seed(ctx,name,{expired:name==='expired_lease'});
  if(name==='stale_token')job.lease_token='synthetic-stale-token';
  if(name==='stale_revision')await atomic([c.statement('bump','UPDATE analytics_project_revisions SET revision=revision+1 WHERE project_id=?',[job.project_id])]);
  const before=state.requests,result=await c.publishSummary(db,job,{synthetic:true},evidence(2,name),Date.now);
  assert.equal(result.published,false);assert.equal(result.reason,name==='stale_revision'?'source_changed':'lease_lost');assert.equal(state.requests-before,name==='stale_revision'?2:1);pass(name);
 }
 // A compact duplicate rolls back its attempted generation. A prior published
 // snapshot must remain byte-for-byte unchanged; aborting intent cannot delete it.
 const duplicateJob=await seed(ctx,'duplicate'),duplicateItems=evidence(2,'duplicate'),duplicateSummary={synthetic:true,name:'duplicate-baseline'};
 const previous=await c.publishSummary(db,duplicateJob,duplicateSummary,duplicateItems);
 const baseline=await exactOutput(ctx,duplicateJob,previous,duplicateSummary,duplicateItems);
 const renewed=await atomic([c.statement('reset',`UPDATE analytics_summary_requests SET lease_token=?,lease_until=${c.CLOCK_SQL}+?,attempts=1 WHERE project_id=? AND query_key=? RETURNING lease_until`,[duplicateJob.lease_token,c.LEASE_MS,duplicateJob.project_id,duplicateJob.query_key],true)]);
 duplicateJob.lease_until=c.resultRows(renewed.plan,renewed.result,'reset')[0].lease_until;
 const duplicateResult=await c.publishSummary(db,duplicateJob,{synthetic:true,name:'must-not-publish'},[duplicateItems[0],duplicateItems[0]]);
 assert.deepEqual(duplicateResult,{published:false,reason:'fenced'});
 const afterDuplicate=await snapshot(ctx,duplicateJob,previous.generation);
 assert.deepEqual(afterDuplicate.head,baseline.head);assert.deepEqual(afterDuplicate.evidence,baseline.evidence);pass('duplicate_compact_rollback_preserves_prior_snapshot');
 // Two concurrent same-lease publishers must not both publish. A globally
 // quarantined loser is expected while the winner's durable intent is active.
 const job=await seed(ctx,'concurrent_same_job'),items=evidence(5,'concurrent');
 const outcomes=await Promise.allSettled([c.publishSummary(db,job,{synthetic:true},items),c.publishSummary(db,job,{synthetic:true},items)]);
 const winners=outcomes.filter(x=>x.status==='fulfilled'&&x.value.published);assert.equal(winners.length,1);
 const loser=outcomes.find(x=>x!==winners[0]);assert.ok(loser.status==='rejected'?loser.reason?.code==='ANALYTICS_PUBLICATION_QUARANTINED':loser.value?.published===false);
 await exactOutput(ctx,job,winners[0].value,{synthetic:true},items);pass('concurrent_same_lease_single_winner');
 const {plan,result}=await atomic([
  ...TABLES.map((table,i)=>c.statement(`count_${i}`,`SELECT COUNT(*) n FROM ${table}`,[],true)),
  c.statement('unpublished','SELECT COUNT(*) n FROM analytics_summary_generations WHERE published_at IS NULL',[],true),
  c.statement('orphan','SELECT COUNT(*) n FROM analytics_summary_evidence e LEFT JOIN analytics_summary_generations g ON g.id=e.generation_id WHERE g.id IS NULL',[],true),
 ]);
 const counts=TABLES.map((_,i)=>c.resultRows(plan,result,`count_${i}`)[0].n);
 assert.deepEqual(counts,[9,9,6,6,459,459]);assert.equal(c.resultRows(plan,result,'unpublished')[0].n,0);assert.equal(c.resultRows(plan,result,'orphan')[0].n,0);
 pass('retained_counts_no_orphans');
 return {status:'passed',checks,counts,requests:state.requests,statements:state.statements,requestBytes:state.requestBytes,responseBytes:state.responseBytes,maxRequestBytes:state.maxRequestBytes,maxResponseBytes:state.maxResponseBytes,maxStatements:state.maxStatements,writes:state.writes,retries:0,restore_required:true};
}
export async function runConfigured({confirmation,expires,env=process.env,signal,emit=()=>{}}={}){
 if(!approvedWindow(confirmation,expires))return {status:'not_run',requests:0,writes:0,retries:0,restore_required:true};
 let state;
 try{
  const candidate=await loadCandidate();
  if(!approvedWindow(confirmation,expires))throw Error('WINDOW_CLOSED');
  const endpoint=fixedEndpoint(env.BUNNY_DATABASE_URL),token=env.BUNNY_DATABASE_AUTH_TOKEN;
  if(typeof token!=='string'||!token||token.length>16384||/[\r\n]/.test(token))throw Error('CONFIG_REJECTED');
  state=budget();const ctx=await createContext({candidate,endpoint,authorization:`Bearer ${token}`,expires,state,signal,fetchImpl:globalThis.fetch});
  return await runSuite(ctx,{emit});
 }catch{return {status:'failed',requests:state?.requests||0,writes:state?.writes||0,retries:0,remote_outcome_may_be_uncertain:state?.unknown||false,rerun:false,restore_required:true};}
}
