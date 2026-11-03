import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
export const id='app-026-analytics-read-indexes';
export const ddl=[
 `CREATE INDEX mon_evidence_run ON mon_evidence(run_id)`,
 `CREATE INDEX intelligence_run_analysis ON intelligence_jobs(analysis_version,run_id)`,
 `CREATE INDEX mon_runs_project_created ON mon_runs(project_id,created_at,id)`,
];
export const checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
// Explicit operator-only migration. Importing this module and serving requests
// do not alter the schema. Do not change checksums of earlier migrations.
export async function migrateAnalyticsReads(db){
 const tx=await db.transaction('write');
 try{
  const old=(await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[id]})).rows[0];
  if(old&&old.checksum!==checksum)throw Error('Analytics read migration checksum mismatch');
  if(!old){for(const sql of ddl)await tx.execute(sql);await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[id,checksum,new Date().toISOString()]});}
  await tx.commit();
 }catch(e){await tx.rollback();throw e;}finally{tx.close();}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){await migrateAnalyticsReads(await getDb());console.log(`Applied ${id}`);}
