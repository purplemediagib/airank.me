import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createClient} from '@libsql/client';
import {PREFIX,TABLE_NAMES,LIMITS,guardStatement,guardedClient,makeBudget,normalizeDatabaseURL,boundedFetch,loadPublisher,runSmoke,verifyRetained,safeFailure} from '../src/analytics/smoke/publication-http-smoke.mjs';

// Local driver transactions are synchronous under the hood. Serialize writer
// acquisition so this test exercises exact libSQL tx.batch calls without falsely
// claiming a real HTTP/server concurrency result. The real harness has no lock.
async function localFixture(){
 const path=await mkdtemp(join(tmpdir(),'airank-publication-smoke-'));
 const clients=[0,1].map(()=>createClient({url:`file:${join(path,'synthetic.sqlite')}`}));
 let tail=Promise.resolve();
 const wrap=client=>({execute:q=>client.execute(q),transaction:async mode=>{
  let release;const waiting=new Promise(r=>{release=r;}),previous=tail;tail=tail.then(()=>waiting);await previous;
  let tx;try{tx=await client.transaction(mode);}catch(error){release();throw error;}
  let finished=false;const unlock=()=>{if(!finished){finished=true;release();}};
  return {execute:q=>tx.execute(q),batch:q=>tx.batch(q),commit:async()=>{try{await tx.commit();}finally{unlock();}},rollback:async()=>{try{await tx.rollback();}finally{unlock();}},close:()=>{try{tx.close();}finally{unlock();}}};
 }});
 return {clients:clients.map(wrap),raw:clients,close:async()=>{clients.forEach(c=>c.close());await rm(path,{recursive:true,force:true});}};
}
test('full bounded synthetic suite passes actual local libSQL batch with retained fixtures',async()=>{
 const f=await localFixture();try{
  const result=await runSmoke({primary:f.clients[0],secondary:f.clients[1],publishSummary:await loadPublisher()});
  assert.equal(result.status,'passed');assert.equal(result.tests.length,10);assert.ok(result.budget.transactionBatches>=20);assert.equal(result.budget.cleanupRows,0);assert.equal(result.budget.httpRequests,0);
  assert.ok(result.budget.queries<LIMITS.queries);assert.ok(result.budget.transactions<LIMITS.transactions);
  const all=await f.raw[0].execute('SELECT name FROM sqlite_master WHERE type=\'table\'');assert.deepEqual(all.rows.map(r=>r.name).sort(),[...TABLE_NAMES].sort());
  const before=await verifyRetained(guardedClient(f.clients[0],makeBudget(),{readOnly:true}));
  await assert.rejects(runSmoke({primary:f.clients[0],secondary:f.clients[1],publishSummary:await loadPublisher()}),e=>e.smokeCode==='SMOKE_PREFIX_ALREADY_EXISTS');
  assert.deepEqual(await verifyRetained(guardedClient(f.clients[0],makeBudget(),{readOnly:true})),before);
 }finally{await f.close();}
});
test('exact SQL allowlist rejects application tables, aliases, injection, reads and arbitrary DDL',()=>{
 for(const sql of ['SELECT * FROM app_projects','SELECT * FROM analytics_summary_requests','SELECT COUNT(*) n FROM sqlite_master','SELECT COUNT(*) n FROM analytics_summary_evidence; DELETE FROM users','SELECT COUNT(*) n FROM analytics_summary_evidence -- note','SELECT COUNT(*) n FROM "analytics_summary_evidence"','DROP TABLE analytics_summary_evidence','DELETE FROM analytics_summary_generations WHERE id=? AND published_at IS NULL',`SELECT COUNT(*) n FROM ${PREFIX}summary_evidence`,'PRAGMA foreign_keys=OFF','ATTACH DATABASE ? AS other','SELECT load_extension(?)']){
  assert.throws(()=>guardStatement({sql,args:[]}),e=>e.smokeCode==='SMOKE_SQL_REJECTED');
 }
 const q=guardStatement({sql:'SELECT COUNT(*) n FROM analytics_summary_evidence',args:[]});assert.equal(q.sql,`SELECT COUNT(*) n FROM ${PREFIX}summary_evidence`);
 assert.throws(()=>guardStatement({sql:'SELECT COUNT(*) n FROM analytics_summary_evidence',args:[],extra:true}));
 assert.throws(()=>guardStatement({sql:'SELECT COUNT(*) n FROM analytics_summary_evidence',args:['x'.repeat(LIMITS.statementArgumentBytes+1)]}));
 assert.throws(()=>guardStatement({sql:'UPDATE analytics_project_revisions SET revision=revision+1 WHERE project_id=?',args:['synthetic']},{readOnly:true}));
});
test('a batch is completely validated before sending any statement',async()=>{
 let calls=0;const raw={transaction:async()=>({batch:async()=>{calls++;},close(){},rollback:async()=>{},commit:async()=>{}})};
 const tx=await guardedClient(raw,makeBudget()).transaction('write');
 await assert.rejects(tx.batch([{sql:'SELECT COUNT(*) n FROM analytics_summary_evidence',args:[]},{sql:'SELECT * FROM users',args:[]}]));assert.equal(calls,0);tx.close();
});
test('query, batch, transaction and clock budgets fail closed',async()=>{
 let calls=0;const raw={execute:async()=>{calls++;return {rows:[]};},transaction:async()=>({batch:async()=>{calls++;return [];},execute:async()=>{calls++;},commit:async()=>{calls++;},rollback:async()=>{},close(){}})};
 const b=makeBudget();b.queries=LIMITS.queries;await assert.rejects(guardedClient(raw,b).execute({sql:'SELECT COUNT(*) n FROM analytics_summary_evidence',args:[]}));assert.equal(calls,0);
 const b2=makeBudget();b2.transactions=LIMITS.transactions;await assert.rejects(guardedClient(raw,b2).transaction('write'));
 let now=0;const b3=makeBudget(()=>now),tx=await guardedClient(raw,b3).transaction('write');now=LIMITS.transactionStartDeadlineMs+1;assert.throws(()=>tx.execute({sql:'SELECT COUNT(*) n FROM analytics_summary_evidence',args:[]}));await assert.rejects(tx.commit());
 const tx2=await guardedClient(raw,makeBudget()).transaction('write');await assert.rejects(tx2.batch(Array.from({length:LIMITS.batchStatements+1},()=>({sql:'SELECT COUNT(*) n FROM analytics_summary_evidence',args:[]}))));assert.equal(calls,0);
});
test('remote URL accepts only the supplied TLS database origin without embedded credentials',()=>{
 assert.equal(normalizeDatabaseURL('libsql://fixture.example.test').href,'https://fixture.example.test/');
 assert.equal(normalizeDatabaseURL('https://fixture.example.test/db').href,'https://fixture.example.test/db');
 for(const url of ['http://fixture.example.test','file:db','wss://fixture.example.test','https://secret@fixture.example.test','https://fixture.example.test?tls=0','https://fixture.example.test/#secret',undefined])assert.throws(()=>normalizeDatabaseURL(url));
});
test('bounded HTTP transport accepts same-origin requests and refuses redirects and oversize bytes',async()=>{
 let calls=0;const signal=new AbortController().signal,budget=makeBudget();
 const f=boundedFetch({url:'https://fixture.example.test/',budget,signal,fetchImpl:async request=>{calls++;assert.equal(request.redirect,'manual');return new Response('{"ok":true}',{status:200});}});
 const response=await f('https://fixture.example.test/v2/pipeline',{method:'POST',body:'{}'});assert.deepEqual(await response.json(),{ok:true});assert.equal(budget.httpRequests,1);assert.equal(budget.requestBytes,2);
 await assert.rejects(f('https://other.example.test/v2/pipeline',{method:'POST',body:'{}'}));assert.equal(calls,1);
 await assert.rejects(f('https://fixture.example.test/v2/pipeline',{method:'POST',body:'x'.repeat(LIMITS.requestBytes+1)}));assert.equal(calls,1);
 const redirect=boundedFetch({url:'https://fixture.example.test/',budget:makeBudget(),signal,fetchImpl:async()=>new Response('',{status:307,headers:{location:'https://other.example.test'}})});await assert.rejects(redirect('https://fixture.example.test/'),e=>e.smokeCode==='SMOKE_HTTP_REDIRECT_REJECTED');
 const large=boundedFetch({url:'https://fixture.example.test/',budget:makeBudget(),signal,fetchImpl:async()=>new Response('x'.repeat(LIMITS.responseBytes+1))});await assert.rejects(large('https://fixture.example.test/'),e=>e.smokeCode==='SMOKE_HTTP_BYTE_LIMIT');
});
test('CLI without exact confirmation is a credential-blind no-op and logs no secrets',()=>{
 const result=spawnSync(process.execPath,['src/analytics/smoke/publication-http-smoke.mjs'],{cwd:new URL('../',import.meta.url),encoding:'utf8',env:{PATH:process.env.PATH,BUNNY_DATABASE_URL:'must-not-be-read',BUNNY_DATABASE_AUTH_TOKEN:'never-log-this-secret'}});
 assert.equal(result.status,2);assert.deepEqual(JSON.parse(result.stdout),{event:'synthetic_publication_smoke',status:'not_run',reason:'explicit_confirmation_required'});assert.equal(result.stderr,'');assert.ok(!result.stdout.includes('never-log'));
});
test('failure classification never echoes driver messages, credentials, or SQL',()=>{
 assert.equal(safeFailure(new Error('secret at https://account.example.test')), 'SMOKE_FAILED');
 assert.equal(safeFailure({code:'SQLITE_BUSY',message:'secret'}),'DATABASE_CONTENTION_OR_CONSTRAINT');
 assert.equal(safeFailure({smokeCode:'https://secret'}),'SMOKE_FAILED');
});
test('publisher static import graph contains no provider dispatch, worker or migration execution',async()=>{
 const root=new URL('../src/',import.meta.url),seen=new Set(),queue=[new URL('analytics/summary-store.mjs',root)];
 while(queue.length){const url=queue.pop();if(seen.has(url.href))continue;seen.add(url.href);assert.ok(!/\/(providers?|worker)\//.test(url.pathname));assert.ok(!/worker\.mjs$/.test(url.pathname));const source=await readFile(url,'utf8');for(const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)){if(match[1].startsWith('.'))queue.push(new URL(match[1],url));}}
 assert.ok(seen.size>1);
});

test('hold wrapper stays healthy with accurate failure status and never reruns',async()=>{
 const {startSmokeHold}=await import('../src/analytics/smoke/publication-http-smoke-hold.mjs');let calls=0;
 const hold=await startSmokeHold({port:0,host:'127.0.0.1',emit:()=>{},run:async()=>{calls++;return {status:'failed',code:'fixture'};}});
 try{await hold.completed;const port=hold.server.address().port;for(const path of ['/healthz','/readyz']){const response=await fetch(`http://127.0.0.1:${port}${path}`);assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,service:'synthetic-publication-smoke-hold',smoke_status:'failed',projector_running:false,restore_required:true});}assert.equal(calls,1);assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status,404);}finally{await hold.stop();}
});
test('hold wrapper without opt-in does not invoke database setup and remains alive',async()=>{
 const {startSmokeHold}=await import('../src/analytics/smoke/publication-http-smoke-hold.mjs');const hold=await startSmokeHold({port:0,host:'127.0.0.1',emit:()=>{}});
 try{assert.deepEqual(await hold.completed,{status:'not_run',reason:'explicit_confirmation_required'});assert.equal(hold.server.listening,true);}finally{await hold.stop();}
});

test('failure after a staged chunk retains committed synthetic rows and never sends DELETE',async()=>{
 const f=await localFixture();let stagedChunks=0,deleteCalls=0;
 const wrap=raw=>({execute:q=>{if(/^DELETE/i.test(q.sql))deleteCalls++;return raw.execute(q);},transaction:async mode=>{
  const tx=await raw.transaction(mode);return {...tx,batch:async queries=>{
   const result=await tx.batch(queries);
   if(queries.some(q=>q.sql.includes('INSERT INTO')&&q.sql.includes('summary_evidence'))&&queries.some(q=>q.sql.includes('SET lease_until='))&&++stagedChunks===2)throw new Error('synthetic failure after prior chunk committed');
   return result;
  }};
 }});
 try{
  await assert.rejects(runSmoke({primary:wrap(f.clients[0]),secondary:wrap(f.clients[1]),publishSummary:await loadPublisher()}),error=>error.smokeCode==='SMOKE_COMMITTED_CLEANUP_REFUSED');
  assert.equal(deleteCalls,0);
  const retained=await verifyRetained(guardedClient(f.clients[0],makeBudget(),{readOnly:true}));
  assert.equal(retained.unpublished,1);assert.equal(retained.counts.summary_generations,3);assert.equal(retained.counts.summary_evidence,150);assert.equal(retained.counts.summary_heads,2);assert.equal(retained.orphanEvidence,0);
 }finally{await f.close();}
});

test('lost acknowledgement after commit preserves publication and blocks cleanup without rerun',async()=>{
 const f=await localFixture();let commits=0,deleteCalls=0;
 const wrap=raw=>({execute:q=>{if(/^DELETE/i.test(q.sql))deleteCalls++;return raw.execute(q);},transaction:async mode=>{
  const tx=await raw.transaction(mode);return {...tx,commit:async()=>{await tx.commit();if(++commits===2)throw new Error('synthetic lost commit acknowledgement');}};
 }});
 try{
  await assert.rejects(runSmoke({primary:wrap(f.clients[0]),secondary:wrap(f.clients[1]),publishSummary:await loadPublisher()}),error=>error.smokeCode==='SMOKE_COMMITTED_CLEANUP_REFUSED');
  assert.equal(deleteCalls,0);assert.equal(commits,2);
  const retained=await verifyRetained(guardedClient(f.clients[0],makeBudget(),{readOnly:true}));assert.equal(retained.counts.summary_heads,1);assert.equal(retained.counts.summary_generations,1);assert.equal(retained.unpublished,0);
  await assert.rejects(runSmoke({primary:f.clients[0],secondary:f.clients[1],publishSummary:await loadPublisher()}),error=>error.smokeCode==='SMOKE_PREFIX_ALREADY_EXISTS');
 }finally{await f.close();}
});

test('shared response byte quota rejects interleaved streams before both responses are accepted',async()=>{
 const budget=makeBudget();budget.responseBytes=LIMITS.totalResponseBytes-3;
 const transport=boundedFetch({url:'https://fixture.example.test/',budget,signal:new AbortController().signal,fetchImpl:async()=>{let timer;return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2]));timer=setTimeout(()=>c.close(),5);},cancel(){clearTimeout(timer);}}));}});
 const outcomes=await Promise.allSettled([transport('https://fixture.example.test/'),transport('https://fixture.example.test/')]);assert.equal(outcomes.filter(r=>r.status==='rejected').length,1);assert.equal(outcomes.find(r=>r.status==='rejected').reason.smokeCode,'SMOKE_HTTP_BYTE_LIMIT');
});

test('actual HTTP client transaction.batch passes complete suite through an in-process Hrana fixture',async()=>{
 // This is a transport-protocol test, not evidence of Bunny connectivity. Fetch
 // is replaced by this explicit in-process server; no network/credentials exist.
 const {DatabaseSync}=await import('node:sqlite');const {createClient:createHttpClient}=await import('@libsql/client/http');
 const dir=await mkdtemp(join(tmpdir(),'airank-hrana-smoke-')),streams=new Map();let sequence=0,writer=null,waiters=[];
 const decode=v=>v.type==='null'?null:v.type==='integer'||v.type==='float'?Number(v.value):v.value;
 const encode=v=>v===null?{type:'null'}:typeof v==='number'?{type:'integer',value:String(v)}:{type:'text',value:String(v)};
 const error=e=>({code:String(e.code||'SQLITE_ERROR'),message:e.message});
 const release=id=>{if(writer===id){writer=null;const w=waiters.shift();if(w)w();}};
 const condition=(c,r,e,stream)=>!c?true:c.type==='ok'?r[c.step]!==null:c.type==='error'?e[c.step]!==null:c.type==='not'?!condition(c.cond,r,e,stream):c.type==='and'?c.conds.every(v=>condition(v,r,e,stream)):c.type==='or'?c.conds.some(v=>condition(v,r,e,stream)):!stream.sql.isTransaction;
 async function execute(stream,q){
  const sql=q.sql??stream.cached.get(q.sql_id);assert.ok(typeof sql==='string');
  if(/^BEGIN/.test(sql)){while(writer!==null&&writer!==stream.id)await new Promise(resolve=>waiters.push(resolve));writer=stream.id;}
  try{
   const stmt=stream.sql.prepare(sql),cols=stmt.columns().map(c=>({name:c.name,decltype:c.type||null}));
   if(cols.length)return {cols,rows:stmt.all(...q.args.map(decode)).map(r=>cols.map(c=>encode(r[c.name]))),affected_row_count:0,last_insert_rowid:null};
   const result=stmt.run(...q.args.map(decode));if(/^(COMMIT|ROLLBACK)/.test(sql))release(stream.id);
   return {cols:[],rows:[],affected_row_count:Number(result.changes),last_insert_rowid:String(result.lastInsertRowid)};
  }catch(e){if(/^BEGIN/.test(sql))release(stream.id);throw e;}
 }
 const fetchImpl=async request=>{
  assert.equal(new URL(request.url).hostname,'fixture.example.test');assert.equal(request.method,'POST');
  const body=await request.json();let stream=body.baton?streams.get(body.baton):null;
  if(!stream){stream={id:`stream-${++sequence}`,sql:new DatabaseSync(join(dir,'synthetic.sqlite')),cached:new Map()};streams.set(stream.id,stream);}
  const results=[];let closed=false;
  for(const q of body.requests){try{
   let response;
   if(q.type==='store_sql'){stream.cached.set(q.sql_id,q.sql);response={type:q.type};}
   else if(q.type==='close_sql'){stream.cached.delete(q.sql_id);response={type:q.type};}
   else if(q.type==='execute')response={type:q.type,result:await execute(stream,q.stmt)};
   else if(q.type==='batch'){
    const step_results=[],step_errors=[];
    for(const step of q.batch.steps){const i=step_results.length;if(!condition(step.condition,step_results,step_errors,stream)){step_results.push(null);step_errors.push(null);continue;}try{step_results.push(await execute(stream,step.stmt));step_errors.push(null);}catch(e){step_results[i]=null;step_errors[i]=error(e);}}
    response={type:q.type,result:{step_results,step_errors}};
   }else if(q.type==='close'){stream.sql.close();streams.delete(stream.id);release(stream.id);closed=true;response={type:q.type};}
   else if(q.type==='get_autocommit')response={type:q.type,is_autocommit:!stream.sql.isTransaction};
   else throw new Error(`unexpected protocol operation ${q.type}`);
   results.push({type:'ok',response});
  }catch(e){results.push({type:'error',error:error(e)});}}
  return new Response(JSON.stringify({baton:closed?null:stream.id,base_url:null,results}),{status:200,headers:{'content-type':'application/json'}});
 };
 const budget=makeBudget(),signal=new AbortController().signal;
 const transport=boundedFetch({url:'https://fixture.example.test/',budget,signal,fetchImpl});
 const clients=[0,1].map(()=>createHttpClient({url:'https://fixture.example.test/',fetch:transport,concurrency:1}));
 try{
  const result=await runSmoke({primary:clients[0],secondary:clients[1],budget,publishSummary:await loadPublisher()});
  assert.equal(result.status,'passed');assert.ok(result.budget.httpRequests>160);assert.ok(result.budget.httpRequests<LIMITS.httpRequests);assert.ok(result.budget.transactionBatches>0);
  console.log(`Synthetic in-process HTTP metrics: ${JSON.stringify(result.budget)}`);
 }finally{clients.forEach(c=>c.close());for(const s of streams.values()){s.sql.close();release(s.id);}await rm(dir,{recursive:true,force:true});}
});
