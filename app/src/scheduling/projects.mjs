import {one,exec,fail,hash,transaction} from '../monitoring/shared.mjs';
import {monitoringService} from '../monitoring/service.mjs';
import {immediateStatus} from '../monitoring/immediate.mjs';
import {assertCanonical,promptUsage,promptReadiness} from '../monitoring/prompt-policy.mjs';
import {id,checksum} from './daily-migration.mjs';

const dayIndex={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
const formatter=timezone=>new Intl.DateTimeFormat('en-GB',{timeZone:timezone,weekday:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const parts=(f,t)=>Object.fromEntries(f.formatToParts(new Date(t)).map(p=>[p.type,p.value]));
export function localSlot(time,timezone='Europe/Helsinki'){const p=parts(formatter(timezone),time);return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;}
export function nextProjectSlot(now,{timezone,hour,weekdays,minute=0}){
 const f=formatter(timezone);
 for(let t=Math.floor(now/60000)*60000+60000;t<=now+9*86400000;t+=60000){
  const p=parts(f,t);
  if(Number(p.minute)===minute&&Number(p.hour)===hour&&weekdays.includes(dayIndex[p.weekday]))return t;
 }throw Error('No schedule slot');
}
export const dailyConfig=userId=>({timezone:'Europe/Helsinki',hour:4,minute:parseInt(hash(['daily-stagger',userId]).slice(0,8),16)%60,weekdays:[0,1,2,3,4,5,6]});
export async function ready(db){try{if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)fail(503,'APP_NOT_CONFIGURED');}catch{fail(503,'APP_NOT_CONFIGURED');}}
const enabled=env=>env.PROJECT_SCHEDULER_ENABLED==='true'&&env.MONITORING_ENABLED==='true';

async function enroll(tx,p,now){
 const c=dailyConfig(p.owner_id);
 if(!await one(tx,"SELECT id FROM mon_prompts WHERE project_id=? AND status='active' LIMIT 1",[p.id]))return;
 await exec(tx,'INSERT OR IGNORE INTO app_project_schedules VALUES (?,?,?,?,?,?,?)',[p.id,1,1,c.timezone,c.hour,JSON.stringify(c.weekdays),nextProjectSlot(now,c)]);
 // Upgrade marker, not an overdue slot: never backfill on migration.
 await exec(tx,'UPDATE app_project_schedules SET next_at=? WHERE project_id=? AND next_at=0',[nextProjectSlot(now,c),p.id]);
}
async function statusFor(db,p,env){
 if(p.status!=='active')return 'archived';
 const u=await promptUsage(db,p.owner_id,p.id,env);
 if(u.promptLimit===null)return 'limit_unconfigured';
 if(u.activePromptCount>u.promptLimit)return 'over_limit';
 const identity=await one(db,'SELECT identity_json FROM app_identity_versions WHERE project_id=? AND version=?',[p.id,p.version]);
 const state=await promptReadiness(db,p.id,JSON.parse(identity.identity_json));
 return state==='ready'?'scheduled':state;
}
export async function scheduleService({db,method,path,body,userId,env=process.env,now=Date.now}){
 const projectId=path.split('/')[3],p=await one(db,'SELECT * FROM app_projects WHERE id=? AND owner_id=?',[projectId,userId]);
 if(!p)fail(404,'NOT_FOUND');await ready(db);
 const c=dailyConfig(userId);
 if(method==='PATCH'){
  if(p.status!=='active')fail(409,'VERSION_CONFLICT');
  if(!body||typeof body.enabled!=='boolean'||body.timezone!==c.timezone||body.hour!==4||!Array.isArray(body.weekdays)||JSON.stringify([...new Set(body.weekdays)].sort())!==JSON.stringify(c.weekdays))fail(422,'DAILY_SCHEDULE_FIXED');
  if(body.enabled&&!enabled(env))fail(503,'SCHEDULER_NOT_ENABLED');
  await transaction(db,async tx=>{
   await assertCanonical(tx,userId,projectId);
   const old=await one(tx,'SELECT * FROM app_project_schedules WHERE project_id=?',[projectId]);
   if(body.expectedVersion!==(old?Number(old.version):0))fail(409,'VERSION_CONFLICT');
   await exec(tx,'INSERT INTO app_project_schedules VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,next_at=excluded.next_at',[projectId,(old?Number(old.version):0)+1,body.enabled?1:0,c.timezone,4,JSON.stringify(c.weekdays),nextProjectSlot(now(),c)]);
   if(!body.enabled)await exec(tx,"UPDATE app_schedule_slots SET state='cancelled',reason='paused' WHERE project_id=? AND state='pending'",[projectId]);
  });
 }else if(method==='GET'){
  if(p.status==='active')await transaction(db,async tx=>{
   await enroll(tx,p,now());
  });
 }else fail(405,'METHOD_NOT_ALLOWED');
 const r=await one(db,'SELECT * FROM app_project_schedules WHERE project_id=?',[projectId]);
 let status=await statusFor(db,p,env);
 if(status==='scheduled'&&!r?.enabled)status='paused';
 if(status==='scheduled'&&!enabled(env))status='unavailable';
 const last=await one(db,'SELECT created_at,status FROM mon_runs WHERE owner_id=? AND project_id=? ORDER BY created_at DESC LIMIT 1',[userId,projectId]);
 const immediate=await immediateStatus(db,projectId);
 const immediateField=immediate?{immediate}:{};
 return {status:200,data:{...c,...immediateField,version:r?Number(r.version):0,enabled:!!r?.enabled,status,...await promptUsage(db,userId,projectId,env),nextAt:status==='scheduled'&&r?Number(r.next_at):null,lastRunAt:last?Number(last.created_at):null,lastRunStatus:last?.status??null,activationAvailable:enabled(env),missedPolicy:'skip_after_6_hours',slots:(await exec(db,'SELECT slot,due_at AS dueAt,state,run_id AS runId,reason FROM app_schedule_slots WHERE project_id=? ORDER BY due_at DESC LIMIT 50',[projectId])).rows}};
}
export async function tickProjects(db,{env=process.env,now=Date.now}={}){
 if(!enabled(env))return;
 await ready(db);
 await transaction(db,async tx=>{
  // Bounded enrollment: existing schedules are not reset, so pauses survive.
  const candidates=(await exec(tx,`SELECT p.* FROM app_projects p LEFT JOIN app_project_schedules s ON s.project_id=p.id WHERE p.status='active' AND (s.project_id IS NULL OR s.next_at=0) AND EXISTS(SELECT 1 FROM mon_prompts m WHERE m.project_id=p.id AND m.status='active') ORDER BY p.created_at,p.id LIMIT 100`)).rows;
  for(const p of candidates)await enroll(tx,p,now());
  const due=(await exec(tx,"SELECT s.*,p.owner_id FROM app_project_schedules s JOIN app_projects p ON p.id=s.project_id WHERE s.enabled=1 AND s.next_at>0 AND s.next_at<=? AND p.status='active' ORDER BY s.next_at LIMIT 100",[now()])).rows;
  for(const r of due){
   const late=now()-Number(r.next_at)>6*3600000,slot=localSlot(Number(r.next_at)).slice(0,10);
   await exec(tx,'INSERT OR IGNORE INTO app_schedule_slots VALUES (?,?,?,?,NULL,?)',[r.project_id,slot,r.next_at,late?'skipped':'pending',late?'missed_window':null]);
   await exec(tx,'UPDATE app_project_schedules SET next_at=? WHERE project_id=?',[nextProjectSlot(now(),dailyConfig(r.owner_id)),r.project_id]);
  }
 });
 const pending=(await exec(db,"SELECT s.*,p.owner_id FROM app_schedule_slots s JOIN app_projects p ON p.id=s.project_id JOIN app_project_schedules c ON c.project_id=s.project_id WHERE s.state='pending' AND c.enabled=1 AND p.status='active' ORDER BY due_at LIMIT 20")).rows;
 for(const s of pending){
  if(now()-Number(s.due_at)>6*3600000){
   await exec(db,"UPDATE app_schedule_slots SET state='skipped',reason='missed_window' WHERE project_id=? AND slot=? AND state='pending'",[s.project_id,s.slot]);continue;
  }
  try{
   // This key is owner/date scoped, NOT project scoped. Replacing a set or
   // restarting cannot create another paid run for the same local date.
   const kinds=(await exec(db,`SELECT DISTINCT json_extract(v.payload,'$.kind') kind FROM mon_prompts p
    JOIN mon_prompt_versions v ON v.prompt_id=p.id AND v.version=p.version WHERE p.project_id=? AND p.status='active'`,[s.project_id])).rows.map(r=>r.kind);
   let r;
   for(const kind of ['neutral','diagnostic'].filter(k=>kinds.includes(k))){
    r=await monitoringService({db,method:'POST',path:`/v1/projects/${s.project_id}/monitoring-runs`,body:{kind,submissionId:hash(kind==='neutral'?['daily',s.owner_id,s.project_id,s.slot]:['daily',s.owner_id,s.project_id,s.slot,kind])},userId:s.owner_id,env,now,scheduleSlot:s.slot});
   }
   if(!r)fail(422,'CONTEXT_PROMPTS_REQUIRED');
   await exec(db,"UPDATE app_schedule_slots SET state='submitted',run_id=? WHERE project_id=? AND slot=? AND state='pending'",[r.data.id,s.project_id,s.slot]);
  }catch(e){
   if([409,422].includes(e.status)||e.code==='PROMPT_LIMIT_NOT_CONFIGURED')await exec(db,"UPDATE app_schedule_slots SET state='blocked',reason=? WHERE project_id=? AND slot=? AND state='pending'",[e.code,s.project_id,s.slot]);
   else throw e;
  }
 }
}
