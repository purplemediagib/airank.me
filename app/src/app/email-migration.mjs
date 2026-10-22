import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';

export const migrationId = 'app-010-email-auth';
export const ddl = [
  `CREATE TABLE IF NOT EXISTS app_email_credentials (email TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), password_hash TEXT NOT NULL, verified_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS app_email_challenges (id TEXT PRIMARY KEY, kind TEXT NOT NULL, email TEXT NOT NULL, name TEXT, password_hash TEXT, locale TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS app_email_challenge_expiry ON app_email_challenges(expires_at)`,
  `CREATE TABLE IF NOT EXISTS app_auth_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
];
export const checksum = createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migrateEmailAuth(db) {
  const tx = await db.transaction('write');
  try {
    const prior = (await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[migrationId]})).rows[0];
    if (prior && prior.checksum !== checksum) throw new Error('Email authentication migration checksum mismatch');
    if (!prior) {
      for (const sql of ddl) await tx.execute(sql);
      await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[migrationId,checksum,new Date().toISOString()]});
    }
    await tx.commit();
  } catch (e) { await tx.rollback(); throw e; } finally { tx.close(); }
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await migrateEmailAuth(await getDb());
  console.log(`Applied ${migrationId}`);
}
