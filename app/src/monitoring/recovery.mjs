import {providerFailure,resultDetails,safeProviderMeta} from '../providers/diagnostics.mjs';
import {recoveryPolicyVersion,recoveryReason,recoveryTimeoutMs} from '../providers/recovery-policy.mjs';

// No queue replay: all recovery stays inside the original owned lease. A
// watchdog winning a race is NOT proof the paid request stopped, so never retry it.
export async function executeMonitoringCall({provider,prompt,route,context,timeoutMs,deadline,call,now=Date.now,
 sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),canRetry=async()=>true,logger=()=>{}}){
 const attempts=[];
 const attempt=async(attemptRoute,limit)=>{
  const remaining=deadline-now(),duration=Math.max(1,Math.min(limit,remaining-250));
  if(remaining<=250)return {status:'timeout_unknown',meta:{failure_code:'PROVIDER_TIMEOUT',retry_blocked:'RUN_DEADLINE_EXCEEDED'}};
  let timer,settled=false;
  try{
   const pending=Promise.resolve().then(()=>call(provider,prompt,attemptRoute,duration,context))
    .catch(providerFailure).then(result=>{settled=true;return result||providerFailure(null);});
   const result=await Promise.race([pending,new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'timeout_unknown',
    meta:{failure_code:'PROVIDER_TIMEOUT',retry_blocked:'ATTEMPT_UNSETTLED'}}),Math.min(remaining,duration+250));})]);
   const details=resultDetails(result);
   return {...result,meta:{...details.meta,...(!settled?{retry_blocked:'ATTEMPT_UNSETTLED'}:{})}};
  }finally{clearTimeout(timer);}
 };
 let result=await attempt(route,timeoutMs);attempts.push(result);
 const reason=recoveryReason(result),recovery=route.api_budget?.recovery;
 if(reason&&recovery&&!result.meta.retry_blocked){
  const retryTokens=reason==='OUTPUT_TOKEN_LIMIT'?recovery.maxTokens:route.api_budget.maxTokens;
  if(reason==='OUTPUT_TOKEN_LIMIT'&&retryTokens<=route.api_budget.maxTokens)result.meta.retry_blocked='OUTPUT_LIMIT_ALREADY_MAXIMUM';
  else if(deadline-now()<2000)result.meta.retry_blocked='RUN_DEADLINE_EXCEEDED';
  else{
   await sleep(1000);
   if(deadline-now()<1000)result.meta.retry_blocked='RUN_DEADLINE_EXCEEDED';
   else if(!await canRetry())result.meta.retry_blocked='TASK_NO_LONGER_OWNED';
   else if(deadline-now()<1000)result.meta.retry_blocked='RUN_DEADLINE_EXCEEDED';
   else{
    logger('provider_recovery_started',{provider,model:route.model,initial_failure_code:reason,max_tokens_requested:retryTokens});
    const retryRoute={...route,api_budget:{...recovery,maxTokens:retryTokens}};
    result=await attempt(retryRoute,recoveryTimeoutMs(timeoutMs));attempts.push(result);
   }
  }
 }
 if(!recovery)return result;
 const summaries=attempts.map(r=>safeProviderMeta(r.meta));
 result.meta={...result.meta,retry_policy:recoveryPolicyVersion,answer_attempts:attempts.length,recovery_retries:attempts.length-1,
  ...(reason?{initial_failure_code:reason}:{}),
  request_attempts:summaries.reduce((n,m)=>n+(m.request_attempts??1),0),
  rate_limit_retries:summaries.reduce((n,m)=>n+(m.rate_limit_retries??0),0),
  ...(summaries.some(m=>m.usage)?{usage:{attempts:Object.fromEntries(summaries.map((m,i)=>['attempt_'+i,m.usage||{}]))}}:{}),
  cost:summaries.every(m=>Number.isFinite(m.cost))?summaries.reduce((n,m)=>n+m.cost,0):null};
 // Preserve each raw response for secure evidence storage, never log it.
 if(attempts.length>1)result.raw={attempts:attempts.map(r=>({status:r.status,meta:safeProviderMeta(r.meta),raw:r.raw??null}))};
 return result;
}
