import test from 'node:test';
import assert from 'node:assert/strict';
import {publicRoutesFromEnv,publicProviders,routesFromEnv,providersForScan,KIMI_GUEST_ROUTE} from '../src/providers/routing.mjs';
import {guestPlan,budgetedPublicProviders} from '../src/public-check/guest-budget.mjs';
import {openrouterSearch} from '../src/providers/openrouter.mjs';
import {callRoute} from '../src/providers/dispatch.mjs';
import {fixtureGuestBudget} from './guest-budget-fixture.mjs';
const env={ENABLED_PROVIDERS:'openai,claude,gemini',PUBLIC_CHECK_PROVIDER_PAIR:'openai,kimi',OPENAI_API_KEY:'test',OPENROUTER_API_KEY:'test'};
const prices={...JSON.parse(fixtureGuestBudget(env)).routes,kimi:{transport:'openrouter',model:KIMI_GUEST_ROUTE.model,searchEngine:'exa',contextWindowTokens:1048576,maxInputBytes:10000,inputUsdPerMillion:2,outputUsdPerMillion:10,searchUsdPerCall:0.007}};
env.PUBLIC_CHECK_BUDGET_CONFIG_JSON=JSON.stringify({perScanUsd:100,dailyUsd:200,routes:prices});
const plan=(e=env)=>guestPlan({provider:'kimi',route:KIMI_GUEST_ROUTE,prompt:'Which firms?',context:{},env:e});
const citation={type:'url_citation',url_citation:{url:'https://example.fi/',title:'Source'}};
const response=()=>({usage:{prompt_tokens:2000,completion_tokens:500,cost:0.02,server_tool_use_details:{web_search_requests:1}},model:KIMI_GUEST_ROUTE.model,provider:'Moonshot AI',choices:[{finish_reason:'stop',message:{content:'A cited answer.',annotations:[citation]}}]});
const run=async(payload=response(),extra={})=>{
 const bodies=[];const result=await openrouterSearch('Which firms?',{model:KIMI_GUEST_ROUTE.model,searchEngine:'exa',guestKimi:true,budget:plan(),maxTokens:3000,apiKey:'test',fetchImpl:async(_u,init)=>{bodies.push(JSON.parse(init.body));return new Response(JSON.stringify(payload),{status:200});},...extra});return {result,bodies};
};
test('Kimi pair is public-only; paid provider routes and old snapshots stay unchanged',()=>{
 assert.deepEqual(publicProviders({enabledProviders:['claude']},env),['openai','kimi']);
 assert.deepEqual(Object.keys(publicRoutesFromEnv(env)),['openai','kimi']);
 assert.deepEqual(Object.keys(routesFromEnv(env)),['openai','claude','gemini']);
 assert.deepEqual(Object.keys(publicRoutesFromEnv({ENABLED_PROVIDERS:'openai,kimi',OPENROUTER_MODELS_JSON:JSON.stringify({kimi:'moonshotai/kimi-k3'})})),['openai'],'an existing paid Kimi mapping must not become a guest route');
 assert.deepEqual(providersForScan({requested:['openai','gemini'],enabled:['openai','kimi'],platform:false}),['openai','gemini']);
 assert.deepEqual(providersForScan({requested:['openai','kimi','claude'],enabled:[],platform:false}),['openai','kimi']);
 assert.throws(()=>publicRoutesFromEnv({...env,PUBLIC_CHECK_PROVIDER_PAIR:'kimi,claude'}),/PUBLIC_CHECK_PROVIDER_PAIR/);
 assert.deepEqual(budgetedPublicProviders({enabledProviders:['openai','claude']},env),['openai','kimi']);
});
test('Kimi reserves three full-context passes, two searches and exactly one HTTP attempt',()=>{
 const p=plan();assert.equal(p.reservedNano,6_395_456_000);assert.equal(p.modelPasses,3);assert.equal(p.httpAttempts,1);assert.equal(p.maxTokens,3000);assert.equal(p.maxSearches,2);
 for(const changes of [{contextWindowTokens:200000},{inputUsdPerMillion:1},{outputUsdPerMillion:9},{searchUsdPerCall:0.006}]){
  const bad={...env,PUBLIC_CHECK_BUDGET_CONFIG_JSON:JSON.stringify({perScanUsd:100,dailyUsd:200,routes:{...prices,kimi:{...prices.kimi,...changes}}})};
  assert.throws(()=>plan(bad),/API_BUDGET_INVALID_CONFIG/);
 }
 const small={...env,PUBLIC_CHECK_BUDGET_CONFIG_JSON:JSON.stringify({perScanUsd:1,dailyUsd:10,routes:prices})};
 assert.throws(()=>plan(small),/API_BUDGET_EXHAUSTED/);
 assert.deepEqual(budgetedPublicProviders({enabledProviders:[]},small),[]);
 const partial={...env,PUBLIC_CHECK_BUDGET_CONFIG_JSON:JSON.stringify({perScanUsd:10,dailyUsd:100,routes:prices})};
 assert.deepEqual(budgetedPublicProviders({enabledProviders:[]},partial),[],'one Kimi call fits but complete pair does not');
 const missing={...env,PUBLIC_CHECK_BUDGET_CONFIG_JSON:JSON.stringify({perScanUsd:100,dailyUsd:200,routes:{openai:prices.openai}})};
 assert.deepEqual(budgetedPublicProviders({enabledProviders:[]},missing),[]);
});
test('Kimi forces bounded cited search and pins the non-highspeed MoonshotAI endpoint',async()=>{
 const {result,bodies:[b]}=await run();assert.equal(result.status,'success');assert.equal(result.citations.length,1);
 assert.deepEqual(b.provider,{allow_fallbacks:false,require_parameters:true,only:['moonshotai/mxfp4'],max_price:{prompt:2,completion:10}});
 assert.deepEqual(b.tools,[{type:'openrouter:web_search',parameters:{engine:'exa',mode:'auto',max_uses:2,max_results:3,max_total_results:6,max_characters:1000}}]);
 assert.equal(b.max_tokens,3000);assert.equal(b.tool_choice,'required');assert.deepEqual(b.reasoning,{effort:'low'});assert.deepEqual(b.stop_server_tools_when,[{type:'step_count_is',step_count:1}]);assert.equal(result.meta.collection_method,KIMI_GUEST_ROUTE.collection_method);
});
test('wrong model/provider, truncation, unfinished tools and refusal cannot count as success',async()=>{
 for(const mutate of [p=>p.model='moonshotai/kimi-k3',p=>p.provider='Other',p=>delete p.provider,p=>p.choices[0].finish_reason='length',p=>p.choices[0].message.tool_calls=[{}],p=>p.choices[0].message.refusal='No',p=>p.choices[0].message.content='']){
  const p=response();mutate(p);assert.equal((await run(p)).result.status,'failed');
 }
 const p=response();p.choices[0].message.annotations=[];assert.equal((await run(p)).result.status,'no_grounding');
});
test('Kimi cannot run without a matching guest reservation or through paid dispatch',async()=>{
 await assert.rejects(()=>run(response(),{budget:undefined}),/API_BUDGET_LIMIT_MISMATCH/);
 await assert.rejects(()=>callRoute('kimi','test',KIMI_GUEST_ROUTE,500,{}),/PUBLIC_CHECK_ONLY_ROUTE/);
 await assert.rejects(()=>run(response(),{maxTokens:2048}),/API_BUDGET_LIMIT_MISMATCH/);
 for(const change of [{scope:'paid'},{model:'other'},{provider:'gemini'},{mode:'legacy_call_cap_only'},{httpAttempts:3},{maxTokens:4000},{maxSearches:3},{modelPasses:1},{searchEngine:'native'}])
  await assert.rejects(()=>run(response(),{budget:{...plan(),...change}}),/API_BUDGET_LIMIT_MISMATCH/);
});
test('HTTP errors are redacted, 429 retries are bounded, and timeouts are never replayed',async()=>{
 let n=0;
 const {result}=await run(response(),{retryOptions:{sleep:async()=>{},random:()=>0},fetchImpl:async()=>{n++;return new Response(JSON.stringify({error:{code:429,message:'secret body'}}),{status:429});}});
 assert.equal(n,1);assert.equal(result.status,'failed');assert.ok(!result.error.includes('secret'));
 n=0;await assert.rejects(()=>run(response(),{fetchImpl:async()=>{n++;throw new DOMException('timeout','TimeoutError');}}),{name:'TimeoutError'});assert.equal(n,1);
 await assert.rejects(()=>run(response(),{fetchImpl:async()=>new Response('bad gateway',{status:502})}),/non-JSON HTTP 502/);
});

test('Kimi fails closed when aggregate usage is missing, malformed or exceeds its reservation',async()=>{
 for(const mutate of [p=>delete p.usage,p=>p.usage.prompt_tokens='2000',p=>p.usage.prompt_tokens=-1,p=>p.usage.prompt_tokens=3*1048576+1,p=>p.usage.completion_tokens=9001,p=>delete p.usage.cost,p=>p.usage.server_tool_use_details.web_search_requests='2',p=>p.usage.server_tool_use_details.web_search_requests=-1,p=>p.usage.cost=6.395457,p=>p.usage.cost='0.02']){
  const p=response();mutate(p);const {result}=await run(p);assert.equal(result.status,'failed');assert.equal(result.meta.failure_code,'USAGE_RESERVATION_MISMATCH');
 }
 const p=response();delete p.usage.server_tool_use_details;assert.equal((await run(p)).result.status,'success');
});

// Archived research response metadata only; no prompt or web content.
// Source: airank-finland-v3-review/raw/fc727767052f2c9fae94e06d89fb7677af5ea6b936cbe8633442c05e670838b0.json
// SHA256: 578d195be0557dc74f81d147d7217f845801ad802d2f3eda70f7f3cc0ee62707
test('archived Kimi usage can report six tool calls while its all-in cost remains within the reservation',async()=>{
 const p=response();Object.assign(p,{"model": "moonshotai/kimi-k3.1-pro", "provider": "Moonshot AI", "usage": {"completion_tokens": 1545, "completion_tokens_details": {"audio_tokens": 0, "image_tokens": 0, "reasoning_tokens": 559}, "cost": 0.035582, "cost_details": {"upstream_inference_completions_cost": 0.01545, "upstream_inference_cost": 0.021582, "upstream_inference_prompt_cost": 0.006132}, "prompt_tokens": 5370, "prompt_tokens_details": {"audio_tokens": 0, "cache_write_tokens": 0, "cached_tokens": 2560, "video_tokens": 0}, "server_tool_use_details": {"tool_calls_executed": 6, "tool_calls_requested": 6, "web_search_requests": 6}, "total_tokens": 6915}});
 assert.equal(p.usage.server_tool_use_details.web_search_requests,6);
 assert.equal((await run(p)).result.status,'success');
});
