import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
import {CONFIG} from '../common/config.mjs';
import {storeRawJson} from '../common/storage.mjs';
import {routesFromEnv,routeAvailable,compatibleRoute} from '../providers/routing.mjs';
import {callRoute} from '../providers/dispatch.mjs';
import {migrateBenchmark} from './schema.mjs';
import {importPanel,enqueue,budgets,processBenchmark,nextSlot} from './core.mjs';
export const currentRoutes=()=>routesFromEnv();
export const models=()=>Object.fromEntries(Object.entries(currentRoutes()).map(([p,r])=>[p,r.model]));
export function routeForSnapshot(provider,snap){return snap.routes?.[provider]||{transport:'direct',model:snap.models[provider]};}
export async function storeEvidence(job,envelope){
 const body=JSON.stringify(envelope),digest=createHash('sha256').update(body).digest('hex');
 // UUID/hash run IDs keep this separate from the existing free-checker namespace.
 const key=await storeRawJson('benchmark-'+job.run_id,job.provider,job.id,envelope);
 if(!key)throw Error('Benchmark requires Bunny Storage zone and write key');return {key,hash:digest};
}
let initialized=false;
export async function benchmarkTick(){
 if(process.env.BENCHMARK_ENABLED!=='true')return;
 const db=await getDb();
 if(!initialized){
 budgets();
 if(!process.env.BUNNY_STORAGE_ZONE||!process.env.BUNNY_STORAGE_ACCESS_KEY)throw Error('Configure existing Bunny Storage before enabling benchmarks');
 if(process.env.BENCHMARK_AUTO_MIGRATE==='true')await migrateBenchmark(db);
 await db.execute('SELECT id FROM bm_panels LIMIT 1');
 if(process.env.BENCHMARK_BOOTSTRAP_PILOT==='true'){
 const panel=JSON.parse(await readFile(new URL('../../data/fi-mobile-v1.json',import.meta.url),'utf8'));
 await importPanel(db,panel);
 if(process.env.BENCHMARK_PILOT_RUN==='true'){const id=await enqueue(db,panel.id,process.env.BENCHMARK_PILOT_RUN_KEY||'pilot-routed-v3',models(),Date.now(),currentRoutes());console.log(JSON.stringify({event:'benchmark_pilot_ready',run_id:id,panel_id:panel.id}));}
 }
 initialized=true;
 }
 const routes=currentRoutes();
 await processBenchmark(db,{models:models(),routes,canExecute:(p,snap)=>snap.methodology==='fi-routed-search-v3'&&compatibleRoute(routeForSnapshot(p,snap),routes[p]),available:p=>routeAvailable(p,routes[p]),call:(p,q,model,snap)=>callRoute(p,q,routeForSnapshot(p,snap),Math.min(CONFIG.httpTimeoutMs,90000)),store:storeEvidence,scheduled:process.env.BENCHMARK_SCHEDULER_ENABLED==='true',onEvent:e=>console.log(JSON.stringify(e))});
}
