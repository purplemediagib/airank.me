import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './summary-fixed-model.mjs';
import {atomicPlan,assertion,statement} from '../src/analytics/summary-plans.mjs';
import {sendFixed,resultRows} from '../src/analytics/summary-transport.mjs';
const endpoint='https://fixed.invalid/v2/pipeline';
async function setup(){
 const f=fixture(),plan=atomicPlan([assertion('true','1=1')]);
 const result=await f.run(plan);f.close();
 const body={baton:null,base_url:'https://other.invalid/route',results:[{type:'ok',response:{type:'batch',result:result.raw}},{type:'ok',response:{type:'close'}}]};
 return {plan,body};
}
for(const [label,mutate] of [
 ['open baton',b=>b.baton='open'],['missing baton',b=>delete b.baton],['missing close',b=>b.results.pop()],['extra slot',b=>b.results.push(b.results[1])],
 ['close error',b=>b.results[1]={type:'error',error:{message:'secret'}}],['contradictory close',b=>b.results[1].error={}],
 ['contradictory batch',b=>b.results[0].error={}],['bad batch result length',b=>b.results[0].response.result.step_results.pop()],
 ['contradictory statement',b=>b.results[0].response.result.step_errors[1]={message:'secret'}],
 ['wrong assertion',b=>b.results[0].response.result.step_results[1].rows[0][0].value='0'],
 ['wrong assertion column',b=>b.results[0].response.result.step_results[1].cols[0].name='wrong'],
 ['commit with rows',b=>{b.results[0].response.result.step_results[2].cols=[{name:'x'}];b.results[0].response.result.step_results[2].rows=[[{type:'integer',value:'1'}]];}],
 ['rollback after commit',b=>b.results[0].response.result.step_results[3]=b.results[0].response.result.step_results[0]],
 ['array column descriptor',b=>b.results[0].response.result.step_results[1].cols[0]=[]],
 ['noninteger count',b=>b.results[0].response.result.step_results[0].affected_row_count=0.5],
])test(`strict atomic acknowledgement rejects ${label}`,async()=>{
 const {plan,body}=await setup();mutate(body);let calls=0;
 const result=await sendFixed(plan,{endpoint,fetch:async()=>{calls++;return new Response(JSON.stringify(body));}});
 assert.deepEqual(result,{outcome:'unknown',reason:'protocol'});assert.equal(calls,1);
 assert.equal(JSON.stringify(result).includes('secret'),false);
});
test('complete committed response accepts ignored routing metadata but makes exactly one request',async()=>{
 const {plan,body}=await setup();let calls=0;
 assert.equal((await sendFixed(plan,{endpoint,fetch:async(url,options)=>{calls++;assert.equal(url,endpoint);assert.equal(options.redirect,'error');return new Response(JSON.stringify(body));}})).outcome,'committed');
 assert.equal(calls,1);
});
for(const raw of ['{"baton":null,"baton":"other","results":[]}','{"baton":"other","b\\u0061ton":null,"results":[]}','{"baton":null,"results":[{"type":"error","type":"ok"}]}'])test('duplicate object keys including escaped keys fail closed',async()=>{
 const {plan}=await setup();assert.equal((await sendFixed(plan,{endpoint,fetch:async()=>new Response(raw)})).outcome,'unknown');
});
test('declared and streamed body caps, invalid UTF8, redirects and thrown fetch never retry',async()=>{
 const {plan}=await setup();
 for(const response of [()=>new Response('{}',{headers:{'content-length':String(16*1024*1024+1)}}),()=>new Response(new Uint8Array(16*1024*1024+1)),()=>new Response(Uint8Array.of(255)),()=>new Response('{}',{status:302}),()=>{throw Error('secret token');}]){
  let calls=0;const r=await sendFixed(plan,{endpoint,fetch:async()=>{calls++;return response();}});assert.equal(r.outcome,'unknown');assert.equal(calls,1);assert.equal(JSON.stringify(r).includes('secret'),false);
 }
});
test('row decoder rejects duplicate column names and unsafe integers',async()=>{
 const f=fixture();try{
  for(const sql of ['SELECT 1 AS duplicate,2 AS duplicate','SELECT 9223372036854775807 AS n']){
   const plan=atomicPlan([statement('read',sql,[],true)],{readOnly:true});
   if(sql.includes('922')){
    const r={outcome:'committed',batch:{step_results:[null,{cols:[{name:'n'}],rows:[[{type:'integer',value:'9223372036854775807'}]]}]}};
    assert.throws(()=>resultRows(plan,r,'read'),{code:'ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN'});
   }else{
    // SQLite's named object row API overwrites duplicate names; construct raw
    // protocol evidence directly to ensure decoder does not do the same.
    const r={outcome:'committed',batch:{step_results:[null,{cols:[{name:'duplicate'},{name:'duplicate'}],rows:[[{type:'integer',value:'1'},{type:'integer',value:'2'}]]}]}};
    assert.throws(()=>resultRows(plan,r,'read'),{code:'ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN'});
   }
  }
 }finally{f.close();}
});

test('oversize pure reads produce explicit capacity error; ambiguous write acknowledgement remains unknown',async()=>{
 const {createSummaryDatabase}=await import('../src/analytics/summary-transport.mjs');
 const db=createSummaryDatabase({url:'https://fixed.invalid',authToken:'synthetic',fetch:async()=>new Response('{}',{headers:{'content-length':String(16*1024*1024+1)}})});
 await assert.rejects(db.execute('SELECT 1'),{code:'ANALYTICS_PROJECTION_LIMIT',status:422});
 await assert.rejects(db.execute('UPDATE synthetic SET value=1'),{code:'ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN'});
});
