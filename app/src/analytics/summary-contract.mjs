import {hash,fail} from '../monitoring/shared.mjs';
import {parseMeasurementFilters} from './service.mjs';
import {config as sentimentConfig} from '../sentiment/core.mjs';
import {configuration as intelligenceConfig} from '../intelligence/core.mjs';
import {extractionVersion} from './extraction.mjs';
export const summaryVersion='analytics-summary-v1';
export const DAY=86400000;
export const MAX_VARIANTS=64;
export const DEMAND_TTL=7*DAY;
export const GENERATION_TTL=DAY;
export const LEASE_MS=10*60*1000;
export function formatVersion(env=process.env){
 const s=sentimentConfig(env),i=intelligenceConfig(env);
 // Only non-secret output-affecting configuration. A new build cannot reuse an
 // older executable's semantics accidentally; API and projector must match.
 return hash([summaryVersion,'overview-ui-v1',extractionVersion,env.AIRANK_BUILD_REVISION||'development',s.version,s.model,env.SENTIMENT_ENABLED==='true',i.version,i.model,env.ENTITY_ANALYSIS_ENABLED==='true']);
}
const allowed=new Set(['from','to','provider','topic','runId','group','surface','promptId','promptVersion','tags','tag','tagMode','market','language']);
export function canonicalQuery(query){
 for(const key of query.keys())if(!allowed.has(key)||query.getAll(key).length!==1)fail(422,'INVALID_FILTER');
 const q=new URLSearchParams();
 for(const key of ['from','to']){
  const v=query.get(key)||'',n=Date.parse(`${v}T00:00:00Z`);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(n)||new Date(n).toISOString().slice(0,10)!==v)fail(422,'INVALID_FILTER');
  q.set(key,v);
 }
 const days=(Date.parse(q.get('to'))-Date.parse(q.get('from')))/DAY+1;
 if(days<1||days>366)fail(422,'INVALID_FILTER');
 for(const key of ['provider','topic','runId','group','surface','promptId','promptVersion']){
  const v=query.get(key);if(v){if(v.length>200)fail(422,'INVALID_FILTER');q.set(key,v);}
 }
 if(q.has('surface')&&!['model_api','consumer_web'].includes(q.get('surface')))fail(422,'INVALID_FILTER');
 if(q.has('promptVersion')&&(!q.has('promptId')||!/^[1-9]\d*$/.test(q.get('promptVersion'))))fail(422,'INVALID_FILTER');
 const f=parseMeasurementFilters(query);
 if(f.tags.length){q.set('tags',JSON.stringify(f.tags));q.set('tagMode',f.tagMode);}
 for(const key of ['market','language'])if(f[key])q.set(key,f[key]);
 q.sort();return q;
}
export const queryKey=(q,format)=>hash([format,q.toString()]);
export function evidenceMetadata(e){
 const ok=e.exclusion===null;
 const fields=[e.text,e.answer,e.provider,e.model,e.topic||'',...(e.tags||[]),...(e.brandNames||[]),...(e.citations||[])];
 // A JSON array preserves field boundaries, matching frontend .some(includes).
 return {search:JSON.stringify(fields.map(s=>(s||'').toLocaleLowerCase())),
  brands:JSON.stringify(e.brandOrder?.mentions?e.brandOrder.mentions.map(m=>m.brandName):(e.brandNames||[])),
  mentioned:Number(ok&&!!e.mentioned),recommended:Number(ok&&e.recommendation==='recommended'),cited:Number(ok&&!!e.ownedCitation),
  ordered:Number(ok&&e.brandOrder?.state==='observed'&&e.brandOrder.targetPosition!==null),first:Number(ok&&e.brandOrder?.state==='observed'&&e.brandOrder.targetPosition===1),excluded:Number(!ok)};
}
export function evidenceSelection(query){
 const allowed=new Set(['generation','cursor','pageSize','q','filter','evidenceBrand']);
 for(const k of query.keys())if(!allowed.has(k)||query.getAll(k).length!==1)fail(422,'INVALID_FILTER');
 const generation=query.get('generation')||'',q=(query.get('q')||'').trim().toLocaleLowerCase(),filter=query.get('filter')||'all',brand=query.get('evidenceBrand')||'',pageSize=Number(query.get('pageSize')||25);
 if(!/^[a-zA-Z0-9-]{1,80}$/.test(generation)||q.length>200||brand.length>200||!['all','mentioned','recommended','cited','ordered','first','excluded'].includes(filter)||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)fail(422,'INVALID_FILTER');
 const key=hash([generation,q,filter,brand]),where=['e.generation_id=?'],args=[generation];
 if(filter!=='all')where.push(`p.${filter==='first'?'first_rank':filter}=1`);
 if(q){where.push('EXISTS(SELECT 1 FROM json_each(p.search_text) f WHERE instr(f.value,?)>0)');args.push(q);}
 if(brand){where.push('EXISTS(SELECT 1 FROM json_each(p.brands_json) b WHERE b.value=?)');args.push(brand);}
 let after=-1;
 if(query.has('cursor')){
  const raw=query.get('cursor');if(raw.length>1024)fail(422,'INVALID_CURSOR');
  try{const c=JSON.parse(Buffer.from(raw,'base64url').toString());if(c.key!==key||!Number.isSafeInteger(c.position)||c.position<0)fail(422,'INVALID_CURSOR');after=c.position;}catch{fail(422,'INVALID_CURSOR');}
 }
 return {generation,key,where:where.join(' AND '),args,pageSize,after};
}
export const cursorFor=(key,position)=>Buffer.from(JSON.stringify({key,position})).toString('base64url');
