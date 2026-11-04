import test from 'node:test';
import assert from 'node:assert/strict';
import {createSummaryWorkerControl,publicationBlockCode} from '../src/analytics/summary-worker-control.mjs';

const unknown=()=>Object.assign(Error('secret endpoint token evidence'),{outcome:'unknown',code:'ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN'});
const quarantined=()=>Object.assign(Error('secret SQL'),{code:'ANALYTICS_PUBLICATION_QUARANTINED'});
function fixture(overrides={}){
 const calls=[],logs=[];
 const deps={db:{},env:{AIRANK_ANALYTICS_PREWARM:'true'},now:()=>Date.parse('2026-11-04'),
  assertPublicationSafe:async()=>{calls.push('guard');},
  prewarmSummaries:async()=>{calls.push('prewarm');return {next:null};},
  projectSummaryOnce:async()=>{calls.push('project');return {state:'idle'};},
  cleanupSummaries:async()=>{calls.push('cleanup');},log:event=>logs.push(event),...overrides};
 return {control:createSummaryWorkerControl(deps),calls,logs,deps};
}

test('unknown outcome latches health and performs no further work across ticks or elapsed lease',async()=>{
 let stamp=0;
 const f=fixture({now:()=>stamp,projectSummaryOnce:async()=>{throw unknown();}});
 assert.deepEqual(await f.control.tick(),{state:'blocked',code:'ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN'});
 const calls=[...f.calls];stamp+=10*86400000;
 for(let i=0;i<100;i++)await f.control.tick();
 assert.deepEqual(f.calls,calls);
 assert.deepEqual(f.control.status(),{running:false,blocked:true,code:'ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN',ready:false});
 assert.deepEqual(f.logs,[{event:'analytics_publication_blocked',code:'ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN',recovery:'operator_review_required'}]);
 assert.doesNotMatch(JSON.stringify(f.logs),/secret|token|endpoint|evidence/);
});

test('startup and restarted instances stop before prewarm/claim when durable guard blocks',async()=>{
 for(let restart=0;restart<2;restart++){
  const f=fixture({assertPublicationSafe:async()=>{throw quarantined();}});
  assert.equal((await f.control.tick()).state,'blocked');
  assert.deepEqual(f.calls,[]);
  assert.equal(f.control.status().ready,false);
 }
});

test('unknown prewarm mutation stops before projection',async()=>{
 const f=fixture({prewarmSummaries:async()=>{throw unknown();}});
 assert.equal((await f.control.tick()).state,'blocked');
 assert.deepEqual(f.calls,['guard']);
});

test('unknown result at cleanup boundary prevents cleanup and later ticks',async()=>{
 let count=0;
 const f=fixture({projectSummaryOnce:async()=>++count===60?{state:'blocked',code:'ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN'}:{state:'idle'}});
 for(let i=0;i<61;i++)await f.control.tick();
 assert.equal(count,60);
 assert.ok(!f.calls.includes('cleanup'));
 assert.equal(f.control.status().ready,false);
});

test('guard immediately before cleanup protects newly observed intent',async()=>{
 let guards=0;
 const f=fixture({assertPublicationSafe:async()=>{if(++guards===61)throw quarantined();}});
 for(let i=0;i<60;i++)await f.control.tick();
 assert.ok(!f.calls.includes('cleanup'));
 assert.equal(f.control.status().blocked,true);
});

test('healthy ticks retain bounded cleanup and once daily prewarm',async()=>{
 const f=fixture();
 for(let i=0;i<60;i++)await f.control.tick();
 assert.equal(f.calls.filter(x=>x==='prewarm').length,1);
 assert.equal(f.calls.filter(x=>x==='cleanup').length,1);
 assert.equal(f.calls.filter(x=>x==='project').length,60);
 assert.equal(f.control.status().ready,true);
});

test('ordinary availability failure emits no raw error and can retry read guard',async()=>{
 let tries=0;
 const f=fixture({assertPublicationSafe:async()=>{if(++tries===1)throw Error('secret token');}});
 assert.equal((await f.control.tick()).state,'unavailable');
 assert.equal((await f.control.tick()).state,'idle');
 assert.deepEqual(f.logs,[{event:'analytics_projector_unavailable'}]);
});

test('classifies only bounded public outcome codes',()=>{
 assert.equal(publicationBlockCode({outcome:'unknown',code:'secret'}),'ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN');
 assert.equal(publicationBlockCode({code:'secret'}),null);
});


test('a peer intent pauses work without permanently latching a healthy worker',async()=>{
 let active=true;
 const f=fixture({assertPublicationSafe:async()=>{if(active)throw quarantined();}});
 assert.equal((await f.control.tick()).state,'blocked');
 assert.equal(f.control.status().ready,false);
 assert.deepEqual(f.calls,[]);
 active=false;
 assert.equal((await f.control.tick()).state,'idle');
 assert.equal(f.control.status().blocked,false);
 assert.deepEqual(f.calls,['prewarm','project']);
});


test('readiness is false until first successful guarded projection tick',async()=>{
 const f=fixture();
 assert.equal(f.control.status().ready,false);
 await f.control.tick();
 assert.equal(f.control.status().ready,true);
});
