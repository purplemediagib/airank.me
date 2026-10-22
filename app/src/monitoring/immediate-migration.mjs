import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
import {transaction,one,exec} from './shared.mjs';

// Triggers cover every tracked-prompt insertion path, including onboarding.
// No INSERT SELECT/backfill: only mutations after this migration produce work.
export const ddl=[
 `CREATE TABLE mon_immediate_outbox(prompt_id TEXT NOT NULL REFERENCES mon_prompts(id),fingerprint TEXT NOT NULL,project_id TEXT NOT NULL REFERENCES app_projects(id),state TEXT NOT NULL DEFAULT 'pending',run_id TEXT REFERENCES mon_runs(id),reason TEXT,created_at INTEGER NOT NULL,checked_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(prompt_id,fingerprint))`,
 `CREATE INDEX mon_immediate_pending ON mon_immediate_outbox(state,created_at)`,
 `CREATE TRIGGER mon_immediate_insert AFTER INSERT ON mon_prompts WHEN NEW.status='active' BEGIN
 INSERT OR IGNORE INTO mon_immediate_outbox(prompt_id,fingerprint,project_id,created_at) VALUES(NEW.id,NEW.hash,NEW.project_id,NEW.created_at); END`,
 `CREATE TRIGGER mon_immediate_update AFTER UPDATE ON mon_prompts WHEN NEW.status='active' AND (OLD.status<>'active' OR OLD.hash<>NEW.hash) BEGIN
 INSERT INTO mon_immediate_outbox(prompt_id,fingerprint,project_id,created_at) VALUES(NEW.id,NEW.hash,NEW.project_id,CAST(strftime('%s','now') AS INTEGER)*1000)
 ON CONFLICT(prompt_id,fingerprint) DO UPDATE SET state='pending',reason=NULL WHERE mon_immediate_outbox.state='cancelled'; END`,
];
export const id='app-016-immediate-tracked-collection';
export const checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migrateImmediate(db){
 await transaction(db,async tx=>{
  const old=await one(tx,'SELECT checksum FROM app_migrations WHERE id=?',[id]);
  if(old&&old.checksum!==checksum)throw Error('Migration checksum mismatch');
  if(!old){
   for(const sql of ddl)await exec(tx,sql);
   await exec(tx,'INSERT INTO app_migrations VALUES (?,?,?)',[id,checksum,new Date().toISOString()]);
  }
 });
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){
 await migrateImmediate(await getDb());console.log(`Applied ${id}`);
}
