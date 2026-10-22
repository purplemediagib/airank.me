import { getDb } from '../common/db.mjs';
import { createMonitoringEngine } from './engine.mjs';
import { id,checksum } from './migration.mjs';
import { one } from './shared.mjs';
import {tickProjects} from '../scheduling/projects.mjs';
import {tickImmediate} from './immediate.mjs';
let engine;
export async function monitoringTick(){
 if(process.env.MONITORING_ENABLED!=='true')return;
 await tickImmediate(await getDb());
 if(process.env.PROJECT_SCHEDULER_ENABLED==='true')await tickProjects(await getDb());
 if(!engine){
  const db=await getDb();
  if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)throw Error('Monitoring migration is not ready');
  engine=createMonitoringEngine({db});
 }
 await engine.tick();
}
