import {getDb} from '../common/db.mjs';
import {one} from '../monitoring/shared.mjs';
import {id,checksum} from './migration.mjs';
import {createSentimentEngine} from './engine.mjs';
let engine;
export async function sentimentTick(){
 if(process.env.SENTIMENT_ENABLED!=='true')return;
 if(!engine){const db=await getDb();if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)throw Error('Sentiment migration is not ready');engine=createSentimentEngine({db});}
 await engine.tick();
}
