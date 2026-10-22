import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceAnalytics,answerUrls} from '../src/analytics/sources.mjs';
import {extract} from '../src/analytics/extraction.mjs';
const identity={brandName:'Example',ownedDomains:['example.fi']};
const snapshot={identity,kind:'neutral',language:'en',prompts:[],cohort:{brands:[identity,{brandName:'Rival',ownedDomains:['rival.fi']}]}};
const row=(id,refs=[],extra={})=>extract({id,provider:'openai',status:'success',answer:'Example',citations:[],collection:{sourceReferences:refs,citationObservation:'unavailable'},...extra},snapshot);
const entry=(rows,s=snapshot)=>({snapshot:s,rows});
test('four source kinds stay separate, answers deduplicate and occurrence maxima do not inflate',()=>{
 const citation={url:'https://example.fi/a',kind:'citation',provenance:'answer_reference',occurrences:2};
 const rows=[row('a',[citation,{...citation,provenance:'passage_1'},{url:'https://rival.fi/',kind:'source_reference',provenance:'sources'},{url:'https://search.test/',kind:'retrieval',provenance:'search_results'}],
  {answer:'Example https://example.fi/a',citations:[{url:citation.url}]}),row('b',[citation])];
 const original=JSON.stringify(rows),result=sourceAnalytics([entry(rows)]);
 const cite=result.items.find(r=>r.kind==='citation');
 assert.equal(cite.answers,2);assert.deepEqual(cite.evidenceIds,['a','b']);assert.equal(cite.reportedOccurrences,4);assert.equal(cite.occurrenceAnswers,2);
 assert.equal(result.items.find(r=>r.kind==='source_reference').category,'competitor');
 assert.equal(result.items.find(r=>r.kind==='retrieval').reportedOccurrences,null);
 assert.equal(result.items.find(r=>r.kind==='answer_link').reportedOccurrences,1);
 assert.equal(result.coverage.find(c=>c.kind==='citation').answers,2);
 assert.equal(JSON.stringify(rows),original);
});
test('failed and diagnostic answers contribute no source votes',()=>{
 const refs=[{url:'https://example.fi/',kind:'citation',provenance:'fixture'}];
 const failed=row('f',refs,{status:'provider_failed'});
 const diagnostic=extract({id:'d',status:'success',answer:'Example',citations:[{url:'https://example.fi/'}]}, {...snapshot,kind:'diagnostic'});
 const result=sourceAnalytics([entry([failed,diagnostic])]);
 assert.equal(result.eligibleAnswers,0);assert.deepEqual(result.items,[]);
});
test('unknown collection coverage is not converted to an observed zero',()=>{
 const unknown=row('unknown');
 const zero=row('zero',[],{collection:{sourceReferences:[],citationObservation:'not_observed',retrievalObservation:'not_observed'}});
 const result=sourceAnalytics([entry([unknown,zero])]);
 assert.equal(result.coverage.find(c=>c.kind==='citation').observableAnswers,1);
 assert.equal(result.coverage.find(c=>c.kind==='retrieval').observableAnswers,1);
 assert.equal(result.coverage.find(c=>c.kind==='source_reference').observableAnswers,null);
 assert.equal(result.coverage.find(c=>c.kind==='answer_link').observableAnswers,2);
});
test('frozen ownership, not current project edits, determines attribution',()=>{
 const refs=[{url:'https://example.fi/a',kind:'citation',provenance:'fixture'}];
 const earlier=entry([row('old',refs)]);
 const later=entry([row('new',refs)],{...snapshot,identity:{brandName:'Renamed',ownedDomains:['new.fi']},cohort:{brands:[]}});
 const result=sourceAnalytics([earlier,later]);
 assert.equal(result.items[0].category,'mixed');assert.equal(result.items[0].answers,2);
});
test('unsafe credentials/protocol URLs never enter source evidence or observable citations',()=>{
 const refs=['javascript:alert(1)','data:text/plain,no','https://user:password@bad.test/'].map(url=>({url,kind:'citation',provenance:'fixture'}));
 const result=sourceAnalytics([entry([row('unsafe',refs)])]);
 assert.deepEqual(result.items,[]);
 assert.equal(result.coverage.find(c=>c.kind==='citation').observableAnswers,0);
});
test('literal URL extraction preserves balanced punctuation and treats duplicate links as occurrences',()=>{
 const result=answerUrls('[Page](https://example.fi/a_(b)). Then `https://example.fi/a_(b)` and https://example.fi/a?q=[x]');
 assert.equal(result.length,2);assert.equal(result[0].url,'https://example.fi/a_(b)');assert.equal(result[0].occurrences,2);
 assert.equal(result[1].url,'https://example.fi/a?q=[x]');
});
test('legacy model API citations stay available and extraction is idempotent for stored URL strings',()=>{
 const first=extract({id:'legacy',status:'success',answer:'Example',provider:'openai',citations:[{url:'https://example.fi/a'}]},snapshot);
 const again=extract(first,snapshot);
 assert.equal(again.ownedCitation,true);assert.deepEqual(again.citations,first.citations);
 const result=sourceAnalytics([entry([again])]);
 assert.equal(result.items[0].kind,'citation');assert.equal(result.items[0].reportedOccurrences,null);
 assert.equal(result.coverage.find(c=>c.kind==='citation').observableAnswers,1);
});
