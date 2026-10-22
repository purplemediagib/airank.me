import {one,exec,transaction} from '../monitoring/shared.mjs';
import {uuid} from '../common/utils.mjs';
import {collectionBudget} from './config.mjs';
import {id,checksum} from './migration.mjs';
import {createCollectorClient} from './client.mjs';
import {normalizeCollection,evidencePayload} from './normalization.mjs';

// POST is only called by submit on a freshly claimed task. Recovery only uses GET.
export function createCollectionRunner({db,env,now,complete,client=createCollectorClient({env}),logger}){
 const submissions=new Map();
 async function persist(task,submission){
  await transaction(db,async tx=>{
   const t=await one(tx,'SELECT status,claim_token FROM mon_tasks WHERE id=?',[task.id]);
   if(t?.status!=='executing'||t.claim_token!==task.claim_token)return;
   await exec(tx,"UPDATE mon_collections SET remote_id=?,phase='submitted',meta_json=?,next_poll_at=? WHERE task_id=? AND phase='reserved'",[submission.remoteId,JSON.stringify(submission.meta||{}),now()+5000,task.id]);
   await exec(tx,"UPDATE mon_tasks SET status='collecting',lease_until=NULL WHERE id=?",[task.id]);
  });
 }
 async function finish(task,result){await complete(task,result);}
 return {
  async reserve(tx,task){
   if(env.CONSUMER_COLLECTION_ENABLED!=='true')return 'CONSUMER_COLLECTION_DISABLED';
   if((await one(tx,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)return 'COLLECTOR_MIGRATION_REQUIRED';
   const budget=collectionBudget(env,task.provider);if(!budget)return 'COLLECTOR_BUDGET_NOT_CONFIGURED';
   const used=Number((await one(tx,'SELECT COALESCE(SUM(reserved_usd),0) n FROM mon_collections WHERE reserved_at>?',[now()-86400000])).n);
   if(used+budget.unit>budget.daily+1e-10)return 'COLLECTOR_BUDGET_EXHAUSTED';
   await exec(tx,"INSERT INTO mon_collections VALUES (?,NULL,'reserved',?,?,?,NULL,'{}')",[task.id,budget.unit,now(),now()]);
   return null;
  },
  async submit(task){
   const route=JSON.parse(task.route);
   let submission;
   try{submission=await client.submit({provider:task.provider,route,prompt:task.text,context:JSON.parse(task.snapshot),taskId:task.id});}
   catch{await finish(task,{status:'provider_failed',meta:{failure_code:'COLLECTOR_PREFLIGHT_FAILED',measurement_surface:'consumer_web'}});return;}
   if(submission.result){await finish(task,submission.result);return;}
   submissions.set(task.id,{task,submission});
   try{await persist(task,submission);submissions.delete(task.id);}
   catch{logger('collector_storage_pending',{task_id:task.id});}
  },
  async flush(){
   for(const [key,{task,submission}]of submissions){try{await persist(task,submission);submissions.delete(key);}catch{logger('collector_storage_pending',{task_id:key});}}
  },
  async poll(concurrency){
   for(let i=0;i<concurrency;i++){
    const task=await transaction(db,async tx=>{
     const table=await one(tx,"SELECT name FROM sqlite_master WHERE type='table' AND name='mon_collections'");if(!table)return null;
     const t=await one(tx,`SELECT t.*,r.snapshot,r.deadline_at,c.remote_id,c.raw_json,c.meta_json,c.phase FROM mon_tasks t JOIN mon_runs r ON r.id=t.run_id JOIN mon_collections c ON c.task_id=t.id WHERE t.status='collecting' AND c.next_poll_at<=? AND (t.lease_until IS NULL OR t.lease_until<=?) ORDER BY c.next_poll_at,t.id LIMIT 1`,[now(),now()]);
     if(!t)return null;
     const token=uuid();await exec(tx,'UPDATE mon_tasks SET claim_token=?,lease_until=? WHERE id=?',[token,now()+45000,t.id]);return {...t,claim_token:token};
    });
    if(!task)return;
    const route=JSON.parse(task.route);
    try{
     if(!task.raw_json&&Number(task.deadline_at)<=now()){await finish(task,{status:'timeout_unknown',meta:{failure_code:'COLLECTOR_DEADLINE_EXCEEDED',task_id:task.remote_id,measurement_surface:'consumer_web'}});continue;}
     const result=task.raw_json?{status:task.phase==='received'?'ready':'failed',raw:JSON.parse(task.raw_json)}:await client.poll({provider:task.provider,route,remoteId:task.remote_id});
     if(result.status==='pending'){
      await transaction(db,async tx=>{
       await exec(tx,'UPDATE mon_collections SET next_poll_at=? WHERE task_id=?',[now()+5000,task.id]);
       await exec(tx,'UPDATE mon_tasks SET lease_until=NULL WHERE id=? AND claim_token=?',[task.id,task.claim_token]);
      });continue;
     }
     // Save original result BEFORE parsing or enrichment. A parser/storage failure never re-POSTs.
     const raw=evidencePayload(route,result.raw||{});
     await exec(db,"UPDATE mon_collections SET raw_json=COALESCE(raw_json,?),phase=? WHERE task_id=?",[JSON.stringify(raw),result.status==='ready'?'received':'failed',task.id]);
     let normalized;
     if(result.status==='ready'){
      try{normalized=normalizeCollection({provider:task.provider,route,raw,context:JSON.parse(task.snapshot),prompt:task.text,remoteId:task.remote_id,submissionMeta:JSON.parse(task.meta_json)});}
      catch{normalized={status:'provider_failed',meta:{failure_code:'COLLECTOR_PARSE_FAILED'}};}
     }else normalized={status:'provider_failed',meta:{failure_code:result.code||'COLLECTOR_EXECUTION_FAILED'}};
     normalized.meta={...normalized.meta,measurement_surface:'consumer_web',task_id:task.remote_id,transport:route.transport};
     await finish(task,normalized);
    }catch{
     // Only GET/persistence is retried, never submission. The run deadline bounds this path.
     logger('collector_poll_pending',{task_id:task.id});
     await exec(db,'UPDATE mon_collections SET next_poll_at=? WHERE task_id=?',[now()+10000,task.id]);
     await exec(db,'UPDATE mon_tasks SET lease_until=NULL WHERE id=? AND claim_token=?',[task.id,task.claim_token]);
    }
   }
  },
 };
}
