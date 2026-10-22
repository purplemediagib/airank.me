export const SCOPES={ga4:'https://www.googleapis.com/auth/analytics.readonly',gsc:'https://www.googleapis.com/auth/webmasters.readonly'};
export const API={admin:'https://analyticsadmin.googleapis.com/v1beta/',ga4:'https://analyticsdata.googleapis.com/v1beta/',gsc:'https://www.googleapis.com/webmasters/v3/'};
// Versioned classification. Preserve raw sources and never classify google/organic as AI.
export const AI_RULES_VERSION='2026-10-13.1';
const AI_HOSTS={
  'chatgpt.com':'ChatGPT','chat.openai.com':'ChatGPT',
  'perplexity.ai':'Perplexity','claude.ai':'Claude','gemini.google.com':'Gemini',
  'copilot.microsoft.com':'Copilot','grok.com':'Grok','chat.deepseek.com':'DeepSeek','meta.ai':'Meta AI'
};
export function aiSource(source){
  let h=String(source||'').trim().toLowerCase();
  try{if(h.includes('://'))h=new URL(h).hostname;}catch{return null;}
  h=h.replace(/\/$/,'');
  for(const [domain,name] of Object.entries(AI_HOSTS))if(h===domain||h.endsWith('.'+domain))return name;
  return null;
}
export function dateDaysAgo(days,zone='UTC'){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
  const d=new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-days);return d.toISOString().slice(0,10);
}
export function daysBetween(start,end){const out=[];for(let d=new Date(start+'T12:00:00Z');d.toISOString().slice(0,10)<=end;d.setUTCDate(d.getUTCDate()+1))out.push(d.toISOString().slice(0,10));return out;}
export const GA_METRICS=['sessions','engagedSessions','engagementRate','keyEvents','sessionKeyEventRate','totalRevenue'];
export function reportBody(kind,date){
  const dimensions={overview:['date'],sources:['date','sessionSource','sessionMedium'],pages:['date','sessionSource','sessionMedium','landingPagePlusQueryString'],countries:['date','sessionSource','sessionMedium','country'],devices:['date','sessionSource','sessionMedium','deviceCategory']}[kind];
  return {dateRanges:[{startDate:date,endDate:date}],dimensions:dimensions.map(name=>({name})),metrics:GA_METRICS.map(name=>({name})),limit:'10000',returnPropertyQuota:true};
}
export function parseGA(data){return (data.rows||[]).map(row=>{
  const o={};(data.dimensionHeaders||[]).forEach((h,i)=>o[h.name]=row.dimensionValues[i]?.value??'');
  (data.metricHeaders||[]).forEach((h,i)=>o[h.name]=Number(row.metricValues[i]?.value||0));
  if(o.sessionSource!==undefined)o.aiAssistant=aiSource(o.sessionSource);return o;
});}
