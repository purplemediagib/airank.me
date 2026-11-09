// Recovery is opt-in for tracked monitoring, never guest checks. One fresh
// sequence may be billable even when the first timed out, so reserve both.
export const recoveryPolicyVersion='bounded-answer-recovery-v1';
export function recoveryEnabled(env){
 const value=env.MONITORING_RECOVERY_ENABLED??'false';
 if(!['true','false'].includes(value))throw Error('API_BUDGET_INVALID_CONFIG');
 return value==='true';
}
export const recoveryRoute=(provider,route)=>route.transport==='openrouter'||(provider==='claude'&&route.transport==='direct');
export const recoveryOutputTokens=tokens=>Math.min(16384,tokens*2);
export const recoveryTimeoutMs=timeout=>Math.min(300000,Math.max(timeout,180000));
export function recoveryReason(result){
 if(['success','no_grounding','no_overview'].includes(result?.status))return null;
 const code=result?.meta?.failure_code;
 if(['OUTPUT_TOKEN_LIMIT','EMPTY_ANSWER','PROVIDER_TIMEOUT'].includes(code))return code;
 if(code==='PROVIDER_UNAVAILABLE'&&[500,502,503,504,529].includes(result.meta.http_status))return code;
 if(code==='WEB_SEARCH_FAILED'&&['internal_error','unavailable'].includes(result.meta.upstream_error_code))return code;
 return null;
}
