import {requireProject} from '../common/access.mjs';
import {one,exec,fail} from '../monitoring/shared.mjs';
import {id,checksum} from './summary-migration.mjs';
import {canonicalQuery,queryKey,formatVersion,evidenceSelection,cursorFor,summaryVersion} from './summary-contract.mjs';
import {demandSummary,readHead} from './summary-store.mjs';

export async function assertSummaryReady(db,env){
 if(env.AIRANK_ANALYTICS_SUMMARY_ENABLED!=='true')fail(404,'NOT_FOUND');
 const has=await one(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='app_migrations'");
 if(!has||(await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)fail(503,'ANALYTICS_NOT_CONFIGURED');
}
const metadata=(g,now)=>({schemaVersion:summaryVersion,state:'ready',generation:g.id,sourceRevision:Number(g.source_revision),generatedAt:Number(g.generated_at),expiresAt:Number(g.expires_at),isStale:Number(g.source_revision)!==Number(g.current_revision)||Number(g.generated_at)<Math.floor(now/86400000)*86400000,evidenceCount:Number(g.evidence_count)});
export async function summaryService({db,path,userId,query=new URLSearchParams(),env=process.env,now=Date.now}){
 const projectId=path.split('/')[3];
 await requireProject(db,projectId,userId); // Never serve a warm cache before current authorization.
 await assertSummaryReady(db,env);
 const q=canonicalQuery(query),format=formatVersion(env),key=queryKey(q,format),stamp=now();
 let g=await readHead(db,projectId,key);
 const fresh=g&&Number(g.expires_at)>stamp&&g.format_version===format;
 // Reads only enqueue deterministic projection of already stored data; never a
 // collection/provider job. Active demand also drives refresh after invalidation.
 const request=await demandSummary(db,projectId,key,q,format,stamp);
 if(fresh)return {status:200,headers:{'cache-control':'private, no-store'},data:{...JSON.parse(g.summary_json),readModel:metadata(g,stamp)}};
 if(request?.last_error==='ANALYTICS_BUILD_FAILED')fail(503,'ANALYTICS_BUILD_FAILED');
 if(request?.last_error==='INVALID_FILTER')fail(422,'INVALID_FILTER');
 if(request?.last_error==='NOT_FOUND')fail(404,'NOT_FOUND');
 if(request?.last_error==='ANALYTICS_PROJECTION_LIMIT')fail(422,'ANALYTICS_PROJECTION_LIMIT');
 return {status:202,headers:{'retry-after':'3','cache-control':'private, no-store'},data:{state:'preparing',retryAfterSeconds:3,readModel:{schemaVersion:summaryVersion,state:'preparing',isStale:false}}};
}
export async function summaryEvidenceService(context){
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
