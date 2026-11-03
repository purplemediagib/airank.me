import {createHash} from 'node:crypto';
import {getDb} from '../common/db.mjs';

// Operator-only, additive read-model schema. Neither importing this module nor
// serving dashboard reads applies it. Existing migration checksums stay intact.
export const id='app-027-analytics-summary-read-model';

// Keep ownership lookups inside each source-writing transaction. Updating both
// OLD and NEW owners also invalidates moves between runs, prompts, or projects.
// Conservative UPDATE triggers include actual status/lease-only changes, but
// skip no-ops. Annotation workers can repeatedly store the same blocked error.
// Invalidating those no-ops would keep an otherwise idle project perpetually stale.
const columns={
 app_projects: 'id owner_id status version created_at',
 app_identity_versions: 'project_id version identity_json created_at',
 app_audit_events: 'id user_id project_id kind version created_at',
 app_project_scans: 'scan_id project_id project_version owner_id submission_id preview_hash created_at',
 mon_runs: 'id project_id owner_id submission_id request_hash kind status snapshot expected created_at deadline_at reason',
 mon_tasks: 'id run_id prompt_id prompt_version text provider route status lease_until claim_token',
 mon_evidence: 'id run_id payload observed_at',
 mon_prompts: 'id project_id version status hash created_at',
 mon_prompt_versions: 'prompt_id version payload created_at',
 intelligence_reviews: 'project_id kind key value updated_at',
 app_migrations: 'id checksum applied_at',
};
columns.sentiment_jobs=columns.intelligence_jobs='evidence_id run_id analysis_version requested_model input_hash status created_at started_at finished_at lease_until claim_token result_json error';
const changed=table=>columns[table].split(' ').map(column=>`OLD.${column} IS NOT NEW.${column}`).join(' OR ');
const bump=selection=>`INSERT INTO analytics_project_revisions(project_id,revision)
 SELECT id,1 FROM app_projects WHERE id IN (${selection})
 ON CONFLICT(project_id) DO UPDATE SET revision=analytics_project_revisions.revision+1;`;
const scoped=(table,owner)=>['INSERT','UPDATE','DELETE'].map(action=>{
 const rows=action==='INSERT'?['NEW']:action==='DELETE'?['OLD']:['OLD','NEW'];
 const selection=rows.map(row=>owner(row)).join(' UNION ');
 return `CREATE TRIGGER analytics_revision_${table}_${action.toLowerCase()}
 AFTER ${action} ON ${table}${action==='UPDATE'?` WHEN ${changed(table)}`:''} BEGIN ${bump(selection)} END`;
});
const direct=row=>`SELECT ${row}.project_id`;
const runOwner=row=>`SELECT project_id FROM mon_runs WHERE id=${row}.run_id`;
const promptOwner=row=>`SELECT project_id FROM mon_prompts WHERE id=${row}.prompt_id`;
const global=(table,when=()=>null)=>['INSERT','UPDATE','DELETE'].map(action=>{
 const condition=[when(action),action==='UPDATE'?changed(table):null].filter(Boolean).map(c=>`(${c})`).join(' AND ');
 return `CREATE TRIGGER analytics_revision_${table}_${action.toLowerCase()}
 AFTER ${action} ON ${table}${condition?` WHEN ${condition}`:''} BEGIN ${bump('SELECT id FROM app_projects')} END`;
});

export const ddl=[
 `CREATE TABLE analytics_project_revisions(project_id TEXT PRIMARY KEY REFERENCES app_projects(id) ON DELETE CASCADE,revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=1 AND revision<=9007199254740991))`,
 `CREATE TABLE analytics_summary_requests(
 project_id TEXT NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE,query_key TEXT NOT NULL,query_json TEXT NOT NULL,format_version TEXT NOT NULL,
 requested_at INTEGER NOT NULL,last_requested_at INTEGER NOT NULL,lease_token TEXT,lease_until INTEGER,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),next_attempt_at INTEGER NOT NULL DEFAULT 0,last_error TEXT,failed_revision INTEGER,
 PRIMARY KEY(project_id,query_key))`,
 `CREATE INDEX analytics_summary_requests_queue ON analytics_summary_requests(next_attempt_at,lease_until,last_requested_at,project_id)`,
 `CREATE TABLE analytics_summary_generations(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE,query_key TEXT NOT NULL,
 source_revision INTEGER NOT NULL,format_version TEXT NOT NULL,generated_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
 evidence_count INTEGER NOT NULL CHECK(evidence_count>=0),summary_json TEXT NOT NULL,published_at INTEGER,
 UNIQUE(project_id,query_key,id),FOREIGN KEY(project_id,query_key) REFERENCES analytics_summary_requests(project_id,query_key) ON DELETE CASCADE)`,
 `CREATE INDEX analytics_summary_generations_expiry ON analytics_summary_generations(expires_at,id)`,
 `CREATE INDEX analytics_summary_generations_project_query ON analytics_summary_generations(project_id,query_key,generated_at)`,
 `CREATE TABLE analytics_summary_heads(
 project_id TEXT NOT NULL REFERENCES app_projects(id) ON DELETE CASCADE,query_key TEXT NOT NULL,generation_id TEXT NOT NULL,
 PRIMARY KEY(project_id,query_key),FOREIGN KEY(project_id,query_key,generation_id) REFERENCES analytics_summary_generations(project_id,query_key,id) ON DELETE CASCADE)`,
 `CREATE INDEX analytics_summary_heads_generation ON analytics_summary_heads(generation_id)`,
 `CREATE TABLE analytics_summary_payloads(
 hash TEXT PRIMARY KEY,payload TEXT NOT NULL,search_text TEXT NOT NULL,brands_json TEXT NOT NULL,
 mentioned INTEGER NOT NULL,recommended INTEGER NOT NULL,cited INTEGER NOT NULL,ordered INTEGER NOT NULL,first_rank INTEGER NOT NULL,excluded INTEGER NOT NULL)`,
 `CREATE TABLE analytics_summary_evidence(
 generation_id TEXT NOT NULL REFERENCES analytics_summary_generations(id) ON DELETE CASCADE,position INTEGER NOT NULL CHECK(position>=0),id TEXT NOT NULL,
 payload_hash TEXT NOT NULL REFERENCES analytics_summary_payloads(hash),
 PRIMARY KEY(generation_id,position),UNIQUE(generation_id,id))`,
 `CREATE INDEX analytics_summary_evidence_payload ON analytics_summary_evidence(payload_hash)`,
 // Manual cleanup also works for connections with foreign_keys disabled, which
 // legacy schemas may use. Do not rely on recursive_triggers being enabled.
 `CREATE TRIGGER analytics_summary_delete_generation AFTER DELETE ON analytics_summary_generations BEGIN
 DELETE FROM analytics_summary_evidence WHERE generation_id=OLD.id;
 DELETE FROM analytics_summary_heads WHERE generation_id=OLD.id; END`,
 `CREATE TRIGGER analytics_summary_delete_request AFTER DELETE ON analytics_summary_requests BEGIN
 DELETE FROM analytics_summary_heads WHERE project_id=OLD.project_id AND query_key=OLD.query_key;
 DELETE FROM analytics_summary_evidence WHERE generation_id IN (SELECT id FROM analytics_summary_generations WHERE project_id=OLD.project_id AND query_key=OLD.query_key);
 DELETE FROM analytics_summary_generations WHERE project_id=OLD.project_id AND query_key=OLD.query_key; END`,
 `CREATE TRIGGER analytics_summary_delete_project AFTER DELETE ON app_projects BEGIN
 DELETE FROM analytics_summary_heads WHERE project_id=OLD.id;
 DELETE FROM analytics_summary_evidence WHERE generation_id IN (SELECT id FROM analytics_summary_generations WHERE project_id=OLD.id);
 DELETE FROM analytics_summary_generations WHERE project_id=OLD.id;
 DELETE FROM analytics_summary_requests WHERE project_id=OLD.id;
 DELETE FROM analytics_project_revisions WHERE project_id=OLD.id; END`,
 ...['INSERT','UPDATE'].map(action=>`CREATE TRIGGER analytics_revision_app_projects_${action.toLowerCase()}
 AFTER ${action} ON app_projects${action==='UPDATE'?` WHEN ${changed('app_projects')}`:''} BEGIN ${bump(`SELECT NEW.id${action==='UPDATE'?' UNION SELECT OLD.id':''}`)} END`),
 ...['app_identity_versions','app_audit_events','app_project_scans','mon_runs','mon_prompts',
     'intelligence_reviews'].flatMap(table=>scoped(table,direct)),
 ...['mon_tasks','mon_evidence','sentiment_jobs','intelligence_jobs'].flatMap(table=>scoped(table,runOwner)),
 ...scoped('mon_prompt_versions',promptOwner),
 // Intelligence availability depends on its exact historical migration record.
 // Other migrations do not change canonical analytics output merely by running.
 ...global('app_migrations',action=>{
  const rows=action==='INSERT'?['NEW']:action==='DELETE'?['OLD']:['OLD','NEW'];
  return rows.map(row=>`${row}.id='app-015-evidence-intelligence'`).join(' OR ');
 }),
 `INSERT INTO analytics_project_revisions(project_id,revision) SELECT id,1 FROM app_projects`,
];
export const checksum=createHash('sha256').update(ddl.join('\n')).digest('hex');

export async function migrateAnalyticsSummary(db){
 const tx=await db.transaction('write');
 try{
  const old=(await tx.execute({sql:'SELECT checksum FROM app_migrations WHERE id=?',args:[id]})).rows[0];
  if(old&&old.checksum!==checksum)throw Error('Analytics summary migration checksum mismatch');
  if(!old){
   for(const sql of ddl)await tx.execute(sql);
   await tx.execute({sql:'INSERT INTO app_migrations VALUES (?,?,?)',args:[id,checksum,new Date().toISOString()]});
  }
  await tx.commit();
 }catch(error){await tx.rollback();throw error;}finally{tx.close();}
}

if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){
 await migrateAnalyticsSummary(await getDb());console.log(`Applied ${id}`);
}
