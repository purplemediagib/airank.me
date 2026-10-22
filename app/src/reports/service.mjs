import {uuid} from '../common/utils.mjs';
import {one,exec,fail,transaction,setting} from '../monitoring/shared.mjs';
import {analyticsService} from '../analytics/service.mjs';
import {monitoringRoutesFromEnv as routesFromEnv,routeAvailable} from '../providers/routing.mjs';
import {isCollectorRoute,collectionBudget} from '../collectors/config.mjs';
import {redact} from '../research/service.mjs';
import {id,checksum} from './migration.mjs';
async function ready(db){try{if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)fail(503,'APP_NOT_CONFIGURED');}catch{fail(503,'APP_NOT_CONFIGURED');}}
export async function selectedRoutes(db,projectId,env){
 const routes=routesFromEnv(env);
 if(!await one(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='app_measurement_settings'"))return routes;
 const r=await one(db,'SELECT providers FROM app_measurement_settings WHERE project_id=?',[projectId]);
 if(!r)return routes;
 const selected=JSON.parse(r.providers);return Object.fromEntries(Object.entries(routes).filter(([p])=>selected.includes(p)));
}
export async function measurementSettingsService({db,method,path,body,userId,env=process.env,now=Date.now}){
 const projectId=path.split('/')[3],project=await one(db,'SELECT * FROM app_projects WHERE id=? AND owner_id=?',[projectId,userId]);if(!project)fail(404,'NOT_FOUND');await ready(db);
 const routes=routesFromEnv(env);
 if(method==='PATCH'){
  if(project.status!=='active')fail(409,'VERSION_CONFLICT');
  if(!Array.isArray(body?.providers)||!body.providers.length||new Set(body.providers).size!==body.providers.length||body.providers.some(p=>!Object.hasOwn(routes,p)))fail(422,'VALIDATION_FAILED');
  await transaction(db,async tx=>{
   const r=await one(tx,'SELECT * FROM app_measurement_settings WHERE project_id=?',[projectId]);if(body.expectedVersion!==(r?Number(r.version):0))fail(409,'VERSION_CONFLICT');
   await exec(tx,'INSERT INTO app_measurement_settings VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET version=excluded.version,providers=excluded.providers,updated_at=excluded.updated_at',[projectId,(r?Number(r.version):0)+1,JSON.stringify(body.providers),now()]);
   await exec(tx,'INSERT INTO app_audit_events (id,user_id,project_id,kind,version,created_at) VALUES (?,?,?,?,?,?)',[uuid(),userId,projectId,'providers.updated',(r?Number(r.version):0)+1,new Date(now()).toISOString()]);
  });
 }else if(method!=='GET')fail(405,'METHOD_NOT_ALLOWED');
 const r=await one(db,'SELECT * FROM app_measurement_settings WHERE project_id=?',[projectId]);
 const providers=r?JSON.parse(r.providers):Object.keys(routes);
 const count=Number((await one(db,"SELECT COUNT(*) n FROM mon_prompts p JOIN mon_prompt_versions v ON v.prompt_id=p.id AND v.version=p.version WHERE p.project_id=? AND p.status='active' AND json_extract(v.payload,'$.kind')='neutral'",[projectId])).n);
 return{status:200,data:{version:r?Number(r.version):0,providers,available:Object.entries(routes).map(([provider,route])=>({provider,model:route.model,transport:route.transport,configured:routeAvailable(provider,route,env),measurementSurface:route.measurement_surface||'model_api',...(isCollectorRoute(route)?{collectionEnabled:env.CONSUMER_COLLECTION_ENABLED==='true',budgetConfigured:!!collectionBudget(env,provider)}:{})})),prompts:count,requiredCalls:count*providers.filter(p=>Object.hasOwn(routes,p)).length,capacity:setting(env,'MONITORING_MAX_TASKS_PER_RUN',1000,1,5000),updatedAt:r?Number(r.updated_at):null}};
}
const summary=r=>({id:r.id,projectId:r.project_id,createdAt:Number(r.created_at),expiresAt:Number(r.expires_at),locale:r.locale,title:r.title||(r.payload?JSON.parse(r.payload).title:null)||'AI Rank'});
export async function reportService({db,method,path,body,userId,now=Date.now}){
 const projectId=path.split('/')[3],reportId=path.split('/')[5];
 const project=await one(db,'SELECT * FROM app_projects WHERE id=? AND owner_id=?',[projectId,userId]);if(!project)fail(404,'NOT_FOUND');await ready(db);
 if(method==='POST'&&!reportId){
  if(project.status!=='active')fail(409,'VERSION_CONFLICT');
  if(!['fi','en'].includes(body?.locale)||!body.filters||typeof body.filters!=='object'||Array.isArray(body.filters))fail(422,'VALIDATION_FAILED');
  const title=body.title??'AI Rank',sections=body.sections??['overview','cohort','questions'];
  if(typeof title!=='string'||!title.trim()||title.trim().length>160||!Array.isArray(sections)||sections.length>3||new Set(sections).size!==sections.length||sections.some(s=>!['overview','cohort','questions'].includes(s)))fail(422,'VALIDATION_FAILED');
  const filters={};for(const key of ['from','to','provider','topic','group','runId','surface','promptId','promptVersion','tag','tagMode','tags','market','language'])if(body.filters[key]!=null){const value=key==='promptVersion'&&Number.isSafeInteger(body.filters[key])?String(body.filters[key]):body.filters[key];if(typeof value!=='string'||value.length>(key==='tags'?1024:200))fail(422,'VALIDATION_FAILED');filters[key]=value;}
  const analytics=(await analyticsService({db,userId,path:`/v1/projects/${projectId}/analytics`,query:new URLSearchParams(filters)})).data;
  const stamp=now(),id=uuid(),identity=JSON.parse((await one(db,'SELECT identity_json FROM app_identity_versions WHERE project_id=? AND version=?',[projectId,project.version])).identity_json);
  const runIds=[...new Set(analytics.runs.filter(r=>r.group===analytics.selectedGroup&&(filters.runId?r.id===filters.runId:r.kind==='neutral')).map(r=>r.id))],runSnapshots=[];
  for(const runId of runIds){const r=await one(db,'SELECT snapshot FROM mon_runs WHERE id=? AND project_id=? AND owner_id=?',[runId,projectId,userId]);if(r)runSnapshots.push({runId,snapshot:JSON.parse(r.snapshot)});}
  const snapshot=redact({schemaVersion:'report-snapshot-v1',title:title.trim(),sections,locale:body.locale,filters,measurementLanguage:runSnapshots[0]?.snapshot.language??identity.promptLanguage??'fi',market:runSnapshots[0]?.snapshot.market??identity.market??'FI',timezone:'UTC',identity:runSnapshots[0]?.snapshot.identity||identity,runSnapshots,analytics});
  await exec(db,'INSERT INTO app_reports VALUES (?,?,?,?,?,?,?)',[id,projectId,userId,stamp,stamp+30*86400000,body.locale,JSON.stringify(snapshot)]);
  return{status:201,data:{...summary({id,project_id:projectId,created_at:stamp,expires_at:stamp+30*86400000,locale:body.locale,title:snapshot.title}),snapshot}};
 }
 if(method!=='GET')fail(405,'METHOD_NOT_ALLOWED');
 if(reportId){
  const r=await one(db,'SELECT * FROM app_reports WHERE id=? AND project_id=? AND owner_id=?',[reportId,projectId,userId]);if(!r)fail(404,'NOT_FOUND');if(Number(r.expires_at)<=now())fail(410,'REPORT_EXPIRED');
  return{status:200,data:{...summary(r),snapshot:JSON.parse(r.payload)}};
 }
 return{status:200,data:(await exec(db,"SELECT id,project_id,created_at,expires_at,locale,json_extract(payload,'$.title') title FROM app_reports WHERE project_id=? AND owner_id=? ORDER BY created_at DESC,id",[projectId,userId])).rows.map(summary)};
}
