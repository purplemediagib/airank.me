import {get,put,list,one,fail,unseal,access,hash} from './store.mjs';
import {webRequest,owned,publicUrl} from './web.mjs';
import {toHtml} from './editor.mjs';
export async function cmsItems({db,projectId,query,env=process.env,requestFn=webRequest}){
 const row=await one(db,'SELECT secret FROM content_cms WHERE project_id=?',[projectId]);if(!row)fail(409,'CMS_NOT_CONFIGURED');const cfg=unseal(row.secret,projectId,env);
 const page=Number(query.get('page')||1);if(!Number.isInteger(page)||page<1||page>1000)fail(422,'INVALID_PAGE');const search=(query.get('search')||'').slice(0,200);
 if(cfg.type==='wordpress'){
  const kind=query.get('type')||'posts';if(!['posts','pages'].includes(kind))fail(422,'INVALID_WORDPRESS_TYPE');const u=new URL(cfg.baseUrl+'/wp-json/wp/v2/'+kind);u.search=new URLSearchParams({context:'edit',status:'any',per_page:'20',page:String(page),search}).toString();
  const r=await requestFn(u.href,{headers:{authorization:'Basic '+Buffer.from(cfg.username+':'+cfg.password).toString('base64')},redirects:0});if(r.status!==200)fail(502,'CMS_READ_FAILED');const rows=JSON.parse(r.text);if(!Array.isArray(rows))fail(502,'CMS_INVALID_RESPONSE');
  return {type:cfg.type,page,totalPages:Number(r.headers?.['x-wp-totalpages']||1),items:rows.map(x=>({id:String(x.id),title:x.title?.raw||x.title?.rendered||'',url:x.link,status:x.status,modified:x.modified_gmt,locale:null}))};
 }
 const u=new URL('https://api.webflow.com/v2/collections/'+cfg.collectionId+'/items');u.search=new URLSearchParams({limit:'100',offset:String((page-1)*100)}).toString();
 const r=await requestFn(u.href,{headers:{authorization:'Bearer '+cfg.token},redirects:0});if(r.status!==200)fail(502,'CMS_READ_FAILED');const data=JSON.parse(r.text);
 return {type:cfg.type,page,totalPages:Math.ceil((data.pagination?.total||0)/100),searchScope:'current_page',items:(data.items||[]).filter(x=>!search||String(x.fieldData?.name||'').toLowerCase().includes(search.toLowerCase())).map(x=>({id:x.id,title:x.fieldData?.name||'',slug:x.fieldData?.slug||'',status:x.isDraft?'draft':'available',modified:x.lastUpdated,locale:x.cmsLocaleId}))};
}
export async function publish(ctx,doc,project){
 const {db,job,input,env}=ctx;await access(db,job.project_id,job.actor,'review');
 if(doc.version!==input.documentVersion||doc.status!=='approved'||!doc.reviewedClaims)fail(409,'APPROVED_REVISION_REQUIRED');
 const saved=await get(db,job.project_id,'publication',job.id);
 if(saved){if(['published','draft'].includes(saved.status))return saved;fail(409,'PUBLICATION_RECONCILIATION_REQUIRED');}
 // Prevent a new submission bypassing an uncertain previous publication.
 const unresolved=(await list(db,job.project_id,'publication')).find(p=>p.documentId===doc.id&&['submitting','uncertain'].includes(p.status));if(unresolved)fail(409,'PUBLICATION_RECONCILIATION_REQUIRED');
 const row=await one(db,'SELECT * FROM content_cms WHERE project_id=?',[job.project_id]);if(!row)fail(409,'CMS_NOT_CONFIGURED');const cfg=unseal(row.secret,job.project_id,env);
 let url,headers,payload,method='POST',before=null;
 const slug=input.slug||('airank-'+doc.id);if(!/^[a-z0-9-]{1,150}$/.test(slug))fail(422,'INVALID_SLUG');
 const req=ctx.requestFn||webRequest;
 if(cfg.type==='wordpress'){
  headers={authorization:'Basic '+Buffer.from(cfg.username+':'+cfg.password).toString('base64'),'content-type':'application/json'};
  const kind=input.wpType||'posts';if(!['posts','pages'].includes(kind))fail(422,'INVALID_WORDPRESS_TYPE');url=cfg.baseUrl+'/wp-json/wp/v2/'+kind;
  if(input.remoteId){if(!/^\d+$/.test(String(input.remoteId)))fail(422,'INVALID_REMOTE_ID');url+='/'+input.remoteId;const r=await req(url+'?context=edit',{headers,redirects:0});if(r.status!==200)fail(502,'CMS_READ_FAILED');before=JSON.parse(r.text);
   if(!input.expectedRemoteModified||before.modified_gmt!==input.expectedRemoteModified)fail(409,'CMS_REMOTE_CHANGED');
   if(!owned(before.link,project.identity.ownedDomains)||doc.sourceUrl&&new URL(before.link).pathname!==new URL(doc.sourceUrl).pathname)fail(409,'CMS_DOCUMENT_MISMATCH');
  }else{const r=await req(url+'?context=edit&status=any&slug='+slug,{headers,redirects:0});if(r.status!==200)fail(502,'CMS_READ_FAILED');if(JSON.parse(r.text).length)fail(409,'CMS_SLUG_EXISTS');}
  payload={title:doc.title,content:toHtml(doc.markdown),excerpt:doc.description,status:input.targetStatus,...(!input.remoteId?{slug}:{})};
 }else{
  headers={authorization:'Bearer '+cfg.token,'content-type':'application/json'};url='https://api.webflow.com/v2/collections/'+cfg.collectionId+'/items';
  const fieldData={name:doc.title,slug,[cfg.bodyField]:toHtml(doc.markdown),...(cfg.descriptionField?{[cfg.descriptionField]:doc.description}:{})};
  if(!input.cmsLocaleId||!/^[a-f0-9]{24}$/i.test(input.cmsLocaleId))fail(422,'WEBFLOW_LOCALE_REQUIRED');
  if(input.remoteId){if(!/^[a-f0-9]{24}$/i.test(input.remoteId))fail(422,'INVALID_REMOTE_ID');const r=await req(url+'/'+input.remoteId,{headers,redirects:0});if(r.status!==200)fail(502,'CMS_READ_FAILED');before=JSON.parse(r.text);if(before.lastUpdated!==input.expectedRemoteModified||before.cmsLocaleId!==input.cmsLocaleId)fail(409,'CMS_REMOTE_CHANGED');url+='/'+input.remoteId;method='PATCH';}
  if(input.targetStatus==='publish')url+='/live';payload={cmsLocaleId:input.cmsLocaleId,isArchived:false,isDraft:input.targetStatus==='draft',fieldData};
 }
 const pre={documentId:doc.id,documentVersion:doc.version,channel:cfg.type,status:'submitting',targetStatus:input.targetStatus,slug,remoteId:input.remoteId||null,startedAt:Date.now(),backup:before,contentHash:hash(doc.markdown)};
 await ctx.commit(async tx=>{const current=await get(tx,job.project_id,'document',doc.id);if(current.version!==doc.version||current.status!=='approved')fail(409,'REVISION_CHANGED');await put(tx,job.project_id,'publication',job.id,pre,0,job.actor);});
 let r;try{r=await req(url,{method,headers,body:JSON.stringify(payload),redirects:0});if(r.status<200||r.status>=300)throw Object.assign(Error('CMS_WRITE_FAILED'),{code:'CMS_WRITE_FAILED'});const d=JSON.parse(r.text);
  const publication={...pre,status:input.targetStatus==='publish'?'published':'draft',remoteId:d.id||d.items?.[0]?.id||null,url:d.link||input.publishedUrl||null,publishedAt:input.targetStatus==='publish'?Date.now():null,remoteModified:d.modified_gmt||d.lastUpdated||null};
  if(publication.url){publicUrl(publication.url);if(!owned(publication.url,project.identity.ownedDomains))fail(502,'CMS_URL_MISMATCH');}
  await ctx.commit(tx=>put(tx,job.project_id,'publication',job.id,publication,1,job.actor));return publication;
 }catch(e){await ctx.commit(tx=>put(tx,job.project_id,'publication',job.id,{...pre,status:'uncertain',error:'CHECK_CMS_BEFORE_RETRY'},1,job.actor));throw Object.assign(Error('PUBLICATION_UNCERTAIN'),{code:'PUBLICATION_UNCERTAIN'});}
}
