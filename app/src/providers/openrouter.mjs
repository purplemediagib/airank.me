import {urlsUnique} from './common.mjs';
import {apiObservation,responseOccurrences,mistralCollectionMethodVersion,deepseekCollectionMethodVersion} from '../common/observations.mjs';
import {isMistral,openrouterPrompt,openrouterSearchLimits} from './openrouter-policy.mjs';
import {attachHttpDetails,httpFailure,safeProviderMeta} from './diagnostics.mjs';
import {openrouterDefaultOutputTokens} from './output-limits.mjs';
import {fetchRateLimited} from './rate-limit.mjs';
export async function openrouterSearch(prompt,{model,searchEngine='native',timeoutMs=60000,apiKey=process.env.OPENROUTER_API_KEY,fetchImpl=fetch,context={},maxTokens=process.env.OPENROUTER_MAX_TOKENS,budget,retryOptions={}}={}){
 if(!apiKey)throw Error('OPENROUTER_API_KEY missing');
 if(!model||/^(openai|anthropic|openrouter)\//.test(model))throw Error('OpenAI and Claude must use direct APIs');
 if(!['native','exa'].includes(searchEngine))throw Error('Unsupported search engine');
 // Reasoning can consume the same allowance as the visible answer.
 // Keep requests bounded and never silently retry a truncated paid call.
 const outputLimit=Number(maxTokens??openrouterDefaultOutputTokens(model));
 if(!Number.isSafeInteger(outputLimit)||outputLimit<256||outputLimit>16384)throw Error('OPENROUTER_MAX_TOKENS must be an integer from 256 to 16384');
 if(budget&&outputLimit!==budget.maxTokens)throw Error('API_BUDGET_LIMIT_MISMATCH');
 const deepseek=/^deepseek\//.test(model);
 const provider={allow_fallbacks:deepseek,require_parameters:true,...(deepseek?{sort:'throughput'}:{})};
 // Model prices vary by endpoint; refuse routing above the reserved token rates.
 if(budget?.mode==='monetary_reserved'){
  const rates=[budget.inputUsdPerMillion,budget.outputUsdPerMillion];
  if(rates.some(r=>typeof r!=='number'||!Number.isFinite(r)||r<0))throw Error('API_BUDGET_INVALID_CONFIG');
  provider.max_price={prompt:rates[0],completion:rates[1]};
 }
 const searchLimits=openrouterSearchLimits(model);
 if(budget?.maxSearches!==undefined&&searchLimits.max_uses>budget.maxSearches)throw Error('API_BUDGET_LIMIT_MISMATCH');
 const {response:res,meta:httpMeta}=await fetchRateLimited('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:openrouterPrompt(prompt,context,model)}],tools:[{type:'openrouter:web_search',parameters:{engine:searchEngine,...searchLimits}}],max_tool_calls:searchLimits.max_uses,max_tokens:outputLimit,stream:false,provider})},{...retryOptions,timeoutMs,fetchImpl});
 let j;try{j=await res.json();}catch(error){
  if(!['TimeoutError','AbortError'].includes(error?.name))error=attachHttpDetails(Error('OpenRouter returned non-JSON HTTP '+res.status),res.status,null,res.headers);
  error.providerMeta={...error.providerMeta,...httpMeta};throw error;
 }
 const c=j.choices?.[0],message=c?.message;
 const answer=typeof message?.content==='string'?message.content.trim():Array.isArray(message?.content)?message.content.filter(x=>x.type==='text').map(x=>x.text||'').join('\n').trim():'';
 const annotations=[...(message?.annotations||[]),...(Array.isArray(message?.content)?message.content.flatMap(x=>x.annotations||[]):[])];
 const citations=urlsUnique(annotations.filter(x=>x.type==='url_citation').map(x=>x.url_citation||x));
 const meta={...httpMeta,transport:'openrouter',requested_model:model,returned_model:j.model||null,upstream_provider:j.provider||null,response_id:j.id||null,search_engine_requested:searchEngine,search_engine_actual:null,usage:j.usage||null,http_status:res.status,finish_reason:c?.finish_reason||null,max_tokens_requested:outputLimit};
 if(isMistral(model))meta.collection_method=mistralCollectionMethodVersion;
 if(deepseek)meta.collection_method=deepseekCollectionMethodVersion;
 let status='success',error=null;
 // Do not echo arbitrary provider errors into logs (may contain sensitive request details).
 if(!res.ok||j.error){status='failed';const code=safeProviderMeta({upstream_error_code:String(j.error?.code||'unknown')}).upstream_error_code||'unknown';error='OpenRouter request failed: HTTP '+res.status+' code '+code;meta.failure_code=httpFailure(Number(j.error?.code)||res.status);meta.upstream_error_code=code;}
 else if(c?.finish_reason==='length'){status='failed';error=`OpenRouter response reached the output token limit (${outputLimit}); excluded from visibility metrics`;meta.failure_code='OUTPUT_TOKEN_LIMIT';}
 else if(!answer||c?.finish_reason!=='stop'||message?.refusal||message?.tool_calls?.length){status='failed';error='OpenRouter returned an empty, truncated or unfinished answer';meta.failure_code=message?.refusal?'REFUSED':message?.tool_calls?.length?'UNFINISHED_TOOL_CALLS':!answer?'EMPTY_ANSWER':'INCOMPLETE_RESPONSE';}
 else if(!citations.length){status='no_grounding';error='No structured source citations returned; excluded from visibility metrics';}
 const occurrences=[
  ...responseOccurrences([{annotations:message?.annotations||[]}]).map(({blockIndex,...ref})=>ref),
  ...responseOccurrences(Array.isArray(message?.content)?message.content:[]),
 ];
 return {status,error,model:j.model||model,answer,citations,
  observation:apiObservation({complete:['success','no_grounding'].includes(status),occurrences}),meta,raw:j};
}
