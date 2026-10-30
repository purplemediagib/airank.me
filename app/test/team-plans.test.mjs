import test from 'node:test';
import assert from 'node:assert/strict';
import {planFixture} from './plan-fixture.mjs';
import {teamSeatUsage} from '../src/app/team-plans.mjs';
const fixture=fn=>async()=>{const f=await planFixture();try{const p=await f.create();await fn(f,p);}finally{f.close();}};
const invite=(f,p,email,scope='workspace')=>f.call('POST',`/v1/projects/${p.id}/team/invites`,{email,role:'member',scope,...(scope==='project'?{projectIds:[p.id]}:{})});
const accept=(f,r,user)=>f.call('POST',`/v1/app/invites/${r.data.token}/accept`,{},user);
const limited=p=>assert.rejects(p,e=>e.code==='PLAN_LIMIT'&&e.status===402);

test('Starter owner plus one invite uses both seats; acceptance consumes reservation without double charging',fixture(async(f,p)=>{
 await f.push(p.workspaceId,'starter');
 const r=await invite(f,p,'bob@example.test');
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),2);
 await limited(invite(f,p,'member@example.test'));
 await accept(f,r,'bob');
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),2);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM app_workspace_members WHERE workspace_id=?').get(p.workspaceId).n,1);
 await limited(invite(f,p,'viewer@example.test'));
}));
test('parallel invitations at the last seat cannot exceed capacity',fixture(async(f,p)=>{
 await f.push(p.workspaceId,'starter');
 const r=await Promise.allSettled([invite(f,p,'bob@example.test'),invite(f,p,'member@example.test')]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(r.filter(x=>x.status==='rejected'&&x.reason.code==='PLAN_LIMIT').length,1);
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),2);
}));
test('Pro has five seats including pending invites, Advanced has no seat cap',fixture(async(f,p)=>{
 await f.push(p.workspaceId,'pro');
 for(let i=0;i<4;i++)await invite(f,p,`seat${i}@example.test`);
 await limited(invite(f,p,'extra@example.test'));
 await f.push(p.workspaceId,'advanced',2);
 await invite(f,p,'extra@example.test');
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),6);
}));
test('Starter forbids new project guests and stale project invite acceptance after downgrade',fixture(async(f,p)=>{
 await f.push(p.workspaceId,'pro');
 const r=await invite(f,p,'bob@example.test','project');
 await f.push(p.workspaceId,'starter',2);
 await limited(accept(f,r,'bob'));
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM app_project_guests').get().n,0);
 assert.equal(f.sql.prepare('SELECT accepted_at FROM app_invites WHERE id=?').get(r.data.invite.id).accepted_at,null);
 await limited(invite(f,p,'viewer@example.test','project'));
}));
test('downgrade blocks stale over-cap acceptance and resend, but revoking releases seats',fixture(async(f,p)=>{
 await f.push(p.workspaceId,'pro');
 const bob=await invite(f,p,'bob@example.test'),other=await invite(f,p,'member@example.test');
 await f.push(p.workspaceId,'starter',2);
 await limited(accept(f,bob,'bob'));
 await limited(f.call('POST',`/v1/projects/${p.id}/team/invites/${bob.data.invite.id}/resend`,{}));
 await f.call('POST',`/v1/projects/${p.id}/team/invites/${other.data.invite.id}/revoke`,{});
 await accept(f,bob,'bob');
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),2);
}));
test('inactive subscription cannot accept outstanding invites; revocation remains available',fixture(async(f,p)=>{
 await f.push(p.workspaceId,'pro');const r=await invite(f,p,'bob@example.test');
 await f.push(p.workspaceId,'pro',2,'inactive');
 await limited(accept(f,r,'bob'));
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM app_workspace_members').get().n,0);
 await f.call('POST',`/v1/projects/${p.id}/team/invites/${r.data.invite.id}/revoke`,{});
}));
test('trial expiration gates acceptance even though invite path has no project-plan middleware',fixture(async(f,p)=>{
 const r=await invite(f,p,'bob@example.test');
 // Expire subscription without expiring the invite, as could happen near trial end.
 f.sql.prepare('UPDATE app_workspaces SET trial_ends_at=? WHERE id=?').run(f.now(),p.workspaceId);
 await limited(accept(f,r,'bob'));
 assert.equal(f.sql.prepare('SELECT accepted_at FROM app_invites WHERE id=?').get(r.data.invite.id).accepted_at,null);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM app_workspace_members WHERE workspace_id=?').get(p.workspaceId).n,0);
}));
test('expired pending invites continue reserving seats to match existing app usage; revoke frees slot',fixture(async(f,p)=>{
 await f.push(p.workspaceId,'starter');const r=await invite(f,p,'bob@example.test');
 f.sql.prepare('UPDATE app_invites SET expires_at=? WHERE id=?').run(f.now()-1,r.data.invite.id);
 await limited(invite(f,p,'member@example.test'));
 await f.call('POST',`/v1/projects/${p.id}/team/invites/${r.data.invite.id}/revoke`,{});
 await invite(f,p,'member@example.test');
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),2);
}));
test('legacy null-plan entitlement compatibility is unchanged',fixture(async(f,p)=>{
 f.sql.prepare("UPDATE app_workspaces SET plan=NULL,plan_status='legacy' WHERE id=?").run(p.workspaceId);
 for(let i=0;i<6;i++)await invite(f,p,`legacy${i}@example.test`);
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),7);
}));
test('usage matches displayed workspace and project entries across roles and brands',fixture(async(f,p)=>{
 await f.push(p.workspaceId,'pro');
 const q=await f.create();
 for(const id of [p.id,q.id])f.sql.prepare('INSERT INTO app_project_guests VALUES(?,?,?,?)').run(id,'bob','viewer',f.now());
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),2); // one grouped guest
 f.sql.prepare('UPDATE app_project_guests SET role=? WHERE project_id=? AND user_id=?').run('member',q.id,'bob');
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),3); // role groups match Team.members
 f.sql.prepare('INSERT INTO app_workspace_members VALUES(?,?,?,?)').run(p.workspaceId,'bob','member',f.now());
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),4); // workspace entry is separate
 await invite(f,p,'viewer@example.test');
 await limited(invite(f,q,'member@example.test')); // cap is workspace-wide
}));
const splitFixture=fn=>fixture(async(f,p)=>{
 await f.push(p.workspaceId,'pro');const q=await f.create();
 for(const id of [p.id,q.id])f.sql.prepare('INSERT INTO app_project_guests VALUES(?,?,?,?)').run(id,'bob','viewer',f.now());
 f.sql.prepare('INSERT INTO app_project_guests VALUES(?,?,?,?)').run(p.id,'member','admin',f.now());
 await invite(f,p,'one@example.test');await invite(f,p,'two@example.test');
 await fn(f,p,q);
});
test('project-admin role edit cannot split a grouped guest beyond Pro capacity; transaction rolls back',splitFixture(async(f,p)=>{
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),5);
 await limited(f.call('PATCH',`/v1/projects/${p.id}/team/members/bob`,{role:'member'},'member'));
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),5);
 assert.equal(f.sql.prepare('SELECT role FROM app_project_guests WHERE project_id=? AND user_id=?').get(p.id,'bob').role,'viewer');
}));
test('neutral and reducing role edits remain available when active workspace is over downgraded cap',splitFixture(async(f,p)=>{
 // Simulate preexisting over-cap grants, not newly admitted through this patch.
 f.sql.prepare('UPDATE app_project_guests SET role=? WHERE project_id=? AND user_id=?').run('member',p.id,'bob');
 await f.push(p.workspaceId,'starter',2);
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),6);
 await f.call('PATCH',`/v1/projects/${p.id}/team/members/bob`,{role:'admin'},'member');
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),6); // neutral
 await f.call('PATCH',`/v1/projects/${p.id}/team/members/bob`,{role:'viewer'}); // owner can lower admin
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),5); // reduces, still over2
}));
test('ownership transfer cannot reactivate an excluded owner guest grant above cap',fixture(async(f,p)=>{
 await f.push(p.workspaceId,'pro');
 f.sql.prepare('INSERT INTO app_workspace_members VALUES(?,?,?,?)').run(p.workspaceId,'bob','admin',f.now());
 f.sql.prepare('INSERT INTO app_project_guests VALUES(?,?,?,?)').run(p.id,'alice','member',f.now());
 for(let i=0;i<3;i++)await invite(f,p,`transfer${i}@example.test`);
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),5);
 await limited(f.call('POST',`/v1/projects/${p.id}/team/transfer`,{userId:'bob'}));
 assert.equal(f.sql.prepare('SELECT owner_id FROM app_workspaces WHERE id=?').get(p.workspaceId).owner_id,'alice');
 assert.equal(f.sql.prepare('SELECT owner_id FROM app_projects WHERE id=?').get(p.id).owner_id,'alice');
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),5);
}));
test('neutral ownership transfer remains available above an active downgraded cap',fixture(async(f,p)=>{
 await f.push(p.workspaceId,'pro');
 f.sql.prepare('INSERT INTO app_workspace_members VALUES(?,?,?,?)').run(p.workspaceId,'bob','admin',f.now());
 for(let i=0;i<3;i++)await invite(f,p,`neutral${i}@example.test`);
 await f.push(p.workspaceId,'starter',2);
 await f.call('POST',`/v1/projects/${p.id}/team/transfer`,{userId:'bob'});
 assert.equal(await teamSeatUsage(f.db,p.workspaceId),5);
 assert.equal(f.sql.prepare('SELECT owner_id FROM app_workspaces WHERE id=?').get(p.workspaceId).owner_id,'bob');
}));

test('concurrent stale accepts after downgrade both roll back without admitting above cap',fixture(async(f,p)=>{
 await f.push(p.workspaceId,'pro');
 const a=await invite(f,p,'bob@example.test'),b=await invite(f,p,'member@example.test');
 await f.push(p.workspaceId,'starter',2);
 const results=await Promise.allSettled([accept(f,a,'bob'),accept(f,b,'member')]);
 assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='PLAN_LIMIT').length,2);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM app_workspace_members WHERE workspace_id=?').get(p.workspaceId).n,0);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM app_invites WHERE workspace_id=? AND accepted_at IS NOT NULL').get(p.workspaceId).n,0);
}));
