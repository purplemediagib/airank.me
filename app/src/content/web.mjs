import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {toHostname,isPublicIP} from '../common/utils.mjs';
import {fail,hash} from './store.mjs';
export function publicUrl(value){let u;try{u=new URL(value);toHostname(value);}catch{fail(422,'INVALID_PUBLIC_URL');}if(u.protocol!=='https:'||u.port&&u.port!=='443')fail(422,'HTTPS_REQUIRED');u.hash='';return u.href;}
export function owned(url,domains){const host=new URL(publicUrl(url)).hostname.replace(/^www\./,'');return domains.some(d=>{const h=toHostname(d).replace(/^www\./,'');return host===h||host.endsWith('.'+h);});}
// Validate every DNS answer and pin the socket. Authenticated requests never redirect.
export async function webRequest(value,{method='GET',headers={},body,redirects=3,maxBytes=2000000,timeout=20000}={}){
 const u=new URL(publicUrl(value));const all=await lookup(u.hostname,{all:true});
 if(!all.length||all.some(a=>!isPublicIP(a.address)))fail(422,'UNSAFE_ADDRESS');
 const ip=all[0];return new Promise((resolve,reject)=>{
  const req=request(u,{method,headers:{'user-agent':'AIRankContent/1.0 (+https://airank.me)','accept-encoding':'identity',...headers},lookup:(_h,opts,cb)=>{if(opts?.all)cb(null,[ip]);else cb(null,ip.address,ip.family);}},res=>{
   if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location&&redirects>0){res.resume();if(method!=='GET'||headers.authorization)return reject(Object.assign(Error('REDIRECT_REJECTED'),{code:'REDIRECT_REJECTED'}));
    const next=new URL(res.headers.location,u);resolve(webRequest(next.href,{method,headers,redirects:redirects-1,maxBytes,timeout}));return;}
   let n=0;const chunks=[];res.on('data',b=>{n+=b.length;if(n>maxBytes)req.destroy(Object.assign(Error('RESPONSE_TOO_LARGE'),{code:'RESPONSE_TOO_LARGE'}));else chunks.push(b);});
   res.on('error',reject);res.on('end',()=>resolve({url:u.href,status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString('utf8')}));
  });const timer=setTimeout(()=>req.destroy(Object.assign(Error('FETCH_TIMEOUT'),{code:'FETCH_TIMEOUT'})),timeout);req.on('close',()=>clearTimeout(timer));req.on('error',reject);if(body)req.write(body);req.end();
 });
}
export const decode=s=>String(s).replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi,m=>{const e={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};if(m[1]!=='#')return e[m.slice(1,-1).toLowerCase()]||m;const n=m[2].toLowerCase()==='x'?parseInt(m.slice(3,-1),16):Number(m.slice(2,-1));return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';});
export const plain=s=>decode(String(s).replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<[^>]+>/g,' ')).replace(/[ \t]+/g,' ').trim();
const attrs=t=>Object.fromEntries([...t.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(m=>[m[1].toLowerCase(),decode(m[2]??m[3]??m[4])]));
export function parsePage(html,url,headers={}){
 const title=plain(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'');
 const meta=[...html.matchAll(/<meta\b[^>]*>/gi)].map(m=>attrs(m[0]));const links=[...html.matchAll(/<link\b[^>]*>/gi)].map(m=>attrs(m[0]));
 const main=html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]||html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]||html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]||html;
 let content=main.replace(/<(nav|footer|header|aside|script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,'');
 const unsupportedElements=[...new Set([...content.matchAll(/<(iframe|video|audio|form|canvas)\b/gi)].map(m=>m[1].toLowerCase()))];
 content=content.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi,(_m,table)=>{const rows=[...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(r=>[...r[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c=>plain(c[1]).replace(/\|/g,'/'))).filter(r=>r.length);if(!rows.length)return '';return '\n\n'+rows.map((r,i)=>'| '+r.join(' | ')+' |'+(i===0?'\n| '+r.map(()=>'---').join(' | ')+' |':'')).join('\n')+'\n\n';});
 content=content.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi,(_m,tag,label)=>{try{return '['+plain(label).replace(/[\[\]]/g,'')+']('+publicUrl(new URL(attrs(tag).href,url).href)+')';}catch{return plain(label);}}).replace(/<img\b([^>]*)>/gi,(_m,tag)=>{const a=attrs(tag);try{return '\n!['+(a.alt||'').replace(/[\[\]]/g,'')+']('+publicUrl(new URL(a.src,url).href)+')\n';}catch{return '';}});
 const markdown=decode(content.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,(_,n,s)=>'\n\n'+'#'.repeat(Number(n))+' '+plain(s)+'\n\n').replace(/<li\b[^>]*>/gi,'\n- ').replace(/<\/(?:p|div|section|tr)>|<br\s*\/?>/gi,'\n\n').replace(/<[^>]*>/g,'')).replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
 const a=[...markdown.matchAll(/\]\((https:\/\/[^\s)]+)\)/g)].map(m=>m[1]);
 return {url,title,description:meta.find(m=>m.name?.toLowerCase()==='description')?.content||'',markdown:markdown.slice(0,100000),contentTruncated:markdown.length>100000,
  h1Count:(content.match(/<h1\b/gi)||[]).length,headings:[...content.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map(m=>({level:Number(m[1]),text:plain(m[2])})),
  canonical:links.find(l=>l.rel==='canonical')?.href||null,robots:meta.filter(m=>['robots','googlebot','gptbot','oai-searchbot'].includes(m.name?.toLowerCase())).map(m=>({agent:m.name,value:m.content})),
  xRobotsTag:headers['x-robots-tag']||null,links:[...new Set(a)],structuredDataPresent:/<script[^>]+type=["']application\/ld\+json/i.test(html),
  extraction:'server-html-v1',unsupportedElements,conversionReviewRequired:true,renderedJavascript:false,contentHash:hash(markdown),fetchedAt:Date.now()};
}
export function robotsAllowed(text,path){
 // Longest matching Allow/Disallow for AIRankContent, falling back to *. Crawl-delay is bounded by worker pacing.
 let groups=[],g=null;for(const raw of text.split(/\r?\n/)){const line=raw.split('#')[0].trim(),i=line.indexOf(':');if(i<0)continue;const k=line.slice(0,i).toLowerCase(),v=line.slice(i+1).trim();
  if(k==='user-agent'){if(!g||g.rules.length){g={agents:[],rules:[]};groups.push(g);}g.agents.push(v.toLowerCase());}else if(g&&['allow','disallow'].includes(k)&&v)g.rules.push({k,v});}
 let use=groups.filter(g=>g.agents.some(a=>a==='airankcontent'));if(!use.length)use=groups.filter(g=>g.agents.includes('*'));
 const matches=use.flatMap(g=>g.rules).filter(r=>new RegExp('^'+r.v.split('*').map(s=>s.replace(/[.+?^{}()|[\]\\]/g,'\\$&')).join('.*').replace(/\\\$$/,'$')).test(path)).sort((a,b)=>b.v.length-a.v.length||(a.k==='allow'?-1:1));
 return !matches.length||matches[0].k==='allow';
}
export async function fetchPage(url,{requestFn=webRequest,robotsCache=new Map(),depth=0}={}){
 if(depth>3)fail(422,'TOO_MANY_REDIRECTS');
 const u=new URL(publicUrl(url));let robots=robotsCache.get(u.origin);
 if(!robots){const r=await requestFn(u.origin+'/robots.txt');if(r.status===404)robots={text:'',state:'missing'};else if(r.status===200)robots={text:r.text,state:'available'};else fail(422,'ROBOTS_UNAVAILABLE');robotsCache.set(u.origin,robots);}
 if(!robotsAllowed(robots.text,u.pathname+u.search))fail(422,'ROBOTS_DISALLOWED');
 // Resolve redirects ourselves so robots is checked again at each destination.
 const r=await requestFn(u.href,{redirects:0});
 if([301,302,303,307,308].includes(r.status)&&r.headers.location)return fetchPage(new URL(r.headers.location,u).href,{requestFn,robotsCache,depth:depth+1});
 if(r.status!==200)fail(422,'PAGE_HTTP_'+r.status);
 if(!/text\/html|application\/xhtml\+xml/i.test(r.headers['content-type']||''))fail(422,'HTML_REQUIRED');
 return {...parsePage(r.text,r.url,r.headers),robotsTxt:robots,rawHtml:r.text};
}
export function audit(page){
 const issues=[];const add=(code,severity,detail)=>issues.push({code,severity,detail});const words=(page.markdown||'').split(/\s+/).filter(Boolean).length;
 if(!page.title)add('missing_title','high','Add a descriptive page title.');if(!page.description)add('missing_description','medium','Write an accurate search description.');
 if(page.h1Count!==1)add('heading_structure','medium','Review the primary heading and section hierarchy.');
 if(/noindex/i.test(JSON.stringify(page.robots||[])+(page.xRobotsTag||'')))add('noindex','high','Page declares noindex; review intentional indexing restrictions.');
 if(words<80)add('little_server_content','high','Very little text was available in server HTML; rendered content has not been checked.');
 if(!page.structuredDataPresent)add('structured_data_review','low','Consider appropriate structured data matching visible content.');
 if(!page.links?.length)add('links_review','low','Review useful internal and supporting-source links.');
 if(page.contentTruncated)add('extraction_truncated','high','Page exceeded the extraction limit.');
 return {methodology:'content-checklist-v1',wordCount:words,issues,checksPassed:8-issues.length,checksTotal:8,scoreType:'editorial_checklist_not_visibility',assessedAt:Date.now()};
}
