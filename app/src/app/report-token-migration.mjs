import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';

export const ddl=[
 `CREATE TABLE app_report_tokens (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id), label TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>created_at), last_used_at INTEGER, revoked_at INTEGER)`,
 `CREATE INDEX app_report_tokens_user ON app_report_tokens(user_id,revoked_at)`,
];
export const id='app-020-report-tokens',checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migrateReportTokens(db){
 const tx=await db.transaction('write');
 try{
  const old=(await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[id]})).rows[0];
  if(old&&old.checksum!==checksum)throw Error('Migration checksum mismatch');
  if(!old){
   await tx.execute('SELECT id FROM users LIMIT 1');
   for(const sql of ddl)await tx.execute(sql);
   await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[id,checksum,new Date().toISOString()]});
  }
  await tx.commit();
 }catch(error){await tx.rollback();throw error;}finally{tx.close();}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){
 await migrateReportTokens(await getDb());console.log(`Applied ${id}`);
}
