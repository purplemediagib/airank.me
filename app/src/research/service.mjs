import {uuid} from '../common/utils.mjs';
import {one,exec,fail,hash,normalized,transaction} from '../monitoring/shared.mjs';
import {extract,sourceUrls} from '../analytics/extraction.mjs';
import {id,checksum} from './migration.mjs';
import {workspaceSuggestions} from '../common/workspace-suggestions.mjs';
import {suggestionsReady} from '../monitoring/suggestions-migration.mjs';
import {sameContext} from '../common/measurement-context.mjs';

export async function cohortState(db,projectId){
 const r=await one(db,'SELECT * FROM app_cohorts WHERE project_id=? ORDER BY version DESC LIMIT 1',[projectId]);
 return r?{version:Number(r.version),competitors:JSON.parse(r.payload)}:{version:0,competitors:[]};
}
export async function frozenCohort(db,projectId,identity){
 // Existing installations remain compatible before the explicitly applied migration.
 if(!await one(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='app_cohorts'"))return null;
 const c=await cohortState(db,projectId);
 return c.version?{version:c.version,brands:[identity,...c.competitors.filter(b=>b.status==='active').map(b=>({brandName:b.name,aliases:b.aliases,ownedDomains:b.domains}))]}:null;
}
export function redact(value){
 if(Array.isArray(value))return value.map(redact);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/(authorization|cookie|token|secret|password|api.?key|headers|credential)/i.test(k)).map(([k,v])=>[k,redact(v)]));
 if(typeof value==='string')return value.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi,'[REDACTED]').replace(/\bsk-[A-Za-z0-9_-]{12,}/g,'[REDACTED]').replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,'$1[REDACTED]@').replace(/([?&](?:key|token|api_key|signature|access_token)=)[^&#\s"]+/gi,'$1[REDACTED]');
 return value;
}
export function candidateNames(answer){
 const names=[];
 for(const line of String(answer||'').split('\n')){
  const m=line.match(/^\s*(?:\d+[.)]\s+)?\*\*([^*\n]{2,80})\*\*(?:\s*[:–—-]|\s*$)/)||line.match(/^\s*\d+[.)]\s+([\p{L}\p{N}][\p{L}\p{N} '&.-]{1,79})\s+[:–—-]\s+/u);
  const name=m?.[1]?.trim();
  if(name&&!/[<>{}:/]/.test(name)&&name.split(/\s+/).length<=6)names.push(name);
 }
 return [...new Set(names)];
}
async function dataset(db,projectId){
 const rows=(await exec(db,'SELECT e.payload,r.snapshot FROM mon_evidence e JOIN mon_runs r ON r.id=e.run_id WHERE r.project_id=? ORDER BY e.observed_at DESC,e.id',[projectId])).rows;
 return rows.map(r=>{
  const raw=JSON.parse(r.payload),snapshot=JSON.parse(r.snapshot),route=snapshot.routes?.find(r=>r.provider===raw.provider);
  return{raw:{...raw,route:route?.transport||'not_recorded'},snapshot};
 });
}
function brandInput(body){
 if(typeof body.name!=='string'||body.name.trim().length<2||body.name.length>100||/[<>\n]/.test(body.name)||!Array.isArray(body.aliases)||!Array.isArray(body.domains)||body.aliases.length>30||body.domains.length>20)fail(422,'VALIDATION_FAILED');
 if(body.aliases.some(a=>typeof a!=='string'||a.trim().length<2||a.length>100||/[<>\n]/.test(a)))fail(422,'VALIDATION_FAILED');
 const domains=body.domains.map(d=>String(d).trim().toLowerCase());
 if(domains.some(d=>!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)))fail(422,'VALIDATION_FAILED');
 const aliases=[...new Map(body.aliases.map(a=>[normalized(a),a.trim()])).values()];
 return {name:body.name.trim(),aliases,domains:[...new Set(domains)]};
}
function verifyUnique(brands,identity){
 const seen=new Set([identity.brandName,...identity.aliases,...identity.ownedDomains].map(normalized));
 for(const b of brands.filter(b=>b.status==='active')){
  const local=new Set([b.name,...b.aliases,...b.domains].map(normalized));
  for(const n of local){if(seen.has(n))fail(409,'DUPLICATE_BRAND');seen.add(n);}
 }
}
async function view(db,projectId,identity){
 const state=await cohortState(db,projectId),data=await dataset(db,projectId);
 const evidence=data.map(d=>extract(redact(d.raw),d.snapshot));
 const reviews=new Map((await exec(db,'SELECT id,payload FROM app_brand_reviews WHERE project_id=?',[projectId])).rows.map(r=>[r.id,JSON.parse(r.payload)]));
 const candidates=new Map();
 const known=new Set([identity.brandName,...identity.aliases,...state.competitors.filter(b=>b.status==='active').flatMap(b=>[b.name,...b.aliases])].map(normalized));
 if(await one(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='app_competitor_drafts'")){
  for(const r of (await exec(db,'SELECT id,payload FROM app_competitor_drafts WHERE project_id=?',[projectId])).rows){
   const draft=JSON.parse(r.payload);
   if(known.has(normalized(draft.name))&&!reviews.has(r.id))continue;
   candidates.set(r.id,{id:r.id,...draft,evidenceIds:[],status:'pending',brandId:null,...reviews.get(r.id)});
  }
 }
 for(const e of evidence.filter(e=>e.status==='success'))for(const name of candidateNames(e.answer)){
  const id=hash(normalized(name)).slice(0,32);
  if(known.has(normalized(name))&&!reviews.has(id))continue;
  if(!candidates.has(id))candidates.set(id,{id,name,evidenceIds:[],status:'pending',brandId:null,proposedDomains:[],source:'observed_answer',reviewRequired:true,...reviews.get(id)});
  candidates.get(id).evidenceIds.push(e.id);
 }
 const sourceMap=new Map();
 for(const e of evidence)for(const c of sourceUrls(e)){
  try{const u=new URL(typeof c==='string'?c:c.url);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)continue;u.hash='';
   const url=u.href,domain=u.hostname.toLowerCase();
   if(!sourceMap.has(url))sourceMap.set(url,{url,domain,answers:0,owned:identity.ownedDomains.some(d=>domain===d||domain.endsWith('.'+d)),evidenceIds:[]});
   const s=sourceMap.get(url);if(!s.evidenceIds.includes(e.id))s.evidenceIds.push(e.id);s.answers=s.evidenceIds.length;
  }catch{}
 }
 return {...state,candidates:[...candidates.values()],sources:[...sourceMap.values()].sort((a,b)=>b.answers-a.answers||a.url.localeCompare(b.url)),evidence};
}
export async function researchService({db,method,path,body,userId,now=Date.now,env=process.env,generate}){
 const projectId=path.split('/')[3],evidenceId=path.split('/')[5];
 const project=await one(db,'SELECT p.*,v.identity_json FROM app_projects p JOIN app_identity_versions v ON v.project_id=p.id AND v.version=p.version WHERE p.id=? AND p.owner_id=?',[projectId,userId]);
 if(!project)fail(404,'NOT_FOUND');
 try{if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)fail(503,'APP_NOT_CONFIGURED');}catch{fail(503,'APP_NOT_CONFIGURED');}
 const identity=JSON.parse(project.identity_json);
 if(method==='GET'&&evidenceId){
  const d=(await dataset(db,projectId)).find(d=>d.raw.id===evidenceId);if(!d)fail(404,'NOT_FOUND');
  return {status:200,data:{evidence:extract(redact(d.raw),d.snapshot),raw:redact(d.raw),rawAvailable:true}};
 }
 if(method==='POST'&&!evidenceId){
  if(project.status!=='active')fail(409,'VERSION_CONFLICT');
  if(body?.action==='suggest'){
   await suggestionsReady(db);
   const state=await cohortState(db,projectId);
   const exclude=state.competitors.filter(b=>b.status==='active').flatMap(b=>[b.name,...b.aliases,...b.domains]);
   const drafts=await workspaceSuggestions({db,project,identity,env,now,generate,type:'competitors',exclude});
   await transaction(db,async tx=>{
    const current=await one(tx,'SELECT version,status FROM app_projects WHERE id=? AND owner_id=?',[projectId,userId]);
    if(Number(current?.version)!==Number(project.version)||current?.status!=='active')fail(409,'VERSION_CONFLICT');
    for(const draft of drafts){
     const id=hash(normalized(draft.name)).slice(0,32);
     if(await one(tx,'SELECT id FROM app_brand_reviews WHERE project_id=? AND id=?',[projectId,id]))continue;
     await exec(tx,'INSERT INTO app_competitor_drafts VALUES (?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET payload=excluded.payload',[projectId,id,JSON.stringify({...draft,source:'project_context_ai',reviewRequired:true})]);
    }
   });
   return {status:200,data:await view(db,projectId,identity)};
  }
  await transaction(db,async tx=>{
   const state=await cohortState(tx,projectId);
   if(body?.expectedVersion!==state.version)fail(409,'VERSION_CONFLICT');
   let brands=state.competitors.map(b=>({...b})),candidate=null,brandId=null;
   if(['accept','dismiss','merge'].includes(body.action)){
    candidate=(await view(tx,projectId,identity)).candidates.find(c=>c.id===body.id&&c.status==='pending');if(!candidate)fail(409,'VERSION_CONFLICT');
    if(body.action!=='dismiss'&&candidate.source==='project_context_ai'&&
     (candidate.identityVersion!==Number(project.version)||!sameContext(candidate,identity)))fail(409,'CONTEXT_PROMPTS_REQUIRED');
   }
   if(['create','accept'].includes(body.action)){const b={...brandInput(body),id:uuid(),status:'active',version:1};brands.push(b);brandId=b.id;}
   else if(['update','archive'].includes(body.action)){
    const b=brands.find(b=>b.id===body.id);if(!b)fail(404,'NOT_FOUND');
    Object.assign(b,body.action==='archive'?{status:'archived'}:brandInput(body),{version:b.version+1});
   }else if(body.action==='merge'){
    const b=brands.find(b=>b.id===body.targetId&&b.status==='active');if(!b)fail(404,'NOT_FOUND');
    b.aliases=[...new Set([...b.aliases,candidate.name])];b.version++;brandId=b.id;
   }else if(body.action!=='dismiss')fail(422,'VALIDATION_FAILED');
   verifyUnique(brands,identity);
   await exec(tx,'INSERT INTO app_cohorts VALUES (?,?,?,?)',[projectId,state.version+1,JSON.stringify(brands),now()]);
   if(candidate)await exec(tx,'INSERT INTO app_brand_reviews VALUES (?,?,?)',[projectId,candidate.id,JSON.stringify({status:{accept:'accepted',dismiss:'dismissed',merge:'merged'}[body.action],brandId})]);
  });
 }else if(method!=='GET')fail(405,'METHOD_NOT_ALLOWED');
 return {status:200,data:await view(db,projectId,identity)};
}
