import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
export const id='app-008-website-profiles';
const ddl=[`CREATE TABLE app_website_profiles(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),submission_id TEXT NOT NULL,website TEXT NOT NULL,domain TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,lease_until INTEGER,payload TEXT,error TEXT,UNIQUE(owner_id,submission_id))`,`CREATE INDEX app_website_profiles_queue ON app_website_profiles(status,created_at)`];
export const checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migrateWebsiteProfiles(db){
 const tx=await db.transaction('write');
 try{const old=(await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[id]})).rows[0];if(old&&old.checksum!==checksum)throw Error('Migration checksum mismatch');
 if(!old){for(const sql of ddl)await tx.execute(sql);await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[id,checksum,new Date().toISOString()]});}await tx.commit();
 }catch(e){await tx.rollback();throw e;}finally{tx.close();}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){await migrateWebsiteProfiles(await getDb());console.log(`Applied ${id}`);}
