import {attachHttpDetails} from './diagnostics.mjs';
import {fetchRateLimited} from './rate-limit.mjs';
const metadata=new WeakMap();
export const requestMeta=json=>metadata.get(json)||{};
export async function requestJson(url,{headers={},body,timeoutMs=60000,redactErrors=false,fetchImpl=fetch,retryOptions={}}={}){
 const {response:res,meta}=await fetchRateLimited(url,{method:body?'POST':'GET',headers:{'accept':'application/json',...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})},{...retryOptions,timeoutMs,fetchImpl});
 try{
  const text=await res.text();let json;try{json=JSON.parse(text)}catch{throw attachHttpDetails(new Error('Provider returned non-JSON HTTP '+res.status),res.status,null,res.headers)}
  if(!res.ok||json?.error)throw attachHttpDetails(new Error('Provider HTTP '+res.status),res.status,json,res.headers);
  if(json&&typeof json==='object')metadata.set(json,meta);
  return json;
 }catch(error){error.providerMeta={...error.providerMeta,...meta};throw error;}
}
export function urlsUnique(input){const seen=new Set();const out=[];for(const x of input){const src=typeof x==='string'?{url:x}:x;try{const u=new URL(src.url);if(!['https:','http:'].includes(u.protocol)||seen.has(u.href))continue;seen.add(u.href);out.push({url:u.href,title:String(src.title||'').slice(0,200)});}catch{}}return out.slice(0,40)}
import {contextInstruction} from '../common/measurement-context.mjs';
export const promptContext=(prompt,context={})=>`${contextInstruction(context)}\nQuestion: ${prompt}`;
