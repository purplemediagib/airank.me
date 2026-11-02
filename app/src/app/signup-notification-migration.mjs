import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
export const migrationId='app-025-signup-owner-notifications';
export const ddl=[
 `CREATE TABLE IF NOT EXISTS app_signup_notifications (
 user_id TEXT PRIMARY KEY, snapshot_json TEXT, payload_json TEXT,
 status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL, first_attempt_at INTEGER, lease_until INTEGER,
 lease_token TEXT, sent_at INTEGER, provider_id TEXT, error_code TEXT)`,
 `CREATE INDEX IF NOT EXISTS app_signup_notifications_due ON app_signup_notifications(status,next_attempt_at)`,
 // Deliberately no SELECT/backfill: only committed, genuinely new account rows.
 // Login UPSERTs and account linking UPDATEs never fire this trigger.
 `CREATE TRIGGER IF NOT EXISTS app_signup_notification_created AFTER INSERT ON users BEGIN
 INSERT OR IGNORE INTO app_signup_notifications(user_id,snapshot_json,next_attempt_at)
 VALUES (NEW.id,json_object('id',NEW.id,'email',NEW.email,'name',NEW.display_name,
 'createdAt',NEW.created_at,'method',CASE WHEN NEW.google_sub LIKE 'email:%' THEN 'Email/password' ELSE 'Google' END),NEW.created_at);
 END`,
 // First app preferences are written in the same signup transaction. Freeze the
 // supplied locale; do not overwrite it on subsequent preference changes/logins.
 `CREATE TRIGGER IF NOT EXISTS app_signup_notification_locale AFTER INSERT ON app_preferences BEGIN
 UPDATE app_signup_notifications SET snapshot_json=json_set(snapshot_json,'$.locale',NEW.locale)
 WHERE user_id=NEW.user_id AND status='pending' AND first_attempt_at IS NULL
 AND json_type(snapshot_json,'$.locale') IS NULL;
 END`,
];
export const checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migrateSignupNotifications(db){
 const tx=await db.transaction('write');
 try{
  const old=(await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[migrationId]})).rows[0];
  if(old&&old.checksum!==checksum)throw Error('Signup notification migration checksum mismatch');
  if(!old){for(const sql of ddl)await tx.execute(sql);await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[migrationId,checksum,new Date().toISOString()]});}
  await tx.commit();
 }catch(e){await tx.rollback();throw e;}finally{tx.close();}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){await migrateSignupNotifications(await getDb());console.log(`Applied ${migrationId}`);}
