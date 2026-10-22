import { createHash } from 'node:crypto';
import { CONFIG } from '../common/config.mjs';
import { uuid, hmac } from '../common/utils.mjs';
import { validateProfile, METHODOLOGY, buildScanReport } from '../common/scan-profile.mjs';
import { scanLimitError } from '../common/scan-limits.mjs';
import { scanMigrationId, scanChecksum } from './scan-migration.mjs';
import {sameContext,measurementContext} from '../common/measurement-context.mjs';
const fail = (status, code) => {throw Object.assign(new Error(code),{status,code});};
const one = async (db,sql,args=[]) => (await db.execute({sql,args})).rows[0];
const accepted = r => ({id:r.scan_id,status:r.status,domain:r.domain,project_id:r.project_id,project_version:Number(r.project_version),submission_id:r.submission_id,created_at:Number(r.created_at)});
const join = 'SELECT l.*,j.status,j.domain,j.owner_id AS job_owner FROM app_project_scans l JOIN scan_jobs j ON j.id=l.scan_id';

// Enqueues the same immutable scan_jobs/scan_profiles consumed by the existing worker.
// No provider transport exists in this module; preview and submission make zero model calls.
export async function appScans({db,method,path,body,userId,now=Date.now,env=process.env,config=CONFIG}) {
 try {if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[scanMigrationId]))?.checksum!==scanChecksum) fail(503,'APP_NOT_CONFIGURED');}
 catch {fail(503,'APP_NOT_CONFIGURED');}
 const list = path.match(/^\/v1\/projects\/([a-zA-Z0-9-]{1,80})\/scans$/);
 if(method==='GET' && list) {
  if(!await one(db,'SELECT id FROM app_projects WHERE id=? AND owner_id=?',[list[1],userId])) fail(404,'NOT_FOUND');
  return {status:200,data:(await db.execute({sql:`${join} WHERE l.project_id=? AND l.owner_id=? AND j.owner_id=? ORDER BY l.created_at DESC,l.scan_id`,args:[list[1],userId,userId]})).rows.map(accepted)};
 }
 const report = path.match(/^\/v1\/scans\/([a-zA-Z0-9-]{1,80})$/);
 if(method==='GET' && report) {
  const linked=await one(db,`${join} WHERE l.scan_id=? AND l.owner_id=? AND j.owner_id=?`,[report[1],userId,userId]);
  if(!linked) fail(404,'NOT_FOUND');
  const saved=await one(db,'SELECT profile_json FROM scan_profiles WHERE scan_id=?',[report[1]]);
  const profile=saved?JSON.parse(saved.profile_json):null;
  const prompts=(await db.execute({sql:'SELECT id,sequence,prompt_text,prompt_version FROM scan_prompts WHERE scan_id=? ORDER BY sequence',args:[report[1]]})).rows;
  const observations=(await db.execute({sql:'SELECT prompt_id,provider,provider_status,model,answer_text,citations_json,own_domain_cited,brand_mentioned,observed_at FROM observations WHERE scan_id=? ORDER BY provider,observed_at',args:[report[1]]})).rows.map(r=>({...r,citations:JSON.parse(r.citations_json||'[]'),citations_json:undefined}));
  return {status:200,data:{...accepted(linked),profile,prompts,observations,...buildScanReport({profile,observations,promptCount:profile?.prompt_count||prompts.length,status:linked.status,legacyProviders:config.enabledProviders})}};
 }
 if(method!=='POST'||!['/v1/scans/preview','/v1/scans'].includes(path)) fail(404,'NOT_FOUND');
 if(!body||typeof body.project_id!=='string'||!Number.isSafeInteger(body.project_version)) fail(422,'PROFILE_INVALID');
 const previewing=path.endsWith('/preview');
 const profile=validateProfile(body);
 const ownerProject=await one(db,'SELECT v.identity_json FROM app_projects p JOIN app_identity_versions v ON v.project_id=p.id AND v.version=p.version WHERE p.id=? AND p.owner_id=?',[body.project_id,userId]);
 if(!ownerProject)fail(404,'NOT_FOUND');
 if(!sameContext(JSON.parse(ownerProject.identity_json),profile))fail(409,'VERSION_CONFLICT');
 // A one-off first measurement must use the exact same user-owned prompt set
 // as future monitoring. Never fall back to product-generated prompt text.
 const prompts=(await db.execute({sql:"SELECT v.payload FROM mon_prompts p JOIN mon_prompt_versions v ON v.prompt_id=p.id AND v.version=p.version WHERE p.project_id=? AND p.status='active' ORDER BY p.id",args:[body.project_id]})).rows
  .map(r=>JSON.parse(r.payload))
  .filter(p=>p.kind==='neutral'&&sameContext(p,profile))
  .map(p=>p.text);
 if(!prompts.length)fail(422,'CONTEXT_PROMPTS_REQUIRED');
 const providers=[...new Set(config.enabledProviders)];
 if(!providers.length || providers.some(p=>!['openai','claude','gemini','grok','perplexity','google_aio'].includes(p))) fail(503,'PROVIDERS_UNAVAILABLE');
 const hash=createHash('sha256').update(JSON.stringify({profile,prompts,providers,methodology:METHODOLOGY,project_id:body.project_id,project_version:body.project_version})).digest('hex');
 const validateProject=async tx=>{
  const p=await one(tx,'SELECT p.*,v.identity_json FROM app_projects p JOIN app_identity_versions v ON v.project_id=p.id AND v.version=p.version WHERE p.id=? AND p.owner_id=?',[body.project_id,userId]);
  if(!p) fail(404,'NOT_FOUND');
  if(p.status!=='active'||Number(p.version)!==body.project_version) fail(409,'VERSION_CONFLICT');
  const identity=JSON.parse(p.identity_json);
  if(!sameContext(identity,profile))fail(409,'VERSION_CONFLICT');
  if(!identity.ownedDomains.map(d=>d.replace(/^www\./,'')).includes(profile.domain)) fail(422,'PROFILE_INVALID');
 };
 if(previewing) {
  await validateProject(db);
  return {status:200,data:{profile:{...profile,project_id:body.project_id,project_version:body.project_version},prompts,providers,methodology:METHODOLOGY,paid_calls:0,preview_hash:hash}};
 }
 if(body.profile_confirmed!==true||body.methodology!==METHODOLOGY) fail(422,'PROFILE_CONFIRMATION_REQUIRED');
 if(body.preview_hash!==hash) fail(409,'PREVIEW_CHANGED');
 if(typeof body.submission_id!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(body.submission_id)) fail(422,'PROFILE_INVALID');
 if(!env.RATE_LIMIT_SECRET||env.RATE_LIMIT_SECRET.length<24) fail(503,'APP_NOT_CONFIGURED');
 const tx=await db.transaction('write');
 try {
  // Durable correlation also deduplicates a deliberately repeated identical request.
  const previous=await one(tx,`${join} WHERE l.owner_id=? AND l.submission_id=?`,[userId,body.submission_id]);
  if(previous) {
   if(previous.preview_hash!==hash||previous.job_owner!==userId) fail(409,'SUBMISSION_CONFLICT');
   await tx.commit();return {status:202,data:accepted(previous)};
  }
  await validateProject(tx);
  const stamp=now(), fingerprint=hmac(`app-user:${userId}`,env.RATE_LIMIT_SECRET);
  const recent=await one(tx,'SELECT COUNT(*) AS count FROM rate_events WHERE fingerprint=? AND requested_at>?',[fingerprint,stamp-86400000]);
  const weekly=await one(tx,'SELECT COUNT(*) AS count FROM rate_events WHERE domain=? AND requested_at>?',[profile.domain,stamp-7*86400000]);
  const limitError=scanLimitError({recentCount:recent?.count,weeklyCount:weekly?.count,authenticated:true,dashboardScan:true},env);
  if(limitError)fail(429,limitError.code);
  const id=uuid(), snapshot={...profile,providers,prompt_count:prompts.length,methodology:METHODOLOGY,confirmed_at:stamp};
  await tx.execute({sql:'INSERT INTO scan_jobs (id,domain,brand_name,owner_id,guest_token_hash,status,requested_at) VALUES (?,?,?,?,?,?,?)',args:[id,profile.domain,profile.brand_name,userId,null,'queued',stamp]});
  await tx.execute({sql:'INSERT INTO scan_profiles VALUES (?,?,?)',args:[id,JSON.stringify(snapshot),stamp]});
  // Persist the actual confirmed wording before the worker can claim the job.
  // Existing worker consumes stored prompts without regenerating templates.
  for (const [index, text] of prompts.entries()) await tx.execute({
   sql:'INSERT INTO scan_prompts (id,scan_id,sequence,prompt_text,prompt_version) VALUES (?,?,?,?,?)',
   args:[uuid(),id,index+1,text,METHODOLOGY],
  });
  await tx.execute({sql:'INSERT INTO app_project_scans VALUES (?,?,?,?,?,?,?)',args:[id,body.project_id,body.project_version,userId,body.submission_id,hash,stamp]});
  await tx.execute({sql:'INSERT INTO rate_events VALUES (?,?,?,?)',args:[uuid(),fingerprint,profile.domain,stamp]});
  await tx.commit();
  return {status:202,data:{id,status:'queued',domain:profile.domain,project_id:body.project_id,project_version:body.project_version,submission_id:body.submission_id,created_at:stamp}};
 } catch(e) {await tx.rollback();throw e;} finally {tx.close();}
}
