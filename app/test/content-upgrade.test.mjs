import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {migrations} from '../src/migrate.mjs';
import {migrateContent,id} from '../src/content/migration.mjs';
import {googleReport} from '../src/content/google.mjs';
import {analyticsService} from '../src/analytics/service.mjs';
import {runJob} from '../src/content/engine.mjs';

test('0.21 migration sequence upgrades additively and content can read current analytics',async()=>{
 const sql=new DatabaseSync(':memory:');
 const execute=async q=>{const s=sql.prepare(q.sql||q),args=q.args||[];return /^\s*SELECT|RETURNING/i.test(q.sql||q)?{rows:s.all(...args)}:{rows:[],rowsAffected:Number(s.run(...args).changes)};};
 const db={execute,transaction:async()=>{sql.exec('BEGIN');return {execute,commit:async()=>sql.exec('COMMIT'),rollback:async()=>sql.exec('ROLLBACK'),close(){}};}};
 try{
  for(const s of migrations)sql.exec(s);
  const startup=readFileSync(new URL('../src/app/start-release.mjs',import.meta.url),'utf8');
  const imported=new Map();
  for(const m of startup.matchAll(/const \{(migrate\w+)\}=await import\('([^']+)'\)/g))imported.set(m[1],m[2]);
  const calls=[...startup.matchAll(/await (migrate\w+)\(db\)/g)].map(x=>x[1]);
  assert.equal(calls.at(-1),'migrateContent');assert.equal(id,'app-019-content-studio');
  for(const name of calls){if(name==='migrateContent')continue;const module=await import(new URL(imported.get(name),new URL('../src/app/start-release.mjs',import.meta.url)));await module[name](db);}
  const before=sql.prepare('SELECT id,checksum FROM app_migrations ORDER BY id').all();assert.equal(before.length,18);
  sql.prepare('INSERT INTO users(id,google_sub,email,created_at,updated_at) VALUES (?,?,?,?,?)').run('alice','sub','alice@example.test',1,1);
  sql.prepare('INSERT INTO app_projects VALUES (?,?,?,?,?)').run('project','alice','active',1,1);
  sql.prepare('INSERT INTO app_identity_versions VALUES (?,?,?,?)').run('project',1,JSON.stringify({brandName:'Example',ownedDomains:['example.test']}),1);
  await migrateContent(db);await migrateContent(db);
  assert.deepEqual(sql.prepare("SELECT id,checksum FROM app_migrations WHERE id<>? ORDER BY id").all(id),before);
  const a=await analyticsService({db,path:'/v1/projects/project/analytics',userId:'alice',env:{}});assert.ok(Array.isArray(a.data.evidence));
  let received;
  await runJob({db,job:{id:'job',project_id:'project',actor:'alice',kind:'research'},input:{locale:'en',topic:'Example'},env:{},step:async(_key,fn)=>fn(),commit:fn=>fn(db),generateFn:async({input})=>{received=input;return {output:{}};}});
  assert.equal(received.brand.brandName,'Example');assert.deepEqual(received.evidence,[]);
 }finally{sql.close();}
});

test('Content Studio reuses 0.21 project-based Google connections without manual mapping',async()=>{
 const r=await googleReport({projectId:'stored-project',service:'gsc',view:'pages',startDate:'2026-01-01',endDate:'2026-01-02',env:{GOOGLE_CONNECTOR_BASE_URL:'https://connector.example.test',GOOGLE_CONNECTOR_API_KEY:'fixture'},fetchFn:async(url,o)=>{
  assert.equal(o.headers['X-AIRank-Workspace-ID'],'stored-project');assert.match(url.pathname,/stored-project/);
  return Response.json({rows:[],nextOffset:null,missingDates:[],metadata:[]});
 }});assert.equal(r.state,'available');
});
