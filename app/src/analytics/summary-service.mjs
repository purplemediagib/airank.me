import {requireProject} from '../common/access.mjs';
import {one,exec,fail} from '../monitoring/shared.mjs';
import {id,checksum} from './summary-migration.mjs';
import {canonicalQuery,queryKey,formatVersion,evidenceSelection,cursorFor,summaryVersion} from './summary-contract.mjs';
import {demandSummary,readHead} from './summary-store.mjs';
import {savedSnapshot,select} from './summary-read.mjs';
import {assertion,CLOCK_SQL,LIMITS} from './summary-plans.mjs';

export async function assertSummaryReady(db,env){
 if(env.AIRANK_ANALYTICS_SUMMARY_ENABLED!=='true')fail(404,'NOT_FOUND');
 const has=await one(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='app_migrations'");
 if(!has||(await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)fail(503,'ANALYTICS_NOT_CONFIGURED');
}
const metadata=(g,now)=>({schemaVersion:summaryVersion,state:'ready',generation:g.id,sourceRevision:Number(g.source_revision),generatedAt:Number(g.generated_at),expiresAt:Number(g.expires_at),isStale:Number(g.source_revision)!==Number(g.current_revision)||Number(g.generated_at)<Math.floor(now/86400000)*86400000,evidenceCount:Number(g.evidence_count)});
export async function summaryService({db,path,userId,query=new URLSearchParams(),env=process.env,now=Date.now}){
 if(db.summaryAtomic)return fixedSummary({db,path,userId,query,env});
 const projectId=path.split('/')[3];
 await requireProject(db,projectId,userId); // Never serve a warm cache before current authorization.
 await assertSummaryReady(db,env);
 const q=canonicalQuery(query),format=formatVersion(env),key=queryKey(q,format),stamp=now();
 let g=await readHead(db,projectId,key);
 const fresh=g&&Number(g.expires_at)>stamp&&g.format_version===format;
 // Reads only enqueue deterministic projection of already stored data; never a
 // collection/provider job. Active demand also drives refresh after invalidation.
 const request=await demandSummary(db,projectId,key,q,format,stamp);
 if(request?.last_error==='ANALYTICS_PUBLICATION_UNKNOWN'&&!fresh)fail(503,'ANALYTICS_PUBLICATION_UNKNOWN');
 if(fresh)return {status:200,headers:{'cache-control':'private, no-store'},data:{...JSON.parse(g.summary_json),readModel:{...metadata(g,stamp),...(request?.last_error==='ANALYTICS_PUBLICATION_UNKNOWN'?{isStale:true,refreshState:'paused'}:{})}}};
 if(request?.last_error==='ANALYTICS_BUILD_FAILED')fail(503,'ANALYTICS_BUILD_FAILED');
 if(request?.last_error==='INVALID_FILTER')fail(422,'INVALID_FILTER');
 if(request?.last_error==='NOT_FOUND')fail(404,'NOT_FOUND');
 if(request?.last_error==='ANALYTICS_PROJECTION_LIMIT')fail(422,'ANALYTICS_PROJECTION_LIMIT');
 return {status:202,headers:{'retry-after':'3','cache-control':'private, no-store'},data:{state:'preparing',retryAfterSeconds:3,readModel:{schemaVersion:summaryVersion,state:'preparing',isStale:false}}};
}
export async function summaryEvidenceService(context){
 if(context.db.summaryAtomic)return fixedEvidence(context);
 const tx=await context.db.transaction('read');
 try{const result=await readEvidence({...context,db:tx});await tx.commit();return result;}catch(error){await tx.rollback();throw error;}finally{tx.close();}
}
const evidenceJoin='FROM analytics_summary_evidence e JOIN analytics_summary_payloads p ON p.hash=e.payload_hash';
async function readEvidence({db,path,userId,query=new URLSearchParams(),env=process.env,now=Date.now}){
 const projectId=path.split('/')[3],itemId=path.split('/')[6];
 await requireProject(db,projectId,userId);
 await assertSummaryReady(db,env);
 const s=evidenceSelection(query),stamp=now(),format=formatVersion(env);
 const g=await one(db,`SELECT g.*,r.revision current_revision FROM analytics_summary_generations g JOIN analytics_project_revisions r ON r.project_id=g.project_id WHERE g.id=? AND g.project_id=? AND g.published_at IS NOT NULL`,[s.generation,projectId]);
 if(!g)fail(404,'NOT_FOUND');
 if(Number(g.expires_at)<=stamp||g.format_version!==format)fail(409,'ANALYTICS_GENERATION_EXPIRED');
 const total=Number((await one(db,`SELECT COUNT(*) n ${evidenceJoin} WHERE ${s.where}`,s.args)).n);
 const meta=metadata(g,stamp);
 if(itemId){
  const row=await one(db,`SELECT e.position,p.payload ${evidenceJoin} WHERE ${s.where} AND e.id=?`,[...s.args,itemId]);
  if(!row)fail(404,'NOT_FOUND');
  const [rank,previous,next]=await Promise.all([
   one(db,`SELECT COUNT(*) n ${evidenceJoin} WHERE ${s.where} AND position<?`,[...s.args,row.position]),
   one(db,`SELECT e.id ${evidenceJoin} WHERE ${s.where} AND position<? ORDER BY position DESC LIMIT 1`,[...s.args,row.position]),
   one(db,`SELECT e.id ${evidenceJoin} WHERE ${s.where} AND position>? ORDER BY position LIMIT 1`,[...s.args,row.position]),
  ]);
  const index=Number(rank.n),pageStart=Math.floor(index/s.pageSize)*s.pageSize;
  const beforePage=pageStart?await one(db,`SELECT position ${evidenceJoin} WHERE ${s.where} ORDER BY position LIMIT 1 OFFSET ?`,[...s.args,pageStart-1]):null;
  return {status:200,data:{item:JSON.parse(row.payload),index,total,prevId:previous?.id||null,nextId:next?.id||null,pageCursor:beforePage?cursorFor(s.key,Number(beforePage.position)):null,generation:s.generation,readModel:meta}};
 }
 const rows=(await exec(db,`SELECT e.position,p.payload ${evidenceJoin} WHERE ${s.where} AND position>? ORDER BY position LIMIT ?`,[...s.args,s.after,s.pageSize+1])).rows;
 const more=rows.length>s.pageSize,visible=rows.slice(0,s.pageSize);
 const offset=s.after<0?0:Number((await one(db,`SELECT COUNT(*) n ${evidenceJoin} WHERE ${s.where} AND position<=?`,[...s.args,s.after])).n);
 const previousStart=Math.max(0,offset-s.pageSize);
 const beforePrevious=previousStart?await one(db,`SELECT position ${evidenceJoin} WHERE ${s.where} ORDER BY position LIMIT 1 OFFSET ?`,[...s.args,previousStart-1]):null;
 return {status:200,data:{items:visible.map(r=>JSON.parse(r.payload)),previousCursor:beforePrevious?cursorFor(s.key,Number(beforePrevious.position)):null,generation:s.generation,offset,total,pageSize:s.pageSize,nextCursor:more?cursorFor(s.key,Number(visible.at(-1).position)):null,hasMore:more,readModel:meta}};
}

async function fixedSummary({db,path,userId,query,env}){
 const projectId=path.split('/')[3],q=canonicalQuery(query),format=formatVersion(env),key=queryKey(q,format);
 const snapshot=await savedSnapshot(db,projectId,userId,env,[
  select('head',`SELECT g.*,r.revision current_revision FROM analytics_summary_heads h JOIN analytics_summary_generations g ON g.id=h.generation_id AND g.project_id=h.project_id AND g.query_key=h.query_key JOIN analytics_project_revisions r ON r.project_id=h.project_id WHERE h.project_id=? AND h.query_key=? AND g.published_at IS NOT NULL`,[projectId,key]),
  select('request','SELECT last_error FROM analytics_summary_requests WHERE project_id=? AND query_key=?',[projectId,key])
 ]);
 const {stamp}=snapshot,g=validGeneration(readOne(snapshot.rows('head'),true),{project_id:projectId,query_key:key});
 const summary=g?readObject(g.summary_json):null;
 let request,error=readError(readOne(snapshot.rows('request'),true)?.last_error);
 try{request=await demandSummary(db,projectId,key,q,format,stamp);error=readError(request?.last_error)||error;}
 catch(e){if(e.code!=='ANALYTICS_PUBLICATION_QUARANTINED')throw e;error='ANALYTICS_PUBLICATION_UNKNOWN';}
 if(error?.startsWith('ANALYTICS_PUBLICATION_UNKNOWN'))error='ANALYTICS_PUBLICATION_UNKNOWN';
 if(g&&Number(g.expires_at)>stamp&&g.format_version===format)return {status:200,headers:{'cache-control':'private, no-store'},data:{...summary,readModel:{...metadata(g,stamp),...(error==='ANALYTICS_PUBLICATION_UNKNOWN'?{isStale:true,refreshState:'paused'}:{})}}};
 const errors={ANALYTICS_PUBLICATION_UNKNOWN:503,ANALYTICS_BUILD_FAILED:503,INVALID_FILTER:422,NOT_FOUND:404,ANALYTICS_PROJECTION_LIMIT:422};
 if(errors[error])fail(errors[error],error);
 return {status:202,headers:{'retry-after':'3','cache-control':'private, no-store'},data:{state:'preparing',retryAfterSeconds:3,readModel:{schemaVersion:summaryVersion,state:'preparing',isStale:false}}};
}
async function fixedEvidence({db,path,userId,query=new URLSearchParams(),env=process.env}){
 const projectId=path.split('/')[3],itemId=path.split('/')[6],s=evidenceSelection(query),format=formatVersion(env);
 // A materialized filtered relation supplies ranks and neighbours without a
 // JS-dependent follow-up read. All values come from the same SQLite snapshot.
 const filtered=`WITH filtered AS (SELECT e.id,e.position,e.payload_hash,ROW_NUMBER() OVER (ORDER BY e.position)-1 idx ${evidenceJoin} WHERE ${s.where})`;
 const reads=[assertion('generation_missing','EXISTS(SELECT 1 FROM analytics_summary_generations WHERE id=? AND project_id=? AND published_at IS NOT NULL)',[s.generation,projectId]),assertion('generation_expired',`EXISTS(SELECT 1 FROM analytics_summary_generations WHERE id=? AND project_id=? AND expires_at>${CLOCK_SQL} AND format_version=?)`,[s.generation,projectId,format]),select('generation',`SELECT g.*,r.revision current_revision FROM analytics_summary_generations g JOIN analytics_project_revisions r ON r.project_id=g.project_id WHERE g.id=? AND g.project_id=? AND g.published_at IS NOT NULL`,[s.generation,projectId]),select('total',`SELECT COUNT(*) n ${evidenceJoin} WHERE ${s.where}`,s.args)];
 if(itemId){
  reads.push(select('item',`${filtered} SELECT f.id,f.position,(SELECT payload FROM analytics_summary_payloads WHERE hash=f.payload_hash) payload,f.idx,(SELECT id FROM filtered WHERE idx=f.idx-1) prev_id,(SELECT id FROM filtered WHERE idx=f.idx+1) next_id,(SELECT position FROM filtered WHERE idx=CAST(f.idx / ? AS INTEGER)*?-1) before_page FROM filtered f WHERE f.id=?`,[...s.args,s.pageSize,s.pageSize,itemId]));
 }else{
  reads.push(select('items',`${filtered} SELECT id,position,(SELECT payload FROM analytics_summary_payloads WHERE hash=filtered.payload_hash) payload FROM filtered WHERE position>? ORDER BY position LIMIT ?`,[...s.args,s.after,s.pageSize+1]));
  reads.push(select('page',`${filtered}, page AS (SELECT COUNT(*) offset FROM filtered WHERE position<=?) SELECT offset,(SELECT position FROM filtered WHERE idx=MAX(0,page.offset-?)-1) before_previous FROM page`,[...s.args,s.after,s.pageSize]));
 }
 const {rows,stamp}=await savedSnapshot(db,projectId,userId,env,reads),g=validGeneration(readOne(rows('generation'),true),{id:s.generation,project_id:projectId});
 if(!g)fail(404,'NOT_FOUND');
 if(Number(g.expires_at)<=stamp||g.format_version!==format)fail(409,'ANALYTICS_GENERATION_EXPIRED');
 const total=readInteger(readOne(rows('total')).n,0,g.evidence_count),meta=metadata(g,stamp);
 if(itemId){
  const r=readOne(rows('item'),true);if(!r)fail(404,'NOT_FOUND');
  const index=readInteger(r.idx,0,total-1),position=readInteger(r.position,index,g.evidence_count-1),item=readEvidenceObject(r,itemId);
  const previous=readId(r.prev_id,index===0),next=readId(r.next_id,index===total-1);
  const before=readPosition(r.before_page,Math.floor(index/s.pageSize)===0,position-1);
  return {status:200,data:{item,index,total,prevId:previous,nextId:next,pageCursor:before===null?null:cursorFor(s.key,before),generation:s.generation,readModel:meta}};
 }
 const page=readOne(rows('page')),items=rows('items'),offset=readInteger(page.offset,0,total);
 if(items.length!==Math.min(s.pageSize+1,total-offset))fail(503,'ANALYTICS_READ_UNAVAILABLE');
 let last=s.after;
 const decoded=items.map(r=>{last=readInteger(r.position,last+1,g.evidence_count-1);return readEvidenceObject(r);});
 const before=readPosition(page.before_previous,offset<=s.pageSize,s.after-1),more=items.length>s.pageSize,visible=items.slice(0,s.pageSize);
 return {status:200,data:{items:decoded.slice(0,s.pageSize),previousCursor:before===null?null:cursorFor(s.key,before),generation:s.generation,offset,total,pageSize:s.pageSize,nextCursor:more?cursorFor(s.key,visible.at(-1).position):null,hasMore:more,readModel:meta}};
}

function readInteger(n,min=0,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(n)||n<min||n>max)fail(503,'ANALYTICS_READ_UNAVAILABLE');return n;}
function readOne(rows,optional=false){if(!Array.isArray(rows)||rows.length>1||(!optional&&rows.length!==1))fail(503,'ANALYTICS_READ_UNAVAILABLE');return rows[0];}
function readObject(json){try{if(typeof json!=='string')throw Error();const x=JSON.parse(json);if(x&&typeof x==='object'&&!Array.isArray(x))return x;}catch{}fail(503,'ANALYTICS_READ_UNAVAILABLE');}
function readError(error){if(error===undefined||error===null)return error;if(typeof error!=='string')fail(503,'ANALYTICS_READ_UNAVAILABLE');return error;}
function readId(id,isNull=false){if(isNull){if(id!==null)fail(503,'ANALYTICS_READ_UNAVAILABLE');return null;}if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(id))fail(503,'ANALYTICS_READ_UNAVAILABLE');return id;}
function readPosition(position,isNull,max){if(isNull){if(position!==null)fail(503,'ANALYTICS_READ_UNAVAILABLE');return null;}return readInteger(position,0,max);}
function readEvidenceObject(row,expectedId){const id=readId(row.id),item=readObject(row.payload);if(item.id!==id||(expectedId!==undefined&&id!==expectedId))fail(503,'ANALYTICS_READ_UNAVAILABLE');return item;}
function validGeneration(g,scope){
 if(!g)return g;
 readInteger(g.current_revision,1);readInteger(g.source_revision,1,g.current_revision);
 for(const k of ['generated_at','expires_at','published_at'])readInteger(g[k],1);
 readInteger(g.evidence_count,0,LIMITS.rows);
 for(const k of ['id','project_id','query_key','format_version','summary_json'])if(typeof g[k]!=='string'||!g[k])fail(503,'ANALYTICS_READ_UNAVAILABLE');
 if(!/^[a-zA-Z0-9-]{1,80}$/.test(g.id)||!/^[a-zA-Z0-9-]{1,80}$/.test(g.project_id)||!Object.entries(scope).every(([k,v])=>g[k]===v))fail(503,'ANALYTICS_READ_UNAVAILABLE');
 return g;
}
