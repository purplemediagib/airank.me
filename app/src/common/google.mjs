import { createHash, createPublicKey, verify } from 'node:crypto';
import { randomToken } from './utils.mjs';
const TOKEN_ENDPOINT='https://oauth2.googleapis.com/token';
const JWKS_ENDPOINT='https://www.googleapis.com/oauth2/v3/certs';
let jwksCache={expires:0,keys:[]};
export function pkceChallenge(verifier){return createHash('sha256').update(verifier).digest('base64url')}
export function createOauthRequest({clientId,redirectUri,nonce,state,verifier}){
 const u=new URL('https://accounts.google.com/o/oauth2/v2/auth');
 for(const [k,v] of Object.entries({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:'openid email profile',state,nonce,code_challenge:pkceChallenge(verifier),code_challenge_method:'S256',access_type:'online'}))u.searchParams.set(k,v);
 return u.href;
}
export async function exchangeGoogleCode({code,codeVerifier,clientId,clientSecret,redirectUri}){
 const body=new URLSearchParams({code,code_verifier:codeVerifier,client_id:clientId,client_secret:clientSecret,redirect_uri:redirectUri,grant_type:'authorization_code'});
 const r=await fetch(TOKEN_ENDPOINT,{method:'POST',body,headers:{'content-type':'application/x-www-form-urlencoded'},signal:AbortSignal.timeout(12000)});
 const j=await r.json();if(!r.ok || !j.id_token)throw new Error('Google OAuth code exchange failed');return j.id_token;
}
export async function verifyGoogleIdToken(token,{clientId,nonce}){
 const parts=String(token).split('.');if(parts.length!==3)throw new Error('Malformed Google ID token');
 const header=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
 const claims=JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8'));
 if(header.alg!=='RS256'||!header.kid)throw new Error('Unexpected Google signing algorithm');
 if(jwksCache.expires<Date.now()){
  const r=await fetch(JWKS_ENDPOINT,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('Unable to retrieve Google signing keys');
  const j=await r.json();jwksCache={keys:j.keys||[],expires:Date.now()+15*60*1000};
 }
 let key=jwksCache.keys.find(k=>k.kid===header.kid);
 if(!key){jwksCache.expires=0;throw new Error('Unknown Google signing key (retry sign-in)')}
 if(!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key,format:'jwk'}),Buffer.from(parts[2],'base64url')))throw new Error('Invalid Google token signature');
 if(!['accounts.google.com','https://accounts.google.com'].includes(claims.iss) || claims.aud!==clientId ||
    !Number.isFinite(claims.exp) || claims.exp*1000<=Date.now() ||
    typeof claims.sub!=='string' || !claims.sub || claims.nonce!==nonce ||
    claims.email_verified!==true || typeof claims.email!=='string' || !claims.email)throw new Error('Google token claims validation failed');
 return {googleSub:claims.sub,email:claims.email||'',name:claims.name||'',picture:claims.picture||''};
}
