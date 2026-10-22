import test from 'node:test';
import assert from 'node:assert/strict';
import {claudeSearch} from '../src/providers/claude.mjs';

async function mock(replies,fn){
 const old=globalThis.fetch,requests=[];
 globalThis.fetch=async(_url,init)=>{
  requests.push(JSON.parse(init.body));
  const reply=replies.shift();
  if(reply instanceof Error)throw reply;
  assert.ok(reply,'Unexpected paid request');
  return {ok:true,status:200,text:async()=>JSON.stringify(reply)};
 };
 try{return await fn(requests);}finally{globalThis.fetch=old;}
}
const response=(reason,text='Retained answer')=>({stop_reason:reason,usage:{output_tokens:400},content:[{type:'text',text,citations:[{url:'https://example.com'}]}]});
// Fixture reservation; production receives this only from a committed engine claim.
const budget={mode:'monetary_reserved',maxTokens:4096,maxSearches:3,maxInputBytes:10000,maxReplayBytes:10000};
test('bounded Claude configuration rejects invalid allowances before sending',async()=>{
 await mock([],async requests=>{
  for(const maxTokens of [0,255,16385,NaN,Infinity,1.5,'bad',''])
   await assert.rejects(claudeSearch('Question',{maxTokens}),/must be an integer/);
  assert.equal(requests.length,0);
 });
});
test('larger allowances and mismatched frozen limits fail before any paid request',async()=>{
 await mock([],async requests=>{
  for(const maxTokens of [1401,4096,16384]){
   await assert.rejects(claudeSearch('Question',{maxTokens}),/API_BUDGET_RESERVATION_REQUIRED/);
   await assert.rejects(claudeSearch('Question',{maxTokens,budget:{mode:'legacy_call_cap_only',maxTokens}}),/API_BUDGET_RESERVATION_REQUIRED/);
  }
  await assert.rejects(claudeSearch('Question',{maxTokens:4096,budget:{...budget,maxTokens:2048}}),/API_BUDGET_LIMIT_MISMATCH/);
  assert.equal(requests.length,0);
 });
});
test('configured allowance is cumulative across both requests; continuation is bounded',async()=>{
 await mock([response('pause_turn'),response('pause_turn')],async requests=>{
  const result=await claudeSearch('Question',{maxTokens:4096,budget});
  assert.deepEqual(requests.map(r=>r.max_tokens),[4096,3696]);
  assert.equal(result.meta.max_tokens_requested,4096);
  assert.equal(result.meta.failure_code,'CONTINUATION_LIMIT');
  assert.equal(result.status,'incomplete');
  assert.equal(result.raw.responses.length,2);
 });
});
test('unknown, invalid or exhausted usage never authorizes a continuation',async()=>{
 for(const output_tokens of [undefined,null,-1,1.5,'400',1400,1500]){
  const reply=response('pause_turn');
  reply.usage={output_tokens};
  await mock([reply],async requests=>{
   const result=await claudeSearch('Question',{maxTokens:1400});
   assert.equal(requests.length,1);
   assert.equal(result.answer,'Retained answer');
   assert.equal(result.meta.failure_code,'CONTINUATION_LIMIT');
   assert.equal(result.status,'incomplete');
  });
 }
});
test('token exhaustion retains evidence without retry, including an empty answer',async()=>{
 for(const text of ['Partial answer',''])await mock([response('max_tokens',text)],async requests=>{
  const result=await claudeSearch('Question');
  assert.equal(requests.length,1);
  assert.equal(result.answer,text);
  assert.equal(result.meta.failure_code,'OUTPUT_TOKEN_LIMIT');
  assert.equal(result.status,'incomplete');
 });
});
test('failed continuation retains original answer and safe failure category',async()=>{
 await mock([response('pause_turn'),new DOMException('sensitive text','TimeoutError')],async requests=>{
  const result=await claudeSearch('Question');
  assert.equal(requests.length,2);
  assert.equal(result.answer,'Retained answer');
  assert.equal(result.meta.failure_code,'PROVIDER_TIMEOUT');
  assert.equal(result.status,'incomplete');
  assert.ok(!JSON.stringify(result).includes('sensitive text'));
 });
});
test('literal tool error words in prose do not constitute a tool failure',async()=>{
 await mock([response('end_turn','web_search_tool_result_error is a technical label')],async()=>{
  assert.equal((await claudeSearch('Question')).status,'success');
 });
});
test('Claude observation preserves repeated original annotations without invented answer offsets',async()=>{
 const first=response('pause_turn'),last=response('end_turn');
 first.content[0].citations[0].start_char_index=12;
 first.content[0].citations[0].end_char_index=34;
 await mock([first,last],async()=>{
  const result=await claudeSearch('Question');
  assert.equal(result.observation.complete,true);
  assert.equal(result.observation.citationOccurrences.length,2);
  assert.deepEqual(result.observation.citationOccurrences.map(c=>c.blockIndex),[0,1]);
  assert.ok(result.observation.citationOccurrences.every(c=>!Object.hasOwn(c,'start')&&!Object.hasOwn(c,'end')));
 });
 await mock([response('max_tokens')],async()=>{
  assert.equal((await claudeSearch('Question')).observation.complete,false);
 });
});
