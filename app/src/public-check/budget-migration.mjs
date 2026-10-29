import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
// Monetary ceilings reserved for free (guest) checks. Separate from paid
// mon_api_reservations so guest spend can never consume or reveal paid budget.
export const ddl=[
 `CREATE TABLE public_check_api_reservations(id TEXT PRIMARY KEY,scan_id TEXT NOT NULL REFERENCES scan_jobs(id),provider TEXT NOT NULL,prompt_id TEXT NOT NULL,reserved_nano_usd INTEGER NOT NULL CHECK(reserved_nano_usd>0),reserved_at INTEGER NOT NULL,plan_json TEXT NOT NULL,UNIQUE(scan_id,provider,prompt_id))`,
 `CREATE INDEX public_check_api_reservation_date ON public_check_api_reservations(reserved_at)`,
];
export const id='app-023-public-check-api-reservations',checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migratePublicCheckBudget(db){
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
 await migratePublicCheckBudget(await getDb());console.log(`Applied ${id}`);
}
