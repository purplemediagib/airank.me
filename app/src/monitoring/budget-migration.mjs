import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
export const ddl=[
 `CREATE TABLE mon_api_reservations(task_id TEXT PRIMARY KEY REFERENCES mon_tasks(id),reserved_nano_usd INTEGER NOT NULL CHECK(reserved_nano_usd>0),reserved_at INTEGER NOT NULL,config_json TEXT NOT NULL)`,
 `CREATE INDEX mon_api_reservation_date ON mon_api_reservations(reserved_at)`,
];
export const id='app-017-api-reservations',checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migrateApiBudget(db){
 const tx=await db.transaction('write');
 try{
  const old=(await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[id]})).rows[0];
  if(old&&old.checksum!==checksum)throw Error('Migration checksum mismatch');
  if(!old){
   for(const sql of ddl)await tx.execute(sql);
   await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[id,checksum,new Date().toISOString()]});
  }
  await tx.commit();
 }catch(error){await tx.rollback();throw error;}finally{tx.close();}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){
 await migrateApiBudget(await getDb());console.log(`Applied ${id}`);
}
