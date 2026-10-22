import {safeLink} from './reports.mjs';
export const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function emailConfigured(env){
 return Boolean(env.RESEND_API_KEY&&(env.PUBLIC_CHECK_EMAIL_FROM||env.AUTH_EMAIL_FROM)&&safeLink(env.PUBLIC_CHECK_PRIVACY_URL)?.startsWith('https://'));
}
export function renderReportEmail(report,{locale,reportUrl,env}){
 const fi=locale==='fi',e=escapeHtml,url=safeLink(reportUrl),privacy=safeLink(env.PUBLIC_CHECK_PRIVACY_URL),logo=safeLink(env.PUBLIC_CHECK_LOGO_URL||'https://app.airank.me/favicon.png');
 if(!url?.startsWith('https://')||!privacy?.startsWith('https://')||!logo?.startsWith('https://'))throw Error('EMAIL_UNAVAILABLE');
 const score=report.score.value===null?'N/A':report.score.value.toFixed(1),date=new Intl.DateTimeFormat(fi?'fi-FI':'en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'}).format(new Date(report.finished_at||report.created_at));
 const title=fi?'AI-näkyvyysraporttisi on valmis.':'Your AI visibility report is ready.';
 const subject=fi?`AI Rank: ${report.brand_name} — näkyvyysraportti`:`AI Rank: ${report.brand_name} — visibility report`;
 const providers=report.providers.map(p=>`<tr><td style="padding:12px 0;border-bottom:1px solid #edf0f5;font-size:14px">${e(p.provider)}<br><span style="color:#727887;font-size:11px">${e(p.models.join(', ')||'N/A')}</span></td><td align="right" style="border-bottom:1px solid #edf0f5;font-size:14px">${p.score===null?'N/A':e(p.score.toFixed(1))+' / 10'}<br><span style="color:#727887;font-size:11px">${p.valid_answers} / ${p.expected_answers}</span></td></tr>`).join('');
 const insight=report.insight.kind==='insufficient'?(fi?'Mittauksia ei ole riittävästi.':'Insufficient measurements.'):
  report.insight.kind==='mentions'?(fi?'Brändisi mainittiin osassa vastauksia. Tarkista kysymykset ja lähteet koko raportista.':'Your brand appeared in the measured answers. Review the questions and sources in the full report.'):
  (fi?'Brändiäsi ei mainittu tässä otoksessa. Tarkista mitatut kysymykset ja vastaukset.':'Your brand was not mentioned in this sample. Review the measured questions and answers.');
 const disclaimer=fi?'Tämä on pieni API-mittausotos, ei kuluttajapalvelujen sijoitus. Virheelliset ja puuttuvat vastaukset eivät ole negatiivisia tuloksia.':'This is a small API measurement sample, not a consumer-chat ranking. Failed and missing responses are not negative results.';
 const footer=fi?'Saat tämän viestin, koska pyysit raportin. Raportin tilaaminen ei tarkoita markkinointiviestien tilaamista.':'You received this email because you requested a report. Requesting it does not subscribe you to marketing emails.';
 const text=[title,report.brand_name,report.domain,`${report.profile.market} · ${report.profile.language} · ${date} UTC`,
  `${fi?'AI-näkyvyyspisteet':'AI visibility score'}: ${score} / 10`,
  `${report.score.mentions} / ${report.score.valid_answers} ${fi?'vastausta mainitsi brändin':'answers mentioned your brand'}`,
  ...report.providers.map(p=>`${p.provider}: ${p.score===null?'N/A':p.score+' / 10'} (${p.valid_answers}/${p.expected_answers}); ${p.models.join(', ')||'N/A'}`),
  insight,`${fi?'Avaa koko raportti':'View full report'}: ${url}`,fi?'Ei kirjautumista. Linkki on voimassa 30 päivää. Älä jaa yksityistä linkkiä.':'No login required. The link expires in 30 days. Keep this private link safe.',
  disclaimer,footer,`${fi?'Tietosuojakäytäntö':'Privacy policy'}: ${privacy}`].join('\n\n');
 // Table layout and inline styles deliberately avoid flex/grid/external fonts for Outlook.
 const html=`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f6f8fd;color:#1c2065;font-family:Arial,sans-serif"><div style="display:none;max-height:0;overflow:hidden">${e(title)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:5px solid #06b6d4;background:#f6f8fd"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:white;border-radius:20px"><tr><td style="padding:32px 24px">
 <table role="presentation" width="100%"><tr><td><img src="${e(logo)}" width="44" height="44" alt="AI Rank" style="display:block;border:0"><strong style="font-size:18px">airank<span style="color:#06b6d4">.me</span></strong></td><td align="right" style="font-size:11px">${fi?'AI-NÄKYVYYSRAPORTTI':'AI VISIBILITY REPORT'}</td></tr></table>
 <p style="font-size:11px;margin-top:32px">${fi?'RAPORTTISI ON VALMIS':'YOUR REPORT IS READY'}</p><h1 style="font-size:30px;line-height:1.15">${e(title)}</h1><p style="color:#6b7280;line-height:1.7">${fi?'Tarkistimme, miten':'We checked how'} ${e(report.brand_name)} ${fi?'näkyy mitatuissa AI-vastauksissa.':'appears in the measured AI answers.'}</p>
 <table role="presentation" width="100%" style="background:#f6f8fd;border-radius:12px"><tr><td style="padding:16px;overflow-wrap:anywhere"><strong>${e(report.domain)}</strong><p style="font-size:12px;color:#6b7280">${e(report.profile.market)} · ${e(report.profile.language)} · ${e(date)} UTC</p></td></tr></table>
 <table role="presentation" width="100%" style="margin-top:16px;background:#1c2065;color:white;border-radius:12px"><tr><td style="padding:20px;width:42%"><span style="font-size:10px">${fi?'AI-NÄKYVYYSPISTEET':'AI VISIBILITY SCORE'}</span><br><strong style="font-size:28px">${e(score)} / 10</strong></td><td style="padding:20px;font-size:13px;line-height:1.8">${report.score.mentions} / ${report.score.valid_answers} ${fi?'vastausta mainitsi brändin':'answers mentioned your brand'}<br>${report.score.providers_measured} / ${report.score.providers_requested} ${fi?'palvelua mitattu':'providers measured'}</td></tr></table>
 <p style="font-size:11px;margin-top:24px">${fi?'NÄKYVYYS MALLEITTAIN':'VISIBILITY BY MODEL'}</p><table role="presentation" width="100%">${providers}</table>
 <table role="presentation" width="100%" style="margin:20px 0;background:#e9f9fc;border-radius:12px"><tr><td style="padding:18px;font-size:14px;line-height:1.6">${e(insight)}</td></tr></table>
 <table role="presentation" width="100%" style="background:#1c2065;border-radius:10px"><tr><td align="center" style="padding:18px"><a href="${e(url)}" style="color:white;text-decoration:none;font-size:15px;font-weight:bold">${fi?'Avaa koko raportti':'View my full report'} →</a></td></tr></table>
 <p style="color:#727887;font-size:12px;line-height:1.6">${fi?'Ei kirjautumista. Yksityinen linkki on voimassa 30 päivää.':'No login required. This private link expires in 30 days.'}</p><p style="border-top:1px solid #edf0f5;padding-top:20px;color:#727887;font-size:12px;line-height:1.6">${e(disclaimer)}</p></td></tr></table><p style="font-size:12px;max-width:560px;line-height:1.6;color:#727887">${e(footer)}</p><a href="${e(privacy)}" style="font-size:12px;color:#1c2065">${fi?'Tietosuojakäytäntö':'Privacy policy'}</a></td></tr></table></body></html>`;
 return {subject:subject.replace(/[\r\n]/g,' '),text,html};
}
async function providerJson(path,options,env,fetcher){
 const response=await fetcher(`https://api.resend.com${path}`,{...options,headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(12000)});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Object.assign(Error('EMAIL_PROVIDER_ERROR'),{definite:[400,401,403,404,422,429].includes(response.status)});
 return data;
}
export async function sendReportEmail(mail,{env,idempotencyKey,fetcher=fetch}){
 const data=await providerJson('/emails',{method:'POST',headers:{'Idempotency-Key':idempotencyKey},body:JSON.stringify({from:env.PUBLIC_CHECK_EMAIL_FROM||env.AUTH_EMAIL_FROM,to:[mail.email],subject:mail.subject,html:mail.html,text:mail.text})},env,fetcher);
 if(typeof data.id!=='string'||!data.id)throw Error('EMAIL_PROVIDER_ERROR');
 return data.id;
}
export async function enrollMarketing(email,{env,fetcher=fetch}){
 if(!env.RESEND_MARKETING_SEGMENT_ID)throw Error('MARKETING_UNAVAILABLE');
 let contact;
 try{contact=await providerJson('/contacts',{method:'POST',body:JSON.stringify({email,unsubscribed:false})},env,fetcher);}
 catch{
  contact=await providerJson(`/contacts/${encodeURIComponent(email)}`,{method:'GET'},env,fetcher);
  if(!contact.id)throw Error('MARKETING_UNAVAILABLE');
  await providerJson(`/contacts/${encodeURIComponent(contact.id)}`,{method:'PATCH',body:JSON.stringify({unsubscribed:false})},env,fetcher);
 }
 if(!contact.id)throw Error('MARKETING_UNAVAILABLE');
 await providerJson(`/contacts/${encodeURIComponent(contact.id)}/segments/${encodeURIComponent(env.RESEND_MARKETING_SEGMENT_ID)}`,{method:'POST'},env,fetcher);
 return true;
}
