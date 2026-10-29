import {setTimeout as delay} from 'node:timers/promises';

export const maxHttpAttempts=3;
export function retryAfterMs(value,now=Date.now()){
 if(typeof value!=='string'||!value.trim())return null;
 const raw=value.trim();
 if(/^\d+(?:\.\d+)?$/.test(raw)){
  const ms=Number(raw)*1000;return Number.isFinite(ms)?ms:null;
 }
 // Avoid interpreting malformed numeric delays as dates.
 if(!/[a-z]/i.test(raw))return null;
 const stamp=Date.parse(raw);return Number.isFinite(stamp)?Math.max(0,stamp-now):null;
}

// Retry only explicit HTTP 429 rejections. Network errors, partially generated
// responses and all other statuses are never replayed here. All attempts share
// the original task deadline and reservation, including backoff and body reads.
export async function fetchRateLimited(url,init,{timeoutMs=60000,fetchImpl=fetch,now=Date.now,random=Math.random,sleep=(ms,signal)=>delay(ms,undefined,{signal})}={}){
 const deadline=now()+timeoutMs,signal=AbortSignal.timeout(timeoutMs);
 let attempts=0,retries=0;
 const meta=()=>({request_attempts:attempts,rate_limit_retries:retries});
 try{
  while(true){
   signal.throwIfAborted();
   attempts++;
   const response=await fetchImpl(url,{...init,signal});
   if(response.status!==429||attempts>=maxHttpAttempts)return {response,meta:meta()};
   const wait=retryAfterMs(response.headers?.get?.('retry-after'),now())??[2000,6000][attempts-1]*(1+Math.min(1,Math.max(0,random()))*0.25);
   // Do not shorten Retry-After to fit a lease or launch after its expiry.
   if(wait>=deadline-now()||signal.aborted)return {response,meta:meta()};
   await sleep(wait,signal);
   if(now()>=deadline||signal.aborted)return {response,meta:meta()};
   await response.body?.cancel?.();
   retries++;
  }
 }catch(error){
  error.providerMeta={...error.providerMeta,...meta()};throw error;
 }
}
