import {one,exec,transaction} from '../monitoring/shared.mjs';
import {assertPublicWebsite,scrapeWebsite,inferProfile} from './providers.mjs';
import {measurementContext} from '../common/measurement-context.mjs';
/** One bounded attempt. Expired leases fail rather than silently duplicating paid calls. */
export async function tickWebsiteProfiles(db,{env=process.env,now=Date.now,validate=assertPublicWebsite,scrape=scrapeWebsite,infer=inferProfile}={}){
 if(env.WEBSITE_PROFILE_ENABLED!=='true')return;
 const job=await transaction(db,async tx=>{
  await exec(tx,"UPDATE app_website_profiles SET status='failed',error='WEBSITE_PROFILE_FAILED' WHERE (status='running' AND lease_until<?) OR (status='queued' AND created_at<?)",[now(),now()-15*60000]);
  const row=await one(tx,"SELECT * FROM app_website_profiles WHERE status='queued' ORDER BY created_at,id LIMIT 1");if(!row)return null;
  await exec(tx,"UPDATE app_website_profiles SET status='running',lease_until=? WHERE id=?",[now()+120000,row.id]);return row;
 });
 if(!job)return;
 try{
  const context=measurementContext(JSON.parse(job.payload||'{}'));
  const site={...await validate(job.website),...context};if(site.domain!==job.domain)throw Error('INVALID_WEBSITE');
  const content=await scrape(site,{env}),result=await infer(site,content,{env});
  const data={...result,market:context.market,promptLanguage:context.language,draft:{...result.draft,market:context.market,promptLanguage:context.language}};
  await exec(db,"UPDATE app_website_profiles SET status='completed',payload=?,lease_until=NULL WHERE id=? AND status='running'",[JSON.stringify(data),job.id]);
 }catch(e){const code=['INVALID_WEBSITE','WEBSITE_UNAVAILABLE','AI_UNAVAILABLE','WEBSITE_PROFILE_DISABLED'].includes(e.message)?e.message:'WEBSITE_PROFILE_FAILED';await exec(db,"UPDATE app_website_profiles SET status='failed',error=?,lease_until=NULL WHERE id=? AND status='running'",[code,job.id]);}
}
