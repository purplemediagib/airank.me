import { one,exec,transaction } from './shared.mjs';
import { uuid } from '../common/utils.mjs';
import {apiBudgetPlan} from '../providers/budget-config.mjs';
import {id,checksum} from './budget-migration.mjs';

// The caller must hold the same write transaction that claims mon_tasks.
// There are deliberately no release/refund operations: every attempted paid
// sequence remains charged at its ceiling, including ambiguous interruptions.
export async function reserveApiBudget(tx,task,env,now){
 const route=JSON.parse(task.route);
 let plan;
 try{plan=apiBudgetPlan({provider:task.provider,route,prompt:task.text,context:JSON.parse(task.snapshot),env});}
 catch(error){return {reason:error.message.startsWith('API_')?error.message:'API_BUDGET_INVALID_CONFIG'};}
 if(plan.mode==='legacy_call_cap_only')return {plan};
 if((await one(tx,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)
  return {reason:'API_BUDGET_MIGRATION_REQUIRED'};
 const old=await one(tx,'SELECT config_json FROM mon_api_reservations WHERE task_id=?',[task.id]);
 // Duplicate reservation is not authorization to dispatch a second paid call.
 if(old)return {reason:'API_BUDGET_ALREADY_RESERVED'};
 const used=Number((await one(tx,'SELECT COALESCE(SUM(reserved_nano_usd),0) n FROM mon_api_reservations WHERE reserved_at>?',[now-86400000])).n);
 if(!Number.isSafeInteger(used)||used+plan.reservedNano>plan.dailyNano)return {reason:'API_BUDGET_EXHAUSTED'};
 await exec(tx,'INSERT INTO mon_api_reservations VALUES (?,?,?,?)',[task.id,plan.reservedNano,now,JSON.stringify(plan)]);
 return {plan};
}
export async function usedCalls(db,since){
 const legacy=Number((await one(db,'SELECT COUNT(*) n FROM provider_calls WHERE created_at>?',[since])).n);
 const hasMonitor=await one(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='mon_budget'");
 return legacy+(hasMonitor?Number((await one(db,'SELECT COUNT(*) n FROM mon_budget WHERE reserved_at>?',[since])).n):0);
}
export async function reserveQuickCall(db,{scanId,provider,daily,perRun,now=Date.now()}){
 return transaction(db,async tx=>{
  const runCount=Number((await one(tx,'SELECT COUNT(*) n FROM provider_calls WHERE scan_id=?',[scanId])).n);
  if(runCount>=perRun||await usedCalls(tx,now-86400000)>=daily)return false;
  await exec(tx,'INSERT INTO provider_calls (id,scan_id,provider,created_at) VALUES (?,?,?,?)',[uuid(),scanId,provider,now]);return true;
 });
}
