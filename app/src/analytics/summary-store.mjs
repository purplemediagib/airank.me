import {randomUUID} from 'node:crypto';
import {one,exec,transaction,fail,hash} from '../monitoring/shared.mjs';
import {DEMAND_TTL,GENERATION_TTL,LEASE_MS,MAX_VARIANTS,evidenceMetadata} from './summary-contract.mjs';

export async function demandSummary(db,projectId,key,query,format,now){
 const existing=await one(db,'SELECT * FROM analytics_summary_requests WHERE project_id=? AND query_key=?',[projectId,key]);
 if(existing&&Number(existing.last_requested_at)>=now-60000)return existing;
 // Serialize admission so concurrent cold requests cannot overrun the cap.
 return transaction(db,async tx=>{
  const old=await one(tx,'SELECT * FROM analytics_summary_requests WHERE project_id=? AND query_key=?',[projectId,key]);
  if(old){
   if(Number(old.last_requested_at)<=now-DEMAND_TTL){
    const active=Number((await one(tx,'SELECT COUNT(*) n FROM analytics_summary_requests WHERE project_id=? AND format_version=? AND last_requested_at>?',[projectId,format,now-DEMAND_TTL])).n);
    if(active>=MAX_VARIANTS)fail(429,'ANALYTICS_FILTER_LIMIT');
   }
   if(Number(old.last_requested_at)<now-60000)await exec(tx,'UPDATE analytics_summary_requests SET last_requested_at=? WHERE project_id=? AND query_key=?',[now,projectId,key]);
   return old;
  }
  const count=Number((await one(tx,'SELECT COUNT(*) n FROM analytics_summary_requests WHERE project_id=? AND format_version=? AND last_requested_at>?',[projectId,format,now-DEMAND_TTL])).n);
  if(count>=MAX_VARIANTS)fail(429,'ANALYTICS_FILTER_LIMIT');
  // Expired demand is no longer work. Generations have an independent lifetime,
  // so pinned evidence remains usable until its advertised expiration.
  await exec(tx,'DELETE FROM analytics_summary_requests WHERE project_id=? AND last_requested_at<=? AND (lease_until IS NULL OR lease_until<=?) AND NOT EXISTS (SELECT 1 FROM analytics_summary_generations g WHERE g.project_id=analytics_summary_requests.project_id AND g.query_key=analytics_summary_requests.query_key AND g.expires_at>?)',[projectId,now-DEMAND_TTL,now,now]);
  await exec(tx,`INSERT INTO analytics_summary_requests (project_id,query_key,query_json,format_version,requested_at,last_requested_at,attempts,next_attempt_at) VALUES (?,?,?,?,?,?,0,0)`,[projectId,key,query.toString(),format,now,now]);
  return null;
 });
}
export async function readHead(db,projectId,key){
 return one(db,`SELECT g.*,r.revision current_revision FROM analytics_summary_heads h JOIN analytics_summary_generations g ON g.id=h.generation_id JOIN analytics_project_revisions r ON r.project_id=h.project_id WHERE h.project_id=? AND h.query_key=? AND g.published_at IS NOT NULL`,[projectId,key]);
}
export async function claimSummary(db,format,now){
 return transaction(db,async tx=>{
  const job=await one(tx,`SELECT q.*,r.revision source_revision,p.owner_id FROM analytics_summary_requests q
   JOIN analytics_project_revisions r ON r.project_id=q.project_id JOIN app_projects p ON p.id=q.project_id
   LEFT JOIN analytics_summary_heads h ON h.project_id=q.project_id AND h.query_key=q.query_key
   LEFT JOIN analytics_summary_generations g ON g.id=h.generation_id
   WHERE q.format_version=? AND q.last_requested_at>? AND q.next_attempt_at<=? AND (q.lease_until IS NULL OR q.lease_until<=?)
   AND (q.last_error IS NULL OR q.last_error NOT IN ('INVALID_FILTER','NOT_FOUND','ANALYTICS_PROJECTION_LIMIT') OR q.failed_revision IS NULL OR q.failed_revision<>r.revision)
   AND (g.id IS NULL OR g.source_revision<>r.revision OR g.format_version<>q.format_version OR g.expires_at<=? OR g.generated_at<?)
   ORDER BY COALESCE(g.generated_at,0),q.requested_at,q.project_id,q.query_key LIMIT 1`,[format,now-DEMAND_TTL,now,now,now,Math.floor(now/86400000)*86400000]);
  if(!job)return null;
  const token=randomUUID();
  await exec(tx,'UPDATE analytics_summary_requests SET lease_token=?,lease_until=?,attempts=attempts+1 WHERE project_id=? AND query_key=?',[token,now+LEASE_MS,job.project_id,job.query_key]);
  return {...job,lease_token:token,lease_until:now+LEASE_MS,attempts:Number(job.attempts)+1};
 });
}
export async function renewSummaryLease(db,job,now){
 const r=await exec(db,'UPDATE analytics_summary_requests SET lease_until=? WHERE project_id=? AND query_key=? AND lease_token=? AND lease_until>?',[now+LEASE_MS,job.project_id,job.query_key,job.lease_token,now]);
 return Number(r.rowsAffected)>0;
}
// Only independent, ordered writes are batched, inside an already-acquired
// write transaction. Never parallelize transaction statements with Promise.all.
async function writeBatch(tx,statements){
 if(tx.batch)return tx.batch(statements);
 // Keep compatible with small local adapters; production libSQL has tx.batch.
 const results=[];for(const statement of statements)results.push(await tx.execute(statement));return results;
}
const COMPACT_ROWS=100,COMPACT_BYTES=1024*1024,CHUNK_ROWS=50,CHUNK_BYTES=4*1024*1024;
class PublicationFenceError extends Error{
 constructor(reason){super('ANALYTICS_PUBLICATION_FENCED');this.reason=reason;}
}
function encodedEvidence(evidence,start){
 const rows=evidence.slice(start,start+CHUNK_ROWS).map((e,i)=>{const m=evidenceMetadata(e);return {position:start+i,id:e.id,hash:hash(e),payload:JSON.stringify(e),search:m.search,brands:m.brands,...m};});
 const encoded=JSON.stringify(rows);
 if(Buffer.byteLength(encoded)>CHUNK_BYTES)fail(422,'ANALYTICS_PROJECTION_LIMIT');
 return encoded;
}
function evidenceStatements(id,encoded){
 return [
  {sql:`INSERT INTO analytics_summary_payloads (hash,payload,search_text,brands_json,mentioned,recommended,cited,ordered,first_rank,excluded)
   SELECT json_extract(value,'$.hash'),json_extract(value,'$.payload'),json_extract(value,'$.search'),json_extract(value,'$.brands'),json_extract(value,'$.mentioned'),json_extract(value,'$.recommended'),json_extract(value,'$.cited'),json_extract(value,'$.ordered'),json_extract(value,'$.first'),json_extract(value,'$.excluded') FROM json_each(?) WHERE true ON CONFLICT(hash) DO NOTHING`,args:[encoded]},
  {sql:`INSERT INTO analytics_summary_evidence (generation_id,position,id,payload_hash)
   SELECT ?,json_extract(value,'$.position'),json_extract(value,'$.id'),json_extract(value,'$.hash') FROM json_each(?)`,args:[id,encoded]},
 ];
}
export async function publishSummary(db,job,summary,evidence,clock){
 const now=typeof clock==='function'?clock:()=>clock;
 const id=randomUUID(),json=JSON.stringify(summary),summaryBytes=Buffer.byteLength(json);
 if(evidence.length>50000||summaryBytes>5*1024*1024)fail(422,'ANALYTICS_PROJECTION_LIMIT');
 let guardedLeaseUntil;
 const guarded=async tx=>{
  const current=await one(tx,`SELECT q.lease_token,q.lease_until,r.revision FROM analytics_summary_requests q JOIN analytics_project_revisions r ON r.project_id=q.project_id WHERE q.project_id=? AND q.query_key=?`,[job.project_id,job.query_key]);
  const stamp=now();
  if(!current||current.lease_token!==job.lease_token||Number(current.lease_until)<=stamp)return 'lease_lost';
  if(Number(current.revision)!==Number(job.source_revision)){
   await exec(tx,'UPDATE analytics_summary_requests SET lease_token=NULL,lease_until=NULL,next_attempt_at=?,last_error=NULL WHERE project_id=? AND query_key=? AND lease_token=?',[stamp+1000,job.project_id,job.query_key,job.lease_token]);
   return 'source_changed';
  }
  guardedLeaseUntil=Number(current.lease_until);
  return null;
 };
 const generationStatement=()=>{
  const stamp=now();
  return {sql:`INSERT INTO analytics_summary_generations (id,project_id,query_key,source_revision,format_version,generated_at,expires_at,evidence_count,summary_json,published_at) VALUES (?,?,?,?,?,?,?,?,?,NULL)`,args:[id,job.project_id,job.query_key,job.source_revision,job.format_version,stamp,stamp+LEASE_MS,evidence.length,json]};
 };
 const finish=async tx=>{
  const invalid=await guarded(tx);if(invalid)throw new PublicationFenceError(invalid);
  const count=Number((await one(tx,'SELECT COUNT(*) n FROM analytics_summary_evidence WHERE generation_id=?',[id])).n);
  if(count!==evidence.length)throw Error('INCOMPLETE_ANALYTICS_GENERATION');
  const stamp=now();if(stamp>=guardedLeaseUntil)throw new PublicationFenceError('lease_lost');
  await writeBatch(tx,[
   {sql:'UPDATE analytics_summary_generations SET published_at=?,generated_at=?,expires_at=? WHERE id=?',args:[stamp,stamp,stamp+GENERATION_TTL,id]},
   {sql:`INSERT INTO analytics_summary_heads (project_id,query_key,generation_id) VALUES (?,?,?) ON CONFLICT(project_id,query_key) DO UPDATE SET generation_id=excluded.generation_id`,args:[job.project_id,job.query_key,id]},
   {sql:'UPDATE analytics_summary_requests SET lease_token=NULL,lease_until=NULL,attempts=0,next_attempt_at=0,last_error=NULL,failed_revision=NULL WHERE project_id=? AND query_key=? AND lease_token=?',args:[job.project_id,job.query_key,job.lease_token]},
  ]);
  // A slow batch may outlive its lease even under the writer lock. Throw so
  // both compact and staged finalization roll back the head and request writes.
  if(now()>=guardedLeaseUntil)throw new PublicationFenceError('lease_lost');
  return {published:true,generation:id};
 };
 // A small setup can publish in one bounded write transaction instead of four.
 // Include both copies of each JSON parameter in the byte budget. Encode at most
 // 50 rows at once; abandon the compact path immediately when it exceeds budget.
 // No project/query data survives this call and no source reads are cached.
 let compact=null;
 if(evidence.length<=COMPACT_ROWS&&summaryBytes<=COMPACT_BYTES){
  compact=[];let bytes=summaryBytes;
  for(let start=0;start<evidence.length;start+=CHUNK_ROWS){
   const encoded=encodedEvidence(evidence,start);bytes+=2*Buffer.byteLength(encoded);
   if(bytes>COMPACT_BYTES){compact=null;break;}
   compact.push(encoded);
  }
 }
 let published=false;
 try{
  if(compact){
   const result=await transaction(db,async tx=>{
    const invalid=await guarded(tx);if(invalid)return {published:false,reason:invalid};
    await writeBatch(tx,[generationStatement(),...compact.flatMap(encoded=>evidenceStatements(id,encoded))]);
    return finish(tx);
   });
   published=result.published;return result;
  }
  let reason=await transaction(db,async tx=>{
   const invalid=await guarded(tx);if(invalid)return invalid;
   await tx.execute(generationStatement());
   return null;
  });
  if(reason)return {published:false,reason};
  // Large generations retain bounded staging transactions. Readers cannot see
  // them until the final, short revision-fenced commit. Release the writer lock
  // between chunks so collection and other source writes can still proceed.
  for(let start=0;start<evidence.length;start+=CHUNK_ROWS){
   const encoded=encodedEvidence(evidence,start);
   reason=await transaction(db,async tx=>{
    const invalid=await guarded(tx);if(invalid)return invalid;
    const stamp=now();
    await writeBatch(tx,[...evidenceStatements(id,encoded),
     {sql:'UPDATE analytics_summary_requests SET lease_until=? WHERE project_id=? AND query_key=? AND lease_token=?',args:[stamp+LEASE_MS,job.project_id,job.query_key,job.lease_token]},
     {sql:'UPDATE analytics_summary_generations SET expires_at=? WHERE id=? AND published_at IS NULL',args:[stamp+LEASE_MS,id]},
    ]);
    return null;
   });
   if(reason)return {published:false,reason};
  }
  const result=await transaction(db,finish);
  published=result.published;return result;
 }catch(error){
  if(!(error instanceof PublicationFenceError))throw error;
  // Preserve source-change retry admission after rolling back a fenced final
  // transaction. The fresh guard cannot release another worker's lease.
  if(error.reason==='source_changed')await transaction(db,guarded);
  return {published:false,reason:error.reason};
 }finally{
  if(!published)await exec(db,'DELETE FROM analytics_summary_generations WHERE id=? AND published_at IS NULL',[id]);
 }
}

export async function failSummary(db,job,error,now){
 const allowed=new Set(['INVALID_FILTER','NOT_FOUND','ANALYTICS_PROJECTION_LIMIT']);
 const code=allowed.has(error.code)?error.code:'ANALYTICS_BUILD_FAILED';
 // Never persist exception text, URLs, credentials, provider bodies or answers.
 await exec(db,'UPDATE analytics_summary_requests SET lease_token=NULL,lease_until=NULL,last_error=?,failed_revision=?,next_attempt_at=? WHERE project_id=? AND query_key=? AND lease_token=?',[code,job.source_revision,now+Math.min(300000,3000*2**Math.min(job.attempts,7)),job.project_id,job.query_key,job.lease_token]);
 return code;
}
export async function cleanupSummaries(db,now){
 // One bounded batch per tick; do not purge active generation pages mid-read.
 return transaction(db,async tx=>{
  await exec(tx,'DELETE FROM analytics_summary_generations WHERE id IN (SELECT id FROM analytics_summary_generations WHERE expires_at<=? ORDER BY expires_at LIMIT 20)',[now]);
  await exec(tx,'DELETE FROM analytics_summary_payloads WHERE hash IN (SELECT p.hash FROM analytics_summary_payloads p WHERE NOT EXISTS (SELECT 1 FROM analytics_summary_evidence e WHERE e.payload_hash=p.hash) LIMIT 1000)');
  await exec(tx,'DELETE FROM analytics_summary_requests WHERE last_requested_at<=? AND (lease_until IS NULL OR lease_until<=?) AND NOT EXISTS (SELECT 1 FROM analytics_summary_generations g WHERE g.project_id=analytics_summary_requests.project_id AND g.query_key=analytics_summary_requests.query_key AND g.expires_at>?)',[now-DEMAND_TTL,now,now]);
 });
}
