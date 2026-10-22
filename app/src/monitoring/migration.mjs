import { createHash } from 'node:crypto';
import { getDb } from '../common/db.mjs';
export const ddl = [
`CREATE TABLE mon_prompts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES app_projects(id),version INTEGER NOT NULL,status TEXT NOT NULL,hash TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(project_id,hash))`,
`CREATE TABLE mon_prompt_versions(prompt_id TEXT NOT NULL REFERENCES mon_prompts(id),version INTEGER NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(prompt_id,version))`,
`CREATE TABLE mon_suggestions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES app_projects(id),hash TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,source TEXT NOT NULL,prompt_id TEXT REFERENCES mon_prompts(id),UNIQUE(project_id,hash))`,
`CREATE TABLE mon_runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES app_projects(id),owner_id TEXT NOT NULL REFERENCES users(id),submission_id TEXT NOT NULL,request_hash TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,snapshot TEXT NOT NULL,expected INTEGER NOT NULL,created_at INTEGER NOT NULL,deadline_at INTEGER NOT NULL,reason TEXT,UNIQUE(owner_id,submission_id))`,
`CREATE TABLE mon_tasks(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES mon_runs(id),prompt_id TEXT NOT NULL,prompt_version INTEGER NOT NULL,text TEXT NOT NULL,provider TEXT NOT NULL,route TEXT NOT NULL,status TEXT NOT NULL,lease_until INTEGER,claim_token TEXT,UNIQUE(run_id,prompt_id,provider))`,
`CREATE INDEX mon_task_queue ON mon_tasks(status,run_id)`,
`CREATE TABLE mon_budget(task_id TEXT PRIMARY KEY REFERENCES mon_tasks(id),reserved_at INTEGER NOT NULL)`,
`CREATE TABLE mon_receipts(task_id TEXT PRIMARY KEY REFERENCES mon_tasks(id),payload TEXT NOT NULL,observed_at INTEGER NOT NULL)`,
`CREATE TABLE mon_evidence(id TEXT PRIMARY KEY REFERENCES mon_tasks(id),run_id TEXT NOT NULL REFERENCES mon_runs(id),payload TEXT NOT NULL,observed_at INTEGER NOT NULL)`,
];
export const id='app-003-monitoring', checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migrateMonitoring(db) {
 const tx=await db.transaction('write');
 try {
  const old=(await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[id]})).rows[0];
  if(old&&old.checksum!==checksum) throw Error('Migration checksum mismatch');
  if(!old) {await tx.execute('SELECT id FROM app_projects LIMIT 1');for(const sql of ddl)await tx.execute(sql);
   await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[id,checksum,new Date().toISOString()]});}
  await tx.commit();
 } catch(e){await tx.rollback();throw e;}finally{tx.close();}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){await migrateMonitoring(await getDb());console.log(`Applied ${id}`);}
