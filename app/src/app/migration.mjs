import { createHash } from 'node:crypto';
import { getDb } from '../common/db.mjs';

// Explicit additive migration; normal API startup does not invoke it.
// The release entrypoint can opt in with AIRANK_RUN_APP_MIGRATIONS=true.
export const appDDL = [
  `CREATE TABLE IF NOT EXISTS app_projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('active','archived')), version INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS app_projects_owner ON app_projects(owner_id,created_at,id)`,
  `CREATE TABLE IF NOT EXISTS app_identity_versions (project_id TEXT NOT NULL REFERENCES app_projects(id), version INTEGER NOT NULL, identity_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id,version))`,
  `CREATE TABLE IF NOT EXISTS app_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id), locale TEXT NOT NULL DEFAULT 'fi', timezone TEXT NOT NULL DEFAULT 'Europe/Helsinki', last_project_id TEXT REFERENCES app_projects(id), version INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS app_audit_events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT REFERENCES app_projects(id), kind TEXT NOT NULL, version INTEGER, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS app_oauth_states (state_hash TEXT PRIMARY KEY, code_verifier TEXT NOT NULL, nonce TEXT NOT NULL, return_to TEXT NOT NULL, client_id TEXT NOT NULL, origin TEXT NOT NULL, redirect_uri TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS app_oauth_expiry ON app_oauth_states(expires_at)`,
];
export const migrationId = 'app-001-identity-projects';
export const checksum = createHash('sha256').update(appDDL.join('\n')).digest('hex');
export async function migrateApp(db) {
  const tx = await db.transaction('write');
  try {
    await tx.execute(`CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    const previous = (await tx.execute({ sql: 'SELECT checksum FROM app_migrations WHERE id=?', args: [migrationId] })).rows[0];
    if (previous && previous.checksum !== checksum) throw new Error('Migration checksum mismatch');
    if (!previous) {
      // Fail rather than silently create a replacement identity store.
      await tx.execute('SELECT id FROM users LIMIT 1');
      for (const statement of appDDL) await tx.execute(statement);
      await tx.execute({ sql: 'INSERT INTO app_migrations VALUES (?,?,?)', args: [migrationId, checksum, new Date().toISOString()] });
    }
    await tx.commit();
  } catch (error) { await tx.rollback(); throw error; }
  finally { tx.close(); }
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await migrateApp(await getDb());
  console.log(`Applied ${migrationId}`);
}
