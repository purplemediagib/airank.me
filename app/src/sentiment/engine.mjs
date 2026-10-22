import {randomUUID} from 'node:crypto';
import {one,exec,transaction} from '../monitoring/shared.mjs';
import {config,brandsFor,mentions,inputHash,eligibility,noMentionResult} from './core.mjs';
import {analyse} from './provider.mjs';

export async function enqueue(db,rows,c,stamp){
 let added=0;
 for(const row of rows){
  const e=JSON.parse(row.payload),s=JSON.parse(row.snapshot);
  if(e.status!=='success'||!String(e.answer||'').trim())continue;
  const r=await exec(db,`INSERT OR IGNORE INTO sentiment_jobs(evidence_id,run_id,analysis_version,requested_model,input_hash,status,created_at) VALUES (?,?,?,?,?,'queued',?)`,[e.id,e.runId,c.version,c.model,inputHash(e,s),stamp]);
  added+=Number(r.rowsAffected||0);
 }
 return added;
}
export function createSentimentEngine({db,env=process.env,now=Date.now,call=analyse,logger=(event,fields)=>console.log(JSON.stringify({event,...fields}))}){
 const c=config(env),buffered=new Map();let busy=false;
 const store=async(job,result,error=null)=>{
  await exec(db,`UPDATE sentiment_jobs SET status=?,result_json=?,error=?,finished_at=?,lease_until=NULL WHERE evidence_id=? AND analysis_version=? AND claim_token=? AND status IN ('running','interrupted_unknown')`,[result?'done':'failed',result?JSON.stringify(result):null,error,now(),job.evidence_id,c.version,job.claim_token]);
  logger('sentiment_saved',{evidence_id:job.evidence_id,analysis_version:c.version,status:result?'done':'failed',error});
 };
 const seed=()=>transaction(db,async tx=>{
  // Start with new evidence only. Historical processing is an explicit owner request.
  await exec(tx,"INSERT OR IGNORE INTO sentiment_state VALUES ('enabled_since',?)",[String(now())]);
  const start=Number((await one(tx,"SELECT value FROM sentiment_state WHERE name='enabled_since'")).value);
  const rows=(await exec(tx,`SELECT e.payload,r.snapshot FROM mon_evidence e JOIN mon_runs r ON r.id=e.run_id JOIN app_projects p ON p.id=r.project_id WHERE p.status='active' AND e.observed_at>=? AND json_extract(e.payload,'$.status')='success' AND length(trim(json_extract(e.payload,'$.answer')))>0 AND NOT EXISTS(SELECT 1 FROM sentiment_jobs j WHERE j.evidence_id=e.id) ORDER BY e.observed_at,e.id LIMIT 100`,[start])).rows;
  await enqueue(tx,rows,c,now());
 });
 const claim=()=>transaction(db,async tx=>{
  await exec(tx,"UPDATE sentiment_jobs SET status='interrupted_unknown',error='INTERRUPTED_UNKNOWN',finished_at=?,lease_until=NULL WHERE status='running' AND lease_until<=?",[now(),now()]);
  // A global single-call slot also bounds cost when several worker replicas exist.
  if(await one(tx,"SELECT evidence_id FROM sentiment_jobs WHERE status='running' LIMIT 1"))return null;
  const j=await one(tx,`SELECT j.*,e.payload,r.snapshot FROM sentiment_jobs j JOIN mon_evidence e ON e.id=j.evidence_id JOIN mon_runs r ON r.id=j.run_id JOIN app_projects p ON p.id=r.project_id WHERE j.status='queued' AND j.analysis_version=? AND p.status='active' ORDER BY j.created_at,j.evidence_id LIMIT 1`,[c.version]);
  if(!j)return null;
  const e=JSON.parse(j.payload),s=JSON.parse(j.snapshot);
  const reason=inputHash(e,s)!==j.input_hash?'evidence_changed':eligibility(e,s);
  if(reason){await exec(tx,"UPDATE sentiment_jobs SET status='skipped',error=?,finished_at=? WHERE evidence_id=? AND analysis_version=?",[reason,now(),j.evidence_id,c.version]);return {skipped:true};}
  if(!brandsFor(s).some(b=>mentions(e.answer,b))){
   await exec(tx,"UPDATE sentiment_jobs SET status='done',result_json=?,finished_at=?,error=NULL WHERE evidence_id=? AND analysis_version=?",[JSON.stringify(noMentionResult(e,s,c)),now(),j.evidence_id,c.version]);return {skipped:true};
  }
  const used=Number((await one(tx,'SELECT COUNT(*) n FROM sentiment_jobs WHERE started_at>=?',[now()-86400000])).n);
  const blocked=!env.OPENAI_API_KEY?'MISSING_CREDENTIAL':used>=c.daily?'BUDGET_WAIT':null;
  if(blocked){await exec(tx,'UPDATE sentiment_jobs SET error=? WHERE evidence_id=? AND analysis_version=?',[blocked,j.evidence_id,c.version]);return null;}
  const token=randomUUID();
  await exec(tx,"UPDATE sentiment_jobs SET status='running',started_at=?,lease_until=?,claim_token=?,error=NULL WHERE evidence_id=? AND analysis_version=?",[now(),now()+c.timeoutMs+30000,token,j.evidence_id,c.version]);
  return {...j,claim_token:token,e,s};
 });
 return {async tick(){
  if(busy||env.SENTIMENT_ENABLED!=='true')return;busy=true;
  try{
   // Storage-only retry: a paid analysis is never repeated for a database failure.
   for(const [id,p] of buffered){try{await store(p.job,p.result,p.error);buffered.delete(id);}catch{}}
   if(buffered.size)return;
   await seed();
   const job=await claim();if(!job||job.skipped)return;
   logger('sentiment_started',{evidence_id:job.evidence_id,analysis_version:c.version,model:c.model});
   let result,error=null;
   try{result=await call(job.e,job.s,c,{env,now});}
   catch(e){error=/^(?:INVALID_SENTIMENT_\w+|SENTIMENT_\w+|MISSING_CREDENTIAL)$/.test(e?.code||'')?e.code:['TimeoutError','AbortError'].includes(e?.name)?'SENTIMENT_TIMEOUT':'SENTIMENT_FAILED';}
   const pending={job,result,error};buffered.set(job.evidence_id,pending);
   try{await store(job,result,error);buffered.delete(job.evidence_id);}catch{logger('sentiment_storage_pending',{evidence_id:job.evidence_id});}
  }finally{busy=false;}
 }};
}
