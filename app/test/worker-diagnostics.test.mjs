import test from 'node:test';
import assert from 'node:assert/strict';
import {observeProvider,providerFailure,safeProviderMeta} from '../src/providers/diagnostics.mjs';
import {requestJson} from '../src/providers/common.mjs';
import {providersForScan} from '../src/providers/routing.mjs';
import {workerConfiguration} from '../src/worker/config-check.mjs';

test('public queued snapshots cannot execute extra platforms, authenticated snapshots retain all providers',()=>{
 const providers=['openai','claude','gemini','grok','perplexity','google_aio'];
 assert.deepEqual(providersForScan({requested:providers,enabled:providers,platform:false}),['openai','claude']);
 assert.deepEqual(providersForScan({requested:providers,enabled:providers,platform:true}),providers);
});
test('configuration reveals missing variable names without leaking secrets or database addresses',()=>{
 const config=workerConfiguration({ENABLED_PROVIDERS:'openai,claude,gemini,grok,perplexity',OPENAI_API_KEY:'secret-123',BUNNY_DATABASE_URL:'https://private-db',BUNNY_DATABASE_AUTH_TOKEN:'private-token',MONITORING_ENABLED:'true'});
 assert.equal(config.database_configured,true);assert.equal(config.monitoring_enabled,true);
 assert.deepEqual(config.providers.find(x=>x.provider==='grok').missing_variables,['XAI_API_KEY']);
 assert.deepEqual(config.providers.find(x=>x.provider==='gemini').missing_variables,['OPENROUTER_API_KEY']);
 assert.ok(!/secret-123|private-db|private-token/.test(JSON.stringify(config)));
});
test('HTTP errors retain actionable classification, request ID and code without the private body',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>({ok:false,status:401,headers:new Headers({'x-request-id':'req-fixture'}),text:async()=>JSON.stringify({error:{type:'authentication_error',message:'Bearer sk-private-secret; prompt private'}})});
 try{
  const events=[];
  const result=await observeProvider({provider:'grok',route:{transport:'direct',model:'grok-fixture'},timeoutMs:100,logger:(event,data)=>events.push({event,...data}),call:()=>requestJson('https://fixture.test')});
  assert.equal(result.meta.http_status,401);assert.equal(result.meta.failure_code,'AUTHENTICATION_FAILED');assert.equal(result.meta.request_id,'req-fixture');
  assert.equal(events.length,2);assert.equal(events[1].event,'provider_finished');
  assert.ok(!/sk-private|prompt private/.test(JSON.stringify({result,events})));
 }finally{globalThis.fetch=original;}
});
test('unknown exceptions cannot leak prompts or secrets; timeouts remain uncertain',()=>{
 const result=providerFailure(Error('secret API key and private prompt'));
 assert.equal(result.error,'PROVIDER_REQUEST_FAILED');assert.ok(!JSON.stringify(result).includes('private prompt'));
 assert.equal(providerFailure(new DOMException('hidden','TimeoutError')).status,'timeout_unknown');
 const meta=safeProviderMeta({usage:{input_tokens:20,cost:{total_cost:0.01},private_text:'secret'},headers:{authorization:'secret'},response_id:'resp-test',failure_code:'Bearer sk-secret'});
 assert.deepEqual(meta,{response_id:'resp-test',usage:{input_tokens:20,cost:{total_cost:0.01}}});
});
