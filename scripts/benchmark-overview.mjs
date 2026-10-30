// Offline benchmark only. No network, credentials, production DB, or provider calls.
// Usage: node scripts/benchmark-overview.mjs <baseline service module path>
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { analyticsService } from '../app/src/analytics/service.mjs';
import { migrations } from '../app/src/migrate.mjs';
import { appDDL } from '../app/src/app/migration.mjs';
import { scanDDL } from '../app/src/app/scan-migration.mjs';
import { ddl } from '../app/src/monitoring/migration.mjs';
const baseline=(await import(pathToFileURL(resolve(process.argv[2])).href)).analyticsService;
const sql=new DatabaseSync(':memory:');
for(const q of [...migrations,...appDDL,scanDDL,...ddl])sql.exec(q);
sql.exec("INSERT INTO users (id,google_sub,email,display_name,created_at,updated_at) VALUES ('alice','alice','alice@example.com','Alice',1,1)");
sql.prepare('INSERT INTO app_projects VALUES (?,?,?,?,?)').run('project','alice','active',1,'2026-01-01T00:00:00Z');
const identity={brandName:'Example',aliases:[],ownedDomains:['example.fi']};
sql.prepare('INSERT INTO app_identity_versions VALUES (?,?,?,?)').run('project',1,JSON.stringify(identity),'2026-01-01T00:00:00Z');
const prompts=Array.from({length:17},(_,i)=>({id:`p${i}`,version:1,text:`Question ${i}`,topic:'general'}));
const snapshot={identity,identityVersion:1,kind:'neutral',market:'FI',language:'fi',methodology:'tracked-fi-evidence-v1',prompts,routes:[{provider:'openai',model:'fixture'}]};
for(let day=0;day<28;day++){
 const id=`r${day}`,stamp=Date.parse('2026-10-01T00:00:00Z')+day*86400000;
 sql.prepare('INSERT INTO mon_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'project','alice',id,id,'neutral','completed',JSON.stringify(snapshot),17,stamp,stamp+1000,null);
 for(const p of prompts){
  const task=`${id}-${p.id}`;
  sql.prepare('INSERT INTO mon_tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run(task,id,p.id,1,p.text,'openai','{}','done',null,null);
  const e={id:task,runId:id,promptId:p.id,promptVersion:1,text:p.text,provider:'openai',model:'fixture',status:'success',observedAt:stamp,answer:'Example is an option.',citations:[]};
  sql.prepare('INSERT INTO mon_evidence VALUES (?,?,?,?)').run(task,id,JSON.stringify(e),stamp);
 }
}
async function measure(fn){
 let calls=0,active=0,peak=0;
 const db={execute:async q=>{
  calls++;active++;peak=Math.max(peak,active);
  try {await new Promise(r=>setTimeout(r,25));return {rows:sql.prepare(q.sql).all(...q.args)};}
  finally {active--;}
 }};
 const start=performance.now();
 const result=await fn({db,userId:'alice',path:'/v1/projects/project/analytics',query:new URLSearchParams('from=2026-10-01&to=2026-10-28')});
 return {result,ms:Math.round(performance.now()-start),calls,peak};
}
const before=await measure(baseline),after=await measure(analyticsService);
assert.deepEqual(after.result,before.result);
console.log(JSON.stringify({kind:'OFFLINE synthetic 25ms per DB read; not a browser/production benchmark',fixture:{runs:28,prompts:17,answers:476},before:{ms:before.ms,queries:before.calls,peak:before.peak},after:{ms:after.ms,queries:after.calls,peak:after.peak},identicalResponse:true},null,2));
sql.close();
