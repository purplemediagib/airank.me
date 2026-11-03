// Dedicated deterministic read-model process. Never imports provider dispatch,
// collection, paid annotation ticks, or the monitoring worker.
import http from 'node:http';
import {setTimeout as sleep} from 'node:timers/promises';
import {getDb} from '../common/db.mjs';
import {one} from '../monitoring/shared.mjs';
import {id as indexId,checksum as indexChecksum} from './read-migration.mjs';
import {assertSummaryReady} from './summary-service.mjs';
import {formatVersion} from './summary-contract.mjs';
import {projectSummaryOnce,prewarmSummaries,cleanupSummaries} from './summary-projector.mjs';
const db=await getDb();
await assertSummaryReady(db,process.env); // Operator migrations are separate.
if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[indexId]))?.checksum!==indexChecksum)throw Error('ANALYTICS_READ_INDEXES_REQUIRED');
let stop=false,running=false,lastSuccess=Date.now(),lastWarmDay='',after='';
const server=http.createServer((req,res)=>{
 const health=req.url==='/healthz',ready=req.url==='/readyz';
 const ok=health||ready&&!stop&&Date.now()-lastSuccess<15*60000;
 res.writeHead(health||ready?(ok?200:503):404,{'content-type':'application/json','cache-control':'no-store'});
 res.end(JSON.stringify(health||ready?{ok,service:'analytics-projector',revision:process.env.AIRANK_BUILD_REVISION||null,formatVersion:formatVersion(),running}:{error:'Not found'}));
});
server.listen(Number(process.env.PORT||3003),'0.0.0.0');
process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});
let ticks=0;
while(!stop){
 try{
  const day=new Date().toISOString().slice(0,10);
  if(process.env.AIRANK_ANALYTICS_PREWARM==='true'&&lastWarmDay!==day){
   const result=await prewarmSummaries({db,after});after=result.next||'';if(!result.next)lastWarmDay=day;
  }
  running=true;const result=await projectSummaryOnce({db});running=false;
  if(result.state!=='failed')lastSuccess=Date.now();
  if(result.state==='failed')console.warn(JSON.stringify({event:'analytics_projection_failed',code:result.code,phase:result.phase,projectId:result.projectId,durationMs:result.durationMs}));
  if(result.state==='published')console.log(JSON.stringify({event:'analytics_projection_published',projectId:result.projectId,sourceRevision:result.sourceRevision,durationMs:result.durationMs}));
  if(++ticks%60===0)await cleanupSummaries(db,Date.now());
  if(result.state==='idle')await sleep(1000);
 }catch{running=false;console.warn(JSON.stringify({event:'analytics_projector_unavailable'}));await sleep(3000);}
}
await new Promise(resolve=>server.close(resolve));
db.close?.();
