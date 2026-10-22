import test from 'node:test';
import assert from 'node:assert/strict';
import {openrouterSearch} from '../src/providers/openrouter.mjs';

const model='google/gemini-3.8-flash';
const citation={type:'url_citation',url_citation:{url:'https://example.com/',title:'Source'}};
const response=(finishReason='stop',annotations=[citation])=>({
 model,choices:[{finish_reason:finishReason,message:{content:'A cited answer.',annotations}}],
 usage:{completion_tokens:2000,completion_tokens_details:{reasoning_tokens:1800}},
});
function mocked(payload,ok=true,status=200){
 const requests=[];
 return {requests,fetchImpl:async (_url,init)=>{
  requests.push(JSON.parse(init.body));
  return {ok,status,json:async()=>payload};
 }};
}
const options=mock=>({model,apiKey:'test-only-key',maxTokens:null,fetchImpl:mock.fetchImpl});

test('Gemini receives a bounded larger output allowance without changing search or streaming',async()=>{
 const mock=mocked(response());
 const result=await openrouterSearch('Test question',options(mock));
 assert.equal(mock.requests.length,1);
 assert.equal(mock.requests[0].max_tokens,8192);
 assert.equal(mock.requests[0].stream,false);
 assert.equal(mock.requests[0].tools[0].parameters.engine,'native');
 assert.equal(mock.requests[0].provider.allow_fallbacks,false);
 assert.equal(result.status,'success');
 assert.equal(result.meta.max_tokens_requested,8192);
});

test('other OpenRouter models retain the original default allowance',async()=>{
 const mock=mocked(response());
 await openrouterSearch('Test question',{...options(mock),model:'mistralai/mistral-small'});
 assert.equal(mock.requests[0].max_tokens,2000);
});

test('an explicit output allowance is validated before any paid request',async()=>{
 const mock=mocked(response());
 await openrouterSearch('Test question',{...options(mock),maxTokens:'4096'});
 assert.equal(mock.requests[0].max_tokens,4096);
 for(const invalid of [0,255,16385,4000.5,'invalid','']){
  const rejected=mocked(response());
  await assert.rejects(openrouterSearch('Test question',{...options(rejected),maxTokens:invalid}),/integer from 256 to 16384/);
  assert.equal(rejected.requests.length,0);
 }
});

test('length remains a failed measurement even with citations, with no automatic retry',async()=>{
 const mock=mocked(response('length'));
 const result=await openrouterSearch('Test question',options(mock));
 assert.equal(result.status,'failed');
 assert.match(result.error,/output token limit \(8192\)/);
 assert.equal(result.meta.failure_code,'OUTPUT_TOKEN_LIMIT');
 assert.equal(result.meta.finish_reason,'length');
 assert.equal(result.meta.usage.completion_tokens_details.reasoning_tokens,1800);
 assert.equal(mock.requests.length,1);
});

test('finished uncited answers remain excluded from grounded measurements',async()=>{
 const mock=mocked(response('stop',[]));
 const result=await openrouterSearch('Test question',options(mock));
 assert.equal(result.status,'no_grounding');
});

test('provider error bodies are not exposed in diagnostic messages',async()=>{
 const mock=mocked({error:{code:402,message:'private provider detail'}},false,402);
 const result=await openrouterSearch('Test question',options(mock));
 assert.equal(result.status,'failed');
 assert.equal(result.error,'OpenRouter request failed: HTTP 402 code 402');
 assert.ok(!result.error.includes('private provider detail'));
});
