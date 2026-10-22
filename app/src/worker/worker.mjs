import {sentimentTick} from '../sentiment/runtime.mjs';
import {entityTick} from '../intelligence/runtime.mjs';
import http from 'node:http';
import { benchmarkTick } from '../benchmark/runtime.mjs';
import { monitoringTick } from '../monitoring/runtime.mjs';
import {tickWebsiteProfiles} from '../website-profile/worker.mjs';
import { reserveQuickCall } from '../monitoring/budget.mjs';
import { CONFIG,hasDbConfig } from '../common/config.mjs';
import { sql, one, getDb } from '../common/db.mjs';
import { inspectWebsite } from '../common/fetch-website.mjs';
import { promptCandidates,detectEvidence } from '../common/observations.mjs';
import {routesFromEnv,routeAvailable,providersForScan} from '../providers/routing.mjs';
import {callRoute} from '../providers/dispatch.mjs';
import {observeProvider,logEvent} from '../providers/diagnostics.mjs';
import {workerConfiguration} from './config-check.mjs';
import { scanProfileDDL } from '../migrate.mjs';
import {confirmedPrompts,profileEvidence,METHODOLOGY} from '../common/scan-profile.mjs';
import { storeRawJson } from '../common/storage.mjs';
import { uuid,errorMessage } from '../common/utils.mjs';
const workerId=uuid(),started=Date.now();let ready=false,stop=false,running=false;
const routes=routesFromEnv();
logEvent('worker_configuration',workerConfiguration());
const models=Object.fromEntries(Object.entries(routes).map(([p,r])=>[p,r.model]));
function respond(res,status,body){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}
const server=http.createServer((req,res)=>{
 if(req.url==='/healthz')return respond(res,200,{ok:true,service:'airank-worker',version:CONFIG.version,revision:process.env.AIRANK_BUILD_REVISION||null,uptime_seconds:Math.floor((Date.now()-started)/1000)});
 if(req.url==='/readyz')return respond(res,ready?200:503,{ready});
 return respond(res,404,{error:'Not found'});
});
server.listen(CONFIG.workerPort,'0.0.0.0',()=>console.log(`AIRank worker v${CONFIG.version} health port ${CONFIG.workerPort}`));
async function claim(){
 const rows=await sql('SELECT id FROM scan_jobs WHERE status=? OR (status=? AND lease_expires<?) ORDER BY requested_at LIMIT 2',['queued','processing',Date.now()]);
 for(const row of rows.rows){
  const n=await sql('UPDATE scan_jobs SET status=?,started_at=COALESCE(started_at,?),lock_owner=?,lease_expires=?,attempts=attempts+1 WHERE id=? AND (status=? OR (status=? AND lease_expires<?))',['processing',Date.now(),workerId,Date.now()+CONFIG.leaseMs,row.id,'queued','processing',Date.now()]);
  if(Number(n.rowsAffected||0)===1)return await one('SELECT * FROM scan_jobs WHERE id=?',[row.id]);
 }
 return null;
}
async function recordObservation({scan,prompt,provider,result}){
 const citations=result.citations||[];
 const e=scan.profile?profileEvidence(result.answer,scan.profile,citations):detectEvidence(result.answer,scan.brand_name,scan.domain,citations);
 let rawKey=null;
 if(result.raw){try{rawKey=await storeRawJson(scan.id,provider,prompt.id,result.raw)}catch(err){console.warn('Raw provider storage failed:',errorMessage(err))}}
 await sql(`INSERT INTO observations (id,scan_id,prompt_id,provider,provider_status,model,answer_text,citations_json,own_domain_cited,brand_mentioned,recommended,raw_storage_key,usage_json,observed_at,error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scan_id,prompt_id,provider) DO UPDATE SET provider_status=excluded.provider_status,model=excluded.model,answer_text=excluded.answer_text,citations_json=excluded.citations_json,own_domain_cited=excluded.own_domain_cited,brand_mentioned=excluded.brand_mentioned,recommended=excluded.recommended,raw_storage_key=excluded.raw_storage_key,usage_json=excluded.usage_json,observed_at=excluded.observed_at,error=excluded.error`,[uuid(),scan.id,prompt.id,provider,result.status,result.model||models[provider]||'',String(result.answer||'').slice(0,15000),JSON.stringify(citations),+e.ownCitation,+e.mentioned,+e.recommended,rawKey,JSON.stringify({...result.meta,...(scan.profile?{methodology:METHODOLOGY,matched_aliases:e.matched_aliases}:{} )}).slice(0,6000),Date.now(),result.error||null]);
}
async function executeOne(provider,prompt,scan){
 const existing=await one('SELECT provider_status FROM observations WHERE scan_id=? AND prompt_id=? AND provider=?',[scan.id,prompt.id,provider]);
 if(existing)return; // Immutable observations per scan; no silent re-measure on retry.
 const skip=async(status,reason)=>{
  logEvent('provider_skipped',{scan_id:scan.id,prompt_id:prompt.id,provider,status,reason});
  return recordObservation({scan,prompt,provider,result:{status,error:reason,meta:{failure_code:reason}}});
 };
 if(!routes[provider])return skip('unconfigured','PROVIDER_DISABLED');
 if(!routeAvailable(provider,routes[provider]))return skip('unconfigured','MISSING_CREDENTIAL');
 if(!await reserveQuickCall(await getDb(),{scanId:scan.id,provider,daily:CONFIG.maxDailyProviderCalls,perRun:CONFIG.maxProviderCalls}))return skip('budget_blocked','BUDGET_EXHAUSTED');
 const result=await observeProvider({provider,route:routes[provider],timeoutMs:CONFIG.httpTimeoutMs,ids:{scan_id:scan.id,prompt_id:prompt.id},call:()=>callRoute(provider,prompt.prompt_text,routes[provider],CONFIG.httpTimeoutMs,scan.profile||{})});
 // A persistence failure is a scan failure, never a replacement provider failure.
 await recordObservation({scan,prompt,provider,result});
 logEvent('evidence_saved',{scan_id:scan.id,prompt_id:prompt.id,provider});
}
async function processJob(scan){
 try{
  const savedProfile=await one('SELECT profile_json FROM scan_profiles WHERE scan_id=?',[scan.id]);
  scan.profile=savedProfile?JSON.parse(savedProfile.profile_json):null;
  let prompts=(await sql('SELECT id,sequence,prompt_text FROM scan_prompts WHERE scan_id=? ORDER BY sequence',[scan.id])).rows;
  if(!prompts.length){
   let questions;
   if(scan.profile){
    // Confirmed identity is authoritative; page titles must never overwrite it.
    questions=confirmedPrompts(scan.profile,scan.profile.prompt_count);
    await sql('UPDATE scan_jobs SET industry=? WHERE id=?',[scan.profile.category_fi,scan.id]);
   }else{
    const site=await inspectWebsite(scan.domain);
    await sql('UPDATE scan_jobs SET website_title=?,industry=?,brand_name=? WHERE id=?',[site.title,site.description.slice(0,200),scan.brand_name===scan.domain.split('.')[0]?site.brand:scan.brand_name,scan.id]);
    scan=await one('SELECT * FROM scan_jobs WHERE id=?',[scan.id]);
    questions=promptCandidates({...site,brand:scan.brand_name},CONFIG.scanPrompts);
   }
   for(let i=0;i<questions.length;i++)await sql('INSERT INTO scan_prompts (id,scan_id,sequence,prompt_text,prompt_version,intent) VALUES (?,?,?,?,?,?)',[uuid(),scan.id,i+1,questions[i],scan.profile?METHODOLOGY:'template-fi-v1',i===0?'discovery':i===1?'comparison':'selection']);
   prompts=(await sql('SELECT id,sequence,prompt_text FROM scan_prompts WHERE scan_id=? ORDER BY sequence',[scan.id])).rows;
  }
  const hasProjects=await one("SELECT name FROM sqlite_master WHERE type='table' AND name='app_project_scans'");
  const platform=hasProjects&&Boolean(await one('SELECT scan_id FROM app_project_scans WHERE scan_id=?',[scan.id]));
  const providers=providersForScan({requested:scan.profile?.providers,enabled:CONFIG.enabledProviders,platform});
  logEvent('scan_started',{scan_id:scan.id,platform:Boolean(platform),providers,prompt_count:prompts.length});
  for(const prompt of prompts){for(const provider of providers){
    if(stop)throw new Error('Worker shutdown');
    // Lease is refreshed before every provider call to support long-lived scans.
    await sql('UPDATE scan_jobs SET lease_expires=? WHERE id=? AND lock_owner=?',[Date.now()+CONFIG.leaseMs,scan.id,workerId]);
    await executeOne(provider,prompt,scan);
  }}
  const success=await one('SELECT COUNT(*) as n FROM observations WHERE scan_id=? AND provider_status=?',[scan.id,'success']);
  const status=Number(success.n)>0?'completed':'no_measurements';
  await sql('UPDATE scan_jobs SET status=?,finished_at=?,lease_expires=NULL,lock_owner=NULL,error=NULL WHERE id=? AND lock_owner=?',[status,Date.now(),scan.id,workerId]);
  console.log(JSON.stringify({event:'scan_finished',id:scan.id,status,sample_size:Number(success.n)}));
 }catch(e){
  console.error('Scan failed',scan.id,errorMessage(e));
  await sql('UPDATE scan_jobs SET status=?,error=?,finished_at=?,lease_expires=NULL,lock_owner=NULL WHERE id=? AND lock_owner=?',['failed',errorMessage(e),Date.now(),scan.id,workerId]);
 }
}
async function tick(){if(running)return;running=true;try{if(!hasDbConfig()){ready=false;return;}await sql('SELECT id FROM users LIMIT 1');if(!ready)await sql(scanProfileDDL);ready=true;try{await benchmarkTick()}catch(e){console.warn('Benchmark waiting:',errorMessage(e))}const job=await claim();if(job)await processJob(job)}catch(err){ready=false;console.warn('Worker waiting for Bunny DB:',errorMessage(err))}finally{running=false}}
async function main(){await tick();while(!stop){await new Promise(r=>setTimeout(r,CONFIG.jobPollMs));if(!stop)await tick()}}
main().catch(e=>console.error('Worker fatal:',errorMessage(e)));
// Independent pump within the existing worker, not a browser scheduler or duplicate service.
const monitoringTimer=process.env.MONITORING_ENABLED==='true'?setInterval(()=>monitoringTick().catch(()=>console.warn('Monitoring unavailable; check migration and database readiness')),Math.min(5000,CONFIG.jobPollMs)):null;
let profileBusy=false;
const profileTimer=process.env.WEBSITE_PROFILE_ENABLED==='true'?setInterval(async()=>{
 if(profileBusy||stop)return;profileBusy=true;
 try{await tickWebsiteProfiles(await getDb());}catch{console.warn('Website autofill unavailable; check migration and worker configuration');}finally{profileBusy=false;}
},Math.min(5000,CONFIG.jobPollMs)):null;
process.on('SIGTERM',()=>clearInterval(profileTimer));
process.on('SIGTERM',()=>clearInterval(monitoringTimer));
process.on('SIGTERM',()=>{stop=true;server.close(()=>{if(!running)process.exit(0)});setTimeout(()=>process.exit(0),10000).unref()});

// Independent analysis queue: never holds up provider evidence or scan completion.
const sentimentTimer=process.env.SENTIMENT_ENABLED==='true'?setInterval(()=>{if(!stop)sentimentTick().catch(()=>console.warn('Sentiment unavailable; check migration and worker configuration'));},Math.min(5000,CONFIG.jobPollMs)):null;
process.on('SIGTERM',()=>clearInterval(sentimentTimer));
const entityTimer=process.env.ENTITY_ANALYSIS_ENABLED==='true'?setInterval(()=>{if(!stop)entityTick().catch(()=>console.warn('Entity analysis unavailable; check migration and worker configuration'));},Math.min(5000,CONFIG.jobPollMs)):null;
process.on('SIGTERM',()=>clearInterval(entityTimer));
