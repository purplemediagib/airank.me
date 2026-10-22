// Only allowlisted metadata enters logs or user-visible evidence. Never log
// request headers, prompts, raw provider bodies, keys or arbitrary exceptions.
const text = (value, max=120) => typeof value==='string' && /^[\w./: -]+$/.test(value) && !/(?:bearer|sk-|pplx-|AIza)/i.test(value) ? value.slice(0,max) : null;
export function numericUsage(value, depth=0) {
 if(depth>4||!value||typeof value!=='object'||Array.isArray(value))return null;
 const out={};
 for(const [key,v] of Object.entries(value).slice(0,40)){
  if(!/^[a-z_][a-z_0-9]{0,59}$/.test(key))continue;
  if(typeof v==='number'&&Number.isFinite(v))out[key]=v;
  else if(v&&typeof v==='object'){const nested=numericUsage(v,depth+1);if(nested)out[key]=nested;}
 }
 return Object.keys(out).length?out:null;
}
export function safeProviderMeta(meta={}){
 const out={};
 for(const key of ['transport','requested_model','returned_model','upstream_provider','response_id','request_id','task_id','response_status','finish_reason','stop_reason','failure_code','upstream_error_code','search_engine_requested','search_engine_actual','measurement_surface','citation_scope']){
  const v=text(meta[key]);if(v!==null)out[key]=v;
 }
 for(const key of ['http_status','max_tokens_requested','tool_calls','duration_ms','continuations','cost'])if(Number.isFinite(meta[key]))out[key]=meta[key];
 if(typeof meta.overview_loaded==='boolean')out.overview_loaded=meta.overview_loaded;
 for(const key of ['context','serp_context'])if(meta[key]){
  const context={};for(const field of ['market','language','country_iso_code','language_code','location_name']){const v=text(meta[key][field]);if(v!==null)context[field]=v;}
  if(Number.isFinite(meta[key].location_code))context.location_code=meta[key].location_code;
  if(Object.keys(context).length)out[key]=context;
 }
 const usage=numericUsage(meta.usage);if(usage)out.usage=usage;
 return out;
}
export function httpFailure(status){
 return ({400:'INVALID_REQUEST',401:'AUTHENTICATION_FAILED',402:'PAYMENT_REQUIRED',403:'PERMISSION_DENIED',404:'MODEL_OR_ENDPOINT_NOT_FOUND',408:'PROVIDER_TIMEOUT',422:'INVALID_REQUEST',429:'RATE_LIMITED'})[status] || (status>=500?'PROVIDER_UNAVAILABLE':'PROVIDER_HTTP_ERROR');
}
export function attachHttpDetails(error,status,json,headers){
 error.providerMeta=safeProviderMeta({http_status:status,failure_code:httpFailure(status),upstream_error_code:String(json?.error?.code||json?.error?.type||''),request_id:headers?.get?.('request-id')||headers?.get?.('x-request-id')});
 return error;
}
export function providerFailure(error){
 const timeout=['TimeoutError','AbortError'].includes(error?.name);
 const empty=/returned no textual answer/.test(error?.message||'');
 const config=/must be an integer|API_KEY missing|Unsupported search engine/.test(error?.message||'');
 const meta=safeProviderMeta({...error?.providerMeta,failure_code:error?.providerMeta?.failure_code||(timeout?'PROVIDER_TIMEOUT':empty?'EMPTY_ANSWER':config?'INVALID_CONFIGURATION':'PROVIDER_REQUEST_FAILED')});
 return {status:timeout?'timeout_unknown':'provider_failed',answer:'',citations:[],error:meta.failure_code,meta};
}
export function resultDetails(result={}){
 const meta=safeProviderMeta(result.meta);
 if(result.status!=='success'&&!meta.failure_code)meta.failure_code=({incomplete:'INCOMPLETE_RESPONSE',failed:'INVALID_RESPONSE',no_grounding:'NO_STRUCTURED_CITATIONS',no_overview:'NO_AI_OVERVIEW',unsupported_context:'UNSUPPORTED_MARKET_OR_LANGUAGE',unconfigured:'MISSING_CREDENTIAL',budget_blocked:'BUDGET_EXHAUSTED',timeout_unknown:'PROVIDER_TIMEOUT',deadline_not_started:'RUN_DEADLINE_EXCEEDED',interrupted_unknown:'WORKER_INTERRUPTED'})[result.status]||'PROVIDER_REQUEST_FAILED';
 return {meta,error:result.status==='success'?null:meta.failure_code};
}
export function logEvent(event,fields={}){
 console.log(JSON.stringify({event,time:new Date().toISOString(),...fields}));
}
export async function observeProvider({provider,route,timeoutMs,ids={},call,logger=logEvent}){
 const started=Date.now();
 logger('provider_started',{...ids,provider,transport:route.transport,model:route.model,timeout_ms:timeoutMs});
 let result;
 try{result=await call();}catch(error){result=providerFailure(error);}
 result=result||providerFailure(null);
 const details=resultDetails(result);
 result={...result,error:details.error,meta:{...details.meta,duration_ms:Date.now()-started}};
 logger('provider_finished',{...ids,provider,model:result.model||route.model,status:result.status,citation_count:result.citations?.length||0,answer_characters:result.answer?.length||0,...result.meta});
 return result;
}
