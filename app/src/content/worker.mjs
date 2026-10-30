import http from 'node:http';
import {getDb} from '../common/db.mjs';
import {one} from './store.mjs';
import {id,checksum} from './migration.mjs';
// Permanently quiescent: preserve queued/running/uncertain rows without
// claiming, retrying, expiring leases, generating children or provider calls.
export async function tick(){return false;}
export async function schedule(){return;}
export async function start(){const db=await getDb();let ready=false,stopping=false,lastTick=0;const server=http.createServer((req,res)=>{const ok=req.url==='/health'||req.url==='/ready'&&ready&&Date.now()-lastTick<600000;res.writeHead(ok?200:503,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({service:'airank-content-worker',version:'1.0.0',retired:true,executionEnabled:false,ready:ok,revision:process.env.AIRANK_BUILD_REVISION||null}));});server.listen(Number(process.env.PORT||3002));
 const stop=()=>{stopping=true;server.close();};process.on('SIGTERM',stop);process.on('SIGINT',stop);
 while(!stopping){try{ready=(await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum===checksum;if(ready){try{await schedule(db);}catch{console.error('content_schedule_deferred');}const worked=await tick(db);lastTick=Date.now();if(worked)continue;}}catch{ready=false;console.error('content_worker_tick_failed');}await new Promise(r=>setTimeout(r,3000));}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href)await start();
