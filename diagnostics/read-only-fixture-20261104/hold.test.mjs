import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {CONFIRMATION,VERIFIED_DATABASE_URL,approvedWindow,runConfiguredProbe,startProbeHold} from './hold.mjs';
const now=Date.parse('2026-11-04T16:00:00.000Z');
const expiry=new Date(now+60000).toISOString();
test('explicit confirmation and canonical short future window are required',()=>{
 assert.equal(approvedWindow(CONFIRMATION,expiry,now),true);
 for (const [confirmation,end] of [[undefined,expiry],['wrong',expiry],[CONFIRMATION,undefined],[CONFIRMATION,'SECRET'],[CONFIRMATION,new Date(now).toISOString()],[CONFIRMATION,new Date(now+120001).toISOString()]])
  assert.equal(approvedWindow(confirmation,end,now),false);
});
test('missing opt-in never reads environment',async()=>{
 const env=new Proxy({}, {get(){assert.fail('environment accessed without confirmation');}});
 assert.equal((await runConfiguredProbe({env})).status,'not_run');
 assert.equal((await runConfiguredProbe({env,confirmation:CONFIRMATION,expires:'2000-01-01T00:00:00.000Z'})).status,'not_run');
});
test('mismatched configured endpoint never reads token',async()=>{
 const env={BUNNY_DATABASE_URL:'https://other.invalid/',get BUNNY_DATABASE_AUTH_TOKEN(){assert.fail('token read for wrong endpoint');}};
 assert.equal((await runConfiguredProbe({env,confirmation:CONFIRMATION,expires:expiry,now})).status,'configuration_rejected');
});
test('missing credential is rejected without request',async()=>{
 assert.equal((await runConfiguredProbe({env:{BUNNY_DATABASE_URL:VERIFIED_DATABASE_URL},confirmation:CONFIRMATION,expires:new Date(Math.floor(Date.now()/1000)*1000+60000).toISOString()})).status,'configuration_rejected');
});
test('actual adapter issues six exact origin-only requests and redacts secret',()=>{
 const program=`
 globalThis.fetch=async request=>{
  const body=await request.json();
  if(request.redirect!=='manual'||request.url!=='https://01m4mydtp7sqp65a096qd7dbj2-airank-db.lite.bunnydb.net/v2/pipeline')throw Error('destination');
  if(!body.requests[0].stmt.sql.startsWith('SELECT 1 FROM airank_http_smoke_20261104_ec81557_'))throw Error('sql');
  return Response.json({baton:null,base_url:'https://attacker.invalid/SECRET',results:[{type:'ok',response:{type:'execute',result:{cols:[{name:'1',decltype:null}],affected_row_count:0,rows:[]}}},{type:'ok',response:{type:'close'}}]});
 };
 const m=await import(${JSON.stringify(new URL('./hold.mjs',import.meta.url).href)});
 const result=await m.runConfiguredProbe({confirmation:m.CONFIRMATION,expires:new Date(Math.floor(Date.now()/1000)*1000+60000).toISOString(),env:{BUNNY_DATABASE_URL:m.VERIFIED_DATABASE_URL,BUNNY_DATABASE_AUTH_TOKEN:'SECRET'}});
 if(result.status!=='observed'||result.requests!==6||JSON.stringify(result).includes('SECRET'))throw Error('wrong result');
 console.log('safe');`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8',timeout:5000});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'safe');
});
test('hold runs exactly once in a process, exposes no data, and stops',async()=>{
 let calls=0;const events=[];
 const h=await startProbeHold({port:0,host:'127.0.0.1',run:async()=>{calls++;return{status:'observed',requests:6,writes:0,retries:0};},emit:x=>events.push(x)});
 try {
  await h.completed;
  const port=h.server.address().port;
  for (const path of ['/healthz','/readyz']) {
   const r=await fetch(`http://127.0.0.1:${port}${path}`);const data=await r.json();
   assert.equal(r.status,200);assert.equal(data.projector_running,false);assert.equal(data.restore_required,true);
   assert.equal(data.tables,undefined);
  }
  assert.equal(calls,1);assert.equal(events.length,2);
 } finally {await h.stop();await h.stop();}
});
test('stop aborts active probe instead of retrying',async()=>{
 let calls=0;
 const h=await startProbeHold({port:0,host:'127.0.0.1',run:async({signal})=>{calls++;return await new Promise(resolve=>{if(signal.aborted)resolve({status:'inconclusive'});else signal.addEventListener('abort',()=>resolve({status:'inconclusive'}),{once:true});});},emit:()=>{}});
 await h.stop();assert.equal(calls,1);
});

test('expiry reached during configuration is rechecked before token access',async()=>{
 const original=Date.now;let time=now;Date.now=()=>time;
 try {
  const env={get BUNNY_DATABASE_URL(){time=now+60001;return VERIFIED_DATABASE_URL;},get BUNNY_DATABASE_AUTH_TOKEN(){assert.fail('expired token access');}};
  assert.equal((await runConfiguredProbe({confirmation:CONFIRMATION,expires:expiry,env})).status,'not_run');
 } finally {Date.now=original;}
});
test('expiry after token access is rejected before native fetch',async()=>{
 const original=Date.now;let time=now;Date.now=()=>time;
 try {
  const env={BUNNY_DATABASE_URL:VERIFIED_DATABASE_URL,get BUNNY_DATABASE_AUTH_TOKEN(){time=now+60001;return 'MOCK_SECRET';}};
  const result=await runConfiguredProbe({confirmation:CONFIRMATION,expires:expiry,env});
  assert.equal(result.status,'inconclusive');assert.equal(result.requests,1);
 } finally {Date.now=original;}
});
