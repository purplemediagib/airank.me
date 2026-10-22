import {one,exec,fail} from '../monitoring/shared.mjs';
import {buildScanReport} from '../common/scan-profile.mjs';
import {digest,secureEqual} from './security.mjs';
export function safeLink(value){
 try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}
}
export async function authorizeGuest(db,id,token){
 if(!/^[a-f0-9-]{36}$/.test(id)||typeof token!=='string'||!/^[A-Za-z0-9_-]{40,100}$/.test(token))fail(404,'SCAN_NOT_FOUND');
 const scan=await one(db,'SELECT j.* FROM scan_jobs j JOIN public_check_scans p ON p.scan_id=j.id WHERE j.id=?',[id]);
 if(!scan||!secureEqual(digest(token),scan.guest_token_hash))fail(404,'SCAN_NOT_FOUND');
 return scan;
}
export async function scanReport(db,scan){
 const saved=await one(db,'SELECT snapshot_json FROM public_check_scans WHERE scan_id=?',[scan.id]);
 if(saved?.snapshot_json)return JSON.parse(saved.snapshot_json);
 const profile=JSON.parse((await one(db,'SELECT profile_json FROM scan_profiles WHERE scan_id=?',[scan.id])).profile_json);
 const prompts=(await exec(db,'SELECT * FROM scan_prompts WHERE scan_id=? ORDER BY sequence',[scan.id])).rows;
 const observations=(await exec(db,'SELECT * FROM observations WHERE scan_id=? ORDER BY observed_at,id',[scan.id])).rows.filter(o=>profile.providers.includes(o.provider)&&prompts.some(p=>p.id===o.prompt_id));
 const {score,metrics}=buildScanReport({profile,observations,promptCount:prompts.length,status:scan.status});
 const terminal=['completed','no_measurements','failed'].includes(scan.status);
 const report={
  id:scan.id,domain:scan.domain,brand_name:scan.brand_name,
  status:!terminal?(scan.status==='queued'?'queued':'running'):score.valid_answers?(score.state==='complete'?'completed':'partial'):'failed',
  created_at:Number(scan.requested_at),finished_at:scan.finished_at?Number(scan.finished_at):null,
  profile,score:{...score,methodology:profile.methodology,providers_requested:score.providers_requested.length,providers_measured:score.providers_measured.length},
  prompts:prompts.map(p=>({id:p.id,sequence:Number(p.sequence),text:p.prompt_text})),
  observations:observations.map(o=>{
   let citations;try{citations=JSON.parse(o.citations_json||'[]');}catch{citations=[];}
   return {id:o.id,prompt_id:o.prompt_id,provider:o.provider,model:o.provider_status==='success'?o.model||null:null,status:o.provider_status,
    response_text:o.answer_text||null,brand_mentioned:Number(o.brand_mentioned),
    citations:(Array.isArray(citations)?citations:[]).map(c=>typeof c==='string'?{url:c}:c).filter(c=>c&&safeLink(c.url)).map(c=>{
     const domain=new URL(c.url).hostname,h=domain.replace(/^www\./,'');
     return {url:safeLink(c.url),domain,owned:h===profile.domain||h.endsWith('.'+profile.domain)};
    })};
  }),
  providers:profile.providers.map(provider=>({provider,score:metrics[provider].score,mentions:metrics[provider].mentioned,valid_answers:metrics[provider].sample_size,expected_answers:metrics[provider].expected,
   models:[...new Set(observations.filter(o=>o.provider===provider&&o.provider_status==='success'&&o.model).map(o=>o.model))],unavailable_answers:metrics[provider].unavailable+metrics[provider].missing})),
  progress:{completed:observations.length,expected:prompts.length*profile.providers.length},
  insight:{kind:!score.valid_answers?'insufficient':score.mentions?'mentions':'no_mentions',mentions:score.mentions,valid_answers:score.valid_answers},
  methodology:profile.methodology
 };
 if(terminal){
  // First terminal payload wins, even if delayed provider writes arrive later.
  await exec(db,'UPDATE public_check_scans SET snapshot_json=? WHERE scan_id=? AND snapshot_json IS NULL',[JSON.stringify(report),scan.id]);
  return JSON.parse((await one(db,'SELECT snapshot_json FROM public_check_scans WHERE scan_id=?',[scan.id])).snapshot_json);
 }
 return report;
}
