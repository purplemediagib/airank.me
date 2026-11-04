// Fixed-stream publication plans. No network or environment access.
import {createHash} from 'node:crypto';
import {evidenceMetadata,LEASE_MS,GENERATION_TTL} from './summary-contract.mjs';
export {LEASE_MS};
export const TTL=GENERATION_TTL;
export const CLOCK_SQL="(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
export const LIMITS={rows:50000,summary:5*1024*1024,compactRows:100,compactBytes:1024*1024,chunkRows:50,chunkBytes:4*1024*1024,wireBytes:36*1024*1024};
export const statement=(label,sql,args=[],want_rows=false)=>({label,sql,args,want_rows});
export const assertion=(label,predicate,args=[])=>statement(label,`SELECT CASE WHEN COALESCE((${predicate}),0) THEN 1 ELSE abs(-9223372036854775808) END AS asserted`,args,true);
export const change=(label)=>assertion(label,'changes()=1');
const validClock=`typeof(${CLOCK_SQL})='integer' AND ${CLOCK_SQL}>0 AND ${CLOCK_SQL}<=9007199254740991`;
const notExpired=(D)=>assertion('lease_deadline',`${validClock} AND ${CLOCK_SQL}<?`,[D]);
const digest=e=>createHash('sha256').update(JSON.stringify(e)).digest('hex');
function validJob(j,D){
 for(const x of [j.project_id,j.query_key,j.lease_token,j.format_version])if(typeof x!=='string'||!x)throw Error('INVALID_JOB');
 if(!Number.isSafeInteger(j.source_revision)||j.source_revision<1||!Number.isSafeInteger(D)||D<1)throw Error('INVALID_JOB');
}
export function encodeChunk(evidence,start){
 const rows=evidence.slice(start,start+LIMITS.chunkRows).map((e,i)=>{
  if(!e||typeof e.id!=='string'||!e.id)throw Error('INVALID_EVIDENCE');
  return {position:start+i,id:e.id,hash:digest(e),payload:JSON.stringify(e),...evidenceMetadata(e)};
 });
 const encoded=JSON.stringify(rows);
 if(Buffer.byteLength(encoded)>LIMITS.chunkBytes)throw Error('ANALYTICS_PROJECTION_LIMIT');
 return encoded;
}
export function prepareInput(job,id,summary,evidence){
 validJob(job,job.lease_until);
 if(typeof id!=='string'||!id)throw Error('INVALID_GENERATION');
 if(!Array.isArray(evidence)||evidence.length>LIMITS.rows)throw Error('ANALYTICS_PROJECTION_LIMIT');
 const json=JSON.stringify(summary);
 if(typeof json!=='string'||Buffer.byteLength(json)>LIMITS.summary)throw Error('ANALYTICS_PROJECTION_LIMIT');
 // Snapshot evidence before any await. Caller mutation cannot change later stages.
 evidence=structuredClone(evidence);
 // Keep only the original evidence and small descriptors. No encoded-all-chunks copy.
 const chunks=[];
 for(let start=0;start<evidence.length;start+=LIMITS.chunkRows){
  chunks.push(Object.freeze({start,count:Math.min(LIMITS.chunkRows,evidence.length-start),get encoded(){return encodeChunk(evidence,start);}}));
 }
 let compact=evidence.length<=LIMITS.compactRows && Buffer.byteLength(json)<=LIMITS.compactBytes;
 if(compact){let bytes=Buffer.byteLength(json);for(const c of chunks){bytes+=4*Buffer.byteLength(c.encoded);if(bytes>LIMITS.compactBytes){compact=false;break;}}}
 return Object.freeze({job:Object.freeze({...job}),id,json,count:evidence.length,chunks:Object.freeze(chunks),compact});
}
export function guards(j,D){
 validJob(j,D);
 return [notExpired(D),assertion('lease_lost',`EXISTS(SELECT 1 FROM analytics_summary_requests q WHERE q.project_id=? AND q.query_key=? AND q.lease_token=? AND typeof(q.lease_until)='integer' AND q.lease_until>=? AND q.last_error=?)`,[j.project_id,j.query_key,j.lease_token,D,j.publication_intent]),
 assertion('source_changed',`EXISTS(SELECT 1 FROM analytics_project_revisions r WHERE r.project_id=? AND r.revision=?)`,[j.project_id,j.source_revision])];
}
function generation(p){return statement('create_generation',`INSERT INTO analytics_summary_generations(id,project_id,query_key,source_revision,format_version,generated_at,expires_at,evidence_count,summary_json,published_at) VALUES(?,?,?,?,?,${CLOCK_SQL},${CLOCK_SQL}+?,?,?,NULL)`,[p.id,p.job.project_id,p.job.query_key,p.job.source_revision,p.job.format_version,LEASE_MS,p.count,p.json]);}
function generationGuard(p){return assertion('generation_scope',`EXISTS(SELECT 1 FROM analytics_summary_generations WHERE id=? AND project_id=? AND query_key=? AND source_revision=? AND format_version=? AND evidence_count=? AND published_at IS NULL AND expires_at>${CLOCK_SQL})`,[p.id,p.job.project_id,p.job.query_key,p.job.source_revision,p.job.format_version,p.count]);}
function countGuard(id,n,label='evidence_complete'){
 return assertion(label,`(SELECT COUNT(*) FROM analytics_summary_evidence WHERE generation_id=?)=? AND (?=0 OR (SELECT MIN(position)=0 AND MAX(position)=?-1 FROM analytics_summary_evidence WHERE generation_id=?)) AND NOT EXISTS(SELECT 1 FROM analytics_summary_evidence e LEFT JOIN analytics_summary_payloads p ON p.hash=e.payload_hash WHERE e.generation_id=? AND (p.hash IS NULL OR NOT json_valid(p.payload) OR json_extract(p.payload,'$.id') IS NOT e.id))`,[id,n,n,n,id,id]);
}
function chunkWrites(id,c){
 const encoded=c.encoded;
 const fields=['mentioned','recommended','cited','ordered','first','excluded'];
 const shape=["json_type(value,'$.position')='integer'","json_extract(value,'$.position')=?+CAST(key AS INTEGER)","json_type(value,'$.id')='text'","length(json_extract(value,'$.id'))>0","json_type(value,'$.hash')='text'","length(json_extract(value,'$.hash'))=64","json_type(value,'$.payload')='text'","json_valid(json_extract(value,'$.payload'))","json_extract(json_extract(value,'$.payload'),'$.id')=json_extract(value,'$.id')","json_valid(json_extract(value,'$.search'))","json_valid(json_extract(value,'$.brands'))",...fields.map(f=>`json_type(value,'$.${f}')='integer' AND json_extract(value,'$.${f}') IN (0,1)`)].join(' AND ');
 return [
 assertion('chunk_shape',`(SELECT json_type(encoded)='array' AND json_array_length(encoded)=? AND NOT EXISTS(SELECT 1 FROM json_each(encoded) WHERE NOT COALESCE((${shape}),0)) FROM (SELECT ? encoded))`,[c.count,c.start,encoded]),
 statement('insert_payloads',`INSERT INTO analytics_summary_payloads(hash,payload,search_text,brands_json,mentioned,recommended,cited,ordered,first_rank,excluded) SELECT json_extract(value,'$.hash'),json_extract(value,'$.payload'),json_extract(value,'$.search'),json_extract(value,'$.brands'),json_extract(value,'$.mentioned'),json_extract(value,'$.recommended'),json_extract(value,'$.cited'),json_extract(value,'$.ordered'),json_extract(value,'$.first'),json_extract(value,'$.excluded') FROM json_each(?) WHERE true ON CONFLICT(hash) DO NOTHING`,[encoded]),
 assertion('payload_identity',`NOT EXISTS(SELECT 1 FROM json_each(?) x LEFT JOIN analytics_summary_payloads p ON p.hash=json_extract(x.value,'$.hash') WHERE p.hash IS NULL OR p.payload IS NOT json_extract(x.value,'$.payload') OR p.search_text IS NOT json_extract(x.value,'$.search') OR p.brands_json IS NOT json_extract(x.value,'$.brands') OR ${fields.map(f=>`p.${f==='first'?'first_rank':f} IS NOT json_extract(x.value,'$.${f}')`).join(' OR ')})`,[encoded]),
 statement('insert_evidence',`INSERT INTO analytics_summary_evidence(generation_id,position,id,payload_hash) SELECT ?,json_extract(value,'$.position'),json_extract(value,'$.id'),json_extract(value,'$.hash') FROM json_each(?)`,[id,encoded]),
 countGuard(id,c.start+c.count,'chunk_complete')
 ];
}
function finish(p,D){return [...guards(p.job,D),generationGuard(p),countGuard(p.id,p.count),
 statement('publish_generation',`UPDATE analytics_summary_generations SET published_at=${CLOCK_SQL},generated_at=${CLOCK_SQL},expires_at=${CLOCK_SQL}+? WHERE id=? AND published_at IS NULL`,[TTL,p.id]),change('generation_updated'),
 statement('swap_head',`INSERT INTO analytics_summary_heads(project_id,query_key,generation_id) VALUES(?,?,?) ON CONFLICT(project_id,query_key) DO UPDATE SET generation_id=excluded.generation_id`,[p.job.project_id,p.job.query_key,p.id]),change('head_updated'),
 statement('release_request',`UPDATE analytics_summary_requests SET lease_token=NULL,lease_until=NULL,attempts=0,next_attempt_at=0,last_error=NULL,failed_revision=NULL WHERE project_id=? AND query_key=? AND lease_token=? AND lease_until>=?`,[p.job.project_id,p.job.query_key,p.job.lease_token,D]),change('request_updated'),notExpired(D)];}
const encode=v=>v===null?{type:'null'}:typeof v==='string'?{type:'text',value:v}:Number.isSafeInteger(v)?{type:'integer',value:String(v)}:(()=>{throw Error('UNSUPPORTED_ARGUMENT')})();
const ok=step=>({type:'ok',step});
export function atomicPlan(statements,meta={}){
 const raw=[statement('begin',meta.readOnly?'BEGIN':'BEGIN IMMEDIATE'),...statements,statement('commit','COMMIT')];
 const steps=raw.map((s,i)=>({stmt:{sql:s.sql,args:s.args.map(encode),named_args:[],want_rows:s.want_rows},...(i?{condition:ok(i-1)}:{})}));
 const commit=steps.length-1;
 steps.push({stmt:{sql:'ROLLBACK',args:[],named_args:[],want_rows:false},condition:{type:'and',conds:[ok(0),{type:'not',cond:ok(commit)}]}});
 const body={baton:null,requests:[{type:'batch',batch:{steps}},{type:'close'}]};
 const bytes=Buffer.byteLength(JSON.stringify(body));
 if(bytes>LIMITS.wireBytes)throw Error('ANALYTICS_PROJECTION_LIMIT');
 return {body,labels:[...raw.map(s=>s.label),'rollback'],commit,rollback:commit+1,bytes,...meta};
}
export function compactPlan(p,D=p.job.lease_until){
 if(!p.compact)throw Error('NOT_COMPACT');
 return atomicPlan([...guards(p.job,D),generation(p),...p.chunks.flatMap(c=>chunkWrites(p.id,c)),...finish(p,D)],{phase:'compact',generation:p.id});
}
export function setupPlan(p,D=p.job.lease_until){return atomicPlan([...guards(p.job,D),generation(p),notExpired(D)],{phase:'setup',generation:p.id});}
export function stagePlan(p,c,D){
 const s=[...guards(p.job,D),generationGuard(p),countGuard(p.id,c.start,'previous_chunks_complete'),...chunkWrites(p.id,c),notExpired(D),
 statement('renew_lease',`UPDATE analytics_summary_requests SET lease_until=${CLOCK_SQL}+? WHERE project_id=? AND query_key=? AND lease_token=? AND lease_until>=? RETURNING lease_until`,[LEASE_MS,p.job.project_id,p.job.query_key,p.job.lease_token,D],true),change('lease_renewed'),
 statement('retain_stage',`UPDATE analytics_summary_generations SET expires_at=(SELECT lease_until FROM analytics_summary_requests WHERE project_id=? AND query_key=? AND lease_token=?) WHERE id=? AND published_at IS NULL`,[p.job.project_id,p.job.query_key,p.job.lease_token,p.id]),change('stage_retained'),notExpired(D)];
 return atomicPlan(s,{phase:'stage',generation:p.id,deadline:D});
}
export function finalPlan(p,D){return atomicPlan([...guards(p.job,D),...finish(p,D)],{phase:'final',generation:p.id});}
