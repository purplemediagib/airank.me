import { uuid } from '../common/utils.mjs';
import { callRoute } from '../providers/dispatch.mjs';
import { routeAvailable } from '../providers/routing.mjs';
import { profileEvidence } from '../common/scan-profile.mjs';
import { one,exec,transaction,setting,hash,normalized } from './shared.mjs';
import {measurementContext} from '../common/measurement-context.mjs';
import {reconcileObservation} from '../common/observations.mjs';
import { usedCalls,reserveApiBudget } from './budget.mjs';
import {observeProvider,resultDetails,logEvent} from '../providers/diagnostics.mjs';
import {isCollectorRoute} from '../collectors/config.mjs';
import {createCollectionRunner} from '../collectors/runner.mjs';

// Persistent state machine: queued -> executing -> recorded -> done.
// An expired executing lease WITHOUT a receipt is ambiguous and is NEVER replayed.
export function createMonitoringEngine({db,env=process.env,now=Date.now,call=callRoute,available=routeAvailable,storeEvidence,logger=logEvent,collectorClient}){
 const concurrency=setting(env,'MONITORING_CONCURRENCY',2,1,8);
 const timeout=setting(env,'MONITORING_PROVIDER_TIMEOUT_MS',120000,10,600000);
 const daily=setting(env,'MAX_DAILY_PROVIDER_CALLS',200,0,1000000);
 const buffered=new Map();
 let busy=false;
 const evidenceFor=(task,result,observedAt)=>{
  const snapshot=JSON.parse(task.snapshot),identity=snapshot.identity;
  const consumer=isCollectorRoute(JSON.parse(task.route));
  if(!consumer)result=reconcileObservation({...result,provider:task.provider},snapshot,{truncated:String(result.answer||'').length>100000});
  const answer=consumer?String(result.answer||''):String(result.answer||'').slice(0,100000);
  const citations=Array.isArray(result.citations)?result.citations.slice(0,200).map(c=>({url:String(c.url||''),...(c.title?{title:String(c.title).slice(0,1000)}:{})})):[];
  const matches=profileEvidence(answer,{brand_name:identity.brandName,aliases:identity.aliases,domain:identity.ownedDomains[0]},citations);
  const status=result.status==='success'&&!answer.trim()?'no_valid_response':result.status||'provider_failed';
  const details=resultDetails({...result,status});
  const budget=JSON.parse(task.route).api_budget;
  const monetary=budget?{api_budget_mode:budget.mode,...(budget.reservedNano?{api_reserved_nano_usd:budget.reservedNano}:{})}:{};
  return {id:task.id,runId:task.run_id,promptId:task.prompt_id,promptVersion:Number(task.prompt_version),text:task.text,provider:task.provider,model:result.model||(consumer?null:JSON.parse(task.route).model),status,answer,citations,...(result.collection?{collection:result.collection}:{}),...(result.observation?{observation:result.observation}:{}),observedAt,mentioned:status==='success'&&matches.mentioned,ownedCitation:status==='success'&&matches.ownCitation,methodology:snapshot.methodology,kind:snapshot.kind,error:details.error,meta:{...details.meta,...monetary,measurement_surface:consumer?'consumer_web':details.meta.measurement_surface||'model_api'}};
 };
 const saveReceipt=async(task,evidence)=>transaction(db,async tx=>{
  const current=await one(tx,'SELECT status,claim_token FROM mon_tasks WHERE id=?',[task.id]);
  if(current.status==='done'||current.status==='recorded')return;
  if(!['executing','collecting'].includes(current.status)||current.claim_token!==task.claim_token)return;
  await exec(tx,'INSERT OR IGNORE INTO mon_receipts VALUES (?,?,?)',[task.id,JSON.stringify(evidence),evidence.observedAt]);
  await exec(tx,"UPDATE mon_tasks SET status='recorded' WHERE id=?",[task.id]);
 });
 const finalize=async(task,status,tx,reason)=>{
  const evidence=evidenceFor(task,{status,meta:reason?{failure_code:reason}:{}},now());
  await exec(tx,'INSERT OR IGNORE INTO mon_receipts VALUES (?,?,?)',[task.id,JSON.stringify(evidence),evidence.observedAt]);
  await exec(tx,"UPDATE mon_tasks SET status='recorded' WHERE id=?",[task.id]);
  logger('provider_skipped',{run_id:task.run_id,task_id:task.id,provider:task.provider,status,reason:evidence.error});
 };
 const flush=async()=>{
  for(const [id,pending]of buffered){try{await saveReceipt(pending.task,pending.evidence);buffered.delete(id);}catch{logger('evidence_storage_pending',{task_id:id,stage:'receipt'});}}
  const receipts=(await exec(db,`SELECT t.id,t.run_id,r.payload,r.observed_at FROM mon_tasks t JOIN mon_receipts r ON r.task_id=t.id WHERE t.status='recorded' ORDER BY r.observed_at LIMIT 200`)).rows;
  for(const r of receipts){
   try{await transaction(db,async tx=>{
    if(storeEvidence)await storeEvidence(r); // Fault injection only; production persistence is below.
    await exec(tx,'INSERT OR IGNORE INTO mon_evidence VALUES (?,?,?,?)',[r.id,r.run_id,r.payload,r.observed_at]);
    await exec(tx,"UPDATE mon_tasks SET status='done',lease_until=NULL WHERE id=?",[r.id]);
   });logger('evidence_saved',{run_id:r.run_id,task_id:r.id});}catch{logger('evidence_storage_pending',{run_id:r.run_id,task_id:r.id,stage:'evidence'});}
  }
 };
 const recover=()=>transaction(db,async tx=>{
  const rows=(await exec(tx,`SELECT t.*,r.snapshot,r.deadline_at FROM mon_tasks t JOIN mon_runs r ON r.id=t.run_id WHERE (t.status='executing' AND t.lease_until<=?) OR (t.status='queued' AND r.deadline_at<=?)`,[now(),now()])).rows;
  for(const t of rows){
   if(await one(tx,'SELECT task_id FROM mon_receipts WHERE task_id=?',[t.id]))await exec(tx,"UPDATE mon_tasks SET status='recorded' WHERE id=?",[t.id]);
   else await finalize(t,t.status==='executing'?'interrupted_unknown':'deadline_not_started',tx);
  }
 });
 const claim=()=>transaction(db,async tx=>{
  const running=Number((await one(tx,"SELECT COUNT(*) n FROM mon_tasks WHERE status IN ('executing','collecting')")).n);
  if(running>=concurrency)return null;
  const t=await one(tx,`SELECT t.*,r.snapshot,r.deadline_at,r.project_id FROM mon_tasks t JOIN mon_runs r ON r.id=t.run_id WHERE t.status='queued' AND r.deadline_at>? ORDER BY r.created_at,t.id LIMIT 1`,[now()]);
  if(!t)return null;
  const snapshot=JSON.parse(t.snapshot);
  const project=await one(tx,'SELECT status FROM app_projects WHERE id=?',[t.project_id]);
  if(project?.status!=='active'){await finalize(t,'cancelled',tx,'PROJECT_ARCHIVED');return {skipped:true};}
  if(snapshot.collectionTrigger==='immediate'){
   const p=await one(tx,'SELECT status,hash FROM mon_prompts WHERE id=?',[t.prompt_id]);
   const frozen=snapshot.prompts.find(p=>p.id===t.prompt_id);
   if(p?.status!=='active'||!frozen||p.hash!==hash([frozen.kind,normalized(frozen.text),measurementContext(frozen)])){
    await finalize(t,'cancelled',tx,'PROMPT_NOT_CURRENT');return {skipped:true};
   }
  }
  const route=JSON.parse(t.route);
  if(!(env.ENABLED_PROVIDERS||'openai,claude').split(',').map(x=>x.trim()).includes(t.provider)){await finalize(t,'unconfigured',tx,'PROVIDER_DISABLED');return {skipped:true};}
  if(!available(t.provider,route,env)){await finalize(t,'unconfigured',tx,'MISSING_CREDENTIAL');return {skipped:true};}
  const used=await usedCalls(tx,now()-86400000);
  if(used>=daily){await finalize(t,'budget_blocked',tx);return {skipped:true};}
  if(isCollectorRoute(route)){
   const reason=await collectors.reserve(tx,t);
   if(reason){await finalize(t,reason==='COLLECTOR_BUDGET_EXHAUSTED'?'budget_blocked':'unconfigured',tx,reason);return {skipped:true};}
  }else{
   const reservation=await reserveApiBudget(tx,t,env,now());
   if(reservation.reason){
    await finalize(t,reservation.reason==='API_BUDGET_EXHAUSTED'?'budget_blocked':'unconfigured',tx,reservation.reason);
    return {skipped:true};
   }
   route.api_budget=reservation.plan;
   t.route=JSON.stringify(route);
   await exec(tx,'UPDATE mon_tasks SET route=? WHERE id=?',[t.route,t.id]);
  }
  const token=uuid(),lease=Math.min(Number(t.deadline_at),now()+timeout);
  await exec(tx,'INSERT INTO mon_budget VALUES (?,?)',[t.id,now()]);
  await exec(tx,"UPDATE mon_tasks SET status='executing',claim_token=?,lease_until=? WHERE id=? AND status='queued'",[token,lease,t.id]);
  await exec(tx,"UPDATE mon_runs SET status='running' WHERE id=? AND status='queued'",[t.run_id]);
  return {...t,claim_token:token,lease_until:lease};
 });
 const execute=async task=>{
  if(isCollectorRoute(JSON.parse(task.route)))return collectors.submit(task);
  let timer,result;
  const duration=Math.max(1,task.lease_until-now());
  try{
   result=await observeProvider({provider:task.provider,route:JSON.parse(task.route),timeoutMs:duration,ids:{run_id:task.run_id,task_id:task.id},logger,call:()=>Promise.race([
    Promise.resolve().then(()=>call(task.provider,task.text,JSON.parse(task.route),duration,JSON.parse(task.snapshot))),
    new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'timeout_unknown'}),duration);}),
   ])});
  }finally{clearTimeout(timer);}
  result=result||{status:'provider_failed'};
   const evidence=evidenceFor(task,result,now());
  buffered.set(task.id,{task,evidence});
  try{await saveReceipt(task,evidence);buffered.delete(task.id);await flush();}catch{logger('evidence_storage_pending',{run_id:task.run_id,task_id:task.id,stage:'receipt'});}
 };
 const collectors=createCollectionRunner({db,env,now,client:collectorClient,logger,complete:async(task,result)=>{
  const evidence=evidenceFor(task,result,now());
  buffered.set(task.id,{task,evidence});
  try{await saveReceipt(task,evidence);buffered.delete(task.id);}catch{logger('evidence_storage_pending',{task_id:task.id,stage:'collector_receipt'});}
 }});
 const summarize=()=>transaction(db,async tx=>{
  const runs=(await exec(tx,"SELECT * FROM mon_runs WHERE status IN ('queued','running')")).rows;
  for(const r of runs){
   const remaining=Number((await one(tx,"SELECT COUNT(*) n FROM mon_tasks WHERE run_id=? AND status<>'done'",[r.id])).n);
   if(remaining){
    const recorded=Number((await one(tx,"SELECT COUNT(*) n FROM mon_tasks WHERE run_id=? AND status='recorded'",[r.id])).n);
    if(recorded)await exec(tx,"UPDATE mon_runs SET reason='evidence_storage_pending' WHERE id=?",[r.id]);
    continue;
   }
   const valid=Number((await one(tx,"SELECT COUNT(*) n FROM mon_evidence WHERE run_id=? AND json_extract(payload,'$.status')='success'",[r.id])).n);
   const budget=Number((await one(tx,"SELECT COUNT(*) n FROM mon_evidence WHERE run_id=? AND json_extract(payload,'$.status')='budget_blocked'",[r.id])).n);
   await exec(tx,'UPDATE mon_runs SET status=?,reason=? WHERE id=?',[valid===Number(r.expected)?'complete':valid?'partial':budget?'capacity_blocked':'unavailable',budget?'daily_budget_exhausted':null,r.id]);
  }
 });
 return {
  async tick(){
   if(busy)return;busy=true;
   try{
    await collectors.flush();await flush();await recover();await flush();
    await collectors.poll(concurrency);
    const tasks=[];
    // One sweep handles non-callable tasks without leaving a large panel stuck.
    for(let i=0;i<1000&&tasks.length<concurrency;i++){
     const t=await claim();if(!t)break;if(!t.skipped)tasks.push(t);
    }
    await Promise.all(tasks.map(execute));
    await flush();await summarize();
   }finally{busy=false;}
  },
 };
}
