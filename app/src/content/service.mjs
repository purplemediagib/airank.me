import {access,get,list,put,event,one,exec,fail,hash,transaction,uid,enqueue,jobView,seal} from './store.mjs';
import {id,checksum} from './migration.mjs';
import {documentInput,applyChanges,exportsFor} from './editor.mjs';
import {publicUrl,owned} from './web.mjs';
import {cmsItems} from './publish.mjs';
export const jobKinds=['import','sitemap','audit','research','rewrite','create','opportunities','perception','impact','publish'];
const response=(data,status=200)=>({status,data});
function text(v,max=4000){if(typeof v!=='string'||v.length>max)fail(422,'INVALID_TEXT');return v;}
export async function contentService({db,method,path,body={},query=new URLSearchParams(),userId,env=process.env,now=Date.now}){
 const m=path.match(/^\/v1\/projects\/([A-Za-z0-9-]{1,80})\/content(?:\/(.*))?$/);if(!m)fail(404,'NOT_FOUND');const p=m[1],[area='',item='',action='']= (m[2]||'').split('/');
 const project=await access(db,p,userId);if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)fail(503,'CONTENT_MIGRATION_REQUIRED');
 if(['PATCH','PUT'].includes(method)||area==='documents'&&method==='POST'&&item&&action){if(!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion<0)fail(422,'EXPECTED_VERSION_REQUIRED');}
 const permission=async perm=>access(db,p,userId,perm);const write=fn=>transaction(db,fn);const loadDoc=async()=>{const d=await get(db,p,'document',item);if(!d)fail(404,'NOT_FOUND');return d;};
 if(method==='GET'&&!area)return response({role:project.role,project:{id:p,...project.identity},documents:(await list(db,p,'document')).map(({markdown,original,...d})=>({...d,wordCount:markdown?.split(/\s+/).length||0})),opportunities:await list(db,p,'opportunity'),brand:await get(db,p,'settings','brand'),settings:await get(db,p,'settings','automation'),capabilities:{languages:['en','fi'],cms:['wordpress','webflow'],modelConfigured:!!(env.OPENROUTER_API_KEY&&env.CONTENT_MODEL),googleMappingConfigured:Object.hasOwn(JSON.parse(env.CONTENT_GOOGLE_WORKSPACES_JSON||'{}'),p)}});
 if(area==='documents'){
  if(method==='GET'&&!item)return response(await list(db,p,'document'));
  if(method==='POST'&&!item){await permission('edit');const value=documentInput(body);if(value.sourceUrl){publicUrl(value.sourceUrl);if(!owned(value.sourceUrl,project.identity.ownedDomains))fail(422,'OWNED_URL_REQUIRED');}return response(await write(tx=>put(tx,p,'document',uid(),value,0,userId,now())),201);}
  const d=await loadDoc();
  if(method==='GET'&&action==='export')return response(exportsFor(d));
  if(method==='GET'&&action==='revisions')return response((await exec(db,'SELECT version,payload,actor,created_at FROM content_revisions WHERE project_id=? AND document_id=? ORDER BY version DESC',[p,item])).rows.map(r=>({...r,payload:JSON.parse(r.payload)})));
  if(method==='GET'&&!action)return response(d);
  if(method==='PATCH'&&!action){await permission('edit');const next={...d,...documentInput({...d,...body})};if(next.sourceUrl&&!owned(next.sourceUrl,project.identity.ownedDomains))fail(422,'OWNED_URL_REQUIRED');return response(await write(tx=>put(tx,p,'document',item,next,body.expectedVersion,userId,now())));}
  if(method==='POST'&&action==='restore'){await permission('edit');const r=await one(db,'SELECT payload FROM content_revisions WHERE project_id=? AND document_id=? AND version=?',[p,item,body.revision]);if(!r)fail(404,'NOT_FOUND');return response(await write(tx=>put(tx,p,'document',item,{...JSON.parse(r.payload),status:'draft',reviewedClaims:false},body.expectedVersion,userId,now())));}
  if(method==='POST'&&action==='review'){await permission('review');if(!['in_review','approved','changes_requested'].includes(body.status))fail(422,'INVALID_REVIEW_STATUS');if(body.status==='approved'&&body.factsChecked!==true)fail(422,'FACT_REVIEW_REQUIRED');
   return response(await write(tx=>put(tx,p,'document',item,{...d,status:body.status,reviewedClaims:body.status==='approved',review:{actor:userId,at:now(),note:text(body.note||'')}},body.expectedVersion,userId,now())));}
  if(method==='POST'&&action==='apply'){await permission('edit');const job=await one(db,"SELECT * FROM content_jobs WHERE project_id=? AND id=? AND status='completed'",[p,body.jobId]);if(!job)fail(404,'NOT_FOUND');const input=JSON.parse(job.input),result=JSON.parse(job.result);if(input.documentId!==item||input.documentVersion!==d.version)fail(409,'REVISION_CHANGED');
   const next=job.kind==='rewrite'?{...d,markdown:applyChanges(d.markdown,result.output.changes,body.changeIds)}:job.kind==='create'?{...d,...documentInput({...d,...result.output,locale:d.locale})}:null;
   if(!next)fail(422,'JOB_NOT_APPLICABLE');next.status='draft';next.reviewedClaims=false;next.contentHash=hash(next.markdown);return response(await write(tx=>put(tx,p,'document',item,next,body.expectedVersion,userId,now())));}
  if(method==='POST'&&action==='published'){await permission('review');if(d.status!=='approved'||body.expectedVersion!==d.version)fail(409,'APPROVED_REVISION_REQUIRED');const url=publicUrl(body.url);if(!owned(url,project.identity.ownedDomains))fail(422,'OWNED_URL_REQUIRED');
   return response(await write(async tx=>{const pub=await put(tx,p,'publication',uid(),{documentId:item,documentVersion:d.version,url,publishedAt:now(),status:'published',channel:'manual',baselineGroup:body.baselineGroup||null,verification:'user_confirmed'},0,userId,now());return pub;}),201);}
 }
 if(area==='brand'){
  if(method==='GET')return response(await get(db,p,'settings','brand'));
  if(method==='PUT'){await permission('manage');if(!Array.isArray(body.facts)||body.facts.length>100)fail(422,'INVALID_FACTS');const facts=body.facts.map(f=>({id:text(f.id,100),statement:text(f.statement,2000),sourceUrl:f.sourceUrl?publicUrl(f.sourceUrl):null,verified:f.verified===true,verifiedBy:f.verified===true?userId:null,verifiedAt:f.verified===true?now():null}));if(new Set(facts.map(f=>f.id)).size!==facts.length)fail(422,'DUPLICATE_FACT');
   return response(await write(tx=>put(tx,p,'settings','brand',{facts,tone:text(body.tone||'',2000),audience:text(body.audience||'',2000),prohibitedClaims:text(body.prohibitedClaims||'',4000)},body.expectedVersion,userId,now())));}
 }
 if(area==='settings'){
  if(method==='GET')return response(await get(db,p,'settings','automation'));
  if(method==='PUT'){await permission('manage');if(!['en','fi'].includes(body.locale)||!Number.isInteger(body.refreshHours)||body.refreshHours<24||body.refreshHours>720)fail(422,'INVALID_AUTOMATION_SETTINGS');return response(await write(tx=>put(tx,p,'settings','automation',{locale:body.locale,refreshHours:body.refreshHours,enabled:body.enabled===true,nextRunAt:now()},body.expectedVersion,userId,now())));}
 }
 if(area==='jobs'){
  if(method==='GET'&&!item)return response((await exec(db,'SELECT * FROM content_jobs WHERE project_id=? ORDER BY created_at DESC LIMIT 200',[p])).rows.map(jobView));
  if(method==='GET'&&item){const j=await one(db,'SELECT * FROM content_jobs WHERE project_id=? AND id=?',[p,item]);if(!j)fail(404,'NOT_FOUND');return response(jobView(j));}
  if(method==='POST'&&!item){await permission(body.kind==='publish'?'review':'edit');if(!jobKinds.includes(body.kind))fail(422,'INVALID_JOB_KIND');const input=body.input||{};
   if(!input||typeof input!=='object'||Array.isArray(input)||JSON.stringify(input).length>200000)fail(422,'INVALID_INPUT');
   input.locale=input.locale||project.identity.promptLanguage||'en';if(!['en','fi'].includes(input.locale))fail(422,'UNSUPPORTED_LOCALE');
   if(['import','sitemap'].includes(body.kind)){input.url=publicUrl(input.url);if(!owned(input.url,project.identity.ownedDomains))fail(422,'OWNED_URL_REQUIRED');}
   if(input.sourceUrls){if(!Array.isArray(input.sourceUrls)||input.sourceUrls.length>12)fail(422,'TOO_MANY_SOURCES');input.sourceUrls=input.sourceUrls.map(publicUrl);}
   if(['audit','rewrite','publish','impact'].includes(body.kind)&&!input.documentId)fail(422,'DOCUMENT_REQUIRED');
   if(input.documentId){const d=await get(db,p,'document',input.documentId);if(!d)fail(404,'NOT_FOUND');if(input.documentVersion!==d.version)fail(409,'REVISION_CHANGED');if(body.kind==='publish'&&(d.status!=='approved'||!d.reviewedClaims))fail(409,'APPROVED_REVISION_REQUIRED');}
   if(body.kind==='create'&&!input.topic)fail(422,'TOPIC_REQUIRED');
   if(body.kind==='publish'&&!['draft','publish'].includes(input.targetStatus))fail(422,'PUBLISH_STATUS_REQUIRED');
   return response(await write(tx=>enqueue(tx,p,userId,body.kind,input,body.submissionId,now())),202);
  }
  if(method==='POST'&&item&&['cancel','retry'].includes(action)){await permission('edit');return response(await write(async tx=>{const j=await one(tx,'SELECT * FROM content_jobs WHERE id=? AND project_id=?',[item,p]);if(!j)fail(404,'NOT_FOUND');if(j.kind==='publish')fail(409,'PUBLICATION_RECONCILIATION_REQUIRED');
   if(action==='cancel'){if(!['queued','running'].includes(j.status))fail(409,'JOB_NOT_ACTIVE');await exec(tx,"UPDATE content_jobs SET status='cancelled',claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=?",[now(),item]);}
   else{if(j.status!=='failed')fail(409,'JOB_NOT_FAILED');await exec(tx,"UPDATE content_jobs SET status='queued',attempt=0,error=NULL,available_at=?,updated_at=? WHERE id=?",[now(),now(),item]);}return jobView(await one(tx,'SELECT * FROM content_jobs WHERE id=?',[item]));}));}
 }
 if(area==='bulk'&&method==='POST'){await permission('edit');if(!Array.isArray(body.items)||body.items.length<1||body.items.length>50)fail(422,'INVALID_BULK');return response(await write(async tx=>{const out=[];for(const [i,b] of body.items.entries()){if(!['audit','research','rewrite'].includes(b.kind))fail(422,'INVALID_BULK_KIND');const d=await get(tx,p,'document',b.documentId);if(!d||d.version!==b.documentVersion)fail(409,'REVISION_CHANGED');out.push(await enqueue(tx,p,userId,b.kind,{documentId:d.id,documentVersion:d.version,locale:d.locale},body.submissionId+'-'+i,now()));}return out;}),202);}
 if(area==='comments'){
  if(method==='GET')return response((await list(db,p,'comment')).filter(c=>!query.get('documentId')||c.documentId===query.get('documentId')));
  if(method==='POST'){if(project.role==='viewer')fail(403,'CONTENT_PERMISSION_DENIED');await access(db,p,userId,project.role==='reviewer'?'review':'edit');if(!await get(db,p,'document',body.documentId))fail(404,'NOT_FOUND');return response(await write(tx=>put(tx,p,'comment',uid(),{documentId:body.documentId,documentVersion:body.documentVersion,body:text(body.text),actor:userId,resolved:false},0,userId,now())),201);}
  if(method==='PATCH'){await permission('review');const c=await get(db,p,'comment',item);if(!c)fail(404,'NOT_FOUND');return response(await write(tx=>put(tx,p,'comment',item,{...c,resolved:body.resolved===true},body.expectedVersion,userId,now())));}
 }
 if(area==='access'){
  await permission('manage');if(method==='GET')return response((await exec(db,'SELECT user_id,role FROM content_members WHERE project_id=?',[p])).rows);
  if(method==='PUT'){if(!['viewer','editor','reviewer','remove'].includes(body.role)||typeof body.email!=='string')fail(422,'INVALID_MEMBER');const u=await one(db,'SELECT id FROM users WHERE lower(email)=lower(?)',[body.email]);if(!u)fail(422,'EXISTING_ACCOUNT_REQUIRED');if(u.id===project.owner_id)fail(422,'OWNER_ROLE_FIXED');
   await write(async tx=>{if(body.role==='remove')await exec(tx,'DELETE FROM content_members WHERE project_id=? AND user_id=?',[p,u.id]);else await exec(tx,'INSERT INTO content_members VALUES (?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role',[p,u.id,body.role]);await event(tx,p,userId,'access.updated',{userId:u.id,role:body.role},now());});return response({ok:true});}
 }
 if(area==='cms'){
  if(method==='GET'&&item==='items'){await permission('review');return response(await cmsItems({db,projectId:p,query,env}));}
  await permission('manage');const old=await one(db,'SELECT version,summary FROM content_cms WHERE project_id=?',[p]);
  if(method==='GET')return response(old?{version:old.version,...JSON.parse(old.summary)}:null);
  if(method==='PUT'){if(!['wordpress','webflow'].includes(body.type))fail(422,'INVALID_CMS');const cfg={type:body.type};
   if(body.type==='wordpress'){cfg.baseUrl=publicUrl(body.baseUrl).replace(/\/$/,'');if(!owned(cfg.baseUrl,project.identity.ownedDomains))fail(422,'OWNED_URL_REQUIRED');cfg.username=text(body.username,200);cfg.password=text(body.password,1000);if(!cfg.username||!cfg.password)fail(422,'CMS_CREDENTIALS_REQUIRED');}
   else{cfg.token=text(body.token,2000);cfg.collectionId=text(body.collectionId,100);cfg.bodyField=text(body.bodyField,100);cfg.descriptionField=text(body.descriptionField||'',100);if(!/^[a-f0-9]{24}$/i.test(cfg.collectionId)||!cfg.token||!cfg.bodyField)fail(422,'INVALID_WEBFLOW_CONFIG');}
   const summary={type:cfg.type,baseUrl:cfg.baseUrl||null,collectionId:cfg.collectionId||null,bodyField:cfg.bodyField||null,descriptionField:cfg.descriptionField||null,configured:true};await write(async tx=>{const r=await one(tx,'SELECT version FROM content_cms WHERE project_id=?',[p]);if(Number(r?.version||0)!==body.expectedVersion)fail(409,'VERSION_CONFLICT');await exec(tx,'INSERT INTO content_cms VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET version=excluded.version,secret=excluded.secret,summary=excluded.summary',[p,body.expectedVersion+1,seal(cfg,p,env),JSON.stringify(summary)]);await event(tx,p,userId,'cms.configured',summary,now());});return response({...summary,version:body.expectedVersion+1});}
 }
 if(['sources','opportunities','publications','assessments'].includes(area)){
  const kind={sources:'source',opportunities:'opportunity',publications:'publication',assessments:'assessment'}[area];if(method==='GET')return response(item?await get(db,p,kind,item):await list(db,p,kind));
  if(area==='opportunities'&&method==='PATCH'){await permission('edit');const o=await get(db,p,kind,item);if(!o)fail(404,'NOT_FOUND');if(!['new','in_progress','completed','dismissed'].includes(body.status))fail(422,'INVALID_STATUS');return response(await write(tx=>put(tx,p,kind,item,{...o,status:body.status,note:text(body.note||'')},body.expectedVersion,userId,now())));}
  if(area==='publications'&&action==='reconcile'&&method==='POST'){await permission('review');if(body.verifiedInCms!==true||!['published','draft','not_published'].includes(body.status)||!Number.isInteger(body.expectedVersion))fail(422,'CMS_VERIFICATION_REQUIRED');const pub=await get(db,p,kind,item);if(!pub||!['uncertain','submitting'].includes(pub.status))fail(409,'PUBLICATION_NOT_UNCERTAIN');const url=body.status==='published'?publicUrl(body.url):null;if(url&&!owned(url,project.identity.ownedDomains))fail(422,'OWNED_URL_REQUIRED');return response(await write(async tx=>{const result=await put(tx,p,kind,item,{...pub,status:body.status,url,remoteId:body.remoteId||pub.remoteId,publishedAt:body.status==='published'?now():null,reconciledBy:userId,reconciledAt:now(),verification:'user_confirmed_in_cms',note:text(body.note||'')},body.expectedVersion,userId,now());await exec(tx,"UPDATE content_jobs SET status='completed',result=?,error=NULL,claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND project_id=? AND status IN ('uncertain','failed')",[JSON.stringify(result),now(),item,p]);return result;}));}
 }
 if(area==='usage'&&method==='GET'){await permission('manage');return response((await exec(db,'SELECT day,COUNT(*) calls,SUM(COALESCE(actual_usd,reserved_usd)) accountedUsd,SUM(CASE WHEN actual_usd IS NULL THEN 1 ELSE 0 END) estimatedCalls,SUM(prompt_tokens) inputTokens,SUM(completion_tokens) outputTokens FROM content_usage WHERE project_id=? GROUP BY day ORDER BY day DESC LIMIT 90',[p])).rows);}
 if(area==='events'&&method==='GET')return response((await exec(db,'SELECT actor,kind,payload,created_at FROM content_events WHERE project_id=? ORDER BY created_at DESC LIMIT 200',[p])).rows.map(r=>({...r,payload:JSON.parse(r.payload)})));
 fail(405,'METHOD_NOT_ALLOWED');
}
