import test from 'node:test';
import assert from 'node:assert/strict';
import {publicProviders,providersForScan,PUBLIC_CHECK_PROVIDERS,GUEST_OPENROUTER_OUTPUT_TOKENS,GUEST_MAX_CALLS_PER_SCAN,routesFromEnv} from '../src/providers/routing.mjs';
import {callRoute} from '../src/providers/dispatch.mjs';

const all=['openai','claude','gemini','grok','perplexity','google_aio','deepseek'];
test('free check allowlist is exactly OpenAI + Gemini on both the capability and worker paths',()=>{
 assert.deepEqual([...PUBLIC_CHECK_PROVIDERS],['openai','gemini']);
 assert.deepEqual(publicProviders({enabledProviders:all}),['openai','gemini']);
 assert.deepEqual(providersForScan({requested:all,enabled:all,platform:false}),['openai','gemini']);
 // Claude is no longer measured by guests, but stays available to paid tracking.
 assert.ok(!publicProviders({enabledProviders:all}).includes('claude'));
 assert.deepEqual(providersForScan({requested:all,enabled:all,platform:true}),all);
});
test('a guest snapshot that still names Claude cannot execute it',()=>{
 assert.deepEqual(providersForScan({requested:['openai','claude'],enabled:all,platform:false}),['openai']);
});
test('Gemini missing from ENABLED_PROVIDERS leaves guests with OpenAI only (capabilities and worker agree)',()=>{
 const enabled=['openai','claude'];
 assert.deepEqual(publicProviders({enabledProviders:enabled}),['openai']);
 assert.deepEqual(providersForScan({requested:publicProviders({enabledProviders:enabled}),enabled,platform:false}),['openai']);
});
test('guest call ceiling is 3 questions x 2 providers',()=>{assert.equal(GUEST_MAX_CALLS_PER_SCAN,6);});

async function captureOpenRouter(run){
 const original=globalThis.fetch,bodies=[];
 globalThis.fetch=async(url,init)=>{bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({id:'r',model:'google/gemini-fixture',choices:[{finish_reason:'stop',message:{content:'Answer [1]',annotations:[{type:'url_citation',url_citation:{url:'https://example.fi/a',title:'A'}}]}}]}),{status:200,headers:{'content-type':'application/json'}});};
 try{return {result:await run(),bodies};}finally{globalThis.fetch=original;}
}
const route=routesFromEnv({ENABLED_PROVIDERS:'gemini',OPENROUTER_GEMINI_MODEL:'google/gemini-fixture'}).gemini;
test('guest Gemini calls are capped and keep web search + citations',async()=>{
 process.env.OPENROUTER_API_KEY='fixture-key';
 const {result,bodies}=await captureOpenRouter(()=>callRoute('gemini','Which providers?',route,5000,{market:'FI',language:'fi'},{guest:true}));
 assert.equal(bodies.length,1);
 assert.equal(bodies[0].max_tokens,GUEST_OPENROUTER_OUTPUT_TOKENS);
 assert.ok(JSON.stringify(bodies[0]).includes('web'),'web search plugin must stay on');
 assert.equal(result.status,'success');
 assert.deepEqual(result.citations.map(c=>c.url),['https://example.fi/a']);
});
test('non-guest (paid tracking) Gemini calls keep their existing default output limit',async()=>{
 process.env.OPENROUTER_API_KEY='fixture-key';
 const {bodies}=await captureOpenRouter(()=>callRoute('gemini','Which providers?',route,5000,{market:'FI',language:'fi'}));
 assert.equal(bodies[0].max_tokens,8192);
});
