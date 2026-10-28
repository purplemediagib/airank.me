import {hashToken,eqString} from '../common/utils.mjs';
import {one,exec,transaction,fail} from '../monitoring/shared.mjs';
import {PLANS,workspaceUsage,TRIAL_MS} from '../common/plans.mjs';
import {id,checksum} from './plan-migration.mjs';
export async function internalPlanService({db,method,path,headers,body,env=process.env,now=Date.now}){
 const match=path.match(/^\/v1\/internal\/workspaces\/([A-Za-z0-9_-]{1,100})\/plan$/);
 if(!match)fail(404,'NOT_FOUND');
 // Cookie, CSRF and report credentials never authorize billing changes.
 const secret=env.BILLING_SHARED_SECRET;
 if(typeof secret!=='string'||!/^[\x21-\x7e]{32,256}$/.test(secret))fail(503,'BILLING_NOT_CONFIGURED');
 const token=typeof headers.authorization==='string'&&headers.authorization.match(/^Bearer ([\x21-\x7e]{32,256})$/i)?.[1];
 if(!token||!eqString(hashToken(token),hashToken(secret)))fail(401,'AUTH_REQUIRED');
 if(method!=='POST')fail(405,'METHOD_NOT_ALLOWED');
 if(!/^application\/json(?:;|$)/i.test(headers['content-type']||''))fail(415,'JSON_REQUIRED');
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['plan','status','trialEndsAt','revision'].includes(k))||typeof body.plan!=='string'||!Object.hasOwn(PLANS,body.plan)||!['active','trialing','inactive'].includes(body.status)||!Number.isSafeInteger(body.revision)||body.revision<1)fail(422,'VALIDATION_FAILED');
 if(body.status==='trialing'&&(body.plan!=='pro'||body.trialEndsAt!==undefined&&(!Number.isSafeInteger(body.trialEndsAt)||body.trialEndsAt<=0))||body.status!=='trialing'&&body.trialEndsAt!==undefined)fail(422,'VALIDATION_FAILED');
 if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)fail(503,'PLANS_NOT_CONFIGURED');
 return transaction(db,async tx=>{
  const w=await one(tx,'SELECT w.*,u.created_at AS account_created_at FROM app_workspaces w JOIN users u ON u.id=w.owner_id WHERE w.id=?',[match[1]]);if(!w)fail(404,'NOT_FOUND');
  const started=w.trial_started_at===null?Number(w.account_created_at):Number(w.trial_started_at);
  const trialEndsAt=body.status==='trialing'?(body.trialEndsAt??started+TRIAL_MS):w.trial_ends_at;
  if(body.status==='trialing'&&(trialEndsAt>started+TRIAL_MS||trialEndsAt<=started))fail(422,'INVALID_TRIAL_END');
  if(body.revision<Number(w.plan_revision)||(body.revision===Number(w.plan_revision)&&(body.plan!==w.plan||body.status!==w.plan_status||trialEndsAt!==w.trial_ends_at)))fail(409,'PLAN_REVISION_CONFLICT');
  const changed=body.revision>Number(w.plan_revision),stamp=now();
  if(changed){
   await exec(tx,'UPDATE app_workspaces SET plan=?,plan_status=?,plan_revision=?,plan_updated_at=?,trial_started_at=?,trial_ends_at=? WHERE id=?',[body.plan,body.status,body.revision,stamp,started,trialEndsAt,w.id]);
   if(w.plan!==body.plan||w.plan_status!==body.status)await exec(tx,"UPDATE app_project_schedules SET next_at=0 WHERE enabled=1 AND project_id IN (SELECT id FROM app_projects WHERE workspace_id=?)",[w.id]);
   await exec(tx,'INSERT INTO app_plan_events VALUES (?,?,?,?,?,?,?)',[w.id,body.revision,w.plan,body.plan,body.status,trialEndsAt,stamp]);
  }
  return {status:200,data:{workspaceId:w.id,plan:body.plan,status:body.status,revision:body.revision,trialEndsAt:trialEndsAt===null?null:Number(trialEndsAt),updatedAt:changed?stamp:Number(w.plan_updated_at),limits:PLANS[body.plan],usage:await workspaceUsage(tx,w.id),changed}};
 });
}
