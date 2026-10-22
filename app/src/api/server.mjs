import http from 'node:http';
import { appRoute, isAppPath } from '../app/http.mjs';
import {publicCheckHttp} from '../public-check/http.mjs';
import { CONFIG, hasDbConfig, providerAvailable } from '../common/config.mjs';
import {publicProviders} from '../providers/routing.mjs';
import { scanLimitError } from '../common/scan-limits.mjs';
import { sql, one, getDb } from '../common/db.mjs';
import { migrate,scanProfileDDL } from '../migrate.mjs';
import { randomToken, hashToken, hmac, uuid, toHostname, parseCookie, isAllowedOrigin, errorMessage, sanitizeText, eqString } from '../common/utils.mjs';
import { createOauthRequest, exchangeGoogleCode, verifyGoogleIdToken } from '../common/google.mjs';

import {validateProfile,confirmedPrompts,buildScanReport,METHODOLOGY} from '../common/scan-profile.mjs';
// Explicit, additive release migration, including when an existing command starts this file directly.
if(process.env.AIRANK_RUN_SENTIMENT_MIGRATION==='true'){const {migrateSentiment}=await import('../sentiment/migration.mjs');await migrateSentiment(await getDb());console.log('AI Rank sentiment migration verified.');}
const started=Date.now();let schemaReady=false;
const json=(res,status,obj)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY'});res.end(JSON.stringify(obj))};
const getSession=async req=>{
 const token=parseCookie(req.headers.cookie||'')[CONFIG.cookieName];if(!token)return null;
 const r=await one('SELECT s.user_id,u.email,u.display_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.session_hash=? AND s.expires_at>?',[hashToken(token),Date.now()]);return r||null;
};
const setCookie=(res,name,value,seconds,opts='')=>{res.setHeader('Set-Cookie',`${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${seconds}; HttpOnly; SameSite=Lax${CONFIG.cookieSecure?'; Secure':''}${opts}`)};
const validReturnTo=(input)=>{let s=typeof input==='string'?input:'/fi/dashboard';if(!/^\/(fi|en)\/(dashboard|start|settings)(?:[/?#]|$)/.test(s)||s.startsWith('//'))return '/fi/dashboard';return s.slice(0,350)};
const oauthConfigured=()=>!!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
const websiteOrigin=new URL(CONFIG.webUrl).origin;
async function readBody(req,max=3000){return await new Promise((resolve,reject)=>{let bufs=[],length=0;req.on('data',b=>{length+=b.length;if(length>max){reject(Object.assign(new Error('Payload too large'),{status:413}));req.destroy();return;}bufs.push(b)});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(bufs).toString('utf8')||'{}'))}catch{reject(Object.assign(new Error('Invalid JSON body'),{status:400}))}});req.on('error',reject)})}
function rateFingerprint(req){const ip=process.env.TRUST_PROXY_CLIENT_IP==='true'?String(req.headers['x-forwarded-for']||'').split(',')[0].trim():(req.socket.remoteAddress||'unknown');return hmac(ip,process.env.RATE_LIMIT_SECRET);}
async function ensureSchema(){if(!hasDbConfig())return;try{if(process.env.AUTO_MIGRATE==='true')await migrate();else await sql('SELECT id FROM users LIMIT 1');await sql(scanProfileDDL);schemaReady=true;console.log('Bunny DB connected');}catch(e){console.warn('Bunny DB setup:',errorMessage(e))}}
async function route(req,res){
 const method=req.method||'GET';const url=new URL(req.url||'/', 'http://localhost');const pathname=url.pathname;const origin=req.headers.origin;
 if(origin && isAllowedOrigin(origin,CONFIG.allowedOrigins)){
  res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Scan-Token');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
 }
 res.setHeader('Cache-Control','no-store');
 if(pathname.startsWith('/v1/public-check/'))return publicCheckHttp(req,res);
 if(isAppPath(pathname) || (req.headers['x-airank-client'] && /^\/v1\/scans(?:\/|$)/.test(pathname)))return appRoute(req,res,url);
 if(method==='OPTIONS'){res.writeHead(origin&&!isAllowedOrigin(origin,CONFIG.allowedOrigins)?403:204);res.end();return}
 if(method==='GET' && pathname==='/healthz'){return json(res,200,{ok:true,service:'airank-api',version:CONFIG.version,revision:process.env.AIRANK_BUILD_REVISION||null,uptime_seconds:Math.floor((Date.now()-started)/1000),environment:CONFIG.appEnv})}
 if(method==='GET' && pathname==='/readyz'){
  if(!hasDbConfig()||!schemaReady)return json(res,503,{ready:false,reason:'database_not_linked'});
  try{await sql('SELECT id FROM users LIMIT 1');return json(res,200,{ready:true})}catch(e){return json(res,503,{ready:false,reason:'database_unavailable'})}
 }
 if(method==='GET' && pathname==='/v1/status'){return json(res,200,{service:'airank-api',version:CONFIG.version,database:hasDbConfig()?'configured':'not_configured',oauth:oauthConfigured()?'configured':'not_configured',providers:Object.fromEntries(CONFIG.enabledProviders.map(p=>[p,'worker_managed'])),enabled_providers:CONFIG.enabledProviders,provider_readiness:'unknown_until_measurement',capabilities:{confirmed_profiles:true,prompt_preview:true,visibility_score:true},methodology:METHODOLOGY,reporting:'evidence_based'})}
 if(method==='GET' && pathname==='/v1/openapi.json'){return json(res,200,{openapi:'3.0.3',info:{title:'AI Rank API',version:CONFIG.version},paths:{'/healthz':{get:{}},'/readyz':{get:{}},'/v1/status':{get:{}},'/v1/auth/google/start':{get:{}},'/v1/auth/google/callback':{get:{}},'/v1/auth/session':{get:{}},'/v1/auth/logout':{post:{}},'/v1/scans/preview':{post:{}},'/v1/scans':{post:{}},'/v1/scans/{id}':{get:{}}}})}
 if(!hasDbConfig())return json(res,503,{error:'Bunny Database is not linked yet',code:'DB_NOT_CONFIGURED'});
 if(method==='GET' && pathname==='/v1/auth/google/start'){
  if(!oauthConfigured())return json(res,503,{error:'Google OAuth not configured',code:'GOOGLE_NOT_CONFIGURED'});
  const state=randomToken(), verifier=randomToken(48),nonce=randomToken();const callback=process.env.GOOGLE_REDIRECT_URI;
  await sql('INSERT INTO oauth_states (state_hash,code_verifier,nonce,return_to,expires_at) VALUES (?,?,?,?,?)',[hashToken(state),verifier,nonce,validReturnTo(url.searchParams.get('return_to')),Date.now()+600000]);
  setCookie(res,'airank_oauth_state',state,600);
  res.writeHead(302,{Location:createOauthRequest({clientId:process.env.GOOGLE_CLIENT_ID,redirectUri:callback,nonce,state,verifier}),'cache-control':'no-store'});res.end();return;
 }
 if(method==='GET' && pathname==='/v1/auth/google/callback'){
  const state=url.searchParams.get('state')||'', code=url.searchParams.get('code')||'';
  const stateCookie=parseCookie(req.headers.cookie||'').airank_oauth_state||'';
  if(!state || !code || !eqString(stateCookie,state))return json(res,400,{error:'Invalid OAuth state or missing code'});
  const saved=await one('SELECT * FROM oauth_states WHERE state_hash=? AND expires_at>?',[hashToken(state),Date.now()]);
  if(!saved)return json(res,400,{error:'Expired or unrecognised OAuth state'});
  await sql('DELETE FROM oauth_states WHERE state_hash=?',[hashToken(state)]);
  const token=await exchangeGoogleCode({code,codeVerifier:saved.code_verifier,clientId:process.env.GOOGLE_CLIENT_ID,clientSecret:process.env.GOOGLE_CLIENT_SECRET,redirectUri:process.env.GOOGLE_REDIRECT_URI});
  const user=await verifyGoogleIdToken(token,{clientId:process.env.GOOGLE_CLIENT_ID,nonce:saved.nonce});
  let record=await one('SELECT id FROM users WHERE google_sub=?',[user.googleSub]);const userId=record?.id||uuid();
  if(record){await sql('UPDATE users SET email=?,display_name=?,picture_url=?,updated_at=? WHERE id=?',[user.email,user.name,user.picture,Date.now(),userId])}
  else{await sql('INSERT INTO users (id,google_sub,email,display_name,picture_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',[userId,user.googleSub,user.email,user.name,user.picture,Date.now(),Date.now()])}
  const session=randomToken();await sql('INSERT INTO sessions (session_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)',[hashToken(session),userId,Date.now(),Date.now()+CONFIG.sessionDays*86400000]);
  setCookie(res,CONFIG.cookieName,session,CONFIG.sessionDays*86400);
  res.writeHead(302,{Location:CONFIG.appUrl+validReturnTo(saved.return_to),'cache-control':'no-store'});res.end();return;
 }
 if(method==='GET' && pathname==='/v1/auth/session'){
  const session=await getSession(req);return session?json(res,200,{authenticated:true,user:{id:session.user_id,email:session.email,name:session.display_name}}):json(res,200,{authenticated:false,user:null});
 }
 if(method==='POST' && pathname==='/v1/auth/logout'){
  if(origin && !isAllowedOrigin(origin,CONFIG.allowedOrigins))return json(res,403,{error:'Origin not permitted'});
  const cookie=parseCookie(req.headers.cookie||'')[CONFIG.cookieName];if(cookie)await sql('DELETE FROM sessions WHERE session_hash=?',[hashToken(cookie)]);
  setCookie(res,CONFIG.cookieName,'',0);return json(res,200,{ok:true});
 }
 if(method==='POST' && pathname==='/v1/scans/preview'){
  if(origin && !isAllowedOrigin(origin,CONFIG.allowedOrigins))return json(res,403,{error:'Origin not permitted'});
  if(!String(req.headers['content-type']||'').startsWith('application/json'))return json(res,415,{error:'Content-Type must be application/json'});
  const profile=validateProfile(await readBody(req));
  return json(res,200,{profile,prompts:confirmedPrompts(profile,CONFIG.scanPrompts),providers:publicProviders(CONFIG),methodology:METHODOLOGY,paid_calls:0});
 }
 if(method==='POST' && pathname==='/v1/scans'){
  if(!schemaReady)return json(res,503,{error:'Database schema is not ready',code:'SCHEMA_NOT_READY'});
  if(origin && !isAllowedOrigin(origin,CONFIG.allowedOrigins))return json(res,403,{error:'Origin not permitted'});
  if(!String(req.headers['content-type']||'').startsWith('application/json'))return json(res,415,{error:'Content-Type must be application/json'});
  if(!process.env.RATE_LIMIT_SECRET || process.env.RATE_LIMIT_SECRET.length<24)return json(res,503,{error:'RATE_LIMIT_SECRET must be configured before public scans'});
  const body=await readBody(req);
  if(body.profile_confirmed!==true||body.methodology!==METHODOLOGY)return json(res,422,{error:'Confirm your brand, category and question preview before scanning',code:'PROFILE_CONFIRMATION_REQUIRED'});
  const profile=validateProfile(body),domain=profile.domain,brand=profile.brand_name;
  const snapshot={...profile,providers:publicProviders(CONFIG),prompt_count:CONFIG.scanPrompts,methodology:METHODOLOGY,confirmed_at:Date.now()};
  const session=await getSession(req);
  const fingerprint=rateFingerprint(req), cutoff24=Date.now()-86400000,cutoff7=Date.now()-7*86400000;
  const recent=await one('SELECT COUNT(*) AS count FROM rate_events WHERE fingerprint=? AND requested_at>?',[fingerprint,cutoff24]);
  const weekly=await one('SELECT COUNT(*) AS count FROM rate_events WHERE domain=? AND requested_at>?',[domain,cutoff7]);
  const limitError=scanLimitError({recentCount:recent?.count,weeklyCount:weekly?.count,authenticated:!!session});
  if(limitError)return json(res,429,limitError);
  const id=uuid(), guestToken=session?null:randomToken();
  const db=await getDb();await db.batch([
   {sql:'INSERT INTO scan_jobs (id,domain,brand_name,owner_id,guest_token_hash,status,requested_at) VALUES (?,?,?,?,?,?,?)',args:[id,domain,brand,session?.user_id||null,guestToken?hashToken(guestToken):null,'queued',Date.now()]},
   {sql:'INSERT INTO scan_profiles (scan_id,profile_json,created_at) VALUES (?,?,?)',args:[id,JSON.stringify(snapshot),Date.now()]},
   {sql:'INSERT INTO rate_events (id,fingerprint,domain,requested_at) VALUES (?,?,?,?)',args:[uuid(),fingerprint,domain,Date.now()]}
  ],'write');
  return json(res,202,{id,status:'queued',domain,scan_token:guestToken,results_endpoint:'/v1/scans/'+id,message:'Actual provider evidence is collected asynchronously; no estimated scores are generated.'});
 }
 const match=pathname.match(/^\/v1\/scans\/([0-9a-f-]{36})$/i);
 if(method==='GET'&&match){
  const job=await one('SELECT * FROM scan_jobs WHERE id=?',[match[1]]);if(!job)return json(res,404,{error:'Scan not found'});
  const session=await getSession(req);const guest=req.headers['x-scan-token']||'';
  if(!(session && session.user_id===job.owner_id) && !(job.guest_token_hash && guest && eqString(hashToken(guest),job.guest_token_hash)))return json(res,403,{error:'Access to this report is restricted'});
  const prompts=await sql('SELECT id,sequence,prompt_text,prompt_version FROM scan_prompts WHERE scan_id=? ORDER BY sequence',[job.id]);
  const results=await sql('SELECT prompt_id,provider,provider_status,model,answer_text,citations_json,own_domain_cited,brand_mentioned,recommended,observed_at,error FROM observations WHERE scan_id=? ORDER BY provider,observed_at',[job.id]);
  const observations=results.rows.map(r=>({...r,citations:JSON.parse(r.citations_json||'[]'),citations_json:undefined}));
  const saved=await one('SELECT profile_json FROM scan_profiles WHERE scan_id=?',[job.id]);
  const profile=saved?JSON.parse(saved.profile_json):null;
  const report=buildScanReport({profile,observations,promptCount:profile?.prompt_count||prompts.rows.length,status:job.status,legacyProviders:CONFIG.enabledProviders});
  return json(res,200,{id:job.id,domain:job.domain,brand_name:job.brand_name,profile,status:job.status,created_at:job.requested_at,finished_at:job.finished_at,error:job.error,prompts:prompts.rows,observations,...report,methodology:report.score.methodology});
 }
 return json(res,404,{error:'Not found'});
}
const server=http.createServer((req,res)=>Promise.resolve(route(req,res)).catch(e=>{
 const status=e.status||(/(invalid|unsupported|website|hostname|domain|URL)/i.test(e.message)?400:500);
 console.error('API request failed:',errorMessage(e));if(!res.headersSent)json(res,status,{error:status>=500?'Server request failed':errorMessage(e),...(e.code?{code:e.code}:{})});else res.end();
}));
await ensureSchema();
server.listen(CONFIG.apiPort,'0.0.0.0',()=>console.log(`AIRank API v${CONFIG.version} listening on ${CONFIG.apiPort}`));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
