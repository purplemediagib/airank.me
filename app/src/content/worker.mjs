import http from 'node:http';
import {getDb} from '../common/db.mjs';
import {transaction,one,exec,uid,enqueue,put,get,fail} from './store.mjs';
import {id,checksum} from './migration.mjs';
import {runJob} from './engine.mjs';
const LEASE=300000;
export async function tick(db,{env=process.env,run=runJob,now=Date.now,...injected}={}){
 const token=uid();const job=await transaction(db,async tx=>{
  await exec(tx,"UPDATE content_jobs SET status=CASE WHEN kind='publish' THEN 'uncertain' WHEN attempt>=3 THEN 'failed' ELSE 'queued' END,claim_token=NULL,lease_until=NULL,error='WORKER_INTERRUPTED',updated_at=? WHERE status='running' AND lease_until<?",[now(),now()]);
  const j=await one(tx,"SELECT * FROM content_jobs WHERE status='queued' AND available_at<=? ORDER BY created_at,id LIMIT 1",[now()]);if(!j)return null;
  await exec(tx,"UPDATE content_jobs SET status='running',attempt=attempt+1,claim_token=?,lease_until=?,updated_at=? WHERE id=?",[token,now()+LEASE,now(),j.id]);return {...j,attempt:Number(j.attempt)+1,claim_token:token};
 });if(!job)return false;
 const controller=new AbortController(),checkpoint=JSON.parse(job.checkpoint);const alive=async tx=>{const j=await one(tx,'SELECT status,claim_token FROM content_jobs WHERE id=?',[job.id]);if(j?.status!=='running'||j.claim_token!==token)fail(409,'LEASE_LOST');};
 const commit=fn=>transaction(db,async tx=>{await alive(tx);return fn(tx);});
 const timer=setInterval(()=>commit(tx=>exec(tx,'UPDATE content_jobs SET lease_until=? WHERE id=?',[now()+LEASE,job.id])).catch(()=>controller.abort()),30000);timer.unref();
 const step=async(name,fn)=>{if(Object.hasOwn(checkpoint,name))return checkpoint[name];await commit(async()=>{});const value=await fn();checkpoint[name]=value;await commit(tx=>exec(tx,'UPDATE content_jobs SET checkpoint=?,updated_at=? WHERE id=?',[JSON.stringify(checkpoint),now(),job.id]));return value;};
 try{
  const result=await run({db,job,input:JSON.parse(job.input),env,commit,step,signal:controller.signal,...injected});
  await commit(tx=>exec(tx,"UPDATE content_jobs SET status='completed',result=?,lease_until=NULL,claim_token=NULL,updated_at=? WHERE id=?",[JSON.stringify(result),now(),job.id]));
 }catch(e){
  const code=/^[A-Z0-9_]+$/.test(e.code||'')?e.code:'CONTENT_JOB_FAILED';
  try{await commit(async tx=>{const retry=job.kind!=='publish'&&e.retryable&&job.attempt<3;await exec(tx,'UPDATE content_jobs SET status=?,error=?,available_at=?,lease_until=NULL,claim_token=NULL,updated_at=? WHERE id=?',[job.kind==='publish'&&code==='PUBLICATION_UNCERTAIN'?'uncertain':retry?'queued':'failed',code,now()+Math.min(300000,15000*2**job.attempt),now(),job.id]);});}catch{/* lease lost or cancellation: do not overwrite newer owner */}
 }finally{clearInterval(timer);controller.abort();}return true;
}
export async function schedule(db,now=Date.now()){
 const rows=(await exec(db,"SELECT r.*,p.owner_id,p.status FROM content_records r JOIN app_projects p ON p.id=r.project_id WHERE r.kind='settings' AND r.id='automation' AND p.status='active'",[])).rows;
 for(const r of rows){const value=JSON.parse(r.payload);if(!value.enabled||value.nextRunAt>now)continue;await transaction(db,async tx=>{const current=await get(tx,r.project_id,'settings','automation');if(current.nextRunAt>now||!current.enabled)return;await enqueue(tx,r.project_id,r.owner_id,'opportunities',{locale:current.locale},'scheduled-'+Math.floor(now/(current.refreshHours*3600000)),now);
 const pubs=(await exec(tx,"SELECT payload FROM content_records WHERE project_id=? AND kind='publication' ORDER BY updated_at DESC LIMIT 10",[r.project_id])).rows.map(x=>JSON.parse(x.payload)).filter(x=>x.status==='published');
 for(const pub of pubs){const doc=await get(tx,r.project_id,'document',pub.documentId);if(doc)await enqueue(tx,r.project_id,r.owner_id,'impact',{locale:doc.locale,documentId:doc.id,documentVersion:doc.version},'impact-'+doc.id+'-'+Math.floor(now/86400000),now);}
 await put(tx,r.project_id,'settings','automation',{...current,nextRunAt:now+current.refreshHours*3600000},current.version,r.owner_id,now);});}
}
export async function start(){const db=await getDb();let ready=false,stopping=false,lastTick=0;const server=http.createServer((req,res)=>{const ok=req.url==='/health'||req.url==='/ready'&&ready&&Date.now()-lastTick<600000;res.writeHead(ok?200:503,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({service:'airank-content-worker',version:'1.0.0',ready:ok,revision:process.env.AIRANK_BUILD_REVISION||null}));});server.listen(Number(process.env.PORT||3002));
 const stop=()=>{stopping=true;server.close();};process.on('SIGTERM',stop);process.on('SIGINT',stop);
 while(!stopping){try{ready=(await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum===checksum;if(ready){try{await schedule(db);}catch{console.error('content_schedule_deferred');}const worked=await tick(db);lastTick=Date.now();if(worked)continue;}}catch{ready=false;console.error('content_worker_tick_failed');}await new Promise(r=>setTimeout(r,3000));}
}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href)await start();
