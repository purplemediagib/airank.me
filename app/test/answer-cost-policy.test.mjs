import test from 'node:test';
import assert from 'node:assert/strict';
import {answerCostInstruction,answerPromptPolicyVersion,answerPromptMeta} from '../src/providers/answer-policy.mjs';
import {promptContext} from '../src/providers/common.mjs';
import {openaiSearch} from '../src/providers/openai.mjs';
import {claudeSearch} from '../src/providers/claude.mjs';
import {geminiSearch} from '../src/providers/gemini.mjs';
import {grokSearch,perplexitySearch} from '../src/providers/grounded-responses.mjs';
import {openrouterSearch} from '../src/providers/openrouter.mjs';
import {apiBudgetPlan,enforceBudgetInput} from '../src/providers/budget-config.mjs';
import {fixtureBudgetConfig} from './api-budget-fixture.mjs';
import {safeProviderMeta} from '../src/providers/diagnostics.mjs';
import {observationContextKey,collectionMethodVersion} from '../src/common/observations.mjs';
import {createCollectorClient} from '../src/collectors/client.mjs';
import {googleAioSearch} from '../src/providers/google-aio.mjs';

const question='Mitkä matkapuhelinliittymät sopivat suomalaiselle perheelle?';
const citation={type:'url_citation',url:'https://example.fi/'};
const grounded={status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Valmis vastaus.',annotations:[citation]}]}]};
async function mock(response,fn){
 const previous=globalThis.fetch,requests=[];
 globalThis.fetch=async(url,init)=>{
  requests.push({url,body:init.body?JSON.parse(init.body):null});
  return new Response(JSON.stringify(response));
 };
 try{return await fn(requests);}finally{globalThis.fetch=previous;}
}

test('economy guidance covers the whole answer while preserving context, facts and the exact question',()=>{
 const prompt=promptContext(question,{market:'FI',language:'fi'});
 assert.match(prompt,/below \$0\.10 USD/);
 assert.match(prompt,/input, reasoning, output and any search or tool use/);
 assert.match(prompt,/concise but complete answer/);
 assert.match(prompt,/Do not omit essential information/);
 assert.match(prompt,/Answer exclusively in Finnish \(fi\)/);
 assert.ok(prompt.endsWith('Question: '+question));
 assert.equal(prompt.split(answerCostInstruction).length,2);
});

test('every generative API adapter sends the target and records the prompt policy without changing the question',async()=>{
 const cases=[
  [()=>openaiSearch(question),grounded,b=>b.input],
  [()=>grokSearch(question),grounded,b=>b.input],
  [()=>perplexitySearch(question),grounded,b=>b.input],
  [()=>claudeSearch(question),{stop_reason:'end_turn',content:[{type:'text',text:'Valmis vastaus.',citations:[{url:'https://example.fi/'}]}]},b=>b.messages[0].content],
  [()=>geminiSearch(question),{candidates:[{finishReason:'STOP',content:{parts:[{text:'Valmis vastaus.'}]}}]},b=>b.contents[0].parts[0].text],
 ];
 for(const [call,response,input] of cases)await mock(response,async requests=>{
  const result=await call();
  assert.equal(requests.length,1);
  assert.equal(input(requests[0].body),promptContext(question));
  assert.equal(result.meta.prompt_policy,answerPromptPolicyVersion);
  assert.equal(result.meta.answer_cost_target_usd,0.1);
 });
 for(const model of ['x-ai/grok-4.7','x-ai/grok-4.3','meta/muse-spark-1.3','deepseek/deepseek-v4-pro','mistralai/mistral-large-4-0','moonshotai/kimi-k3','google/gemini-3.8-flash']){
  await mock({model,choices:[{finish_reason:'stop',message:{content:'Valmis vastaus.',annotations:[]}}]},async requests=>{
   const result=await openrouterSearch(question,{model,apiKey:'offline-fixture'});
   assert.equal(requests.length,1);assert.equal(requests[0].body.model,model);
   assert.ok(requests[0].body.messages[0].content.includes(answerCostInstruction));
   assert.ok(requests[0].body.messages[0].content.includes('Question: '+question));
   assert.equal(result.meta.prompt_policy,answerPromptPolicyVersion);
  });
 }
});

test('prompt byte validation includes the additional cost guidance for both direct and OpenRouter routes',()=>{
 for(const [provider,route,env] of [
  ['openai',{transport:'direct',model:'gpt-4.1-mini'},{ENABLED_PROVIDERS:'openai'}],
  ['grok',{transport:'openrouter',model:'x-ai/grok-4.7',search_engine:'native'},{ENABLED_PROVIDERS:'grok',OPENROUTER_GROK_MODEL:'x-ai/grok-4.7'}],
 ]){
  const config=JSON.parse(fixtureBudgetConfig(env));
  config.routes[provider].maxInputBytes=Buffer.byteLength(promptContext(question))-1;
  env.API_BUDGET_CONFIG_JSON=JSON.stringify(config);
  assert.throws(()=>apiBudgetPlan({provider,route,prompt:question,context:{},env}),/API_INPUT_LIMIT/);
  assert.throws(()=>enforceBudgetInput({mode:'monetary_reserved',provider,transport:route.transport,model:route.model,searchEngine:route.search_engine,maxInputBytes:config.routes[provider].maxInputBytes},provider,route,question,{}),/API_INPUT_LIMIT/);
 }
});

test('policy metadata survives sanitization without changing existing analytics grouping',()=>{
 const meta=safeProviderMeta({...answerPromptMeta(),secret:'never persist'});
 assert.deepEqual(meta,answerPromptMeta());
 const snapshot={collectionMethod:collectionMethodVersion},old={provider:'grok'},fresh={...old,meta};
 assert.equal(observationContextKey(old,snapshot),observationContextKey(fresh,snapshot));
 const consumer={...old,collection:{surface:'consumer_web'}};
 assert.equal(observationContextKey(consumer,snapshot),observationContextKey({...consumer,meta},snapshot));
});

test('a cheap but truncated answer is still incomplete and is never retried or substituted',async()=>{
 const model='x-ai/grok-4.7';
 await mock({model,usage:{cost:0.01},choices:[{finish_reason:'length',message:{content:'Osittainen vastaus',annotations:[{type:'url_citation',url_citation:citation}]}}]},async requests=>{
  const result=await openrouterSearch(question,{model,apiKey:'offline-fixture'});
  assert.equal(requests.length,1);assert.equal(requests[0].body.model,model);
  assert.equal(result.status,'failed');assert.equal(result.meta.failure_code,'OUTPUT_TOKEN_LIMIT');
  assert.equal(result.observation.complete,false);
 });
});

test('consumer collectors and Google SERP queries keep the original question, not an LLM billing instruction',async()=>{
 const requests=[];
 const client=createCollectorClient({env:{CONSUMER_COLLECTION_ENABLED:'true'},transport:async(url,init)=>{
  requests.push(JSON.parse(init.body));return new Response(JSON.stringify({task_id:'fixture-task'}));
 }});
 await client.submit({provider:'perplexity',route:{transport:'scrapeless'},prompt:question,context:{},taskId:'fixture'});
 assert.equal(requests[0].input.prompt,question);
 await mock({tasks:[{status_code:20000,result:[{items:[]}]}]},async requests=>{
  await googleAioSearch(question,{catalog:{locations:[{country_iso_code:'FI',location_type:'Country',location_code:2246}],languages:[{language_code:'fi'}]}});
  assert.equal(decodeURIComponent(requests[0].body[0].keyword),question);
 });
});
