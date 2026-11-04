import {analyticsService} from './service.mjs';
import {one,fail} from '../monitoring/shared.mjs';
import {canonicalQuery,formatVersion,queryKey} from './summary-contract.mjs';
import {assertSummaryReady} from './summary-service.mjs';
import {claimSummary,publishSummary,failSummary,cleanupSummaries,demandSummary} from './summary-store.mjs';

export async function projectSummaryOnce({db,env=process.env,now=Date.now,buildOverview,compute=analyticsService}){
 await assertSummaryReady(db,env);
 const job=await claimSummary(db,formatVersion(env),now());
 if(!job)return {state:'idle'};
 const started=now();let phase='preflight';
 try{
  const query=canonicalQuery(new URLSearchParams(job.query_json));
  // Bound projector memory before fetching raw evidence. A larger account gets
  // an explicit capacity error, never partial metrics or a paid re-collection.
  const from=Date.parse(query.get('from')),to=Date.parse(query.get('to'))+86400000-1,previousFrom=from-(to-from+1);
  const size=await one(db,'SELECT COUNT(*) n,COALESCE(SUM(length(CAST(e.payload AS BLOB))),0) bytes FROM mon_evidence e JOIN mon_runs r ON r.id=e.run_id WHERE r.project_id=? AND r.created_at>=? AND r.created_at<=?',[job.project_id,previousFrom,to]);
  if(Number(size.n)>50000||Number(size.bytes)>128*1024*1024)fail(422,'ANALYTICS_PROJECTION_LIMIT');
  let selectedEntries=[];
  phase='aggregate';
  const result=await compute({db,path:`/v1/projects/${job.project_id}/analytics`,userId:job.owner_id,query,env,
   onEntries:({entries})=>{selectedEntries=entries;}});
  const identity=await one(db,'SELECT v.identity_json FROM app_projects p JOIN app_identity_versions v ON v.project_id=p.id AND v.version=p.version WHERE p.id=?',[job.project_id]);
  if(!identity)throw Object.assign(Error('NOT_FOUND'),{code:'NOT_FOUND'});
  const {evidence,...summary}=result.data;
  const allEvidence=new Map();
  // Match useAllSetups: selected response first, then all neutral compositions.
  for(const e of evidence)allEvidence.set(e.id,e);
  const runId=query.get('runId');
  for(const group of result.data.groups.filter(g=>g.id!==result.data.selectedGroup))
   for(const entry of selectedEntries.filter(e=>e.group===group.id&&(!runId?e.kind==='neutral':e.id===runId)))
    for(const {cohortMentions,cohortAvailable,...e} of entry.rows)allEvidence.set(e.id,e);
  phase='overview';
  const builder=buildOverview||(await import('./summary-overview.mjs')).buildOverviewSummary;
  const filters={...Object.fromEntries(query),provider:query.get('provider')||'all',topic:query.get('topic')||'all',tags:JSON.parse(query.get('tags')||'[]')};
  const projected=builder({analytics:result.data,allEvidence:[...allEvidence.values()],project:JSON.parse(identity.identity_json),filters,now:now()});
  phase='publish';
  // Legacy analytics consumers use run-created date selection; the Overview drawer
  // additionally filters by answer observation date. Preserve both populations explicitly.
  const evidenceScope=query.get('evidenceScope')==='analytics'?'analytics':'overview';
  const savedEvidence=evidenceScope==='analytics'?evidence:projected.evidence;
  const published=await publishSummary(db,job,{...summary,...(evidenceScope==='analytics'?{evidenceScope}:{}),ui:projected.ui},savedEvidence,now);
  return {state:published.published?'published':'retry',...published,projectId:job.project_id,sourceRevision:Number(job.source_revision),durationMs:now()-started};
 }catch(error){
  const code=await failSummary(db,job,error,now());
  return {state:'failed',code,phase,projectId:job.project_id,durationMs:now()-started};
 }
}

export async function prewarmSummaries({db,env=process.env,now=Date.now,limit=200,after=''}){
 await assertSummaryReady(db,env);
 const stamp=now(),to=new Date(stamp).toISOString().slice(0,10),from=new Date(Date.parse(to)-27*86400000).toISOString().slice(0,10),format=formatVersion(env);
 const projects=(await db.execute({sql:"SELECT id FROM app_projects WHERE status='active' AND id>? ORDER BY id LIMIT ?",args:[after,Math.min(200,limit)]})).rows;
 for(const {id} of projects){const q=canonicalQuery(new URLSearchParams({from,to}));await demandSummary(db,id,queryKey(q,format),q,format,stamp);}
 return {count:projects.length,next:projects.length===Math.min(200,limit)?projects.at(-1).id:null};
}
export {cleanupSummaries};
