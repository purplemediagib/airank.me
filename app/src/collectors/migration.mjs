import {createHash} from 'node:crypto';
export const ddl=[
 `CREATE TABLE mon_collections(task_id TEXT PRIMARY KEY REFERENCES mon_tasks(id),remote_id TEXT,phase TEXT NOT NULL,reserved_usd REAL NOT NULL,reserved_at INTEGER NOT NULL,next_poll_at INTEGER NOT NULL,raw_json TEXT,meta_json TEXT NOT NULL)`,
 `CREATE INDEX mon_collection_poll ON mon_collections(phase,next_poll_at)`,
];
export const id='app-014-consumer-collectors',checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migrateCollectors(db){
 const tx=await db.transaction('write');
 try{
  const old=(await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[id]})).rows[0];
  if(old&&old.checksum!==checksum)throw Error('Migration checksum mismatch');
  if(!old){for(const sql of ddl)await tx.execute(sql);await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[id,checksum,new Date().toISOString()]});}
  await tx.commit();
 }catch(e){await tx.rollback();throw e;}finally{tx.close();}
}
