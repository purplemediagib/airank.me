import test from 'node:test';
import assert from 'node:assert/strict';
import {routesFromEnv,routeAvailable,compatibleRoute,publicProviders} from '../src/providers/routing.mjs';
import {grokSearch,perplexitySearch,normalizeGroundedResponse} from '../src/providers/grounded-responses.mjs';
import {googleAioSearch} from '../src/providers/google-aio.mjs';
import {selectSerpContext} from '../src/providers/dataforseo-context.mjs';
const names=['openai','claude','gemini','grok','perplexity','google_aio'];
const catalog={locations:[
 {country_iso_code:'FI',location_type:'Country',location_code:2246,location_name:'Finland'},
 {country_iso_code:'GI',location_type:'Country',location_code:2292,location_name:'Gibraltar'}
],languages:[{language_code:'fi'},{language_code:'sv'},{language_code:'en'}]};
const response={id:'response-fixture',model:'actual-fixture-model',status:'completed',output:[
 {type:'message',status:'completed',content:[{type:'output_text',text:'Example is available.',annotations:[
  {type:'url_citation',url:'https://example.test/',title:'Example'}
 ]}]}
]};
async function mock(fn,reply=response){
 const old=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,init)=>{calls.push({url,body:init.body?JSON.parse(init.body):null});return {ok:true,status:200,text:async()=>JSON.stringify(reply)};};
 try{return await fn(calls);}finally{globalThis.fetch=old;}
}
test('six sources have explicit transports, own credentials, immutable routes and no Copilot alias',()=>{
 const routes=routesFromEnv({ENABLED_PROVIDERS:names.join(',')});
 assert.equal(routes.gemini.transport,'openrouter');
 assert.equal(routes.grok.transport,'direct');assert.equal(routes.perplexity.transport,'direct');
 assert.equal(routes.google_aio.transport,'dataforseo');
 for(const p of names)assert.equal(routeAvailable(p,routes[p],{}),false);
 assert.equal(routeAvailable('grok',routes.grok,{XAI_API_KEY:'fixture'}),true);
 assert.equal(routeAvailable('perplexity',routes.perplexity,{PERPLEXITY_API_KEY:'fixture'}),true);
 assert.equal(routeAvailable('google_aio',routes.google_aio,{DATAFORSEO_LOGIN:'fixture',DATAFORSEO_PASSWORD:'fixture'}),true);
 assert.equal(compatibleRoute({...routes.google_aio,transport:'openrouter'},routes.google_aio),false);
 assert.throws(()=>routesFromEnv({ENABLED_PROVIDERS:'copilot'}),/deferred/);
 assert.throws(()=>routesFromEnv({OPENROUTER_MODELS_JSON:'{"grok":"x-ai/grok"}'}),/reserved/);
 assert.deepEqual(publicProviders({enabledProviders:names}),['openai','claude']);
});
test('Grok requires web search, bounded output and independent language/market without paid retries',async()=>{
 await mock(async calls=>{
  const r=await grokSearch('Who supplies this?',{context:{market:'FI',language:'sv'}});
  assert.equal(r.status,'success');assert.equal(r.model,'actual-fixture-model');
  assert.equal(calls.length,1);assert.match(calls[0].url,/api\.x\.ai\/v1\/responses/);
  assert.equal(calls[0].body.tool_choice,'required');
  assert.equal(calls[0].body.max_output_tokens,8192);
  assert.match(calls[0].body.input,/Swedish/);assert.match(calls[0].body.input,/Finland/);
 });
});
test('Perplexity uses current Agent API, records actual model and returned source evidence',async()=>{
 const reply=structuredClone(response);reply.output[0].content[0].annotations=[];
 reply.output.unshift({type:'search_results',results:[{url:'https://example.test/',title:'Example'}]});
 await mock(async calls=>{
  const r=await perplexitySearch('Who supplies this?',{context:{market:'GI',language:'en'}});
  assert.equal(r.status,'success');assert.equal(calls[0].body.preset,'fast');
  assert.equal(calls[0].url,'https://api.perplexity.ai/v1/agent');
  assert.equal(r.meta.citation_scope,'provider search results and inline citations');
 },reply);
});
test('unfinished, refused, empty or ungrounded responses never count as successful measurements',()=>{
 for(const overrides of [{status:'incomplete'},{error:{code:'error'}},{incomplete_details:{reason:'max_output_tokens'}}]){
  assert.equal(normalizeGroundedResponse({...response,...overrides},{}).status,'incomplete');
 }
 assert.equal(normalizeGroundedResponse({...response,output:[]},{}).status,'failed');
 const plain=structuredClone(response);plain.output[0].content[0].annotations=[];
 assert.equal(normalizeGroundedResponse(plain,{}).status,'no_grounding');
 plain.output[0].content.push({type:'refusal'});
 assert.equal(normalizeGroundedResponse(plain,{}).status,'incomplete');
});
test('DataForSEO targets Finland/Swedish independently and excludes unsupported locales before paid request',async()=>{
 assert.equal(selectSerpContext({market:'FI',language:'sv'},catalog).language_code,'sv');
 assert.equal(selectSerpContext({market:'BG',language:'en'},catalog),null);
 await mock(async calls=>{
  const r=await googleAioSearch('Who supplies this?',{context:{market:'BG',language:'en'},catalog});
  assert.equal(r.status,'unsupported_context');assert.equal(calls.length,0);
 });
 const reply={tasks:[{status_code:20000,result:[{items:[]}]}]};
 await mock(async calls=>{
  const r=await googleAioSearch('Who supplies this?',{context:{market:'FI',language:'sv'},catalog});
  assert.equal(r.status,'no_overview');assert.equal(calls[0].body[0].location_code,2246);
  assert.equal(calls[0].body[0].language_code,'sv');assert.equal(calls[0].body[0].depth,10);
 },reply);
});
test('DataForSEO invalid result is a failure, not absent overview; sources are required',async()=>{
 await mock(async()=>{
  const r=await googleAioSearch('Question',{catalog});
  assert.equal(r.status,'failed');
  assert.equal(r.meta.failure_code,'SERP_RESULT_MISSING');
 },{tasks:[{status_code:20000,result:[]}]});
 await mock(async()=>{
  const r=await googleAioSearch('Question',{catalog});
  assert.equal(r.status,'no_grounding');
 },{tasks:[{status_code:20000,result:[{items:[{type:'ai_overview',text:'An answer'}]}]}]});
});
test('new provider HTTP errors do not expose response bodies or automatically retry',async()=>{
 const old=globalThis.fetch;let count=0;
 globalThis.fetch=async()=>{count++;return {ok:false,status:401,text:async()=>JSON.stringify({error:{message:'private credential details'}})};};
 try{await assert.rejects(grokSearch('Question'),e=>e.message==='Provider HTTP 401');assert.equal(count,1);}finally{globalThis.fetch=old;}
});
