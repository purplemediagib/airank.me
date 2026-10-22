import {measurementContext} from '../common/measurement-context.mjs';
import {httpFailure} from '../providers/diagnostics.mjs';
const engines={openai:'chat_gpt',gemini:'gemini'};
const validId=id=>typeof id==='string'&&/^[\w-]{1,200}$/.test(id);
export function createCollectorClient({env=process.env,transport=fetch}={}){
 const catalogs=new Map();
 async function request(url,body,route){
  const dfs=route.transport==='dataforseo_scraper';
  const headers=dfs?{authorization:'Basic '+Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`).toString('base64')}:{'x-api-token':env.SCRAPELESS_API_TOKEN};
  const response=await transport(url,{method:body?'POST':'GET',headers:{...headers,accept:'application/json',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
  // Bound raw evidence before JSON parsing without logging supplier bodies.
  let size=0,text='';const decoder=new TextDecoder();
  if(response.body){for await(const chunk of response.body){size+=chunk.byteLength;if(size>8000000)throw Error('Collector response too large');text+=decoder.decode(chunk,{stream:true});}text+=decoder.decode();}
  let json;try{json=JSON.parse(text);}catch{throw Error('Invalid collector response');}
  return {http:response.status,ok:response.ok,json};
 }
 return {
  async submit({provider,route,prompt,context:input,taskId}){
   const context=measurementContext(input);
   if(env.CONSUMER_COLLECTION_ENABLED!=='true')return {result:{status:'unconfigured',meta:{failure_code:'CONSUMER_COLLECTION_DISABLED'}}};
   if(route.transport==='dataforseo_scraper'){
    const engine=engines[provider];if(!engine)throw Error('Unsupported consumer platform');
    const root=`https://api.dataforseo.com/v3/ai_optimization/${engine}/llm_scraper`;
    const catalogKey=`${engine}:${context.market}`;
    if(catalogs.get(catalogKey)?.expires<Date.now())catalogs.delete(catalogKey);
    if(!catalogs.has(catalogKey)){
     let lists;
     try{lists=await Promise.all(['locations','languages'].map(async path=>{
      const r=await request(`${root}/${path}${path==='locations'?`/${context.market}`:''}`,undefined,route);
      if(!r.ok||r.json.status_code!==20000||r.json.tasks?.[0]?.status_code!==20000||!Array.isArray(r.json.tasks[0].result))throw Error('Locale catalog unavailable');
      return r.json.tasks[0].result;
     }));}catch{return {result:{status:'provider_failed',meta:{failure_code:'COLLECTOR_LOCALE_CATALOG_UNAVAILABLE',submission_attempted:false}}};}
     catalogs.set(catalogKey,{expires:Date.now()+3600000,locations:lists[0],languages:lists[1]});
    }
    const catalog=catalogs.get(catalogKey);
    const location=catalog.locations.find(x=>x.country_iso_code===context.market&&x.location_type==='Country');
    if(!location||!catalog.languages.some(x=>x.language_code===context.language))return {result:{status:'unsupported_context',meta:{failure_code:'UNSUPPORTED_MARKET_OR_LANGUAGE'}}};
    const body=[{keyword:encodeURIComponent(prompt),location_code:location.location_code,language_code:context.language,priority:1,tag:`airank-${taskId}`,...(provider==='openai'?{force_web_search:false}:{})}];
    let r;try{r=await request(`${root}/task_post`,body,route);}catch{ return {result:{status:'interrupted_unknown',meta:{failure_code:'SUBMISSION_UNKNOWN'}}};}
    const t=r.json.tasks?.[0];
    if(r.ok&&r.json.status_code===20000&&[20000,20100].includes(t?.status_code)&&validId(t.id))return {remoteId:t.id,meta:{location_code:location.location_code,language_code:context.language,...(Number.isFinite(t.cost)?{cost:t.cost}:{})}};
    const rejected=r.http>=400&&r.http<500||r.ok&&(t?.status_code>=40000||r.json.status_code>=40000);
    return {result:{status:rejected?'provider_failed':'interrupted_unknown',meta:{failure_code:rejected?(r.ok?'COLLECTOR_TASK_REJECTED':httpFailure(r.http)):'SUBMISSION_UNKNOWN',http_status:r.http}}};
   }
   const inputBody={prompt,country:context.market,should_fetch_share_link:false,...(provider==='grok'?{mode:'MODEL_MODE_AUTO'}:{})};
   let r;try{r=await request('https://api.scrapeless.com/api/v2/scraper/request',{actor:`scraper.${provider}`,input:inputBody},route);}catch{return {result:{status:'interrupted_unknown',meta:{failure_code:'SUBMISSION_UNKNOWN'}}};}
   if(r.ok&&validId(r.json.task_id))return {remoteId:r.json.task_id,meta:{}};
   return {result:{status:r.http>=500||r.ok?'interrupted_unknown':'provider_failed',meta:{failure_code:r.http>=500||r.ok?'SUBMISSION_UNKNOWN':httpFailure(r.http),http_status:r.http}}};
  },
  async poll({provider,route,remoteId}){
   if(!validId(remoteId))throw Error('Invalid stored collector identifier');
   const dfs=route.transport==='dataforseo_scraper',engine=engines[provider];
   const endpoint=dfs?`https://api.dataforseo.com/v3/ai_optimization/${engine}/llm_scraper/task_get/advanced/${encodeURIComponent(remoteId)}`:`https://api.scrapeless.com/api/v2/scraper/result/${encodeURIComponent(remoteId)}`;
   const r=await request(endpoint,undefined,route),j=r.json;
   if(r.http===429||r.http>=500&&j.status!=='failed')return {status:'pending'};
   if(dfs){
    const t=j.tasks?.[0];
    if(r.ok&&j.status_code===20000&&[20100,40601,40602].includes(t?.status_code))return {status:'pending'};
    if(r.ok&&j.status_code===20000&&t?.status_code===20000&&t.id===remoteId&&Array.isArray(t.result)&&t.result.length===1)return {status:'ready',raw:j};
   }else{
    if(j.status==='failed')return {status:'failed',raw:j,code:'COLLECTOR_EXECUTION_FAILED'};
    if(r.http===202||['pending','running'].includes(j.status))return {status:'pending'};
    if(r.ok&&j.status==='success'&&j.task_result)return {status:'ready',raw:j};
   }
   return {status:'failed',raw:j,code:r.http===410?'COLLECTOR_RESULT_EXPIRED':r.ok?'COLLECTOR_INVALID_RESULT':httpFailure(r.http)};
  },
 };
}
