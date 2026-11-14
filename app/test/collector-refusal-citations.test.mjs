import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCollection} from '../src/collectors/normalization.mjs';
import {extract,aggregate} from '../src/analytics/extraction.mjs';
import {collectorFixture} from './collector-fixture.mjs';
import {createMonitoringEngine} from '../src/monitoring/engine.mjs';
const refusal='Turvallisuusasetukseni estävät vastaamisen kehotteeseen. Jos haluat, voimme aloittaa alusta uudella.';
const prompt='Which tools suit a small business?';
const raw=markdown=>({tasks:[{result:[{keyword:prompt,language_code:'fi',location_code:2246,markdown,sources:[{url:'https://unrelated.example/'}]}]}]});
const args=markdown=>({provider:'gemini',route:{transport:'dataforseo_scraper'},raw:raw(markdown),context:{market:'FI',language:'fi'},prompt,remoteId:'fixture',submissionMeta:{location_code:2246}});
const snapshot={kind:'neutral',identity:{brandName:'Example',aliases:[],ownedDomains:['example.com']}};
test('whole-answer Gemini refusal is non-answer regardless of unrelated sources and excluded from metrics',()=>{
 const r=normalizeCollection(args(refusal));
 assert.equal(r.status,'provider_failed');assert.equal(r.meta.failure_code,'PROVIDER_REFUSAL');assert.deepEqual(r.citations,[]);
 assert.equal(aggregate([extract(r,snapshot)],1).visibility,null);
});
test('substantive safety discussion and quoted refusal remain answers',()=>{
 for(const answer of ['Example provides safety controls for teams.',`The error says "${refusal}". Example offers a useful alternative.`,`${refusal}\nExample is suitable for small teams.`])assert.equal(normalizeCollection(args(answer)).status,'success');
});
test('same-passage domain-labelled attribution counts once, generic sources remain separate',()=>{
 const a=args('Example is useful.');
 a.raw.tasks[0].result[0].items=[{type:'gemini_text',original_text:'Example suits teams. More information.',markdown:'Example suits teams.[example.com](https://example.com/) More information.[example.com](https://example.com/)',sources:[{url:'https://example.com/'},{url:'https://unused.example/'}]}];
 const r=normalizeCollection(a);
 assert.deepEqual(r.citations.map(c=>c.url),['https://example.com/']);
 assert.equal(r.collection.sourceReferences.filter(s=>s.provenance==='items[0].markdown').length,2);
 assert.equal(r.collection.sourceReferences.find(s=>s.url==='https://unrelated.example/').kind,'source_reference');
 assert.equal(aggregate([extract(r,snapshot)],1).citationRate,100);
});
test('unmatched, ordinary-label, wrong-type and root-only links are not provider citations',()=>{
 for(const [type,label,sources] of [['gemini_text','example.com',[]],['gemini_text','Read more',[{url:'https://example.com/'}]],['other','example.com',[{url:'https://example.com/'}]]]){
  const a=args('See [example.com](https://example.com/) for details.');
  a.raw.tasks[0].result[0].items=[{type,original_text:'Example suits teams.',markdown:`Example suits teams.[${label}](https://example.com/)`,sources}];
  assert.deepEqual(normalizeCollection(a).citations,[]);
 }
});
test('no promotion of bare URLs, images, standalone source links or code',()=>{
 const r=normalizeCollection(args('Example is useful.\n[Example](https://example.com/)\n![Example](https://example.com/image)\n`Read [Example](https://example.com/code)`\nhttps://example.com/plain'));
 assert.deepEqual(r.citations,[]);
});
test('reference citations remain supported and deduplicate against inline attribution',()=>{
 const r=normalizeCollection(args('Use [Example][1] and read [Example](https://example.com/).\n\n[1]: https://example.com/'));
 assert.equal(r.citations.length,1);assert.equal(r.collection.sourceReferences.filter(s=>s.kind==='citation').length,1);
});
test('Gemini refusal finalizes existing paid task without any resubmission',async()=>{
 const f=await collectorFixture({ENABLED_PROVIDERS:'gemini',CONSUMER_COLLECTION_PROVIDERS:'gemini',CONSUMER_UNIT_COSTS_JSON:'{"gemini":0.01}',DATAFORSEO_LOGIN:'fixture',DATAFORSEO_PASSWORD:'fixture'});
 try{
  let posts=0,gets=0;
  const c={submit:async()=>{posts++;return {remoteId:'fixture',meta:{location_code:2840}};},poll:async()=>{gets++;return {status:'ready',raw:{tasks:[{result:[{keyword:'Which marketing tools suit a small business?',language_code:'en',location_code:2840,markdown:refusal,sources:[{url:'https://unrelated.example/'}]}]}]}};}};
  await f.run();const e=createMonitoringEngine({db:f.db,env:f.env,now:f.now,collectorClient:c,logger:()=>{}});
  await e.tick();f.advance(5001);await e.tick();await e.tick();
  assert.equal(posts,1);assert.equal(gets,1);
  const evidence=JSON.parse(f.sqlite.prepare('SELECT payload FROM mon_evidence').get().payload);
  assert.equal(evidence.status,'provider_failed');assert.equal(evidence.meta.failure_code,'PROVIDER_REFUSAL');
 }finally{f.close();}
});

test('Gemini attribution requires original-text distinction and rejects source-only passages',()=>{
 for(const [original_text,markdown] of [[undefined,'Example suits teams.[example.com](https://example.com/)'],['See https://example.com/','See [example.com](https://example.com/)'],['Sources:','Sources: [example.com](https://example.com/)'],['Example suits teams.','- Sources: [example.com](https://example.com/)'],['Example suits teams.','- [example.com](https://example.com/)']]){
  const a=args('Example suits teams.');a.raw.tasks[0].result[0].items=[{type:'gemini_text',original_text,markdown,sources:[{url:'https://example.com/'}]}];
  assert.deepEqual(normalizeCollection(a).citations,[]);
 }
});
