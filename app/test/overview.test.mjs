import test from 'node:test';
import assert from 'node:assert/strict';
import {overviewInsights} from '../src/analytics/overview.mjs';
import {extract} from '../src/analytics/extraction.mjs';
test('overview uses full eligible evidence, saved tags and frozen domain ownership',()=>{
 const snapshot={identity:{brandName:'Example',ownedDomains:['example.com']},kind:'neutral',language:'en',cohort:{brands:[{brandName:'Example',ownedDomains:['example.com']},{brandName:'Rival',ownedDomains:['rival.com']}]},prompts:[{id:'p',topic:'Cost',tags:['price','small business']},{id:'q',topic:'',tags:[]}]};
 const rows=Array.from({length:31},(_,i)=>extract({id:String(i),promptId:'p',status:i===30?'failed':'success',answer:'Example is available.',citations:[{url:'https://example.com/a'},{url:'https://example.com/b'},{url:'https://rival.com/a'},{url:'https://other.org'},{url:'javascript:alert(1)'}]},snapshot));
 const entry={snapshot,rows,tasks:rows.map(r=>({id:r.id,prompt_id:'p'})).concat([{id:'unstarted',prompt_id:'q'}])};
 const result=overviewInsights([entry]);
 assert.equal(result.domains.length,3);
 assert.equal(result.domains.find(d=>d.domain==='example.com').answers,30);
 assert.equal(result.domains.find(d=>d.domain==='rival.com').category,'competitor');
 assert.equal(result.matrix.find(c=>c.tag==='price').metrics.eligible,30);
 assert.equal(result.matrix.find(c=>c.tag==='price').metrics.expected,31);
 assert.equal(result.matrix.find(c=>c.topic==='').metrics.visibility,null);
 assert.equal(result.domainTypes.reduce((n,t)=>n+t.answers,0),90);
 assert.equal(result.comparison,null);
 assert.equal(overviewInsights([]).domains.length,0);
});
test('source frequency counts stored eligible answers, not citation occurrences or retrieval estimates',()=>{
 const snapshot={identity:{brandName:'Example',ownedDomains:['example.com']},kind:'neutral',language:'en',prompts:[]};
 const rows=[
  extract({id:'one',status:'success',answer:'Example',citations:[{url:'https://source.test/a'},{url:'https://source.test/b'}]},snapshot),
  extract({id:'two',status:'success',answer:'Example',citations:[{url:'https://source.test/c'}]},snapshot),
 ];
 const result=overviewInsights([{snapshot,rows,tasks:[]}]);
 assert.deepEqual(result.domains,[{domain:'source.test',category:'other',answers:2}]);
 assert.equal(Object.hasOwn(result,'totalChats'),false);
 assert.equal(Object.hasOwn(result,'retrievals'),false);
 assert.equal(Object.hasOwn(result,'winRate'),false);
});
