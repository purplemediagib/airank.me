import { resolve4, resolve6 } from 'node:dns/promises';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { toHostname, isPublicIP, textWithoutTags, sanitizeText } from './utils.mjs';
const MAX_BYTES=350000;
async function ipFor(host){
 const all=[];
 try{all.push(...await resolve4(host))}catch{}
 try{all.push(...await resolve6(host))}catch{}
 if(!all.length || all.some(ip=>!isPublicIP(ip))) throw new Error('Website DNS resolves to an unsafe or non-public address');
 return all[0];
}
async function fetchPinned(url,depth=0){
 if(depth>2)throw new Error('Too many website redirects');
 const u=new URL(url);const domain=toHostname(url);
 const pinned=await ipFor(domain);
 return await new Promise((resolve,reject)=>{
   const request=(u.protocol==='https:'?httpsGet:httpGet)(u,{headers:{'user-agent':'AIRankScanner/0.1 (+https://airank.me)',accept:'text/html,application/xhtml+xml'},timeout:8000,lookup:(_hostname,opts,cb)=>{if(typeof opts==='function')cb=opts;cb(null,pinned,pinned.includes(':')?6:4)}},res=>{
     if([301,302,303,307,308].includes(res.statusCode||0) && res.headers.location){
       res.resume(); const next=new URL(res.headers.location,u);
       try{const nextHost=toHostname(next.href);if(nextHost.replace(/^www\./,'')!==domain.replace(/^www\./,''))throw new Error('Cross-domain website redirects are disabled');}catch(e){reject(e);return;}
       resolve(fetchPinned(next.href,depth+1));return;
     }
     if(res.statusCode!==200){res.resume();reject(new Error('Website responded with HTTP '+res.statusCode));return;}
     const typ=String(res.headers['content-type']||'');if(!/text\/html|application\/xhtml\+xml/i.test(typ)){res.resume();reject(new Error('Website is not an HTML page'));return;}
     let bytes=0;const chunks=[];
     res.on('data',c=>{bytes+=c.length;if(bytes>MAX_BYTES){request.destroy(new Error('Website page exceeds size limit'));return;}chunks.push(c);});
     res.on('end',()=>resolve({url:u.href,html:Buffer.concat(chunks).toString('utf8')}));
     res.on('error',reject);
   });
   request.on('timeout',()=>request.destroy(new Error('Website request timed out')));request.on('error',reject);
 });
}
function tag(html,re){return sanitizeText((re.exec(html)?.[1]||'').replace(/<[^>]*>/g,' '),300)}
export function summariseWebsite(html,domain){
 const title=tag(html,/<title[^>]*>([\s\S]*?)<\/title>/i);
 const ogName=tag(html,/<meta[^>]*(?:property|name)=["']og:site_name["'][^>]*content=["']([^"']+)["']/i);
 const description=tag(html,/<meta[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']+)["']/i);
 const h1=tag(html,/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
 const brand=sanitizeText(ogName||title.split(/\s+[|–—-]\s+/).at(-1)||domain.split('.')[0],100);
 return {brand,title,description,h1,body:textWithoutTags(html).slice(0,5000)};
}
export async function inspectWebsite(domain){const h=toHostname(domain);const r=await fetchPinned('https://'+h+'/');return {...summariseWebsite(r.html,h),url:r.url,domain:h};}
