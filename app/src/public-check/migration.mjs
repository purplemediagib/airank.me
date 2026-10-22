import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
export const id='app-011-public-check';
export const ddl=[
 `CREATE TABLE public_check_drafts(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,payload TEXT,created_at INTEGER NOT NULL)`,
 `CREATE INDEX public_check_drafts_budget ON public_check_drafts(fingerprint,created_at)`,
 `CREATE TABLE public_check_scans(scan_id TEXT PRIMARY KEY REFERENCES scan_jobs(id),fingerprint TEXT NOT NULL,submission_id TEXT NOT NULL,input_hash TEXT NOT NULL,guest_token_cipher TEXT NOT NULL,snapshot_json TEXT,UNIQUE(fingerprint,submission_id))`,
 `CREATE TABLE public_check_deliveries(request_id TEXT PRIMARY KEY,scan_id TEXT NOT NULL REFERENCES public_check_scans(scan_id),email TEXT NOT NULL,marketing_consent INTEGER NOT NULL,consent_version TEXT NOT NULL,consent_text TEXT NOT NULL,locale TEXT NOT NULL,source TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,report_token_hash TEXT NOT NULL UNIQUE,report_token_cipher TEXT NOT NULL,status TEXT NOT NULL,marketing_status TEXT NOT NULL,provider_message_id TEXT,attempt_id TEXT NOT NULL,last_attempt_at INTEGER NOT NULL,UNIQUE(scan_id,email))`,
 `CREATE INDEX public_check_deliveries_provider ON public_check_deliveries(provider_message_id)`,
 `CREATE TABLE public_check_consents(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES public_check_deliveries(request_id),marketing_consent INTEGER NOT NULL,consent_version TEXT NOT NULL,consent_text TEXT NOT NULL,locale TEXT NOT NULL,source TEXT NOT NULL,created_at INTEGER NOT NULL)`,
 `CREATE TABLE public_check_webhooks(event_id TEXT PRIMARY KEY,provider_message_id TEXT,status TEXT,created_at INTEGER NOT NULL)`,
 `CREATE INDEX public_check_webhooks_provider ON public_check_webhooks(provider_message_id)`,
 `CREATE TABLE public_check_signup_events(session_hash TEXT PRIMARY KEY REFERENCES sessions(session_hash) ON DELETE CASCADE,pending INTEGER NOT NULL)`
];
export const checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migratePublicCheck(db){
 const tx=await db.transaction('write');
 try{
  const old=(await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[id]})).rows[0];
  if(old&&old.checksum!==checksum)throw Error('Migration checksum mismatch');
  if(!old){for(const sql of ddl)await tx.execute(sql);await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[id,checksum,new Date().toISOString()]});}
  await tx.commit();
 }catch(e){await tx.rollback();throw e;}finally{tx.close();}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){await migratePublicCheck(await getDb());console.log(`Applied ${id}`);}
