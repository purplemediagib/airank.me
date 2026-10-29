import { requestJson,requestMeta,urlsUnique } from './common.mjs';
import {apiObservation} from '../common/observations.mjs';
import {localeCatalog,selectSerpContext} from './dataforseo-context.mjs';
export const googleAioMaxRequests=2;
const retryDelayMs=4000;
// Explicit supplier failures only: never replay ambiguous transport timeouts,
// authentication/payment/supplier rate limits, invalid input or 50100. Explicit
// HTTP 429 rejection retries are handled separately by requestJson.
const transient=code=>[40101,50000,50001,50301,50302,50303,50401,50402].includes(code);
function extractText(items){
 const buf=[];const visit=(x,depth=0)=>{
  if(!x||depth>8)return;
  if(Array.isArray(x)){x.forEach(y=>visit(y,depth+1));return;}
  if(typeof x!=='object')return;
  if(typeof x.text==='string')buf.push(x.text);
  if(typeof x.markdown==='string')buf.push(x.markdown);
  if(typeof x.snippet==='string')buf.push(x.snippet);
  for(const [k,v] of Object.entries(x))if(k==='items'||k==='content'||k==='elements'||k==='text_blocks')visit(v,depth+1);
 };visit(items);return [...new Set(buf)].join('\n');
}
function sourceUrls(ai){const out=[];const visit=(x,depth=0)=>{if(!x||depth>7)return;if(Array.isArray(x)){x.forEach(y=>visit(y,depth+1));return;}if(typeof x!=='object')return;
 if(x.url&&/^(https?:\/\/)/.test(x.url))out.push({url:x.url,title:x.title});if(x.link&&/^(https?:\/\/)/.test(x.link))out.push({url:x.link,title:x.title});
 for(const k of ['references','items','sources','links','elements','content','text_blocks'])visit(x[k],depth+1);
 };visit(ai);return urlsUnique(out)}
export async function googleAioSearch(prompt,{timeoutMs=60000,context={},catalog,budget,now=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 if(prompt.length>700)return {status:'failed',model:'Google AI Overviews / desktop SERP',answer:'',citations:[],error:'SERP question exceeds 700 characters'};
 const maxRequests=budget?.maxRequests??googleAioMaxRequests;
 if(!Number.isSafeInteger(maxRequests)||maxRequests<1||maxRequests>googleAioMaxRequests)throw Error('API_BUDGET_LIMIT_MISMATCH');
 const deadline=now()+timeoutMs;
 const token=Buffer.from(process.env.DATAFORSEO_LOGIN+':'+process.env.DATAFORSEO_PASSWORD).toString('base64');
 const headers={authorization:'Basic '+token},locale=selectSerpContext(context,catalog||await localeCatalog(headers,timeoutMs));
 const model='Google AI Overviews / desktop SERP';
 if(!locale)return {status:'unsupported_context',model,answer:'',citations:[],error:'DataForSEO does not support this requested market/language',meta:{context}};
 const body=[{keyword:prompt,location_code:locale.location_code,language_code:locale.language_code,device:'desktop',depth:10,load_async_ai_overview:true}];
 let attempts=0,httpAttempts=0,rateLimitRetries=0,cost=null,initialCode=null;
 const attemptMeta=()=>({request_attempts:httpAttempts,rate_limit_retries:rateLimitRetries,cost,...(initialCode!==null?{initial_upstream_error_code:String(initialCode)}:{})});
 const call=async()=>{
  const remaining=Math.floor(deadline-now());
  if(remaining<=0)throw new DOMException('Provider deadline reached','TimeoutError');
  attempts++;
  try{
   const result=await requestJson('https://api.dataforseo.com/v3/serp/google/organic/live/advanced',{headers,timeoutMs:remaining,redactErrors:true,body});
   httpAttempts+=requestMeta(result).request_attempts||1;rateLimitRetries+=requestMeta(result).rate_limit_retries||0;
   const charged=result.tasks?.[0]?.cost??result.cost;
   if(typeof charged==='number'&&Number.isFinite(charged)&&charged>=0)cost=(cost??0)+charged;
   return result;
  }catch(error){httpAttempts+=error.providerMeta?.request_attempts||1;rateLimitRetries+=error.providerMeta?.rate_limit_retries||0;error.providerMeta={...error.providerMeta,...attemptMeta()};throw error;}
 };
 let j=await call();
 const code=Number(j.tasks?.[0]?.status_code??j.status_code);
 if(transient(code)&&attempts<maxRequests&&deadline-now()>retryDelayMs){
  initialCode=code;
  await sleep(retryDelayMs);
  // Recheck after sleeping: an expired worker lease must not launch another paid call.
  if(deadline-now()>0)j=await call();
 }
 const task=j.tasks?.[0];
 // Preserve numeric machine-readable diagnostics, never arbitrary supplier messages.
 const upstreamCode=Number(task?.status_code??j.status_code);
 const failure=(code)=>({status:'failed',model,answer:'',citations:[],meta:{...attemptMeta(),failure_code:code,upstream_error_code:String(Number.isSafeInteger(upstreamCode)&&upstreamCode>=0?upstreamCode:0),measurement_surface:'Google desktop SERP / DataForSEO',serp_context:locale}});
 if(task?.status_code!==20000)return failure(transient(upstreamCode)?'SERP_TEMPORARILY_UNAVAILABLE':'SERP_TASK_FAILED');
 if(!Array.isArray(task.result?.[0]?.items))return failure('SERP_RESULT_MISSING');
 const items=task.result[0].items;const ai=items.find(x=>x.type==='ai_overview');
 const meta={task_id:task.id,...attemptMeta(),serp_context:locale,measurement_surface:'Google desktop SERP / DataForSEO'};
 if(!ai)return {status:'no_overview',model,answer:'',citations:[],meta,raw:j};
 const answer=extractText(ai);
 if(!answer)return {...failure('AI_OVERVIEW_TEXT_MISSING'),meta:{...meta,...failure('AI_OVERVIEW_TEXT_MISSING').meta}};
 const citations=sourceUrls(ai);
 // Supplier references are not inline occurrence annotations. Do not fabricate
 // span associations or interpret references as retrieval/search fan-out.
 const complete=ai.is_truncated!==true&&answer.length<=100000;
 return {status:!complete?'incomplete':citations.length?'success':'no_grounding',model,answer,citations,
  observation:apiObservation({complete,citationObservation:citations.length?'observed':'not_observed'}),
  meta:{...meta,overview_loaded:ai.asynchronous_ai_overview},raw:j};
}
