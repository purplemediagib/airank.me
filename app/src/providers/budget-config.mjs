import {isGuestKimi,KIMI_GUEST_ROUTE} from './routing.mjs';
import {promptContext} from './common.mjs';
import {measurementContext} from '../common/measurement-context.mjs';
import {claudeOutputBudget} from './claude.mjs';
import {openrouterDefaultOutputTokens} from './output-limits.mjs';
import {openrouterPrompt,openrouterSearchLimits} from './openrouter-policy.mjs';
import {googleAioMaxRequests} from './google-aio.mjs';
import {recoveryEnabled,recoveryRoute,recoveryOutputTokens} from './recovery-policy.mjs';

export const NANO_USD=1_000_000_000;
const invalid=()=>{throw Error('API_BUDGET_INVALID_CONFIG');};
const integer=(v,min,max)=>{if(!Number.isSafeInteger(v)||v<min||v>max)invalid();return v;};
const rate=v=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1000000)invalid();return v;};
export function completionLimit(provider,route,env){
 if(provider==='claude'&&route.transport==='direct'){
  try{return claudeOutputBudget(env);}catch{invalid();}
 }
 const value=route.transport==='openrouter'?env.OPENROUTER_MAX_TOKENS??openrouterDefaultOutputTokens(route.model):
  provider==='openai'?1250:8192;
 return integer(Number(value),256,16384);
}

// A full model context allowance includes server-added search content and replay.
// Prices and that model-specific context ceiling are operator supplied, never inferred.
export function apiBudgetPlan({provider,route,prompt,context,env,guest=null,allowRecovery=true}){
 if(guest)return guestBudgetPlan({provider,route,prompt,context,env,guest});
 const outputTokens=completionLimit(provider,route,env);
 if(!env.API_BUDGET_CONFIG_JSON){
  if(provider==='claude'&&route.transport==='direct'&&outputTokens<=1400)
   return {mode:'legacy_call_cap_only',maxTokens:outputTokens,maxSearches:3,maxRequests:2};
  throw Error('API_BUDGET_NOT_CONFIGURED');
 }
 let config;try{config=JSON.parse(env.API_BUDGET_CONFIG_JSON);}catch{invalid();}
 if(!config||typeof config!=='object'||Array.isArray(config)||!config.routes||typeof config.routes!=='object'||Array.isArray(config.routes))invalid();
 // Explicit JSON null removes the aggregate daily stop, not per-call validation.
 const dailyNano=config.dailyUsd===null?null:Math.floor(rate(config.dailyUsd)*NANO_USD);
 if(dailyNano!==null&&(!Number.isSafeInteger(dailyNano)||dailyNano<=0))invalid();
 const price=config.routes[provider];
 if(!price)throw Error('API_BUDGET_NOT_CONFIGURED');
 if(price.transport!==route.transport||price.model!==route.model||
  (route.transport==='openrouter'&&price.searchEngine!==route.search_engine))
  throw Error('API_BUDGET_ROUTE_MISMATCH');
 const maxInputBytes=integer(price.maxInputBytes,1,1000000);
 const input=route.transport==='openrouter'?openrouterPrompt(prompt,measurementContext(context),route.model):promptContext(prompt,measurementContext(context));
 if(Buffer.byteLength(input,'utf8')>maxInputBytes)throw Error('API_INPUT_LIMIT');
 const maxRequests=route.transport==='dataforseo'&&provider==='google_aio'?googleAioMaxRequests:provider==='claude'&&route.transport==='direct'?2:1;
 let reservedNano,limits;
 if(route.transport==='dataforseo'&&provider==='google_aio'){
  // Reserve both potentially billable live requests before the first attempt.
  const requestUsd=rate(price.requestUsd);
  reservedNano=maxRequests*Math.ceil(requestUsd*NANO_USD);
  limits={requestUsd};
 }else{
  // Perplexity Agent has no verified hard tool-invocation ceiling in this adapter.
  // Do not treat an unverified/ignored request parameter as a monetary guarantee.
  if(provider==='perplexity'&&route.transport==='direct')throw Error('API_BUDGET_UNBOUNDED_ROUTE');
  if(!['direct','openrouter'].includes(route.transport)||
   (route.transport==='direct'&&!['claude','openai','grok'].includes(provider)))
   throw Error('API_BUDGET_UNBOUNDED_ROUTE');
  const contextWindowTokens=integer(price.contextWindowTokens,outputTokens,10000000);
  // maxInputBytes is an additional local payload limit, not a token estimator.
  if(maxInputBytes>contextWindowTokens)invalid();
  const maxReplayBytes=provider==='claude'?integer(price.maxReplayBytes,1,10000000):0;
  const inputRate=rate(price.inputUsdPerMillion),outputRate=rate(price.outputUsdPerMillion);
  const searchRate=rate(price.searchUsdPerCall);
  const kimi=isGuestKimi(route);
  if(kimi&&(provider!=='kimi'||route.model!==KIMI_GUEST_ROUTE.model||route.search_engine!=='exa'||contextWindowTokens<1048576||inputRate<2||outputRate<10||searchRate<0.007))invalid();
  const maxSearches=kimi?2:route.transport==='openrouter'?openrouterSearchLimits(route.model).max_uses:3;
  const modelPasses=kimi?3:1;
  reservedNano=maxRequests*(modelPasses*(Math.ceil(contextWindowTokens*inputRate*NANO_USD/1000000)+
   Math.ceil(outputTokens*outputRate*NANO_USD/1000000))+Math.ceil(maxSearches*searchRate*NANO_USD));
  limits={contextWindowTokens,maxReplayBytes,maxSearches,...(kimi?{modelPasses}:{}),inputUsdPerMillion:inputRate,
   outputUsdPerMillion:outputRate,searchUsdPerCall:searchRate};
 }
 if(!Number.isSafeInteger(reservedNano)||reservedNano<=0)invalid();
 const plan={version:1,mode:'monetary_reserved',provider,transport:route.transport,model:route.model,
  ...(route.search_engine?{searchEngine:route.search_engine}:{}),dailyNano,reservedNano,
  maxTokens:outputTokens,maxRequests,maxInputBytes,...limits};
 if(allowRecovery&&recoveryEnabled(env)&&recoveryRoute(provider,route)){
  const tokens=Math.min(recoveryOutputTokens(outputTokens),plan.contextWindowTokens);
  const recovery=apiBudgetPlan({provider,route,prompt,context,allowRecovery:false,
   env:{...env,...(route.transport==='openrouter'?{OPENROUTER_MAX_TOKENS:String(tokens)}:{CLAUDE_MAX_TOKENS:String(tokens)})}});
  // Retain both ceilings even if recovery is unnecessary or the first call timed out.
  plan.reservedNano+=recovery.reservedNano;
  if(!Number.isSafeInteger(plan.reservedNano))invalid();
  plan.recovery=recovery;
 }
 return plan;
}

// Free (guest) checks use their own operator-supplied price table and caps in
// PUBLIC_CHECK_BUDGET_CONFIG_JSON. Paid tracking never reads it, and guests never
// read API_BUDGET_CONFIG_JSON. Missing/invalid config fails closed.
export function guestBudgetConfig(env){
 if(!env.PUBLIC_CHECK_BUDGET_CONFIG_JSON)throw Error('PUBLIC_CHECK_BUDGET_NOT_CONFIGURED');
 let config;try{config=JSON.parse(env.PUBLIC_CHECK_BUDGET_CONFIG_JSON);}catch{invalid();}
 if(!config||typeof config!=='object'||Array.isArray(config)||!config.routes||typeof config.routes!=='object'||Array.isArray(config.routes))invalid();
 // Both guest caps are mandatory monetary ceilings; null/zero is never "unlimited".
 const perScanNano=Math.floor(rate(config.perScanUsd)*NANO_USD),dailyNano=Math.floor(rate(config.dailyUsd)*NANO_USD);
 if(!Number.isSafeInteger(perScanNano)||perScanNano<=0||!Number.isSafeInteger(dailyNano)||dailyNano<=0||perScanNano>dailyNano)invalid();
 return {config,perScanNano,dailyNano};
}
function guestBudgetPlan({provider,route,prompt,context,env,guest}){
 if(!guest.providers.includes(provider))throw Error('API_BUDGET_UNBOUNDED_ROUTE');
 const {config,perScanNano,dailyNano}=guestBudgetConfig(env);
 const outputTokens=isGuestKimi(route)?3000:route.transport==='openrouter'?guest.openrouterOutputTokens:completionLimit(provider,route,env);
 const plan=apiBudgetPlan({provider,route,prompt,context,allowRecovery:false,env:{...env,API_BUDGET_CONFIG_JSON:JSON.stringify({dailyUsd:null,routes:config.routes}),
  ...(route.transport==='openrouter'?{OPENROUTER_MAX_TOKENS:String(outputTokens)}:{})}});
 if(plan.mode!=='monetary_reserved')throw Error('API_BUDGET_NOT_CONFIGURED');
 if(plan.reservedNano>perScanNano)throw Error('API_BUDGET_EXHAUSTED');
 return {...plan,scope:'public_check',dailyNano,perScanNano};
}

export function enforceBudgetInput(budget,provider,route,prompt,context){
 if(!budget||budget.mode!=='monetary_reserved')return;
 if(budget.provider!==provider||budget.transport!==route.transport||budget.model!==route.model||
  (route.transport==='openrouter'&&budget.searchEngine!==route.search_engine))
  throw Error('API_BUDGET_ROUTE_MISMATCH');
 const input=route.transport==='openrouter'?openrouterPrompt(prompt,context,route.model):promptContext(prompt,context);
 if(Buffer.byteLength(input,'utf8')>budget.maxInputBytes)throw Error('API_INPUT_LIMIT');
}
