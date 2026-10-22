import { getDb } from './common/db.mjs';
export const scanProfileDDL = `CREATE TABLE IF NOT EXISTS scan_profiles (scan_id TEXT PRIMARY KEY, profile_json TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(scan_id) REFERENCES scan_jobs(id))`;
const ddl = [
`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, google_sub TEXT NOT NULL UNIQUE, email TEXT NOT NULL, display_name TEXT, picture_url TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS oauth_states (state_hash TEXT PRIMARY KEY, code_verifier TEXT NOT NULL, nonce TEXT NOT NULL, return_to TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS sessions (session_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id))`,
`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
`CREATE TABLE IF NOT EXISTS scan_jobs (id TEXT PRIMARY KEY, domain TEXT NOT NULL, brand_name TEXT NOT NULL, owner_id TEXT, guest_token_hash TEXT, status TEXT NOT NULL, requested_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, lock_owner TEXT, lease_expires INTEGER, error TEXT, website_title TEXT, industry TEXT, location TEXT DEFAULT 'Finland', FOREIGN KEY(owner_id) REFERENCES users(id))`,
`CREATE INDEX IF NOT EXISTS idx_scan_jobs_pending ON scan_jobs(status, lease_expires, requested_at)`,
`CREATE INDEX IF NOT EXISTS idx_scan_jobs_owner ON scan_jobs(owner_id, requested_at)`,
`CREATE TABLE IF NOT EXISTS scan_prompts (id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, sequence INTEGER NOT NULL, prompt_text TEXT NOT NULL, prompt_version TEXT NOT NULL, intent TEXT, UNIQUE(scan_id, sequence), FOREIGN KEY(scan_id) REFERENCES scan_jobs(id))`,
`CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, prompt_id TEXT NOT NULL, provider TEXT NOT NULL, provider_status TEXT NOT NULL, model TEXT, answer_text TEXT, citations_json TEXT, own_domain_cited INTEGER NOT NULL DEFAULT 0, brand_mentioned INTEGER NOT NULL DEFAULT 0, recommended INTEGER NOT NULL DEFAULT 0, raw_storage_key TEXT, usage_json TEXT, observed_at INTEGER NOT NULL, error TEXT, UNIQUE(scan_id,prompt_id,provider), FOREIGN KEY(scan_id) REFERENCES scan_jobs(id))`,
`CREATE INDEX IF NOT EXISTS idx_observations_scan ON observations(scan_id, provider)`,
`CREATE TABLE IF NOT EXISTS provider_calls (id TEXT PRIMARY KEY, scan_id TEXT NOT NULL, provider TEXT NOT NULL, created_at INTEGER NOT NULL, estimated_cost_usd REAL)`,
`CREATE INDEX IF NOT EXISTS idx_provider_calls_date ON provider_calls(created_at)`,
`CREATE TABLE IF NOT EXISTS rate_events (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, domain TEXT NOT NULL, requested_at INTEGER NOT NULL)`,
`CREATE INDEX IF NOT EXISTS idx_rate_events_fingerprint ON rate_events(fingerprint,requested_at)`,
`CREATE INDEX IF NOT EXISTS idx_rate_events_domain ON rate_events(domain,requested_at)`
];
ddl.push(scanProfileDDL);
export const migrations = ddl;
export async function migrate(){ const db=await getDb(); for(const stmt of ddl)await db.execute(stmt); return ddl.length; }
if(process.argv[1] && import.meta.url===new URL(`file://${process.argv[1]}`).href){migrate().then(n=>{console.log(JSON.stringify({migration:'ok',statements:n}));process.exit(0)}).catch(e=>{console.error('Migration failed:',e.message);process.exit(1)})}
