import {one,exec} from '../monitoring/shared.mjs';
import {brandKey,config,eligibility,inputHash,mentions} from './core.mjs';
export async function loadJobs(db,projectId,userId,evidenceIds=null){
 if(!await one(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='sentiment_jobs'"))return null;
 if(evidenceIds?.length===0)return [];
 const selection=evidenceIds?` AND j.evidence_id IN (${evidenceIds.map(()=>'?').join(',')})`:'';
 return (await exec(db,`SELECT j.* FROM sentiment_jobs j JOIN mon_runs r ON r.id=j.run_id WHERE r.project_id=? AND r.owner_id=?${selection} ORDER BY j.created_at DESC`,[projectId,userId,...(evidenceIds||[])])).rows;
}
export function attachSentiment(e,s,jobs,env=process.env){
 const c=config(env),reason=eligibility(e,s);
 const job=jobs?.find(j=>j.evidence_id===e.id&&j.analysis_version===c.version)||jobs?.find(j=>j.evidence_id===e.id);
 let result=null,status=reason||(jobs===null?'not_configured':env.SENTIMENT_ENABLED!=='true'?'disabled':'not_analysed');
 if(job){
  status=job.status==='queued'?(job.error==='BUDGET_WAIT'?'budget_wait':job.error==='MISSING_CREDENTIAL'?'unconfigured':'queued'):job.status==='running'?'analysing':job.status==='skipped'?job.error:job.status;
  if(job.input_hash!==inputHash(e,s))status='evidence_changed';
  else if(job.status==='done')result=JSON.parse(job.result_json);
 }
 const sentiments={};
 for(const b of [s.identity,...(s.cohort?.brands||[])]){
  const key=brandKey(b),a=result?.assessments.find(a=>a.brandId===key);
  sentiments[key]=a?{...a,analysisVersion:result.analysisVersion,rubricVersion:result.rubricVersion,model:result.model,requestedModel:result.requestedModel,assessedAt:result.assessedAt}: {brandId:key,brandName:b.brandName,status:!reason&&!mentions(e.answer,b)?'not_mentioned':status,score:null,label:null,quotes:[],analysisVersion:c.version,model:null,error:job?.error||null};
 }
 return {...e,sentimentAnalysis:{state:status,analysisVersion:job?.analysis_version||c.version,configuredAnalysisVersion:c.version,requestedModel:job?.requested_model||c.model,error:job?.error||null},sentiment:sentiments[brandKey(s.identity)],brandSentiments:sentiments};
}
