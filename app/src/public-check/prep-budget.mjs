import {one,exec,transaction,fail,hash} from '../monitoring/shared.mjs';
import {uuid} from '../common/utils.mjs';
import {NANO_USD,guestBudgetConfig} from '../providers/budget-config.mjs';
import {maxHttpAttempts} from '../providers/rate-limit.mjs';
import {id as scanId,checksum as scanChecksum} from './budget-migration.mjs';
import {id,checksum} from './prep-migration.mjs';

export const PREP_STAGES=Object.freeze(['scrape','identity','questions']);
export const PREP_REUSE_MS=6*3600000;
// Reserve the operator-verified full model context, including server-added chat
// framing/schema. Serialized bytes are only a local payload cap, not a token
// estimator. Unknown model context or pricing fails closed.
const bad=reason=>{throw Object.assign(Error(reason),{reason});};
const usd=v=>{if(typeof v!=='number'||!Number.isFinite(v)||v<=0||v>1000000)bad('API_BUDGET_INVALID_CONFIG');return v;};
const nano=v=>{const n=Math.ceil(usd(v)*NANO_USD);if(!Number.isSafeInteger(n))bad('API_BUDGET_INVALID_CONFIG');return n;};

export function prepConfig(env){
 let guest;try{guest=guestBudgetConfig(env);}catch(e){bad(e.message.startsWith('PUBLIC_CHECK_')?e.message:'API_BUDGET_INVALID_CONFIG');}
 const p=guest.config.preparation;
 if(!p||typeof p!=='object'||Array.isArray(p))bad('PUBLIC_CHECK_PREP_BUDGET_NOT_CONFIGURED');
 const stageNano=nano(p.maxStageUsd),visitorNano=nano(p.visitorDailyUsd);
 if(stageNano>visitorNano||visitorNano>guest.dailyNano)bad('API_BUDGET_INVALID_CONFIG');
 return {p,stageNano,visitorNano,dailyNano:guest.dailyNano};
}
// Worst-case monetary ceiling for one billable preparation stage.
export function prepPlan({stage,model,body,maxTokens},env){
 if(!PREP_STAGES.includes(stage))bad('API_BUDGET_UNBOUNDED_ROUTE');
 const {p,stageNano,visitorNano,dailyNano}=prepConfig(env);
 const price=p[stage==='scrape'?'firecrawl':stage];
 if(!price||typeof price!=='object')bad('API_BUDGET_NOT_CONFIGURED');
 let reservedNano,limits;
 if(stage==='scrape'){
  // One Firecrawl /v2/scrape request, never retried here. requestUsd is the
  // operator's worst-case price for one scrape on their plan (incl. any
  // enhanced-proxy surcharge Firecrawl may apply).
  reservedNano=nano(price.requestUsd);limits={requests:1,requestUsd:price.requestUsd};
 }else{
  if(typeof model!=='string'||price.model!==model)bad('API_BUDGET_ROUTE_MISMATCH');
  if(!Number.isSafeInteger(maxTokens)||maxTokens<1)bad('API_BUDGET_UNBOUNDED_ROUTE');
  const inputTokens=price.contextWindowTokens,maxInputBytes=price.maxInputBytes;
  if(!Number.isSafeInteger(inputTokens)||inputTokens<maxTokens||inputTokens>10000000||
   !Number.isSafeInteger(maxInputBytes)||maxInputBytes<1||maxInputBytes>1000000||maxInputBytes>inputTokens)bad('API_BUDGET_INVALID_CONFIG');
  if(Buffer.byteLength(String(body),'utf8')>maxInputBytes)bad('API_INPUT_LIMIT');
  const inRate=usd(price.inputUsdPerMillion),outRate=usd(price.outputUsdPerMillion);
  // Only HTTP 429 is retried, at most maxHttpAttempts in total; reserve all.
  const attempts=stage==='questions'?maxHttpAttempts:1;
  reservedNano=attempts*(Math.ceil(inputTokens*inRate*NANO_USD/1e6)+Math.ceil(maxTokens*outRate*NANO_USD/1e6));
  limits={requests:attempts,inputTokens,maxInputBytes,maxTokens,model};
 }
 if(!Number.isSafeInteger(reservedNano)||reservedNano<=0)bad('API_BUDGET_INVALID_CONFIG');
 if(reservedNano>stageNano)bad('PREP_STAGE_BUDGET_EXCEEDED');
 return {version:1,scope:'public_check_prep',stage,reservedNano,stageNano,visitorNano,dailyNano,...limits};
}

// Atomic: one paid attempt per stage key per 6 h, visitor 24 h cap, and the
// SAME rolling 24 h guest ceiling shared with scan reservations. No refunds.
export async function reservePrepStage(db,{stageKey,fingerprint,plan,now}){
 return transaction(db,async tx=>{
  for(const [m,c] of [[id,checksum],[scanId,scanChecksum]])
   if((await one(tx,'SELECT checksum FROM app_migrations WHERE id=?',[m]))?.checksum!==c)return {reason:'PUBLIC_CHECK_BUDGET_MIGRATION_REQUIRED'};
  if(await one(tx,'SELECT id FROM public_check_prep_reservations WHERE stage_key=? AND reserved_at>?',[stageKey,now-PREP_REUSE_MS]))return {reason:'PREP_ALREADY_RESERVED'};
  const visitor=Number((await one(tx,'SELECT COALESCE(SUM(reserved_nano_usd),0) n FROM public_check_prep_reservations WHERE fingerprint=? AND reserved_at>?',[fingerprint,now-86400000])).n);
  if(visitor+plan.reservedNano>plan.visitorNano)return {reason:'PREP_VISITOR_BUDGET_EXHAUSTED'};
  if(await guestDailyNano(tx,now)+plan.reservedNano>plan.dailyNano)return {reason:'GUEST_DAILY_BUDGET_EXHAUSTED'};
  await exec(tx,'INSERT INTO public_check_prep_reservations VALUES (?,?,?,?,?,?,?)',[uuid(),stageKey,fingerprint,plan.stage,plan.reservedNano,now,JSON.stringify(plan)]);
  return {plan};
 });
}
export async function guestDailyNano(tx,now){
 const a=Number((await one(tx,'SELECT COALESCE(SUM(reserved_nano_usd),0) n FROM public_check_api_reservations WHERE reserved_at>?',[now-86400000])).n);
 const b=Number((await one(tx,'SELECT COALESCE(SUM(reserved_nano_usd),0) n FROM public_check_prep_reservations WHERE reserved_at>?',[now-86400000])).n);
 const total=a+b;if(!Number.isSafeInteger(total))bad('API_BUDGET_INVALID_CONFIG');return total;
}

// Hook handed to the billable preparation functions. It runs BEFORE their
// network request and throws (no request) when the stage cannot be reserved.
export function prepReserver({db,fingerprint,requestKey,env,now}){
 return async request=>{
  let plan;
  try{plan=prepPlan(request,env);}
  catch(e){const reason=e.reason||'API_BUDGET_INVALID_CONFIG';throw Object.assign(Error('AI_UNAVAILABLE'),{status:503,code:'AI_UNAVAILABLE',reason});}
  const r=await reservePrepStage(db,{stageKey:hash([requestKey,request.stage]),fingerprint,plan,now:now()});
  if(!r.plan){
   const limited=/EXHAUSTED$/.test(r.reason);
   throw Object.assign(Error(limited?'PREPARATION_RATE_LIMIT':'AI_UNAVAILABLE'),{status:limited?429:503,code:limited?'PREPARATION_RATE_LIMIT':'AI_UNAVAILABLE',reason:r.reason});
  }
  return r.plan;
 };
}
export {fail};

// Configuration readiness only; actual serialized input and remaining aggregate
// limits are checked again atomically immediately before each provider request.
export function guestAutofillConfigured(env){
 if(env.WEBSITE_PROFILE_ENABLED!=='true'||!env.FIRECRAWL_API_KEY||!env.OPENAI_API_KEY)return false;
 try{
  prepPlan({stage:'scrape'},env);
  prepPlan({stage:'identity',model:env.WEBSITE_PROFILE_MODEL||'gpt-4.1-mini',body:'',maxTokens:700},env);
  return true;
 }catch{return false;}
}
