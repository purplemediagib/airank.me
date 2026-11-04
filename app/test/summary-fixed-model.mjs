import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {ddl} from '../src/analytics/summary-migration.mjs';
import {CLOCK_SQL,LEASE_MS} from '../src/analytics/summary-plans.mjs';
import {classify} from '../src/analytics/summary-transport.mjs';
const encode=v=>v===null?{type:'null'}:typeof v==='string'?{type:'text',value:v}:{type:'integer',value:String(v)};
const decode=v=>v.type==='null'?null:v.type==='integer'?BigInt(v.value):v.value;
const condition=(c,r)=>!c?true:c.type==='ok'?r[c.step]!==null:c.type==='not'?!condition(c.cond,r):c.type==='and'?c.conds.every(x=>condition(x,r)):(()=>{throw Error('unsupported condition')})();
export function fixture({foreignKeys=true}={}){
 const dir=mkdtempSync('/tmp/summary-fixed-fixture-'),path=join(dir,'proof.sqlite');
 const db=new DatabaseSync(path);db.exec(`PRAGMA foreign_keys=${foreignKeys?'ON':'OFF'}; PRAGMA journal_mode=WAL; CREATE TABLE app_projects(id TEXT PRIMARY KEY,owner_id TEXT)`);
 for(const s of ddl)if(/^CREATE (TABLE|INDEX) analytics_/.test(s)||/^CREATE TRIGGER analytics_summary_delete_/.test(s))db.exec(s);
 db.exec("INSERT INTO app_projects VALUES('p','owner'); INSERT INTO analytics_project_revisions VALUES('p',1)");
 let now=1800000000000,seq=0;
 db.prepare(`INSERT INTO analytics_summary_requests(project_id,query_key,query_json,format_version,requested_at,last_requested_at,lease_token,lease_until,attempts) VALUES('p','q','{}','f',?,?,'token',?,1)`).run(now,now,now+LEASE_MS);
 const job={project_id:'p',query_key:'q',format_version:'f',lease_token:'token',source_revision:1,lease_until:now+LEASE_MS,attempts:1};
 const queries=[];
 const f={db,path,job,queries,get now(){return now;},set now(n){now=n;},row:(s,...a)=>db.prepare(s).get(...a),rows:(s,...a)=>db.prepare(s).all(...a),exec:s=>db.exec(s),
  advance:n=>{now+=n;},close:()=>{db.close();rmSync(dir,{recursive:true,force:true});},
  claim:(token=`token-${++seq}`)=>{const rev=f.row("SELECT revision FROM analytics_project_revisions WHERE project_id='p'").revision;db.prepare("UPDATE analytics_summary_requests SET lease_token=?,lease_until=?,attempts=1 WHERE project_id='p' AND query_key='q'").run(token,now+LEASE_MS);return {...job,lease_token:token,lease_until:now+LEASE_MS,source_revision:rev};},
  snapshot:()=>Object.fromEntries(['requests','generations','heads','payloads','evidence'].map(t=>[t,JSON.stringify(db.prepare(`SELECT * FROM analytics_summary_${t} ORDER BY 1,2`).all())]))};
 f.run=async(plan,{before,after,realClock=false,delayResponse=false}={})=>{
  const conn=new DatabaseSync(path);conn.exec(`PRAGMA foreign_keys=${foreignKeys?'ON':'OFF'}; PRAGMA busy_timeout=0`);
  conn.function('proof_now_ms',()=>Number.isSafeInteger(now)?BigInt(now):null);
  const steps=plan.body.requests[0].batch.steps,r=steps.map(()=>null),e=steps.map(()=>null);
  for(let i=0;i<steps.length;i++){
   if(!condition(steps[i].condition,r))continue;
   const label=plan.labels[i];
   try{
    await before?.({conn,label,index:i,plan});
    const stmt=steps[i].stmt;const query=realClock?stmt.sql:stmt.sql.replaceAll(CLOCK_SQL,'proof_now_ms()');
    queries.push({label,sql:query});
    const p=conn.prepare(query),args=stmt.args.map(decode);
    let rows=[],affected=0,cols=[];
    if(stmt.want_rows){rows=p.all(...args);cols=p.columns().map(c=>({name:c.name}));affected=Number(conn.prepare('SELECT changes() n').get().n);}
    else affected=Number(p.run(...args).changes);
    r[i]={cols,rows:rows.map(row=>Object.values(row).map(encode)),affected_row_count:affected,last_insert_rowid:null};
    await after?.({conn,label,index:i,plan});
   }catch(error){r[i]=null;e[i]={message:error.message,code:error.code??'LOCAL_INJECTED'};}
  }
  try{conn.exec('ROLLBACK');}catch{} // Closing a fresh stream abandons any remaining transaction.
  conn.close();
  if(delayResponse)throw Error('LOCAL_RESPONSE_LOST_AFTER_SERVER_EXECUTION');
  const batch={step_results:r,step_errors:e};return {...classify(plan,batch),raw:batch};
 };
 f.adapter={summaryAtomic:plan=>f.run(plan),execute:async ({sql,args=[]})=>({rows:f.rows(sql.replaceAll(CLOCK_SQL,String(now)),...args)})};
 return f;
}
export const evidence=n=>Array.from({length:n},(_,i)=>({id:`e${i}`,text:'Synthetic question',answer:`Synthetic answer ${i}`,provider:'fixture',model:'fixture',topic:'Example',tags:[],brandNames:[],citations:[],exclusion:null,mentioned:false,recommendation:'none',ownedCitation:false,brandOrder:{state:'none',targetPosition:null}}));

// HTTP-only fixture exercises the public adapter and exact JSON envelope without
// opening sockets. SQLite is an execution model, not a provider acceptance test.
export async function httpFixture(options={}){
 const {createSummaryDatabase}=await import('../src/analytics/summary-transport.mjs');
 const f=fixture(options);f.requests=[];
 f.fetch=async(url,options)=>{
  const body=JSON.parse(options.body),steps=body.requests[0].batch.steps;
  f.requests.push({url,bytes:Buffer.byteLength(options.body),statements:steps.length,sql:steps.map(x=>x.stmt.sql)});
  const plan={body,labels:steps.map((_,i)=>`step_${i}`),commit:steps.length-2,rollback:steps.length-1};
  const r=await f.run(plan);
  return new Response(JSON.stringify({baton:null,base_url:'https://untrusted-routing.invalid',results:[{type:'ok',response:{type:'batch',result:r.raw}},{type:'ok',response:{type:'close'}}]}));
 };
 f.adapter=createSummaryDatabase({url:'https://fixed.invalid',authToken:'synthetic-only',fetch:(...args)=>f.fetch(...args)});
 return f;
}
