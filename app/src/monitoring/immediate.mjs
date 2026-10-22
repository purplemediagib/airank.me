import {monitoringService} from './service.mjs';
import {exec,one,hash,normalized,transaction,fail} from './shared.mjs';
import {measurementContext} from '../common/measurement-context.mjs';
import {id,checksum} from './immediate-migration.mjs';

export const measurementKey=p=>hash([p.kind,normalized(p.text),measurementContext(p)]);

export async function bootstrapImmediate({db,projectId,userId,body,env=process.env,now=Date.now}){
 if(!body||!['neutral','diagnostic'].includes(body.kind)||typeof body.submissionId!=='string'||!/^[\w-]{16,80}$/.test(body.submissionId)||
  Object.keys(body).some(k=>!['kind','submissionId'].includes(k)))fail(422,'VALIDATION_FAILED');
 await immediateReady(db);
 await transaction(db,async tx=>{
  const project=await one(tx,'SELECT status FROM app_projects WHERE id=? AND owner_id=?',[projectId,userId]);
  if(!project)fail(404,'NOT_FOUND');
  if(project.status!=='active')fail(409,'VERSION_CONFLICT');
  // Explicit user action only: migration/GET/worker never seed old prompt sets.
  const prompts=(await exec(tx,"SELECT id,hash FROM mon_prompts WHERE project_id=? AND status='active'",[projectId])).rows;
  for(const p of prompts)await exec(tx,`INSERT INTO mon_immediate_outbox(prompt_id,fingerprint,project_id,created_at) VALUES(?,?,?,?)
   ON CONFLICT(prompt_id,fingerprint) DO UPDATE SET state='pending',reason=NULL WHERE mon_immediate_outbox.state='cancelled'`,[p.id,p.hash,projectId,now()]);
 });
 let result;
 try{
  result=await monitoringService({db,method:'POST',path:`/v1/projects/${projectId}/monitoring-runs`,body,userId,env,now,immediate:true});
 }catch(e){
  if([409,422,503].includes(e.status))await exec(db,"UPDATE mon_immediate_outbox SET state='blocked',reason=? WHERE project_id=? AND state IN ('pending','blocked')",[e.code,projectId]);
  throw e;
 }
 if(!result.data.id)fail(409,'NO_UNMEASURED_PROMPTS');
 return result;
}

export async function immediateStatus(db,projectId){
 // Optional on installations awaiting app-016; no write or implicit enrollment.
 if(!await one(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='mon_immediate_outbox'"))return undefined;
 const row=await one(db,`SELECT state,reason,run_id FROM mon_immediate_outbox WHERE project_id=?
 ORDER BY CASE state WHEN 'blocked' THEN 0 WHEN 'pending' THEN 1 WHEN 'submitted' THEN 2 ELSE 3 END,created_at DESC LIMIT 1`,[projectId]);
 return row?{state:row.state,reason:row.reason??null,runId:row.run_id??null}:{state:'idle',reason:null,runId:null};
}

async function immediateReady(db){
 if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)fail(503,'APP_NOT_CONFIGURED');
}

// Called only inside the run-enqueue write transaction. Any task reservation,
// even failed/interrupted/budget-blocked, counts: never retry a paid attempt.
export async function immediatePrompts(tx,projectId,prompts){
 const pending=(await exec(tx,"SELECT * FROM mon_immediate_outbox WHERE project_id=? AND state IN ('pending','blocked')",[projectId])).rows;
 const selected=[];
 for(const entry of pending){
  const p=prompts.find(p=>p.id===entry.prompt_id&&measurementKey(p)===entry.fingerprint);
  if(!p){
   // This sweep is kind-specific. Do not cancel current prompts of the other kind.
   if(await one(tx,"SELECT id FROM mon_prompts WHERE id=? AND status='active' AND hash=?",[entry.prompt_id,entry.fingerprint]))continue;
   await exec(tx,"UPDATE mon_immediate_outbox SET state='cancelled',reason='prompt_not_current' WHERE prompt_id=? AND fingerprint=?",[entry.prompt_id,entry.fingerprint]);
   continue;
  }
  const history=(await exec(tx,`SELECT v.payload FROM mon_tasks t JOIN mon_runs r ON r.id=t.run_id
   JOIN mon_prompt_versions v ON v.prompt_id=t.prompt_id AND v.version=t.prompt_version
   WHERE r.project_id=? AND t.prompt_id=?`,[projectId,p.id])).rows;
  if(history.some(r=>measurementKey(JSON.parse(r.payload))===entry.fingerprint)){
   await exec(tx,"UPDATE mon_immediate_outbox SET state='covered',reason='already_reserved' WHERE prompt_id=? AND fingerprint=?",[p.id,entry.fingerprint]);
  }else selected.push(p);
 }
 return selected;
}

export async function tickImmediate(db,{env=process.env,now=Date.now}={}){
 await immediateReady(db);
 await exec(db,`UPDATE mon_immediate_outbox SET state='cancelled',reason='prompt_not_current'
 WHERE state IN ('pending','blocked') AND NOT EXISTS(SELECT 1 FROM mon_prompts p
 WHERE p.id=mon_immediate_outbox.prompt_id AND p.status='active' AND p.hash=mon_immediate_outbox.fingerprint)`);
 const projects=(await exec(db,`SELECT o.project_id,p.owner_id,p.status FROM mon_immediate_outbox o
 JOIN app_projects p ON p.id=o.project_id WHERE o.state IN ('pending','blocked')
 GROUP BY o.project_id,p.owner_id,p.status ORDER BY MIN(o.checked_at),MIN(o.created_at) LIMIT 20`)).rows;
 for(const p of projects){
  // Config-blocked projects must not monopolize the bounded worker sweep.
  await exec(db,"UPDATE mon_immediate_outbox SET checked_at=? WHERE project_id=? AND state IN ('pending','blocked')",[now(),p.project_id]);
  if(p.status!=='active'||env.MONITORING_ENABLED!=='true'){
   await transaction(db,tx=>exec(tx,`UPDATE mon_immediate_outbox SET state=?,reason=? WHERE project_id=? AND state IN ('pending','blocked')`,
    [p.status!=='active'?'cancelled':'blocked',p.status!=='active'?'project_archived':'MONITORING_NOT_ENABLED',p.project_id]));
   continue;
  }
  for(const kind of ['neutral','diagnostic'])try{
   await monitoringService({db,method:'POST',path:`/v1/projects/${p.project_id}/monitoring-runs`,
    body:{kind,submissionId:hash(['immediate',p.project_id,kind])},userId:p.owner_id,env,now,immediate:true,verifyImmediateCredentials:true});
  }catch(e){
   if(![409,422,503].includes(e.status))throw e;
   await exec(db,"UPDATE mon_immediate_outbox SET state='blocked',reason=? WHERE project_id=? AND state IN ('pending','blocked')",[e.code,p.project_id]);
  }
 }
}
