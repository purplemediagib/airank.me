import test from 'node:test';
import assert from 'node:assert/strict';
import {planFixture} from './plan-fixture.mjs';
import {sessionContext} from '../src/app/session-context.mjs';
import {TRIAL_MS} from '../src/common/plans.mjs';
const fixture=fn=>async()=>{const f=await planFixture();try{await fn(f);}finally{f.close();}};
test('pre-brand session context uses immutable signup anchor and SELECT only',fixture(async f=>{
 const signup=f.now();f.advance(2*86400000);
 const readOnly={execute:q=>{assert.match(q.sql,/^SELECT /);return f.db.execute(q);}};
 const context=await sessionContext(readOnly,'alice',f.now());
 assert.equal(context.accountCreatedAt,signup);assert.equal(context.state,'ready');assert.deepEqual(context.ownedWorkspaces,[]);
 assert.deepEqual(context.provisionalTrial,{source:'account_signup',startsAt:signup,endsAt:signup+TRIAL_MS});
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM app_workspaces WHERE owner_id=?').get('alice').n,0);
 assert.deepEqual((await f.call('GET','/v1/app/session')).data.lifecycle,context);
 const p=await f.create();const after=(await f.call('GET','/v1/app/session')).data.lifecycle;
 assert.equal(after.provisionalTrial,null);assert.equal(after.ownedWorkspaces[0].id,p.workspaceId);
 assert.equal(after.ownedWorkspaces[0].trialStartedAt,signup);assert.equal(after.ownedWorkspaces[0].trialEndsAt,signup+TRIAL_MS);
}));
test('anonymous expired and report-bearer sessions expose no context',fixture(async f=>{
 for(const headers of [{cookie:''},{cookie:'__Host-airank_session=missing'},{authorization:'Bearer airank_rt_'+'a'.repeat(43)}]){
  const r=(await f.call('GET','/v1/app/session',{},'alice',headers)).data;assert.equal(r.authenticated,false);assert.equal(r.lifecycle,null);assert.equal(r.accountCreated,false);
 }
 f.sql.prepare('UPDATE sessions SET expires_at=?').run(f.now());assert.equal((await f.call('GET','/v1/app/session')).data.lifecycle,null);
}));
test('invited members and guests disclose no foreign workspace context or provisional owner trial',fixture(async f=>{
 const p=await f.create();
 f.sql.prepare('INSERT INTO app_workspace_members VALUES(?,?,?,?)').run(p.workspaceId,'member','admin',f.now());
 f.sql.prepare('INSERT INTO app_project_guests VALUES(?,?,?,?)').run(p.id,'viewer','viewer',f.now());
 for(const user of ['member','viewer']){
  const c=await sessionContext(f.db,user,f.now());assert.deepEqual(c.ownedWorkspaces,[]);assert.equal(c.hasNonOwnerMembership,true);assert.equal(c.provisionalTrial,null);assert(!JSON.stringify(c).includes(p.workspaceId));
 }
 assert.equal((await sessionContext(f.db,'bob',f.now())).hasNonOwnerMembership,false);
}));
test('legacy paid expired and transferred workspaces retain actual dates and do not reset trial',fixture(async f=>{
 const legacy=await sessionContext(f.db,'old',f.now());assert.equal(legacy.ownedWorkspaces[0].plan,null);assert.equal(legacy.ownedWorkspaces[0].status,'legacy');assert.equal(legacy.provisionalTrial,null);assert(legacy.accountCreatedAt<f.now()-TRIAL_MS);
 const p=await f.create();const anchor=f.now();f.advance(TRIAL_MS+1);
 let c=await sessionContext(f.db,'alice',f.now());assert.equal(c.ownedWorkspaces[0].status,'trialing');assert.equal(c.ownedWorkspaces[0].trialEndsAt,anchor+TRIAL_MS);
 await f.push(p.workspaceId,'pro');c=await sessionContext(f.db,'alice',f.now());assert.equal(c.ownedWorkspaces[0].status,'active');assert.equal(c.provisionalTrial,null);
 f.sql.prepare('UPDATE app_workspaces SET owner_id=? WHERE id=?').run('bob',p.workspaceId);
 assert.deepEqual((await sessionContext(f.db,'alice',f.now())).ownedWorkspaces,[]);
 c=await sessionContext(f.db,'bob',f.now());assert.equal(c.ownedWorkspaces[0].ownerUserId,'bob');assert.equal(c.ownedWorkspaces[0].trialStartedAt,anchor);
 assert.throws(()=>f.sql.prepare('UPDATE app_workspaces SET owner_id=? WHERE id=?').run('bob','ws_legacy'),/UNIQUE/);
}));
test('missing migration or invalid signup fails closed without a fresh clock anchor',fixture(async f=>{
 for(const bad of [null,-1,0,f.now()+1,'invalid']){
  // users.created_at is NOT NULL: use a read-only result wrapper to exercise corrupt metadata.
  const db={execute:async q=>q.sql==='SELECT created_at FROM users WHERE id=?'?{rows:[{created_at:bad}]}:f.db.execute(q)};
  const c=await sessionContext(db,'alice',f.now());assert.equal(c.accountCreatedAt,null);assert.equal(c.provisionalTrial,null);
 }
 f.sql.prepare('DELETE FROM app_migrations WHERE id=?').run('app-022-plan-limits');
 const c=(await f.call('GET','/v1/app/session')).data.lifecycle;assert.equal(c.state,'unknown');assert.equal(c.provisionalTrial,null);assert.deepEqual(c.ownedWorkspaces,[]);
}));
test('old pre-brand account remains old even when first brand is attempted later',fixture(async f=>{
 f.sql.prepare('UPDATE users SET created_at=? WHERE id=?').run(f.now()-30*86400000,'bob');
 const c=await sessionContext(f.db,'bob',f.now());assert(c.provisionalTrial.endsAt<f.now());
 await assert.rejects(f.create('bob'),e=>e.code==='PLAN_LIMIT');
 assert.equal((await sessionContext(f.db,'bob',f.now())).accountCreatedAt,c.accountCreatedAt);
}));
