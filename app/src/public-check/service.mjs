import {randomUUID,randomBytes} from 'node:crypto';
import {CONFIG} from '../common/config.mjs';
import {publicProviders} from '../providers/routing.mjs';
import {validateProfile} from '../common/scan-profile.mjs';
import {measurementContext,contextCatalog} from '../common/measurement-context.mjs';
import {normalizeWebsite} from '../common/website-url.mjs';
import {assertPublicWebsite,scrapeWebsite,inferProfile} from '../website-profile/providers.mjs';
import {scanLimitError} from '../common/scan-limits.mjs';
import {one,exec,fail,transaction,hash,setting} from '../monitoring/shared.mjs';
import {id,checksum} from './migration.mjs';
import {digest,seal,unseal,secretReady} from './security.mjs';
import {PUBLIC_METHODOLOGY,publicPrompts} from './prompts.mjs';
import {authorizeGuest,scanReport} from './reports.mjs';
import {emailConfigured} from './email.mjs';
import {requestDelivery,deliveryStatus,openReport} from './delivery.mjs';
const result=data=>({status:200,data});
async function configured(db,env){
 if(env.PUBLIC_CHECK_ENABLED!=='true'||!secretReady(env)||!env.RATE_LIMIT_SECRET||!db)return false;
 try{return (await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum===checksum;}catch{return false;}
}
async function limits(db,fingerprint,domain,env,now){
 const recent=await one(db,'SELECT COUNT(*) n FROM rate_events WHERE fingerprint=? AND requested_at>?',[fingerprint,now()-86400000]);
 const weekly=await one(db,'SELECT COUNT(*) n FROM rate_events WHERE domain=? AND requested_at>?',[domain,now()-7*86400000]);
 const error=scanLimitError({recentCount:recent.n,weeklyCount:weekly.n,authenticated:false},env);
 if(error)fail(429,error.code);
}
async function cachedDraft({db,fingerprint,kind,input,env,now,produce}){
 const key=hash([fingerprint,kind,input,PUBLIC_METHODOLOGY]),old=await one(db,'SELECT * FROM public_check_drafts WHERE id=?',[key]);
 if(old?.status==='complete'&&now()-Number(old.created_at)<6*3600000)return JSON.parse(old.payload);
 const reserved=await transaction(db,async tx=>{
  const saved=await one(tx,'SELECT * FROM public_check_drafts WHERE id=?',[key]);
  if(saved&&now()-Number(saved.created_at)<6*3600000){
   if(saved.status==='complete')return JSON.parse(saved.payload);
   fail(409,saved.status==='running'&&now()-Number(saved.created_at)<90000?'GENERATION_PENDING':'AI_UNAVAILABLE');
  }
  if(kind!=='questions'){
   const hour=await one(tx,"SELECT COUNT(*) n FROM public_check_drafts WHERE fingerprint=? AND kind IN ('identity','questions-ai') AND created_at>?",[fingerprint,now()-3600000]);
   const total=await one(tx,"SELECT COUNT(*) n FROM public_check_drafts WHERE kind IN ('identity','questions-ai') AND created_at>?",[now()-86400000]);
   if(Number(hour.n)>=setting(env,'PUBLIC_CHECK_PREPARATIONS_PER_HOUR',6,1,100)||Number(total.n)>=setting(env,'PUBLIC_CHECK_MAX_DAILY_PREPARATIONS',100,1,10000))fail(429,'PREPARATION_RATE_LIMIT');
  }
  await exec(tx,"INSERT INTO public_check_drafts VALUES (?,?,?,'running',NULL,?) ON CONFLICT(id) DO UPDATE SET status='running',payload=NULL,created_at=excluded.created_at",[key,fingerprint,kind,now()]);
  return null;
 });
 if(reserved)return reserved;
 try{
  const value=await produce();
  await exec(db,"UPDATE public_check_drafts SET status='complete',payload=? WHERE id=?",[JSON.stringify(value),key]);
  return value;
 }catch(error){await exec(db,"UPDATE public_check_drafts SET status='failed' WHERE id=?",[key]);throw error;}
}
function previewKey(profile,config){return hash([profile,config.enabledProviders,config.scanPrompts,PUBLIC_METHODOLOGY]);}
function previewKind(profile){return profile.language==='en'||profile.market==='FI'&&profile.language==='fi'?'questions':'questions-ai';}
export async function publicCheckService({db,method,path,body={},fingerprint,scanToken,env=process.env,now=Date.now,config=CONFIG,deps={}}){
 config={...config,enabledProviders:publicProviders(config)};
 const ready=await configured(db,env);
 if(method==='GET'&&path==='/v1/public-check/capabilities')return result({
  enabled:ready,emailEnabled:ready&&emailConfigured(env),marketingEnabled:ready&&emailConfigured(env)&&Boolean(env.RESEND_MARKETING_SEGMENT_ID),
  autofillEnabled:ready&&env.WEBSITE_PROFILE_ENABLED==='true'&&Boolean(env.FIRECRAWL_API_KEY&&env.OPENAI_API_KEY),
  providers:config.enabledProviders,promptCount:config.scanPrompts,...contextCatalog(),limits:{guestScansPerDay:1,domainScansPerWeek:5}
 });
 if(!ready)fail(503,'APP_NOT_CONFIGURED');
 if(!/^[a-f0-9]{64}$/.test(fingerprint||''))fail(403,'PROXY_REQUIRED');
 const validate=deps.validateWebsite||assertPublicWebsite;
 if(method==='POST'&&path==='/v1/public-check/prepare'){
  if(env.WEBSITE_PROFILE_ENABLED!=='true'||!env.FIRECRAWL_API_KEY||!env.OPENAI_API_KEY)fail(503,'AI_UNAVAILABLE');
  const site=normalizeWebsite(body.website),context=measurementContext(body);
  await validate(site.website);
  await limits(db,fingerprint,site.domain,env,now);
  return result(await cachedDraft({db,fingerprint,kind:'identity',input:{...site,...context},env,now,produce:async()=>{
   const content=await (deps.scrape||scrapeWebsite)({...site,...context},{env});
   const inferred=await (deps.infer||inferProfile)({...site,...context},content,{env});
   return {draft:{domain:site.domain,brand_name:inferred.draft.brandName,aliases:inferred.draft.aliases,category_fi:inferred.draft.categoryFi,...context},
    sources:inferred.sources.map(url=>({url})),model:inferred.model||null};
  }}));
 }
 if(method==='POST'&&path==='/v1/public-check/preview'){
  const site=normalizeWebsite(body.domain),profile=validateProfile({...body,domain:site.domain});
  await validate(site.website);
  await limits(db,fingerprint,profile.domain,env,now);
  const key=previewKey(profile,config);
  return result(await cachedDraft({db,fingerprint,kind:previewKind(profile),input:{profile,key},env,now,produce:async()=>({
   profile,...await publicPrompts(profile,config.scanPrompts,env,deps.generate),providers:config.enabledProviders,methodology:PUBLIC_METHODOLOGY,preview_hash:key
  })}));
 }
 if(method==='POST'&&path==='/v1/public-check/scans'){
  const profile=validateProfile(body),key=previewKey(profile,config);
  if(body.profile_confirmed!==true||body.methodology!==PUBLIC_METHODOLOGY||body.preview_hash!==key)fail(422,'CONFIRMATION_REQUIRED');
  if(typeof body.submission_id!=='string'||!/^[a-f0-9-]{36}$/i.test(body.submission_id))fail(422,'SUBMISSION_INVALID');
  await validate(normalizeWebsite(body.domain).website);
  const draftKey=hash([fingerprint,previewKind(profile),{profile,key},PUBLIC_METHODOLOGY]);
  const draft=await one(db,'SELECT * FROM public_check_drafts WHERE id=?',[draftKey]);
  if(!draft||draft.status!=='complete'||now()-Number(draft.created_at)>=6*3600000)fail(409,'PREVIEW_EXPIRED');
  const preview=JSON.parse(draft.payload),inputHash=hash([profile,preview.prompts,config.enabledProviders,PUBLIC_METHODOLOGY]);
  const queued=await transaction(db,async tx=>{
   const prior=await one(tx,'SELECT * FROM public_check_scans WHERE fingerprint=? AND submission_id=?',[fingerprint,body.submission_id]);
   if(prior){if(prior.input_hash!==inputHash)fail(409,'SUBMISSION_CONFLICT');return {id:prior.scan_id,status:'queued',scan_token:unseal(prior.guest_token_cipher,env)};}
   const duplicate=await one(tx,'SELECT p.* FROM public_check_scans p JOIN scan_jobs j ON j.id=p.scan_id WHERE p.fingerprint=? AND p.input_hash=? AND j.requested_at>? ORDER BY j.requested_at DESC LIMIT 1',[fingerprint,inputHash,now()-86400000]);
   if(duplicate)return {id:duplicate.scan_id,status:'queued',scan_token:unseal(duplicate.guest_token_cipher,env)};
   await limits(tx,fingerprint,profile.domain,env,now);
   const scanId=randomUUID(),token=randomBytes(32).toString('base64url');
   const snapshot={...profile,providers:config.enabledProviders,prompt_count:preview.prompts.length,methodology:PUBLIC_METHODOLOGY,confirmed_at:now()};
   await exec(tx,'INSERT INTO scan_jobs (id,domain,brand_name,guest_token_hash,status,requested_at,industry,location) VALUES (?,?,?,?,?,?,?,?)',[scanId,profile.domain,profile.brand_name,digest(token),'queued',now(),profile.category_fi,profile.market]);
   await exec(tx,'INSERT INTO scan_profiles VALUES (?,?,?)',[scanId,JSON.stringify(snapshot),now()]);
   for(let i=0;i<preview.prompts.length;i++)await exec(tx,'INSERT INTO scan_prompts (id,scan_id,sequence,prompt_text,prompt_version,intent) VALUES (?,?,?,?,?,?)',[randomUUID(),scanId,i+1,preview.prompts[i],PUBLIC_METHODOLOGY,'discovery']);
   await exec(tx,'INSERT INTO public_check_scans VALUES (?,?,?,?,?,NULL)',[scanId,fingerprint,body.submission_id,inputHash,seal(token,env)]);
   await exec(tx,'INSERT INTO rate_events VALUES (?,?,?,?)',[randomUUID(),fingerprint,profile.domain,now()]);
   return {id:scanId,status:'queued',scan_token:token};
  });
  return {status:202,data:queued};
 }
 const scan=path.match(/^\/v1\/public-check\/scans\/([a-f0-9-]{36})$/);
 if(method==='GET'&&scan)return result(await scanReport(db,await authorizeGuest(db,scan[1],scanToken)));
 const email=path.match(/^\/v1\/public-check\/scans\/([a-f0-9-]{36})\/email$/);
 if(method==='POST'&&email)return result(await requestDelivery({db,scanId:email[1],scanToken,body,env,now,deps}));
 const delivery=path.match(/^\/v1\/public-check\/deliveries\/([a-f0-9-]{36})$/);
 if(method==='GET'&&delivery)return result(await deliveryStatus(db,delivery[1],scanToken,now));
 // Bearer report tokens never enter Bunny/CDN request paths or query strings.
 if(method==='POST'&&path==='/v1/public-check/reports/open')return result(await openReport(db,body.token,now));
 fail(404,'NOT_FOUND');
}
