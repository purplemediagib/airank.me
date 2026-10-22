import test from 'node:test';
import assert from 'node:assert/strict';
import { openaiSearch } from '../src/providers/openai.mjs';
import { claudeSearch, claudeOutputBudget } from '../src/providers/claude.mjs';
import { geminiSearch } from '../src/providers/gemini.mjs';
import { googleAioSearch } from '../src/providers/google-aio.mjs';
const catalog={locations:[{country_iso_code:'FI',location_type:'Country',location_code:2246,location_name:'Finland'}],languages:[{language_code:'fi'}]};

async function withMock(body, fn) {
 const previous = globalThis.fetch;
 globalThis.fetch = async (_url,_init) => ({ok:true,status:200,text:async()=>JSON.stringify(body)});
 try { return await fn(); } finally { globalThis.fetch = previous; }
}
test('OpenAI adapter preserves returned citation annotations', async () => {
 const data = {model:'test-model',id:'rsp1',status:'completed',output:[
  {type:'web_search_call',id:'call1'},
  {type:'message',content:[{type:'output_text',text:'Example Oy tarjoaa palvelua.',annotations:[{type:'url_citation',url:'https://example.fi/',title:'Example'}]}]}
 ]};
 const x=await withMock(data,()=>openaiSearch('Kysy'));
 assert.equal(x.status,'success');assert.equal(x.citations[0].url,'https://example.fi/');assert.equal(x.meta.tool_calls,1);
});
test('Claude adapter extracts citations from text blocks',async()=>{
 const data={model:'claude-test',stop_reason:'end_turn',content:[{type:'text',text:'Vastaus',citations:[{url:'https://example.fi/',title:'Example'}]}]};
 const x=await withMock(data,()=>claudeSearch('Kysy'));
 assert.equal(x.answer,'Vastaus');assert.equal(x.citations.length,1);
});
test('Gemini without grounding cannot be represented as grounded measurement',async()=>{
 const data={candidates:[{finishReason:'STOP',content:{parts:[{text:'Text'}]}}]};
 const x=await withMock(data,()=>geminiSearch('Kysy'));
 assert.equal(x.status,'no_grounding');
});
test('Gemini grounding provides cited sources',async()=>{
 const data={candidates:[{finishReason:'STOP',content:{parts:[{text:'Result'}]},groundingMetadata:{webSearchQueries:['q'],groundingChunks:[{web:{uri:'https://example.fi/',title:'Site'}}]}}]};
 const x=await withMock(data,()=>geminiSearch('Kysy'));
 assert.equal(x.status,'success');assert.equal(x.citations.length,1);
});
test('No Google AI Overview is not zero visibility',async()=>{
 const data={tasks:[{status_code:20000,result:[{items:[{type:'organic',title:'Website'}]}]}]};
 const x=await withMock(data,()=>googleAioSearch('Kysy',{catalog}));
 assert.equal(x.status,'no_overview');
});
test('Google AI Overview adapter records cited sources',async()=>{
 const data={tasks:[{status_code:20000,id:'id',result:[{items:[{type:'ai_overview',text:'Example Oy näkyy',references:[{url:'https://example.fi/',title:'Page'}]}]}]}]};
 const x=await withMock(data,()=>googleAioSearch('Kysy',{catalog}));
 assert.equal(x.status,'success');assert.equal(x.citations[0].url,'https://example.fi/');
});
test('Google AI Overview task errors retain safe codes without upstream messages',async()=>{
 const data={tasks:[{status_code:40501,status_message:'sensitive supplier message'}]};
 const x=await withMock(data,()=>googleAioSearch('Kysy',{catalog}));
 assert.equal(x.status,'failed');
 assert.equal(x.meta.failure_code,'SERP_TASK_FAILED');
 assert.equal(x.meta.upstream_error_code,'40501');
 assert.ok(!JSON.stringify(x).includes('sensitive supplier message'));
});
test('Google AI Overview sanitizes invalid upstream status codes',async()=>{
 for(const status_code of ['sensitive supplier message','Infinity',-1,40501.5]){
  const x=await withMock({tasks:[{status_code}]},()=>googleAioSearch('Kysy',{catalog}));
  assert.equal(x.status,'failed');
  assert.equal(x.meta.failure_code,'SERP_TASK_FAILED');
  assert.equal(x.meta.upstream_error_code,'0');
  assert.ok(!JSON.stringify(x).includes('sensitive supplier message'));
 }
 const x=await withMock({status_code:40501},()=>googleAioSearch('Kysy',{catalog}));
 assert.equal(x.meta.upstream_error_code,'40501');
});
test('Google AI Overview distinguishes missing results from missing overview text',async()=>{
 const missing=await withMock({tasks:[{status_code:20000}]},()=>googleAioSearch('Kysy',{catalog}));
 assert.equal(missing.meta.failure_code,'SERP_RESULT_MISSING');
 const empty=await withMock({tasks:[{status_code:20000,result:[{items:[{type:'ai_overview'}]}]}]},()=>googleAioSearch('Kysy',{catalog}));
 assert.equal(empty.meta.failure_code,'AI_OVERVIEW_TEXT_MISSING');
 assert.equal(empty.status,'failed');
});

test('OpenAI text without sources and incomplete output cannot count as a grounded success',async()=>{
 const payload={status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Purple+ https://purpleplus.ai'}]}]};
 assert.equal((await withMock(payload,()=>openaiSearch('Kysy'))).status,'no_grounding');
 payload.status='incomplete';payload.output[0].content[0].annotations=[{type:'url_citation',url:'https://example.fi'}];
 assert.equal((await withMock(payload,()=>openaiSearch('Kysy'))).status,'incomplete');
});
test('Claude ungrounded, truncated and failed search answers are excluded',async()=>{
 const payload={stop_reason:'end_turn',content:[{type:'text',text:'Purple+'}]};
 assert.equal((await withMock(payload,()=>claudeSearch('Kysy'))).status,'no_grounding');
 payload.content[0].citations=[{url:'https://example.fi'}];payload.stop_reason='max_tokens';
 assert.equal((await withMock(payload,()=>claudeSearch('Kysy'))).status,'incomplete');
 payload.stop_reason='end_turn';payload.content.push({type:'web_search_tool_result',content:{type:'web_search_tool_result_error',error_code:'max_uses_exceeded'}});
 assert.equal((await withMock(payload,()=>claudeSearch('Kysy'))).status,'incomplete');
});
test('Claude continuation preserves both raw responses and citations',async()=>{
 const old=globalThis.fetch;let i=0;
 const replies=[{stop_reason:'pause_turn',usage:{output_tokens:400},content:[{type:'text',text:'Lähde',citations:[{url:'https://example.fi'}]}]},{stop_reason:'end_turn',content:[{type:'text',text:'Purple+ on vaihtoehto'}]}];
 globalThis.fetch=async()=>({ok:true,status:200,text:async()=>JSON.stringify(replies[i++])});
 try{const r=await claudeSearch('Kysy');assert.equal(r.status,'success');assert.equal(r.citations.length,1);assert.equal(r.raw.responses.length,2);}finally{globalThis.fetch=old;}
});
test('Claude output allowance is bounded and configuration fails explicitly',()=>{
 assert.equal(claudeOutputBudget({}),1400);
 assert.equal(claudeOutputBudget({CLAUDE_MAX_TOKENS:'256'}),256);
 assert.equal(claudeOutputBudget({CLAUDE_MAX_TOKENS:'2048',CLAUDE_MAX_OUTPUT_TOKENS:'8192'}),2048);
 assert.equal(claudeOutputBudget({CLAUDE_MAX_OUTPUT_TOKENS:'4096'}),4096);
 for(const v of ['','0','255','-1','no','16385','1400.5']){
  assert.throws(()=>claudeOutputBudget({CLAUDE_MAX_TOKENS:v,CLAUDE_MAX_OUTPUT_TOKENS:'8192'}));
  assert.throws(()=>claudeOutputBudget({CLAUDE_MAX_OUTPUT_TOKENS:v}));
 }
});
test('Claude continuation shares the output allowance; truncation never retries',async()=>{
 const old=globalThis.fetch;const bodies=[];
 globalThis.fetch=async(_url,init)=>{
  bodies.push(JSON.parse(init.body));
  return {ok:true,status:200,text:async()=>JSON.stringify({stop_reason:bodies.length===1?'pause_turn':'max_tokens',usage:{output_tokens:1000},content:[{type:'text',text:'Retained evidence'}]})};
 };
 try{
  const result=await claudeSearch('Question');
  assert.equal(bodies.length,2);
  assert.equal(bodies[1].max_tokens,bodies[0].max_tokens-1000);
  assert.equal(result.status,'incomplete');
  assert.equal(result.meta.failure_code,'OUTPUT_TOKEN_LIMIT');
 }finally{globalThis.fetch=old;}
});
test('Claude does not continue when usage is unknown',async()=>{
 let calls=0;const old=globalThis.fetch;
 globalThis.fetch=async()=>{calls++;return {ok:true,status:200,text:async()=>JSON.stringify({stop_reason:'pause_turn',content:[{type:'text',text:'Partial'}]})};};
 try{assert.equal((await claudeSearch('Question')).status,'incomplete');assert.equal(calls,1);}finally{globalThis.fetch=old;}
});
