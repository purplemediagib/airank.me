import test from 'node:test';
import assert from 'node:assert/strict';
import {CONFIRMATION,approvedWindow,mapSQL,fixedEndpoint,boundedTransport,budget,LIMITS} from '../policy.mjs';
const endpoint='https://atomic-fixture.invalid/v2/pipeline';
test('exact two-minute window, canonical expiry and explicit opt-in',()=>{
 const now=Date.parse('2026-11-04T18:00:00Z');
 assert.equal(approvedWindow(CONFIRMATION,'2026-11-04T18:01:00.000Z',now),true);
 for(const [c,e] of [[undefined,undefined],[CONFIRMATION,'never'],[CONFIRMATION,'2026-11-04T18:00:00.000Z'],[CONFIRMATION,'2026-11-04T18:02:01.000Z'],['wrong','2026-11-04T18:01:00.000Z']])assert.equal(approvedWindow(c,e,now),false);
});
test('only pinned endpoint accepted',()=>{
 assert.equal(fixedEndpoint(endpoint.replace('/v2/pipeline','/')),endpoint);
 assert.equal(fixedEndpoint(endpoint.replace('https:','libsql:').replace('/v2/pipeline','')),endpoint);
 assert.equal(fixedEndpoint(endpoint.replace('https:','libsql:').replace('/v2/pipeline','').toUpperCase()),endpoint);
 for(const host of ['https://example.com/','https://user:pass@atomic-fixture.invalid/','https://atomic-fixture.invalid/extra'])assert.throws(()=>fixedEndpoint(host));
});
test('SQL isolation rejects customer data, deletion, DDL alterations and chaining',()=>{
 for(const q of ['SELECT * FROM app_projects','SELECT * FROM sqlite_master','DELETE FROM analytics_summary_requests','DROP TABLE analytics_summary_heads','SELECT 1; SELECT 2','SELECT 1 -- hi','UPDATE arbitrary SET x=1','CREATE TABLE arbitrary(x)'])assert.throws(()=>mapSQL(q));
 assert.match(mapSQL('SELECT COUNT(*) n FROM analytics_summary_heads'),/FROM airank_http_smoke_20261104_ec81557_summary_heads/);
 assert.equal(mapSQL('BEGIN IMMEDIATE'),'BEGIN IMMEDIATE');
});
function request(sql='SELECT 1') {return new Request(endpoint,{method:'POST',redirect:'error',body:JSON.stringify({baton:null,requests:[{type:'execute',stmt:{sql,args:[],want_rows:true}},{type:'close'}]})});}
test('transport loss closes all subsequent attempts and never retries',async()=>{
 let calls=0;const state=budget();const tx=boundedTransport({endpoint,authorization:'Bearer local',expires:new Date(Date.now()+60000).toISOString(),state,fetchImpl:async()=>{calls++;throw Error('SECRET_RAW_ERROR');}});
 await assert.rejects(tx(request()),/TRANSPORT_UNKNOWN/);await assert.rejects(tx(request()),/UNKNOWN_HOLD/);assert.equal(calls,1);assert.equal(state.retries,0);
});
test('arbitrary host cannot call fetch',async()=>{
 let calls=0;const tx=boundedTransport({endpoint,authorization:'Bearer local',expires:new Date(Date.now()+60000).toISOString(),state:budget(),fetchImpl:async()=>{calls++;}});
 await assert.rejects(tx(new Request('https://evil.invalid/',{method:'POST',redirect:'error'})));assert.equal(calls,0);
});
test('request budget enforced before send',async()=>{
 let calls=0;const state=budget();state.requests=LIMITS.requests;
 const tx=boundedTransport({endpoint,authorization:'Bearer local',expires:new Date(Date.now()+60000).toISOString(),state,fetchImpl:async()=>{calls++;}});
 await assert.rejects(tx(request()));assert.equal(calls,0);
});
test('redirect refused without second destination and latches unknown',async()=>{
 let calls=0;const state=budget();const tx=boundedTransport({endpoint,authorization:'Bearer local',expires:new Date(Date.now()+60000).toISOString(),state,fetchImpl:async req=>{calls++;assert.equal(req.redirect,'error');return new Response(null,{status:302,headers:{location:'https://evil.invalid/'}});}});
 await assert.rejects(tx(request()),/TRANSPORT_UNKNOWN/);assert.equal(calls,1);assert.equal(state.unknown,true);
});
test('response byte cap cancels and stops future requests',async()=>{
 const state=budget();let calls=0;const tx=boundedTransport({endpoint,authorization:'Bearer local',expires:new Date(Date.now()+60000).toISOString(),state,fetchImpl:async()=>{calls++;return new Response('x'.repeat(LIMITS.responseBytes+1));}});
 await assert.rejects(tx(request()),/TRANSPORT_UNKNOWN/);await assert.rejects(tx(request()),/UNKNOWN_HOLD/);assert.equal(calls,1);
});
test('expired deadline and already-aborted signal are inert',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;};
 const expired=boundedTransport({endpoint,authorization:'Bearer local',expires:new Date(Date.now()-1).toISOString(),state:budget(),fetchImpl});await assert.rejects(expired(request()));
 const controller=new AbortController();controller.abort();const aborted=boundedTransport({endpoint,authorization:'Bearer local',expires:new Date(Date.now()+60000).toISOString(),state:budget(),fetchImpl,signal:controller.signal});await assert.rejects(aborted(request()));assert.equal(calls,0);
});
test('entire batch is validated before any request, even a late forbidden statement',async()=>{
 let calls=0;const state=budget();const tx=boundedTransport({endpoint,authorization:'Bearer local',expires:new Date(Date.now()+60000).toISOString(),state,fetchImpl:async()=>{calls++;}});
 const body={baton:null,requests:[{type:'batch',batch:{steps:[{stmt:{sql:'BEGIN IMMEDIATE',args:[]}},{stmt:{sql:'DELETE FROM analytics_summary_generations',args:[]}}]}},{type:'close'}]};
 await assert.rejects(tx(new Request(endpoint,{method:'POST',redirect:'error',body:JSON.stringify(body)})));assert.equal(calls,0);assert.equal(state.requests,0);
});
test('closed SQL corpus rejects identifier and expression escape variants',()=>{
 for(const sql of [
  'SELECT * FROM "other_table"','UPDATE "other_table" SET x=1','SELECT * FROM `other_table`','SELECT * FROM [other_table]',
  'SELECT * FROM analytics_summary_heads, other_table','SELECT * FROM main.analytics_summary_heads',
  'SELECT load_extension(?)','SELECT writefile(?,?)','SELECT COUNT(*) n FROM analytics_summary_heads UNION SELECT secret FROM other_table',
  'CREATE TABLE analytics_summary_heads(other TEXT)','SELECT * FROM analytics_summary_heads',
 ])assert.throws(()=>mapSQL(sql),sql);
});
