import {promptContext} from './common.mjs';
import {measurementContext} from '../common/measurement-context.mjs';
import {claudeOutputBudget} from './claude.mjs';

export const NANO_USD=1_000_000_000;
const invalid=()=>{throw Error('API_BUDGET_INVALID_CONFIG');};
const integer=(v,min,max)=>{if(!Number.isSafeInteger(v)||v<min||v>max)invalid();return v;};
const rate=v=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1000000)invalid();return v;};
export function completionLimit(provider,route,env){
 if(provider==='claude'&&route.transport==='direct'){
  try{return claudeOutputBudget(env);}catch{invalid();}
 }
 const value=route.transport==='openrouter'?env.OPENROUTER_MAX_TOKENS??(route.model.startsWith('google/gemini-')?8192:2000):
  provider==='openai'?1250:8192;
 return integer(Number(value),256,16384);
}

// A full model context allowance includes server-added search content and replay.
// Prices and that model-specific context ceiling are operator supplied, never inferred.
export function apiBudgetPlan({provider,route,prompt,context,env}){
 const outputTokens=completionLimit(provider,route,env);
 if(!env.API_BUDGET_CONFIG_JSON){
  if(provider==='claude'&&route.transport==='direct'&&outputTokens<=1400)
   return {mode:'legacy_call_cap_only',maxTokens:outputTokens,maxSearches:3,maxRequests:2};
  throw Error('API_BUDGET_NOT_CONFIGURED');
 }
 let config;try{config=JSON.parse(env.API_BUDGET_CONFIG_JSON);}catch{invalid();}
 if(!config||typeof config!=='object'||Array.isArray(config)||!config.routes||typeof config.routes!=='object'||Array.isArray(config.routes))invalid();
 const dailyNano=Math.floor(rate(config.dailyUsd)*NANO_USD);
 if(!Number.isSafeInteger(dailyNano)||dailyNano<=0)invalid();
 const price=config.routes[provider];
 if(!price)throw Error('API_BUDGET_NOT_CONFIGURED');
 if(price.transport!==route.transport||price.model!==route.model||
  (route.transport==='openrouter'&&price.searchEngine!==route.search_engine))
  throw Error('API_BUDGET_ROUTE_MISMATCH');
 const maxInputBytes=integer(price.maxInputBytes,1,1000000);
 const input=promptContext(prompt,measurementContext(context))+(route.transport==='openrouter'?' Include source citations.':'');
 if(Buffer.byteLength(input,'utf8')>maxInputBytes)throw Error('API_INPUT_LIMIT');
 const maxRequests=provider==='claude'&&route.transport==='direct'?2:1;
 let reservedNano,limits;
 if(route.transport==='dataforseo'&&provider==='google_aio'){
  // One live SERP request, including the requested asynchronous AI overview.
  const requestUsd=rate(price.requestUsd);
  reservedNano=Math.ceil(requestUsd*NANO_USD);
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
  const maxSearches=3;
  reservedNano=maxRequests*(Math.ceil(contextWindowTokens*inputRate*NANO_USD/1000000)+
   Math.ceil(outputTokens*outputRate*NANO_USD/1000000)+Math.ceil(maxSearches*searchRate*NANO_USD));
  limits={contextWindowTokens,maxReplayBytes,maxSearches,inputUsdPerMillion:inputRate,
   outputUsdPerMillion:outputRate,searchUsdPerCall:searchRate};
 }
 if(!Number.isSafeInteger(reservedNano)||reservedNano<=0)invalid();
 return {version:1,mode:'monetary_reserved',provider,transport:route.transport,model:route.model,
  ...(route.search_engine?{searchEngine:route.search_engine}:{}),dailyNano,reservedNano,
  maxTokens:outputTokens,maxRequests,maxInputBytes,...limits};
}

export function enforceBudgetInput(budget,provider,route,prompt,context){
 if(!budget||budget.mode!=='monetary_reserved')return;
 if(budget.provider!==provider||budget.transport!==route.transport||budget.model!==route.model||
  (route.transport==='openrouter'&&budget.searchEngine!==route.search_engine))
  throw Error('API_BUDGET_ROUTE_MISMATCH');
 const input=promptContext(prompt,context)+(route.transport==='openrouter'?' Include source citations.':'');
 if(Buffer.byteLength(input,'utf8')>budget.maxInputBytes)throw Error('API_INPUT_LIMIT');
}
