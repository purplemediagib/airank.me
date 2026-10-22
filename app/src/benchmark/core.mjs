import {createHash, randomUUID} from 'node:crypto';
export const providers=['openai','claude','gemini','google_aio'];
export const hash=x=>createHash('sha256').update(x).digest('hex');
const stmt=(sql,args=[])=>({sql,args});
const rows=async(db,sql,args=[]) => (await db.execute(stmt(sql,args))).rows;
const first=async(db,sql,args=[]) => (await rows(db,sql,args))[0];
export async function atomic(db,fn){const tx=await db.transaction('write');try{const r=await fn(tx);await tx.commit();return r;}catch(e){await tx.rollback();throw e;}finally{tx.close();}}
export function validatePanel(p){
 const id=x=>typeof x==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/.test(x);
 if(!id(p?.id)||!id(p?.industry?.id)||!id(p?.version)||!p.industry.name||p.country!=='FI'||p.language!=='fi')throw Error('Invalid panel identity or locale (FI/fi required)');
 if(!Array.isArray(p.brands)||!p.brands.length||p.brands.length>100||!Array.isArray(p.prompts)||!p.prompts.length||p.prompts.length>200)throw Error('Panel requires 1–100 brands and 1–200 prompts');
 const b=new Set(),q=new Set(),names=new Set();
 for(const x of p.brands){if(!id(x.id)||b.has(x.id)||typeof x.name!=='string'||x.name.length<2||!Array.isArray(x.aliases)||x.aliases.some(a=>typeof a!=='string'||a.length<2||a.length>120)||!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(x.domain))throw Error('Invalid or duplicate brand');b.add(x.id);
  for(const n of new Set([x.name,x.domain,...x.aliases].map(s=>s.normalize('NFKC').trim().toLowerCase()))){if(names.has(n))throw Error('Overlapping brand identities');names.add(n);}
 }
 for(const x of p.prompts){if(!id(x.id)||q.has(x.id)||typeof x.text!=='string'||x.text.length<10||x.text.length>1000||!['discovery','comparison','selection'].includes(x.intent))throw Error('Invalid or duplicate prompt');q.add(x.id);for(const brand of p.brands)for(const alias of [brand.name,brand.domain,...brand.aliases])if(matches(x.text,alias))throw Error('Benchmark prompt must not name tracked brands');}
 return p;
}
export function matches(text,name){const esc=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}(?=$|[^\\p{L}\\p{N}])`,'iu').test(text.normalize('NFC'));}
export function evidence(result,brands){return brands.map(b=>{const alias=[b.name,...b.aliases].find(a=>matches(result.answer||'',a));return {id:b.id,mentioned:!!alias,alias:alias||null,cited:(result.citations||[]).some(c=>{try{const h=new URL(c.url).hostname.toLowerCase();return h===b.domain||h.endsWith('.'+b.domain);}catch{return false;}})};});}
export function nextSlot(now){const d=new Date(now);d.setUTCHours(8,0,0,0);for(let i=0;i<8;i++){if(d.getTime()>now&&[1,4].includes(d.getUTCDay()))return d.getTime();d.setUTCDate(d.getUTCDate()+1);}throw Error('Schedule calculation failed');}
export async function importPanel(db,input,now=Date.now(),publication=null){
 const p=validatePanel(input),json=JSON.stringify(p),digest=hash(json);
 return atomic(db,async tx=>{const old=await first(tx,'SELECT dataset_hash FROM bm_panels WHERE id=?',[p.id]);if(old){if(old.dataset_hash!==digest)throw Error('Panel is immutable: use a new id and version for changes');return p.id;}
 await tx.execute(stmt('INSERT OR IGNORE INTO bm_industries VALUES (?,?)',[p.industry.id,p.industry.name]));
 await tx.execute(stmt('INSERT INTO bm_panels VALUES (?,?,?,?,?,?)',[p.id,p.industry.id,p.version,json,digest,now]));
 for(const b of p.brands)await tx.execute(stmt('INSERT INTO bm_brands VALUES (?,?,?,?,?)',[p.id,b.id,b.name,b.domain,JSON.stringify(b.aliases)]));
 for(const q of p.prompts)await tx.execute(stmt('INSERT INTO bm_prompts VALUES (?,?,?,?)',[p.id,q.id,q.text,q.intent]));
 await tx.execute(stmt('INSERT INTO bm_schedules VALUES (?,0,?)',[p.id,nextSlot(now)]));
 if(publication)await tx.execute(stmt('INSERT INTO bm_publications VALUES (?,0,?,?)',[p.id,publication.verifiedBy,now]));
 return p.id;});
}
export async function enqueue(db,panelId,slot,models,now=Date.now(),routes=null){
 if(typeof slot!=='string'||!slot.length||slot.length>100)throw Error('A stable run slot/token is required');
 return atomic(db,async tx=>{const p=await first(tx,'SELECT dataset_json FROM bm_panels WHERE id=?',[panelId]);if(!p)throw Error('Unknown panel');
 const id=hash(panelId+'\n'+slot).slice(0,32),snapshot={panel:JSON.parse(p.dataset_json),models,providers:routes?Object.keys(routes):providers,routes,methodology:routes?'fi-routed-search-v3':'fi-native-search-v1',locale:'FI/fi',transport:routes?'per_provider_routes':'native_provider_apis'};
 const n=await tx.execute(stmt('INSERT OR IGNORE INTO bm_runs(id,panel_id,slot,created_at,status,snapshot_json) VALUES (?,?,?,?,?,?)',[id,panelId,slot,now,'queued',JSON.stringify(snapshot)]));
 if(Number(n.rowsAffected))for(const q of snapshot.panel.prompts)for(const provider of snapshot.providers)await tx.execute(stmt('INSERT INTO bm_jobs(id,run_id,prompt_id,provider,state) VALUES (?,?,?,?,?)',[hash(id+q.id+provider).slice(0,32),id,q.id,provider,'queued']));return id;});
}
export async function scheduleDue(db,models,now=Date.now(),routes=null){
 for(const s of await rows(db,'SELECT * FROM bm_schedules WHERE enabled=1 AND next_at<=?',[now])){
 if(now-Number(s.next_at)<=6*3600000)await enqueue(db,s.panel_id,'scheduled:'+s.next_at,models,now,routes);
 await db.execute(stmt('UPDATE bm_schedules SET next_at=? WHERE panel_id=? AND next_at=?',[nextSlot(now),s.panel_id,s.next_at]));
 }
}
export function budgets(env=process.env){const n=(k,d)=>{const v=Number(env[k]??d);if(!Number.isSafeInteger(v)||v<1)throw Error(k+' must be a positive finite integer');return v;};return {daily:n('BENCHMARK_MAX_DAILY_CALLS',80),perRun:n('BENCHMARK_MAX_CALLS_PER_RUN',40)};}
export async function claim(db,limits,now=Date.now()){
 return atomic(db,async tx=>{
 // Panel size is questions × providers, NOT questions × providers × brands.
 // Terminate impossible panels instead of leaving their last jobs queued forever.
 const oversized=await rows(tx,"SELECT r.id FROM bm_runs r WHERE r.finished_at IS NULL AND (SELECT COUNT(*) FROM bm_jobs j WHERE j.run_id=r.id)>?",[Math.min(limits.perRun,limits.daily)]);
 for(const r of oversized){
  await tx.execute(stmt("UPDATE bm_jobs SET state='capacity_blocked',error='Panel exceeds configured daily/per-run capacity' WHERE run_id=? AND state='queued'",[r.id]));
  const active=await first(tx,"SELECT id FROM bm_jobs WHERE run_id=? AND state IN ('executing','storing','evidence_pending') LIMIT 1",[r.id]);
  if(!active)await tx.execute(stmt("UPDATE bm_runs SET status='capacity_blocked',finished_at=? WHERE id=?",[now,r.id]));
 }
 await tx.execute(stmt("UPDATE bm_jobs SET state='deadline_exceeded',error='Run missed its 24-hour execution deadline' WHERE state='queued' AND run_id IN (SELECT id FROM bm_runs WHERE created_at<?)",[now-86400000]));
 // Never repeat a potentially billed request after a process interruption.
 await tx.execute(stmt("UPDATE bm_jobs SET state=CASE WHEN result_json IS NULL THEN 'interrupted' ELSE 'evidence_pending' END,error=CASE WHEN result_json IS NULL THEN 'Worker interrupted; provider delivery unknown; no automatic retry' ELSE error END,owner=NULL,lease_until=NULL WHERE state='executing' AND lease_until<?",[now]));
 await tx.execute(stmt("UPDATE bm_jobs SET state='evidence_pending',owner=NULL,lease_until=NULL WHERE state='storing' AND lease_until<?",[now]));
 let j=await first(tx,"SELECT j.*,r.snapshot_json FROM bm_jobs j JOIN bm_runs r ON r.id=j.run_id WHERE j.state='evidence_pending' AND (j.lease_until IS NULL OR j.lease_until<?) ORDER BY r.created_at LIMIT 1",[now]);
 if(j){await tx.execute(stmt("UPDATE bm_jobs SET state='storing',lease_until=?,owner=? WHERE id=?",[now+300000,randomUUID(),j.id]));return {...j,storageOnly:true};}
 const count=await first(tx,'SELECT COUNT(*) n FROM bm_attempts WHERE created_at>?',[now-86400000]);if(Number(count.n)>=limits.daily)return null;
 j=await first(tx,"SELECT j.*,r.snapshot_json FROM bm_jobs j JOIN bm_runs r ON r.id=j.run_id WHERE j.state='queued' AND (SELECT COUNT(*) FROM bm_attempts a WHERE a.run_id=j.run_id)<? ORDER BY r.created_at,j.id LIMIT 1",[limits.perRun]);
 if(!j)return null;
 await tx.execute(stmt("UPDATE bm_jobs SET state='executing',lease_until=?,owner=? WHERE id=?",[now+300000,randomUUID(),j.id]));
 await tx.execute(stmt('INSERT INTO bm_attempts VALUES (?,?,?,?)',[j.id,j.run_id,j.provider,now]));
 await tx.execute(stmt("UPDATE bm_runs SET status='processing' WHERE id=?",[j.run_id]));return {...j,storageOnly:false};});
}
export async function finishRuns(db,now=Date.now()){
 await db.execute(stmt("UPDATE bm_runs SET status=CASE WHEN EXISTS(SELECT 1 FROM bm_jobs WHERE run_id=bm_runs.id AND state NOT IN ('success','no_overview')) THEN 'partial' ELSE 'completed' END,finished_at=? WHERE finished_at IS NULL AND NOT EXISTS(SELECT 1 FROM bm_jobs WHERE run_id=bm_runs.id AND state IN ('queued','executing','storing','evidence_pending'))",[now]));
}
export async function processBenchmark(db,{models,available,call,store,limits=budgets(),scheduled=false,now=()=>Date.now(),onEvent=()=>{},routes=null,canExecute=()=>true}){
 if(scheduled)await scheduleDue(db,models,now(),routes);
 const job=await claim(db,limits,now());if(!job){await finishRuns(db,now());return false;}
 onEvent({event:'benchmark_job_started',run_id:job.run_id,job_id:job.id,provider:job.provider,storage_retry:job.storageOnly});
 const snap=JSON.parse(job.snapshot_json),prompt=snap.panel.prompts.find(p=>p.id===job.prompt_id);
 let result=job.result_json?JSON.parse(job.result_json):null;
 if(!job.storageOnly){
 try{result=!canExecute(job.provider,snap)?{status:'disabled',error:'Provider disabled or route changed; preserved old run without rerouting',answer:'',citations:[]}:available(job.provider)?await call(job.provider,prompt.text,snap.models[job.provider],snap):{status:'unconfigured',error:'Provider credential missing',answer:'',citations:[]};}
 catch(e){result={status:'failed',error:String(e.message).slice(0,1000),answer:'',citations:[]};}
 const observed=now();job.observed_at=observed;
 // Durable staging of provider payload allows storage retries without another AI call.
 await db.execute(stmt("UPDATE bm_jobs SET result_json=?,observed_at=?,state='storing',lease_until=? WHERE id=?",[JSON.stringify(result),observed,now()+300000,job.id]));
 }
 try{
 const envelope={schema_version:1,job_id:job.id,run_id:job.run_id,prompt,provider:job.provider,requested_model:snap.models[job.provider],route:snap.routes?.[job.provider]||null,methodology:snap.methodology,locale:snap.locale,observed_at:job.observed_at,result};
 const saved=await store(job,envelope);if(!saved?.key||!saved?.hash)throw Error('Evidence storage not configured');
 await atomic(db,async tx=>{
 for(const e of result.status==='success'?evidence(result,snap.panel.brands):[])await tx.execute(stmt('INSERT OR IGNORE INTO bm_mentions VALUES (?,?,?,?,?)',[job.id,e.id,+e.mentioned,+e.cited,e.alias]));
 for(const c of result.citations||[]){let u;try{u=new URL(c.url);if(!['http:','https:'].includes(u.protocol))continue;}catch{continue;}
 await tx.execute(stmt('INSERT OR IGNORE INTO bm_citations VALUES (?,?,?,?)',[job.id,c.url,c.title||'',u.hostname]));}
 const state=['success','no_overview','no_grounding','unconfigured','failed','disabled'].includes(result.status)?result.status:'failed';
 // Keep answer/citations/usage in DB; raw payload now resides in private object storage.
 const compact={...result};delete compact.raw;
 await tx.execute(stmt('UPDATE bm_jobs SET state=?,storage_key=?,storage_hash=?,storage_error=NULL,error=?,lease_until=NULL,owner=NULL,result_json=? WHERE id=?',[state,saved.key,saved.hash,result.error||null,JSON.stringify(compact),job.id]));
 });
 }catch(e){await db.execute(stmt("UPDATE bm_jobs SET state='evidence_pending',storage_error=?,lease_until=?,owner=NULL WHERE id=?",[String(e.message).slice(0,1000),now()+60000,job.id]));}
 await finishRuns(db,now());const current=await first(db,'SELECT state FROM bm_jobs WHERE id=?',[job.id]);const run=await first(db,'SELECT status FROM bm_runs WHERE id=?',[job.run_id]);onEvent({event:'benchmark_job_finished',run_id:job.run_id,job_id:job.id,provider:job.provider,state:current.state,run_status:run.status});return true;
}
export async function report(db,runId){
 const run=await first(db,'SELECT * FROM bm_runs WHERE id=?',[runId]);if(!run)throw Error('Unknown run');
 const jobs=await rows(db,'SELECT * FROM bm_jobs WHERE run_id=?',[runId]);
 const snap=JSON.parse(run.snapshot_json),metrics={};
 for(const p of snap.providers){const eligible=jobs.filter(j=>j.provider===p&&j.state==='success'),all=jobs.filter(j=>j.provider===p);metrics[p]={successful_responses:eligible.length,total:all.length,unavailable:all.filter(j=>!['success','no_overview'].includes(j.state)).length,no_overview:all.filter(j=>j.state==='no_overview').length,brands:{}};
 for(const b of snap.panel.brands){const m=await first(db,'SELECT SUM(m.mentioned) mentions,SUM(m.domain_cited) citations FROM bm_mentions m JOIN bm_jobs j ON j.id=m.job_id WHERE j.run_id=? AND j.provider=? AND j.state=? AND m.brand_id=?',[runId,p,'success',b.id]);metrics[p].brands[b.id]={mentions:Number(m.mentions||0),cited_responses:Number(m.citations||0),visibility:eligible.length?Number(m.mentions||0)/eligible.length:null};}}
 return {run:{...run,snapshot_json:undefined,snapshot:snap},metrics,jobs:jobs.map(j=>({...j,result_json:undefined,result:j.result_json?JSON.parse(j.result_json):null})),methodology:'Visibility = responses mentioning brand / successful responses. No-overview, errors and unavailable excluded. API observations with recorded transport; not consumer-chat rankings. Recommendation classification is not implemented.'};
}
