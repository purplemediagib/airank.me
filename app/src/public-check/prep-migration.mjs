import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
// Monetary ceilings reserved for billable free-check PREPARATION calls
// (website scrape, identity inference, AI question drafting). These happen
// before any scan exists, so they are keyed by request stage, not scan.
export const ddl=[
 `CREATE TABLE public_check_prep_reservations(id TEXT PRIMARY KEY,stage_key TEXT NOT NULL,fingerprint TEXT NOT NULL,stage TEXT NOT NULL CHECK(stage IN ('scrape','identity','questions')),reserved_nano_usd INTEGER NOT NULL CHECK(reserved_nano_usd>0),reserved_at INTEGER NOT NULL,plan_json TEXT NOT NULL)`,
 `CREATE INDEX public_check_prep_reservation_key ON public_check_prep_reservations(stage_key,reserved_at)`,
 `CREATE INDEX public_check_prep_reservation_date ON public_check_prep_reservations(reserved_at)`,
 `CREATE INDEX public_check_prep_reservation_visitor ON public_check_prep_reservations(fingerprint,reserved_at)`,
];
export const id='app-024-public-check-prep-reservations',checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migratePublicCheckPrepBudget(db){
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
 await migratePublicCheckPrepBudget(await getDb());console.log(`Applied ${id}`);
}
