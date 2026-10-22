import {createHmac,createHash,randomBytes,timingSafeEqual,createCipheriv,createDecipheriv} from 'node:crypto';
import {isIP} from 'node:net';
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const secretReady=env=>typeof env.PUBLIC_CHECK_PROXY_SECRET==='string'&&env.PUBLIC_CHECK_PROXY_SECRET.length>=32;
export const mac=(value,secret)=>createHmac('sha256',secret).update(value).digest('hex');
export const secureEqual=(a,b)=>{
 if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;
 return timingSafeEqual(Buffer.from(a),Buffer.from(b));
};
/** Authenticated BFF proof. Never accept client-supplied forwarding headers at Bunny. */
export function verifyProxy({method,path,body='',headers,env,now=Date.now()}){
 if(!secretReady(env))return null;
 const timestamp=String(headers['x-check-time']||''),fingerprint=String(headers['x-check-visitor']||'');
 const address=String(headers['x-check-address']||'');
 if(!isIP(address)||!secureEqual(mac(address,env.PUBLIC_CHECK_PROXY_SECRET),fingerprint))return null;
 if(!/^\d{13}$/.test(timestamp)||Math.abs(now-Number(timestamp))>60000||!/^[a-f0-9]{64}$/.test(fingerprint))return null;
 const expected=mac([method,path,timestamp,fingerprint,digest(body)].join('\n'),env.PUBLIC_CHECK_PROXY_SECRET);
 return secureEqual(expected,headers['x-check-proof'])?fingerprint:null;
}
/** Outbox-only recoverable ciphertext; access checks exclusively use token hashes. */
export function seal(value,env){
 const key=createHash('sha256').update('airank-public-outbox:'+env.PUBLIC_CHECK_PROXY_SECRET).digest(),iv=randomBytes(12);
 const cipher=createCipheriv('aes-256-gcm',key,iv);
 const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
}
export function unseal(value,env){
 const b=Buffer.from(value,'base64url'),key=createHash('sha256').update('airank-public-outbox:'+env.PUBLIC_CHECK_PROXY_SECRET).digest();
 const cipher=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));cipher.setAuthTag(b.subarray(12,28));
 return Buffer.concat([cipher.update(b.subarray(28)),cipher.final()]).toString('utf8');
}
export function verifyResendWebhook(raw,headers,secret,now=Date.now()){
 if(!secret||!secret.startsWith('whsec_'))return false;
 const id=String(headers['svix-id']||''),ts=String(headers['svix-timestamp']||'');
 if(!id||!/^\d+$/.test(ts)||Math.abs(now/1000-Number(ts))>300)return false;
 const expected=createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${id}.${ts}.${raw}`).digest('base64');
 return String(headers['svix-signature']||'').split(' ').some(part=>part.startsWith('v1,')&&secureEqual(part.slice(3),expected));
}
