import {getDb} from '../common/db.mjs';
import {one} from '../monitoring/shared.mjs';
import {id,checksum} from './migration.mjs';
import {createEntityEngine} from './engine.mjs';
let engine;
export async function entityTick(){
 if(process.env.ENTITY_ANALYSIS_ENABLED!=='true')return;
 if(!engine){const db=await getDb();if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)throw Error('Intelligence migration is not ready');engine=createEntityEngine({db});}
 await engine.tick();
}
