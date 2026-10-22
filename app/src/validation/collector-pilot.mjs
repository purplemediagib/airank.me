// Explicit one-off, isolated supplier validation. Never connects to the app DB.
import {mkdir,writeFile,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createCollectorClient} from '../collectors/client.mjs';
import {normalizeCollection,evidencePayload} from '../collectors/normalization.mjs';
if(!process.argv.includes('--approve-usd=5'))throw Error('Explicit --approve-usd=5 approval required');
const out=resolve(process.argv.find(x=>x.startsWith('--out='))?.slice(6)||'generated-artifacts/collector-pilot-0.17.0');
await mkdir(out,{recursive:true});
const ledger={approvedUSD:5,reservedUSD:0,startedAt:new Date().toISOString(),prompt:'Mitkä markkinointiohjelmistot sopivat pienelle suomalaiselle yritykselle, joka tarvitsee sähköpostimarkkinointia ja sosiaalisen median hallintaa? Vertaile nimettyjä vaihtoehtoja ja mainitse lähteet.',market:'FI',language:'fi',tasks:[]};
// Exclusive creation prevents an accidental second paid run in the same folder.
await writeFile(`${out}/ledger.json`,JSON.stringify(ledger,null,2),{flag:'wx',mode:0o600});
let saving=Promise.resolve();
const persist=()=>{
 const json=JSON.stringify(ledger,null,2);
 saving=saving.then(async()=>{await writeFile(`${out}/ledger.next`,json,{mode:0o600});await rename(`${out}/ledger.next`,`${out}/ledger.json`);});
 return saving;
};
const transport=async(url,init)=>{
 // Published priority queue price: $0.0024/result. No second task submission.
 if(String(url).endsWith('/task_post')){const body=JSON.parse(init.body);body[0].priority=2;init={...init,body:JSON.stringify(body)};}
 return fetch(url,init);
};
const client=createCollectorClient({env:{...process.env,CONSUMER_COLLECTION_ENABLED:'true'},transport});
const only=process.argv.find(x=>x.startsWith('--only='))?.slice(7);
if(only&&!['openai','gemini','grok','perplexity'].includes(only))throw Error('Unsupported pilot provider');
for(const provider of (only?[only]:['openai','gemini','grok','perplexity'])){
 const dfs=['openai','gemini'].includes(provider);
 const credential=dfs?process.env.DATAFORSEO_LOGIN&&process.env.DATAFORSEO_PASSWORD:process.env.SCRAPELESS_API_TOKEN;
 if(!credential){ledger.tasks.push({provider,status:'blocked_missing_credential'});continue;}
 // Conservative reservation per fixed, standard actor request, not actual cost.
 if(ledger.reservedUSD+.5>ledger.approvedUSD)throw Error('PILOT_BUDGET_EXHAUSTED');
 ledger.reservedUSD+=.5;
 ledger.tasks.push({provider,route:{transport:dfs?'dataforseo_scraper':'scrapeless',measurement_surface:'consumer_web'},reservedUSD:.5,status:'reserved'});
}
await persist();
await Promise.all(ledger.tasks.filter(t=>t.status==='reserved').map(async task=>{
 try{
  task.status='submitting';await persist();
  const submitted=await client.submit({provider:task.provider,route:task.route,prompt:ledger.prompt,context:{market:'FI',language:'fi'},taskId:`pilot-017-${task.provider}-${Date.now()}`});
  Object.assign(task,submitted.remoteId?{remoteId:submitted.remoteId,submissionMeta:submitted.meta,status:'submitted'}:{status:submitted.result?.status||'interrupted_unknown',failure:submitted.result?.meta?.failure_code||'UNKNOWN'});
  await persist();if(!submitted.remoteId)return;
  const deadline=Date.now()+8*60000;
  while(Date.now()<deadline){
   let result;try{result=await client.poll({provider:task.provider,route:task.route,remoteId:task.remoteId});}catch{result={status:'pending'};}
   if(result.status!=='pending'){
    // Capture originals immediately, before normalization or additional work.
    await writeFile(`${out}/${task.provider}-original.json`,JSON.stringify(evidencePayload(task.route,result.raw)),{mode:0o600});
    if(result.status==='ready'){
     const normalized=normalizeCollection({provider:task.provider,route:task.route,raw:result.raw,context:{market:'FI',language:'fi'},prompt:ledger.prompt,remoteId:task.remoteId,submissionMeta:submitted.meta});
     await writeFile(`${out}/${task.provider}-normalized.json`,JSON.stringify(normalized,null,2),{mode:0o600});
     Object.assign(task,{status:normalized.status,answerCharacters:normalized.answer?.length||0,citations:normalized.citations?.length||0,searchQueries:normalized.collection?.searchQueries?.length??null,sourceReferences:normalized.collection?.sourceReferences?.length??null,locationVerification:normalized.collection?.locationVerification||null,...(normalized.meta?.failure_code?{failure:normalized.meta.failure_code}:{})});
    }else Object.assign(task,{status:'provider_failed',failure:result.code});
    await persist();return;
   }
   await new Promise(r=>setTimeout(r,15000));
  }
  task.status='pending_timeout';await persist();
 }catch{
  task.status=task.remoteId?'capture_or_poll_failed':'interrupted_unknown';await persist();
 }
}));
ledger.tasks.push({provider:'claude',status:'blocked_consumer_new_prompt_unsupported',note:'Current collector contract does not execute new consumer Claude prompts. Model API is not a substitute.'});
ledger.finishedAt=new Date().toISOString();await persist();
console.log(JSON.stringify({approvedUSD:ledger.approvedUSD,reservedUSD:ledger.reservedUSD,tasks:ledger.tasks.map(({remoteId,submissionMeta,route,...t})=>({...t,transport:route?.transport}))}));
