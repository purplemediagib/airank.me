import {DatabaseSync} from 'node:sqlite';
import {migrations} from '../src/migrate.mjs';
import {migrateApp} from '../src/app/migration.mjs';
import {migrateMonitoring} from '../src/monitoring/migration.mjs';
import {migrateProjectScans} from '../src/app/scan-migration.mjs';
import {migrateCollectors} from '../src/collectors/migration.mjs';
import {monitoringService} from '../src/monitoring/service.mjs';
export async function collectorFixture(overrides={}){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');for(const sql of migrations)sqlite.exec(sql);
 const execute=async q=>{const sql=typeof q==='string'?q:q.sql,args=typeof q==='string'?[]:q.args||[],s=sqlite.prepare(sql);return /^\s*(SELECT|PRAGMA)|RETURNING/i.test(sql)?{rows:s.all(...args)}:{rows:[],rowsAffected:Number(s.run(...args).changes)};};
 let tail=Promise.resolve();const db={execute,transaction:async()=>{let release;const next=new Promise(r=>release=r),prior=tail;tail=next;await prior;sqlite.exec('BEGIN IMMEDIATE');return {execute,commit:async()=>sqlite.exec('COMMIT'),rollback:async()=>sqlite.exec('ROLLBACK'),close:release};}};
 sqlite.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?)').run('alice','google-test','alice@example.test','Test','',1,1);
 await migrateApp(db);await migrateProjectScans(db);await migrateMonitoring(db);await migrateCollectors(db);
 sqlite.prepare('INSERT INTO app_projects VALUES (?,?,?,?,?)').run('project','alice','active',1,1);
 sqlite.prepare('INSERT INTO app_identity_versions VALUES (?,?,?,?)').run('project',1,JSON.stringify({brandName:'Example',aliases:[],ownedDomains:['example.com'],categoryFi:'marketing software',market:'US',promptLanguage:'en'}),1);
 const env={TRACKED_PROMPT_LIMIT:'10',MONITORING_ENABLED:'true',ENABLED_PROVIDERS:'grok',CONSUMER_COLLECTION_PROVIDERS:'grok',CONSUMER_COLLECTION_ENABLED:'true',CONSUMER_MAX_DAILY_COST_USD:'1',CONSUMER_UNIT_COSTS_JSON:'{"grok":0.01}',SCRAPELESS_API_TOKEN:'test-only-not-a-real-key',...overrides};
 let clock=Date.now();const now=()=>clock;
 const api=(method,suffix,body,userId='alice',query)=>monitoringService({db,method,path:'/v1/projects/project/'+suffix,body,userId,query,env,now});
 await api('POST','prompts',{text:'Which marketing tools suit a small business?',topic:'Marketing',tags:['test'],kind:'neutral'});
 const run=()=>api('POST','monitoring-runs',{kind:'neutral',submissionId:crypto.randomUUID()});
 return {db,sqlite,env,now,api,run,advance:n=>clock+=n,close:()=>sqlite.close()};
}
