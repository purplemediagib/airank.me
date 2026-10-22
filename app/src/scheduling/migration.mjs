import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
import {migrateBenchmark} from '../benchmark/schema.mjs';
export const ddl=[
`CREATE TABLE app_project_schedules(project_id TEXT PRIMARY KEY REFERENCES app_projects(id),version INTEGER NOT NULL,enabled INTEGER NOT NULL,timezone TEXT NOT NULL,hour INTEGER NOT NULL,weekdays TEXT NOT NULL,next_at INTEGER NOT NULL)`,
`CREATE TABLE app_schedule_slots(project_id TEXT NOT NULL,slot TEXT NOT NULL,due_at INTEGER NOT NULL,state TEXT NOT NULL,run_id TEXT,reason TEXT,PRIMARY KEY(project_id,slot))`,
`CREATE TABLE bm_publications(panel_id TEXT PRIMARY KEY REFERENCES bm_panels(id),published INTEGER NOT NULL,verified_by TEXT NOT NULL,created_at INTEGER NOT NULL)`
];
export const id='app-005-schedules',checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migrateScheduling(db){
 await migrateBenchmark(db);const tx=await db.transaction('write');
 try{const old=(await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[id]})).rows[0];
 if(old&&old.checksum!==checksum)throw Error('Migration checksum mismatch');
 if(!old){for(const sql of ddl)await tx.execute(sql);await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[id,checksum,new Date().toISOString()]});}
 await tx.commit();}catch(e){await tx.rollback();throw e;}finally{tx.close();}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){await migrateScheduling(await getDb());console.log(`Applied ${id}`);}
