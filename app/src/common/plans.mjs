import {one,exec,fail} from '../monitoring/shared.mjs';
export const PLANS=Object.freeze({
 starter:Object.freeze({prompts:60,brands:1,models:3,frequency:'weekly'}),
 pro:Object.freeze({prompts:175,brands:3,models:5,frequency:'daily'}),
 advanced:Object.freeze({prompts:400,brands:10,models:null,frequency:'daily'}),
 custom:Object.freeze({prompts:null,brands:null,models:null,frequency:'daily'}),
});
export const plansEnabled=async cx=>!!await one(cx,"SELECT name FROM sqlite_master WHERE type='table' AND name='app_plan_events'");
export const planLimit=(plan,resource,reason)=>{
 const upgradeTo=resource==='access'?'pro':{starter:'pro',pro:'advanced',advanced:'custom',custom:null}[plan];
 throw Object.assign(Error('PLAN_LIMIT'),{status:402,code:'PLAN_LIMIT',limit:resource==='access'?0:resource==='frequency'?7:PLANS[plan][resource],upgradeTo,resource,...(reason?{reason}:{})});
};
export async function workspacePlan(cx,workspaceId){
 if(!await plansEnabled(cx))return null;
 const w=await one(cx,'SELECT id,plan,plan_status,trial_started_at,trial_ends_at,plan_revision,plan_updated_at FROM app_workspaces WHERE id=?',[workspaceId]);
 if(!w||w.plan===null)return null;
 if(!Object.hasOwn(PLANS,w.plan))fail(503,'PLAN_NOT_CONFIGURED');
 return {workspaceId:w.id,plan:w.plan,status:w.plan_status,trialStartedAt:w.trial_started_at===null?null:Number(w.trial_started_at),trialEndsAt:w.trial_ends_at===null?null:Number(w.trial_ends_at),revision:Number(w.plan_revision),updatedAt:w.plan_updated_at===null?null:Number(w.plan_updated_at),limits:PLANS[w.plan]};
}
export async function projectPlan(cx,projectId){
 if(!await plansEnabled(cx))return null;
 const p=await one(cx,'SELECT workspace_id FROM app_projects WHERE id=?',[projectId]);
 return p?workspacePlan(cx,p.workspace_id):null;
}
export const TRIAL_MS=7*86400000;
export function assertWorkspaceAccess(plan,stamp=Date.now()){
 if(!plan)return;
 if(plan.status==='active')return;
 if(plan.status==='trialing'&&plan.plan==='pro'&&plan.trialEndsAt!==null&&stamp<plan.trialEndsAt)return;
 planLimit(plan.plan,'access',plan.status==='trialing'?'TRIAL_EXPIRED':'SUBSCRIPTION_INACTIVE');
}
export async function assertPlanAccess(cx,projectId,stamp=Date.now()){const plan=await projectPlan(cx,projectId);assertWorkspaceAccess(plan,stamp);return plan;}
export async function workspaceUsage(cx,workspaceId){
 const brands=Number((await one(cx,"SELECT COUNT(*) n FROM app_projects WHERE workspace_id=? AND status='active'",[workspaceId])).n);
 const prompts=Number((await one(cx,"SELECT COUNT(*) n FROM mon_prompts m JOIN app_projects p ON p.id=m.project_id WHERE p.workspace_id=? AND p.status='active' AND m.status='active'",[workspaceId])).n);
 return {brands,prompts};
}
export async function assertBrandCapacity(cx,workspaceId,{adding=false,stamp=Date.now()}={}){
 const plan=await workspacePlan(cx,workspaceId);if(adding)assertWorkspaceAccess(plan,stamp);if(!plan||plan.limits.brands===null)return;
 const {brands}=await workspaceUsage(cx,workspaceId);
 if(brands+(adding?1:0)>plan.limits.brands)planLimit(plan.plan,'brands');
}
export async function assertPlanPromptCapacity(cx,projectId,{adding=false}={}){
 const plan=await projectPlan(cx,projectId);if(!plan||plan.limits.prompts===null)return;
 const {prompts}=await workspaceUsage(cx,plan.workspaceId);
 if(prompts+(adding?1:0)>plan.limits.prompts)planLimit(plan.plan,'prompts');
}
export async function assertModelCapacity(cx,projectId,providers){
 const plan=await projectPlan(cx,projectId);
 if(plan&&plan.limits.models!==null&&new Set(providers).size>plan.limits.models)planLimit(plan.plan,'models');
 return plan;
}
export const WEEK_MS=7*86400000;
// A reservation counts even if the upstream result later fails. Different prompt
// kinds share the same rules but may both run in the same scheduled collection.
export async function weeklyNextAt(cx,projectId,kind,{before=Infinity,excludeRun=null}={}){
 const r=await one(cx,`SELECT MAX(r.created_at) last_at FROM mon_runs r WHERE r.project_id=? AND r.kind=?
 AND r.created_at<=? AND r.id<>? AND EXISTS(SELECT 1 FROM mon_tasks t WHERE t.run_id=r.id)`,[projectId,kind,Number.isFinite(before)?before:Number.MAX_SAFE_INTEGER,excludeRun||'']);
 return r?.last_at==null?null:Number(r.last_at)+WEEK_MS;
}
export async function assertPlanRun(cx,projectId,kind,stamp,{runId=null,createdAt=stamp,providers=null,promptCount=null}={}){
 const plan=await assertPlanAccess(cx,projectId,stamp);if(!plan)return null;
 await assertBrandCapacity(cx,plan.workspaceId);await assertPlanPromptCapacity(cx,projectId);
 if(promptCount!==null&&plan.limits.prompts!==null&&promptCount>plan.limits.prompts)planLimit(plan.plan,'prompts');
 if(providers)await assertModelCapacity(cx,projectId,providers);
 if(plan.limits.frequency==='weekly'){
  const next=await weeklyNextAt(cx,projectId,kind,{before:runId?createdAt:Infinity,excludeRun:runId});
  if(next!==null&&createdAt<next)planLimit(plan.plan,'frequency');
 }
 return plan;
}
export async function planScheduleNextAt(cx,projectId,stamp){
 const plan=await projectPlan(cx,projectId);if(plan?.limits.frequency!=='weekly')return stamp;
 const kinds=(await exec(cx,`SELECT DISTINCT json_extract(v.payload,'$.kind') kind FROM mon_prompts p JOIN mon_prompt_versions v ON v.prompt_id=p.id AND v.version=p.version WHERE p.project_id=? AND p.status='active'`,[projectId])).rows;
 if(!kinds.length)return stamp;
 const times=[];for(const {kind} of kinds)times.push(await weeklyNextAt(cx,projectId,kind)??stamp);
 return Math.max(stamp,Math.min(...times));
}
