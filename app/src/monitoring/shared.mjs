import { createHash } from 'node:crypto';
import {collectionMethodVersion} from '../common/observations.mjs';
export {collectionMethodVersion};
export const fail=(status,code)=>{throw Object.assign(Error(code),{status,code});};
export const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const normalized=s=>s.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('fi');
export const one=async(db,sql,args=[]) => (await db.execute({sql,args})).rows[0];
export const exec=(db,sql,args=[])=>db.execute({sql,args});
export async function transaction(db,fn){const tx=await db.transaction('write');try{const r=await fn(tx);await tx.commit();return r;}catch(e){await tx.rollback();throw e;}finally{tx.close();}}
export const methodology='tracked-api-complete-answer-v2';
export function setting(env,key,fallback,min,max){
 const n=Number(env[key]??fallback);
 if(!Number.isSafeInteger(n)||n<min||n>max)fail(503,'APP_NOT_CONFIGURED');
 return n;
}
export const promptSQL='SELECT p.id,p.project_id,p.version,p.status,p.hash,v.created_at,v.payload FROM mon_prompts p JOIN mon_prompt_versions v ON v.prompt_id=p.id AND v.version=p.version';
export const promptRow=r=>({id:r.id,projectId:r.project_id,version:Number(r.version),createdAt:Number(r.created_at),...JSON.parse(r.payload),status:r.status});
export async function runRow(db,r){
 const counts=await one(db,`SELECT COUNT(*) completed,COALESCE(SUM(CASE WHEN json_extract(payload,'$.status')='success' THEN 1 ELSE 0 END),0) valid FROM mon_evidence WHERE run_id=?`,[r.id]);
 const s=JSON.parse(r.snapshot);
 return {id:r.id,projectId:r.project_id,submissionId:r.submission_id,status:r.status,kind:r.kind,expected:Number(r.expected),completed:Number(counts.completed),valid:Number(counts.valid),createdAt:Number(r.created_at),deadlineAt:Number(r.deadline_at),methodology:s.methodology,collectionMethod:s.collectionMethod||'citation-required-v1',routes:s.routes,reason:r.reason||null};
}
