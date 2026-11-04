import {randomUUID} from 'node:crypto';
import {fail} from '../monitoring/shared.mjs';
import {DEMAND_TTL,LEASE_MS,MAX_VARIANTS} from './summary-contract.mjs';
import {CLOCK_SQL,atomicPlan,statement as s,assertion,change,prepareInput,compactPlan,setupPlan,stagePlan,finalPlan} from './summary-plans.mjs';
import {SummaryOutcomeUnknown,resultRows,renewedDeadline} from './summary-transport.mjs';
export const QUARANTINE_PREFIX='ANALYTICS_PUBLICATION_UNKNOWN';
export const quarantinePredicate=`(last_error='${QUARANTINE_PREFIX}' OR last_error LIKE '${QUARANTINE_PREFIX}:%')`;
const safe=()=>assertion('publication_quarantined',`NOT EXISTS(SELECT 1 FROM analytics_summary_requests WHERE ${quarantinePredicate})`);
const clockValid=()=>assertion('clock_valid',`typeof(${CLOCK_SQL})='integer' AND ${CLOCK_SQL}>0 AND ${CLOCK_SQL}<=9007199254740991`);
export function quarantineError(){return Object.assign(Error('ANALYTICS_PUBLICATION_QUARANTINED'),{code:'ANALYTICS_PUBLICATION_QUARANTINED',status:503});}
export async function assertPublicationSafe(db){
 const r=await db.execute({sql:`SELECT 1 blocked FROM analytics_summary_requests WHERE ${quarantinePredicate} LIMIT 1`,args:[]});
 if(r.rows.length)throw quarantineError();
}
export async function readSummaryClock(db,fallback=Date.now()){
 if(!db.summaryAtomic)return fallback;
 const row=(await db.execute({sql:`SELECT ${CLOCK_SQL} stamp`,args:[]})).rows[0];
 if(!Number.isSafeInteger(row?.stamp)||row.stamp<=0)throw Object.assign(Error('ANALYTICS_CLOCK_INVALID'),{code:'ANALYTICS_CLOCK_INVALID',status:503});
 return row.stamp;
}
async function run(db,statements,meta={}){
 const plan=atomicPlan(statements,meta),result=await db.summaryAtomic(plan);
 if(result.outcome==='unknown')throw new SummaryOutcomeUnknown();
 if(result.outcome!=='committed'){
  if(result.reason==='publication_quarantined')throw quarantineError();
  if(result.reason==='filter_limit')fail(429,'ANALYTICS_FILTER_LIMIT');
  throw Object.assign(Error('ANALYTICS_DATABASE_FAILED'),{code:'ANALYTICS_DATABASE_FAILED',status:503});
 }
 return {plan,result};
}
export async function demandFixed(db,projectId,key,query,format){
 const active=`(SELECT COUNT(*) FROM analytics_summary_requests WHERE project_id=? AND format_version=? AND last_requested_at>${CLOCK_SQL}-?)`;
 const {plan,result}=await run(db,[clockValid(),safe(),
  assertion('filter_limit',`EXISTS(SELECT 1 FROM analytics_summary_requests WHERE project_id=? AND query_key=? AND last_requested_at>${CLOCK_SQL}-?) OR ${active}<?`,[projectId,key,DEMAND_TTL,projectId,format,DEMAND_TTL,MAX_VARIANTS]),
  s('request',`INSERT INTO analytics_summary_requests(project_id,query_key,query_json,format_version,requested_at,last_requested_at,attempts,next_attempt_at) VALUES(?,?,?,?,${CLOCK_SQL},${CLOCK_SQL},0,0) ON CONFLICT(project_id,query_key) DO UPDATE SET last_requested_at=CASE WHEN analytics_summary_requests.last_requested_at<${CLOCK_SQL}-60000 THEN ${CLOCK_SQL} ELSE analytics_summary_requests.last_requested_at END`,[projectId,key,query.toString(),format]),
  s('requested','SELECT * FROM analytics_summary_requests WHERE project_id=? AND query_key=?',[projectId,key],true)]);
 const rows=resultRows(plan,result,'requested'),row=rows[0];
 if(rows.length!==1||row.project_id!==projectId||row.query_key!==key||row.format_version!==format||typeof row.query_json!=='string'||!Number.isSafeInteger(row.last_requested_at)||row.last_requested_at<=0)throw new SummaryOutcomeUnknown();
 return row;
}
export async function claimFixed(db,format){
 const token=randomUUID();
 const eligible=`SELECT q.rowid FROM analytics_summary_requests q JOIN analytics_project_revisions r ON r.project_id=q.project_id JOIN app_projects p ON p.id=q.project_id LEFT JOIN analytics_summary_heads h ON h.project_id=q.project_id AND h.query_key=q.query_key LEFT JOIN analytics_summary_generations g ON g.id=h.generation_id
 WHERE q.format_version=? AND q.last_requested_at>${CLOCK_SQL}-? AND q.next_attempt_at<=${CLOCK_SQL} AND (q.lease_until IS NULL OR q.lease_until<=${CLOCK_SQL})
 AND (q.last_error IS NULL OR (q.last_error NOT LIKE '${QUARANTINE_PREFIX}%' AND (q.last_error NOT IN ('INVALID_FILTER','NOT_FOUND','ANALYTICS_PROJECTION_LIMIT') OR q.failed_revision IS NULL OR q.failed_revision<>r.revision)))
 AND (g.id IS NULL OR g.source_revision<>r.revision OR g.format_version<>q.format_version OR g.expires_at<=${CLOCK_SQL} OR g.generated_at<(${CLOCK_SQL}/86400000)*86400000)
 ORDER BY COALESCE(g.generated_at,0),q.requested_at,q.project_id,q.query_key LIMIT 1`;
 const {plan,result}=await run(db,[clockValid(),safe(),s('claim',`UPDATE analytics_summary_requests SET lease_token=?,lease_until=${CLOCK_SQL}+?,attempts=attempts+1 WHERE rowid=(${eligible})`,[token,LEASE_MS,format,DEMAND_TTL]),
 s('claimed',`SELECT q.*,r.revision source_revision,p.owner_id FROM analytics_summary_requests q JOIN analytics_project_revisions r ON r.project_id=q.project_id JOIN app_projects p ON p.id=q.project_id WHERE q.lease_token=?`,[token],true)]);
 const rows=resultRows(plan,result,'claimed');
 if(rows.length>1)throw new SummaryOutcomeUnknown();
 const job=rows[0];if(!job)return null;
 if((typeof job.query_json!=='string'||['project_id','query_key','format_version','owner_id','lease_token'].some(k=>typeof job[k]!=='string'||!job[k]))||job.lease_token!==token||job.format_version!==format||['source_revision','lease_until','attempts'].some(k=>!Number.isSafeInteger(job[k])||job[k]<1))throw new SummaryOutcomeUnknown();
 return job;
}
export async function renewFixed(db,job){
 const {plan,result}=await run(db,[clockValid(),safe(),s('renew',`UPDATE analytics_summary_requests SET lease_until=${CLOCK_SQL}+? WHERE project_id=? AND query_key=? AND lease_token=? AND lease_until>${CLOCK_SQL} RETURNING lease_until`,[LEASE_MS,job.project_id,job.query_key,job.lease_token],true)]);
 const rows=resultRows(plan,result,'renew');
 if(rows.length>1||rows.length===1&&(!Number.isSafeInteger(rows[0].lease_until)||rows[0].lease_until<=0))throw new SummaryOutcomeUnknown();
 return rows.length===1;
}
function ownership(job){return assertion('lease_lost',`EXISTS(SELECT 1 FROM analytics_summary_requests q JOIN analytics_project_revisions r ON r.project_id=q.project_id WHERE q.project_id=? AND q.query_key=? AND q.lease_token=? AND q.lease_until>=? AND q.lease_until>${CLOCK_SQL})`,[job.project_id,job.query_key,job.lease_token,job.lease_until]);}
async function abortKnown(db,p){
 // Only invoked following a fully acknowledged rollback/not-started. Never
 // invoked after an unknown result, even when a later read sees nothing.
 const {job,id}=p;
 await run(db,[clockValid(),assertion('intent_owned',`EXISTS(SELECT 1 FROM analytics_summary_requests WHERE project_id=? AND query_key=? AND lease_token=? AND last_error=?)`,[job.project_id,job.query_key,job.lease_token,job.publication_intent]),
 // Retain previously acknowledged staged rows until bounded expiry cleanup.
 s('abort_intent',`UPDATE analytics_summary_requests SET lease_token=NULL,lease_until=NULL,last_error=NULL,next_attempt_at=${CLOCK_SQL}+1000 WHERE project_id=? AND query_key=? AND lease_token=? AND last_error=?`,[job.project_id,job.query_key,job.lease_token,job.publication_intent]),change('intent_aborted')]);
}
export async function publishFixed(db,job,summary,evidence){
 const id=randomUUID(),intent=`${QUARANTINE_PREFIX}:${id}`;
 let p;
 try{p=prepareInput({...job,publication_intent:intent},id,summary,evidence);}catch{fail(422,'ANALYTICS_PROJECTION_LIMIT');}
 // Validate all lazy chunks BEFORE durable intent; retain no encoded-all copy.
 // Immutable snapshot ensures this validation remains true across awaits.
 for(const c of p.chunks)void c.encoded;
 const intentPlan=atomicPlan([clockValid(),safe(),ownership(job),assertion('source_changed','EXISTS(SELECT 1 FROM analytics_project_revisions WHERE project_id=? AND revision=?)',[job.project_id,job.source_revision]),s('set_intent','UPDATE analytics_summary_requests SET last_error=? WHERE project_id=? AND query_key=? AND lease_token=?',[intent,job.project_id,job.query_key,job.lease_token]),change('intent_set'),ownership(job)],{phase:'intent',generation:id});
 const intentResult=await db.summaryAtomic(intentPlan);
 if(intentResult.outcome==='unknown')throw new SummaryOutcomeUnknown();
 if(intentResult.outcome!=='committed'){
  if(intentResult.reason==='publication_quarantined')throw quarantineError();
  if(intentResult.reason==='source_changed'){
   await run(db,[clockValid(),safe(),s('requeue_source_change',`UPDATE analytics_summary_requests SET lease_token=NULL,lease_until=NULL,next_attempt_at=${CLOCK_SQL}+1000,last_error=NULL WHERE project_id=? AND query_key=? AND lease_token=? AND EXISTS(SELECT 1 FROM analytics_project_revisions WHERE project_id=? AND revision<>?)`,[job.project_id,job.query_key,job.lease_token,job.project_id,job.source_revision])]);
   return {published:false,reason:'source_changed'};
  }
  return {published:false,reason:'lease_lost'};
 }
 let deadline=job.lease_until;
 const execute=async plan=>{
  const result=await db.summaryAtomic(plan);
  if(result.outcome==='unknown')throw new SummaryOutcomeUnknown();
  if(result.outcome!=='committed'){
   await abortKnown(db,p);
   return null;
  }
  return result;
 };
 // No finally cleanup. The durable intent survives every ambiguous operation.
 if(p.compact){if(!await execute(compactPlan(p,deadline)))return {published:false,reason:'fenced'};}
 else{
  if(!await execute(setupPlan(p,deadline)))return {published:false,reason:'fenced'};
  for(const c of p.chunks){const plan=stagePlan(p,c,deadline),r=await execute(plan);if(!r)return {published:false,reason:'fenced'};deadline=renewedDeadline(plan,r);}
  if(!await execute(finalPlan(p,deadline)))return {published:false,reason:'fenced'};
 }
 return {published:true,generation:id};
}
export async function failFixed(db,job,error){
 if(error?.outcome==='unknown'||error?.code==='ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN'||error?.code==='ANALYTICS_PUBLICATION_QUARANTINED')throw error;
 const allowed=new Set(['INVALID_FILTER','NOT_FOUND','ANALYTICS_PROJECTION_LIMIT']),code=allowed.has(error?.code)?error.code:'ANALYTICS_BUILD_FAILED';
 await run(db,[clockValid(),safe(),s('fail',`UPDATE analytics_summary_requests SET lease_token=NULL,lease_until=NULL,last_error=?,failed_revision=?,next_attempt_at=${CLOCK_SQL}+? WHERE project_id=? AND query_key=? AND lease_token=?`,[code,job.source_revision,Math.min(300000,3000*2**Math.min(job.attempts,7)),job.project_id,job.query_key,job.lease_token])]);
 return code;
}
export async function cleanupFixed(db){
 await run(db,[clockValid(),safe(),s('expired_generations',`DELETE FROM analytics_summary_generations WHERE id IN (SELECT id FROM analytics_summary_generations WHERE expires_at<=${CLOCK_SQL} ORDER BY expires_at LIMIT 20)`),
 s('unreferenced_payloads','DELETE FROM analytics_summary_payloads WHERE hash IN (SELECT p.hash FROM analytics_summary_payloads p WHERE NOT EXISTS (SELECT 1 FROM analytics_summary_evidence e WHERE e.payload_hash=p.hash) LIMIT 1000)'),
 s('expired_requests',`DELETE FROM analytics_summary_requests WHERE last_requested_at<=${CLOCK_SQL}-? AND (lease_until IS NULL OR lease_until<=${CLOCK_SQL}) AND NOT EXISTS(SELECT 1 FROM analytics_summary_generations g WHERE g.project_id=analytics_summary_requests.project_id AND g.query_key=analytics_summary_requests.query_key AND g.expires_at>${CLOCK_SQL})`,[DEMAND_TTL])]);
}
