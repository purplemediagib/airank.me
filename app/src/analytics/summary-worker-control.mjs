// This latch supplements the store's durable intent and in-transaction fences.
// It is not a replacement for them and never infers rollback from a missing row.
export function publicationBlockCode(value){
 if(value?.outcome==='unknown'||value?.code==='ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN')return 'ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN';
 if(value?.code==='ANALYTICS_PUBLICATION_QUARANTINED')return 'ANALYTICS_PUBLICATION_QUARANTINED';
 return null;
}

export function createSummaryWorkerControl({db,env=process.env,now=Date.now,assertPublicationSafe,projectSummaryOnce,prewarmSummaries,cleanupSummaries,log=()=>{}}){
 let blockedCode=null,latched=false,initialized=false,running=false,lastSuccess=now(),lastWarmDay='',after='',ticks=0;
 const block=code=>{
  if(blockedCode!==code)log({event:'analytics_publication_blocked',code,recovery:code==='ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN'?'operator_review_required':'awaiting_publication_resolution'});
  blockedCode=code;
  if(code==='ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN')latched=true;
  return {state:'blocked',code:blockedCode};
 };
 return {
  status(){return {running,blocked:!!blockedCode,code:blockedCode,ready:initialized&&!blockedCode&&now()-lastSuccess<15*60000};},
  async tick(){
   if(latched)return {state:'blocked',code:blockedCode};
   running=true;
   try{
    // Check before prewarm too: it is a mutation, not a harmless health read.
    await assertPublicationSafe(db);
    // An observed intent may belong to a still-active peer. Only our own
    // unknown outcome is latched; absence never resolves that latch. Store
    // writes must independently enforce exclusion under the writer lock.
    blockedCode=null;
    const day=new Date(now()).toISOString().slice(0,10);
    if(env.AIRANK_ANALYTICS_PREWARM==='true'&&lastWarmDay!==day){
     const warm=await prewarmSummaries({db,env,now,after});after=warm.next||'';if(!warm.next)lastWarmDay=day;
    }
    const result=await projectSummaryOnce({db,env,now});
    const code=publicationBlockCode(result);
    if(code)return block(code);
    // Unknown blocked states must also fail closed rather than refreshing health.
    if(result.state==='blocked')return block('ANALYTICS_PUBLICATION_QUARANTINED');
    if(result.state==='failed')log({event:'analytics_projection_failed',code:result.code,phase:result.phase,projectId:result.projectId,durationMs:result.durationMs});
    else {lastSuccess=now();initialized=true;}
    if(result.state==='published')log({event:'analytics_projection_published',projectId:result.projectId,sourceRevision:result.sourceRevision,durationMs:result.durationMs});
    if(++ticks%60===0){await assertPublicationSafe(db);await cleanupSummaries(db,now());}
    return result;
   }catch(error){
    const code=publicationBlockCode(error);
    if(code)return block(code);
    // Do not emit exception text, SQL, endpoints, credentials or evidence.
    log({event:'analytics_projector_unavailable'});
    return {state:'unavailable'};
   }finally{running=false;}
  },
 };
}
