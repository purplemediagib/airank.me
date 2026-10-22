import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
import {migrateScheduling} from './migration.mjs';
export const ddl=[
 "UPDATE app_schedule_slots SET state='cancelled',reason='daily_schedule_upgrade' WHERE state='pending'",
 "UPDATE app_project_schedules SET timezone='Europe/Helsinki',hour=4,weekdays='[0,1,2,3,4,5,6]',next_at=0,version=version+1",
 // A paused legacy schedule remains paused. New enrollments are created by
 // the application; migration itself never starts a run.
];
export const id='app-013-daily-prompt-sets';
export const checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migrateDailyScheduling(db){
 await migrateScheduling(db);
 const tx=await db.transaction('write');
 try{
  const old=(await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[id]})).rows[0];
  if(old&&old.checksum!==checksum)throw Error('Migration checksum mismatch');
  if(!old){
   for(const sql of ddl)await tx.execute(sql);
   await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[id,checksum,new Date().toISOString()]});
  }
  await tx.commit();
 }catch(e){await tx.rollback();throw e;}finally{tx.close();}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){await migrateDailyScheduling(await getDb());console.log(`Applied ${id}`);}
