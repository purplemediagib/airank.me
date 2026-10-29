import {one,exec,transaction} from '../monitoring/shared.mjs';
import {usedCalls} from '../monitoring/budget.mjs';
import {uuid} from '../common/utils.mjs';
import {apiBudgetPlan} from '../providers/budget-config.mjs';
import {routesFromEnv,routeAvailable,publicProviders,PUBLIC_CHECK_PROVIDERS,GUEST_OPENROUTER_OUTPUT_TOKENS,GUEST_MAX_CALLS_PER_SCAN} from '../providers/routing.mjs';
import {callRoute} from '../providers/dispatch.mjs';
import {id,checksum} from './budget-migration.mjs';
import {id as prepId,checksum as prepChecksum} from './prep-migration.mjs';
import {guestDailyNano} from './prep-budget.mjs';
import {maxHttpAttempts} from '../providers/rate-limit.mjs';

export const GUEST_POLICY=Object.freeze({providers:PUBLIC_CHECK_PROVIDERS,openrouterOutputTokens:GUEST_OPENROUTER_OUTPUT_TOKENS});

export function guestPlan({provider,route,prompt,context,env}){
 const plan=apiBudgetPlan({provider,route,prompt,context,env,guest:GUEST_POLICY});
 // Provider adapters retry HTTP 429 up to maxHttpAttempts; guests reserve every attempt.
 const reservedNano=plan.reservedNano*maxHttpAttempts;
 if(!Number.isSafeInteger(reservedNano)||reservedNano>plan.perScanNano)throw Error('API_BUDGET_EXHAUSTED');
 return {...plan,reservedNano,httpAttempts:maxHttpAttempts};
}
// Capabilities list a provider only when the worker could actually reserve it.
export function guestBudgetReady(provider,route,env){
 if(!route)return false;
 try{guestPlan({provider,route,prompt:'',context:{},env});return true;}catch{return false;}
}

// One write transaction: idempotency, call count, per-scan money, rolling 24 h
// money and the existing daily call cap are checked together. No refunds: an
// attempted call stays charged at its ceiling, including crashes and timeouts.
export async function reserveGuestCall(db,{scanId,provider,promptId,route,prompt,context={},env,dailyCalls=null,maxCalls=GUEST_MAX_CALLS_PER_SCAN,now=Date.now()}){
 let plan;
 try{plan=guestPlan({provider,route,prompt,context,env});}
 catch(error){return {reason:/^(API_|PUBLIC_CHECK_)/.test(error.message)?error.message:'API_BUDGET_INVALID_CONFIG'};}
 return transaction(db,async tx=>{
  for(const [m,c] of [[id,checksum],[prepId,prepChecksum]])
   if((await one(tx,'SELECT checksum FROM app_migrations WHERE id=?',[m]))?.checksum!==c)return {reason:'PUBLIC_CHECK_BUDGET_MIGRATION_REQUIRED'};
  if(await one(tx,'SELECT id FROM public_check_api_reservations WHERE scan_id=? AND provider=? AND prompt_id=?',[scanId,provider,promptId]))return {reason:'API_BUDGET_ALREADY_RESERVED'};
  const scan=await one(tx,'SELECT COUNT(*) n,COALESCE(SUM(reserved_nano_usd),0) s FROM public_check_api_reservations WHERE scan_id=?',[scanId]);
  if(Number(scan.n)>=Math.min(maxCalls,GUEST_MAX_CALLS_PER_SCAN))return {reason:'GUEST_CALL_LIMIT'};
  if(Number(scan.s)+plan.reservedNano>plan.perScanNano)return {reason:'GUEST_SCAN_BUDGET_EXHAUSTED'};
  // One rolling 24 h ceiling shared by scan and preparation spending.
  const day=await guestDailyNano(tx,now);
  if(day+plan.reservedNano>plan.dailyNano)return {reason:'GUEST_DAILY_BUDGET_EXHAUSTED'};
  if(dailyCalls!==null&&await usedCalls(tx,now-86400000)>=dailyCalls)return {reason:'BUDGET_EXHAUSTED'};
  await exec(tx,'INSERT INTO provider_calls (id,scan_id,provider,created_at) VALUES (?,?,?,?)',[uuid(),scanId,provider,now]);
  await exec(tx,'INSERT INTO public_check_api_reservations VALUES (?,?,?,?,?,?,?)',[uuid(),scanId,provider,promptId,plan.reservedNano,now,JSON.stringify(plan)]);
  return {plan};
 });
}

// The guest execution step used by the worker: reserve first, then dispatch with
// the reserved plan attached so the request uses exactly the reserved limits.
export async function executeGuestCall({db,scanId,provider,promptId,prompt,route,context={},env,timeoutMs,dailyCalls=null,maxCalls,now=Date.now(),call=callRoute}){
 const r=await reserveGuestCall(db,{scanId,provider,promptId,route,prompt,context,env,dailyCalls,maxCalls,now});
 if(!r.plan)return {reserved:false,reason:r.reason};
 return {reserved:true,plan:r.plan,result:await call(provider,prompt,{...route,api_budget:r.plan},timeoutMs,context,{guest:true})};
}

// Providers a guest scan may list: allowlisted, enabled, and with a valid guest
// price route. With no guest budget configured the list is empty (fail closed).
export function budgetedPublicProviders(config,env=process.env){
 const listed=publicProviders(config);
 if(!listed.length)return [];
 let routes;try{routes=routesFromEnv({...env,ENABLED_PROVIDERS:listed.join(',')});}catch{return [];}
 return listed.filter(p=>routeAvailable(p,routes[p],env)&&guestBudgetReady(p,routes[p],env));
}

// API-local prerequisites only. Worker configuration must also be verified at release.
export async function readyPublicProviders(db,config,env=process.env){
 try{
  if(!db)return [];
  for(const [m,c] of [[id,checksum],[prepId,prepChecksum]])
   if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[m]))?.checksum!==c)return [];
  return budgetedPublicProviders(config,env);
 }catch{return [];}
}
