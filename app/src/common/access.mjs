import {uuid,hashToken,eqString} from './utils.mjs';
import {one,exec,fail} from '../monitoring/shared.mjs';
export const RANK={viewer:0,member:1,admin:2,owner:3};
const NEED={read:'viewer',edit:'member',runChecks:'member',manageTeam:'admin',manageConnections:'admin',manageReports:'admin',manageProject:'admin',transferOwnership:'owner'};
// Keep owner-only installations usable until the explicit additive migration runs.
export const teamsEnabled=async cx=>!!await one(cx,"SELECT name FROM sqlite_master WHERE type='table' AND name='app_workspaces'");
export async function projectRole(cx,projectId,userId){
 const p=await one(cx,'SELECT * FROM app_projects WHERE id=?',[projectId]);
 if(!p)return null;
 if(p.owner_id===userId)return 'owner';
 if(!await teamsEnabled(cx))return null;
 const w=await one(cx,'SELECT role FROM app_workspace_members WHERE workspace_id=? AND user_id=?',[p.workspace_id,userId]);
 const g=await one(cx,'SELECT role FROM app_project_guests WHERE project_id=? AND user_id=?',[projectId,userId]);
 return [w?.role,g?.role].filter(Boolean).sort((a,b)=>RANK[b]-RANK[a])[0]||null;
}
export async function requireProject(cx,projectId,userId,action='read'){
 const role=await projectRole(cx,projectId,userId);
 if(!role)fail(404,'NOT_FOUND');
 if(!Object.hasOwn(NEED,action)||RANK[role]<RANK[NEED[action]])fail(403,'ROLE_FORBIDDEN');
 return role;
}
export async function accessibleProject(cx,projectId,userId,action='read'){
 const myRole=await requireProject(cx,projectId,userId,action);
 const row=await one(cx,`SELECT p.*,v.identity_json,u.display_name AS owner_name,u.email AS owner_email FROM app_projects p
 JOIN app_identity_versions v ON v.project_id=p.id AND v.version=p.version JOIN users u ON u.id=p.owner_id WHERE p.id=?`,[projectId]);
 return {...row,myRole,ownerName:row.owner_name||row.owner_email,workspaceId:row.workspace_id||null};
}
export async function visibleProjects(cx,userId){
 const enabled=await teamsEnabled(cx);
 const joins=enabled?'LEFT JOIN app_workspace_members m ON m.workspace_id=p.workspace_id AND m.user_id=? LEFT JOIN app_project_guests g ON g.project_id=p.id AND g.user_id=?':'';
 const where=enabled?'(p.owner_id=? OR m.role IS NOT NULL OR g.role IS NOT NULL)':'p.owner_id=?';
 const rows=(await exec(cx,`SELECT p.*,v.identity_json,u.display_name AS owner_name,u.email AS owner_email${enabled?',m.role AS wrole,g.role AS grole':''}
 FROM app_projects p JOIN app_identity_versions v ON v.project_id=p.id AND v.version=p.version JOIN users u ON u.id=p.owner_id ${joins}
 WHERE ${where} ORDER BY p.created_at DESC,p.id`,enabled?[userId,userId,userId]:[userId])).rows;
 return rows.map(r=>({...r,myRole:r.owner_id===userId?'owner':[r.wrole,r.grole].filter(Boolean).sort((a,b)=>RANK[b]-RANK[a])[0],ownerName:r.owner_name||r.owner_email,workspaceId:r.workspace_id||null}));
}
export async function ensureWorkspace(cx,userId,name,now=Date.now()){
 const old=await one(cx,'SELECT * FROM app_workspaces WHERE owner_id=?',[userId]);
 if(old)return old;
 const w={id:'ws_'+uuid(),owner_id:userId,name};
 await exec(cx,'INSERT INTO app_workspaces VALUES (?,?,?,?)',[w.id,userId,name,now]);return w;
}
export async function reportProjectAllowed(cx,tokenId,projectId){
 return !await teamsEnabled(cx)||!await one(cx,'SELECT token_id FROM app_report_token_revocations WHERE token_id=? AND project_id=?',[tokenId,projectId]);
}

// The legacy scan URL must not preserve historical owner access to a shared brand.
// Public, unlinked scan tokens keep their existing independent authorization.
export async function scanReadAllowed(cx,job,userId,guestToken=''){
 const linkedTable=await one(cx,"SELECT name FROM sqlite_master WHERE type='table' AND name='app_project_scans'");
 const linked=linkedTable?await one(cx,'SELECT project_id FROM app_project_scans WHERE scan_id=?',[job.id]):null;
 if(linked)return !!userId&&!!await projectRole(cx,linked.project_id,userId);
 return (!!userId&&userId===job.owner_id)||!!(job.guest_token_hash&&typeof guestToken==='string'&&guestToken&&eqString(hashToken(guestToken),job.guest_token_hash));
}
