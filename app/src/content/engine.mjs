import {get,list,put,one,exec,fail,hash,uid,enqueue,access} from './store.mjs';
import {fetchPage,webRequest,publicUrl,owned,audit,decode} from './web.mjs';
import {generate} from './model.mjs';
import {documentInput} from './editor.mjs';
import {googleReport,searchOpportunities,aggregateGsc} from './google.mjs';
import {analyticsService} from '../analytics/service.mjs';
import {publish} from './publish.mjs';
const day=n=>new Date(n).toISOString().slice(0,10);
const windowDates=(now=Date.now())=>{const end=new Date(day(now)+'T00:00:00Z').getTime()-4*86400000;return {endDate:day(end),startDate:day(end-27*86400000),previousEnd:day(end-28*86400000),previousStart:day(end-55*86400000)};};
async function evidence(ctx,project){return ctx.step('analytics',async()=>{try{return (await analyticsService({db:ctx.db,path:`/v1/projects/${ctx.job.project_id}/analytics`,userId:project.owner_id,env:ctx.env})).data;}catch(e){if(e.code==='INVALID_FILTER')throw e;return {state:'unavailable',error:'MONITORING_DATA_UNAVAILABLE',evidence:[],runs:[],selectedGroup:null,metrics:null};}});}
async function sources(ctx,urls){const out=[];for(const u of [...new Set(urls)].slice(0,12)){
 const k='source-'+hash(u).slice(0,20);const r=await ctx.step(k,async()=>{try{const page=await (ctx.fetchPageFn||fetchPage)(u);const id=hash([u,page.contentHash]).slice(0,40);const record={...page,id};await ctx.commit(tx=>put(tx,ctx.job.project_id,'source',id,record,undefined,ctx.job.actor));return record;}catch(e){return {url:u,error:e.code||'SOURCE_FETCH_FAILED'};}});out.push(r);
 }return out;}
async function modelContext(ctx,project,doc){
 const a=await evidence(ctx,project);const ev=a.evidence.filter(e=>!e.exclusion).slice(-20).map(e=>({...e,answer:e.answer.slice(0,2000),answerTruncated:e.answer.length>2000}));
 const urls=[...(ctx.input.sourceUrls||[]),...ev.flatMap(e=>e.citations||[])].filter(u=>{try{publicUrl(u);return true;}catch{return false;}});
 const fetched=await sources(ctx,urls);return {locale:ctx.input.locale,brand:{...project.identity,...await get(ctx.db,ctx.job.project_id,'settings','brand')},document:doc?{id:doc.id,version:doc.version,title:doc.title,description:doc.description,markdown:doc.markdown,locale:doc.locale}:null,topic:ctx.input.topic||doc?.topic||'',instructions:ctx.input.instructions||'',expertise:ctx.input.expertise||doc?.expertise||'',
  ownedPages:(await list(ctx.db,ctx.job.project_id,'document')).filter(d=>d.sourceUrl).slice(0,100).map(d=>({title:d.title,url:d.sourceUrl})),sources:fetched.filter(s=>!s.error).map(s=>({id:s.id,url:s.url,title:s.title,markdown:s.markdown.slice(0,6000),contentHash:s.contentHash,fetchedAt:s.fetchedAt,truncated:s.markdown.length>6000})),sourceErrors:fetched.filter(s=>s.error),evidence:ev,monitoringGroup:a.selectedGroup};
}
export async function runJob(ctx){
 const {db,job,input}=ctx,p=job.project_id;const project=await access(db,p,job.actor,job.kind==='publish'?'review':'edit');
 const doc=input.documentId?await get(db,p,'document',input.documentId):null;
 if(input.documentId&&(!doc||doc.version!==input.documentVersion)&&!['impact'].includes(job.kind))fail(409,'REVISION_CHANGED');
 if(job.kind==='import'){
  const page=await ctx.step('page',()=> (ctx.fetchPageFn||fetchPage)(input.url));if(!owned(page.url,project.identity.ownedDomains))fail(422,'OWNED_URL_REQUIRED');
  return ctx.step('saved',()=>ctx.commit(async tx=>{const id=hash(page.url).slice(0,40),old=await get(tx,p,'document',id);if(old)return {documentId:id,existing:true,note:'Existing edits preserved. Use a new audit to review the source.'};
   const value={...documentInput({title:page.title,markdown:page.markdown,description:page.description,locale:input.locale,sourceUrl:page.url}),original:page,audit:audit(page)};const result=await put(tx,p,'document',id,value,0,job.actor);return {documentId:id,version:result.version};}));
 }
 if(job.kind==='sitemap'){
  const discovered=await ctx.step('urls',async()=>{const pending=[input.url],seen=new Set(),urls=new Set(),errors=[];const max=Math.min(500,Math.max(1,Number(input.maxPages)||200));while(pending.length&&seen.size<20&&urls.size<max){const u=pending.shift();if(seen.has(u))continue;seen.add(u);if(!owned(u,project.identity.ownedDomains))continue;const r=await(ctx.requestFn||webRequest)(u);if(r.status!==200){errors.push({url:u,status:r.status});continue;}if(/<!DOCTYPE|<!ENTITY/i.test(r.text))fail(422,'UNSAFE_XML');const index=/<sitemapindex\b/i.test(r.text);for(const m of r.text.matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)){let link;try{link=publicUrl(decode(m[1].trim()));}catch{continue;}if(!owned(link,project.identity.ownedDomains))continue;if(index){if(pending.length<20)pending.push(link);}else{urls.add(link);if(urls.size>=max)break;}}}return {urls:[...urls],errors,limit:max,partial:pending.length>0||urls.size>=max};});
  const jobs=[];for(const [i,u]of discovered.urls.entries())jobs.push(await ctx.step('queued-'+i,()=>ctx.commit(tx=>enqueue(tx,p,job.actor,'import',{url:u,locale:input.locale},job.id+'-'+i))));return {...discovered,jobs:jobs.map(j=>j.id)};
 }
 if(['research','rewrite','create','perception','audit'].includes(job.kind)){
  const context=await ctx.step('context',()=>modelContext(ctx,project,doc));let deterministic=null;
  if(job.kind==='audit'){
   if(doc.sourceUrl){const page=await ctx.step('audit-page',()=> (ctx.fetchPageFn||fetchPage)(doc.sourceUrl));deterministic=audit(page);}
   else deterministic={...audit({title:doc.title,description:doc.description,markdown:doc.markdown,h1Count:(doc.markdown.match(/^# /gm)||[]).length,links:[],structuredDataPresent:false}),scope:'pasted_content_only',note:'Indexing, server HTML and robots checks require a published URL.'};
  }
  if(job.kind==='perception'&&!context.evidence.length)return {state:'unavailable',reason:'NO_MONITORING_EVIDENCE'};
  const result=await ctx.step('generation',()=> (ctx.generateFn||generate)({db,job,kind:job.kind,input:context,env:ctx.env,signal:ctx.signal}));
  const full={...result,deterministic,sourceErrors:context.sourceErrors,documentId:doc?.id||null,documentVersion:doc?.version||null,monitoringGroup:context.monitoringGroup};
  if(job.kind==='create'&&!doc){const created=await ctx.step('created-document',()=>ctx.commit(async tx=>await get(tx,p,'document',job.id)||put(tx,p,'document',job.id,{...documentInput({...result.output,locale:input.locale}),topic:input.topic,generationJobId:job.id,claims:result.output.claims||[],missingInformation:result.output.missingInformation},0,job.actor)));full.documentId=created.id;full.documentVersion=created.version;}
  await ctx.step('assessment',()=>ctx.commit(async tx=>await get(tx,p,'assessment',job.id)||put(tx,p,'assessment',job.id,{kind:job.kind,...full},0,job.actor)));return full;
 }
 if(job.kind==='opportunities'){
  const a=await evidence(ctx,project),dates=windowDates();const report=async(service,view,startDate,endDate,aiOnly=false)=> (ctx.googleFn||googleReport)({projectId:p,service,view,startDate,endDate,aiOnly,env:ctx.env});
  const current=await ctx.step('gsc-current',()=>report('gsc','pages',dates.startDate,dates.endDate)),previous=await ctx.step('gsc-previous',()=>report('gsc','pages',dates.previousStart,dates.previousEnd)),pairs=await ctx.step('gsc-pairs',()=>report('gsc','query_pages',dates.startDate,dates.endDate));
  const candidates=searchOpportunities(current,previous,pairs);const groups=new Map();for(const e of a.evidence.filter(e=>!e.exclusion)){const rows=groups.get(e.promptId)||[];rows.push(e);groups.set(e.promptId,rows);}
  for(const [promptId,rows]of groups){const missing=rows.filter(e=>!e.mentioned),external=rows.filter(e=>e.citations?.length&&!e.ownedCitation);if(missing.length)candidates.push({kind:'ai_visibility_gap',promptId,question:rows[0].text,priority:missing.length===rows.length?'high':'medium',rationale:`Brand absent in ${missing.length}/${rows.length} eligible answers.`,evidenceIds:missing.map(e=>e.id)});
   if(external.length)candidates.push({kind:'external_source_opportunity',promptId,question:rows[0].text,priority:'medium',rationale:'These answers cite external sources without citing an owned page. Review accurate representation on relevant sources.',sourceUrls:[...new Set(external.flatMap(e=>e.citations))],evidenceIds:external.map(e=>e.id)});
  }
  const saved=await ctx.step('save-opportunities',()=>ctx.commit(async tx=>{const out=[];for(const c of candidates){const id=hash([c.kind,c.url||c.query||c.promptId]).slice(0,40),old=await get(tx,p,'opportunity',id);if(['completed','dismissed'].includes(old?.status)){out.push(old);continue;}out.push(await put(tx,p,'opportunity',id,{...c,status:old?.status||'new',note:old?.note||'',dataCoverage:{current:current.state,previous:previous.state,pairs:pairs.state},monitoringGroup:a.selectedGroup,generatedAt:Date.now()},undefined,job.actor));}return out;}));
  return {opportunities:saved,dates,googleCoverage:{current:{...current,rows:undefined},previous:{...previous,rows:undefined},queryPages:{...pairs,rows:undefined}},monitoringState:a.state||a.metrics?.state||'unavailable'};
 }
 if(job.kind==='impact'){
  const pubs=(await list(db,p,'publication')).filter(r=>r.documentId===doc?.id&&r.status==='published').sort((a,b)=>b.publishedAt-a.publishedAt);const pub=pubs[0];if(!pub)return {state:'unavailable',reason:'NO_PUBLISHED_REVISION'};
  const days=28,start=Date.parse(day(pub.publishedAt)+'T00:00:00Z')+86400000,end=start+days*86400000;const a=await evidence(ctx,project),before=a.runs.filter(r=>r.kind==='neutral'&&r.createdAt>=start-days*86400000&&r.createdAt<start),after=a.runs.filter(r=>r.kind==='neutral'&&r.createdAt>=start&&r.createdAt<end);
  const groups=[...new Set(before.map(r=>r.group))].filter(g=>after.some(r=>r.group===g));const comparisons=groups.map(group=>{const reduce=rs=>{const eligible=rs.reduce((n,r)=>n+r.metrics.eligible,0),mentions=rs.reduce((n,r)=>n+r.metrics.mentions,0),citations=rs.reduce((n,r)=>n+r.metrics.ownedCitations,0);const sentimentGroups=new Map();for(const r of rs)for(const g of r.metrics.sentiment?.groups||[]){const v=sentimentGroups.get(g.id)||{id:g.id,model:g.model,analysisVersion:g.analysisVersion,sampleSize:0,total:0};v.sampleSize+=g.sampleSize;v.total+=g.score*g.sampleSize;sentimentGroups.set(g.id,v);}return {sentimentGroups:[...sentimentGroups.values()].map(({total,...g})=>({...g,score:g.sampleSize?total/g.sampleSize:null})),runs:rs.length,eligible,mentions,citations,visibility:eligible?100*mentions/eligible:null,citationRate:eligible?100*citations/eligible:null};};return {group,before:reduce(before.filter(r=>r.group===group)),after:reduce(after.filter(r=>r.group===group))};});
  const reports={};for(const service of ['gsc','ga4'])for(const period of ['before','after']){const startDate=day(period==='before'?start-days*86400000:start),endDate=day(period==='before'?start-86400000:Math.min(end-86400000,Date.now()-4*86400000));reports[service+'_'+period]=startDate>endDate?{state:'collecting',rows:[],missingDates:[]}:await ctx.step(service+'-'+period,()=> (ctx.googleFn||googleReport)({projectId:p,service,view:'pages',startDate,endDate,aiOnly:service==='ga4',env:ctx.env}));}
  const normal=u=>{try{const v=new URL(u,pub.url);return v.origin+v.pathname.replace(/\/$/,'');}catch{return null;}};
  for(const [key,r]of Object.entries(reports)){if(!['available','partial'].includes(r.state)){r.summary=null;continue;}r.rows=r.rows.filter(row=>normal(key.startsWith('gsc')?row.keys?.[0]:row.landingPagePlusQueryString)===normal(pub.url));if(key.startsWith('gsc'))r.summary=aggregateGsc(r.rows);else r.summary={sessions:r.rows.reduce((n,x)=>n+Number(x.sessions||0),0),keyEvents:r.rows.reduce((n,x)=>n+Number(x.keyEvents||0),0),totalRevenue:r.rows.reduce((n,x)=>n+Number(x.totalRevenue||0),0),currency:r.currency||null};}
  const result={publicationId:pub.id,windowDays:days,state:Date.now()<end?'collecting':'available',comparisons,google:reports,attribution:'Observed association, not causal proof. AI comparisons cover the project and comparable prompt/model groups; they are not exact article-to-prompt attribution.',limitations:['Other website changes, seasonality and model updates can affect results.','AI referral reporting includes identified referrers only.'],evaluatedAt:Date.now()};await ctx.step('save-impact',()=>ctx.commit(tx=>put(tx,p,'assessment',job.id,{kind:'impact',documentId:doc.id,...result},0,job.actor)));return result;
 }
 if(job.kind==='publish')return publish(ctx,doc,project);
 fail(422,'UNKNOWN_JOB');
}
