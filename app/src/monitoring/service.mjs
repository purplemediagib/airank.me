import {loadJobs,attachSentiment} from '../sentiment/read.mjs';
import { uuid } from '../common/utils.mjs';
import { routeAvailable } from '../providers/routing.mjs';
import {isCollectorRoute,collectionBudget} from '../collectors/config.mjs';
import {frozenCohort} from '../research/service.mjs';
import {selectedRoutes} from '../reports/service.mjs';
import {measurementContext,sameContext} from '../common/measurement-context.mjs';
import {workspaceSuggestions,validateDraft} from '../common/workspace-suggestions.mjs';
import {suggestionsReady} from './suggestions-migration.mjs';
import {immediatePrompts,measurementKey} from './immediate.mjs';
import { id,checksum } from './migration.mjs';
import {assertCanonical,assertPromptCapacity,promptReadiness,assertDailyNotMeasured} from './prompt-policy.mjs';
import { fail,hash,normalized,one,exec,transaction,methodology,collectionMethodVersion,promptSQL,promptRow,runRow,setting } from './shared.mjs';

function input(b,identity,archiving=false){
 if(!b||typeof b.text!=='string'||b.text.trim().length<8||b.text.length>1000||/[<>\r]/.test(b.text)||typeof b.topic!=='string'||b.topic.length>80||
 !Array.isArray(b.tags)||b.tags.length>12||b.tags.some(t=>typeof t!=='string'||!t.trim()||t.length>40)||!['neutral','diagnostic'].includes(b.kind))fail(422,'VALIDATION_FAILED');
 const text=b.text.trim();
 if(!archiving)validateDraft(b,identity);
 return {text,topic:b.topic.trim(),tags:[...new Set(b.tags.map(t=>t.trim()))],kind:b.kind,...measurementContext(identity)};
}
const suggestion=r=>{
 const {generatedHash,...metadata}=JSON.parse(r.metadata||'{}');
 return {id:r.id,text:r.text,status:r.status,source:r.source,promptId:r.prompt_id||null,
  kind:'neutral',topic:'',tags:[],...metadata};
};
const suggestionSQL='SELECT s.*,m.payload AS metadata FROM mon_suggestions s LEFT JOIN mon_suggestion_metadata m ON m.suggestion_id=s.id';
export async function monitoringService({db,method,path,query=new URLSearchParams(),body,userId,now=Date.now,env=process.env,generate,scheduleSlot,immediate=false,verifyImmediateCredentials=false}){
 try{if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)fail(503,'APP_NOT_CONFIGURED');}catch{fail(503,'APP_NOT_CONFIGURED');}
 const match=path.match(/^\/v1\/projects\/([a-zA-Z0-9-]{1,80})\/(prompts|suggestions|monitoring-runs)(?:\/([a-zA-Z0-9-]{1,80}))?$/);
 if(!match)fail(404,'NOT_FOUND');
 const [,projectId,kind,itemId]=match;
 const owned=async cx=>{
  const p=await one(cx,'SELECT p.*,v.identity_json FROM app_projects p JOIN app_identity_versions v ON v.project_id=p.id AND v.version=p.version WHERE p.id=? AND p.owner_id=?',[projectId,userId]);
  if(!p)fail(404,'NOT_FOUND');if(method!=='GET'&&p.status!=='active')fail(409,'VERSION_CONFLICT');return p;
 };
 const project=await owned(db), identity=JSON.parse(project.identity_json);
 const reply=(data,status=200)=>({status,data});
 const addPrompt=async(cx,data)=>{
   await assertPromptCapacity(cx,userId,projectId,env,{adding:true});
  const fingerprint=hash([data.kind,normalized(data.text),measurementContext(data)]);
  if(await one(cx,'SELECT id FROM mon_prompts WHERE project_id=? AND hash=?',[projectId,fingerprint]))fail(409,'DUPLICATE_PROMPT');
  const promptId=uuid(),stamp=now();
  await exec(cx,'INSERT INTO mon_prompts VALUES (?,?,?,?,?,?)',[promptId,projectId,1,'active',fingerprint,stamp]);
  await exec(cx,'INSERT INTO mon_prompt_versions VALUES (?,?,?,?)',[promptId,1,JSON.stringify({...data,status:'active'}),stamp]);
  return promptRow(await one(cx,`${promptSQL} WHERE p.id=?`,[promptId]));
 };
 if(kind==='prompts'){
  if(method==='GET'&&!itemId){
   const filters=['p.project_id=?'],args=[projectId],status=query.get('status')||'active';
   if(!['active','archived'].includes(status))fail(422,'VALIDATION_FAILED');
   filters.push('p.status=?');args.push(status);
   const search=query.get('search');if(search){filters.push("instr(replace(replace(replace(lower(json_extract(v.payload,'$.text')),'Ä','ä'),'Ö','ö'),'Å','å'),?)>0");args.push(search.slice(0,1000).toLocaleLowerCase('fi'));}
   for(const key of ['topic','tag'])if(query.get(key)){
    filters.push(key==='topic'?"json_extract(v.payload,'$.topic')=?":"EXISTS(SELECT 1 FROM json_each(v.payload,'$.tags') WHERE value=?)");args.push(query.get(key));
   }
   const provider=query.get('provider'),outcome=query.get('outcome');
   if(outcome==='unmeasured'){
    filters.push(`NOT EXISTS(SELECT 1 FROM mon_evidence e WHERE json_extract(e.payload,'$.promptId')=p.id ${provider?"AND json_extract(e.payload,'$.provider')=?":''})`);
    if(provider)args.push(provider);
   }else if(provider||outcome){
    filters.push(`EXISTS(SELECT 1 FROM mon_evidence e WHERE json_extract(e.payload,'$.promptId')=p.id ${provider?"AND json_extract(e.payload,'$.provider')=?":''} ${outcome?"AND json_extract(e.payload,'$.status')=?":''})`);
    if(provider)args.push(provider);if(outcome)args.push(outcome);
   }
   const page=Math.max(1,Math.min(100000,Number(query.get('page')||1)));
   if(!Number.isInteger(page))fail(422,'VALIDATION_FAILED');
   const where=filters.join(' AND '),total=Number((await one(db,`SELECT COUNT(*) n FROM mon_prompts p JOIN mon_prompt_versions v ON v.prompt_id=p.id AND v.version=p.version WHERE ${where}`,args)).n);
   const sort=query.get('sort')==='text'?"json_extract(v.payload,'$.text'),p.id":'v.created_at DESC,p.id';
   const rows=(await exec(db,`${promptSQL} WHERE ${where} ORDER BY ${sort} LIMIT 20 OFFSET ?`,[...args,(page-1)*20])).rows;
   return reply({items:rows.map(promptRow),total,page,pageSize:20});
  }
  if(method==='POST'&&!itemId)return transaction(db,async tx=>{const p=await owned(tx);return reply(await addPrompt(tx,input(body,JSON.parse(p.identity_json))),201);});
  const p=await one(db,`${promptSQL} WHERE p.id=? AND p.project_id=?`,[itemId,projectId]);if(!p)fail(404,'NOT_FOUND');
  if(method==='GET'){
   const versions=(await exec(db,'SELECT * FROM mon_prompt_versions WHERE prompt_id=? ORDER BY version DESC',[itemId])).rows.map(v=>({...promptRow(p),...JSON.parse(v.payload),version:Number(v.version),createdAt:Number(v.created_at)}));
   const measurements=(await exec(db,"SELECT e.payload FROM mon_evidence e JOIN mon_runs r ON r.id=e.run_id WHERE r.owner_id=? AND r.project_id=? AND json_extract(e.payload,'$.promptId')=? ORDER BY e.observed_at DESC",[userId,projectId,itemId])).rows.map(r=>JSON.parse(r.payload));
   return reply({prompt:promptRow(p),versions,measurements});
  }
  if(method==='PATCH')return transaction(db,async tx=>{
   const currentProject=await owned(tx),current=await one(tx,`${promptSQL} WHERE p.id=? AND p.project_id=?`,[itemId,projectId]);
   if(body?.expectedVersion!==Number(current.version)||!['active','archived'].includes(body?.status))fail(409,'VERSION_CONFLICT');
    if(body.status==='active'){
     await assertCanonical(tx,userId,projectId);
     if(current.status!=='active')await assertPromptCapacity(tx,userId,projectId,env,{adding:true});
    }
   const data=input(body,JSON.parse(currentProject.identity_json),body.status==='archived'),fingerprint=hash([data.kind,normalized(data.text),measurementContext(data)]);
   if(await one(tx,'SELECT id FROM mon_prompts WHERE project_id=? AND hash=? AND id<>?',[projectId,fingerprint,itemId]))fail(409,'DUPLICATE_PROMPT');
   const version=Number(current.version)+1;
   await exec(tx,'INSERT INTO mon_prompt_versions VALUES (?,?,?,?)',[itemId,version,JSON.stringify({...data,status:body.status}),now()]);
   await exec(tx,'UPDATE mon_prompts SET version=?,status=?,hash=? WHERE id=?',[version,body.status,fingerprint,itemId]);
   return reply(promptRow(await one(tx,`${promptSQL} WHERE p.id=?`,[itemId])));
  });
 }
 if(kind==='suggestions'){
  await suggestionsReady(db);
  const list=async cx=>(await exec(cx,`${suggestionSQL} WHERE s.project_id=? ORDER BY s.id`,[projectId])).rows.map(suggestion);
  if(method==='GET'&&!itemId)return reply(await list(db));
  if(method==='POST'&&!itemId){
   const cohort=await frozenCohort(db,projectId,identity);
   const exclude=(cohort?.brands||[]).flatMap(b=>[b.brandName,...b.aliases,...b.ownedDomains]);
   const drafts=await workspaceSuggestions({db,project,identity,env,now,generate,exclude});return transaction(db,async tx=>{
   const current=await owned(tx),profile=JSON.parse(current.identity_json);
   if(Number(current.version)!==Number(project.version))fail(409,'VERSION_CONFLICT');
   const context=measurementContext(profile);
   for(const draft of drafts){
    const fingerprint=hash([draft.kind,normalized(draft.text),context]),suggestionId=uuid();
    if(await one(tx,`SELECT s.id FROM mon_suggestions s JOIN mon_suggestion_metadata m ON m.suggestion_id=s.id
     WHERE s.project_id=? AND json_extract(m.payload,'$.generatedHash')=? AND json_extract(m.payload,'$.identityVersion')=?`,[projectId,fingerprint,Number(current.version)]))continue;
    await exec(tx,'INSERT OR IGNORE INTO mon_suggestions VALUES (?,?,?,?,?,?,?)',[suggestionId,projectId,fingerprint,draft.text,'pending',`context:${context.market}/${context.language}; identity version ${current.version}`,null]);
    const saved=await one(tx,'SELECT id FROM mon_suggestions WHERE project_id=? AND hash=?',[projectId,fingerprint]);
    await exec(tx,'INSERT OR IGNORE INTO mon_suggestion_metadata VALUES (?,?)',[saved.id,JSON.stringify({...draft,generatedHash:fingerprint})]);
    // A newly generated batch may repeat an unreviewed question after identity
    // changes. Refresh its provenance, but never undo an explicit review/edit
    // within the same identity version or rewrite accepted tracked prompts.
    await exec(tx,`UPDATE mon_suggestion_metadata SET payload=? WHERE suggestion_id=?
     AND json_extract(payload,'$.identityVersion')<>?
     AND EXISTS(SELECT 1 FROM mon_suggestions s WHERE s.id=suggestion_id AND s.status='pending')`,
     [JSON.stringify({...draft,generatedHash:fingerprint}),saved.id,Number(current.version)]);
   }return reply(await list(tx));
  });}
  if(method==='PATCH'&&itemId)return transaction(db,async tx=>{
   const current=await owned(tx),s=await one(tx,`${suggestionSQL} WHERE s.id=? AND s.project_id=?`,[itemId,projectId]);
   if(!s)fail(404,'NOT_FOUND');if(s.status!=='pending')fail(409,'VERSION_CONFLICT');
   const old=suggestion(s);
   if(old.identityVersion&&old.identityVersion!==Number(current.version))fail(409,'CONTEXT_PROMPTS_REQUIRED');
   const draft=input({...old,...body},JSON.parse(current.identity_json));
   const fingerprint=hash([draft.kind,normalized(draft.text),measurementContext(draft)]);
   if(await one(tx,'SELECT id FROM mon_suggestions WHERE project_id=? AND hash=? AND id<>?',[projectId,fingerprint,itemId]))fail(409,'DUPLICATE_PROMPT');
   const metadata={...draft,generatedHash:JSON.parse(s.metadata||'{}').generatedHash||s.hash,identityVersion:Number(current.version)};
   await exec(tx,'UPDATE mon_suggestions SET text=?,hash=? WHERE id=?',[draft.text,fingerprint,itemId]);
   await exec(tx,'INSERT INTO mon_suggestion_metadata VALUES (?,?) ON CONFLICT(suggestion_id) DO UPDATE SET payload=excluded.payload',[itemId,JSON.stringify(metadata)]);
   return reply(suggestion(await one(tx,`${suggestionSQL} WHERE s.id=?`,[itemId])));
  });
  if(method==='POST'&&itemId)return transaction(db,async tx=>{
   const current=await owned(tx),s=await one(tx,`${suggestionSQL} WHERE s.id=? AND s.project_id=?`,[itemId,projectId]);
   if(!s)fail(404,'NOT_FOUND');
   if(!['accept','reject'].includes(body?.action))fail(422,'VALIDATION_FAILED');
   const status=body.action==='accept'?'accepted':'rejected';
   if(s.status!=='pending'){if(s.status!==status)fail(409,'VERSION_CONFLICT');return reply(suggestion(s));}
   let promptId=null;
   if(status==='accepted'){
    const context=measurementContext(JSON.parse(current.identity_json)),saved=s.source?.match(/^context:([A-Z]{2})\/([a-z]{2});/);
    if(!sameContext(saved?{market:saved[1],language:saved[2]}:{},context))fail(409,'CONTEXT_PROMPTS_REQUIRED');
    const old=suggestion(s);
    if(old.identityVersion&&old.identityVersion!==Number(current.version))fail(409,'CONTEXT_PROMPTS_REQUIRED');
    const edits=Object.fromEntries(['text','topic','tags','kind'].filter(k=>Object.hasOwn(body,k)).map(k=>[k,body[k]]));
    const data=input({...old,...edits},JSON.parse(current.identity_json)),fingerprint=hash([data.kind,normalized(data.text),context]);
    const metadata={...data,generatedHash:JSON.parse(s.metadata||'{}').generatedHash||s.hash,identityVersion:Number(current.version)};
    if(await one(tx,'SELECT id FROM mon_suggestions WHERE project_id=? AND hash=? AND id<>?',[projectId,fingerprint,itemId]))fail(409,'DUPLICATE_PROMPT');
    await exec(tx,'UPDATE mon_suggestions SET text=?,hash=? WHERE id=?',[data.text,fingerprint,itemId]);
    await exec(tx,'INSERT INTO mon_suggestion_metadata VALUES (?,?) ON CONFLICT(suggestion_id) DO UPDATE SET payload=excluded.payload',[itemId,JSON.stringify(metadata)]);
     const found=await one(tx,'SELECT id,status FROM mon_prompts WHERE project_id=? AND hash=?',[projectId,fingerprint]);
     await assertCanonical(tx,userId,projectId);
     if(found?.status==='archived')fail(409,'PROMPT_ARCHIVED');
    promptId=found?.id||(await addPrompt(tx,data)).id;
   }
   await exec(tx,'UPDATE mon_suggestions SET status=?,prompt_id=? WHERE id=?',[status,promptId,itemId]);
   return reply(suggestion(await one(tx,`${suggestionSQL} WHERE s.id=?`,[itemId])));
  });
 }
 if(kind==='monitoring-runs'){
  if(method==='GET'&&!itemId){const rows=(await exec(db,'SELECT * FROM mon_runs WHERE project_id=? AND owner_id=? ORDER BY created_at DESC,id',[projectId,userId])).rows;return reply(await Promise.all(rows.map(r=>runRow(db,r))));}
  if(method==='GET'&&itemId){
   const r=await one(db,'SELECT * FROM mon_runs WHERE id=? AND project_id=? AND owner_id=?',[itemId,projectId,userId]);if(!r)fail(404,'NOT_FOUND');
   const sentimentJobs=await loadJobs(db,projectId,userId),snapshot=JSON.parse(r.snapshot);
   return reply({run:await runRow(db,r),evidence:(await exec(db,'SELECT payload FROM mon_evidence WHERE run_id=? ORDER BY observed_at,id',[itemId])).rows.map(e=>attachSentiment(JSON.parse(e.payload),snapshot,sentimentJobs,env))});
  }
  if(method==='POST'&&!itemId){
   if(env.MONITORING_ENABLED!=='true')fail(503,'MONITORING_NOT_ENABLED');
   if(!body||!['neutral','diagnostic'].includes(body.kind)||typeof body.submissionId!=='string'||!/^[\w-]{16,80}$/.test(body.submissionId))fail(422,'VALIDATION_FAILED');
   const requestHash=hash([projectId,body.kind]);
   return transaction(db,async tx=>{
     if(scheduleSlot){
      const slot=await one(tx,"SELECT s.state,c.enabled FROM app_schedule_slots s JOIN app_project_schedules c ON c.project_id=s.project_id WHERE s.project_id=? AND s.slot=?",[projectId,scheduleSlot]);
      if(slot?.state!=='pending'||!slot.enabled)fail(409,'SCHEDULE_CANCELLED');
     }
    const previous=immediate?null:await one(tx,'SELECT * FROM mon_runs WHERE owner_id=? AND submission_id=?',[userId,body.submissionId]);
    if(previous){if(previous.request_hash!==requestHash)fail(409,'VERSION_CONFLICT');return reply(await runRow(tx,previous),202);}
    if(scheduleSlot)await assertDailyNotMeasured(tx,userId,projectId,scheduleSlot,body.kind);
    const current=await owned(tx),profile=JSON.parse(current.identity_json);
     await assertPromptCapacity(tx,userId,projectId,env);
     if(await promptReadiness(tx,projectId,profile)==='prompt_review_required')fail(422,'PROMPT_REVIEW_REQUIRED');
    const context=measurementContext(profile);
    let prompts=(await exec(tx,`${promptSQL} WHERE p.project_id=? AND p.status='active' AND json_extract(v.payload,'$.kind')=? ORDER BY p.id`,[projectId,body.kind])).rows.map(promptRow).filter(p=>sameContext(p,context));
    const fullCount=prompts.length;
    if(immediate){
     prompts=await immediatePrompts(tx,projectId,prompts);
     if(!prompts.length)return reply({status:'covered'},200);
    }
    if(!prompts.length)fail(422,'CONTEXT_PROMPTS_REQUIRED');
    // Revalidate against the whole confirmed cohort, not only the owned brand.
    const cohort=await frozenCohort(tx,projectId,profile);
    for(const p of prompts){input(p,profile);if(p.kind==='neutral')for(const b of cohort?.brands||[])input(p,b);}
    let routes;
     try{routes=Object.entries(await selectedRoutes(tx,projectId,env)).map(([provider,r])=>({provider,...r,measurement_surface:r.measurement_surface||'model_api'}));}
    catch(e){if(immediate)fail(503,'APP_NOT_CONFIGURED');throw e;}
    if(!routes.length)fail(422,'NO_AVAILABLE_PROVIDERS');
    if(immediate&&verifyImmediateCredentials){
     if(routes.some(r=>!routeAvailable(r.provider,r,env)))fail(503,'MONITORING_PROVIDERS_UNCONFIGURED');
     if(routes.some(isCollectorRoute)&&env.CONSUMER_COLLECTION_ENABLED!=='true')fail(503,'CONSUMER_COLLECTION_NOT_ENABLED');
     if(routes.some(r=>isCollectorRoute(r)&&!collectionBudget(env,r.provider)))fail(503,'COLLECTOR_BUDGET_NOT_CONFIGURED');
     setting(env,'MONITORING_CONCURRENCY',2,1,8);
     setting(env,'MONITORING_PROVIDER_TIMEOUT_MS',120000,10,600000);
     setting(env,'MAX_DAILY_PROVIDER_CALLS',200,0,1000000);
    }
    const expected=prompts.length*routes.length,stamp=now(),runId=uuid();
    const limit=setting(env,'MONITORING_MAX_TASKS_PER_RUN',1000,1,5000);
    const blocked=expected>limit;
    const deadline=stamp+setting(env,'MONITORING_RUN_TIMEOUT_MS',1800000,1000,86400000);
     const surfaces=new Set(routes.map(r=>r.measurement_surface||'model_api'));
     const snapshot={identity:profile,identityVersion:Number(current.version),cohort,prompts,routes,
      collectionMethod:collectionMethodVersion,
      ...(immediate?{collectionTrigger:'immediate'}:{}),collectionScope:immediate&&prompts.length!==fullCount?'incremental':'full',
      methodology:surfaces.size>1?'tracked-separated-surfaces-v2':surfaces.has('consumer_web')?'tracked-consumer-evidence-v1':methodology,...context,kind:body.kind};
    // A no-task capacity rejection can recover after capacity/routes change.
    // Already-reserved prompts are removed above regardless of this key.
    const submissionId=immediate?hash(['immediate',projectId,prompts.map(p=>[p.id,measurementKey(p)]),routes,limit]):body.submissionId;
    const existing=immediate?await one(tx,'SELECT * FROM mon_runs WHERE owner_id=? AND submission_id=?',[userId,submissionId]):null;
    if(existing)return reply(await runRow(tx,existing),202);
    await exec(tx,'INSERT INTO mon_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[runId,projectId,userId,submissionId,requestHash,body.kind,blocked?'capacity_blocked':'queued',JSON.stringify(snapshot),expected,stamp,deadline,blocked?'panel_exceeds_monitoring_capacity':null]);
    if(!blocked)for(const p of prompts)for(const route of routes)await exec(tx,'INSERT INTO mon_tasks VALUES (?,?,?,?,?,?,?,?,?,?)',[uuid(),runId,p.id,p.version,p.text,route.provider,JSON.stringify(route),'queued',null,null]);
    if(immediate)for(const p of prompts)await exec(tx,"UPDATE mon_immediate_outbox SET state=?,run_id=?,reason=? WHERE prompt_id=? AND fingerprint=?",[blocked?'blocked':'submitted',runId,blocked?'panel_exceeds_monitoring_capacity':null,p.id,measurementKey(p)]);
    return reply(await runRow(tx,await one(tx,'SELECT * FROM mon_runs WHERE id=?',[runId])),202);
   });
  }
 }
 fail(404,'NOT_FOUND');
}
