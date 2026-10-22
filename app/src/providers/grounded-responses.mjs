import {requestJson,urlsUnique,promptContext} from './common.mjs';
import {apiObservation,responseOccurrences} from '../common/observations.mjs';

// Only structured, provider-returned evidence is accepted, never URLs inferred
// from the answer. These are API observations, not consumer-chat rankings.
export function normalizeGroundedResponse(j,{model,surface,searchResults=false}){
 const messages=(j.output||[]).filter(x=>x.type==='message');
 const blocks=messages.flatMap(x=>x.content||[]);
 const answer=blocks.filter(x=>x.type==='output_text').map(x=>x.text||'').join('\n').trim();
 const sources=[];
 for(const b of blocks)for(const a of b.annotations||[]){
  if(a.type==='url_citation'&&a.url)sources.push({url:a.url,title:a.title});
 }
 if(searchResults)for(const item of j.output||[]){
  if(item.type==='search_results')sources.push(...(item.results||[]));
 }
 const citations=urlsUnique(sources);
 const complete=j.status==='completed'&&!j.error&&!j.incomplete_details&&
  !(j.output||[]).some(x=>x.type==='web_search_call'&&x.status&&x.status!=='completed')&&
  messages.every(x=>!x.status||x.status==='completed')&&!blocks.some(x=>x.type==='refusal');
 return {
  status:!complete?'incomplete':!answer?'failed':citations.length?'success':'no_grounding',
  model:j.model||model,answer,citations,
  observation:apiObservation({complete:complete&&!!answer,occurrences:responseOccurrences(blocks)}),
  error:!complete?'Provider response did not complete':!answer?'Provider returned no textual answer':null,
  meta:{response_id:j.id,response_status:j.status,usage:j.usage||null,measurement_surface:surface,
   citation_scope:searchResults?'provider search results and inline citations':'inline citations'},
  raw:j
 };
}

export async function grokSearch(prompt,{model='grok-4.7',timeoutMs=60000,context={},budget}={}){
 const j=await requestJson('https://api.x.ai/v1/responses',{
  headers:{authorization:'Bearer '+process.env.XAI_API_KEY},timeoutMs,redactErrors:true,
  body:{model,input:promptContext(prompt,context),tools:[{type:'web_search'}],
   tool_choice:'required',max_output_tokens:budget?.maxTokens??8192,stream:false,...(budget?{max_tool_calls:budget.maxSearches}:{})}
 });
 return normalizeGroundedResponse(j,{model,surface:'xAI Grok web-search API'});
}

export async function perplexitySearch(prompt,{timeoutMs=60000,context={}}={}){
 const j=await requestJson('https://api.perplexity.ai/v1/agent',{
  headers:{authorization:'Bearer '+process.env.PERPLEXITY_API_KEY},timeoutMs,redactErrors:true,
  body:{preset:'fast',input:promptContext(prompt,context),tools:[{type:'web_search'}],
   max_output_tokens:8192,stream:false}
 });
 return normalizeGroundedResponse(j,{model:'perplexity-agent/fast',
  surface:'Perplexity Agent API / fast preset',searchResults:true});
}
