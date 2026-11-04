import {atomicPlan,statement} from './summary-plans.mjs';
function rejectDuplicateKeys(json) {
  // JSON.parse validates syntax first. Scan its valid input without recursion,
  // decoding only key strings so escaped duplicate keys cannot hide ambiguity.
  const stack = [];
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (char === '"') {
      const start = i++;
      while (json[i] !== '"') { if (json[i] === '\\') i++; i++; }
      const frame = stack.at(-1);
      if (frame?.keys && frame.expectKey) {
        const key = JSON.parse(json.slice(start, i + 1));
        if (frame.keys.has(key)) (() => {throw Error('INVALID_RESPONSE');})();
        frame.keys.add(key); frame.expectKey = false;
      }
    } else if (char === '{') stack.push({ keys: new Set(), expectKey: true });
    else if (char === '[') stack.push({});
    else if (char === '}' || char === ']') stack.pop();
    else if (char === ',' && stack.at(-1)?.keys) stack.at(-1).expectKey = true;
  }
}
class ResponseLimitError extends Error {}
async function boundedJSON(response){
 const max=16*1024*1024;
 const declared=response.headers?.get?.('content-length');
 if(declared!==null&&declared!==undefined){if(!/^\d+$/.test(declared))throw Error('INVALID_RESPONSE');if(Number(declared)>max)throw new ResponseLimitError();}
 if(!response.body?.getReader)throw Error('MISSING_RESPONSE_STREAM');
 const reader=response.body.getReader(),parts=[];let bytes=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>max)throw new ResponseLimitError();parts.push(Buffer.from(value));}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 const json=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts));
 const result=JSON.parse(json);rejectDuplicateKeys(json);return result;
}
export async function sendFixed(plan,{endpoint,fetch:doFetch,authToken}){
 const url=new URL(endpoint);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/v2/pipeline'||typeof doFetch!=='function')throw Error('INVALID_FIXED_TRANSPORT');
 try{
  const response=await doFetch(url.href,{method:'POST',redirect:'error',headers:{'content-type':'application/json',...(authToken?{authorization:`Bearer ${authToken}`}:{})},body:JSON.stringify(plan.body),signal:AbortSignal.timeout(30000)});
  if(!response.ok||response.redirected||(response.url&&response.url!==url.href))return {outcome:'unknown',reason:'http'};
  const payload=await boundedJSON(response);
  // base_url never affects the destination. A complete close acknowledgment is required.
  if(!payload||payload.baton!==null||!Array.isArray(payload.results)||payload.results.length!==2||payload.results[1]?.type!=='ok'||payload.results[1]?.error!==undefined||payload.results[1]?.response?.type!=='close')return {outcome:'unknown',reason:'protocol'};
  const result=payload.results[0];
  if(result?.type!=='ok'||result.error!==undefined||result.response?.type!=='batch')return {outcome:'unknown',reason:'protocol'};
  return classify(plan,result.response.result);
 }catch(error){return {outcome:'unknown',reason:error instanceof ResponseLimitError?'response_limit':'transport'};}
}
const wireValue=v=>v&&typeof v==='object'&&!Array.isArray(v)&&(v.type==='null'||v.type==='text'&&typeof v.value==='string'||v.type==='float'&&typeof v.value==='number'&&Number.isFinite(v.value)||v.type==='integer'&&typeof v.value==='string'&&/^-?\d+$/.test(v.value)&&BigInt(v.value)>=-(2n**63n)&&BigInt(v.value)<2n**63n);
function resultShape(r){return r&&typeof r==='object'&&!Array.isArray(r)&&Array.isArray(r.cols)&&r.cols.every(c=>c&&typeof c==='object'&&!Array.isArray(c)&&(c.name===undefined||c.name===null||typeof c.name==='string'))&&Array.isArray(r.rows)&&r.rows.every(row=>Array.isArray(row)&&row.length===r.cols.length&&row.every(wireValue))&&Number.isSafeInteger(r.affected_row_count)&&r.affected_row_count>=0&&(r.last_insert_rowid===undefined||r.last_insert_rowid===null||typeof r.last_insert_rowid==='string'&&/^-?\d+$/.test(r.last_insert_rowid));}
export function classify(plan,batch){
 const r=batch?.step_results,e=batch?.step_errors,n=plan.body.requests[0].batch.steps.length;
 if(!Array.isArray(r)||!Array.isArray(e)||r.length!==n||e.length!==n||!r.every(x=>x===null||resultShape(x))||!e.every(x=>x===null||x&&typeof x==='object'&&!Array.isArray(x)&&typeof x.message==='string'))return {outcome:'unknown',reason:'protocol'};
 const successful=i=>{
  if(r[i]===null||e[i]!==null)return false;
  const statement=plan.body.requests[0].batch.steps[i].stmt.sql;
  if(statement.startsWith('SELECT CASE WHEN'))return r[i].cols.length===1&&r[i].cols[0].name==='asserted'&&r[i].rows.length===1&&r[i].rows[0].length===1&&r[i].rows[0][0].type==='integer'&&r[i].rows[0][0].value==='1';
  if(plan.labels[i]==='renew_lease'){const v=r[i].rows[0]?.[0];return r[i].cols.length===1&&r[i].cols[0].name==='lease_until'&&r[i].rows.length===1&&v?.type==='integer'&&Number.isSafeInteger(Number(v.value))&&Number(v.value)>0;}
  if(!plan.body.requests[0].batch.steps[i].stmt.want_rows)return r[i].cols.length===0&&r[i].rows.length===0;
  return true;
 };
 if(successful(plan.commit)&&r[plan.rollback]===null&&e[plan.rollback]===null&&Array.from({length:plan.commit},(_,i)=>i).every(successful))return {outcome:'committed',generation:plan.generation,batch};
 const first=e.findIndex(x=>x!==null);
 const chainFailure=first>=0&&first<=plan.commit&&r[first]===null&&Array.from({length:first},(_,i)=>i).every(successful)&&r.slice(first+1,plan.rollback).every(x=>x===null)&&e.slice(first+1,plan.rollback).every(x=>x===null);
 if(chainFailure&&successful(plan.rollback)&&r[plan.commit]===null)return {outcome:'rolled_back',reason:plan.labels[first],batch};
 if(first===0&&r.every(x=>x===null)&&e.slice(1).every(x=>x===null))return {outcome:'not_started',reason:'begin'};
 return {outcome:'unknown',reason:'protocol'};
}
export function renewedDeadline(plan,result){
 if(result.outcome!=='committed'||plan.phase!=='stage')throw Error('NO_ACKNOWLEDGED_RENEWAL');
 const i=plan.labels.indexOf('renew_lease'),row=result.batch.step_results[i]?.rows?.[0],v=row?.[0];
 const n=v?.type==='integer'?Number(v.value):NaN;
 if(!Number.isSafeInteger(n)||n<=0||n<plan.deadline)throw new SummaryOutcomeUnknown();
 return n;
}

// All failures after dispatch are conservatively uncertain unless the complete
// batch/close acknowledgement proves rollback. Never expose provider text.
export class SummaryOutcomeUnknown extends Error {
 constructor(){super('ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN');this.code=this.message;this.outcome='unknown';this.status=503;}
}
export function resultRows(plan,result,label){
 if(result.outcome!=='committed')throw new SummaryOutcomeUnknown();
 const index=plan.labels.indexOf(label),r=result.batch.step_results[index];
 if(index<0||!r||r.cols.some(c=>typeof c.name!=='string'||!c.name)||new Set(r.cols.map(c=>c.name)).size!==r.cols.length)throw new SummaryOutcomeUnknown();
 return r.rows.map(row=>Object.fromEntries(r.cols.map((c,i)=>[c.name,decodeValue(row[i])])));
}
function decodeValue(v){
 if(v.type==='null')return null;
 if(v.type==='text')return v.value;
 if(v.type==='integer'){const n=Number(v.value);if(!Number.isSafeInteger(n))throw new SummaryOutcomeUnknown();return n;}
 if(v.type==='float')return v.value;
 throw new SummaryOutcomeUnknown();
}
export function createSummaryDatabase({url,authToken,fetch:doFetch=globalThis.fetch}){
 let endpoint;
 try{
  const u=new URL(url);
  if(!['https:','libsql:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||!['','/','/v2/pipeline'].includes(u.pathname)||typeof authToken!=='string'||!authToken||/[\r\n]/.test(authToken)||typeof doFetch!=='function')throw Error();
  endpoint=`https://${u.host}/v2/pipeline`;
 }catch{throw Object.assign(Error('ANALYTICS_TRANSPORT_NOT_CONFIGURED'),{code:'ANALYTICS_TRANSPORT_NOT_CONFIGURED',status:503});}
 const db={
  summaryAtomic:plan=>sendFixed(plan,{endpoint,authToken,fetch:doFetch}),
  async execute(input){
   const s=typeof input==='string'?{sql:input,args:[]}:input;
   // This adapter deliberately does not implement interactive transactions.
   // Shared source readers use execute; all saved-model writes use explicit plans.
   const plan=atomicPlan([statement('execute',s.sql,s.args||[],true)],{readOnly:/^\s*(SELECT|EXPLAIN)\b/i.test(s.sql)});
   const result=await db.summaryAtomic(plan);
   if(result.outcome==='unknown'){
    if(plan.readOnly&&result.reason==='response_limit')throw Object.assign(Error('ANALYTICS_PROJECTION_LIMIT'),{code:'ANALYTICS_PROJECTION_LIMIT',status:422});
    if(plan.readOnly)throw Object.assign(Error('ANALYTICS_DATABASE_UNAVAILABLE'),{code:'ANALYTICS_DATABASE_UNAVAILABLE',status:503});
    throw new SummaryOutcomeUnknown();
   }
   if(result.outcome!=='committed')throw Object.assign(Error('ANALYTICS_DATABASE_FAILED'),{code:'ANALYTICS_DATABASE_FAILED',status:503});
   return {rows:resultRows(plan,result,'execute'),rowsAffected:result.batch.step_results[1].affected_row_count};
  },
  close(){},
 };
 return db;
}
