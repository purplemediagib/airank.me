import { createHash } from 'node:crypto';
import { getDb } from '../common/db.mjs';
export const scanDDL = `CREATE TABLE IF NOT EXISTS app_project_scans (
 scan_id TEXT PRIMARY KEY REFERENCES scan_jobs(id),
 project_id TEXT NOT NULL REFERENCES app_projects(id),
 project_version INTEGER NOT NULL,
 owner_id TEXT NOT NULL REFERENCES users(id),
 submission_id TEXT NOT NULL,
 preview_hash TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 UNIQUE(owner_id,submission_id),
 FOREIGN KEY(project_id,project_version) REFERENCES app_identity_versions(project_id,version))`;
export const scanMigrationId = 'app-002-project-scans';
export const scanChecksum = createHash('sha256').update(scanDDL).digest('hex');
export async function migrateProjectScans(db) {
 const tx = await db.transaction('write');
 try {
  const old = (await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[scanMigrationId]})).rows[0];
  if(old && old.checksum!==scanChecksum) throw new Error('Migration checksum mismatch');
  if(!old) {
   await tx.execute('SELECT id FROM app_projects LIMIT 1');
   await tx.execute('SELECT scan_id FROM scan_profiles LIMIT 1');
   await tx.execute(scanDDL);
   await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[scanMigrationId,scanChecksum,new Date().toISOString()]});
  }
  await tx.commit();
 } catch(e) {await tx.rollback();throw e;} finally {tx.close();}
}
if(process.argv[1] && import.meta.url===new URL(`file://${process.argv[1]}`).href) {
 await migrateProjectScans(await getDb());console.log(`Applied ${scanMigrationId}`);
}
