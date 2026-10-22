import {one,exec,fail} from './shared.mjs';
import {sameContext} from '../common/measurement-context.mjs';
import {validateDraft} from '../common/workspace-suggestions.mjs';

const dateFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Helsinki',year:'numeric',month:'2-digit',day:'2-digit'});
export function helsinkiDate(time){
 const p=Object.fromEntries(dateFormatter.formatToParts(new Date(Number(time))).map(p=>[p.type,p.value]));
 return `${p.year}-${p.month}-${p.day}`;
}
export async function assertDailyNotMeasured(db,userId,projectId,day,kind='neutral'){
 // Old schedules used project/local-time submission keys. Check preserved
 // evidence as well as the new key, under the same write transaction as enqueue.
 // Include the old slot's intended date even when its run was submitted late.
 const midnight=Date.parse(`${day}T00:00:00Z`),from=midnight-4*3600000,to=midnight+86400000;
 const rows=(await exec(db,`SELECT r.created_at,s.due_at FROM mon_runs r
 LEFT JOIN app_schedule_slots s ON s.run_id=r.id AND s.state='submitted'
 WHERE r.owner_id=? AND r.project_id=? AND r.kind=? AND COALESCE(json_extract(r.snapshot,'$.collectionScope'),'full')<>'incremental' AND ((r.created_at>=? AND r.created_at<?) OR (s.due_at>=? AND s.due_at<?))`,
 [userId,projectId,kind,from,to,from,to])).rows;
 if(rows.some(r=>helsinkiDate(r.created_at)===day||(r.due_at!=null&&helsinkiDate(r.due_at)===day)))fail(409,'DAILY_ALREADY_MEASURED');
}

// No implicit unlimited tier. Until commercial plans exist, operators configure
// a default cap and optional account-specific entitlements on both API and worker.
export function promptLimit(env=process.env,userId){
 let overrides;
 try{overrides=JSON.parse(env.TRACKED_PROMPT_LIMITS_JSON||'{}');}catch{return null;}
 if(!overrides||Array.isArray(overrides)||typeof overrides!=='object')return null;
 const value=Object.hasOwn(overrides,userId)?overrides[userId]:env.TRACKED_PROMPT_LIMIT;
 if(value===undefined||value===null||value==='')return null;
 const n=Number(value);
 return Number.isSafeInteger(n)&&n>=0&&n<=5000?n:null;
}
export async function assertCanonical(db,userId,projectId){
 const project=await one(db,"SELECT id FROM app_projects WHERE owner_id=? AND id=? AND status='active'",[userId,projectId]);
 if(!project)fail(404,'NOT_FOUND');
}
export async function promptUsage(db,userId,projectId,env=process.env){
 const active=Number((await one(db,"SELECT COUNT(*) n FROM mon_prompts p JOIN app_projects a ON a.id=p.project_id WHERE a.owner_id=? AND a.status='active' AND p.status='active'",[userId])).n);
 return {activePromptCount:active,promptLimit:promptLimit(env,userId)};
}
export async function assertPromptCapacity(db,userId,projectId,env,{adding=false}={}){
 await assertCanonical(db,userId,projectId);
 const usage=await promptUsage(db,userId,projectId,env);
 if(usage.promptLimit===null)fail(503,'PROMPT_LIMIT_NOT_CONFIGURED');
 if(usage.activePromptCount+(adding?1:0)>usage.promptLimit)fail(422,'PROMPT_LIMIT_REACHED');
 return usage;
}
export async function promptReadiness(db,projectId,identity){
 const rows=(await exec(db,"SELECT v.payload FROM mon_prompts p JOIN mon_prompt_versions v ON v.prompt_id=p.id AND v.version=p.version WHERE p.project_id=? AND p.status='active'",[projectId])).rows;
 if(!rows.length)return 'empty';
 if(rows.some(r=>{const p=JSON.parse(r.payload);try{validateDraft(p,identity);}catch{return true;}return !sameContext(p,identity);} ))return 'prompt_review_required';
 return 'ready';
}
