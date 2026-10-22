import {one,exec,fail,transaction} from '../monitoring/shared.mjs';
import {uuid} from '../common/utils.mjs';
import {normalizeWebsite} from '../common/website-url.mjs';
import {id,checksum} from './migration.mjs';
import {measurementContext,sameContext} from '../common/measurement-context.mjs';
export const profileJob=r=>({id:r.id,status:r.status,website:r.website,domain:r.domain,createdAt:Number(r.created_at),market:'FI',promptLanguage:'fi',...(r.payload?JSON.parse(r.payload):{}),...(r.error?{error:r.error}:{})});
export async function websiteProfileService({db,method,path,body,userId,env=process.env,now=Date.now}){
 let ready=false;try{ready=(await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum===checksum;}catch{}
 const enabled=ready&&env.WEBSITE_PROFILE_ENABLED==='true';
 if(method==='GET'&&path.endsWith('/capabilities'))return{status:200,data:{enabled}};
 if(!ready)fail(503,'WEBSITE_PROFILE_DISABLED');
 if(method==='GET'){const r=await one(db,'SELECT * FROM app_website_profiles WHERE id=? AND owner_id=?',[path.split('/')[3],userId]);if(!r)fail(404,'NOT_FOUND');return{status:200,data:profileJob(r)};}
 if(method!=='POST'||path!=='/v1/website-profiles')fail(405,'METHOD_NOT_ALLOWED');
 if(!enabled)fail(503,'WEBSITE_PROFILE_DISABLED');
 const context=measurementContext(body),payload=JSON.stringify({market:context.market,promptLanguage:context.language});
 let site;try{site=normalizeWebsite(body?.website);}catch{fail(422,'INVALID_WEBSITE');}
 if(typeof body?.submissionId!=='string'||!/^[a-f0-9-]{36}$/i.test(body.submissionId))fail(422,'VALIDATION_FAILED');
 return transaction(db,async tx=>{
  const old=await one(tx,'SELECT * FROM app_website_profiles WHERE owner_id=? AND submission_id=?',[userId,body.submissionId]);
  if(old){if(old.domain!==site.domain||!sameContext(profileJob(old),context))fail(409,'VERSION_CONFLICT');return{status:202,data:profileJob(old)};}
  const count=await one(tx,'SELECT COUNT(*) n FROM app_website_profiles WHERE owner_id=? AND created_at>?',[userId,now()-86400000]);
  const global=await one(tx,'SELECT COUNT(*) n FROM app_website_profiles WHERE created_at>?',[now()-86400000]);
  const pending=await one(tx,"SELECT COUNT(*) n FROM app_website_profiles WHERE owner_id=? AND status IN ('queued','running')",[userId]);
  if(Number(count.n)>=10||Number(global.n)>=100||Number(pending.n)>=2)fail(429,'RATE_LIMITED');
  const r={id:uuid(),owner_id:userId,submission_id:body.submissionId,...site,status:'queued',created_at:now(),payload};
  await exec(tx,'INSERT INTO app_website_profiles (id,owner_id,submission_id,website,domain,status,created_at,payload) VALUES (?,?,?,?,?,?,?,?)',[r.id,userId,body.submissionId,site.website,site.domain,r.status,r.created_at,payload]);
  return{status:202,data:profileJob(r)};
 });
}
