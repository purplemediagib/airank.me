import {randomUUID} from 'node:crypto';
import {one,exec,transaction} from '../monitoring/shared.mjs';
import {configuration,inputHash} from './core.mjs';
import {analyse} from './provider.mjs';
import {extract} from '../analytics/extraction.mjs';
export async function enqueue(db,rows,c,now){
 let queued=0;
 for(const row of rows){
  const e=JSON.parse(row.payload);
  const reason=e.status!=='success'||!e.answer?.trim()?'EVIDENCE_INELIGIBLE':e.answer.length>24000?'ANSWER_TOO_LONG':row.snapshot&&extract(e,JSON.parse(row.snapshot)).exclusion?'EVIDENCE_INELIGIBLE':null;
  const r=await exec(db,`INSERT OR IGNORE INTO intelligence_jobs(evidence_id,run_id,analysis_version,requested_model,input_hash,status,created_at,error,finished_at) VALUES (?,?,?,?,?,?,?,?,?)`,[e.id,row.run_id||e.runId,c.version,c.model,inputHash(e),reason?'skipped':'queued',now,reason,reason?now:null]);
  queued+=reason?0:Number(r.rowsAffected||0);
 }
 return queued;
}
export function createEntityEngine({db,env=process.env,now=Date.now,call=analyse}){
 const c=configuration(env),buffer=new Map();let busy=false;
 const save=async p=>exec(db,`UPDATE intelligence_jobs SET status=?,result_json=?,error=?,finished_at=?,lease_until=NULL WHERE evidence_id=? AND analysis_version=? AND claim_token=? AND status IN ('running','interrupted_unknown')`,[p.result?'done':'failed',p.result?JSON.stringify(p.result):null,p.error,now(),p.job.evidence_id,c.version,p.job.claim_token]);
 return {async tick(){
  if(busy||env.ENTITY_ANALYSIS_ENABLED!=='true')return;busy=true;
  try{
   for(const [id,p]of buffer){try{await save(p);buffer.delete(id);}catch{}}
   if(buffer.size)return;
   // Explicit operator opt-in seeds future evidence only, never a silent backfill.
   await transaction(db,async tx=>{
    const stateKey=`enabled_since:${c.version}`;
    await exec(tx,"INSERT OR IGNORE INTO intelligence_state VALUES (?,?)",[stateKey,String(now())]);
    const since=Number((await one(tx,"SELECT value FROM intelligence_state WHERE name=?",[stateKey])).value);
    const rows=(await exec(tx,`SELECT e.payload,e.run_id,r.snapshot FROM mon_evidence e JOIN mon_runs r ON r.id=e.run_id JOIN app_projects p ON p.id=r.project_id WHERE p.status='active' AND e.observed_at>=? AND json_extract(e.payload,'$.status')='success' AND NOT EXISTS(SELECT 1 FROM intelligence_jobs j WHERE j.evidence_id=e.id AND j.analysis_version=?) ORDER BY e.observed_at,e.id LIMIT 50`,[since,c.version])).rows;
    await enqueue(tx,rows,c,now());
   });
   const job=await transaction(db,async tx=>{
    await exec(tx,"UPDATE intelligence_jobs SET status='interrupted_unknown',error='INTERRUPTED_UNKNOWN',finished_at=?,lease_until=NULL WHERE status='running' AND lease_until<=?",[now(),now()]);
    if(await one(tx,"SELECT evidence_id FROM intelligence_jobs WHERE status='running' LIMIT 1"))return null;
    const j=await one(tx,`SELECT j.*,e.payload FROM intelligence_jobs j JOIN mon_evidence e ON e.id=j.evidence_id JOIN mon_runs r ON r.id=j.run_id JOIN app_projects p ON p.id=r.project_id WHERE j.status='queued' AND j.analysis_version=? AND p.status='active' ORDER BY j.created_at,j.evidence_id LIMIT 1`,[c.version]);
    if(!j)return null;const e=JSON.parse(j.payload);
    if(inputHash(e)!==j.input_hash||e.status!=='success'||!e.answer?.trim()||e.answer.length>24000){await exec(tx,"UPDATE intelligence_jobs SET status='skipped',error='EVIDENCE_INELIGIBLE',finished_at=? WHERE evidence_id=? AND analysis_version=?",[now(),j.evidence_id,c.version]);return null;}
    const used=Number((await one(tx,'SELECT COUNT(*) n FROM intelligence_jobs WHERE started_at>=?',[now()-86400000])).n);
    const blocked=!env.OPENAI_API_KEY?'MISSING_CREDENTIAL':used>=c.daily?'BUDGET_WAIT':null;
    if(blocked){await exec(tx,'UPDATE intelligence_jobs SET error=? WHERE evidence_id=? AND analysis_version=?',[blocked,j.evidence_id,c.version]);return null;}
    const token=randomUUID();
    await exec(tx,"UPDATE intelligence_jobs SET status='running',started_at=?,lease_until=?,claim_token=?,error=NULL WHERE evidence_id=? AND analysis_version=?",[now(),now()+c.timeoutMs+30000,token,j.evidence_id,c.version]);
    return {...j,e,claim_token:token};
   });
   if(!job)return;
   let result=null,error=null;
   try{result=await call(job.e,c,{env});}catch(e){error=/^(?:ENTITY_\w+|INVALID_ENTITY_OUTPUT|MISSING_CREDENTIAL)$/.test(e?.code||'')?e.code:'ENTITY_FAILED';}
   const p={job,result,error};buffer.set(job.evidence_id,p);
   try{await save(p);buffer.delete(job.evidence_id);}catch{}
  }finally{busy=false;}
 }};
}
