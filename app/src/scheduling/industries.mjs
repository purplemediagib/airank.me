import {one,exec,fail} from '../monitoring/shared.mjs';
import {importPanel,validatePanel,enqueue,report,nextSlot,budgets} from '../benchmark/core.mjs';
import {routesFromEnv} from '../providers/routing.mjs';
import {id,checksum} from './migration.mjs';
async function ready(db){if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)fail(503,'APP_NOT_CONFIGURED');}
import {redact} from '../research/service.mjs';
export const catalogue=[
 ['digital-marketing','Digimarkkinointi','Digital marketing'],['ecommerce','Verkkokauppa','Ecommerce'],['travel','Matkailu','Travel'],
 ['real-estate','Kiinteistönvälitys','Real estate'],['accounting','Tilitoimistot','Accounting'],['legal','Lakipalvelut','Legal services'],
 ['software','IT-palvelut','IT services'],['insurance','Vakuutukset','Insurance'],['gyms','Kuntosalit','Gyms'],
 ['education','Koulutus','Education'],['construction','Rakentaminen','Construction'],['restaurants','Ravintolat','Restaurants']
].map(([id,nameFi,nameEn])=>({id,nameFi,nameEn,status:'draft',pilot:false}));
export const isAdmin=(userId,env)=>String(env.APP_ADMIN_USER_IDS||'').split(',').map(s=>s.trim()).filter(Boolean).includes(userId);
export async function industriesService({db,method,path,body,userId,env=process.env,now=Date.now}){
 await ready(db);const admin=isAdmin(userId,env),industryId=path.split('/')[3];
 if(method==='POST'){
  if(!admin)fail(403,'ADMIN_REQUIRED');
  if(body?.action==='import'){
   if(body.verified!==true||body.neutralConfirmed!==true)fail(422,'VERIFICATION_REQUIRED');
   try{validatePanel(body.panel);}catch{fail(422,'INVALID_PANEL');}
   // No measured/verified claim is inferred from an uploaded name or domain.
   try{await importPanel(db,body.panel,now(),{verifiedBy:userId});}catch(e){if(/immutable|UNIQUE/i.test(e.message))fail(409,'VERSION_CONFLICT');throw e;}
  }else{
   const p=await one(db,'SELECT * FROM bm_panels WHERE id=?',[body?.panelId||'']);if(!p)fail(404,'NOT_FOUND');
   const panel=JSON.parse(p.dataset_json),routes=routesFromEnv(env),models=Object.fromEntries(Object.entries(routes).map(([k,v])=>[k,v.model]));
   const calls=panel.prompts.length*Object.keys(routes).length,limits=budgets(env);
   if(body.action==='publish'){
    if(body.verified!==true||body.neutralConfirmed!==true)fail(422,'VERIFICATION_REQUIRED');
    await exec(db,'INSERT INTO bm_publications VALUES (?,1,?,?) ON CONFLICT(panel_id) DO UPDATE SET published=1,verified_by=excluded.verified_by',[p.id,userId,now()]);
   }else if(body.action==='schedule'){
    if(typeof body.enabled!=='boolean')fail(422,'VALIDATION_FAILED');
    if(body.enabled&&(env.BENCHMARK_ENABLED!=='true'||env.BENCHMARK_SCHEDULER_ENABLED!=='true'))fail(503,'SCHEDULER_NOT_ENABLED');
    if(body.enabled&&calls>Math.min(limits.daily,limits.perRun))fail(422,'PANEL_EXCEEDS_CAPACITY');
    if(body.enabled&&(await one(db,'SELECT published FROM bm_publications WHERE panel_id=?',[p.id]))?.published!==1)fail(409,'PANEL_NOT_PUBLISHED');
    await exec(db,'UPDATE bm_schedules SET enabled=?,next_at=? WHERE panel_id=?',[body.enabled?1:0,nextSlot(now()),p.id]);
   }else if(body.action==='run'){
    if(env.BENCHMARK_ENABLED!=='true')fail(503,'BENCHMARK_NOT_ENABLED');
    if(typeof body.submissionId!=='string'||!/^[\w-]{16,80}$/.test(body.submissionId))fail(422,'VALIDATION_FAILED');
    if((await one(db,'SELECT published FROM bm_publications WHERE panel_id=?',[p.id]))?.published!==1)fail(409,'PANEL_NOT_PUBLISHED');
    await enqueue(db,p.id,'manual:'+body.submissionId,models,now(),routes);
   }else fail(422,'VALIDATION_FAILED');
  }
 }else if(method!=='GET')fail(405,'METHOD_NOT_ALLOWED');
 const panels=(await exec(db,'SELECT p.*,s.enabled,s.next_at,u.published FROM bm_panels p LEFT JOIN bm_schedules s ON s.panel_id=p.id LEFT JOIN bm_publications u ON u.panel_id=p.id ORDER BY p.created_at DESC,p.id')).rows.filter(p=>admin||p.published===1||p.published==null);
 const industries=new Map(catalogue.map(i=>[i.id,{...i,panels:[]}]));
 const routes=routesFromEnv(env),limits=budgets(env);
 for(const p of panels){
  const panel=JSON.parse(p.dataset_json),pilot=p.id.startsWith('fi-mobile');
  if(!industries.has(p.industry_id))industries.set(p.industry_id,{id:p.industry_id,nameFi:panel.industry.name,nameEn:panel.industry.name,status:'draft',pilot,panels:[]});
  const runs=(await exec(db,'SELECT id,created_at,status,snapshot_json FROM bm_runs WHERE panel_id=? ORDER BY created_at DESC,id DESC',[p.id])).rows;
  const summaries=runs.map(r=>{const s=JSON.parse(r.snapshot_json);return{id:r.id,createdAt:Number(r.created_at),status:r.status,composition:JSON.stringify({panel:p.dataset_hash,methodology:s.methodology,models:s.models,routes:s.routes})};});
  let latest=null;
  if(industryId===p.industry_id&&runs.length){
   const r=await report(db,runs[0].id);
   const valid=r.jobs.filter(j=>j.state==='success'&&String(j.result?.answer||'').trim());
   // Each provider/prompt answer is reused across every member of the fixed cohort.
   const rankings=panel.brands.map(b=>{
    const perProvider=Object.values(r.metrics).map(m=>m.brands[b.id]);
    const mentions=perProvider.reduce((n,m)=>n+m.mentions,0),citations=perProvider.reduce((n,m)=>n+m.cited_responses,0);
    return{id:b.id,name:b.name,mentions,citations,eligible:valid.length,visibility:valid.length?Math.round(mentions/valid.length*1000)/10:null};
   }).sort((a,b)=>(b.visibility??-1)-(a.visibility??-1)||a.name.localeCompare(b.name));
   latest={runId:runs[0].id,eligible:valid.length,expected:r.jobs.length,rankings,evidence:r.jobs.map(j=>({id:j.id,prompt:panel.prompts.find(p=>p.id===j.prompt_id)?.text||'',provider:j.provider,model:r.run.snapshot.models[j.provider],status:j.state,observedAt:j.observed_at,answer:redact(j.result?.answer||''),citations:redact(j.result?.citations||[])}))};
  }
  const calls=panel.prompts.length*Object.keys(routes).length,i=industries.get(p.industry_id);
  const measured=!!await one(db,"SELECT j.id FROM bm_jobs j JOIN bm_runs r ON r.id=j.run_id WHERE r.panel_id=? AND j.state='success' AND length(trim(json_extract(j.result_json,'$.answer')))>0 LIMIT 1",[p.id]);
  if(measured)i.status='measured';else if(i.status!=='measured'&&p.published!==0)i.status='unmeasured';i.pilot ||=pilot;
  i.panels.push({id:p.id,version:p.version,published:p.published!==0,brands:panel.brands.length,prompts:panel.prompts.length,requiredCalls:calls,capacity:Math.min(limits.daily,limits.perRun),enabled:!!p.enabled,nextAt:p.enabled?Number(p.next_at):null,timezone:'UTC',weekdays:[1,4],hour:8,runs:summaries,latest});
 }
 const data={admin,activationAvailable:env.BENCHMARK_ENABLED==='true'&&env.BENCHMARK_SCHEDULER_ENABLED==='true',industries:[...industries.values()]};
 if(industryId){data.industries=data.industries.filter(i=>i.id===industryId);if(!data.industries.length)fail(404,'NOT_FOUND');}
 return{status:200,data};
}
