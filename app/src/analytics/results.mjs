import {one,exec,fail} from '../monitoring/shared.mjs';
import {extract} from './extraction.mjs';
import {loadJobs,attachSentiment} from '../sentiment/read.mjs';
import {analyticsService,parseMeasurementFilters} from './service.mjs';

const skipped=new Set(['unconfigured','disabled','budget_blocked','deadline_not_started','unsupported_context','not_configured']);
export const resultState=(task,e)=>!e?(['queued','executing','collecting','recorded'].includes(task.status)?task.status==='queued'?'queued':'running':'unavailable'):e.status==='success'?'success':skipped.has(e.status)?'skipped':'failed';
export async function resultsService({db,path,query=new URLSearchParams(),userId,env=process.env}){
 const projectId=path.split('/')[3],itemId=path.split('/')[5];
 if(!await one(db,'SELECT id FROM app_projects WHERE id=? AND owner_id=?',[projectId,userId]))fail(404,'NOT_FOUND');
 const page=Number(query.get('page')||1),pageSize=Number(query.get('pageSize')||25);
 if(!Number.isSafeInteger(page)||page<1||page>100000||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)fail(422,'INVALID_FILTER');
 const where=['r.project_id=?','r.owner_id=?'],args=[projectId,userId];
 // A run may contain multiple measurement partitions. Restrict exact task IDs
 // using the analytics selection itself; run IDs alone would leak other groups.
 if(query.get('group')){
  const analyticsQuery=new URLSearchParams(query);
  if(analyticsQuery.get('group')==='latest')analyticsQuery.delete('group');
  let selectedIds=[];
  await analyticsService({db,path:`/v1/projects/${projectId}/analytics`,query:analyticsQuery,userId,env,
   onSelectedTasks:tasks=>{selectedIds=tasks.map(t=>t.id);}});
  where.push('t.id IN (SELECT value FROM json_each(?))');args.push(JSON.stringify(selectedIds));
 }
 const filters=parseMeasurementFilters(query);
 for(const key of ['market','language'])if(filters[key]){
  where.push(`COALESCE(json_extract(r.snapshot,'$.${key}'),?)=?`);args.push(key==='market'?'FI':'fi',filters[key]);
 }
 if(filters.tags.length){
  const conditions=filters.tags.map(()=>`EXISTS(SELECT 1 FROM json_each(p.value,'$.tags') tag WHERE tag.value=?)`).join(filters.tagMode==='and'?' AND ':' OR ');
  where.push(`EXISTS(SELECT 1 FROM json_each(r.snapshot,'$.prompts') p WHERE json_extract(p.value,'$.id')=t.prompt_id AND (${conditions}))`);args.push(...filters.tags);
 }
 const version=query.get('promptVersion');
 if(version){if(!query.get('promptId')||!/^[1-9]\d*$/.test(version))fail(422,'INVALID_FILTER');where.push('t.prompt_version=?');args.push(Number(version));}
 const surface=query.get('surface');
 if(surface){
  if(!['model_api','consumer_web'].includes(surface))fail(422,'INVALID_FILTER');
  const frozenSurface=`(SELECT json_extract(route.value,'$.measurement_surface') FROM json_each(r.snapshot,'$.routes') route WHERE json_extract(route.value,'$.provider')=t.provider LIMIT 1)`;
  const collectionSurface=`json_extract(e.payload,'$.collection.surface')`,metaSurface=`json_extract(e.payload,'$.meta.measurement_surface')`;
  where.push(`(CASE WHEN ${collectionSurface} IN ('model_api','consumer_web') THEN ${collectionSurface}
    WHEN ${frozenSurface} IN ('model_api','consumer_web') THEN ${frozenSurface}
    WHEN ${metaSurface} IN ('model_api','consumer_web') THEN ${metaSurface} ELSE 'model_api' END)=?`);args.push(surface);
 }
 for(const [key,column] of [['runId','r.id'],['promptId','t.prompt_id'],['provider','t.provider']])if(query.get(key)){where.push(`${column}=?`);args.push(query.get(key));}
 if(itemId){where.push('t.id=?');args.push(itemId);}
 if(query.get('topic')){where.push("EXISTS(SELECT 1 FROM json_each(r.snapshot,'$.prompts') p WHERE json_extract(p.value,'$.id')=t.prompt_id AND json_extract(p.value,'$.topic')=?)");args.push(query.get('topic'));}
 for(const [key,op] of [['from','>='],['to','<=']])if(query.get(key)){
  const v=query.get(key),stamp=Date.parse(`${v}T00:00:00Z`);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(stamp)||new Date(stamp).toISOString().slice(0,10)!==v)fail(422,'INVALID_FILTER');
  where.push(`r.created_at${op}?`);args.push(stamp+(key==='to'?86400000-1:0));
 }
 if(query.get('from')&&query.get('to')&&query.get('from')>query.get('to'))fail(422,'INVALID_FILTER');
 const stateExpr=`CASE WHEN e.id IS NULL THEN CASE WHEN t.status='queued' THEN 'queued' WHEN t.status IN ('executing','collecting','recorded') THEN 'running' ELSE 'unavailable' END WHEN json_extract(e.payload,'$.status')='success' THEN 'success' WHEN json_extract(e.payload,'$.status') IN ('unconfigured','disabled','budget_blocked','deadline_not_started','unsupported_context','not_configured') THEN 'skipped' ELSE 'failed' END`;
 const state=query.get('state');if(state){if(!['queued','running','success','skipped','failed','unavailable'].includes(state))fail(422,'INVALID_FILTER');where.push(`(${stateExpr})=?`);args.push(state);}
 const join=`FROM mon_tasks t JOIN mon_runs r ON r.id=t.run_id LEFT JOIN mon_evidence e ON e.id=t.id WHERE ${where.join(' AND ')}`;
 const total=Number((await one(db,`SELECT COUNT(*) n ${join}`,args)).n);
 if(itemId&&!total)fail(404,'NOT_FOUND');
 const rows=(await exec(db,`SELECT t.*,r.snapshot,r.created_at run_created_at,e.payload ${join} ORDER BY r.created_at DESC,r.id,t.prompt_id,t.provider LIMIT ? OFFSET ?`,[...args,itemId?1:pageSize,itemId?0:(page-1)*pageSize])).rows;
 const jobs=await loadJobs(db,projectId,userId,rows.map(t=>t.id));
 const items=rows.map(t=>{
  const s=JSON.parse(t.snapshot),saved=t.payload?JSON.parse(t.payload):null;
  const e=saved||{id:t.id,runId:t.run_id,promptId:t.prompt_id,promptVersion:Number(t.prompt_version),text:t.text,provider:t.provider,model:JSON.parse(t.route).model||null,status:t.status,answer:'',citations:[],observedAt:null};
  const parsed=extract(attachSentiment(e,s,jobs,env),s);
  const {cohortMentions,cohortAvailable,...item}=parsed;
  return {...item,state:resultState(t,saved),taskStatus:t.status,runCreatedAt:Number(t.run_created_at),topic:s.prompts.find(p=>p.id===t.prompt_id)?.topic||'',language:s.language||'fi',market:s.market||'FI',metricsEligible:!parsed.exclusion};
 });
 return {status:200,data:itemId?items[0]:{items,total,page,pageSize,hasMore:page*pageSize<total}};
}
