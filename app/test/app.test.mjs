import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrations } from '../src/migrate.mjs';
import { migrateApp, checksum, migrationId } from '../src/app/migration.mjs';
import { createAppService, safeReturn, csrfFor, clientsFromEnv } from '../src/app/service.mjs';
import { hashToken } from '../src/common/utils.mjs';
import { migrateProjectScans } from '../src/app/scan-migration.mjs';
import { appScans } from '../src/app/scans.mjs';
import { migrateMonitoring } from '../src/monitoring/migration.mjs';
import { monitoringService } from '../src/monitoring/service.mjs';

const origin = 'https://preview.example.com';
const clients = { preview: { origin, redirectUri: `${origin}/api/airank/v1/app/google/callback` } };
const data = { brandName: 'Example', aliases: ['Example Oy'], ownedDomains: ['example.fi'], categoryFi: 'suomalaiset matkapuhelinliittymät' };
function adapter(sqlite) {
  const execute = async q => {
    const s = typeof q === 'string' ? q : q.sql;
    const args = typeof q === 'string' ? [] : q.args || [];
    const stmt = sqlite.prepare(s);
    if (/^\s*(SELECT|PRAGMA)|RETURNING/i.test(s)) return { rows: stmt.all(...args) };
    const r = stmt.run(...args); return { rows: [], rowsAffected: Number(r.changes) };
  };
  return { execute, transaction: async () => {
    sqlite.exec('BEGIN IMMEDIATE');
    return { execute, commit: async () => sqlite.exec('COMMIT'), rollback: async () => sqlite.exec('ROLLBACK'), close: () => {} };
  } };
}
async function fixture(file = ':memory:') {
  const sqlite = new DatabaseSync(file);
  sqlite.exec('PRAGMA foreign_keys=ON');
  const db = adapter(sqlite);
  for (const ddl of migrations) sqlite.exec(ddl);
  for (const id of ['alice', 'bob']) {
    sqlite.prepare('INSERT OR IGNORE INTO users VALUES (?,?,?,?,?,?,?)').run(id, `google-${id}`, `${id}@example.test`, id, '', 1, 1);
    sqlite.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?,?,?)').run(hashToken(`token-${id}`), id, Date.now() + 3600000, 1);
  }
  await migrateApp(db);
  let exchanges = 0;
  const service = createAppService({
    db, clients, env: { GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret', RATE_LIMIT_SECRET: 'isolated-test-rate-secret-at-least-24' },
    exchange: async args => { exchanges++; assert.equal(args.redirectUri, clients.preview.redirectUri); assert.ok(args.codeVerifier.length > 32); return args.code; },
    verify: async (code, options) => { assert.ok(options.nonce); if (code === 'bad') throw new Error('bad nonce'); return { googleSub: 'google-alice', email: 'alice@example.test', name: 'Alice', picture: '' }; },
  });
  const call = (method, path, body, user = 'alice', extra = {}) => service({
    method, path, body, headers: { 'x-airank-client': 'preview', origin, 'content-type': 'application/json',
      cookie: `__Host-airank_session=token-${user}`, 'x-csrf-token': csrfFor(`token-${user}`), ...extra },
  });
  return { sqlite, db, service, call, exchanges: () => exchanges };
}
const denied = async (promise, status) => assert.rejects(promise, e => e.status === status);
test('Google connections retain app session, CSRF, active project ownership and setup-needed state',async()=>{
 const f=await fixture();try{
  const p=(await f.call('POST','/v1/projects',data)).data;
  const route=`/v1/projects/${p.id}/connections/ga4`;
  assert.equal((await f.call('GET',route)).data.status,'setup_required');
  await denied(f.call('GET',route,undefined,'bob'),404);
  await denied(f.call('GET',route,undefined,'alice',{cookie:''}),401);
  await denied(f.call('POST',route+'/connect',{},'alice',{'x-csrf-token':'wrong'}),403);
  await denied(f.call('PUT',route+'/selection',{property:'properties/123'},'alice',{origin:'https://evil.example'}),403);
  await denied(f.call('DELETE',route,{},'alice',{'x-csrf-token':'wrong'}),403);
  await denied(f.call('POST',route+'/connect',{}),503);
 }finally{f.sqlite.close();}
});
test('accounts can create multiple active workspaces without a workspace-count cap',async()=>{
 const f=await fixture();try{
  for(let i=0;i<8;i++)assert.equal((await f.call('POST','/v1/projects',{...data,brandName:`Business ${i}`})).status,201);
  assert.equal((await f.call('GET','/v1/projects')).data.filter(p=>p.status==='active').length,8);
  assert.equal((await f.call('GET','/v1/projects',undefined,'bob')).data.length,0);
 }finally{f.sqlite.close();}
});
async function seedTrackedPrompts(f, projectId, texts) {
 await migrateMonitoring(f.db);
  for(const text of texts) await monitoringService({db:f.db,method:'POST',path:`/v1/projects/${projectId}/prompts`,userId:'alice',env:{TRACKED_PROMPT_LIMIT:'100'},body:{text,topic:'General',tags:[],kind:'neutral'}});
}

test('signed-in scans remain retired; monitoring bootstrap validates input after authentication and CSRF', async () => {
 const f=await fixture();
 try {
   for(const path of ['/v1/scans/preview','/v1/scans','/v1/projects/project/monitoring-runs']){
    await denied(f.call('POST',path,{}),path.endsWith('/monitoring-runs')?422:410);
    await denied(f.call('POST',path,{},'alice',{'x-csrf-token':'wrong'}),403);
    await denied(f.call('POST',path,{},'alice',{cookie:''}),401);
   }
   assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM scan_jobs').get().n,0);
 } finally {f.sqlite.close();}
});

test('Finnish first check requires the project tracked prompt set; it never falls back to generated prompts', async () => {
 const f=await fixture();
 try {
  await migrateProjectScans(f.db);
  await migrateMonitoring(f.db);
  const p=(await f.call('POST','/v1/projects',data)).data;
  const input={project_id:p.id,project_version:1,domain:'example.fi',brand_name:'Example',aliases:[],category_fi:data.categoryFi,market:'FI',language:'fi'};
  await assert.rejects(appScans({db:f.db,method:'POST',path:'/v1/scans/preview',body:input,userId:'alice'}),e=>e.status===422&&e.code==='CONTEXT_PROMPTS_REQUIRED');
 } finally { f.sqlite.close(); }
});

test('authenticated scan limit returns the weekly-cap reason and supports an opt-in testing bypass', async () => {
 const f=await fixture();
 try {
  await migrateProjectScans(f.db);
  const p=(await f.call('POST','/v1/projects',data)).data;
  await seedTrackedPrompts(f,p.id,['Where can travellers compare mobile plans?','Which service offers reliable coverage?','What makes a mobile plan suitable for frequent travel?']);
  const input={project_id:p.id,project_version:1,domain:'example.fi',brand_name:'Example',aliases:[],category_fi:data.categoryFi,market:'FI',language:'fi'};
  const env={RATE_LIMIT_SECRET:'isolated-test-rate-secret-at-least-24',APP_ENV:'production'};
  const config={enabledProviders:['openai'],scanPrompts:1};
  const preview=(await appScans({db:f.db,method:'POST',path:'/v1/scans/preview',body:input,userId:'alice',env,config})).data;
  for(let i=0;i<5;i++) await f.db.execute({sql:'INSERT INTO rate_events (id,fingerprint,domain,requested_at) VALUES (?,?,?,?)',args:[`prior-${i}`,`other-user-${i}`,'example.fi',Date.now()-i]});
  const submit={...input,profile_confirmed:true,methodology:preview.methodology,preview_hash:preview.preview_hash,submission_id:'weekly-cap-submission-1234'};
  await assert.rejects(
   appScans({db:f.db,method:'POST',path:'/v1/scans',body:submit,userId:'alice',env,config}),
   e=>e.status===429&&e.code==='DOMAIN_RATE_LIMIT',
  );
  const accepted=await appScans({
   db:f.db,method:'POST',path:'/v1/scans',
   body:{...submit,submission_id:'testing-bypass-submission-1234'},
   userId:'alice',env:{...env,DISABLE_AUTHENTICATED_SCAN_LIMITS:'true'},config,
  });
  assert.equal(accepted.status,202);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM scan_jobs').get().n,1);
 } finally {f.sqlite.close();}
});

test('owned report authoritative 4/6, zero, unavailable, partial, failure and legacy states', async () => {
 const f=await fixture();
 try {
  await migrateProjectScans(f.db);
  const p=(await f.call('POST','/v1/projects',data)).data;
  await seedTrackedPrompts(f,p.id,['Where can travellers compare mobile plans?','Which service offers reliable coverage?','What makes a mobile plan suitable for frequent travel?']);
  const input={project_id:p.id,project_version:1,domain:'example.fi',brand_name:'Example',aliases:[],category_fi:data.categoryFi,market:'FI',language:'fi'};
  const config={enabledProviders:['openai','claude'],scanPrompts:3};
  const call=(method,path,body)=>appScans({db:f.db,method,path,body,userId:'alice',config,env:{RATE_LIMIT_SECRET:'isolated-test-rate-secret-at-least-24'}});
  const preview=(await call('POST','/v1/scans/preview',input)).data;
  const accepted=(await call('POST','/v1/scans',{...input,preview_hash:preview.preview_hash,methodology:preview.methodology,profile_confirmed:true,submission_id:'fixture-report-123456'})).data;
  const path=`/v1/scans/${accepted.id}`;
  const prompts=(await call('GET',path)).data.prompts;
  let index=0;
  for(const provider of config.enabledProviders) for(const prompt of prompts) {
   f.sqlite.prepare('INSERT INTO observations (id,scan_id,prompt_id,provider,provider_status,answer_text,brand_mentioned,observed_at) VALUES (?,?,?,?,?,?,?,?)').run(`obs-${index}`,accepted.id,prompt.id,provider,'success','Fixture answer',index++<4?1:0,1);
  }
  f.sqlite.prepare("UPDATE scan_jobs SET status='completed'").run();
  assert.equal((await call('GET',path)).data.score.value,6.7);
  f.sqlite.prepare('UPDATE observations SET brand_mentioned=0').run();
  assert.equal((await call('GET',path)).data.score.value,0);
  f.sqlite.prepare("UPDATE observations SET provider_status='failed' WHERE provider='claude'").run();
  assert.equal((await call('GET',path)).data.score.state,'partial');
  f.sqlite.prepare("UPDATE observations SET provider_status='failed'").run();
  f.sqlite.prepare("UPDATE scan_jobs SET status='no_measurements'").run();
  assert.equal((await call('GET',path)).data.score.value,null);
  assert.equal((await call('GET',path)).data.score.state,'unavailable');
  f.sqlite.prepare("UPDATE scan_jobs SET status='failed'").run();
  assert.equal((await call('GET',path)).data.status,'failed');
  f.sqlite.prepare('DELETE FROM scan_profiles').run();
  assert.equal((await call('GET',path)).data.score.state,'legacy');
 } finally {f.sqlite.close();}
});

test('two accounts: project ownership, nested versions, archive and forged user IDs', async () => {
  const f = await fixture();
  try {
    const created = (await f.call('POST', '/v1/projects', data)).data;
    assert.equal(created.market, 'FI'); assert.equal(created.version, 1);
    assert.equal((await f.call('GET', '/v1/projects', undefined, 'bob')).data.length, 0);
    for (const path of [`/v1/projects/${created.id}`, `/v1/projects/${created.id}/versions`]) await denied(f.call('GET', path, undefined, 'bob'), 404);
    await denied(f.call('PATCH', `/v1/projects/${created.id}`, { ...data, expectedVersion: 1 }, 'bob'), 404);
    await denied(f.call('POST', `/v1/projects/${created.id}/archive`, { expectedVersion: 1 }, 'bob'), 404);
    await denied(f.call('POST', '/v1/projects', { ...data, owner_id: 'bob' }), 422);
    await denied(f.call('PATCH', '/v1/me/preferences', { expectedVersion: 0, lastProjectId: created.id }, 'bob'), 404);
  } finally { f.sqlite.close(); }
});

test('identity updates append immutable versions; stale writes conflict; archive keeps history', async () => {
  const f = await fixture();
  try {
    const p = (await f.call('POST', '/v1/projects', data)).data;
    const updated = (await f.call('PATCH', `/v1/projects/${p.id}`, { ...data, brandName: 'Changed', expectedVersion: 1 })).data;
    assert.equal(updated.version, 2);
    await denied(f.call('PATCH', `/v1/projects/${p.id}`, { ...data, expectedVersion: 1 }), 409);
    const versions = (await f.call('GET', `/v1/projects/${p.id}/versions`)).data;
    assert.deepEqual(versions.map(v => v.brandName), ['Changed', 'Example']);
    await f.call('PATCH', '/v1/me/preferences', { expectedVersion: 0, lastProjectId: p.id, locale: 'en' });
    await f.call('POST', `/v1/projects/${p.id}/archive`, { expectedVersion: 2 });
    assert.equal((await f.call('GET', '/v1/me/preferences')).data.lastProjectId, null);
    assert.equal((await f.call('GET', `/v1/projects/${p.id}/versions`)).data.length, 3);
    await denied(f.call('PATCH', '/v1/me/preferences', { expectedVersion: 2, lastProjectId: p.id }), 409);
  } finally { f.sqlite.close(); }
});

test('CSRF/origin/session expiry and logout are enforced before writes', async () => {
  const f = await fixture();
  try {
    for (const extra of [{ origin: '' }, { origin: 'https://attacker.test' }, { 'x-csrf-token': 'bad' }, { 'x-csrf-token': csrfFor('token-bob') }]) await denied(f.call('POST', '/v1/projects', data, 'alice', extra), 403);
    await denied(f.call('POST', '/v1/projects', data, 'alice', { cookie: '' }), 401);
    const session = await f.call('GET', '/v1/app/session');
    assert.equal(session.data.user.id, 'alice'); assert.equal(session.data.csrfToken, csrfFor('token-alice'));
    const logout = await f.call('POST', '/v1/app/logout', {});
    assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
    await denied(f.call('GET', '/v1/projects'), 401);
    f.sqlite.prepare('UPDATE sessions SET expires_at=1').run();
    assert.equal((await f.call('GET', '/v1/app/session', undefined, 'bob')).data.authenticated, false);
  } finally { f.sqlite.close(); }
});

test('migration repeatability preserves users, sessions, old scans and original observations', async () => {
  const f = await fixture();
  try {
    f.sqlite.prepare('INSERT INTO scan_jobs(id,domain,brand_name,status,requested_at) VALUES (?,?,?,?,?)').run('old', 'old.fi', 'Old', 'completed', 1);
    f.sqlite.prepare('INSERT INTO scan_prompts(id,scan_id,sequence,prompt_text,prompt_version) VALUES (?,?,?,?,?)').run('prompt', 'old', 1, 'original question', 'v1');
    f.sqlite.prepare('INSERT INTO observations(id,scan_id,prompt_id,provider,provider_status,answer_text,observed_at) VALUES (?,?,?,?,?,?,?)').run('ob', 'old', 'prompt', 'openai', 'success', 'original evidence', 1);
    await migrateApp(f.db); await migrateApp(f.db);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM users').get().n, 2);
    assert.equal(f.sqlite.prepare('SELECT answer_text FROM observations').get().answer_text, 'original evidence');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM app_migrations').get().n, 1);
    f.sqlite.prepare('UPDATE app_migrations SET checksum=?').run('tampered');
    await assert.rejects(migrateApp(f.db), /checksum mismatch/);
  } finally { f.sqlite.close(); }
});

test('projects and preferences survive actual SQLite close/reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'airank-persist-'));
  try {
    const path = join(dir, 'fixture.db');
    const a = await fixture(path);
    await migrateProjectScans(a.db);
    const p = (await a.call('POST', '/v1/projects', data)).data;
    await seedTrackedPrompts(a,p.id,['Where can travellers compare mobile plans?']);
    const input={project_id:p.id,project_version:1,domain:'example.fi',brand_name:'Example',aliases:[],category_fi:data.categoryFi,market:'FI',language:'fi'};
    // Construct a pre-upgrade legacy record through the retained historical
    // handler; the authenticated HTTP write route is tested as retired above.
    const legacy=(path,body)=>appScans({db:a.db,method:'POST',path,body,userId:'alice',env:{RATE_LIMIT_SECRET:'fixture-rate-secret-at-least-24'}});
    const preview=(await legacy('/v1/scans/preview',input)).data;
    const scan=(await legacy('/v1/scans',{...input,preview_hash:preview.preview_hash,methodology:preview.methodology,profile_confirmed:true,submission_id:'persisted-submission-fixture'})).data;
    await a.call('PATCH', '/v1/me/preferences', { expectedVersion: 0, locale: 'en', timezone: 'Europe/London', lastProjectId: p.id });
    a.sqlite.close();
    const b = await fixture(path);
    assert.equal((await b.call('GET', '/v1/projects')).data[0].id, p.id);
    assert.equal((await b.call('GET', `/v1/projects/${p.id}/scans`)).data[0].id, scan.id);
    assert.equal((await b.call('GET', `/v1/scans/${scan.id}`)).data.score.state,'pending');
    assert.equal((await b.call('GET', '/v1/me/preferences')).data.locale, 'en');
    await denied(b.call('PATCH', '/v1/me/preferences', { expectedVersion: 0, locale: 'fi' }), 409);
    b.sqlite.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bound OAuth PKCE/state/callback is one-use, rotates session and reuses Google identity', async () => {
  const f = await fixture();
  try {
    const start = await f.service({ method: 'GET', path: '/v1/app/google/start', headers: { 'x-airank-client': 'preview' }, query: new URLSearchParams({ return_to: '/en/settings?project=x#identity' }) });
    const location = new URL(start.headers.location);
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    const state = location.searchParams.get('state');
    const headers = { 'x-airank-client': 'preview', cookie: `__Host-airank_app_oauth=${state}; __Host-airank_session=token-alice` };
    const query = new URLSearchParams({ state, code: 'good' });
    const bad = await f.service({ method: 'GET', path: '/v1/app/google/callback', headers: { ...headers, cookie: '' }, query });
    assert.match(bad.headers.location, /oauth_failed/);
    assert.equal(f.exchanges(), 0);
    const callback = await f.service({ method: 'GET', path: '/v1/app/google/callback', headers, query });
    assert.equal(callback.headers.location, `${origin}/en/settings?project=x#identity`);
    assert.equal(f.sqlite.prepare('SELECT locale FROM app_preferences WHERE user_id=?').get('alice').locale,'en');
    assert.equal(callback.headers['set-cookie'].length, 2);
    assert.match(callback.headers['set-cookie'][1], /HttpOnly; Secure; SameSite=Lax/);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM users').get().n, 2);
    assert.equal((await f.call('GET', '/v1/app/session')).data.authenticated, false);
    await f.service({ method: 'GET', path: '/v1/app/google/callback', headers, query });
    assert.equal(f.exchanges(), 1);
  } finally { f.sqlite.close(); }
});

test('OAuth expiry, revoked client binding and token verification failure never create sessions', async () => {
  const f = await fixture();
  try {
    const begin = async () => {
      const s = await f.service({ method: 'GET', path: '/v1/app/google/start', headers: { 'x-airank-client': 'preview' } });
      return new URL(s.headers.location).searchParams.get('state');
    };
    const state = await begin();
    f.sqlite.prepare('UPDATE app_oauth_states SET expires_at=1').run();
    const callback = s => f.service({ method: 'GET', path: '/v1/app/google/callback', headers: { 'x-airank-client': 'preview', cookie: `__Host-airank_app_oauth=${s}` }, query: new URLSearchParams({ code: 'bad', state: s }) });
    assert.match((await callback(state)).headers.location, /oauth_failed/); assert.equal(f.exchanges(), 0);
    assert.match((await callback(await begin())).headers.location, /oauth_failed/);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sessions').get().n, 2);
    const changed = await begin();
    f.sqlite.prepare('UPDATE app_oauth_states SET redirect_uri=?').run('https://attacker.test/callback');
    assert.match((await callback(changed)).headers.location, /oauth_failed/);
    assert.equal(f.exchanges(), 1);
  } finally { f.sqlite.close(); }
});

test('safe returns, exact client registry, server validation and readiness fail closed', async () => {
  assert.equal(safeReturn('//evil.test'), '/fi/dashboard');
  assert.equal(safeReturn('/fi/dashboard\\evil'), '/fi/dashboard');
  assert.equal(safeReturn('/en/settings?tab=project'), '/en/settings?tab=project');
  assert.throws(() => clientsFromEnv({ AIRANK_OAUTH_CLIENTS_JSON: JSON.stringify({ bad: { origin: 'http://evil', redirectUri: 'http://evil' } }) }));
  const f = await fixture();
  try {
    for (const value of [{ ...data, aliases: Array(9).fill('name') }, { ...data, categoryFi: 'Example mobile plans' }, { ...data, ownedDomains: ['localhost'] }, { ...data, brandName: '' }]) await denied(f.call('POST', '/v1/projects', value), 422);
    await denied(f.call('PATCH', '/v1/me/preferences', { expectedVersion: 0, timezone: 'not/timezone' }), 422);
    f.sqlite.prepare('DELETE FROM app_migrations WHERE id=? AND checksum=?').run(migrationId, checksum);
    await denied(f.call('GET', '/v1/app/session'), 503);
  } finally { f.sqlite.close(); }
});
