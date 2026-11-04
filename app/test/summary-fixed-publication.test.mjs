import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,evidence} from './summary-fixed-model.mjs';
import {publishSummary,claimSummary,cleanupSummaries,demandSummary,failSummary,assertPublicationSafe,readSummaryClock} from '../src/analytics/summary-store.mjs';
import {createSummaryDatabase,sendFixed} from '../src/analytics/summary-transport.mjs';
import {atomicPlan,statement,CLOCK_SQL} from '../src/analytics/summary-plans.mjs';
const withFixture=fn=>async()=>{const f=fixture();try{await fn(f);}finally{f.close();}};
test('fixed compact publication clears acknowledged intent and preserves complete immutable payloads',withFixture(async f=>{
 const e=evidence(4),result=await publishSummary(f.adapter,f.job,{ok:true},e,()=>0);
 assert.equal(result.published,true);assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_evidence').n,4);
 assert.equal(f.row('SELECT last_error FROM analytics_summary_requests').last_error,null);
 assert.equal(f.row('SELECT published_at FROM analytics_summary_generations').published_at,f.now);
}));
test('fixed staged publication renews using DB clock and finalizes',withFixture(async f=>{
 const result=await publishSummary(f.adapter,f.job,{ok:true},evidence(101),()=>-1);
 assert.equal(result.published,true);assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_evidence').n,101);
}));
for(const phase of ['intent','compact','setup','stage','final'])test(`unknown ${phase} causes no dependent mutation and quarantine survives restart`,withFixture(async f=>{
 let lost=false,after=0;
 f.adapter.summaryAtomic=async plan=>{
  if(lost){after++;throw Error('dependent write');}
  const result=await f.run(plan);
  if(plan.phase===phase){lost=true;return {outcome:'unknown',reason:'transport'};}
  return result;
 };
 await assert.rejects(publishSummary(f.adapter,f.job,{ok:true},evidence(['setup','stage','final'].includes(phase)?101:1)),{code:'ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN'});
 assert.equal(after,0);
 // Final/compact may have atomically committed and cleared intent. In those
 // cases a fresh process sees a complete publication, never reclaims partial work.
 const restarted={...f.adapter,summaryAtomic:plan=>f.run(plan)};
 if(['intent','setup','stage'].includes(phase)){
  await assert.rejects(assertPublicationSafe(restarted),{code:'ANALYTICS_PUBLICATION_QUARANTINED'});
  await assert.rejects(claimSummary(restarted,'f',f.now+999999999),{code:'ANALYTICS_PUBLICATION_QUARANTINED'});
  await assert.rejects(cleanupSummaries(restarted,Infinity),{code:'ANALYTICS_PUBLICATION_QUARANTINED'});
  await assert.rejects(demandSummary(restarted,'p','q',new URLSearchParams(),'f',Infinity),{code:'ANALYTICS_PUBLICATION_QUARANTINED'});
  await assert.rejects(failSummary(restarted,f.job,Error('x'),Infinity),{code:'ANALYTICS_PUBLICATION_QUARANTINED'});
 }else{assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_heads').n,1);assert.equal(await claimSummary(restarted,'f',Infinity),null);}
}));
test('lost intent before server execution sends no publication; delayed intent cannot capture reclaimed token',withFixture(async f=>{
 let intent;f.adapter.summaryAtomic=async p=>{intent=p;return {outcome:'unknown'};};
 await assert.rejects(publishSummary(f.adapter,f.job,{},evidence(1)),{code:'ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN'});
 assert.equal(f.row('SELECT last_error FROM analytics_summary_requests').last_error,null);
 f.advance(700000);f.claim('replacement');
 const result=await f.run(intent);assert.equal(result.outcome,'rolled_back');assert.equal(f.row('SELECT last_error FROM analytics_summary_requests').last_error,null);
}));
test('known stage rollback permits guarded abort; unknown abort is not retried',withFixture(async f=>{
 let aborted=false;
 f.adapter.summaryAtomic=async p=>{
  if(p.phase==='stage')return f.run(p,{before:({label,conn})=>{if(label==='insert_evidence')conn.exec('SELECT no_such_column');}});
  if(p.labels.includes('abort_intent')){aborted=true;await f.run(p);return {outcome:'unknown'};}
  return f.run(p);
 };
 await assert.rejects(publishSummary(f.adapter,f.job,{},evidence(101)),{code:'ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN'});assert.equal(aborted,true);
}));
test('store demand/claim/clock use one shared database clock not host',withFixture(async f=>{
 f.exec("DELETE FROM analytics_summary_requests");
 await demandSummary(f.adapter,'p','q',new URLSearchParams(),'f',0);
 const job=await claimSummary(f.adapter,'f',Infinity);assert.equal(job.lease_until,f.now+600000);assert.equal(await readSummaryClock(f.adapter,-1),f.now);
}));
test('transport never adopts routing URL, rejects escaped duplicate keys and malformed UTF8',async()=>{
 const plan=atomicPlan([statement('read','SELECT 1',[],true)],{readOnly:true});
 let calls=0;
 const fetch=async(url,options)=>{calls++;assert.equal(url,'https://fixed.example/v2/pipeline');assert.equal(options.redirect,'error');return new Response('{"baton":"x","b\\u0061ton":null,"results":[]}');};
 assert.equal((await sendFixed(plan,{endpoint:'https://fixed.example/v2/pipeline',fetch})).outcome,'unknown');assert.equal(calls,1);
 const invalid=async()=>new Response(Uint8Array.of(0xff));assert.equal((await sendFixed(plan,{endpoint:'https://fixed.example/v2/pipeline',fetch:invalid})).outcome,'unknown');
});
test('credential-bearing transport only sends to configured origin once',async()=>{
 const db=createSummaryDatabase({url:'libsql://fixed.example',authToken:'synthetic',fetch:async(url,options)=>{
  assert.equal(url,'https://fixed.example/v2/pipeline');assert.equal(options.headers.authorization,'Bearer synthetic');assert.equal(options.redirect,'error');
  const request=JSON.parse(options.body);assert.equal(request.baton,null);assert.equal(request.requests.length,2);assert.equal(request.requests[1].type,'close');
  return new Response('{"baton":null,"base_url":"https://evil.example","results":[]}');
 }});
 await assert.rejects(db.execute('SELECT 1'),{code:'ANALYTICS_DATABASE_UNAVAILABLE'});
});

test('every compact SQL failure is rollback-fenced and never publishes a partial generation',withFixture(async f=>{
 // Fresh claim per run. The acknowledged intent is allowed to be safely aborted.
 let indices;
 f.adapter.summaryAtomic=async p=>{if(p.phase==='compact'){indices=p.commit+1;return {outcome:'unknown'};}return f.run(p);};
 await assert.rejects(publishSummary(f.adapter,f.job,{},evidence(2)));
 f.exec("UPDATE analytics_summary_requests SET last_error=NULL");
 for(let inject=0;inject<indices;inject++){
  const job=f.claim();
  f.adapter.summaryAtomic=async p=>f.run(p,p.phase==='compact'?{before:({index,conn})=>{if(index===inject)conn.exec('SELECT definitely_missing');}}:{});
  assert.equal((await publishSummary(f.adapter,job,{},evidence(2))).published,false);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_heads').n,0);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_generations').n,0);
  assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_payloads').n,0);
  assert.equal(f.row('SELECT last_error FROM analytics_summary_requests').last_error,null);
 }
}));
test('late lease expiry after head swap rolls back publication and preserves prior pin',withFixture(async f=>{
 const first=await publishSummary(f.adapter,f.job,{},evidence(2));
 const job=f.claim();
 f.adapter.summaryAtomic=p=>f.run(p,{after:({label})=>{if(label==='swap_head')f.now=job.lease_until;}});
 assert.equal((await publishSummary(f.adapter,job,{new:true},evidence(3))).published,false);
 assert.equal(f.row('SELECT generation_id FROM analytics_summary_heads').generation_id,first.generation);
 assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_evidence WHERE generation_id=?',first.generation).n,2);
}));
test('caller mutation after intent cannot modify frozen publication input',withFixture(async f=>{
 const rows=evidence(101),original=rows[100].answer;
 f.adapter.summaryAtomic=async p=>{const r=await f.run(p);if(p.phase==='intent')rows[100].answer='changed';return r;};
 const result=await publishSummary(f.adapter,f.job,{},rows);
 const saved=f.row('SELECT p.payload FROM analytics_summary_evidence e JOIN analytics_summary_payloads p ON p.hash=e.payload_hash WHERE generation_id=? AND position=100',result.generation);
 assert.equal(JSON.parse(saved.payload).answer,original);
}));
test('known source churn before intent promptly requeues without quarantine',withFixture(async f=>{
 f.exec("UPDATE analytics_project_revisions SET revision=2");
 const result=await publishSummary(f.adapter,f.job,{},evidence(1));assert.equal(result.reason,'source_changed');
 const row=f.row('SELECT lease_token,last_error,next_attempt_at FROM analytics_summary_requests');assert.equal(row.lease_token,null);assert.equal(row.last_error,null);assert.equal(row.next_attempt_at,f.now+1000);
}));
test('known staged abort retains acknowledged immutable rows for bounded expiry cleanup',withFixture(async f=>{
 f.adapter.summaryAtomic=p=>f.run(p,{before:({label})=>{if(p.phase==='stage'&&label==='source_changed'&&f.row('SELECT COUNT(*) n FROM analytics_summary_evidence').n===50)f.exec('UPDATE analytics_project_revisions SET revision=2');}});
 // Source update must happen outside the writer transaction, emulate between stages.
 let stages=0;f.adapter.summaryAtomic=async p=>{if(p.phase==='stage'&&stages++===1)f.exec('UPDATE analytics_project_revisions SET revision=2');return f.run(p);};
 assert.equal((await publishSummary(f.adapter,f.job,{},evidence(101))).published,false);
 assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_evidence').n,50);assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_heads').n,0);
 assert.equal(f.row('SELECT last_error FROM analytics_summary_requests').last_error,null);
 f.advance(700000);await cleanupSummaries(f.adapter);assert.equal(f.row('SELECT COUNT(*) n FROM analytics_summary_evidence').n,0);
}));

test('malformed acknowledged claim and renewal are unknown, never ordinary retry errors',withFixture(async f=>{
 const {renewSummaryLease}=await import('../src/analytics/summary-store.mjs');
 f.exec('UPDATE analytics_summary_requests SET lease_until=0');
 f.adapter.summaryAtomic=async p=>{
  const r=await f.run(p);
  const i=p.labels.indexOf('claimed');
  if(i>=0){const s=r.batch.step_results[i],c=s.cols.findIndex(x=>x.name==='source_revision');s.rows[0][c]={type:'float',value:1.5};}
  return r;
 };
 await assert.rejects(claimSummary(f.adapter,'f'),{code:'ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN'});
 const job=f.claim();
 f.adapter.summaryAtomic=async p=>{const r=await f.run(p);const i=p.labels.indexOf('renew');r.batch.step_results[i].rows[0][0]={type:'text',value:'secret'};return r;};
 await assert.rejects(renewSummaryLease(f.adapter,job),{code:'ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN'});
}));
test('integrated HTTP publication request counts stay bounded, no statement round trips',async()=>{
 const {httpFixture}=await import('./summary-fixed-model.mjs');
 for(const [count,expected] of [[0,2],[100,2],[101,6]]){
  const f=await httpFixture();try{
   assert.equal((await publishSummary(f.adapter,f.job,{},evidence(count))).published,true);
   assert.equal(f.requests.length,expected);
   assert.ok(f.requests.every(r=>r.bytes<36*1024*1024));
   f.requests.length=0;await demandSummary(f.adapter,'p','q',new URLSearchParams(),'f');assert.equal(f.requests.length,1);
   f.requests.length=0;assert.equal(await claimSummary(f.adapter,'f'),null);assert.equal(f.requests.length,1);
  }finally{f.close();}
 }
});
