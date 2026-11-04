// Inert on import. Only exact opt-in and a short absolute window permit configuration access.
import {createHash} from 'node:crypto';
import {REVIEWED_SQL} from './reviewed-sql.mjs';
export const PREFIX='airank_http_smoke_20261104_ec81557_';
export const TABLES=Object.freeze(['project_revisions','summary_requests','summary_generations','summary_heads','summary_payloads','summary_evidence'].map(s=>PREFIX+s));
export const CONFIRMATION='RUN_ATOMIC_SIX_SYNTHETIC_TABLES_20261104';
export const ENDPOINT_SHA256='075c77e08c80dc3bd48cc649cc647669c390e13562404b1e49d93e0ea6b24e72';
export const LIMITS=Object.freeze({durationMs:90000,requestMs:6000,requests:100,statements:1200,statementPerRequest:64,requestBytes:512*1024,responseBytes:512*1024,totalRequestBytes:4*1024*1024,totalResponseBytes:4*1024*1024});
export function approvedWindow(confirmation,expires,now=Date.now()){
 if(confirmation!==CONFIRMATION||typeof expires!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(expires))return false;
 const end=Date.parse(expires);return Number.isFinite(end)&&new Date(end).toISOString()===expires&&end>now&&end-now<=120000;
}
export function fixedEndpoint(value){
 let u;try{u=new URL(value);}catch{throw Error('CONFIG_REJECTED');}
 if(!['https:','libsql:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))throw Error('CONFIG_REJECTED');
 const endpoint=new URL(`https://${u.host}/v2/pipeline`).href;
 if(createHash('sha256').update(endpoint).digest('hex')!==ENDPOINT_SHA256)throw Error('CONFIG_REJECTED');
 return endpoint;
}
export function mapSQL(sql){
 if(typeof sql!=='string'||/;|--|\/\*|\b(?:DELETE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REPLACE)\b/i.test(sql.startsWith('CREATE TABLE ')?sql.replaceAll('ON DELETE CASCADE',''):sql))throw Error('SQL_REJECTED');
 const mapped=sql.replace(/'(?:''|[^'])*'|\b[A-Za-z_][A-Za-z_0-9]*\b/g,t=>t.startsWith('analytics_')?PREFIX+t.slice(10):t);
 const bare=mapped.replace(/'(?:''|[^'])*'/g,"''");
 if(/["`\[\]]/.test(bare))throw Error('SQL_REJECTED');
 if(/\b(?:app_|mon_|sqlite_|analytics_|users\b|sessions\b)/i.test(bare))throw Error('SQL_REJECTED');
 // Derived subqueries are allowed; all named sources/targets must be fixed synthetic tables.
 const refs=[...bare.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|REFERENCES|TABLE)\s+([A-Za-z_][A-Za-z_0-9]*)/gi)].map(m=>m[1]);
 if(refs.some(t=>!TABLES.includes(t)&&!['json_each','SET'].includes(t)))throw Error('SQL_REJECTED');
 if(!/^(?:SELECT |INSERT INTO |UPDATE |CREATE TABLE |BEGIN IMMEDIATE$|COMMIT$|ROLLBACK$)/i.test(mapped.trim()))throw Error('SQL_REJECTED');
 if(!REVIEWED_SQL.has(mapped.trim().replace(/\s+/g,' ')))throw Error('SQL_TEMPLATE_REJECTED');
 return mapped;
}
export function budget(now=Date.now){return {now,started:now(),requests:0,statements:0,requestBytes:0,responseBytes:0,maxRequestBytes:0,maxResponseBytes:0,maxStatements:0,writes:0,retries:0,unknown:false};}
export function boundedTransport({endpoint,authorization,expires,state,fetchImpl,signal}){
 if(typeof fetchImpl!=='function'||createHash('sha256').update(endpoint).digest('hex')!==ENDPOINT_SHA256)throw Error('CONFIG_REJECTED');
 const overall=AbortSignal.timeout(Math.max(1,Math.min(LIMITS.durationMs,Date.parse(expires)-state.now())));
 return async(input,init)=>{
  signal?.throwIfAborted();overall.throwIfAborted();
  if(state.unknown)throw Error('UNKNOWN_HOLD');
  if(state.now()>=Date.parse(expires)||state.now()-state.started>=LIMITS.durationMs)throw Error('WINDOW_CLOSED');
  const req=new Request(input,init);
  if(req.url!==endpoint||req.method!=='POST'||!['error','manual'].includes(req.redirect))throw Error('DESTINATION_REJECTED');
  const body=JSON.parse(await req.text());
  if(body.baton!==null||body.requests?.length!==2||body.requests[1].type!=='close')throw Error('ENVELOPE_REJECTED');
  const first=body.requests[0];
  const statements=first.type==='execute'?[first.stmt]:first.type==='batch'?first.batch?.steps?.map(x=>x.stmt):null;
  if(!statements?.length||statements.length>LIMITS.statementPerRequest)throw Error('STATEMENT_LIMIT');
  for(const stmt of statements)stmt.sql=mapSQL(stmt.sql);
  const encoded=JSON.stringify(body),bytes=Buffer.byteLength(encoded);
  if(bytes>LIMITS.requestBytes||state.requestBytes+bytes>LIMITS.totalRequestBytes||state.requests+1>LIMITS.requests||state.statements+statements.length>LIMITS.statements)throw Error('BUDGET_EXHAUSTED');
  state.requests++;state.statements+=statements.length;state.requestBytes+=bytes;state.maxRequestBytes=Math.max(state.maxRequestBytes,bytes);state.maxStatements=Math.max(state.maxStatements,statements.length);
  state.writes+=Number(statements.some(s=>/^(?:INSERT|UPDATE|CREATE)\b/i.test(s.sql)));
  const stop=AbortSignal.any([overall,req.signal,AbortSignal.timeout(Math.min(LIMITS.requestMs,Math.max(1,Date.parse(expires)-state.now()))),...(signal?[signal]:[])]);
  try{
   stop.throwIfAborted();
   const response=await fetchImpl(new Request(endpoint,{method:'POST',redirect:'error',headers:{authorization,'content-type':'application/json'},body:encoded,signal:stop}));
   if(response.status!==200||response.redirected||(response.url&&response.url!==endpoint))throw Error('HTTP_REJECTED');
   const reader=response.body?.getReader();if(!reader)throw Error('BODY_REJECTED');const parts=[];let bytes=0;
   try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;state.responseBytes+=chunk.value.byteLength;if(bytes>LIMITS.responseBytes||state.responseBytes>LIMITS.totalResponseBytes)throw Error('BODY_LIMIT');parts.push(chunk.value);}}catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
   state.maxResponseBytes=Math.max(state.maxResponseBytes,bytes);
   stop.throwIfAborted();return new Response(Buffer.concat(parts),{status:200,headers:{'content-type':'application/json'}});
  }catch{state.unknown=true;throw Error('TRANSPORT_UNKNOWN');}
 };
}
