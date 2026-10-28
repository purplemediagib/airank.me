import {one,exec,fail,transaction} from '../monitoring/shared.mjs';
import {uuid,randomToken,hashToken} from '../common/utils.mjs';
import {RANK,requireProject,projectRole} from '../common/access.mjs';
import {id,checksum} from './team-migration.mjs';
const roles=['viewer','member','admin'];
const object=(b,keys)=>{if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!keys.includes(k)))fail(422,'VALIDATION_FAILED');};
const json=r=>JSON.parse(r.project_ids_json);
const userView=r=>({userId:r.id,email:r.email,name:r.display_name||r.email});
const name=r=>r.display_name||r.email;
async function ready(cx){if((await one(cx,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)fail(503,'TEAMS_NOT_CONFIGURED');}
async function context(cx,projectId,userId,action='read'){
 const myRole=await requireProject(cx,projectId,userId,action);
 const w=await one(cx,'SELECT w.* FROM app_workspaces w JOIN app_projects p ON p.workspace_id=w.id WHERE p.id=?',[projectId]);
 if(!w)fail(503,'TEAMS_NOT_CONFIGURED');
 const wr=w.owner_id===userId?'owner':(await one(cx,'SELECT role FROM app_workspace_members WHERE workspace_id=? AND user_id=?',[w.id,userId]))?.role;
 return {w,myRole,workspaceRole:wr,workspaceAdmin:RANK[wr]>=RANK.admin};
}
async function projects(cx,workspaceId){return (await exec(cx,`SELECT p.id,json_extract(v.identity_json,'$.brandName') name FROM app_projects p JOIN app_identity_versions v ON v.project_id=p.id AND v.version=p.version WHERE p.workspace_id=? ORDER BY p.created_at,p.id`,[workspaceId])).rows;}
async function authorizeScope(cx,c,userId,scope,ids){
 if(scope==='workspace'){if(!c.workspaceAdmin)fail(403,'ROLE_FORBIDDEN');return;}
 const all=await projects(cx,c.w.id);
 if(!Array.isArray(ids)||!ids.length||ids.length>100||new Set(ids).size!==ids.length||ids.some(p=>typeof p!=='string'||!all.some(x=>x.id===p)))fail(422,'INVALID_PROJECTS');
 for(const p of ids)await requireProject(cx,p,userId,'manageTeam');
}
async function audit(cx,c,actor,kind,target,payload,stamp){
 const eventId=uuid();
 await exec(cx,'INSERT INTO app_team_audit VALUES (?,?,?,?,?,?,?,?)',[eventId,c.w.id,actor,target?.id||null,target?.email||null,kind,JSON.stringify(payload),stamp]);
 await exec(cx,'INSERT INTO app_audit_events VALUES (?,?,?,?,?,?)',[eventId,actor,null,kind,1,new Date(stamp).toISOString()]);
}
async function rate(cx,c,stamp){const n=await one(cx,"SELECT COUNT(*) n FROM app_team_audit WHERE workspace_id=? AND kind='team.invited' AND created_at>?",[c.w.id,stamp-86400000]);if(Number(n.n)>=50)fail(429,'INVITE_RATE_LIMIT');}
async function returned(cx,r,token){
 const u=await one(cx,'SELECT * FROM users WHERE id=?',[r.invited_by]);
 const w=await one(cx,'SELECT name FROM app_workspaces WHERE id=?',[r.workspace_id]);
 const selected=(await projects(cx,r.workspace_id)).filter(p=>json(r).includes(p.id));
 return {token,invite:{id:r.id,email:r.email,role:r.role,scope:r.scope,inviterName:name(u),inviterEmail:u.email,targetName:r.scope==='workspace'?w.name:selected.map(p=>p.name).join(', ')}};
}
async function revokeReportAccess(cx,userId,ids,stamp){
 for(const p of ids)await exec(cx,'INSERT OR IGNORE INTO app_report_token_revocations SELECT id,?,? FROM app_report_tokens WHERE user_id=?',[p,stamp,userId]);
}
export async function teamsService({db,method,path,body,userId,now=Date.now}){
 const invitation=path.match(/^\/v1\/app\/invites\/(airank_inv_[A-Za-z0-9_-]{43})(\/accept)?$/);
 const route=path.match(/^\/v1\/projects\/([A-Za-z0-9-]{1,80})\/team(?:\/(invites|members|transfer)(?:\/([A-Za-z0-9-]{1,80})(?:\/(resend|revoke))?)?)?$/);
 if(!invitation&&!route) return null;
 await ready(db);
 if(invitation){
  if(method!==(invitation[2]?'POST':'GET'))fail(405,'METHOD_NOT_ALLOWED');
  if(invitation[2])object(body,[]);
  const read=async cx=>{const r=await one(cx,'SELECT * FROM app_invites WHERE token_hash=? AND accepted_at IS NULL AND revoked_at IS NULL',[hashToken(invitation[1])]);if(!r)fail(404,'NOT_FOUND');return r;};
  if(!invitation[2]){const r=await read(db),view=(await returned(db,r,null)).invite;return {status:200,data:{email:r.email,role:r.role,scope:r.scope,targetName:view.targetName,inviterName:view.inviterName,expired:Number(r.expires_at)<=now()}};}
  return transaction(db,async tx=>{
   const r=await read(tx),u=await one(tx,'SELECT * FROM users WHERE id=?',[userId]);
   if(u.email.trim().toLowerCase()!==r.email)fail(403,'INVITE_EMAIL_MISMATCH');
   if(Number(r.expires_at)<=now())fail(410,'INVITE_EXPIRED');
   const all=await projects(tx,r.workspace_id),ids=r.scope==='workspace'?all.map(p=>p.id):json(r);
   if(!ids.length||ids.some(p=>!all.some(x=>x.id===p)))fail(410,'INVITE_UNAVAILABLE');
   // Outstanding invitations cannot outlive the inviter's management access.
   const c=await context(tx,ids[0],r.invited_by,'manageTeam');
   await authorizeScope(tx,c,r.invited_by,r.scope,ids);
   if(c.w.owner_id!==userId){
    const add=async(table,key,value)=>{
     const old=await one(tx,`SELECT role FROM ${table} WHERE ${key}=? AND user_id=?`,[value,userId]);
     if(!old)await exec(tx,`INSERT INTO ${table} VALUES (?,?,?,?)`,[value,userId,r.role,now()]);
     else if(RANK[r.role]>RANK[old.role])await exec(tx,`UPDATE ${table} SET role=? WHERE ${key}=? AND user_id=?`,[r.role,value,userId]);
    };
    if(r.scope==='workspace')await add('app_workspace_members','workspace_id',r.workspace_id);
    else for(const p of ids)await add('app_project_guests','project_id',p);
   }
   await exec(tx,'UPDATE app_invites SET accepted_at=? WHERE id=?',[now(),r.id]);
   await audit(tx,c,userId,'team.accepted',u,{inviteId:r.id,scope:r.scope,role:r.role,projectIds:ids},now());
   return {status:200,data:{projectId:ids[0]}};
  });
 }
 const [,projectId,section,targetId,operation]=route;
 const reply=(data,status=200)=>({status,data});
 if(method==='GET'&&!section){
  const c=await context(db,projectId,userId),all=await projects(db,c.w.id),visible=[];
  for(const p of all)if(await projectRole(db,p.id,userId))visible.push(p);
  const owner=await one(db,'SELECT * FROM users WHERE id=?',[c.w.owner_id]);
  const members=[{...userView(owner),role:'owner',scope:'workspace'}];
  const wm=(await exec(db,'SELECT u.*,m.role FROM app_workspace_members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY u.email',[c.w.id])).rows;
  members.push(...wm.filter(r=>r.id!==c.w.owner_id).map(r=>({...userView(r),role:r.role,scope:'workspace'})));
  const guests=(await exec(db,'SELECT u.*,g.role,g.project_id FROM app_project_guests g JOIN app_projects p ON p.id=g.project_id JOIN users u ON u.id=g.user_id WHERE p.workspace_id=? ORDER BY u.email,g.project_id',[c.w.id])).rows;
  for(const r of guests.filter(g=>visible.some(p=>p.id===g.project_id)&&g.id!==c.w.owner_id)){
   let old=members.find(m=>m.scope==='project'&&m.userId===r.id&&m.role===r.role);
   if(!old){old={...userView(r),role:r.role,scope:'project',projectNames:[]};members.push(old);}
   old.projectNames.push(visible.find(p=>p.id===r.project_id).name);
  }
  const invites=[];
  if(c.myRole!=='viewer')for(const r of (await exec(db,'SELECT * FROM app_invites WHERE workspace_id=? AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC',[c.w.id])).rows){
   if(!c.workspaceRole&&(r.scope==='workspace'||json(r).some(p=>!visible.some(v=>v.id===p))))continue;
   const u=await one(db,'SELECT * FROM users WHERE id=?',[r.invited_by]);
   invites.push({id:r.id,email:r.email,role:r.role,scope:r.scope,...(r.scope==='project'?{projectNames:visible.filter(p=>json(r).includes(p.id)).map(p=>p.name)}:{}),expiresAt:Number(r.expires_at),invitedBy:name(u)});
  }
  return reply({workspaceName:c.w.name,myRole:c.myRole,members,invites});
 }
 return transaction(db,async tx=>{
  const c=await context(tx,projectId,userId,section==='transfer'?'transferOwnership':'manageTeam'),stamp=now();
  if(section==='invites'&&method==='POST'){
   if(!targetId){
    object(body,['email','role','scope','projectIds']);
    if(typeof body.email!=='string'||body.email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())||!roles.includes(body.role)||!['workspace','project'].includes(body.scope))fail(422,'VALIDATION_FAILED');
    const email=body.email.trim().toLowerCase(),ids=body.scope==='project'?body.projectIds||[projectId]:[];
    await authorizeScope(tx,c,userId,body.scope,ids);
    const target=await one(tx,'SELECT * FROM users WHERE lower(email)=?',[email]);
    if(target){
     if(target.id===c.w.owner_id)fail(409,'ALREADY_MEMBER');
     const wm=await one(tx,'SELECT role FROM app_workspace_members WHERE workspace_id=? AND user_id=?',[c.w.id,target.id]);
     if(body.scope==='workspace'&&wm)fail(409,'ALREADY_MEMBER');
     if(body.scope==='project'){
      let complete=true;for(const p of ids)if(RANK[await projectRole(tx,p,target.id)]<RANK[body.role]||!await projectRole(tx,p,target.id))complete=false;
      if(complete)fail(409,'ALREADY_MEMBER');
     }
    }
    await rate(tx,c,stamp);
    const token='airank_inv_'+randomToken(),r={id:uuid(),workspace_id:c.w.id,email,role:body.role,scope:body.scope,project_ids_json:JSON.stringify(ids),invited_by:userId};
    await exec(tx,'INSERT INTO app_invites VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)',[r.id,hashToken(token),c.w.id,email,r.role,r.scope,r.project_ids_json,userId,stamp,stamp+7*86400000]);
    await audit(tx,c,userId,'team.invited',target||{email},{inviteId:r.id,scope:r.scope,role:r.role,projectIds:ids},stamp);
    return reply(await returned(tx,r,token),201);
   }
   object(body,[]);
   const r=await one(tx,'SELECT * FROM app_invites WHERE id=? AND workspace_id=? AND accepted_at IS NULL AND revoked_at IS NULL',[targetId,c.w.id]);if(!r)fail(404,'NOT_FOUND');
   await authorizeScope(tx,c,userId,r.scope,json(r));
   if(operation==='revoke'){await exec(tx,'UPDATE app_invites SET revoked_at=? WHERE id=?',[stamp,r.id]);await audit(tx,c,userId,'team.invite_revoked',{email:r.email},{inviteId:r.id},stamp);return reply({ok:true});}
   if(operation==='resend'){
    await rate(tx,c,stamp);const token='airank_inv_'+randomToken();
    await exec(tx,'UPDATE app_invites SET token_hash=?,expires_at=?,invited_by=? WHERE id=?',[hashToken(token),stamp+7*86400000,userId,r.id]);
    await audit(tx,c,userId,'team.invited',{email:r.email},{inviteId:r.id,resend:true},stamp);
    return reply(await returned(tx,{...r,invited_by:userId},token));
   }
  }
  if(section==='members'&&targetId&&['PATCH','DELETE'].includes(method)){
   object(body,method==='PATCH'?['role']:[]);
   if(method==='PATCH'&&!roles.includes(body.role))fail(422,'VALIDATION_FAILED');
   if(targetId===c.w.owner_id)fail(403,'ROLE_FORBIDDEN');
   const wm=await one(tx,'SELECT * FROM app_workspace_members WHERE workspace_id=? AND user_id=?',[c.w.id,targetId]);
   const guests=(await exec(tx,'SELECT g.* FROM app_project_guests g JOIN app_projects p ON p.id=g.project_id WHERE p.workspace_id=? AND g.user_id=?',[c.w.id,targetId])).rows;
   if(!wm&&!guests.length)fail(404,'NOT_FOUND');
   if(wm&&!c.workspaceAdmin)fail(403,'ROLE_FORBIDDEN');
   const ids=(await projects(tx,c.w.id)).map(p=>p.id);
   const affected=c.workspaceAdmin?guests:guests.filter(g=>g.project_id===projectId);
   if(!wm&&!affected.length)fail(404,'NOT_FOUND');
   if(c.w.owner_id!==userId&&(wm?.role==='admin'||affected.some(g=>g.role==='admin')))fail(403,'ROLE_FORBIDDEN');
   const target=await one(tx,'SELECT * FROM users WHERE id=?',[targetId]);
   if(method==='PATCH'){
    if(wm)await exec(tx,'UPDATE app_workspace_members SET role=? WHERE workspace_id=? AND user_id=?',[body.role,c.w.id,targetId]);
    else for(const g of affected)await exec(tx,'UPDATE app_project_guests SET role=? WHERE project_id=? AND user_id=?',[body.role,g.project_id,targetId]);
   }else{
    if(wm)await exec(tx,'DELETE FROM app_workspace_members WHERE workspace_id=? AND user_id=?',[c.w.id,targetId]);
    for(const g of affected){await exec(tx,'DELETE FROM app_project_guests WHERE project_id=? AND user_id=?',[g.project_id,targetId]);await exec(tx,'DELETE FROM content_members WHERE project_id=? AND user_id=?',[g.project_id,targetId]);}
    await revokeReportAccess(tx,targetId,c.workspaceAdmin?ids:affected.map(g=>g.project_id),stamp);
    // An invitation sent before removal cannot silently restore the removed grant.
    const pending=(await exec(tx,'SELECT * FROM app_invites WHERE workspace_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND (invited_by=? OR email=?)',[c.w.id,targetId,target.email.toLowerCase()])).rows;
    for(const inv of pending)if(c.workspaceAdmin||(inv.scope==='project'&&json(inv).every(p=>affected.some(g=>g.project_id===p))))await exec(tx,'UPDATE app_invites SET revoked_at=? WHERE id=?',[stamp,inv.id]);
   }
   await audit(tx,c,userId,method==='PATCH'?'team.role_changed':'team.removed',target,{role:body.role||null,projectIds:wm?ids:affected.map(g=>g.project_id)},stamp);
   return reply({ok:true});
  }
  if(section==='transfer'&&!targetId&&method==='POST'){
   object(body,['userId']);if(typeof body.userId!=='string'||body.userId===userId)fail(422,'INVALID_TRANSFER_TARGET');
   const m=await one(tx,'SELECT role FROM app_workspace_members WHERE workspace_id=? AND user_id=?',[c.w.id,body.userId]);
   if(m?.role!=='admin')fail(422,'WORKSPACE_ADMIN_REQUIRED');
   if(await one(tx,'SELECT id FROM app_workspaces WHERE owner_id=?',[body.userId]))fail(409,'TARGET_ALREADY_WORKSPACE_OWNER');
   await exec(tx,'UPDATE app_workspaces SET owner_id=? WHERE id=?',[body.userId,c.w.id]);
   await exec(tx,'UPDATE app_projects SET owner_id=? WHERE workspace_id=?',[body.userId,c.w.id]);
   await exec(tx,'DELETE FROM app_workspace_members WHERE workspace_id=? AND user_id=?',[c.w.id,body.userId]);
   await exec(tx,"INSERT INTO app_workspace_members VALUES (?,?,'admin',?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role='admin'",[c.w.id,userId,stamp]);
   await audit(tx,c,userId,'team.ownership_transferred',await one(tx,'SELECT * FROM users WHERE id=?',[body.userId]),{previousOwner:userId},stamp);
   return reply({ok:true});
  }
  fail(405,'METHOD_NOT_ALLOWED');
 });
}
