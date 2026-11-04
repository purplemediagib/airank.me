import {getDb} from '../common/db.mjs';
import {one} from '../monitoring/shared.mjs';
import {id,checksum} from './migration.mjs';
import {createEntityEngine} from './engine.mjs';
import {atOperationStage,operationFailure,operationDiagnostic} from '../common/operation-diagnostics.mjs';
import {logEvent} from '../providers/diagnostics.mjs';
export function createEntityTick({env=process.env,getDatabase=getDb,makeEngine=createEntityEngine}={}){
 let engine;
 return async()=>{
  if(env.ENTITY_ANALYSIS_ENABLED!=='true')return;
  if(!engine){
   const db=await atOperationStage('entity_database_connect',()=>getDatabase());
   const migration=await atOperationStage('entity_migration_read',()=>one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]));
   if(migration?.checksum!==checksum)throw operationFailure('entity_migration_validate',null,{diagnostic_code:'MIGRATION_NOT_READY'});
   engine=await atOperationStage('entity_engine_initialize',()=>makeEngine({db,env}));
  }
  await atOperationStage('entity_tick',()=>engine.tick());
 };
}
export const entityTick=createEntityTick();
export function reportEntityFailure(error,logger=logEvent){
 try{logger('entity_analysis_unavailable',operationDiagnostic(error,'entity_tick'));}catch{}
}
