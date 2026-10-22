import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
export const ddl=[`CREATE TABLE app_opportunities(project_id TEXT NOT NULL REFERENCES app_projects(id),id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(project_id,id))`];
export const id='app-006-opportunities',checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migrateOpportunities(db){
 const tx=await db.transaction('write');
 try{const old=(await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[id]})).rows[0];
 if(old&&old.checksum!==checksum)throw Error('Migration checksum mismatch');
 if(!old){for(const sql of ddl)await tx.execute(sql);await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[id,checksum,new Date().toISOString()]});}await tx.commit();
 }catch(e){await tx.rollback();throw e;}finally{tx.close();}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){await migrateOpportunities(await getDb());console.log(`Applied ${id}`);}
