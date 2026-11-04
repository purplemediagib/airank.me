// Offline fixtures only. No production URLs, credentials, or network transports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {probe, TABLES, FAILURE_REASONS, normalizeEndpoint} from './probe.mjs';
const base = 'https://authorized.example.invalid/';
const secret = 'ATTACKER_PRIVATE_VALUE_8fa970';
const options = {configuredURL:base, verifiedDatabaseURL:base, authorization:`Bearer ${secret}`};
function empty() {
 return {baton:null,base_url:null,results:[
  {type:'ok',response:{type:'execute',result:{cols:[{name:'1',decltype:null}],rows:[],affected_row_count:0}}},
  {type:'ok',response:{type:'close'}},
 ]};
}
function absent(table,code,message) {
 const body=empty(); body.results[0]={type:'error',error:{code,message}}; return body;
}
function errorBody(code,message) {return absent(TABLES[0],code,message);}
function assertRedacted(report) {
 const serialized=JSON.stringify(report);
 for(const value of [secret,'authorized.example.invalid','attacker.invalid','no such table:','SQLite error:','SQL input error:','SQLITE_ERROR','SQLITE_UNKNOWN','SQL_INPUT_ERROR']) assert.ok(!serialized.includes(value));
 assert.equal(report.retries,0);assert.equal(report.writes,0);
 assert.ok(report.requests>=0 && report.requests<=6);
 for(const entry of report.tables) {
  assert.ok(TABLES.includes(entry.table));
  assert.ok(['unknown','absent','present_empty','present_nonempty'].includes(entry.state));
  assert.ok(['absent','invalid','same_origin','changed_origin'].includes(entry.routing));
  if(entry.origin_sha256!==undefined)assert.match(entry.origin_sha256,/^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(entry).sort(),['table','state','routing',...(entry.origin_sha256 ? ['origin_sha256']:[])].sort());
 }
 if(report.status==='inconclusive')assert.ok(FAILURE_REASONS.includes(report.failure_reason));
 else assert.equal(report.failure_reason,undefined);
}
async function run(factory) {
 let calls=0;
 const report=await probe({...options,fetchImpl:async request=>{
  const i=calls++;
  assert.equal(request.url,`${base}v2/pipeline`);assert.equal(request.method,'POST');assert.equal(request.redirect,'manual');
  assert.equal(request.headers.get('authorization'),`Bearer ${secret}`);
  assert.deepEqual(await request.json(),{baton:null,requests:[{type:'execute',stmt:{sql:`SELECT 1 FROM ${TABLES[i]} LIMIT 1`,args:[],named_args:[],want_rows:true}},{type:'close'}]});
  return factory(TABLES[i],i,request);
 }});
 assert.equal(report.requests,calls); assertRedacted(report);return report;
}
async function rejected(body,reason) {
 const report=await run(()=>Response.json(body));
 assert.equal(report.status,'inconclusive');assert.equal(report.requests,1);assert.equal(report.failure_reason,reason);
 assert.ok(report.tables.every(row=>row.state==='unknown'));return report;
}
const variants=[
 ['legacy', t=>['SQLITE_ERROR',`no such table: ${t}`]],
 ['sqlite', t=>['SQLITE_UNKNOWN',`SQLite error: no such table: ${t}`]],
 ...[-1,0,14].map(n=>[`input offset ${n}`,t=>['SQL_INPUT_ERROR',`SQL input error: no such table: ${t} (at offset ${n})`]]),
];
for(const [name,variant] of variants) test(`supported missing-table representation: ${name}, all six exact tables`,async()=>{
 const result=await run(table=>{const [code,message]=variant(table);return Response.json(absent(table,code,message));});
 assert.equal(result.status,'observed');assert.equal(result.requests,6);assert.ok(result.tables.every(row=>row.state==='absent'));
});
test('input offset final character remains a bounded representation',async()=>{
 const result=await run(table=>Response.json(absent(table,'SQL_INPUT_ERROR',`SQL input error: no such table: ${table} (at offset ${`SELECT 1 FROM ${table} LIMIT 1`.length-1})`)));
 assert.equal(result.status,'observed');
});
for(const name of ['1',null,undefined]) for(const count of [0,1,4294967296,Number.MAX_SAFE_INTEGER]) for(const hasRow of [false,true]) test(`name ${name}, safe SELECT count ${count}, row ${hasRow}`,async()=>{
 const body=empty();const value=body.results[0].response.result;
 value.cols[0].name=name;value.affected_row_count=count;
 if(hasRow)value.rows=[[{type:'integer',value:'1'}]];
 const report=await run(()=>Response.json(body));assert.equal(report.status,'observed');assert.ok(report.tables.every(row=>row.state===(hasRow?'present_nonempty':'present_empty')));
});
const wrongErrors=[
 ['wrong table','SQLITE_ERROR',`no such table: ${TABLES[1]}`],
 ['unrelated table','SQLITE_ERROR','no such table: customers'],
 ['prefix collision','SQLITE_ERROR',`no such table: ${TABLES[0]}_extra`],
 ['schema qualified','SQLITE_ERROR',`no such table: main.${TABLES[0]}`],
 ['quoted identifier','SQLITE_ERROR',`no such table: "${TABLES[0]}"`],
 ['trailing newline','SQLITE_ERROR',`no such table: ${TABLES[0]}\n`],
 ['leading space','SQLITE_ERROR',` no such table: ${TABLES[0]}`],
 ['trailing text','SQLITE_ERROR',`no such table: ${TABLES[0]} ${secret}`],
 ['nested message','SQLITE_ERROR',`permission failure: no such table: ${TABLES[0]}`],
 ['different case','SQLITE_ERROR',`No such table: ${TABLES[0]}`],
 ['homoglyph','SQLITE_ERROR',`no such table: ${TABLES[0].replace('airank','aırank')}`],
 ['wrong error code','SQLITE_BUSY',`no such table: ${TABLES[0]}`],
 ['attacker error code',secret,`no such table: ${TABLES[0]}`],
 ['bare UNKNOWN not sourced','SQLITE_UNKNOWN',`no such table: ${TABLES[0]}`],
 ['wrapped legacy not sourced','SQLITE_ERROR',`SQLite error: no such table: ${TABLES[0]}`],
 ['SQL_INPUT wrong prefix','SQL_INPUT_ERROR',`SQLite error: no such table: ${TABLES[0]}`],
 ['wrapped SQLITE wrong code','SQLITE_UNKNOWN',`SQL input error: no such table: ${TABLES[0]} (at offset 14)`],
 ...['','00','+1','-0','-2','01','1.0','1e0',' 1','1 ','999','2147483647',secret,'14) extra (at offset 14','14\n'].map(n=>[`bad offset ${n.length}`,'SQL_INPUT_ERROR',`SQL input error: no such table: ${TABLES[0]} (at offset ${n})`]),
 ['offset at end','SQL_INPUT_ERROR',`SQL input error: no such table: ${TABLES[0]} (at offset ${`SELECT 1 FROM ${TABLES[0]} LIMIT 1`.length})`],
 ['offset suffixed','SQL_INPUT_ERROR',`SQL input error: no such table: ${TABLES[0]} (at offset 14)\n`],
 ['metadata oversized within bound','SQLITE_ERROR',secret.repeat(1000)],
];
for(const [name,code,message] of wrongErrors)test(`ambiguous absence remains unknown: ${name}`,async()=>rejected(errorBody(code,message),'error_unsupported'));
const malformed=[
 ['missing error',b=>{b.results[0]={type:'error'};},'error_shape'],
 ['null error',b=>{b.results[0]={type:'error',error:null};},'error_shape'],
 ['array error',b=>{b.results[0]={type:'error',error:[]};},'error_shape'],
 ['nonstring code',b=>{b.results[0]={type:'error',error:{code:1,message:`no such table: ${TABLES[0]}`}};},'error_shape'],
 ['nonstring message',b=>{b.results[0]={type:'error',error:{code:'SQLITE_ERROR',message:{text:secret}}};},'error_shape'],
 ['success and error ambiguity',b=>{b.results[0].error={code:'SQLITE_ERROR',message:`no such table: ${TABLES[0]}`};},'execute_slot'],
 ['error and success ambiguity',b=>{b.results[0]={...errorBody('SQLITE_ERROR',`no such table: ${TABLES[0]}`).results[0],response:b.results[0].response};},'error_ambiguous'],
 ['wrong execution type',b=>{b.results[0].type=secret;},'execute_slot'],
 ['wrong response type',b=>{b.results[0].response.type='batch';},'execute_response'],
 ['null result',b=>{b.results[0].response.result=null;},'execute_result'],
 ['missing column list',b=>{delete b.results[0].response.result.cols;},'column_shape'],
 ['empty column list',b=>{b.results[0].response.result.cols=[];},'column_shape'],
 ['multiple columns',b=>{b.results[0].response.result.cols=[{name:'1'},{name:'1'}];},'column_shape'],
 ['null column',b=>{b.results[0].response.result.cols=[null];},'column_shape'],
 ['nonstring name',b=>{b.results[0].response.result.cols[0].name=1;},'column_name'],
 ['unexpected column name',b=>{b.results[0].response.result.cols[0].name=secret;},'column_name'],
 ['invalid decltype',b=>{b.results[0].response.result.cols[0].decltype={private:secret};},'column_decltype'],
 ...[undefined,null,-1,0.5,Number.MAX_SAFE_INTEGER+1,'0',false,{},[],Infinity,NaN].map(count=>[`bad affected count ${typeof count}`,b=>{b.results[0].response.result.affected_row_count=count;},'affected_row_count_shape']),
 ['missing rows',b=>{delete b.results[0].response.result.rows;},'row_shape'],
 ['object rows',b=>{b.results[0].response.result.rows={length:0};},'row_shape'],
 ['multiple rows',b=>{b.results[0].response.result.rows=[[{type:'integer',value:'1'}],[{type:'integer',value:'1'}]];},'row_shape'],
 ...[[],null,{0:{type:'integer',value:'1'},length:1},[{type:'integer',value:1}],[{type:'integer',value:'01'}],[{type:'float',value:1}],[{type:'text',value:secret}],[{type:'null'}],[{type:'integer',value:'1'},{type:'integer',value:'1'}]].map(row=>['bad row or constant',b=>{b.results[0].response.result.rows=[row];},'value_shape']),
 ['missing slots',b=>{delete b.results;},'pipeline_slots'],
 ['one slot',b=>{b.results.pop();},'pipeline_slots'],
 ['three slots',b=>{b.results.push(b.results[1]);},'pipeline_slots'],
 ['null close',b=>{b.results[1]=null;},'close_slot'],
 ['unknown close slot',b=>{b.results[1].type=secret;},'close_slot'],
 ['close error',b=>{b.results[1]={type:'error',error:{code:secret,message:secret}};},'close_error'],
 ['ambiguous close',b=>{b.results[1].error={code:secret,message:secret};},'close_slot'],
 ['wrong close response',b=>{b.results[1].response.type='execute';},'close_response'],
 ['missing baton',b=>{delete b.baton;},'baton_missing'],
 ['open baton',b=>{b.baton=secret;},'baton_open'],
 ['empty string baton',b=>{b.baton='';},'baton_open'],
 ['numeric baton',b=>{b.baton=0;},'baton_shape'],
];
for(const [name,mutate,reason] of malformed)test(`malformed response: ${name}`,async()=>{const body=empty();mutate(body);await rejected(body,reason);});
for(const value of [null,[],true,42,'secret'])test(`non-object envelope: ${typeof value}`,async()=>rejected(value,'envelope_shape'));
test('changed-origin metadata by itself is not a failure',async()=>{
 const body=empty();body.base_url=`https://attacker.invalid/${secret}`;
 const report=await run(()=>Response.json(body));assert.equal(report.status,'observed');assert.ok(report.tables.every(row=>row.routing==='changed_origin'));
});
test('original live report is preserved evidence, without invented body or cause',async()=>{
 const report=JSON.parse(await readFile(new URL('./live-observation.json',import.meta.url),'utf8'));
 assert.deepEqual(report,{event:'read_only_fixture_probe',status:'inconclusive',tables:[{table:TABLES[0],state:'unknown',routing:'changed_origin',origin_sha256:'7d475d6610134e4b92ad5e7e9d8e09dde1f6ca703d1a56a3696bb4b4f351d0d1'}],requests:1,retries:0,writes:0});
 assert.equal(report.failure_reason,undefined);assert.equal(report.raw_response,undefined);
});
for(const [name,mutate,reason] of [malformed[0],malformed.find(x=>x[0]==='close error'),malformed.find(x=>x[0]==='open baton'),malformed.find(x=>x[0]==='unexpected column name')])test(`distinct simulated explanation compatible with historical unknown: ${name}`,async()=>{
 const body=empty();body.base_url=`https://attacker.invalid/${secret}`;mutate(body);
 const report=await rejected(body,reason);assert.equal(report.tables[0].routing,'changed_origin');
});
test('byte bound accepts exactly 64KiB and rejects the next byte',async()=>{
 const body=empty();body.unknown='';const baseText=JSON.stringify(body);
 const exact=JSON.stringify({...body,unknown:'x'.repeat(65536-Buffer.byteLength(baseText))});assert.equal(Buffer.byteLength(exact),65536);
 assert.equal((await run(()=>new Response(exact))).status,'observed');
 const report=await run(()=>new Response(exact+' '));assert.equal(report.failure_reason,'body_limit');assert.equal(report.requests,1);
});
test('64KiB cap applies across streamed chunks and cancels reader',async()=>{
 let cancelled=false;const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(40000));c.enqueue(new Uint8Array(30000));},cancel(){cancelled=true;}});
 const report=await run(()=>new Response(stream));assert.equal(report.failure_reason,'body_limit');assert.equal(cancelled,true);
});
for(const raw of ['{',`{"results":[],"results":${JSON.stringify(empty().results)},"baton":null}`,`{"baton":"${secret}","b\\u0061ton":null,"results":${JSON.stringify(empty().results)}}`,JSON.stringify(empty()).replace('"name":"1"','"name":"bad","name":"1"')])test('invalid or duplicate-key JSON is inconclusive',async()=>{
 const report=await run(()=>new Response(raw));assert.equal(report.status,'inconclusive');assert.ok(['body_json_invalid','body_duplicate_key'].includes(report.failure_reason));
});
test('invalid UTF8 is not silently replaced',async()=>{
 const report=await run(()=>new Response(new Uint8Array([123,34,120,34,58,34,255,34,125])));assert.equal(report.failure_reason,'body_json_invalid');
});
test('valid escaped strings, braces and commas do not confuse duplicate scanner',async()=>{
 const body=empty();body.future_metadata={'escaped"key':'{ [ " , \\ } ]',nested:[{name:'one'},{name:'two'}]};
 assert.equal((await run(()=>Response.json(body))).status,'observed');
});
test('untrusted exception cannot spoof a failure reason or leak content',async()=>{
 const report=await run(()=>{throw {reason:secret,message:secret,stack:secret};});assert.equal(report.failure_reason,'transport_failure');
});
test('response URL mismatch is rejected even without redirected flag',async()=>{
 const response=Response.json(empty());Object.defineProperty(response,'url',{value:`https://attacker.invalid/${secret}`});
 assert.equal((await run(()=>response)).failure_reason,'http_rejected');
});
test('all six requests retain 45s overall and 6s per-request timeout configuration',async()=>{
 const original=AbortSignal.timeout;const timeouts=[];
 AbortSignal.timeout=ms=>{timeouts.push(ms);return new AbortController().signal;};
 try {assert.equal((await run(()=>Response.json(empty()))).status,'observed');assert.deepEqual(timeouts,[45000,...Array(6).fill(6000)]);}finally{AbortSignal.timeout=original;}
});
for(const budget of ['overall','request'])test(`${budget} abort stops without retry even if mock fetch returns after abort`,async()=>{
 const original=AbortSignal.timeout;const controllers=[];
 AbortSignal.timeout=()=>{const c=new AbortController();controllers.push(c);return c.signal;};
 try {const report=await run(()=>{controllers[budget==='overall'?0:1].abort(secret);return Response.json(empty());});assert.equal(report.failure_reason,'aborted');assert.equal(report.requests,1);}finally{AbortSignal.timeout=original;}
});
test('failure after a successful table never retries or continues',async()=>{
 const report=await run((_,i)=>{const body=empty();if(i===1)body.baton=secret;return Response.json(body);});
 assert.equal(report.requests,2);assert.equal(report.tables[0].state,'present_empty');assert.equal(report.tables[1].state,'unknown');assert.equal(report.failure_reason,'baton_open');
});
for(const url of ['http://authorized.example.invalid/','https://user:pass@authorized.example.invalid/','https://authorized.example.invalid/path','https://authorized.example.invalid/?token=x','https://authorized.example.invalid/#x','file:///tmp'])test('configuration rejection performs no request',async()=>{
 await assert.rejects(probe({...options,configuredURL:url,fetchImpl:()=>assert.fail('network prohibited')}),/CONFIG_REJECTED/);
});
test('libsql normalization still matches separately verified root exactly',()=>assert.equal(normalizeEndpoint('libsql://authorized.example.invalid/').href,base));
test('no implicit native fetch: transport remains mandatory',async()=>assert.rejects(probe(options),/CONFIG_REJECTED/));
for(const id of [null,'0','1','-1','9223372036854775807','-9223372036854775808'])test('optional insert rowid accepts bounded signed-int64 representation',async()=>{
 const body=empty();body.results[0].response.result.last_insert_rowid=id;assert.equal((await run(()=>Response.json(body))).status,'observed');
});
for(const id of [1,{},[],true,'','01','1.1','1e0','9223372036854775808','-9223372036854775809',secret])test('malformed optional insert rowid is unknown',async()=>{
 const body=empty();body.results[0].response.result.last_insert_rowid=id;await rejected(body,'insert_rowid_shape');
});
test('original classifier rejects supported variants; corrected classifier observes them offline',async()=>{
 const {probe:originalProbe}=await import('./baseline/probe.original.mjs');
 for(const [_,variant] of variants.slice(1)) {
  const [code,message]=variant(TABLES[0]);const body=absent(TABLES[0],code,message);
  const before=await originalProbe({...options,fetchImpl:async()=>Response.json(body)});
  assert.equal(before.status,'inconclusive');assert.equal(before.tables[0].state,'unknown');assert.equal(before.requests,1);
 }
 for(const mutate of [body=>{body.results[0].response.result.cols[0].name=null;},body=>{body.results[0].response.result.affected_row_count=1;}]) {
  const body=empty();mutate(body);
  const before=await originalProbe({...options,fetchImpl:async()=>Response.json(body)});
  assert.equal(before.status,'inconclusive');assert.equal(before.tables[0].state,'unknown');
  assert.equal((await run(()=>Response.json(body))).status,'observed');
 }
});

for(const code of [undefined,null]) for(const [name,variant] of variants)test(`optional error code ${code}: ${name}`,async()=>{
 const report=await run(table=>Response.json(absent(table,code,variant(table)[1])));assert.equal(report.status,'observed');assert.ok(report.tables.every(row=>row.state==='absent'));
});
for(const code of [undefined,null]) for(const [name,_,message] of wrongErrors.filter(([name])=>!['wrong error code','attacker error code','bare UNKNOWN not sourced','wrapped legacy not sourced','SQL_INPUT wrong prefix','wrapped SQLITE wrong code'].includes(name)))test(`optional code still rejects unsupported message: ${name}`,async()=>rejected(errorBody(code,message),'error_unsupported'));
