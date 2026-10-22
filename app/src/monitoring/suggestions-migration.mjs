import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
import {transaction,one,exec} from './shared.mjs';

export const ddl=[
 `CREATE TABLE mon_suggestion_metadata(suggestion_id TEXT PRIMARY KEY REFERENCES mon_suggestions(id),payload TEXT NOT NULL)`,
 `CREATE TABLE app_competitor_drafts(project_id TEXT NOT NULL REFERENCES app_projects(id),id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(project_id,id))`,
];
export const id='app-018-intelligent-suggestions';
export const checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migrateSuggestions(db){
 await transaction(db,async tx=>{
  const old=await one(tx,'SELECT checksum FROM app_migrations WHERE id=?',[id]);
  if(old&&old.checksum!==checksum)throw Error('Migration checksum mismatch');
  if(!old){
   for(const sql of ddl)await exec(tx,sql);
   await exec(tx,'INSERT INTO app_migrations VALUES (?,?,?)',[id,checksum,new Date().toISOString()]);
  }
 });
}
export async function suggestionsReady(db){
 if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum){
  throw Object.assign(Error('APP_NOT_CONFIGURED'),{status:503,code:'APP_NOT_CONFIGURED'});
 }
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){
 await migrateSuggestions(await getDb());console.log(`Applied ${id}`);
}
