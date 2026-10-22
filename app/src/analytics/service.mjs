import {loadJobs,attachSentiment} from '../sentiment/read.mjs';
import { hash, one, exec, fail } from '../monitoring/shared.mjs';
import { extract, aggregate, extractionVersion } from './extraction.mjs';
import { competitorMeasurements } from './competitors.mjs';
import {overviewInsights} from './overview.mjs';
import {readIntelligence} from '../intelligence/read.mjs';
import {containsName} from '../common/scan-profile.mjs';
import {collectionSurface,methodFor,metricsFor,legacyMetricVersion} from '../common/observations.mjs';

function measured(snapshot,rows,expected,provider) {
  const context=rows[0]||{provider:provider||snapshot?.routes?.[0]?.provider};
  return {...aggregate(rows,expected),metricVersion:metricsFor(snapshot,context),
    measurementSurface:collectionSurface(context,snapshot),collectionMethod:methodFor(snapshot,context)};
}
export function composition(snapshot, tasks, rows) {
  const context=rows[0]||{provider:tasks[0]?.provider};
  return hash({identity:snapshot.identity, identityVersion:snapshot.identityVersion, cohort:snapshot.cohort || null,
    methodology:snapshot.methodology, metrics:metricsFor(snapshot,context), extraction:extractionVersion,
    collectionMethod:methodFor(snapshot,context),surface:collectionSurface(context,snapshot),
    measurementContexts:[...new Set(rows.map(e=>JSON.stringify([collectionSurface(e,snapshot),methodFor(snapshot,e),metricsFor(snapshot,e)])))].sort(),
    market:snapshot.market, language:snapshot.language, kind:snapshot.kind,
    prompts:tasks.map(t=>[t.prompt_id,Number(t.prompt_version),t.text]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    routes:snapshot.routes,
    // Include actual model identities when providers report them; unknown is not interchangeable.
    models:[...new Set(rows.map(e=>`${e.provider}:${e.model || 'unknown'}`))].sort()});
}
// Exact pre-reconciliation identity, used solely to resolve saved historical
// links. It must not pool the separate measurement universes introduced later.
export function legacyComposition(snapshot,tasks,rows) {
 return hash({identity:snapshot.identity,identityVersion:snapshot.identityVersion,cohort:snapshot.cohort||null,
  methodology:snapshot.methodology,metrics:legacyMetricVersion,extraction:extractionVersion,
  market:snapshot.market,language:snapshot.language,kind:snapshot.kind,
  prompts:tasks.map(t=>[t.prompt_id,Number(t.prompt_version),t.text]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
  routes:snapshot.routes,models:[...new Set(rows.map(e=>`${e.provider}:${e.model||'unknown'}`))].sort()});
}
function date(value, end=false) {
  if (!value) return end ? Infinity : -Infinity;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(422,'INVALID_FILTER');
  const n=Date.parse(`${value}T00:00:00Z`);
  if(!Number.isFinite(n)||new Date(n).toISOString().slice(0,10)!==value)fail(422,'INVALID_FILTER');
  return n+(end?86400000-1:0);
}
export function parseMeasurementFilters(query) {
  let tags=[];
  const encoded=query.get('tags');
  if(encoded!==null) {
    if(encoded.length>1024)fail(422,'INVALID_FILTER');
    try { tags=JSON.parse(encoded); } catch { fail(422,'INVALID_FILTER'); }
    if(!Array.isArray(tags))fail(422,'INVALID_FILTER');
  }
  const legacy=query.get('tag');
  if(legacy)tags=[...tags,legacy];
  if(tags.length>12||tags.some(t=>typeof t!=='string'||!t.trim()||t.length>40))fail(422,'INVALID_FILTER');
  tags=[...new Set(tags.map(t=>t.trim()))].sort();
  const tagMode=query.get('tagMode')||'or',market=query.get('market')||'',language=query.get('language')||'';
  if(!['and','or'].includes(tagMode)||(market&&!/^[A-Z]{2}$/.test(market))||(language&&!/^[a-z]{2}$/.test(language)))fail(422,'INVALID_FILTER');
  return {tags,tagMode,market,language};
}
export function matchesMeasurementFilters(snapshot,prompt,{tags,tagMode,market,language}) {
  return (!market||(snapshot.market||'FI')===market)&&(!language||(snapshot.language||'fi')===language)&&
    (!tags.length||(tagMode==='and'?tags.every(t=>(prompt?.tags||[]).includes(t)):tags.some(t=>(prompt?.tags||[]).includes(t))));
}
/** Complete-dataset per-version summaries; never average incompatible run compositions. */
export function promptSummaries(entries) {
  const buckets=new Map();
  for(const e of entries.filter(e=>e.kind==='neutral')) {
    const keys=new Set(e.tasks.map(t=>JSON.stringify([t.prompt_id,Number(t.prompt_version)])));
    for(const key of keys) {
      const [promptId,version]=JSON.parse(key),tasks=e.tasks.filter(t=>t.prompt_id===promptId&&Number(t.prompt_version)===version);
      const ids=new Set(tasks.map(t=>t.id)),rows=e.rows.filter(r=>ids.has(r.id));
      const group=composition(e.snapshot,tasks,rows),bucket=buckets.get(key)||new Map();
       const old=bucket.get(group)||{group,rows:[],expected:0,latestAt:0,runCount:0,snapshot:e.snapshot,provider:tasks[0]?.provider};
      old.rows.push(...rows);old.expected+=tasks.length;old.latestAt=Math.max(old.latestAt,e.createdAt);old.runCount++;
      bucket.set(group,old);buckets.set(key,bucket);
    }
  }
  return [...buckets].map(([key,bucket])=>{
    const [promptId,version]=JSON.parse(key),groups=[...bucket.values()].sort((a,b)=>b.latestAt-a.latestAt);
    const latest=groups[0];
    return {promptId,version,selectedGroup:latest.group,groupCount:groups.length,latestAt:latest.latestAt,
       runCount:latest.runCount,metrics:measured(latest.snapshot,latest.rows,latest.expected,latest.provider)};
  });
}
export async function analyticsService({db,path,userId,query=new URLSearchParams(),env=process.env,onSelectedTasks}) {
  const id=path.split('/')[3];
  if(!await one(db,'SELECT id FROM app_projects WHERE id=? AND owner_id=?',[id,userId]))fail(404,'NOT_FOUND');
  const project=await one(db,'SELECT v.identity_json FROM app_projects p JOIN app_identity_versions v ON v.project_id=p.id AND v.version=p.version WHERE p.id=?',[id]);
  const from=date(query.get('from')),to=date(query.get('to'),true);
  if(from>to)fail(422,'INVALID_FILTER');
  const previousFrom=Number.isFinite(from)&&Number.isFinite(to)?from-(to-from+1):from;
  const provider=query.get('provider')||'',topic=query.get('topic')||'',runId=query.get('runId')||'';
  const filters=parseMeasurementFilters(query),surface=query.get('surface')||'';
  const promptId=query.get('promptId')||'',version=query.get('promptVersion')||'';
  if(version&&(!promptId||!/^[1-9]\d*$/.test(version)))fail(422,'INVALID_FILTER');
  if(promptId&&!await one(db,'SELECT id FROM mon_prompts WHERE id=? AND project_id=?',[promptId,id]))fail(404,'NOT_FOUND');
  const raw=(await exec(db,'SELECT * FROM mon_runs WHERE project_id=? AND owner_id=? ORDER BY created_at,id',[id,userId])).rows;
  const windowSql=`${Number.isFinite(previousFrom)?' AND r.created_at>=?':''}${Number.isFinite(to)?' AND r.created_at<=?':''}`;
  const windowArgs=[id,userId,...(Number.isFinite(previousFrom)?[previousFrom]:[]),...(Number.isFinite(to)?[to]:[])];
  const tasks=(await exec(db,`SELECT t.* FROM mon_tasks t JOIN mon_runs r ON r.id=t.run_id WHERE r.project_id=? AND r.owner_id=?${windowSql}`,windowArgs)).rows;
  const evidence=(await exec(db,`SELECT e.payload FROM mon_evidence e JOIN mon_runs r ON r.id=e.run_id WHERE r.project_id=? AND r.owner_id=?${windowSql}`,windowArgs)).rows.map(r=>JSON.parse(r.payload));
  const tasksByRun=new Map(),evidenceByRun=new Map();
  for(const task of tasks){const bucket=tasksByRun.get(task.run_id)||[];bucket.push(task);tasksByRun.set(task.run_id,bucket);}
  for(const row of evidence){const bucket=evidenceByRun.get(row.runId)||[];bucket.push(row);evidenceByRun.set(row.runId,bucket);}
  const sentimentJobs=await loadJobs(db,id,userId);
  const topics=new Set(), availableProviders=new Set(), availableTags=new Set(),availableSurfaces=new Set(),availablePrompts=new Map(),availableMarkets=new Set(),availableLanguages=new Set();
  const allEntries=[];
  for(const r of raw) {
    const snapshot=JSON.parse(r.snapshot);
    availableMarkets.add(snapshot.market||'FI');availableLanguages.add(snapshot.language||'fi');
    for(const p of snapshot.prompts)if(p.topic)topics.add(p.topic);
    for(const p of snapshot.prompts){for(const tag of p.tags||[])availableTags.add(tag);availablePrompts.set(p.id,{id:p.id,text:p.text});}
    for(const r of snapshot.routes)availableProviders.add(r.provider);
    for(const route of snapshot.routes)availableSurfaces.add(collectionSurface({provider:route.provider},snapshot));
    if(Number(r.created_at)<previousFrom||Number(r.created_at)>to)continue;
    const storedTasks=tasksByRun.get(r.id)||[];
    const allTasks=storedTasks.length?storedTasks:snapshot.prompts.flatMap(p=>snapshot.routes.map(route=>({
      id:`unstarted:${r.id}:${p.id}:${route.provider}`,run_id:r.id,prompt_id:p.id,prompt_version:p.version,text:p.text,provider:route.provider,
    })));
    const runEvidence=evidenceByRun.get(r.id)||[],evidenceByTask=new Map(runEvidence.map(e=>[e.id,e]));
    const taskSurface=t=>{
      const row=evidenceByTask.get(t.id);
       return collectionSurface(row||{provider:t.provider},snapshot);
    };
    for(const task of allTasks)availableSurfaces.add(taskSurface(task));
    const selectedTasks=allTasks.filter(t=>(!provider||t.provider===provider)&&(!promptId||t.prompt_id===promptId)&&(!version||Number(t.prompt_version)===Number(version))&&
      (!topic||snapshot.prompts.some(p=>p.id===t.prompt_id&&p.topic===topic))&&
      matchesMeasurementFilters(snapshot,snapshot.prompts.find(p=>p.id===t.prompt_id),filters)&&
      (!surface||taskSurface(t)===surface));
    if(!selectedTasks.length)continue;
    const taskIds=new Set(selectedTasks.map(t=>t.id));
    const rawRows=(evidenceByRun.get(r.id)||[]).filter(e=>taskIds.has(e.id)).map(e=>attachSentiment(e,snapshot,sentimentJobs,env));
    const rows=rawRows.map(e=>{
     const p=snapshot.prompts.find(p=>p.id===e.promptId);
     const brands=snapshot.cohort?.brands||[snapshot.identity];
     return {...extract(e,snapshot),topic:p?.topic||'',tags:p?.tags||[],market:snapshot.market||'FI',language:snapshot.language||'fi',
      brandNames:[...new Set(brands.flatMap(b=>[b.brandName,...(b.aliases||[])]).filter(n=>n&&containsName(e.answer||'',n)))]};
    });
     // Partition before aggregation, including unstarted tasks. A mixed run is
     // not a single measurement universe even when the provider names match.
     const partitions=new Map();
     for(const task of selectedTasks){
      const saved=runEvidence.find(e=>e.id===task.id)||{provider:task.provider};
      const key=JSON.stringify([collectionSurface(saved,snapshot),methodFor(snapshot,saved),metricsFor(snapshot,saved)]);
      const partition=partitions.get(key)||[];partition.push(task);partitions.set(key,partition);
     }
     for(const partition of partitions.values()){
      const ids=new Set(partition.map(t=>t.id)),partRows=rows.filter(e=>ids.has(e.id)),partRaw=rawRows.filter(e=>ids.has(e.id));
      const partSnapshot={...snapshot,routes:snapshot.routes.filter(route=>partition.some(t=>t.provider===route.provider))};
      const group=composition(partSnapshot,partition,partRows);
      allEntries.push({id:r.id,createdAt:Number(r.created_at),kind:r.kind,status:r.status,group,
       legacyGroup:!snapshot.collectionMethod?legacyComposition(snapshot,selectedTasks,rows):null,
       metrics:measured(partSnapshot,partRows,partition.length,partition[0]?.provider),rows:partRows,rawRows:partRaw,tasks:partition,snapshot:partSnapshot});
     }
  }
  const entries=allEntries.filter(e=>e.createdAt>=from);
  if(provider&&!availableProviders.has(provider))fail(422,'INVALID_FILTER');
  if(topic&&!topics.has(topic))fail(422,'INVALID_FILTER');
  if(filters.tags.some(tag=>!availableTags.has(tag)))fail(422,'INVALID_FILTER');
  if(filters.market&&!availableMarkets.has(filters.market))fail(422,'INVALID_FILTER');
  if(filters.language&&!availableLanguages.has(filters.language))fail(422,'INVALID_FILTER');
  if(surface&&!availableSurfaces.has(surface))fail(422,'INVALID_FILTER');
  const groupsMap=new Map();
  for(const e of entries.filter(e=>e.kind==='neutral')){
    const old=groupsMap.get(e.group);
    groupsMap.set(e.group,{id:e.group,runCount:(old?.runCount||0)+1,latestAt:e.createdAt,
       measurementSurface:collectionSurface(e.rows[0]||{provider:e.tasks[0]?.provider},e.snapshot),
       collectionMethod:methodFor(e.snapshot,e.rows[0]||{provider:e.tasks[0]?.provider}),
       metricVersion:metricsFor(e.snapshot,e.rows[0]||{provider:e.tasks[0]?.provider}),
       label:`${e.snapshot.methodology} · ${collectionSurface(e.rows[0]||{provider:e.tasks[0]?.provider},e.snapshot)} · identity ${e.snapshot.identityVersion} · ${e.tasks.length} answers`});
  }
  const groups=[...groupsMap.values()].sort((a,b)=>b.latestAt-a.latestAt);
  let requested=query.get('group');
  if(requested&&!groupsMap.has(requested)){
   const aliases=new Set(entries.filter(e=>e.legacyGroup===requested&&(!runId||e.id===runId)).map(e=>e.group));
   // A historically mixed group resolves to the newest available partition,
   // with canonical selectedGroup returned to the UI, never combined totals.
   requested=groups.find(g=>aliases.has(g.id))?.id||requested;
  }
  if(requested&&!groupsMap.has(requested))fail(422,'INVALID_FILTER');
   const selectedGroup=requested||(runId?entries.find(e=>e.id===runId)?.group:null)||groups[0]?.id||null;
  if(runId&&!entries.some(e=>e.id===runId))fail(404,'NOT_FOUND');
   if(runId&&requested&&!entries.some(e=>e.id===runId&&e.group===requested))fail(422,'INVALID_FILTER');
   const selected=entries.filter(e=>e.group===selectedGroup&&(runId?e.id===runId:e.kind==='neutral'));
   // Internal read-only drilldown bridge: includes unfinished tasks, not only recorded evidence.
   onSelectedTasks?.(selected.flatMap(e=>e.tasks));
  const selectedRows=selected.flatMap(e=>e.rows),expected=selected.reduce((n,e)=>n+e.tasks.length,0);
  const previous=runId?[]:allEntries.filter(e=>e.createdAt<from&&e.group===selectedGroup&&e.kind==='neutral');
  const priorMetrics=aggregate(previous.flatMap(e=>e.rows),previous.reduce((n,e)=>n+e.tasks.length,0));
  const comparison=previous.length&&priorMetrics.eligible&&Number.isFinite(previousFrom)?{from:new Date(previousFrom).toISOString().slice(0,10),to:new Date(from-1).toISOString().slice(0,10),metrics:priorMetrics}:null;
  const providers=[...new Set(selected.flatMap(e=>e.tasks.map(t=>t.provider)))].sort().map(provider=>({
     provider,metrics:measured(selected[0]?.snapshot,selectedRows.filter(e=>e.provider===provider),selected.reduce((n,e)=>n+e.tasks.filter(t=>t.provider===provider).length,0),provider)}));
  const audit=(await exec(db,'SELECT * FROM app_audit_events WHERE project_id=? AND user_id=? ORDER BY created_at DESC,id',[id,userId])).rows;
  const versions=(await exec(db,'SELECT v.*,p.id FROM mon_prompt_versions v JOIN mon_prompts p ON p.id=v.prompt_id WHERE p.project_id=? ORDER BY v.created_at DESC',[id])).rows;
  const changes=[...audit.map(r=>({id:r.id,createdAt:r.created_at,type:r.kind,version:Number(r.version||0)})),
    ...versions.map(r=>({id:`${r.id}:${r.version}`,createdAt:new Date(Number(r.created_at)).toISOString(),type:`prompt.${JSON.parse(r.payload).status==='archived'?'archived':Number(r.version)===1?'created':'updated'}`,version:Number(r.version)}))]
    .filter(r=>Date.parse(r.createdAt)>=from&&Date.parse(r.createdAt)<=to).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const quickChecks=Number((await one(db,'SELECT COUNT(*) n FROM app_project_scans WHERE project_id=?',[id])).n);
  const overview=overviewInsights(selected,comparison);
  const intelligence=await readIntelligence(db,id,selected,overview);
   return {status:200,headers:{},data:{methodology:metricsFor(selected[0]?.snapshot,selectedRows[0]||{provider:selected[0]?.tasks[0]?.provider}),extractionVersion,selectedGroup,groups,
     measurementScope:'frozen_tracked_cohort_not_all_detected_brands',
    promptScope:{promptId:promptId||null,promptVersion:version?Number(version):null},
    promptSummaries:promptSummaries(runId?entries.filter(e=>e.id===runId):entries),
    overview,intelligence,
     availableTags:[...availableTags].sort(),availableMarkets:[...availableMarkets].sort(),availableLanguages:[...availableLanguages].sort(),availableSurfaces:[...availableSurfaces].sort(),availablePrompts:[...availablePrompts.values()],
    metrics:measured(selected[0]?.snapshot,selectedRows,expected,selected[0]?.tasks[0]?.provider),providers,competitors:competitorMeasurements(selected),
     runs:entries.map((e,i)=>({id:e.id,createdAt:e.createdAt,kind:e.kind,status:e.status,group:e.group,measurementSurface:collectionSurface(e.rows[0]||{provider:e.tasks[0]?.provider},e.snapshot),comparableToPrevious:i>0&&e.kind==='neutral'&&e.group===entries[i-1].group,metrics:e.metrics})),
    evidence:selectedRows.map(({cohortMentions,cohortAvailable,...e})=>e),changes,topics:[...topics].sort(),availableProviders:[...availableProviders].sort(),
    totalRuns:entries.length,quickChecks,market:selected[0]?.snapshot.market??JSON.parse(project.identity_json).market??'FI',language:selected[0]?.snapshot.language??JSON.parse(project.identity_json).promptLanguage??'fi'}};
}
