import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
export const ddl=[
 `ALTER TABLE app_workspaces ADD COLUMN plan TEXT DEFAULT 'pro' CHECK(plan IS NULL OR plan IN ('starter','pro','advanced','custom'))`,
 `ALTER TABLE app_workspaces ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'trialing' CHECK(plan_status IN ('legacy','trialing','active','inactive'))`,
 `ALTER TABLE app_workspaces ADD COLUMN trial_started_at INTEGER`,
 `ALTER TABLE app_workspaces ADD COLUMN trial_ends_at INTEGER`,
 `ALTER TABLE app_workspaces ADD COLUMN plan_revision INTEGER NOT NULL DEFAULT 0`,
 `ALTER TABLE app_workspaces ADD COLUMN plan_updated_at INTEGER`,
 // Existing accounts retain their operator entitlements only until billing first syncs them.
 `UPDATE app_workspaces SET plan=NULL,plan_status='legacy'`,
 `CREATE TABLE app_plan_events(workspace_id TEXT NOT NULL REFERENCES app_workspaces(id), revision INTEGER NOT NULL, previous_plan TEXT, plan TEXT NOT NULL, status TEXT NOT NULL, trial_ends_at INTEGER, created_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,revision))`,
 `CREATE INDEX mon_runs_plan_frequency ON mon_runs(project_id,kind,created_at)`,
];
export const id='app-022-plan-limits',checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migratePlans(db){
 const tx=await db.transaction('write');
 try{
  const old=(await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[id]})).rows[0];
  if(old&&old.checksum!==checksum)throw Error('Migration checksum mismatch');
  if(!old){for(const sql of ddl)await tx.execute(sql);await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[id,checksum,new Date().toISOString()]});}
  await tx.commit();
 }catch(e){await tx.rollback();throw e;}finally{tx.close();}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){await migratePlans(await getDb());console.log(`Applied ${id}`);}
