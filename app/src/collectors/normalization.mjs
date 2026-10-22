// Preserve occurrences and vendor provenance separately from deduplicated metric URLs.
export const version='consumer-evidence-v1';
const url=value=>{try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}};
function markdownCitations(answer){
 const definitions=[...answer.matchAll(/^\[(\d+)\]:\s+(https?:\/\/\S+)/gm)];
 return definitions.flatMap(m=>{
  const occurrences=[...answer.matchAll(/\[[^\]\n]+\]\[(\d+)\]/g)].filter(r=>r[1]===m[1]);
  return occurrences.length&&url(m[2])?[{url:url(m[2]),index:Number(m[1]),occurrences:occurrences.length,kind:'citation',provenance:'answer_reference'}]:[];
 });
}
export function normalizeCollection({provider,route,raw,context,prompt,remoteId,submissionMeta={}}){
 const dfs=route.transport==='dataforseo_scraper',value=dfs?raw.tasks?.[0]?.result?.[0]:raw.task_result;
 if(!value||typeof value!=='object')throw Error('Invalid collector result');
 const answer=dfs?value.markdown:provider==='grok'?value.full_response:value.result_text;
 const originalPrompt=dfs?value.keyword:provider==='grok'?value.user_query:value.prompt;
 const failed=code=>({status:'provider_failed',answer:typeof answer==='string'?answer:'',citations:[],meta:{failure_code:code,measurement_surface:'consumer_web',task_id:remoteId}});
 if(typeof answer!=='string'||!answer.trim())return failed('EMPTY_ANSWER');
 if(answer.length>1000000)return failed('ANSWER_TOO_LARGE');
 if(originalPrompt!==prompt)return failed('PROMPT_MISMATCH');
 if(value.error_message||value.finish_reason==='length'||value.finish_reason==='max_tokens')return failed('INCOMPLETE_RESPONSE');
 if(dfs&&(value.language_code!==context.language||value.location_code!==submissionMeta.location_code))return failed('COLLECTION_CONTEXT_MISMATCH');
 const references=markdownCitations(answer);
 const add=(items,kind,provenance)=>{for(const s of Array.isArray(items)?items:[]){const u=url(s?.url);if(!u)continue;references.push({url:u,title:String(s.title??s.name??'').slice(0,1000),kind,provenance,...(Number.isSafeInteger(s.index)?{index:s.index}:{}),...(Number.isSafeInteger(s.cited_count)?{occurrences:s.cited_count}:{}),...(typeof s.markdown==='string'?{passage:s.markdown}:{}),...(typeof s.snippet==='string'?{snippet:s.snippet}:{} )});}};
 if(dfs){
  add(value.sources,'source_reference','result.sources');
  // Item-level sources are separate passage associations, not extra metric votes.
  const walk=(items,path='',depth=0)=>{if(depth>8)return;for(const [i,item]of (Array.isArray(items)?items:[]).entries()){add(item.sources,'source_reference',`${path}items[${i}].sources`);walk(item.items,`${path}items[${i}].`,depth+1);}};
  walk(value.items);
  add(value.search_results,'retrieval','result.search_results');
 }else if(provider==='grok'){
  add(Object.values(value.footnotes||{}),'source_reference','footnotes');
  add(value.web_search_results,'retrieval','web_search_results');
  add(value.x_search_results,'retrieval','x_search_results');
 }else{
  add(value.web_results,'source_reference','web_results');
 }
 // Only answer-backed references enter explicit-citation metrics; ordinary vendor links do not.
 const citations=references.filter(s=>s.kind==='citation').map(s=>({url:s.url,...(s.title?{title:s.title}:{})}));
 const collection={
  version,supplier:dfs?'dataforseo':'scrapeless',surface:'consumer_web',requestedMarket:context.market,requestedLanguage:context.language,
  locationVerification:dfs?'vendor_reported':'unverified',reportedLocationCode:dfs?value.location_code:null,reportedLanguage:dfs?value.language_code:null,
  modelVersionVerified:false,sourceReferences:references,
  citationObservation:citations.length?'observed':dfs?'unavailable':'not_observed',
  retrievalObservation:references.some(r=>r.kind==='retrieval')?'observed':
   (dfs?Array.isArray(value.search_results):provider==='grok'&&(Array.isArray(value.web_search_results)||Array.isArray(value.x_search_results)))?'not_observed':'unavailable',
  searchQueries:dfs&&Array.isArray(value.fan_out_queries)?value.fan_out_queries:null,
  searchQueryRecords:dfs&&Array.isArray(value.fan_out_queries)&&value.fan_out_queries.every(q=>typeof q==='string'&&q.trim()||typeof q?.query==='string'&&q.query.trim())
   ?value.fan_out_queries.map(q=>({query:typeof q==='string'?q:q.query,provenance:'result.fan_out_queries'})):null,
  brandEntities:dfs&&Array.isArray(value.brand_entities)?value.brand_entities:null,
  // Follow-up suggestions are not search fanouts.
 };
 return {status:'success',answer,citations,collection,model:dfs?value.model||null:provider==='grok'?value.user_model||null:null,
  meta:{transport:route.transport,measurement_surface:'consumer_web',task_id:remoteId,citation_scope:'answer_references',...(Number.isFinite(submissionMeta.cost)?{cost:submissionMeta.cost}:{})}};
}
// Known result fields only: exclude supplier headers, raw session traffic and share links.
export function evidencePayload(route,raw){
 if(route.transport==='dataforseo_scraper')return {status_code:raw.status_code,tasks:(raw.tasks||[]).map(t=>({id:t.id,status_code:t.status_code,result:t.result}))};
 const v=raw.task_result||{},keys=['full_response','result_text','prompt','user_query','user_model','create_time','conversation','response_id','error_feature','error_message','footnotes','web_search_results','x_search_results','tool_usages','related_prompt','follow_up_suggestions','web_results','media_items'];
 return {status:raw.status,message:raw.status==='failed'?'Provider execution failed':undefined,task_result:Object.fromEntries(keys.filter(k=>Object.hasOwn(v,k)).map(k=>[k,v[k]]))};
}
