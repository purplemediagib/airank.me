import {createHash} from 'node:crypto';
import {getDb} from './db.mjs';
export const id='app-009-context-drafts';
const ddl=`CREATE TABLE app_context_drafts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES app_projects(id),status TEXT NOT NULL,payload TEXT,created_at INTEGER NOT NULL)`;
export const checksum=createHash('sha256').update(ddl).digest('hex');
export async function migrateContextDrafts(db){
 const tx=await db.transaction('write');
 try{const old=(await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[id]})).rows[0];
 if(old&&old.checksum!==checksum)throw Error('Migration checksum mismatch');
 if(!old){await tx.execute(ddl);await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[id,checksum,new Date().toISOString()]});}
 await tx.commit();}catch(e){await tx.rollback();throw e;}finally{tx.close();}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){await migrateContextDrafts(await getDb());console.log(`Applied ${id}`);}
