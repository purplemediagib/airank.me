import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
export const ddl=[
 `CREATE TABLE app_workspaces(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, created_at INTEGER NOT NULL)`,
 `CREATE UNIQUE INDEX app_workspaces_owner ON app_workspaces(owner_id)`,
 `CREATE TABLE app_workspace_members(workspace_id TEXT NOT NULL REFERENCES app_workspaces(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('admin','member','viewer')), created_at INTEGER NOT NULL, PRIMARY KEY(workspace_id,user_id))`,
 `CREATE INDEX app_workspace_members_user ON app_workspace_members(user_id,workspace_id)`,
 `CREATE TABLE app_project_guests(project_id TEXT NOT NULL REFERENCES app_projects(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('admin','member','viewer')), created_at INTEGER NOT NULL, PRIMARY KEY(project_id,user_id))`,
 `CREATE INDEX app_project_guests_user ON app_project_guests(user_id,project_id)`,
 `CREATE TABLE app_invites(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL REFERENCES app_workspaces(id), email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member','viewer')), scope TEXT NOT NULL CHECK(scope IN ('workspace','project')), project_ids_json TEXT NOT NULL DEFAULT '[]', invited_by TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accepted_at INTEGER, revoked_at INTEGER)`,
 `CREATE INDEX app_invites_workspace ON app_invites(workspace_id,email)`,
 `CREATE TABLE app_team_audit(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES app_workspaces(id), actor_id TEXT NOT NULL REFERENCES users(id), target_user_id TEXT, target_email TEXT, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL)`,
 `CREATE INDEX app_team_audit_rate ON app_team_audit(workspace_id,kind,created_at)`,
 `CREATE TABLE app_report_token_revocations(token_id TEXT NOT NULL REFERENCES app_report_tokens(id), project_id TEXT NOT NULL REFERENCES app_projects(id), revoked_at INTEGER NOT NULL, PRIMARY KEY(token_id,project_id))`,
 `ALTER TABLE app_projects ADD COLUMN workspace_id TEXT REFERENCES app_workspaces(id)`,
 `CREATE INDEX app_projects_workspace ON app_projects(workspace_id)`,
 `INSERT INTO app_workspaces SELECT 'ws_'||u.id,u.id,COALESCE((SELECT json_extract(v.identity_json,'$.brandName') FROM app_projects p JOIN app_identity_versions v ON v.project_id=p.id AND v.version=p.version WHERE p.owner_id=u.id ORDER BY p.created_at,p.id LIMIT 1),u.email),strftime('%s','now')*1000 FROM users u WHERE EXISTS(SELECT 1 FROM app_projects p WHERE p.owner_id=u.id)`,
 `UPDATE app_projects SET workspace_id='ws_'||owner_id WHERE workspace_id IS NULL`,
 `INSERT OR IGNORE INTO app_project_guests SELECT project_id,user_id,CASE role WHEN 'viewer' THEN 'viewer' ELSE 'member' END,strftime('%s','now')*1000 FROM content_members`,
];
export const id='app-021-teams',checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migrateTeams(db){
 const tx=await db.transaction('write');
 try{
  const old=(await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[id]})).rows[0];
  if(old&&old.checksum!==checksum)throw Error('Migration checksum mismatch');
  if(!old){for(const sql of ddl)await tx.execute(sql);await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[id,checksum,new Date().toISOString()]});}
  await tx.commit();
 }catch(e){await tx.rollback();throw e;}finally{tx.close();}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){await migrateTeams(await getDb());console.log(`Applied ${id}`);}
