// Dedicated deterministic read-model process. Never imports provider dispatch,
// collection, paid annotation ticks, or the monitoring worker.
import http from 'node:http';
import {setTimeout as sleep} from 'node:timers/promises';
import {createSummaryDatabase} from './summary-transport.mjs';
import {assertPublicationSafe} from './summary-store.mjs';
import {createSummaryWorkerControl} from './summary-worker-control.mjs';
import {one} from '../monitoring/shared.mjs';
import {id as indexId,checksum as indexChecksum} from './read-migration.mjs';
import {assertSummaryReady} from './summary-service.mjs';
import {formatVersion} from './summary-contract.mjs';
import {projectSummaryOnce,prewarmSummaries,cleanupSummaries} from './summary-projector.mjs';
const db=createSummaryDatabase({url:process.env.BUNNY_DATABASE_URL,authToken:process.env.BUNNY_DATABASE_AUTH_TOKEN});
await assertSummaryReady(db,process.env); // Operator migrations are separate.
if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[indexId]))?.checksum!==indexChecksum)throw Error('ANALYTICS_READ_INDEXES_REQUIRED');
let stop=false;
const control=createSummaryWorkerControl({db,assertPublicationSafe,projectSummaryOnce,prewarmSummaries,cleanupSummaries,log:event=>console.warn(JSON.stringify(event))});
const server=http.createServer((req,res)=>{
 const health=req.url==='/healthz',ready=req.url==='/readyz';
 const status=control.status();
 const ok=health||ready&&!stop&&status.ready;
 res.writeHead(health||ready?(ok?200:503):404,{'content-type':'application/json','cache-control':'no-store'});
 res.end(JSON.stringify(health||ready?{ok,service:'analytics-projector',revision:process.env.AIRANK_BUILD_REVISION||null,formatVersion:formatVersion(),running:status.running,blocked:status.blocked,code:status.code}:{error:'Not found'}));
});
server.listen(Number(process.env.PORT||3003),'0.0.0.0');
process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});
while(!stop){
 const result=await control.tick();
 if(result.state==='idle')await sleep(1000);
 if(result.state==='unavailable'||result.state==='blocked')await sleep(3000);
}
await new Promise(resolve=>server.close(resolve));
db.close?.();
