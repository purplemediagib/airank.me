import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';
import {transaction,one,exec} from '../monitoring/shared.mjs';
export const ddl=[
 `CREATE TABLE content_records(project_id TEXT NOT NULL REFERENCES app_projects(id),kind TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(project_id,kind,id))`,
 `CREATE TABLE content_revisions(project_id TEXT NOT NULL,document_id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,actor TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(project_id,document_id,version))`,
 `CREATE TABLE content_jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES app_projects(id),actor TEXT NOT NULL,submission_id TEXT NOT NULL,input_hash TEXT NOT NULL,kind TEXT NOT NULL,input TEXT NOT NULL,status TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,lease_until INTEGER,claim_token TEXT,checkpoint TEXT NOT NULL DEFAULT '{}',result TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(project_id,submission_id))`,
 `CREATE INDEX content_queue ON content_jobs(status,available_at,created_at)`,
 `CREATE TABLE content_members(project_id TEXT NOT NULL REFERENCES app_projects(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL CHECK(role IN ('viewer','editor','reviewer')),PRIMARY KEY(project_id,user_id))`,
 `CREATE TABLE content_events(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,actor TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL)`,
 `CREATE INDEX content_event_project ON content_events(project_id,created_at)`,
 `CREATE TABLE content_usage(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,job_id TEXT NOT NULL,day TEXT NOT NULL,status TEXT NOT NULL,reserved_usd REAL NOT NULL,actual_usd REAL,prompt_tokens INTEGER,completion_tokens INTEGER,model TEXT,created_at INTEGER NOT NULL)`,
 `CREATE INDEX content_usage_day ON content_usage(day,project_id)`,
 `CREATE TABLE content_cms(project_id TEXT PRIMARY KEY REFERENCES app_projects(id),version INTEGER NOT NULL,secret TEXT NOT NULL,summary TEXT NOT NULL)`,
];
export const id='app-019-content-studio',checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');
export async function migrateContent(db){await transaction(db,async tx=>{
 const old=await one(tx,'SELECT checksum FROM app_migrations WHERE id=?',[id]);
 if(old){if(old.checksum!==checksum)throw Error('Content migration checksum mismatch');return;}
 await exec(tx,'SELECT id FROM app_projects LIMIT 1');
 for(const sql of ddl)await exec(tx,sql);
 await exec(tx,'INSERT INTO app_migrations VALUES (?,?,?)',[id,checksum,new Date().toISOString()]);
});}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){await migrateContent(await getDb());console.log('Applied '+id);}
