import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {isAppPath} from '../src/app/http.mjs';

test('all app-level route families reach the authenticated dispatcher without swallowing legacy checker routes',()=>{
 for(const path of ['/v1/app/session','/v1/projects','/v1/projects/p/reports','/v1/me/preferences','/v1/measurement-context','/v1/website-profiles','/v1/website-profiles/capabilities','/v1/website-profiles/job','/v1/industries','/v1/industries/panel'])assert.equal(isAppPath(path),true,path);
 for(const path of ['/v1/measurement-context-evil','/v1/industriesevil','/v1/website-profilesevil','/v1/scans','/v1/auth/session','/healthz','/readyz'])assert.equal(isAppPath(path),false,path);
});

test('real API HTTP entrypoint forwards catalogue, autofill and industry paths even without workspace database credentials',async()=>{
 const reservation=net.createServer();
 await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
 const port=reservation.address().port;
 await new Promise(resolve=>reservation.close(resolve));
 const child=spawn(process.execPath,['src/api/server.mjs'],{
  cwd:new URL('../',import.meta.url),
  env:{PATH:process.env.PATH,PORT:String(port),APP_ENV:'staging',ENABLED_PROVIDERS:''},
  stdio:['ignore','pipe','pipe'],
 });
 let logs='';child.stdout.on('data',v=>{logs+=v});child.stderr.on('data',v=>{logs+=v});
 try{
  let healthy=false;
  for(let i=0;i<80;i++){
   try{const r=await fetch(`http://127.0.0.1:${port}/healthz`);healthy=r.ok;if(healthy)break;}catch{}
   await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(healthy,logs);
  for(const path of ['/v1/measurement-context','/v1/website-profiles/capabilities','/v1/industries','/v1/projects/project/analytics?promptId=prompt&promptVersion=1','/v1/projects/project/results','/v1/projects/project/monitoring-runs','/v1/projects/project/connections/ga4','/v1/projects/project/connections/gsc/properties','/v1/projects/project/connections/ga4/reports?startDate=2026-10-01&endDate=2026-10-02']){
   const response=await fetch(`http://127.0.0.1:${port}${path}`);
   assert.equal(response.status,503,path); // Explicit unavailable database, NOT an unhandled 404.
   assert.equal((await response.json()).error.code,'SERVICE_UNAVAILABLE',path);
  }
   const email=await fetch(`http://127.0.0.1:${port}/v1/app/email/sign-in`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'offline@example.test',password:'offline-test-password',locale:'en'}),
   });
   assert.equal(email.status,503);
   assert.equal((await email.json()).error.code,'SERVICE_UNAVAILABLE');
 }finally{
  const exited=new Promise(resolve=>child.once('exit',resolve));
  child.kill('SIGTERM');
  if(child.exitCode===null)await exited;
 }
});
