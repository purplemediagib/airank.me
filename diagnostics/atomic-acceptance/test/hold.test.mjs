import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {parseArguments,startHold} from '../hold.mjs';
import {CONFIRMATION} from '../policy.mjs';
const get=url=>new Promise((resolve,reject)=>{http.get(url,res=>{let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));}).on('error',reject);});
test('CLI only accepts exact flags, fixed confirmation and expiry',()=>{
 assert.deepEqual(parseArguments([]),{});assert.deepEqual(parseArguments(['--confirm=no']),{});
 assert.deepEqual(parseArguments([`--confirm=${CONFIRMATION}`,'--expires=x','--url=evil']),{});
 assert.deepEqual(parseArguments([`--confirm=${CONFIRMATION}`,'--expires=x']),{confirmation:CONFIRMATION,expires:'x'});
});
for(const outcome of ['passed','failed','not_run'])test(`hold runs once and remains healthy after ${outcome}`,async t=>{
 let calls=0;const logs=[];const hold=await startHold({port:0,host:'127.0.0.1',run:async()=>{calls++;return {status:outcome};},emit:x=>logs.push(x)});t.after(()=>hold.stop());
 await hold.completed;for(const path of ['/healthz','/readyz']){
  const r=await get(`http://127.0.0.1:${hold.server.address().port}${path}`);assert.equal(r.status,200);assert.equal(r.body.status,outcome);assert.equal(r.body.projector_running,false);assert.equal(r.body.restore_required,true);
 }
 assert.equal(calls,1);assert.equal(logs.length,1);
});
test('wrapper rejection logs only closed safe status',async t=>{
 const logs=[];const hold=await startHold({port:0,host:'127.0.0.1',run:async()=>{throw Error('SECRET_PROVIDER_RESPONSE');},emit:x=>logs.push(x)});t.after(()=>hold.stop());await hold.completed;
 assert.equal(JSON.stringify(logs).includes('SECRET'),false);assert.equal(logs[0].status,'failed');
});
