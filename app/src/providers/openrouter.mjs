import {urlsUnique,promptContext} from './common.mjs';
import {apiObservation,responseOccurrences} from '../common/observations.mjs';
import {attachHttpDetails,httpFailure,safeProviderMeta} from './diagnostics.mjs';
export async function openrouterSearch(prompt,{model,searchEngine='native',timeoutMs=60000,apiKey=process.env.OPENROUTER_API_KEY,fetchImpl=fetch,context={},maxTokens=process.env.OPENROUTER_MAX_TOKENS,budget}={}){
 if(!apiKey)throw Error('OPENROUTER_API_KEY missing');
 if(!model||/^(openai|anthropic|openrouter)\//.test(model))throw Error('OpenAI and Claude must use direct APIs');
 if(!['native','exa'].includes(searchEngine))throw Error('Unsupported search engine');
 // Gemini reasoning can consume the same allowance as its visible answer.
 // Keep requests bounded and never silently retry a truncated paid call.
 const outputLimit=Number(maxTokens??(model.startsWith('google/gemini-')?8192:2000));
 if(!Number.isSafeInteger(outputLimit)||outputLimit<256||outputLimit>16384)throw Error('OPENROUTER_MAX_TOKENS must be an integer from 256 to 16384');
 if(budget&&outputLimit!==budget.maxTokens)throw Error('API_BUDGET_LIMIT_MISMATCH');
 const res=await fetchImpl('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},signal:AbortSignal.timeout(timeoutMs),body:JSON.stringify({model,messages:[{role:'user',content:promptContext(prompt,context)+' Include source citations.'}],tools:[{type:'openrouter:web_search',parameters:{engine:searchEngine,max_uses:3,max_results:5,max_total_results:15}}],max_tool_calls:3,max_tokens:outputLimit,stream:false,provider:{allow_fallbacks:false,require_parameters:true}})});
 let j;try{j=await res.json();}catch{throw attachHttpDetails(Error('OpenRouter returned non-JSON HTTP '+res.status),res.status,null,res.headers);}
 const c=j.choices?.[0],message=c?.message;
 const answer=typeof message?.content==='string'?message.content.trim():Array.isArray(message?.content)?message.content.filter(x=>x.type==='text').map(x=>x.text||'').join('\n').trim():'';
 const annotations=[...(message?.annotations||[]),...(Array.isArray(message?.content)?message.content.flatMap(x=>x.annotations||[]):[])];
 const citations=urlsUnique(annotations.filter(x=>x.type==='url_citation').map(x=>x.url_citation||x));
 const meta={transport:'openrouter',requested_model:model,returned_model:j.model||null,upstream_provider:j.provider||null,response_id:j.id||null,search_engine_requested:searchEngine,search_engine_actual:null,usage:j.usage||null,http_status:res.status,finish_reason:c?.finish_reason||null,max_tokens_requested:outputLimit};
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
