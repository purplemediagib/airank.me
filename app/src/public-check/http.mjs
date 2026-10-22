import {getDb} from '../common/db.mjs';
import {hasDbConfig} from '../common/config.mjs';
import {publicCheckService} from './service.mjs';
import {verifyProxy,mac} from './security.mjs';
import {handleDeliveryWebhook} from './delivery.mjs';
async function readRaw(req){
 let length=0;const chunks=[];
 for await(const chunk of req){length+=chunk.length;if(length>65536)throw Object.assign(Error('BODY_TOO_LARGE'),{status:413,code:'BODY_TOO_LARGE'});chunks.push(chunk);}
 return Buffer.concat(chunks).toString('utf8');
}
export async function publicCheckHttp(req,res,options={}){
 const env=options.env||process.env,path=new URL(req.url,'http://localhost').pathname,method=req.method;
 res.setHeader('Cache-Control','private, no-store');res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('X-Robots-Tag','noindex, nofollow');res.setHeader('X-Content-Type-Options','nosniff');
 const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
 try{
  const raw=method==='POST'?await readRaw(req):'';
  const db=options.db|| (hasDbConfig()?await getDb():null);
  if(path==='/v1/public-check/webhooks/resend'&&method==='POST'){
   if(!db)throw Object.assign(Error('APP_NOT_CONFIGURED'),{status:503,code:'APP_NOT_CONFIGURED'});
   return json(200,await handleDeliveryWebhook({db,raw,headers:req.headers,env}));
  }
  const fingerprint=verifyProxy({method,path,body:raw,headers:req.headers,env});
  if(!fingerprint&&!(method==='GET'&&path==='/v1/public-check/capabilities'))throw Object.assign(Error('PROXY_REQUIRED'),{status:403,code:'PROXY_REQUIRED'});
  let body={};try{if(raw)body=JSON.parse(raw);}catch{throw Object.assign(Error('BODY_INVALID'),{status:400,code:'BODY_INVALID'});}
  if(body===null||Array.isArray(body)||typeof body!=='object')throw Object.assign(Error('BODY_INVALID'),{status:400,code:'BODY_INVALID'});
  // Reuse the authoritative API's existing keyed IP fingerprint, not a second daily quota namespace.
  const rateFingerprint=fingerprint&&env.RATE_LIMIT_SECRET?mac(String(req.headers['x-check-address']),env.RATE_LIMIT_SECRET):null;
  const response=await publicCheckService({db,method,path,body,fingerprint:rateFingerprint,scanToken:req.headers['x-scan-token'],env,config:options.config,deps:options.deps,now:options.now});
  return json(response.status,response.data);
 }catch(error){
  const code=error.code||(error.message==='INVALID_WEBSITE'?'INVALID_WEBSITE':error.message==='WEBSITE_UNAVAILABLE'?'WEBSITE_UNAVAILABLE':'PUBLIC_CHECK_UNAVAILABLE');
  // No raw URLs, request bodies, tokens, provider responses or emails enter logs.
  return json(error.status||(code==='INVALID_WEBSITE'?422:503),{error:{code}});
 }
}
