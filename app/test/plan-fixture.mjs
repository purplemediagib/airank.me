import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {migrations} from '../src/migrate.mjs';
import {migratePlans} from '../src/app/plan-migration.mjs';
import {createAppService,csrfFor} from '../src/app/service.mjs';
import {hashToken} from '../src/common/utils.mjs';
import {fixtureBudgetConfig} from './api-budget-fixture.mjs';
export const identity={brandName:'Example',aliases:[],ownedDomains:['example.com'],categoryFi:'marketing software',market:'US',promptLanguage:'en'};
export const providers=['openai','claude','gemini','grok','deepseek','mistral'];
export const secret='offline-billing-fixture-0123456789abcdef';
export const prompt=text=>({text,kind:'neutral',topic:'Tools',tags:[]});
export async function planFixture({migrate=true}={}){
 const sql=new DatabaseSync(':memory:');sql.exec('PRAGMA foreign_keys=ON');for(const q of migrations)sql.exec(q);
 let clock=Date.parse('2026-10-28T12:00:00Z'),lock=Promise.resolve();
 const execute=async q=>{const s=sql.prepare(q.sql||q),args=q.args||[];if(s.columns().length)return {rows:s.all(...args)};return {rows:[],rowsAffected:Number(s.run(...args).changes)};};
 const db={execute,transaction:async()=>{const prev=lock;let unlock;lock=new Promise(r=>unlock=r);await prev;sql.exec('BEGIN IMMEDIATE');return {execute,commit:async()=>sql.exec('COMMIT'),rollback:async()=>sql.exec('ROLLBACK'),close:()=>unlock()};}};
 const startup=readFileSync(new URL('../src/app/start-release.mjs',import.meta.url),'utf8'),imported=new Map();
 for(const m of startup.matchAll(/const \{(migrate\w+)\}=await import\('([^']+)'\)/g))imported.set(m[1],m[2]);
 for(const m of startup.matchAll(/await (migrate\w+)\(db\)/g))if(m[1]!=='migratePlans'){const mod=await import(new URL(imported.get(m[1]),new URL('../src/app/start-release.mjs',import.meta.url)));await mod[m[1]](db);}
 for(const user of ['alice','bob','member','viewer','old']){
  const created=clock-(user==='old'?30*86400000:0);
  sql.prepare('INSERT INTO users(id,google_sub,email,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(user,user,user+'@example.test',user,created,created);
  sql.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hashToken('session-'+user),user,clock+365*86400000,clock);
 }
 sql.prepare('INSERT INTO app_workspaces VALUES(?,?,?,?)').run('ws_legacy','old','Legacy',clock-86400000);
 sql.prepare('INSERT INTO app_projects(id,owner_id,status,version,created_at,workspace_id) VALUES(?,?,?,?,?,?)').run('legacy','old','active',1,new Date(clock).toISOString(),'ws_legacy');
 sql.prepare('INSERT INTO app_identity_versions VALUES(?,?,?,?)').run('legacy',1,JSON.stringify(identity),new Date(clock).toISOString());
 if(migrate)await migratePlans(db);
 const env={BILLING_SHARED_SECRET:secret,TRACKED_PROMPT_LIMIT:'55',MONITORING_ENABLED:'true',PROJECT_SCHEDULER_ENABLED:'true',ENABLED_PROVIDERS:providers.join(','),OPENROUTER_MODELS_JSON:JSON.stringify({deepseek:'deepseek/fixture',mistral:'mistralai/fixture'}),OPENAI_API_KEY:'fixture',ANTHROPIC_API_KEY:'fixture',OPENROUTER_API_KEY:'fixture',XAI_API_KEY:'fixture'};
 env.API_BUDGET_CONFIG_JSON=fixtureBudgetConfig(env);
 const origin='https://app.example.test';
 const service=createAppService({db,clients:{preview:{origin,redirectUri:origin+'/api/airank/v1/app/google/callback'}},env,now:()=>clock});
 const call=(method,path,body={},user='alice',extra={})=>service({method,path,body,headers:{'x-airank-client':'preview',origin,'content-type':'application/json',cookie:'__Host-airank_session=session-'+user,'x-csrf-token':csrfFor('session-'+user),...extra}});
 const create=async(user='alice')=>(await call('POST','/v1/projects',identity,user)).data;
 const push=(ws,plan,revision=1,status='active',extra={})=>service({method:'POST',path:`/v1/internal/workspaces/${ws}/plan`,headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:{plan,revision,status,...extra}});
 const add=async(p,text='Which email tools suit small businesses?',user='alice')=>(await call('POST',`/v1/projects/${p}/prompts`,prompt(text),user)).data;
 const seed=(p,n,start=0)=>{for(let i=start;i<start+n;i++){
  const id=p+'-prompt-'+i,value={...prompt('Which marketing tools suit business number '+i+'?'),status:'active',market:'US',language:'en'};
  sql.prepare('INSERT INTO mon_prompts VALUES(?,?,?,?,?,?)').run(id,p,1,'active','hash-'+i,clock);
  sql.prepare('INSERT INTO mon_prompt_versions VALUES(?,?,?,?)').run(id,1,JSON.stringify(value),clock);
 }};
 return {sql,db,env,service,call,create,push,add,seed,now:()=>clock,advance:ms=>clock+=ms,setNow:t=>clock=t,close:()=>sql.close()};
}
