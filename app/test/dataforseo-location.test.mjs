import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/dataforseo-gibraltar-location.json' with {type:'json'};
import {selectMarketLocation} from '../src/common/dataforseo-location.mjs';
import {selectSerpContext} from '../src/providers/dataforseo-context.mjs';
import {googleAioSearch} from '../src/providers/google-aio.mjs';
import {createCollectorClient} from '../src/collectors/client.mjs';

const gi=fixture.location;
const gb={location_code:2826,location_name:'United Kingdom',location_code_parent:null,country_iso_code:'GB',location_type:'Country'};
const fi={location_code:2246,location_name:'Finland',location_code_parent:null,country_iso_code:'FI',location_type:'Country'};
const catalog=locations=>({locations,languages:[{language_code:'en'},{language_code:'sv'}]});

test('official Gibraltar top-level Region resolves to its own exact market code',()=>{
 assert.equal(selectMarketLocation('GI',[gb,gi,fi]),gi);
 assert.deepEqual(selectSerpContext({market:'GI',language:'en'},catalog([gb,gi,fi])),{location_code:2292,location_name:'Gibraltar',language_code:'en',market:'GI'});
 assert.equal(selectSerpContext({market:'FI',language:'sv'},catalog([fi])).location_code,2246);
 assert.equal(selectSerpContext({market:'GI',language:'fi'},catalog([gi])),null);
});

test('market selection refuses absent, ambiguous, malformed and arbitrary subregion matches',()=>{
 const invalid=[
  [gb,fi],
  [gi,{...gi}],
  [gi,{...gi,location_type:'Country'}],
  [{...gi,location_code_parent:2826}],
  [{...gi,location_code_parent:undefined}],
  [{...gi,location_code:1000001}],
  [{...gi,location_code:'2292'}],
  [{...gi,location_name:'Gibraltar District'}],
  [{...gi,location_type:'City'}],
  [{...gi,country_iso_code:'GB'}],
  [{...gi,location_type:'Country',location_code_parent:2826}],
 ];
 for(const locations of invalid)assert.equal(selectMarketLocation('GI',locations),null,JSON.stringify(locations));
 assert.equal(selectMarketLocation('GB',[{...gb,location_type:'Region'}]),null);
 assert.equal(selectMarketLocation('FI',[fi,{...fi,location_code:1234}]),null);
 assert.equal(selectMarketLocation('GI',null),null);
});

test('AI Overview sends documented Gibraltar location rather than substituting another country',async()=>{
 const original=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{
  calls.push({url,body:JSON.parse(options.body)});
  return new Response(JSON.stringify({status_code:20000,tasks:[{status_code:20000,result:[{items:[]}]}]}));
 };
 try{
  const result=await googleAioSearch('Fixture question',{context:{market:'GI',language:'en'},catalog:catalog([gb,gi])});
  assert.equal(calls.length,1);
  assert.equal(calls[0].body[0].location_code,2292);
  assert.equal(calls[0].body[0].language_code,'en');
  assert.equal(result.status,'no_overview');
  assert.equal(result.meta.serp_context.market,'GI');
 }finally{globalThis.fetch=original;}
});

function collector(locations){
 const calls=[];
 const client=createCollectorClient({env:{CONSUMER_COLLECTION_ENABLED:'true',DATAFORSEO_LOGIN:'fixture',DATAFORSEO_PASSWORD:'fixture'},transport:async(url,options)=>{
  calls.push({url,body:options.body?JSON.parse(options.body):null});
  const task=url.endsWith('/task_post')?{status_code:20100,id:'fixture-id'}:{status_code:20000,result:url.endsWith('/languages')?[{language_code:'en'}]:locations};
  return new Response(JSON.stringify({status_code:20000,tasks:[task]}));
 }});
 return {client,calls};
}
const submit=(client,provider)=>client.submit({provider,route:{transport:'dataforseo_scraper'},prompt:'Fixture question',context:{market:'GI',language:'en'},taskId:'fixture-task'});

test('consumer collector only accepts Gibraltar when its own endpoint catalog contains the verified root',async()=>{
 const {client,calls}=collector([gb,gi]);
 const result=await submit(client,'gemini');
 assert.equal(result.remoteId,'fixture-id');
 assert.equal(calls.find(c=>c.body).body[0].location_code,2292);
 assert.equal(calls.find(c=>c.body).body[0].language_code,'en');
});

test('absent ChatGPT Gibraltar remains unsupported and never submits or substitutes UK',async()=>{
 const {client,calls}=collector([gb,fi]);
 const result=await submit(client,'openai');
 assert.equal(result.result.status,'unsupported_context');
 assert.equal(result.result.meta.failure_code,'UNSUPPORTED_MARKET_OR_LANGUAGE');
 assert.equal(calls.length,2);
 assert.ok(calls.every(c=>!c.body));
});

test('ambiguous consumer catalog remains unsupported with no task submission',async()=>{
 const {client,calls}=collector([gi,{...gi}]);
 assert.equal((await submit(client,'gemini')).result.status,'unsupported_context');
 assert.ok(calls.every(c=>!c.body));
});
