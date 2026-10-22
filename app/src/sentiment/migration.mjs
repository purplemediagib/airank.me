import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
export const ddl=[
 `CREATE TABLE sentiment_state(name TEXT PRIMARY KEY,value TEXT NOT NULL)`,
 `CREATE TABLE sentiment_jobs(evidence_id TEXT NOT NULL REFERENCES mon_evidence(id),run_id TEXT NOT NULL REFERENCES mon_runs(id),analysis_version TEXT NOT NULL,requested_model TEXT NOT NULL,input_hash TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,lease_until INTEGER,claim_token TEXT,result_json TEXT,error TEXT,PRIMARY KEY(evidence_id,analysis_version))`,
 `CREATE INDEX sentiment_queue ON sentiment_jobs(status,created_at)`,
 `CREATE INDEX sentiment_runs ON sentiment_jobs(run_id,analysis_version)`,
];
export const id='app-012-sentiment',checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migrateSentiment(db){
 const tx=await db.transaction('write');
 try{
  const old=(await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[id]})).rows[0];
  if(old&&old.checksum!==checksum)throw Error('Migration checksum mismatch');
  if(!old){await tx.execute('SELECT id FROM mon_evidence LIMIT 1');for(const sql of ddl)await tx.execute(sql);await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[id,checksum,new Date().toISOString()]});}
  await tx.commit();
 }catch(e){await tx.rollback();throw e;}finally{tx.close();}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){await migrateSentiment(await getDb());console.log(`Applied ${id}`);}
