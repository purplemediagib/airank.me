// One-shot, synthetic-only HTTP publication acceptance check. Not a worker.
// Nothing executes or reads environment credentials when this module is imported.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export const PREFIX='airank_http_smoke_20261104_ec81557_';
export const CONFIRMATION='RUN_SYNTHETIC_ONLY_20261104_EC81557';
export const PUBLISHER_SHA256='389989b871319be646681b56cb470af2621be3e9ba597bb05d27808229b2adfb';
export const LIMITS=Object.freeze({durationMs:90000,requestMs:8000,transactionStartDeadlineMs:8000,queries:300,transactions:45,httpRequests:300,requestBytes:512*1024,responseBytes:512*1024,totalRequestBytes:4*1024*1024,totalResponseBytes:4*1024*1024,batchStatements:6,statementArgumentBytes:128*1024});
const LEASE_MS=600000;
const STAGES=new Set(['initialization','publisher_verification','database_configuration','http_client_creation','isolated_table_preflight','isolated_schema_creation','compact_empty','compact_100','staged_101','revision_fence','token_fence','late_expiry_rollback','duplicate_rollback','concurrent_publishers','retention_verification','retained_state_verification']);
const DRIVER_CODES=new Set(['SQLITE_ERROR','SQLITE_BUSY','SQLITE_BUSY_TIMEOUT','SQLITE_LOCKED','SQLITE_CONSTRAINT','SQLITE_CONSTRAINT_UNIQUE','SQLITE_CONSTRAINT_FOREIGNKEY','SQLITE_CONSTRAINT_CHECK','SQLITE_CONSTRAINT_PRIMARYKEY','TRANSACTION_CLOSED','CLIENT_CLOSED','SERVER_ERROR','HTTP_SERVER_ERROR','HTTP_CLIENT_ERROR','INVALID_RESPONSE','URL_SCHEME_NOT_SUPPORTED','PROTOCOL_ERROR','UNAUTHORIZED','AUTHENTICATION_FAILED']);
const TABLES=['analytics_project_revisions','analytics_summary_requests','analytics_summary_generations','analytics_summary_heads','analytics_summary_payloads','analytics_summary_evidence'];
const MAPPING=new Map(TABLES.map(t=>[t,PREFIX+t.replace(/^analytics_/, '')]));
const normalize=sql=>sql.trim().replace(/\s+/g,' ');
const mapTables=sql=>sql.replace(/'(?:''|[^'])*'|\b[a-zA-Z_][a-zA-Z_0-9]*\b/g,token=>MAPPING.get(token)||token);
export const TABLE_NAMES=Object.freeze([...MAPPING.values()]);
const Q=Object.freeze({
 guard:`SELECT q.lease_token,q.lease_until,r.revision FROM analytics_summary_requests q JOIN analytics_project_revisions r ON r.project_id=q.project_id WHERE q.project_id=? AND q.query_key=?`,
 sourceChanged:'UPDATE analytics_summary_requests SET lease_token=NULL,lease_until=NULL,next_attempt_at=?,last_error=NULL WHERE project_id=? AND query_key=? AND lease_token=?',
 generation:`INSERT INTO analytics_summary_generations (id,project_id,query_key,source_revision,format_version,generated_at,expires_at,evidence_count,summary_json,published_at) VALUES (?,?,?,?,?,?,?,?,?,NULL)`,
 payloads:`INSERT INTO analytics_summary_payloads (hash,payload,search_text,brands_json,mentioned,recommended,cited,ordered,first_rank,excluded)
 SELECT json_extract(value,'$.hash'),json_extract(value,'$.payload'),json_extract(value,'$.search'),json_extract(value,'$.brands'),json_extract(value,'$.mentioned'),json_extract(value,'$.recommended'),json_extract(value,'$.cited'),json_extract(value,'$.ordered'),json_extract(value,'$.first'),json_extract(value,'$.excluded') FROM json_each(?) WHERE true ON CONFLICT(hash) DO NOTHING`,
 evidence:`INSERT INTO analytics_summary_evidence (generation_id,position,id,payload_hash)
 SELECT ?,json_extract(value,'$.position'),json_extract(value,'$.id'),json_extract(value,'$.hash') FROM json_each(?)`,
 count:'SELECT COUNT(*) n FROM analytics_summary_evidence WHERE generation_id=?',
 publish:'UPDATE analytics_summary_generations SET published_at=?,generated_at=?,expires_at=? WHERE id=?',
 head:`INSERT INTO analytics_summary_heads (project_id,query_key,generation_id) VALUES (?,?,?) ON CONFLICT(project_id,query_key) DO UPDATE SET generation_id=excluded.generation_id`,
 release:'UPDATE analytics_summary_requests SET lease_token=NULL,lease_until=NULL,attempts=0,next_attempt_at=0,last_error=NULL,failed_revision=NULL WHERE project_id=? AND query_key=? AND lease_token=?',
 renew:'UPDATE analytics_summary_requests SET lease_until=? WHERE project_id=? AND query_key=? AND lease_token=?',
 extend:'UPDATE analytics_summary_generations SET expires_at=? WHERE id=? AND published_at IS NULL',
 cleanup:'DELETE FROM analytics_summary_generations WHERE id=? AND published_at IS NULL',
 cleanupExists:'SELECT 1 FROM analytics_summary_generations WHERE id=? LIMIT 1',
 seedRevision:'INSERT INTO analytics_project_revisions(project_id,revision) VALUES (?,1)',
 seedRequest:'INSERT INTO analytics_summary_requests(project_id,query_key,query_json,format_version,requested_at,last_requested_at,lease_token,lease_until,attempts,next_attempt_at) VALUES (?,?,?,?,?,?,?,?,1,0)',
 resetLease:'UPDATE analytics_summary_requests SET lease_token=?,lease_until=?,attempts=1 WHERE project_id=? AND query_key=?',
 bumpRevision:'UPDATE analytics_project_revisions SET revision=revision+1 WHERE project_id=?',
 output:`SELECT g.id,g.source_revision,g.format_version,g.evidence_count,g.summary_json,g.published_at FROM analytics_summary_heads h JOIN analytics_summary_generations g ON g.id=h.generation_id WHERE h.project_id=? AND h.query_key=?`,
 rows:`SELECT e.position,e.id,p.hash,p.payload,p.search_text,p.brands_json,p.mentioned,p.recommended,p.cited,p.ordered,p.first_rank,p.excluded FROM analytics_summary_evidence e JOIN analytics_summary_payloads p ON p.hash=e.payload_hash WHERE e.generation_id=? ORDER BY e.position LIMIT 102`,
 lease:'SELECT lease_token,lease_until,attempts FROM analytics_summary_requests WHERE project_id=? AND query_key=?',
 unpublished:'SELECT COUNT(*) n FROM analytics_summary_generations WHERE published_at IS NULL',
 orphanEvidence:'SELECT COUNT(*) n FROM analytics_summary_evidence e LEFT JOIN analytics_summary_generations g ON g.id=e.generation_id WHERE g.id IS NULL',
});
// Deliberately independent fixture DDL. No application project FK, source trigger,
// migration registry, index scan, sqlite_master read, or migration runner.
const DDL=[
 'CREATE TABLE analytics_project_revisions(project_id TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=1))',
 `CREATE TABLE analytics_summary_requests(project_id TEXT NOT NULL,query_key TEXT NOT NULL,query_json TEXT NOT NULL,format_version TEXT NOT NULL,requested_at INTEGER NOT NULL,last_requested_at INTEGER NOT NULL,lease_token TEXT,lease_until INTEGER,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,last_error TEXT,failed_revision INTEGER,PRIMARY KEY(project_id,query_key))`,
 `CREATE TABLE analytics_summary_generations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,query_key TEXT NOT NULL,source_revision INTEGER NOT NULL,format_version TEXT NOT NULL,generated_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,evidence_count INTEGER NOT NULL CHECK(evidence_count>=0),summary_json TEXT NOT NULL,published_at INTEGER,UNIQUE(project_id,query_key,id),FOREIGN KEY(project_id,query_key) REFERENCES analytics_summary_requests(project_id,query_key) ON DELETE CASCADE)`,
 `CREATE TABLE analytics_summary_heads(project_id TEXT NOT NULL,query_key TEXT NOT NULL,generation_id TEXT NOT NULL,PRIMARY KEY(project_id,query_key),FOREIGN KEY(project_id,query_key,generation_id) REFERENCES analytics_summary_generations(project_id,query_key,id) ON DELETE CASCADE)`,
 `CREATE TABLE analytics_summary_payloads(hash TEXT PRIMARY KEY,payload TEXT NOT NULL,search_text TEXT NOT NULL,brands_json TEXT NOT NULL,mentioned INTEGER NOT NULL,recommended INTEGER NOT NULL,cited INTEGER NOT NULL,ordered INTEGER NOT NULL,first_rank INTEGER NOT NULL,excluded INTEGER NOT NULL)`,
 `CREATE TABLE analytics_summary_evidence(generation_id TEXT NOT NULL REFERENCES analytics_summary_generations(id) ON DELETE CASCADE,position INTEGER NOT NULL CHECK(position>=0),id TEXT NOT NULL,payload_hash TEXT NOT NULL REFERENCES analytics_summary_payloads(hash),PRIMARY KEY(generation_id,position),UNIQUE(generation_id,id))`,
];
const COUNTS=TABLES.map(table=>`SELECT COUNT(*) n FROM ${table}`);
const EXISTS=TABLES.map(table=>`SELECT 1 FROM ${table} LIMIT 1`);
const ALLOWED=new Set([...Object.values(Q).filter(sql=>sql!==Q.cleanup),...DDL,...COUNTS,...EXISTS].map(normalize));
const fail=code=>{throw Object.assign(new Error(code),{smokeCode:code});};
export function makeBudget(now=Date.now){return {startedAt:now(),now,stage:'initialization',lastHttpStatus:null,queries:0,transactions:0,transactionBatches:0,httpRequests:0,requestBytes:0,responseBytes:0,maximumConcurrentOperations:0,concurrentOperations:0,cleanupRows:0};}
function checkTime(budget){if(budget.now()-budget.startedAt>LIMITS.durationMs)fail('SMOKE_TIME_LIMIT');}
export function guardStatement(statement,{readOnly=false}={}){
 if(!statement||typeof statement!=='object'||typeof statement.sql!=='string'||!Array.isArray(statement.args||[]))fail('SMOKE_SQL_REJECTED');
 if(Object.keys(statement).some(k=>!['sql','args'].includes(k)))fail('SMOKE_SQL_REJECTED');
 const original=normalize(statement.sql);
 if(!ALLOWED.has(original)||(readOnly&&!original.startsWith('SELECT ')))fail('SMOKE_SQL_REJECTED');
 const sql=mapTables(statement.sql),outsideStrings=sql.replace(/'(?:''|[^'])*'/g,"''");
 if(/\b(?:app_|mon_|users\b|sessions\b|sqlite_|analytics_)/i.test(outsideStrings))fail('SMOKE_TABLE_REJECTED');
 const references=[...outsideStrings.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|REFERENCES|TABLE)\s+([A-Za-z_][A-Za-z_0-9]*)/gi)].map(m=>m[1]);
 if(!references.length||references.some(t=>!TABLE_NAMES.includes(t)&&t!=='json_each'&&t!=='SET'))fail('SMOKE_TABLE_REJECTED');
 const args=statement.args||[];
 if(args.some(v=>v!==null&&typeof v!=='string'&&!(typeof v==='number'&&Number.isFinite(v))))fail('SMOKE_ARGUMENT_REJECTED');
 if(Buffer.byteLength(JSON.stringify(args))>LIMITS.statementArgumentBytes)fail('SMOKE_ARGUMENT_LIMIT');
 return {sql,args};
}
export function guardedClient(client,budget,{readOnly=false,onBatch}={}){
 async function invoke(fn){checkTime(budget);budget.concurrentOperations++;budget.maximumConcurrentOperations=Math.max(budget.maximumConcurrentOperations,budget.concurrentOperations);try{return await fn();}finally{budget.concurrentOperations--;}}
 function reserve(statements){const mapped=statements.map(q=>guardStatement(q,{readOnly}));if(budget.queries+mapped.length>LIMITS.queries)fail('SMOKE_QUERY_LIMIT');budget.queries+=mapped.length;return mapped;}
 async function execute(target,q){
  if(q&&typeof q.sql==='string'&&normalize(q.sql)===Q.cleanup){
   // The publisher normally deletes failed staging. This retained-fixture smoke
   // must never do so: prove there is nothing to delete, otherwise stop with all
   // committed staging intact. No DELETE is in the remote SQL allowlist.
   if(Object.keys(q).some(k=>!['sql','args'].includes(k))||!Array.isArray(q.args)||q.args.length!==1||typeof q.args[0]!=='string'||!/^[0-9a-f-]{36}$/.test(q.args[0]))fail('SMOKE_SQL_REJECTED');
   const [probe]=reserve([{sql:Q.cleanupExists,args:q.args}]);
   const found=await invoke(()=>target.execute(probe));
   if(found.rows.length)fail('SMOKE_COMMITTED_CLEANUP_REFUSED');
   return {rows:[],rowsAffected:0};
  }
  const [mapped]=reserve([q]);return invoke(()=>target.execute(mapped));
 }
 return {
  execute:q=>execute(client,q),
  transaction:async mode=>{
   checkTime(budget);if(readOnly||mode!=='write')fail('SMOKE_TRANSACTION_REJECTED');
   if(++budget.transactions>LIMITS.transactions)fail('SMOKE_TRANSACTION_LIMIT');
   const tx=await invoke(()=>client.transaction('write'));const opened=budget.now();
   const check=()=>{checkTime(budget);if(budget.now()-opened>LIMITS.transactionStartDeadlineMs)fail('SMOKE_TRANSACTION_TIME_LIMIT');};
   return {
    execute:q=>{check();return execute(tx,q);},
    batch:async statements=>{
     check();if(!Array.isArray(statements)||!statements.length||statements.length>LIMITS.batchStatements)fail('SMOKE_BATCH_LIMIT');
     const mapped=reserve(statements);budget.transactionBatches++;
     const result=await invoke(()=>tx.batch(mapped));await onBatch?.(statements);return result;
    },
    commit:async()=>{check();return invoke(()=>tx.commit());},
    // Rollback/close may release a lock after a time/query limit. They never retry
    // a failed statement, start a fresh transaction, or issue application SQL.
    rollback:()=>tx.rollback(),close:()=>tx.close(),
   };
  },
 };
}
export function normalizeDatabaseURL(value){
 if(typeof value!=='string'||value.length>2048)fail('SMOKE_DATABASE_CONFIG_REJECTED');
 let url;try{url=new URL(value);}catch{fail('SMOKE_DATABASE_CONFIG_REJECTED');}
 if(!['https:','libsql:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)fail('SMOKE_DATABASE_CONFIG_REJECTED');
 if(url.protocol==='libsql:')url=new URL(`https://${url.host}${url.pathname}`);
 return url;
}
export function boundedFetch({url,budget,signal,fetchImpl=fetch}){
 const origin=new URL(url).origin;
 return async(input,init)=>{
  checkTime(budget);
  const request=new Request(input,init);
  if(new URL(request.url).origin!==origin||!['GET','POST'].includes(request.method))fail('SMOKE_HTTP_DESTINATION_REJECTED');
  if(++budget.httpRequests>LIMITS.httpRequests)fail('SMOKE_HTTP_REQUEST_LIMIT');
  const body=await request.clone().arrayBuffer();
  if(body.byteLength>LIMITS.requestBytes||budget.requestBytes+body.byteLength>LIMITS.totalRequestBytes)fail('SMOKE_HTTP_BYTE_LIMIT');
  budget.requestBytes+=body.byteLength;
  const response=await fetchImpl(new Request(request,{redirect:'manual',signal:AbortSignal.any([signal,request.signal,AbortSignal.timeout(LIMITS.requestMs)])}));
  budget.lastHttpStatus=response.status>=100&&response.status<=599?response.status:null;
  if(response.status>=300&&response.status<400)fail('SMOKE_HTTP_REDIRECT_REJECTED');
  const reader=response.body?.getReader();const chunks=[];let bytes=0;
  if(reader)try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;budget.responseBytes+=value.byteLength;if(bytes>LIMITS.responseBytes||budget.responseBytes>LIMITS.totalResponseBytes){await reader.cancel();fail('SMOKE_HTTP_BYTE_LIMIT');}chunks.push(value);}}finally{reader.releaseLock();}
  return new Response([204,205,304].includes(response.status)?null:Buffer.concat(chunks),{status:response.status,statusText:response.statusText,headers:response.headers});
 };
}
export async function loadPublisher(){
 const path=new URL('../summary-store.mjs',import.meta.url),source=await readFile(path);
 assert.equal(createHash('sha256').update(source).digest('hex'),PUBLISHER_SHA256,'publisher must match the reviewed candidate');
 return (await import(path.href)).publishSummary;
}
const statement=(sql,args=[])=>({sql,args});
const scalar=async(db,sql,args=[])=>Number((await db.execute(statement(sql,args))).rows[0].n);
const rows=async(db,sql,args=[]) => (await db.execute(statement(sql,args))).rows;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixtureEvidence(count,caseName){return Array.from({length:count},(_,i)=>({id:`smoke-${caseName}-${i}`,text:'Synthetic question?',answer:`Synthetic answer ${i}.`,provider:'synthetic',model:'no-provider-call',topic:'smoke',tags:['synthetic'],brandNames:['Fixture'],citations:['https://example.invalid/synthetic'],exclusion:null,mentioned:i%2===0,recommendation:i%3===0?'recommended':'none',ownedCitation:i%4===0,brandOrder:{state:'observed',targetPosition:1,mentions:[{brandName:'Fixture'}]}}));}
async function assertOutput(db,job,result,summary,evidence){
 const found=await rows(db,Q.output,[job.project_id,job.query_key]);assert.equal(found.length,1);
 const g=found[0];assert.equal(g.id,result.generation);assert.equal(g.source_revision,job.source_revision);assert.equal(g.format_version,job.format_version);assert.equal(g.evidence_count,evidence.length);assert.ok(Number(g.published_at)>0);assert.deepEqual(JSON.parse(g.summary_json),summary);
 const saved=await rows(db,Q.rows,[g.id]);assert.equal(saved.length,evidence.length);
 saved.forEach((r,i)=>{
  const e=evidence[i];assert.equal(r.position,i);assert.equal(r.id,e.id);assert.equal(r.hash,hash(e));assert.deepEqual(JSON.parse(r.payload),e);
  assert.equal(r.search_text,JSON.stringify([e.text,e.answer,e.provider,e.model,e.topic,...e.tags,...e.brandNames,...e.citations].map(s=>s.toLocaleLowerCase())));
  assert.equal(r.brands_json,'["Fixture"]');assert.equal(r.mentioned,Number(e.mentioned));assert.equal(r.recommended,Number(e.recommendation==='recommended'));assert.equal(r.cited,Number(e.ownedCitation));assert.equal(r.ordered,1);assert.equal(r.first_rank,1);assert.equal(r.excluded,0);
 });
 const request=(await rows(db,Q.lease,[job.project_id,job.query_key]))[0];assert.equal(request.lease_token,null);assert.equal(request.lease_until,null);assert.equal(request.attempts,0);
}
export async function verifyRetained(db){
 const counts={};for(let i=0;i<TABLES.length;i++)counts[TABLES[i].replace('analytics_','')]=await scalar(db,COUNTS[i]);
 const unpublished=await scalar(db,Q.unpublished),orphanEvidence=await scalar(db,Q.orphanEvidence);
 return {counts,unpublished,orphanEvidence};
}
export async function runSmoke({primary,secondary,budget=makeBudget(),publishSummary,log=()=>{}}){
 const db=guardedClient(primary,budget),other=guardedClient(secondary,budget);const tests=[];
 const pass=name=>{tests.push(name);log({event:'synthetic_publication_smoke_check',name,status:'passed'});};
 // Probe only the exact synthetic tables, without schema/customer inspection.
 // A retained full or partial run blocks every subsequent write, including when
 // an external restart policy launches this one-shot command again.
 budget.stage='isolated_table_preflight';
 for(let i=0;i<EXISTS.length;i++){
  try{await db.execute(statement(EXISTS[i]));}catch(error){
   if(String(error.message||'').includes(`no such table: ${TABLE_NAMES[i]}`))continue;
   throw error;
  }
  fail('SMOKE_PREFIX_ALREADY_EXISTS');
 }
 // All six CREATEs occur in one transaction. Existing prefix => fail closed;
 // no IF NOT EXISTS, no adoption of old tables, no restart/retry logic.
 budget.stage='isolated_schema_creation';
 const setup=await db.transaction('write');try{for(const sql of DDL)await setup.execute(statement(sql));await setup.commit();}catch(error){await setup.rollback();throw error;}finally{setup.close();}
 pass('isolated_schema_created');
 const stamp=Date.now();
 async function seed(name){
  const job={project_id:`synthetic-${name}`,query_key:`synthetic-query-${name}`,source_revision:1,format_version:'synthetic-publication-smoke-v1',lease_token:`synthetic-lease-${name}`,lease_until:stamp+LEASE_MS};
  await db.execute(statement(Q.seedRevision,[job.project_id]));
  await db.execute(statement(Q.seedRequest,[job.project_id,job.query_key,'synthetic',job.format_version,stamp,stamp,job.lease_token,job.lease_until]));
  return job;
 }
 async function publish(name,count,client=db){
  const job=await seed(name),evidence=fixtureEvidence(count,name),summary={synthetic:true,case:name,count};
  const before=budget.transactions,result=await publishSummary(client,job,summary,evidence,()=>stamp);
  assert.equal(result.published,true);await assertOutput(db,job,result,summary,evidence);
  return {job,result,evidence,summary,transactions:budget.transactions-before};
 }
 for(const [name,count,transactions] of [['compact_empty',0,1],['compact_100',100,1],['staged_101',101,5]]){
  budget.stage=name;const result=await publish(name,count);assert.equal(result.transactions,transactions);pass(`${name}_exact_output`);
 }
 for(const name of ['revision_fence','token_fence','late_expiry_rollback','duplicate_rollback']){
  budget.stage=name;const baseline=await publish(name,2),job={...baseline.job,lease_token:`synthetic-retry-${name}`};
  await db.execute(statement(Q.resetLease,[job.lease_token,stamp+LEASE_MS,job.project_id,job.query_key]));
  const before=await verifyRetained(db);let virtualNow=stamp;
  if(name==='revision_fence')await other.execute(statement(Q.bumpRevision,[job.project_id]));
  if(name==='token_fence')job.lease_token='synthetic-stale-token';
  const observed=name==='late_expiry_rollback'?guardedClient(primary,budget,{onBatch:statements=>{if(statements.some(q=>q.sql.includes('SET published_at=')))virtualNow+=LEASE_MS+1;}}):db;
  const nextEvidence=fixtureEvidence(3,`${name}-new`);
  if(name==='duplicate_rollback'){
   await assert.rejects(publishSummary(observed,job,{synthetic:true},[nextEvidence[0],nextEvidence[0]],()=>virtualNow),error=>/CONSTRAINT|UNIQUE/.test(String(error.code||'')+' '+String(error.message||'')));
  }else{
   const result=await publishSummary(observed,job,{synthetic:true},nextEvidence,()=>virtualNow);
   assert.deepEqual(result,{published:false,reason:name==='revision_fence'?'source_changed':'lease_lost'});
  }
  const after=await verifyRetained(db);assert.deepEqual(after,before);
  const head=(await rows(db,Q.output,[job.project_id,job.query_key]))[0];assert.equal(head.id,baseline.result.generation);assert.deepEqual(JSON.parse(head.summary_json),baseline.summary);
  const saved=await rows(db,Q.rows,[head.id]);assert.deepEqual(saved.map(r=>JSON.parse(r.payload)),baseline.evidence);
  pass(name);
 }
 budget.stage='concurrent_publishers';
 const concurrent=await Promise.all(['concurrent_a','concurrent_b'].map(async name=>({job:await seed(name),evidence:fixtureEvidence(25,name),summary:{synthetic:true,case:name,count:25}})));
 budget.maximumConcurrentOperations=0;
 const results=await Promise.all(concurrent.map((f,i)=>publishSummary(i?other:db,f.job,f.summary,f.evidence,()=>stamp)));
 for(let i=0;i<concurrent.length;i++){assert.equal(results[i].published,true);await assertOutput(db,concurrent[i].job,results[i],concurrent[i].summary,concurrent[i].evidence);}
 assert.ok(budget.maximumConcurrentOperations>=2);pass('two_concurrent_publishers_exact_output');
 budget.stage='retention_verification';
 const retained=await verifyRetained(db);assert.equal(retained.unpublished,0);assert.equal(retained.orphanEvidence,0);assert.equal(budget.cleanupRows,0);
 assert.deepEqual(retained.counts,{project_revisions:9,summary_requests:9,summary_generations:9,summary_heads:9,summary_payloads:259,summary_evidence:259});
 pass('bounded_readonly_retention_verification');
 return {status:'passed',tests,retained,budget:{queries:budget.queries,transactions:budget.transactions,transactionBatches:budget.transactionBatches,httpRequests:budget.httpRequests,requestBytes:budget.requestBytes,responseBytes:budget.responseBytes,maximumConcurrentOperations:budget.maximumConcurrentOperations,cleanupRows:budget.cleanupRows}};
}
export function safeFailure(error){
 const allowed=new Set(['SMOKE_SQL_REJECTED','SMOKE_TABLE_REJECTED','SMOKE_ARGUMENT_REJECTED','SMOKE_ARGUMENT_LIMIT','SMOKE_TIME_LIMIT','SMOKE_QUERY_LIMIT','SMOKE_TRANSACTION_REJECTED','SMOKE_TRANSACTION_LIMIT','SMOKE_TRANSACTION_TIME_LIMIT','SMOKE_BATCH_LIMIT','SMOKE_DATABASE_CONFIG_REJECTED','SMOKE_HTTP_DESTINATION_REJECTED','SMOKE_HTTP_REQUEST_LIMIT','SMOKE_HTTP_BYTE_LIMIT','SMOKE_HTTP_REDIRECT_REJECTED','SMOKE_PREFIX_ALREADY_EXISTS','SMOKE_COMMITTED_CLEANUP_REFUSED']);
 return allowed.has(error?.smokeCode)?error.smokeCode:/^SQLITE_(BUSY|LOCKED|CONSTRAINT)/.test(String(error?.code))?'DATABASE_CONTENTION_OR_CONSTRAINT':error?.code==='ERR_ASSERTION'?'CHECK_FAILED':error?.name==='TimeoutError'||error?.name==='AbortError'?'TIME_LIMIT_OR_ABORT':'SMOKE_FAILED';
}
export async function runConfiguredSmoke({confirmation,verify=false,signal,emit=()=>{}}={}){
 // No credential access until this exact opt-in. The hold wrapper uses a CLI
 // argument so there is no persistent environment/configuration change.
 if(confirmation!==CONFIRMATION){const result={status:'not_run',reason:'explicit_confirmation_required'};emit({event:'synthetic_publication_smoke',...result});return result;}
 let primary,secondary;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),LIMITS.durationMs);const budget=makeBudget();
 const stop=()=>controller.abort();signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)controller.abort();
 try{
  budget.stage='publisher_verification';const publishSummary=await loadPublisher();
  budget.stage='database_configuration';const url=normalizeDatabaseURL(process.env.BUNNY_DATABASE_URL);
  const authToken=process.env.BUNNY_DATABASE_AUTH_TOKEN;
  if(typeof authToken!=='string'||!authToken||authToken.length>16384)fail('SMOKE_DATABASE_CONFIG_REJECTED');
  budget.stage='http_client_creation';const {createClient}=await import('@libsql/client/http');
  const config={url:url.href,authToken,fetch:boundedFetch({url:url.href,budget,signal:controller.signal}),concurrency:1};
  primary=createClient(config);secondary=createClient(config);assert.equal(primary.protocol,'http');assert.equal(secondary.protocol,'http');
  if(verify){
   budget.stage='retained_state_verification';const retained=await verifyRetained(guardedClient(primary,budget,{readOnly:true}));const result={status:'observed',retained};emit({event:'synthetic_publication_smoke_verify',...result});return result;
  }
  const result=await runSmoke({primary,secondary,budget,publishSummary,log:emit});emit({event:'synthetic_publication_smoke',...result});return result;
 }catch(error){const result={status:'failed',code:safeFailure(error),stage:STAGES.has(budget.stage)?budget.stage:'initialization',http_status:budget.lastHttpStatus,driver_code:DRIVER_CODES.has(error?.code)?error.code:null,rerun:false,synthetic_tables_retained:true,remote_outcome_may_be_uncertain:true};emit({event:'synthetic_publication_smoke',...result});return result;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);controller.abort();primary?.close();secondary?.close();}
}
async function main(){
 const args=process.argv.slice(2);const confirmationArg=args.find(v=>v.startsWith('--confirm='));
 if(args.some(v=>v!=='--verify'&&v!==`--confirm=${CONFIRMATION}`)||args.length>2){console.log(JSON.stringify({event:'synthetic_publication_smoke',status:'not_run',reason:'invalid_arguments'}));process.exitCode=2;return;}
 const result=await runConfiguredSmoke({confirmation:confirmationArg?.slice('--confirm='.length)||process.env.AIRANK_SYNTHETIC_HTTP_SMOKE_CONFIRM,verify:args.includes('--verify'),emit:value=>console.log(JSON.stringify(value))});
 process.exitCode=['passed','observed'].includes(result.status)?0:result.status==='not_run'?2:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
