import {one} from '../monitoring/shared.mjs';
import {workspacePlan,assertWorkspaceAccess} from '../common/plans.mjs';

// Mirrors the app's published plan-limits.ts. Keep legacy unsynced workspaces
// under the existing migration022 compatibility policy; do not invent billing.
export const TEAM_LIMITS=Object.freeze({starter:{seats:2,guests:false},pro:{seats:5,guests:true},advanced:{seats:null,guests:true},custom:{seats:null,guests:true}});
const denied=(plan,resource,limit)=>{throw Object.assign(Error('PLAN_LIMIT'),{status:402,code:'PLAN_LIMIT',resource,limit,upgradeTo:{starter:'pro',pro:'advanced',advanced:'custom',custom:null}[plan]});};

// Match Team.members + Team.invites as counted by app billing.server.ts.
// A workspace member and a project guest grant are separate displayed entries;
// project guest entries are grouped by user+role across projects. Unaccepted,
// unrevoked invites (including expired invitations) reserve one displayed seat.
// Caller holds the team mutation write transaction, including invitation accept.
export async function teamSeatUsage(tx,workspaceId){
 const w=await one(tx,'SELECT owner_id FROM app_workspaces WHERE id=?',[workspaceId]);
 const members=Number((await one(tx,'SELECT COUNT(*) n FROM app_workspace_members WHERE workspace_id=? AND user_id<>?',[workspaceId,w.owner_id])).n);
 const guests=Number((await one(tx,`SELECT COUNT(*) n FROM (SELECT g.user_id,g.role FROM app_project_guests g JOIN app_projects p ON p.id=g.project_id WHERE p.workspace_id=? AND g.user_id<>? GROUP BY g.user_id,g.role)`,[workspaceId,w.owner_id])).n);
 const invites=Number((await one(tx,'SELECT COUNT(*) n FROM app_invites WHERE workspace_id=? AND accepted_at IS NULL AND revoked_at IS NULL',[workspaceId])).n);
 return 1+members+guests+invites;
}
export async function assertTeamCapacity(tx,workspaceId,{scope,adding=0,stamp=Date.now()}={}){
 const plan=await workspacePlan(tx,workspaceId);
 assertWorkspaceAccess(plan,stamp);
 if(!plan)return;
 const limits=TEAM_LIMITS[plan.plan];
 if(scope==='project'&&!limits.guests)denied(plan.plan,'guests',0);
 if(limits.seats!==null&&await teamSeatUsage(tx,workspaceId)+adding>limits.seats)denied(plan.plan,'seats',limits.seats);
}
