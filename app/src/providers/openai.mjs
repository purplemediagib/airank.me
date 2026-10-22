import { requestJson,urlsUnique,promptContext } from './common.mjs';
import {apiObservation,responseOccurrences} from '../common/observations.mjs';
export async function openaiSearch(prompt,{model='gpt-4.1-mini',timeoutMs=60000,context={},budget}={}){
 const j=await requestJson('https://api.openai.com/v1/responses',{headers:{authorization:'Bearer '+process.env.OPENAI_API_KEY},timeoutMs,body:{model,input:promptContext(prompt,context),tools:[{type:'web_search'}],tool_choice:'required',max_output_tokens:budget?.maxTokens??1250,...(budget?{max_tool_calls:budget.maxSearches}:{})}});
 const blocks=(j.output||[]).filter(x=>x.type==='message').flatMap(x=>x.content||[]);
 const answer=blocks.filter(x=>x.type==='output_text').map(x=>x.text||'').join('\n').trim();
 const sources=[];
 for(const b of blocks)for(const a of b.annotations||[]){if(a.type==='url_citation'&&a.url)sources.push({url:a.url,title:a.title});}
 const searchCalls=(j.output||[]).filter(x=>x.type==='web_search_call');
 if(!answer)throw new Error('OpenAI returned no textual answer');
 const citations=urlsUnique(sources);
 const complete=j.status==='completed'&&!j.error&&!j.incomplete_details&&
  (j.output||[]).filter(x=>['message','web_search_call'].includes(x.type)).every(x=>!x.status||x.status==='completed')&&!blocks.some(x=>x.type==='refusal');
 return {status:!complete?'incomplete':citations.length?'success':'no_grounding',model:j.model||model,answer,citations,
  observation:apiObservation({complete,occurrences:responseOccurrences(blocks)}),
  meta:{response_id:j.id,response_status:j.status,tool_calls:searchCalls.length,usage:j.usage||null},raw:j};
}
