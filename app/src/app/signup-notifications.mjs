import {randomUUID} from 'node:crypto';

export const OWNER_EMAIL='vincent.carrie@purple.gi';
const MAX_ATTEMPTS=6, RETRY_WINDOW=23*60*60*1000, LEASE=60000;
const run=(db,sql,args=[])=>db.execute({sql,args});
const one=async(db,sql,args=[]) => (await run(db,sql,args)).rows[0];
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function signupNotificationsConfigured(env){
 // Fixed owner-only recipient; reject accidental lists/overrides, never user input.
 return env.SIGNUP_NOTIFICATIONS_ENABLED==='true'&&
 (!env.SIGNUP_NOTIFICATION_TO||env.SIGNUP_NOTIFICATION_TO===OWNER_EMAIL)&&
 !!env.RESEND_API_KEY?.trim()&&!!env.AUTH_EMAIL_FROM?.trim()&&!/[\r\n]/.test(env.AUTH_EMAIL_FROM);
}
export function renderSignupNotification(snapshot,from){
 const fields=[['Name',snapshot.name||'Not provided'],['Email',snapshot.email],['Account ID',snapshot.id],
 ['Signup time (UTC)',new Date(Number(snapshot.createdAt)).toISOString()],['Authentication',snapshot.method],
 ['Email verification','Verified at account creation'],
 ['Company / website','Not supplied at account creation (onboarding happens later)'],
 ['Locale',snapshot.locale||'Not supplied'],
 ['Persisted plan / trial / team role','Not assigned at account creation; provisional app trial may apply'],['User timezone','Not collected at account creation']];
 const subject='AI Rank — new account created';
 return {from,to:[OWNER_EMAIL],subject,text:[subject,...fields.map(([k,v])=>`${k}: ${v}`)].join('\n'),
 html:`<h1>${escape(subject)}</h1><table>${fields.map(([k,v])=>`<tr><th align="left">${escape(k)}</th><td>${escape(v)}</td></tr>`).join('')}</table>`};
}
export async function sendSignupNotification(payload,{env,key,fetcher=fetch}){
 const response=await fetcher('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
 const data=await response.json().catch(()=>({}));
 if(!response.ok||typeof data.id!=='string'||!data.id)throw Object.assign(Error('SIGNUP_MAIL_PROVIDER_FAILED'),{permanent:[400,401,403,404,422].includes(response.status)});
 return data.id;
}
export async function dispatchSignupNotification({db,env=process.env,now=Date.now,send=sendSignupNotification,log=event=>console.warn(JSON.stringify(event))}){
 if(!signupNotificationsConfigured(env))return {status:'disabled'};
 const stamp=now(),token=randomUUID();
 // Never resend an uncertain delivery after Resend's 24h deduplication window.
 const expired=await run(db,`UPDATE app_signup_notifications SET status='dead',error_code='RETRY_WINDOW_EXPIRED',lease_token=NULL,lease_until=NULL
 WHERE status IN ('pending','sending') AND (lease_until IS NULL OR lease_until<=?) AND (attempts>=? OR first_attempt_at<=?)`,[stamp,MAX_ATTEMPTS,stamp-RETRY_WINDOW]);
 if(expired.rowsAffected)log({event:'signup_notification_dead',reason:'retry_limit',count:expired.rowsAffected});
 // Atomic claim works across API replicas, not merely within this process.
 const row=await one(db,`UPDATE app_signup_notifications SET status='sending',attempts=attempts+1,
 first_attempt_at=COALESCE(first_attempt_at,?),lease_until=?,lease_token=?
 WHERE user_id=(SELECT user_id FROM app_signup_notifications WHERE
 (status='pending' AND next_attempt_at<=? OR status='sending' AND lease_until<=?)
 AND attempts<? AND (first_attempt_at IS NULL OR first_attempt_at>?) ORDER BY next_attempt_at,user_id LIMIT 1)
 RETURNING *`,[stamp,stamp+LEASE,token,stamp,stamp,MAX_ATTEMPTS,stamp-RETRY_WINDOW]);
 if(!row)return {status:'idle'};
 try{
  // Persist exactly the same bytes/sender for retries even if settings change.
  const payload=row.payload_json?JSON.parse(row.payload_json):renderSignupNotification(JSON.parse(row.snapshot_json),env.AUTH_EMAIL_FROM);
  const saved=await run(db,`UPDATE app_signup_notifications SET payload_json=? WHERE user_id=? AND lease_token=? AND status='sending' AND lease_until>? AND first_attempt_at>?`,[JSON.stringify(payload),row.user_id,token,now(),now()-RETRY_WINDOW]);
  if(!saved.rowsAffected||now()>=Number(row.lease_until)||now()>=Number(row.first_attempt_at)+RETRY_WINDOW)return {status:'lease_lost'};
  const providerId=await send(payload,{env,key:`signup-owner/${row.user_id}`});
  const marked=await run(db,`UPDATE app_signup_notifications SET status='sent',sent_at=?,provider_id=?,lease_token=NULL,lease_until=NULL,error_code=NULL,snapshot_json=NULL,payload_json=NULL WHERE user_id=? AND lease_token=?`,[now(),providerId,row.user_id,token]);
  return {status:marked.rowsAffected?'sent':'lease_lost'};
 }catch(error){
  const dead=error.permanent||Number(row.attempts)>=MAX_ATTEMPTS;
  await run(db,`UPDATE app_signup_notifications SET status=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,error_code=? WHERE user_id=? AND lease_token=?`,
   [dead?'dead':'pending',now()+Math.min(3600000,30000*2**(Number(row.attempts)-1)),dead?'DELIVERY_REQUIRES_REVIEW':'DELIVERY_RETRY',row.user_id,token]);
  log({event:dead?'signup_notification_dead':'signup_notification_retry',attempt:Number(row.attempts)});
  return {status:dead?'dead':'retry'};
 }
}
export function startSignupNotifications({db,env=process.env,log=event=>console.warn(JSON.stringify(event)),intervalMs=15000}){
 if(!signupNotificationsConfigured(env)){log({event:'signup_notification_configuration',enabled:env.SIGNUP_NOTIFICATIONS_ENABLED==='true',configured:false});return ()=>{};}
 log({event:'signup_notification_configuration',enabled:true,configured:true});
 let busy=false;
 const tick=async()=>{if(busy)return;busy=true;try{await dispatchSignupNotification({db,env,log});}catch{log({event:'signup_notification_dispatch_unavailable'});}finally{busy=false;}};
 const timer=setInterval(tick,intervalMs);timer.unref();void tick();
 return ()=>clearInterval(timer);
}
