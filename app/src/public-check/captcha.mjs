import {fail} from '../monitoring/shared.mjs';
export const CAPTCHA_ACTION='public_check';
const endpoint='https://challenges.cloudflare.com/turnstile/v0/siteverify';
export function captchaConfig(env=process.env){
 const siteKey=String(env.TURNSTILE_SITE_KEY||'').trim();
 const secret=String(env.TURNSTILE_SECRET_KEY||'').trim();
 const hostnames=String(env.TURNSTILE_ALLOWED_HOSTNAMES||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
 const ready=!!siteKey&&!!secret&&hostnames.length>0&&hostnames.every(h=>/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(h));
 return {ready,siteKey,secret,hostnames};
}
// Siteverify atomically consumes tokens across API replicas; never retry a verification.
// Tokens, secrets and provider responses must not be logged or persisted.
export async function verifyCaptcha({token,env=process.env,fetcher=fetch,now=Date.now}){
 const config=captchaConfig(env);
 if(!config.ready)fail(503,'CAPTCHA_UNAVAILABLE');
 if(typeof token!=='string'||!token.trim()||token.length>2048)fail(403,'CAPTCHA_REQUIRED');
 let response,data;
 try{
  response=await fetcher(endpoint,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({secret:config.secret,response:token}),signal:AbortSignal.timeout(8000)});
  if(!response.ok)fail(503,'CAPTCHA_UNAVAILABLE');
  const reader=response.body.getReader();let text='',length=0;const decoder=new TextDecoder();
  try{while(true){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.byteLength;if(length>16384)throw Error('CAPTCHA_RESPONSE_TOO_LARGE');text+=decoder.decode(chunk.value,{stream:true});}data=JSON.parse(text+decoder.decode());}
  finally{await reader.cancel();}
 }catch{fail(503,'CAPTCHA_UNAVAILABLE');}
 const issued=Date.parse(data?.challenge_ts),age=now()-issued;
 if(data?.success!==true||data.action!==CAPTCHA_ACTION||typeof data.hostname!=='string'||!config.hostnames.includes(data.hostname.toLowerCase())||!Number.isFinite(age)||age<0||age>=300000)fail(403,'CAPTCHA_FAILED');
 return true;
}
