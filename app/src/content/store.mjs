import {randomUUID,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {one,exec,fail,hash,transaction} from '../monitoring/shared.mjs';
export {one,exec,fail,hash,transaction};
export const uid=()=>randomUUID();
export async function access(db,projectId,userId,permission='read'){
 const p=await one(db,'SELECT p.*,v.identity_json FROM app_projects p JOIN app_identity_versions v ON v.project_id=p.id AND v.version=p.version WHERE p.id=?',[projectId]);
 if(!p)fail(404,'NOT_FOUND');
 const role=p.owner_id===userId?'owner':(await one(db,'SELECT role FROM content_members WHERE project_id=? AND user_id=?',[projectId,userId]))?.role;
 if(!role)fail(404,'NOT_FOUND');
 const allow={read:['owner','viewer','editor','reviewer'],edit:['owner','editor'],review:['owner','reviewer'],manage:['owner']};
 if(!allow[permission]?.includes(role))fail(403,'CONTENT_PERMISSION_DENIED');
 if(permission!=='read'&&p.status!=='active')fail(409,'PROJECT_ARCHIVED');
 return {...p,identity:JSON.parse(p.identity_json),role};
}
export async function get(db,p,kind,id){const r=await one(db,'SELECT * FROM content_records WHERE project_id=? AND kind=? AND id=?',[p,kind,id]);return r?{...JSON.parse(r.payload),id:r.id,version:Number(r.version),updatedAt:Number(r.updated_at)}:null;}
export async function list(db,p,kind){return(await exec(db,'SELECT * FROM content_records WHERE project_id=? AND kind=? ORDER BY updated_at DESC,id',[p,kind])).rows.map(r=>({...JSON.parse(r.payload),id:r.id,version:Number(r.version),updatedAt:Number(r.updated_at)}));}
export async function put(db,p,kind,id,value,expected,actor,now=Date.now()){
 const old=await get(db,p,kind,id);if(expected!==undefined&&(old?.version||0)!==expected)fail(409,'VERSION_CONFLICT');
 const version=(old?.version||0)+1;const payload={...value};delete payload.version;delete payload.updatedAt;delete payload.id;
 await exec(db,'INSERT INTO content_records VALUES (?,?,?,?,?,?) ON CONFLICT(project_id,kind,id) DO UPDATE SET version=excluded.version,payload=excluded.payload,updated_at=excluded.updated_at',[p,kind,id,version,JSON.stringify(payload),now]);
 if(kind==='document')await exec(db,'INSERT INTO content_revisions VALUES (?,?,?,?,?,?)',[p,id,version,JSON.stringify(payload),actor,now]);
 await event(db,p,actor,kind+'.saved',{id,version},now);return {...payload,id,version,updatedAt:now};
}
export const event=(db,p,actor,kind,payload,now=Date.now())=>exec(db,'INSERT INTO content_events VALUES (?,?,?,?,?,?)',[uid(),p,actor,kind,JSON.stringify(payload),now]);
export const jobView=r=>({...r,input:JSON.parse(r.input),checkpoint:JSON.parse(r.checkpoint),result:r.result?JSON.parse(r.result):null,claim_token:undefined,lease_until:undefined});
export async function enqueue(db,p,actor,kind,input,submissionId,now=Date.now()){
 if(typeof submissionId!=='string'||! /^[A-Za-z0-9_-]{8,100}$/.test(submissionId))fail(422,'SUBMISSION_ID_REQUIRED');
 const h=hash({kind,input});const old=await one(db,'SELECT * FROM content_jobs WHERE project_id=? AND submission_id=?',[p,submissionId]);
 if(old){if(old.input_hash!==h)fail(409,'SUBMISSION_CONFLICT');return jobView(old);}
 const n=await one(db,"SELECT COUNT(*) n FROM content_jobs WHERE project_id=? AND status IN ('queued','running')",[p]);
 if(Number(n.n)>=1000)fail(429,'CONTENT_QUEUE_FULL');
 const id=uid();await exec(db,`INSERT INTO content_jobs(id,project_id,actor,submission_id,input_hash,kind,input,status,available_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'queued',?,?,?)`,[id,p,actor,submissionId,h,kind,JSON.stringify(input),now,now,now]);
 return jobView(await one(db,'SELECT * FROM content_jobs WHERE id=?',[id]));
}
function key(env){if(!/^[a-f0-9]{64}$/i.test(env.CONTENT_ENCRYPTION_KEY||''))fail(503,'CONTENT_ENCRYPTION_NOT_CONFIGURED');return Buffer.from(env.CONTENT_ENCRYPTION_KEY,'hex');}
export function seal(value,p,env){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key(env),iv);c.setAAD(Buffer.from(p));const body=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');}
export function unseal(value,p,env){const b=Buffer.from(value,'base64'),c=createDecipheriv('aes-256-gcm',key(env),b.subarray(0,12));c.setAAD(Buffer.from(p));c.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]).toString());}
