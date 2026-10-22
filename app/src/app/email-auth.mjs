import {randomInt} from 'node:crypto';
import {migrationId,checksum} from './email-migration.mjs';
import {hashPassword,verifyPassword,validPassword,dummyHash} from './password.mjs';
import {randomToken,hashToken,hmac,uuid,eqString,parseCookie} from '../common/utils.mjs';
import {CONFIG} from '../common/config.mjs';

const fail = (status,code) => { throw Object.assign(new Error(code),{status,code}); };
const one = async (db,sql,args=[]) => (await db.execute({sql,args})).rows[0];
const run = (db,sql,args=[]) => db.execute({sql,args});
const transaction = async (db,fn) => {
  const tx = await db.transaction('write');
  try { const result = await fn(tx); await tx.commit(); return result; }
  catch (e) { await tx.rollback(); throw e; } finally { tx.close(); }
};
export async function emailAuthAvailable(db,env) {
  return (await emailAuthConfiguration(db,env)).available;
}
export async function emailAuthConfiguration(db,env=process.env) {
  const enabled=env.EMAIL_AUTH_ENABLED==='true';
  const missingVariables=['RESEND_API_KEY','AUTH_EMAIL_FROM','RATE_LIMIT_SECRET'].filter(k=>!env[k]?.trim());
  const rateSecretValid=typeof env.RATE_LIMIT_SECRET==='string'&&env.RATE_LIMIT_SECRET.length>=24;
  let migrationReady=false;
  try{migrationReady=(await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[migrationId]))?.checksum===checksum;}catch{}
  return {enabled,available:enabled&&!missingVariables.length&&rateSecretValid&&migrationReady,
    missing_variables:missingVariables,rate_limit_secret_valid:rateSecretValid,migration_ready:migrationReady};
}
export async function sendAuthEmail({email,code,locale,kind},env) {
  const fi = locale === 'fi', reset = kind === 'reset';
  const subject = fi ? (reset ? 'AI Rank – salasanan palautus' : 'AI Rank – vahvista sähköpostisi') :
    (reset ? 'AI Rank – reset your password' : 'AI Rank – verify your email');
  const text = `${subject}\n\n${fi ? 'Vahvistuskoodisi' : 'Your verification code'}: ${code}\n\n${fi ? 'Koodi on voimassa 15 minuuttia. Jos et pyytänyt tätä, voit jättää viestin huomiotta.' : 'This code expires in 15 minutes. If you did not request this, ignore this email.'}`;
  const response = await fetch('https://api.resend.com/emails',{
    method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({from:env.AUTH_EMAIL_FROM,to:[email],subject,text}),signal:AbortSignal.timeout(10000),
  });
  await response.body?.cancel();
  if (!response.ok) fail(503,'AUTH_MAIL_UNAVAILABLE');
}
export async function saveAuthLocale(db,userId,locale) {
  await run(db,`INSERT INTO app_preferences (user_id,locale,timezone,last_project_id,version)
    VALUES (?,?,'Europe/Helsinki',NULL,1)
    ON CONFLICT(user_id) DO UPDATE SET locale=excluded.locale,version=app_preferences.version+1`,[userId,locale]);
}
async function limit(db,email,client,action,now,secret) {
  const interval = action === 'sign-in' ? 15*60000 : 30*60000;
  const window = Math.floor(now/interval);
  const buckets = [[`email:${email}:${action}`,action==='sign-in'?12:5],[`client:${client}:${action}`,100]];
  const allowed = await transaction(db,async tx => {
    await run(tx,'DELETE FROM app_auth_limits WHERE expires_at<?',[now]);
    await run(tx,'DELETE FROM app_email_challenges WHERE expires_at<?',[now]);
    for (const [key,max] of buckets) {
      const bucket = hmac(`${key}:${window}`,secret);
      const row = await one(tx,`INSERT INTO app_auth_limits VALUES (?,1,?)
        ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count`,[bucket,(window+1)*interval]);
      if (Number(row.count)>max) return false;
    }
    return true;
  });
  if (!allowed) fail(429,'AUTH_RATE_LIMITED');
}
export async function emailAuth({db,env,now,client,clientId,headers,body,action,sendMail=sendAuthEmail}) {
  if (!await emailAuthAvailable(db,env)) fail(503,'EMAIL_AUTH_NOT_CONFIGURED');
  if (headers.origin !== client.origin || !/^application\/json(?:;|$)/i.test(headers['content-type']||'')) fail(403,'CSRF_INVALID');
  const fields = {
    'sign-up':['email','name','password','locale'],
    'sign-in':['email','password','locale'],
    verify:['challengeId','code','locale'],
    'reset-request':['email','locale'],
    reset:['challengeId','code','password'],
  }[action];
  if (!fields) fail(404,'NOT_FOUND');
  if (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(k=>!fields.includes(k))) fail(422,'AUTH_VALIDATION_FAILED');
  let email;
  if (action==='sign-up'||action==='sign-in'||action==='reset-request') {
    if (typeof body.email!=='string') fail(422,'AUTH_VALIDATION_FAILED');
    email = body.email.trim().toLowerCase();
    if (email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['fi','en'].includes(body.locale)) fail(422,'AUTH_VALIDATION_FAILED');
    await limit(db,email,clientId,action,now(),env.RATE_LIMIT_SECRET);
  }
  const result = (data,status=200,responseHeaders={}) => ({status,data,headers:responseHeaders});
  const authenticated = async (tx,userId,locale) => {
    const token = randomToken(), stamp = now();
    const old = parseCookie(headers.cookie||'')['__Host-airank_session'];
    if (old) await run(tx,'DELETE FROM sessions WHERE session_hash=?',[hashToken(old)]);
    await run(tx,'INSERT INTO sessions VALUES (?,?,?,?)',[hashToken(token),userId,stamp+CONFIG.sessionDays*86400000,stamp]);
    await saveAuthLocale(tx,userId,locale);
    const user = await one(tx,'SELECT id,email,display_name FROM users WHERE id=?',[userId]);
    return result({authenticated:true,user:{id:user.id,email:user.email,name:user.display_name},csrfToken:hmac('airank-app-csrf-v1',token),loginAvailable:!!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET),emailLoginAvailable:true,locale},200,{
      'set-cookie':[`__Host-airank_session=${token}; Path=/; Max-Age=${CONFIG.sessionDays*86400}; HttpOnly; Secure; SameSite=Lax`],
    });
  };
  if (action==='sign-in') {
    if (typeof body.password!=='string' || body.password.length>128 || Buffer.byteLength(body.password)>256) fail(401,'INVALID_CREDENTIALS');
    const credential = await one(db,'SELECT * FROM app_email_credentials WHERE email=?',[email]);
    const valid = await verifyPassword(body.password,credential?.password_hash||dummyHash);
    if (!credential || !valid) fail(401,'INVALID_CREDENTIALS');
    return transaction(db,async tx => {
      // A concurrent reset must invalidate a login checked against an old password.
      const current = await one(tx,'SELECT * FROM app_email_credentials WHERE email=?',[email]);
      if (current?.password_hash!==credential.password_hash) fail(401,'INVALID_CREDENTIALS');
      return authenticated(tx,credential.user_id,body.locale);
    });
  }
  if (action==='sign-up'||action==='reset-request') {
    const id = randomToken(), code = String(randomInt(100000,1000000)), kind = action==='sign-up'?'verify':'reset';
    let passwordHash=null,name=null;
    if (kind==='verify') {
      if (!validPassword(body.password) || typeof body.name!=='string' || body.name.trim().length<2 || body.name.trim().length>100 || /[\u0000-\u001f]/.test(body.name)) fail(422,'AUTH_VALIDATION_FAILED');
      if (await one(db,'SELECT id FROM users WHERE lower(email)=?',[email])) fail(409,'EMAIL_IN_USE');
      passwordHash=await hashPassword(body.password); name=body.name.trim();
    } else if (!await one(db,'SELECT user_id FROM app_email_credentials WHERE email=?',[email])) {
      // Same status and opaque challenge shape; do not reveal whether an account exists.
      return result({challengeId:id,expiresIn:900});
    }
    await run(db,'INSERT INTO app_email_challenges VALUES (?,?,?,?,?,?,?,?,0)',[
      id,kind,email,name,passwordHash,body.locale,hmac(`${id}:${code}`,env.RATE_LIMIT_SECRET),now()+900000,
    ]);
    try { await sendMail({email,code,locale:body.locale,kind},env); }
    catch { await run(db,'DELETE FROM app_email_challenges WHERE id=?',[id]); fail(503,'AUTH_MAIL_UNAVAILABLE'); }
    return result({challengeId:id,expiresIn:900});
  }
  if (typeof body.challengeId!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(body.challengeId) || typeof body.code!=='string' || !/^[0-9]{6}$/.test(body.code)) fail(422,'AUTH_VALIDATION_FAILED');
  if (action==='verify'&&!['fi','en'].includes(body.locale)) fail(422,'AUTH_VALIDATION_FAILED');
  if (action==='reset'&&!validPassword(body.password)) fail(422,'AUTH_VALIDATION_FAILED');
  // Wrong attempts commit their count even when the subsequent response is an error.
  const challenge = await transaction(db,async tx => {
    const row = await one(tx,`UPDATE app_email_challenges SET attempts=attempts+1
      WHERE id=? AND kind=? AND expires_at>? AND attempts<5 RETURNING *`,[body.challengeId,action==='verify'?'verify':'reset',now()]);
    if (!row || !eqString(row.code_hash,hmac(`${body.challengeId}:${body.code}`,env.RATE_LIMIT_SECRET))) return null;
    return row;
  });
  if (!challenge) fail(400,'INVALID_OR_EXPIRED_CODE');
  const passwordHash = action==='reset'?await hashPassword(body.password):challenge.password_hash;
  return transaction(db,async tx => {
    const consumed = await one(tx,'DELETE FROM app_email_challenges WHERE id=? AND expires_at>? RETURNING id',[challenge.id,now()]);
    if (!consumed) fail(400,'INVALID_OR_EXPIRED_CODE');
    if (action==='verify') {
      if (await one(tx,'SELECT id FROM users WHERE lower(email)=?',[challenge.email])) fail(409,'EMAIL_IN_USE');
      const id=uuid(),stamp=now();
      await run(tx,'INSERT INTO users VALUES (?,?,?,?,?,?,?)',[id,`email:${id}`,challenge.email,challenge.name,null,stamp,stamp]);
      await run(tx,'INSERT INTO app_email_credentials VALUES (?,?,?,?)',[challenge.email,id,passwordHash,stamp]);
      return authenticated(tx,id,body.locale);
    }
    const credential = await one(tx,'SELECT user_id FROM app_email_credentials WHERE email=?',[challenge.email]);
    if (!credential) fail(400,'INVALID_OR_EXPIRED_CODE');
    await run(tx,'UPDATE app_email_credentials SET password_hash=? WHERE email=?',[passwordHash,challenge.email]);
    await run(tx,'DELETE FROM sessions WHERE user_id=?',[credential.user_id]);
    await run(tx,"DELETE FROM app_email_challenges WHERE email=? AND kind='reset'",[challenge.email]);
    return result({ok:true});
  });
}
