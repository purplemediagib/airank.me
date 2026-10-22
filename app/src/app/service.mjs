import {contentService} from '../content/service.mjs';
import {resultsService} from '../analytics/results.mjs';
import {backfillService} from '../sentiment/service.mjs';
import { CONFIG } from '../common/config.mjs';
import { randomToken, hashToken, hmac, uuid, parseCookie, eqString, toHostname } from '../common/utils.mjs';
import { validateProfile } from '../common/scan-profile.mjs';
import { createOauthRequest, exchangeGoogleCode, verifyGoogleIdToken } from '../common/google.mjs';
import { migrationId, checksum } from './migration.mjs';
import { appScans } from './scans.mjs';
import {recordNewGoogleSignup,claimNewGoogleSignup} from '../public-check/signup.mjs';
import { monitoringService } from '../monitoring/service.mjs';
import {bootstrapImmediate} from '../monitoring/immediate.mjs';
import { analyticsService } from '../analytics/service.mjs';
import {researchService} from '../research/service.mjs';
import {intelligenceService} from '../intelligence/service.mjs';
import {googleConnectionsService} from '../google-connections/service.mjs';
import {scheduleService} from '../scheduling/projects.mjs';
import {industriesService} from '../scheduling/industries.mjs';
import {opportunityService} from '../opportunities/service.mjs';
import {websiteProfileService} from '../website-profile/service.mjs';
import {normalizeWebsite} from '../common/website-url.mjs';
import {measurementContext,contextCatalog} from '../common/measurement-context.mjs';
import {reportService,measurementSettingsService} from '../reports/service.mjs';
import {emailAuth,emailAuthAvailable,saveAuthLocale} from './email-auth.mjs';

export const fail = (status, code, fieldErrors) => { throw Object.assign(new Error(code), { status, code, fieldErrors }); };
export function safeReturn(input) {
  if (typeof input !== 'string' || input.length > 1000 || /[\\\r\n]/.test(input)) return '/fi/dashboard';
  return /^\/(fi|en)\/(dashboard|start|settings)(?:[/?#]|$)/.test(input) ? input : '/fi/dashboard';
}
export function clientsFromEnv(env = process.env) {
  const clients = JSON.parse(env.AIRANK_OAUTH_CLIENTS_JSON || '{}');
  for (const [id, c] of Object.entries(clients)) {
    if (!/^[a-z0-9-]{1,40}$/.test(id) || !c || typeof c.origin !== 'string') throw new Error('Invalid app client registry');
    const u = new URL(c.origin);
    if (u.protocol !== 'https:' || u.origin !== c.origin || u.username || u.password ||
      c.redirectUri !== `${c.origin}/api/airank/v1/app/google/callback`) throw new Error('Invalid app client origin/redirect');
  }
  return clients;
}
const defaults = () => ({ locale: 'fi', timezone: 'Europe/Helsinki', lastProjectId: null, version: 0 });
const object = b => { if (!b || typeof b !== 'object' || Array.isArray(b)) fail(422, 'VALIDATION_FAILED'); };
const keys = (b, allowed) => { object(b); if (Object.keys(b).some(k => !allowed.includes(k))) fail(422, 'VALIDATION_FAILED'); };
function identity(b, update = false) {
  keys(b, ['brandName', 'aliases', 'ownedDomains', 'categoryFi', 'category', 'market', 'promptLanguage', ...(update ? ['expectedVersion'] : [])]);
  if (!Array.isArray(b.ownedDomains) || b.ownedDomains.length < 1 || b.ownedDomains.length > 8 || !Array.isArray(b.aliases)) fail(422, 'VALIDATION_FAILED');
  try{measurementContext(b);}catch(e){fail(422,e.code,{[b.market==='RU'?'market':'promptLanguage']:e.code});}
  try {
    const domains = [...new Set(b.ownedDomains.map(v=>normalizeWebsite(v).domain))];
    const p = validateProfile({ brand_name: b.brandName, domain: domains[0], aliases: b.aliases, category_fi: b.category??b.categoryFi, ...measurementContext(b) });
    if (domains.some(d => p.category_fi.toLowerCase().includes(d))) fail(422, 'VALIDATION_FAILED');
    return { brandName: p.brand_name, aliases: p.aliases, ownedDomains: domains, categoryFi: p.category_fi,category:p.category_fi,market:p.market,promptLanguage:p.language };
  } catch { fail(422, 'VALIDATION_FAILED', { identity: 'INVALID_IDENTITY' }); }
}
function revision(b) { if (!Number.isSafeInteger(b.expectedVersion) || b.expectedVersion < 1) fail(422, 'VALIDATION_FAILED'); }
const one = async (db, sql, args = []) => (await db.execute({ sql, args })).rows[0] || null;
const execute = (db, sql, args = []) => db.execute({ sql, args });
const asProject = row => {const p=JSON.parse(row.identity_json);return { id: row.id, ...p,category:p.category??p.categoryFi,status: row.status, version: Number(row.version), createdAt: row.created_at,market:p.market??'FI',promptLanguage:p.promptLanguage??'fi' };};
const projectSQL = 'SELECT p.*,v.identity_json FROM app_projects p JOIN app_identity_versions v ON v.project_id=p.id AND v.version=p.version';
const cookie = (name, value, age) => `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
export const csrfFor = token => hmac('airank-app-csrf-v1', token);

// Dependency injection exists only for offline tests; production uses existing Google validation and DB.
export function createAppService({ db, clients, env = process.env, now = Date.now,
  exchange = exchangeGoogleCode, verify = verifyGoogleIdToken, sendMail }) {
  const ready = async () => {
    try { const row = await one(db, 'SELECT checksum FROM app_migrations WHERE id=?', [migrationId]); if (row?.checksum !== checksum) fail(503, 'APP_NOT_CONFIGURED'); }
    catch { fail(503, 'APP_NOT_CONFIGURED'); }
  };
  const session = async headers => {
    const token = parseCookie(headers.cookie || '')['__Host-airank_session'];
    if (!token) return null;
    const row = await one(db, 'SELECT u.id,u.email,u.display_name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.session_hash=? AND s.expires_at>?', [hashToken(token), now()]);
    return row ? { token, user: { id: row.id, email: row.email, name: row.display_name || '' } } : null;
  };
  const owned = async (cx, id, userId) => {
    const p = await one(cx, `${projectSQL} WHERE p.id=? AND p.owner_id=?`, [id, userId]);
    if (!p) fail(404, 'NOT_FOUND');
    return p;
  };
  const audit = (cx, userId, id, kind, version) => execute(cx, 'INSERT INTO app_audit_events VALUES (?,?,?,?,?,?)', [uuid(), userId, id, kind, version, new Date(now()).toISOString()]);
  const transaction = async fn => {
    const tx = await db.transaction('write');
    try { const result = await fn(tx); await tx.commit(); return result; }
    catch (e) { await tx.rollback(); throw e; } finally { tx.close(); }
  };
  const preferences = async (cx, userId) => {
    const p = await one(cx, 'SELECT * FROM app_preferences WHERE user_id=?', [userId]);
    return p ? { locale: p.locale, timezone: p.timezone, lastProjectId: p.last_project_id, version: Number(p.version) } : defaults();
  };
  return async ({ method, path, query = new URLSearchParams(), headers = {}, body }) => {
    await ready();
    const result = (data, status = 200, responseHeaders = {}) => ({ status, data, headers: responseHeaders });
    const clientId = headers['x-airank-client'];
    const client = Object.hasOwn(clients, clientId) ? clients[clientId] : null;
    if (!client) fail(503, 'APP_NOT_CONFIGURED');
    const loginAvailable = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
    if (method === 'POST' && /^\/v1\/app\/email\/[a-z-]+$/.test(path)) {
      return emailAuth({db,env,now,client,clientId,headers,body,action:path.split('/').at(-1),sendMail});
    }
    if (method === 'GET' && path === '/v1/app/google/start') {
      if (!loginAvailable) fail(503, 'GOOGLE_NOT_CONFIGURED');
      const state = randomToken(), verifier = randomToken(48), nonce = randomToken();
      await execute(db, 'DELETE FROM app_oauth_states WHERE expires_at<=?', [now()]);
      await execute(db, 'INSERT INTO app_oauth_states VALUES (?,?,?,?,?,?,?,?)', [
        hashToken(state), verifier, nonce, safeReturn(query.get('return_to')), clientId, client.origin, client.redirectUri, now() + 600000,
      ]);
      return result(null, 302, { 'set-cookie': [cookie('__Host-airank_app_oauth', state, 600)], location: createOauthRequest({ clientId: env.GOOGLE_CLIENT_ID, redirectUri: client.redirectUri, nonce, state, verifier }) });
    }
    if (method === 'GET' && path === '/v1/app/google/callback') {
      const state = query.get('state') || '';
      const stateCookie = parseCookie(headers.cookie || '')['__Host-airank_app_oauth'] || '';
      const clear = cookie('__Host-airank_app_oauth', '', 0);
      let failureLocale = 'fi';
      const failure = () => result(null, 302, { location: `${client.origin}/${failureLocale}/sign-in?error=oauth_failed`, 'set-cookie': [clear] });
      if (!state || !eqString(state, stateCookie)) return failure();
      // Atomic DELETE RETURNING ensures concurrent callback requests cannot exchange twice.
      const saved = await one(db, 'DELETE FROM app_oauth_states WHERE state_hash=? AND client_id=? AND expires_at>? RETURNING *', [hashToken(state), clientId, now()]);
      if (saved) failureLocale = safeReturn(saved.return_to).split('/')[1];
      if (!saved || saved.origin !== client.origin || saved.redirect_uri !== client.redirectUri || !query.get('code') || query.has('error')) return failure();
      try {
        const token = await exchange({ code: query.get('code'), codeVerifier: saved.code_verifier, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: saved.redirect_uri });
        const user = await verify(token, { clientId: env.GOOGLE_CLIENT_ID, nonce: saved.nonce });
        const sessionToken = randomToken();
        await transaction(async tx => {
          const stamp = now();
          const registered = await one(tx, 'SELECT id FROM users WHERE google_sub=?', [user.googleSub]);
          await execute(tx, `INSERT INTO users (id,google_sub,email,display_name,picture_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,picture_url=excluded.picture_url,updated_at=excluded.updated_at`, [uuid(), user.googleSub, user.email, user.name, user.picture, stamp, stamp]);
          const existing = await one(tx, 'SELECT id FROM users WHERE google_sub=?', [user.googleSub]);
          const previous = parseCookie(headers.cookie || '')['__Host-airank_session'];
          if (previous) await execute(tx, 'DELETE FROM sessions WHERE session_hash=?', [hashToken(previous)]);
          await execute(tx, 'INSERT INTO sessions VALUES (?,?,?,?)', [hashToken(sessionToken), existing.id, stamp + CONFIG.sessionDays * 86400000, stamp]);
          await saveAuthLocale(tx,existing.id,safeReturn(saved.return_to).split('/')[1]);
          await recordNewGoogleSignup(tx,env,hashToken(sessionToken),!registered);
        });
        return result(null, 302, { location: client.origin + safeReturn(saved.return_to), 'set-cookie': [clear, cookie('__Host-airank_session', sessionToken, CONFIG.sessionDays * 86400)] });
      } catch { return failure(); }
    }
    const auth = await session(headers);
    if (method === 'GET' && path === '/v1/app/session') return result({ authenticated: !!auth, user: auth?.user || null, csrfToken: auth ? csrfFor(auth.token) : null, loginAvailable, emailLoginAvailable: await emailAuthAvailable(db,env),accountCreated:auth?await claimNewGoogleSignup(db,env,hashToken(auth.token)):false });
    if (!auth) fail(401, 'AUTH_REQUIRED');
    const userId = auth.user.id;
    if (method !== 'GET') {
      if (headers.origin !== client.origin || !eqString(headers['x-csrf-token'] || '', csrfFor(auth.token))) fail(403, 'CSRF_INVALID');
      if (!/^application\/json(?:;|$)/i.test(headers['content-type'] || '')) fail(415, 'JSON_REQUIRED');
    }
    if(method==='POST' && /^\/v1\/scans(?:\/preview)?$/.test(path))fail(410,'DAILY_TRACKING_ONLY');
    if(method==='POST' && /^\/v1\/projects\/[a-zA-Z0-9-]{1,80}\/monitoring-runs$/.test(path))
     return bootstrapImmediate({db,projectId:path.split('/')[3],userId,body,env,now});
    if (method === 'POST' && path === '/v1/app/logout') {
      await execute(db, 'DELETE FROM sessions WHERE session_hash=?', [hashToken(auth.token)]);
      return result({ ok: true }, 200, { 'set-cookie': [cookie('__Host-airank_session', '', 0), cookie('__Host-airank_app_oauth', '', 0)] });
    }
    if (/^\/v1\/projects\/[a-zA-Z0-9-]{1,80}\/connections\//.test(path)) return googleConnectionsService({db,method,path,query,body,userId,env});
    if (method === 'POST' && /^\/v1\/projects\/[a-zA-Z0-9-]{1,80}\/intelligence$/.test(path)) return intelligenceService({db,path,body,userId,env,now});
    if (method==='GET' && path==='/v1/app/content-projects') return result((await execute(db, `SELECT DISTINCT p.id,p.status,v.identity_json FROM app_projects p JOIN app_identity_versions v ON v.project_id=p.id AND v.version=p.version LEFT JOIN content_members m ON m.project_id=p.id WHERE p.owner_id=? OR m.user_id=?`, [userId,userId])).rows.map(r=>({id:r.id,status:r.status,...JSON.parse(r.identity_json)})));
    if (/^\/v1\/projects\/[A-Za-z0-9-]{1,80}\/content(?:\/|$)/.test(path)) return contentService({db,method,path,query,body,userId,env,now});
    if (method === 'GET' && /^\/v1\/projects\/[a-zA-Z0-9-]{1,80}\/results(?:\/[a-zA-Z0-9-]{1,80})?$/.test(path)) return resultsService({db,path,query,userId,env});
    if (method === 'POST' && /^\/v1\/projects\/[a-zA-Z0-9-]{1,80}\/sentiment-backfill$/.test(path)) return backfillService({db,path,body,userId,env,now});
    if (method === 'GET' && /^\/v1\/projects\/[a-zA-Z0-9-]{1,80}\/analytics$/.test(path)) return analyticsService({db,path,query,userId,env});
    if (/^\/v1\/industries(?:\/[a-zA-Z0-9_-]{1,80})?$/.test(path)) return industriesService({db,method,path,body,userId,env,now});
    if (/^\/v1\/website-profiles(?:\/[a-zA-Z0-9-]{1,80})?$/.test(path)) return websiteProfileService({db,method,path,body,userId,env,now});
    if(method==='GET'&&path==='/v1/measurement-context')return result(contextCatalog());
    if (/^\/v1\/projects\/[a-zA-Z0-9-]{1,80}\/opportunities(?:\/[a-zA-Z0-9-]{1,80})?$/.test(path)) return opportunityService({db,method,path,body,userId,now});
    if (/^\/v1\/projects\/[a-zA-Z0-9-]{1,80}\/reports(?:\/[a-zA-Z0-9-]{1,80})?$/.test(path)) return reportService({db,method,path,body,userId,now});
    if (/^\/v1\/projects\/[a-zA-Z0-9-]{1,80}\/measurement-settings$/.test(path)) return measurementSettingsService({db,method,path,body,userId,now,env});
    if (/^\/v1\/projects\/[a-zA-Z0-9-]{1,80}\/schedule$/.test(path)) return scheduleService({db,method,path,body,userId,env,now});
    if (/^\/v1\/projects\/[^/]+\/(?:research|evidence)(?:\/|$)/.test(path)) return researchService({db,method,path,body,userId,now,env});
    if (/^\/v1\/projects\/[^/]+\/(?:prompts|suggestions|monitoring-runs)(?:\/|$)/.test(path)) return monitoringService({db,method,path,query,body,userId,now,env});
    if (path.startsWith('/v1/scans') || /^\/v1\/projects\/[^/]+\/scans$/.test(path)) return appScans({db,method,path,body,userId,now,env});
    if (path === '/v1/projects' && method === 'GET') return result((await execute(db, `${projectSQL} WHERE p.owner_id=? ORDER BY p.created_at DESC,p.id`, [userId])).rows.map(asProject));
    if (path === '/v1/projects' && method === 'POST') {
      const data = identity(body), id = uuid(), stamp = new Date(now()).toISOString();
      return transaction(async tx => {
        await execute(tx, 'INSERT INTO app_projects VALUES (?,?,?,?,?)', [id, userId, 'active', 1, stamp]);
        await execute(tx, 'INSERT INTO app_identity_versions VALUES (?,?,?,?)', [id, 1, JSON.stringify(data), stamp]);
        await audit(tx, userId, id, 'project.created', 1);
        return result(asProject(await owned(tx, id, userId)), 201);
      });
    }
    const match = path.match(/^\/v1\/projects\/([a-zA-Z0-9-]{1,80})(\/archive|\/versions)?$/);
    if (match) {
      const [, id, action] = match;
      const p = await owned(db, id, userId);
      if (method === 'GET' && !action) return result(asProject(p));
      if (method === 'GET' && action === '/versions') return result((await execute(db, 'SELECT * FROM app_identity_versions WHERE project_id=? ORDER BY version DESC', [id])).rows.map(r => ({ ...JSON.parse(r.identity_json), version: Number(r.version), createdAt: r.created_at })));
      if ((method === 'PATCH' && !action) || (method === 'POST' && action === '/archive')) {
        object(body); revision(body);
        if (action) keys(body, ['expectedVersion']);
        const prior=JSON.parse(p.identity_json);
        const data = action ? null : identity({market:prior.market??'FI',promptLanguage:prior.promptLanguage??'fi',...body}, true);
        return transaction(async tx => {
          const current = await owned(tx, id, userId);
          if (Number(current.version) !== body.expectedVersion || current.status !== 'active') fail(409, 'VERSION_CONFLICT');
          const version = Number(current.version) + 1;
          await execute(tx, 'INSERT INTO app_identity_versions VALUES (?,?,?,?)', [id, version, data ? JSON.stringify(data) : current.identity_json, new Date(now()).toISOString()]);
          await execute(tx, 'UPDATE app_projects SET version=?,status=? WHERE id=? AND owner_id=?', [version, action ? 'archived' : 'active', id, userId]);
          if (action) await execute(tx, 'UPDATE app_preferences SET last_project_id=NULL,version=version+1 WHERE user_id=? AND last_project_id=?', [userId, id]);
          await audit(tx, userId, id, action ? 'project.archived' : 'identity.updated', version);
          return result(asProject(await owned(tx, id, userId)));
        });
      }
    }
    if (path === '/v1/me/preferences' && method === 'GET') return result(await preferences(db, userId));
    if (path === '/v1/me/preferences' && method === 'PATCH') {
      keys(body, ['expectedVersion', 'locale', 'timezone', 'lastProjectId']);
      if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) fail(422, 'VALIDATION_FAILED');
      if (body.locale !== undefined && !['fi', 'en'].includes(body.locale)) fail(422, 'VALIDATION_FAILED');
      if (body.timezone !== undefined) {
        if (typeof body.timezone !== 'string' || body.timezone.length > 100) fail(422, 'VALIDATION_FAILED');
        try { new Intl.DateTimeFormat('en', { timeZone: body.timezone }); } catch { fail(422, 'VALIDATION_FAILED'); }
      }
      return transaction(async tx => {
        const p = await preferences(tx, userId);
        if (p.version !== body.expectedVersion) fail(409, 'VERSION_CONFLICT');
        if ('lastProjectId' in body && body.lastProjectId !== null) {
          if (typeof body.lastProjectId !== 'string') fail(422, 'VALIDATION_FAILED');
          const project = await owned(tx, body.lastProjectId, userId);
          if (project.status !== 'active') fail(409, 'VERSION_CONFLICT');
        }
        const next = { ...p, ...body, version: p.version + 1 };
        await execute(tx, `INSERT INTO app_preferences VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET locale=excluded.locale,timezone=excluded.timezone,last_project_id=excluded.last_project_id,version=excluded.version`, [userId, next.locale, next.timezone, next.lastProjectId, next.version]);
        await audit(tx, userId, null, 'preferences.updated', next.version);
        return result(await preferences(tx, userId));
      });
    }
    fail(404, 'NOT_FOUND');
  };
}
