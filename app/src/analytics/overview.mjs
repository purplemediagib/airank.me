import {aggregate,sourceUrls} from './extraction.mjs';
import {sourceAnalytics} from './sources.mjs';
import {observationContextKey} from '../common/observations.mjs';
const host=value=>{try{return new URL(value.includes('://')?value:`https://${value}`).hostname.toLowerCase().replace(/^www\./,'');}catch{return '';}};
const matches=(domain,list)=>list.some(d=>{const h=host(d);return h&&(domain===h||domain.endsWith(`.${h}`));});
export function overviewInsights(entries,comparison=null){
 const contexts=new Map();
 for(const entry of entries){
  const rowContexts=new Set(entry.rows.map(row=>observationContextKey(row,entry.snapshot)));
  if(rowContexts.size>1)return {state:'incompatible',reason:'mixed_measurement_contexts',sources:sourceAnalytics(entries),matrix:[],domains:[],domainTypes:[],comparison:null};
  const context=observationContextKey(entry.rows[0]||{provider:entry.tasks[0]?.provider},entry.snapshot);
  const part=contexts.get(context)||[];part.push(entry);contexts.set(context,part);
 }
 if(contexts.size>1)return {state:'incompatible',reason:'mixed_measurement_contexts',sources:sourceAnalytics(entries),matrix:[],domains:[],domainTypes:[],comparison:null,
  groups:[...contexts].map(([context,part])=>({context:JSON.parse(context),...overviewInsights(part)}))};
 const cells=new Map(),domains=new Map(),types=new Map();
 for(const entry of entries){
  const byId=new Map(entry.rows.map(r=>[r.id,r]));
  for(const t of entry.tasks){
   const p=entry.snapshot.prompts.find(p=>p.id===t.prompt_id);
   const tags=p?.tags?.length?[...new Set(p.tags)]:[''];
   for(const tag of tags){
    const topic=p?.topic||'',key=JSON.stringify([topic,tag]);
    const cell=cells.get(key)||{topic,tag,rows:[],expected:0};
    cell.expected++;if(byId.has(t.id))cell.rows.push(byId.get(t.id));cells.set(key,cell);
   }
  }
  for(const row of entry.rows.filter(r=>!r.exclusion)){
   const categories=new Set();
   for(const domain of new Set(sourceUrls(row).map(host).filter(Boolean))){
    const category=matches(domain,entry.snapshot.identity.ownedDomains||[])?'owned':
     matches(domain,(entry.snapshot.cohort?.brands||[]).slice(1).flatMap(b=>b.ownedDomains||[]))?'competitor':'other';
    const key=JSON.stringify([domain,category]),old=domains.get(key)||{domain,category,answers:0};old.answers++;domains.set(key,old);categories.add(category);
   }
   for(const c of categories)types.set(c,(types.get(c)||0)+1);
  }
 }
 return {sources:sourceAnalytics(entries),matrix:[...cells.values()].map(({rows,expected,...c})=>({...c,metrics:aggregate(rows,expected)})),
 domains:[...domains.values()].sort((a,b)=>b.answers-a.answers||a.domain.localeCompare(b.domain)),
 domainTypes:['owned','competitor','other'].map(category=>({category,answers:types.get(category)||0})),comparison};
}
