import {randomUUID,randomBytes} from 'node:crypto';
import {one,exec,fail,transaction} from '../monitoring/shared.mjs';
import {digest,seal,unseal,verifyResendWebhook} from './security.mjs';
import {authorizeGuest,scanReport} from './reports.mjs';
import {emailConfigured,renderReportEmail,sendReportEmail,enrollMarketing} from './email.mjs';
export const CONSENT_VERSION='public-check-marketing-v1';
export const CONSENT_TEXT={
 en:'Also send me occasional AI Rank product news and tips (optional, separate from the report).',
 fi:'Lähettäkää minulle myös satunnaisesti AI Rankin uutisia ja vinkkejä (valinnainen, erillinen raportista).'
};
const publicDelivery=r=>({requestId:r.request_id,status:r.status,marketingStatus:r.marketing_status});
export function normalizedEmail(value){
 if(typeof value!=='string'||value.length>254||/[\r\n\u0000-\u001f]/.test(value))fail(422,'EMAIL_INVALID');
 const email=value.trim().normalize('NFKC').toLowerCase();
 if(!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)||email.startsWith('.')||email.includes('..')||email.split('@')[0].length>64)fail(422,'EMAIL_INVALID');
 return email;
}
export async function requestDelivery({db,scanId,scanToken,body,env,now=Date.now,deps={}}){
 if(!emailConfigured(env))fail(503,'EMAIL_UNAVAILABLE');
 const scan=await authorizeGuest(db,scanId,scanToken),report=await scanReport(db,scan);
 if(!['completed','partial'].includes(report.status)||report.score.valid_answers<1)fail(409,'REPORT_NOT_READY');
 const email=normalizedEmail(body.email),locale=body.locale;
 if(!['fi','en'].includes(locale)||typeof body.marketingConsent!=='boolean'||body.resend!==undefined&&typeof body.resend!=='boolean')fail(422,'EMAIL_INVALID');
 if(body.marketingConsent&&!env.RESEND_MARKETING_SEGMENT_ID)fail(503,'MARKETING_UNAVAILABLE');
 const reserve=await transaction(db,async tx=>{
  const old=await one(tx,'SELECT * FROM public_check_deliveries WHERE scan_id=? AND email=?',[scanId,email]);
  if(old&&!body.resend&&!old.marketing_consent&&body.marketingConsent&&['sent','delivered'].includes(old.status)){
   await exec(tx,"UPDATE public_check_deliveries SET marketing_consent=1,consent_version=?,consent_text=?,marketing_status='pending' WHERE request_id=?",[CONSENT_VERSION,CONSENT_TEXT[locale],old.request_id]);
   await exec(tx,'INSERT INTO public_check_consents VALUES (?,?,?,?,?,?,?,?)',[randomUUID(),old.request_id,1,CONSENT_VERSION,CONSENT_TEXT[locale],locale,'public-check-embed',now()]);
   return {row:await one(tx,'SELECT * FROM public_check_deliveries WHERE request_id=?',[old.request_id]),send:false,subscribe:true};
  }
  if(old&&!body.resend)return {row:old,send:false};
  if(old&&(old.status==='sending'||old.status==='uncertain'))return {row:old,send:false};
  if(old&&now()-Number(old.last_attempt_at)<60000)fail(429,'EMAIL_RESEND_WAIT');
  // Operational delivery safeguard, not an extra measurement quota.
  const count=await one(tx,'SELECT COUNT(*) n FROM public_check_deliveries WHERE scan_id=?',[scanId]);
  if(!old&&Number(count.n)>=Number(env.PUBLIC_CHECK_MAX_REPORT_RECIPIENTS||5))fail(429,'EMAIL_RATE_LIMIT');
  const token=randomBytes(32).toString('base64url'),requestId=old?.request_id||randomUUID(),attempt=randomUUID();
  if(old){
   await exec(tx,`UPDATE public_check_deliveries SET marketing_consent=?,consent_version=?,consent_text=?,locale=?,created_at=?,expires_at=?,report_token_hash=?,report_token_cipher=?,status='sending',marketing_status=?,provider_message_id=NULL,attempt_id=?,last_attempt_at=? WHERE request_id=?`,
    [+body.marketingConsent,CONSENT_VERSION,CONSENT_TEXT[locale],locale,now(),now()+30*86400000,digest(token),seal(token,env),body.marketingConsent?'pending':'not_requested',attempt,now(),requestId]);
  }else{
   await exec(tx,'INSERT INTO public_check_deliveries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [requestId,scanId,email,+body.marketingConsent,CONSENT_VERSION,CONSENT_TEXT[locale],locale,'public-check-embed',now(),now()+30*86400000,digest(token),seal(token,env),'sending',body.marketingConsent?'pending':'not_requested',null,attempt,now()]);
  }
  await exec(tx,'INSERT INTO public_check_consents VALUES (?,?,?,?,?,?,?,?)',[randomUUID(),requestId,+body.marketingConsent,CONSENT_VERSION,CONSENT_TEXT[locale],locale,'public-check-embed',now()]);
  return {row:await one(tx,'SELECT * FROM public_check_deliveries WHERE request_id=?',[requestId]),send:true};
 });
 if(!reserve.send&&!reserve.subscribe)return publicDelivery(reserve.row);
 const row=reserve.row;
 if(reserve.subscribe){
  let status='failed';
  try{if(await (deps.subscribe||enrollMarketing)(email,{env}))status='subscribed';}catch{}
  await exec(db,'UPDATE public_check_deliveries SET marketing_status=? WHERE request_id=?',[status,row.request_id]);
  return publicDelivery(await one(db,'SELECT * FROM public_check_deliveries WHERE request_id=?',[row.request_id]));
 }
 try{
  const origin=env.PUBLIC_CHECK_REPORT_ORIGIN||'https://app.airank.me';
  if(!['https://app.airank.me'].includes(origin))fail(503,'EMAIL_UNAVAILABLE');
  const mail=renderReportEmail(report,{locale,reportUrl:`${origin}/${locale}/report/${unseal(row.report_token_cipher,env)}`,env});
  const messageId=await (deps.send||sendReportEmail)({...mail,email},{env,idempotencyKey:`public-report/${row.attempt_id}`});
  await exec(db,"UPDATE public_check_deliveries SET status='sent',provider_message_id=? WHERE request_id=? AND attempt_id=?",[messageId,row.request_id,row.attempt_id]);
  // Signed webhooks can arrive before the send response. Reconcile their stored minimal state.
  const events=(await exec(db,'SELECT status FROM public_check_webhooks WHERE provider_message_id=?',[messageId])).rows.map(e=>e.status);
  const status=['bounced','failed','delivered'].find(s=>events.includes(s));
  if(status)await exec(db,'UPDATE public_check_deliveries SET status=? WHERE request_id=? AND attempt_id=?',[status,row.request_id,row.attempt_id]);
 }catch(err){
  const definite=err?.definite||err?.code==='EMAIL_UNAVAILABLE'||err?.message==='EMAIL_UNAVAILABLE';
  await exec(db,'UPDATE public_check_deliveries SET status=? WHERE request_id=? AND attempt_id=?',[definite?'failed':'uncertain',row.request_id,row.attempt_id]);
  return publicDelivery(await one(db,'SELECT * FROM public_check_deliveries WHERE request_id=?',[row.request_id]));
 }
 if(body.marketingConsent){
  let status='failed';
  try{if(await (deps.subscribe||enrollMarketing)(email,{env}))status='subscribed';}catch{}
  await exec(db,'UPDATE public_check_deliveries SET marketing_status=? WHERE request_id=? AND attempt_id=?',[status,row.request_id,row.attempt_id]);
 }
 return publicDelivery(await one(db,'SELECT * FROM public_check_deliveries WHERE request_id=?',[row.request_id]));
}
export async function deliveryStatus(db,id,token,now=Date.now){
 const row=await one(db,'SELECT * FROM public_check_deliveries WHERE request_id=?',[id]);
 if(!row)fail(404,'REPORT_NOT_FOUND');
 await authorizeGuest(db,row.scan_id,token);
 if(row.status==='sending'&&now()-Number(row.last_attempt_at)>60000){
  await exec(db,"UPDATE public_check_deliveries SET status='uncertain' WHERE request_id=? AND status='sending'",[id]);
  row.status='uncertain';
 }
 return publicDelivery(row);
}
export async function openReport(db,token,now=Date.now){
 if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))fail(404,'REPORT_NOT_FOUND');
 const row=await one(db,'SELECT * FROM public_check_deliveries WHERE report_token_hash=?',[digest(token)]);
 if(!row)fail(404,'REPORT_NOT_FOUND');
 if(Number(row.expires_at)<=now())fail(410,'REPORT_EXPIRED');
 const saved=await one(db,'SELECT snapshot_json FROM public_check_scans WHERE scan_id=?',[row.scan_id]);
 if(!saved?.snapshot_json)fail(404,'REPORT_NOT_FOUND');
 return JSON.parse(saved.snapshot_json);
}
export async function handleDeliveryWebhook({db,raw,headers,env,now=Date.now}){
 if(!verifyResendWebhook(raw,headers,env.PUBLIC_CHECK_RESEND_WEBHOOK_SECRET,now()))fail(401,'WEBHOOK_INVALID');
 let event;try{event=JSON.parse(raw);}catch{fail(400,'WEBHOOK_INVALID');}
 const statuses={'email.sent':'sent','email.delivered':'delivered','email.bounced':'bounced','email.failed':'failed','email.complained':'bounced'};
 return transaction(db,async tx=>{
  const eventId=String(headers['svix-id']);
  if(await one(tx,'SELECT event_id FROM public_check_webhooks WHERE event_id=?',[eventId]))return {ok:true};
  await exec(tx,'INSERT INTO public_check_webhooks VALUES (?,?,?,?)',[eventId,typeof event.data?.email_id==='string'?event.data.email_id:null,statuses[event.type]||null,now()]);
  if(statuses[event.type]&&typeof event.data?.email_id==='string'){
   // Terminal failures cannot be overwritten by out-of-order success webhooks.
   await exec(tx,`UPDATE public_check_deliveries SET status=? WHERE provider_message_id=? AND status NOT IN ('bounced','failed') AND NOT (status='delivered' AND ?='sent')`,[statuses[event.type],event.data.email_id,statuses[event.type]]);
  }
  return {ok:true};
 });
}
