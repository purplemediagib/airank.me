import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
export const ddl=[
`CREATE TABLE app_reports(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES app_projects(id),owner_id TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,locale TEXT NOT NULL,payload TEXT NOT NULL)`,
`CREATE TABLE app_measurement_settings(project_id TEXT PRIMARY KEY REFERENCES app_projects(id),version INTEGER NOT NULL,providers TEXT NOT NULL,updated_at INTEGER NOT NULL)`
];
export const id='app-007-reports',checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migrateReports(db){
 const tx=await db.transaction('write');
 try{const old=(await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[id]})).rows[0];
 if(old&&old.checksum!==checksum)throw Error('Migration checksum mismatch');
 if(!old){for(const sql of ddl)await tx.execute(sql);await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[id,checksum,new Date().toISOString()]});}await tx.commit();
 }catch(e){await tx.rollback();throw e;}finally{tx.close();}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){await migrateReports(await getDb());console.log(`Applied ${id}`);}
