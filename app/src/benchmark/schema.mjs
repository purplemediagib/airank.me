export const schema = [
`CREATE TABLE IF NOT EXISTS bm_industries(id TEXT PRIMARY KEY,name TEXT NOT NULL)`,
`CREATE TABLE IF NOT EXISTS bm_panels(id TEXT PRIMARY KEY,industry_id TEXT NOT NULL,version TEXT NOT NULL,dataset_json TEXT NOT NULL,dataset_hash TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(industry_id,version))`,
`CREATE TABLE IF NOT EXISTS bm_brands(panel_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,domain TEXT NOT NULL,aliases_json TEXT NOT NULL,PRIMARY KEY(panel_id,id))`,
`CREATE TABLE IF NOT EXISTS bm_prompts(panel_id TEXT NOT NULL,id TEXT NOT NULL,text TEXT NOT NULL,intent TEXT NOT NULL,PRIMARY KEY(panel_id,id))`,
`CREATE TABLE IF NOT EXISTS bm_schedules(panel_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS bm_runs(id TEXT PRIMARY KEY,panel_id TEXT NOT NULL,slot TEXT NOT NULL,created_at INTEGER NOT NULL,finished_at INTEGER,status TEXT NOT NULL,snapshot_json TEXT NOT NULL,UNIQUE(panel_id,slot))`,
`CREATE TABLE IF NOT EXISTS bm_jobs(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,prompt_id TEXT NOT NULL,provider TEXT NOT NULL,state TEXT NOT NULL,lease_until INTEGER,owner TEXT,result_json TEXT,observed_at INTEGER,storage_key TEXT,storage_hash TEXT,storage_error TEXT,error TEXT,UNIQUE(run_id,prompt_id,provider))`,
`CREATE INDEX IF NOT EXISTS bm_jobs_pending ON bm_jobs(state,lease_until)`,
`CREATE TABLE IF NOT EXISTS bm_attempts(job_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,provider TEXT NOT NULL,created_at INTEGER NOT NULL)`,
`CREATE INDEX IF NOT EXISTS bm_attempts_date ON bm_attempts(created_at)`,
`CREATE TABLE IF NOT EXISTS bm_mentions(job_id TEXT NOT NULL,brand_id TEXT NOT NULL,mentioned INTEGER NOT NULL,domain_cited INTEGER NOT NULL,matched_alias TEXT,PRIMARY KEY(job_id,brand_id))`,
`CREATE TABLE IF NOT EXISTS bm_citations(job_id TEXT NOT NULL,url TEXT NOT NULL,title TEXT,host TEXT,PRIMARY KEY(job_id,url))`
];
export async function migrateBenchmark(db){for(const sql of schema)await db.execute(sql);}
