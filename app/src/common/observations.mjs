import { toHostname, sanitizeText } from './utils.mjs';
export const collectionMethodVersion = 'complete-answer-visibility-v2';
export const apiObservationVersion = 'api-occurrence-evidence-v1';
export const legacyMetricVersion = 'neutral-valid-weighted-v2-citation-coverage';
export const completeAnswerMetricVersion = 'neutral-complete-answer-weighted-v3';
// Provider metadata names the observed product, not the canonical filter enum.
// Recorded collection provenance and frozen routes take precedence over provider
// metadata; older API metadata such as "Grok API" remains
// available in meta without creating an incompatible selectable surface.
export const collectionSurface = (e={}, snapshot={}) => {
 const canonical=value=>['model_api','consumer_web'].includes(value)?value:null;
 return canonical(e.collection?.surface) ||
  canonical(snapshot.routes?.find(r=>r.provider===e.provider)?.measurement_surface) ||
  canonical(e.meta?.measurement_surface) || 'model_api';
};
export const methodFor = (snapshot={}, e={}) => collectionSurface(e,snapshot)==='consumer_web'
 ? 'consumer-original-v1' : snapshot.collectionMethod || 'citation-required-v1';
export const metricsFor = (snapshot={}, e={}) => methodFor(snapshot,e)===collectionMethodVersion ? completeAnswerMetricVersion : legacyMetricVersion;

/** Reconcile only explicitly opted-in API observations. Never upgrade legacy or consumer evidence. */
export function reconcileObservation(result, snapshot={}, {truncated=false}={}) {
 if(methodFor(snapshot,result)!==collectionMethodVersion || result.collection?.surface==='consumer_web')return result;
 const complete=result.observation?.version===apiObservationVersion && result.observation?.complete===true && !truncated;
 const eligible=['success','no_grounding'].includes(result.status);
 return {...result,status:truncated?'incomplete':eligible&&!complete?'incomplete':eligible&&String(result.answer||'').trim()?'success':result.status,
  ...(eligible&&complete&&String(result.answer||'').trim()?{error:null}:{}),
  ...(result.observation?{observation:{...result.observation,complete}}:{})};
}

/** Ordered occurrences are provider annotations, not a deduplicated URL list.
 * Missing spans remain missing; no retrieval count or search fan-out is inferred. */
export function apiObservation({complete,occurrences=[],citationObservation}={}) {
 const citationOccurrences=occurrences.flatMap(ref=>{
  try{
   const u=new URL(ref.url);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return [];
   const item={url:u.href,provenance:ref.provenance||'provider_annotation'};
   if(typeof ref.title==='string')item.title=ref.title.slice(0,1000);
   if(Number.isSafeInteger(ref.blockIndex)&&ref.blockIndex>=0)item.blockIndex=ref.blockIndex;
   if(Number.isSafeInteger(ref.start)&&Number.isSafeInteger(ref.end)&&ref.start>=0&&ref.end>=ref.start){item.start=ref.start;item.end=ref.end;}
   return [item];
  }catch{return [];}
 });
 return {version:apiObservationVersion,complete:complete===true,citationObservation:citationObservation||
  (citationOccurrences.length?'observed':'not_observed'),citationOccurrences,retrievalObservation:'unavailable',fanoutObservation:'unavailable'};
}

export function responseOccurrences(blocks=[]) {
 return blocks.flatMap((b,blockIndex)=>(b.annotations||[]).filter(a=>a.type==='url_citation').map(a=>{
  const ref=a.url_citation||a;
  return {url:ref.url,title:ref.title,start:ref.start_index,end:ref.end_index,blockIndex,provenance:'provider_inline_annotation'};
 }));
}
export const observationContextKey = (row, snapshot={}) => JSON.stringify([
 collectionSurface(row,snapshot),methodFor(snapshot,row),metricsFor(snapshot,row)]);
export function detectEvidence(answer,brand,domain,citations=[]){
 const text=String(answer||'');const name=sanitizeText(brand,120);
 // Match whole brand phrase, not a substring such as 'Air' in 'Airlines'.
 const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 const pattern=name.length>1?new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`,'iu'):null;
 const match=pattern?.exec(text), mentioned=!!match;
 // Conservative detection: a mention alone does not establish an endorsement.
 const nearby=match?text.slice(Math.max(0,match.index-100),Math.min(text.length,match.index+100)):'';
 const recommended=mentioned && (/\b(?:suosittelen|suosittelemme|suositus:|recommended:|recommend)\s*[:–-]?\s*$/iu.test(text.slice(Math.max(0,match.index-100),match.index)) || /(?:^|\n)\s*\d+[.)]\s*$/u.test(text.slice(Math.max(0,match.index-10),match.index)));
 const ownCitation=citations.some(x=>{try{const h=toHostname(x.url);return h===domain||h.endsWith('.'+domain)}catch{return false}});
 return {mentioned,recommended,ownCitation};
}
export function promptCandidates({brand,description,h1,title,domain},count=3){
 let category=sanitizeText(description||h1||title||'yrityspalveluita',120);
 category=category.replace(/https?:\/\/\S+/g,' ').split(/[.!?;:\n]/)[0];
 if(category.length>70)category=category.slice(0,70).replace(/\s+\S*$/,'');
 // Do not leak the submitted brand/domain into neutral prompt text.
 category=category.replace(new RegExp(String(brand||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),' ').replace(new RegExp(String(domain||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),' ').trim();
 if(category.length<5)category='yrityspalveluita';
 const prompts=[
  `Mitkä suomalaiset yritykset tarjoavat seuraavan tyyppisiä palveluita: ${category}?`,
  `Miten vertailla Suomessa palveluntarjoajia, jotka tarjoavat: ${category}?`,
  `Mistä Suomesta löytää luotettavan toimijan tähän tarpeeseen: ${category}?`,
  `Mitkä ovat vaihtoehdot palvelulle: ${category}, Suomessa?`,
  `Mitä yrityksiä kannattaa vertailla, kun tarvitsee palvelua: ${category}?`,
  `Missä suomalaisissa yrityksissä on osaamista seuraavasta: ${category}?`
 ];
 return prompts.slice(0,Math.max(1,Math.min(count,6)));
}
