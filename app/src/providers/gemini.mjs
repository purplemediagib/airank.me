import { requestJson,urlsUnique,promptContext } from './common.mjs';
import {apiObservation} from '../common/observations.mjs';
export async function geminiSearch(prompt,{model='gemini-2.5-flash',timeoutMs=60000}={}){
 const j=await requestJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{headers:{'x-goog-api-key':process.env.GEMINI_API_KEY},body:{contents:[{role:'user',parts:[{text:promptContext(prompt)}]}],tools:[{google_search:{}}]},timeoutMs});
 const c=j.candidates?.[0];const answer=(c?.content?.parts||[]).map(x=>x.text||'').join('\n').trim();
 const grounding=c?.groundingMetadata;const citations=urlsUnique((grounding?.groundingChunks||[]).filter(x=>x.web?.uri).map(x=>({url:x.web.uri,title:x.web.title})));
 if(!answer)throw new Error('Gemini returned no textual answer');
 const complete=c?.finishReason==='STOP'&&!j.promptFeedback?.blockReason;
 const occurrences=(grounding?.groundingSupports||[]).flatMap(s=>(s.groundingChunkIndices||[]).flatMap(index=>{
  const web=grounding?.groundingChunks?.[index]?.web;
  return web?.uri?[{url:web.uri,title:web.title,start:s.segment?.startIndex,end:s.segment?.endIndex,provenance:'provider_grounding_support'}]:[];
 }));
 const observation=apiObservation({complete,occurrences,citationObservation:grounding?'observed':'unavailable'});
 if(!grounding || !(grounding.webSearchQueries?.length||grounding.groundingChunks?.length))return {status:complete?'no_grounding':'incomplete',model,answer,citations:[],observation,meta:{usage:j.usageMetadata||null},raw:j};
 return {status:complete?'success':'incomplete',model,answer,citations,observation,meta:{usage:j.usageMetadata||null,searchQueries:grounding.webSearchQueries||[]},raw:j};
}
