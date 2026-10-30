import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {verifyCaptcha,captchaConfig} from '../src/public-check/captcha.mjs';
const env={TURNSTILE_SITE_KEY:'fixture-site',TURNSTILE_SECRET_KEY:'fixture-secret',TURNSTILE_ALLOWED_HOSTNAMES:'app.example.test, preview.example.test'};
const time=1791900000000;
const valid={success:true,action:'public_check',hostname:'app.example.test',challenge_ts:new Date(time).toISOString()};
const response=data=>async()=>new Response(JSON.stringify(data));
const call=(data=valid,extra={})=>verifyCaptcha({token:'fixture-token',env,now:()=>time,fetcher:response(data),...extra});
test('CAPTCHA requires explicit complete configuration and exact hostname allowlist',async()=>{
 for(const key of Object.keys(env)){
  assert.equal(captchaConfig({...env,[key]:''}).ready,false);
  await assert.rejects(call(valid,{env:{...env,[key]:''}}),e=>e.code==='CAPTCHA_UNAVAILABLE');
 }
 assert.equal(captchaConfig({...env,TURNSTILE_ALLOWED_HOSTNAMES:'*.example.test'}).ready,false);
 await call();
});
test('CAPTCHA rejects missing, oversized, invalid, expired, future, wrong-host and wrong-action tokens',async()=>{
 for(const token of [undefined,null,{},'', ' ', 'x'.repeat(2049)])await assert.rejects(call(valid,{token}),e=>e.code==='CAPTCHA_REQUIRED');
 for(const bad of [null,{}, {...valid,success:false},{...valid,success:'true'}, {...valid,action:'login'}, {...valid,hostname:'evil.example.test'}, {...valid,hostname:'app.example.test.evil.test'}, {...valid,challenge_ts:'invalid'}, {...valid,challenge_ts:new Date(time-300000).toISOString()}, {...valid,challenge_ts:new Date(time+1).toISOString()}])await assert.rejects(call(bad),e=>e.code==='CAPTCHA_FAILED');
});
test('CAPTCHA network errors and malformed provider responses fail closed without retry or secret leakage',async()=>{
 for(const fetcher of [async()=>{throw Error('secret response');},async()=>new Response('no',{status:500}),async()=>new Response('not JSON'),async()=>new Response('x'.repeat(16385))])await assert.rejects(call(valid,{fetcher}),e=>e.code==='CAPTCHA_UNAVAILABLE'&&!e.message.includes('secret'));
 let calls=0;
 await call(valid,{fetcher:async(url,init)=>{calls++;assert.equal(url,'https://challenges.cloudflare.com/turnstile/v0/siteverify');assert(init.signal);assert.equal(init.redirect,'error');assert.deepEqual(JSON.parse(init.body),{secret:'fixture-secret',response:'fixture-token'});return new Response(JSON.stringify(valid));}});
 assert.equal(calls,1);
});
test('provider single-use verification rejects replay and is never cached locally',async()=>{
 const used=new Set();const fetcher=async(_url,init)=>{const token=JSON.parse(init.body).response;const repeated=used.has(token);used.add(token);return new Response(JSON.stringify(repeated?{success:false,'error-codes':['timeout-or-duplicate']}:valid));};
 await call(valid,{fetcher});await assert.rejects(call(valid,{fetcher}),e=>e.code==='CAPTCHA_FAILED');
});
test('legacy public submission gates queue writes while authenticated app dispatch stays separate',async()=>{
 const source=await readFile(new URL('../src/api/server.mjs',import.meta.url),'utf8');
 const legacy=source.slice(source.indexOf("if(method==='POST' && pathname==='/v1/scans')"));
 assert(legacy.indexOf('await verifyCaptcha')<legacy.indexOf('await admitLegacyScan'));
 assert(source.indexOf('return appRoute(req,res,url)')<source.indexOf('await verifyCaptcha'));
});
