import { requestJson,urlsUnique,promptContext } from './common.mjs';
import {providerFailure} from './diagnostics.mjs';
import {apiObservation} from '../common/observations.mjs';
export function claudeOutputBudget(env=process.env){
 const value=Number(env.CLAUDE_MAX_TOKENS??env.CLAUDE_MAX_OUTPUT_TOKENS??1400);
 if(!Number.isSafeInteger(value)||value<256||value>16384)throw new Error('CLAUDE_MAX_TOKENS (or legacy CLAUDE_MAX_OUTPUT_TOKENS) must be an integer from 256 to 16384');
 return value;
}
export async function claudeSearch(prompt,{model='claude-sonnet-4-5',timeoutMs=60000,context={},maxTokens=process.env.CLAUDE_MAX_TOKENS??process.env.CLAUDE_MAX_OUTPUT_TOKENS,budget}={}){
 const outputLimit=claudeOutputBudget({CLAUDE_MAX_TOKENS:maxTokens});
 if(outputLimit>1400&&budget?.mode!=='monetary_reserved')throw Error('API_BUDGET_RESERVATION_REQUIRED');
 if(budget&&outputLimit!==budget.maxTokens)throw Error('API_BUDGET_LIMIT_MISMATCH');
 const input=promptContext(prompt,context);
 if(budget?.mode==='monetary_reserved'&&Buffer.byteLength(input,'utf8')>budget.maxInputBytes)throw Error('API_INPUT_LIMIT');
 const deadline=Date.now()+timeoutMs;
 const params={model,max_tokens:outputLimit,messages:[{role:'user',content:input}],tools:[{type:'web_search_20250305',name:'web_search',max_uses:budget?.maxSearches??3}]};
 let j=await requestJson('https://api.anthropic.com/v1/messages',{headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},body:params,timeoutMs});
 const responses=[j];
 let continuationFailure=null;
 // Anthropic's server web-search may return pause_turn. Preserve the assistant blocks when continuing.
 const usedTokens=j.usage?.output_tokens;
 const remainingTokens=Number.isSafeInteger(usedTokens)&&usedTokens>=0?outputLimit-usedTokens:0;
 if(j.stop_reason==='pause_turn'&&remainingTokens>0){
  const remaining=deadline-Date.now();
  params.messages=[...params.messages,{role:'assistant',content:j.content||[]}];
  params.max_tokens=remainingTokens;
  if(budget?.mode==='monetary_reserved'&&Buffer.byteLength(JSON.stringify(params.messages),'utf8')>budget.maxReplayBytes){
   continuationFailure='CONTINUATION_INPUT_LIMIT';
  }else try{
   if(remaining<=0)throw new DOMException('Provider deadline reached','TimeoutError');
   j=await requestJson('https://api.anthropic.com/v1/messages',{headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},body:params,timeoutMs:remaining});responses.push(j);
  }catch(error){continuationFailure=providerFailure(error).meta.failure_code;}
 }
 const blocks=responses.flatMap(r=>r.content||[]).filter(x=>x.type==='text');
 const answer=blocks.map(x=>x.text||'').join('\n').trim();
 const refs=[];
 for(const block of blocks)for(const a of block.citations||[]){if(a.url)refs.push({url:a.url,title:a.title||''});}
 const citations=urlsUnique(refs);
 const toolFailed=responses.some(r=>(r.content||[]).some(b=>b.type==='web_search_tool_result'&&b.content?.type==='web_search_tool_result_error'));
 const complete=!!answer&&j.stop_reason==='end_turn'&&!toolFailed&&!continuationFailure;
 const occurrences=blocks.flatMap((block,blockIndex)=>(block.citations||[]).filter(a=>a.url)
  .map(a=>({url:a.url,title:a.title,blockIndex,provenance:'provider_inline_annotation'})));
 const usage={responses:Object.fromEntries(responses.map((r,i)=>['response_'+i,r.usage||{}]))};
 return {status:!complete?'incomplete':citations.length?'success':'no_grounding',model:j.model||model,answer,citations,observation:apiObservation({complete,occurrences}),meta:{response_id:j.id,usage:responses.length>1?usage:j.usage||null,stop_reason:j.stop_reason,max_tokens_requested:outputLimit,continuations:responses.length-1,...(!complete?{failure_code:continuationFailure||(j.stop_reason==='max_tokens'?'OUTPUT_TOKEN_LIMIT':toolFailed?'WEB_SEARCH_FAILED':j.stop_reason==='pause_turn'?'CONTINUATION_LIMIT':!answer?'EMPTY_ANSWER':'INCOMPLETE_RESPONSE')}:{})},raw:responses.length>1?{responses}:j};
}
