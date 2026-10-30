import {one,exec} from '../monitoring/shared.mjs';
import {TRIAL_MS} from '../common/plans.mjs';
import {id as teamId,checksum as teamChecksum} from './team-migration.mjs';
import {id as planId,checksum as planChecksum} from './plan-migration.mjs';
const timestamp=value=>value!==null&&value!==undefined&&Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;

// Caller-only, read-only context. This is NOT an email-send authorization or a
// persisted trial before first brand; background sends require fresh authority.
export async function sessionContext(db,userId,stamp=Date.now()){
 const user=await one(db,'SELECT created_at FROM users WHERE id=?',[userId]);
 const created=timestamp(user?.created_at),accountCreatedAt=created!==null&&created<=stamp?created:null;
 const result={accountCreatedAt,observedAt:stamp,state:'unknown',ownedWorkspaces:[],hasNonOwnerMembership:null,provisionalTrial:null};
 for(const [id,checksum] of [[teamId,teamChecksum],[planId,planChecksum]]){
  if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)return result;
 }
 const rows=(await exec(db,'SELECT id,owner_id,plan,plan_status,trial_started_at,trial_ends_at,plan_revision FROM app_workspaces WHERE owner_id=? ORDER BY id',[userId])).rows;
 result.ownedWorkspaces=rows.map(w=>({id:w.id,ownerUserId:w.owner_id,plan:w.plan,status:w.plan_status,trialStartedAt:timestamp(w.trial_started_at),trialEndsAt:timestamp(w.trial_ends_at),revision:Number(w.plan_revision)}));
 result.hasNonOwnerMembership=Boolean(await one(db,`SELECT 1 FROM app_workspace_members m JOIN app_workspaces w ON w.id=m.workspace_id WHERE m.user_id=? AND w.owner_id<>?
 UNION ALL SELECT 1 FROM app_project_guests g JOIN app_projects p ON p.id=g.project_id WHERE g.user_id=? AND p.owner_id<>? LIMIT 1`,[userId,userId,userId,userId]));
 result.state='ready';
 if(!rows.length&&!result.hasNonOwnerMembership&&accountCreatedAt!==null&&Number.isSafeInteger(accountCreatedAt+TRIAL_MS)){
  result.provisionalTrial={source:'account_signup',startsAt:accountCreatedAt,endsAt:accountCreatedAt+TRIAL_MS};
 }
 return result;
}
