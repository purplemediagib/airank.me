import {teamsEnabled,visibleProjects,RANK} from '../common/access.mjs';
import {hashToken,randomToken,uuid} from '../common/utils.mjs';
import {id as migrationId,checksum} from './report-token-migration.mjs';

const fail=(status,code)=>{throw Object.assign(new Error(code),{status,code});};
const exec=(db,sql,args=[])=>db.execute({sql,args});
const one=async(db,sql,args)=>(await exec(db,sql,args)).rows[0]||null;
export const reportReadAllowed=(method,path)=>method==='GET'&&/^\/v1\/projects(?:\/[a-zA-Z0-9-]{1,80}(?:\/analytics)?)?$/.test(path);
const bodyKeys=(body,allowed)=>{
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!allowed.includes(k)))fail(422,'VALIDATION_FAILED');
};

export function createReportTokens({db,env=process.env,now=Date.now}){
 const ready=async()=>{
  if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[migrationId]))?.checksum!==checksum)fail(503,'REPORT_TOKENS_NOT_CONFIGURED');
 };
 const transaction=async fn=>{
  const tx=await db.transaction('write');
  try{const r=await fn(tx);await tx.commit();return r;}
  catch(error){await tx.rollback();throw error;}finally{tx.close();}
 };
 const audit=(tx,userId,kind,stamp)=>exec(tx,'INSERT INTO app_audit_events VALUES (?,?,?,?,?,?)',[uuid(),userId,null,kind,0,new Date(stamp).toISOString()]);
 return {
  async resolve(authorization){
   // Credential bytes are case sensitive; only the HTTP authentication scheme is not.
   const match=typeof authorization==='string'&&authorization.match(/^[Bb][Ee][Aa][Rr][Ee][Rr] (airank_rt_[A-Za-z0-9_-]{43})$/);
   if(!match)return null;
   await ready();
   const row=await one(db,`SELECT t.id,t.last_used_at,u.id AS user_id,u.email,u.display_name FROM app_report_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>?`,[hashToken(match[1]),now()]);
   return row?{machine:true,tokenId:row.id,lastUsedAt:row.last_used_at,user:{id:row.user_id,email:row.email,name:row.display_name||''}}:null;
  },
  async touch(auth){
   const stamp=now();
   if(auth.lastUsedAt!==null&&stamp-Number(auth.lastUsedAt)<60000)return;
   // Conditional update prevents concurrent reads from producing repeated writes.
   await exec(db,'UPDATE app_report_tokens SET last_used_at=? WHERE id=? AND revoked_at IS NULL AND expires_at>? AND (last_used_at IS NULL OR last_used_at<=?)',[stamp,auth.tokenId,stamp,stamp-60000]);
  },
  async manage(method,path,body,userId){
   const root=path==='/v1/app/report-tokens';
   const revoke=method==='POST'&&path.match(/^\/v1\/app\/report-tokens\/([a-zA-Z0-9-]{1,80})\/revoke$/);
   if(!(root&&['GET','POST'].includes(method))&&!revoke)return null;
   await ready();
   if(root&&method==='POST'){
    bodyKeys(body,['label']);
    if(body.label!==undefined&&(typeof body.label!=='string'||!body.label.trim()||body.label.length>60||/[\u0000-\u001f\u007f]/.test(body.label)))fail(422,'VALIDATION_FAILED');
    const label=body.label?.trim()||'Weekly report',rawDays=String(env.REPORT_TOKEN_DAYS??'180');
    const days=Number(rawDays);
    if(!/^\d{1,3}$/.test(rawDays)||!Number.isSafeInteger(days)||days<1||days>365)fail(503,'REPORT_TOKEN_DAYS_INVALID');
    const token=`airank_rt_${randomToken(32)}`,id=uuid(),stamp=now(),expiresAt=stamp+days*86400000;
    return transaction(async tx=>{
     if(await teamsEnabled(tx)&&!(await visibleProjects(tx,userId)).some(p=>RANK[p.myRole]>=RANK.admin))fail(403,'ROLE_FORBIDDEN');
     await exec(tx,'INSERT INTO app_report_tokens (id,token_hash,user_id,label,created_at,expires_at,last_used_at,revoked_at) VALUES (?,?,?,?,?,?,NULL,NULL)',[id,hashToken(token),userId,label,stamp,expiresAt]);
     await audit(tx,userId,'report_token.created',stamp);
     // This is the only response that contains the credential. Never persist/log it.
     return {status:201,data:{id,token,label,expiresAt:new Date(expiresAt).toISOString()}};
    });
   }
   if(root)return {status:200,data:(await exec(db,'SELECT id,label,created_at AS createdAt,expires_at AS expiresAt,last_used_at AS lastUsedAt,revoked_at AS revokedAt FROM app_report_tokens WHERE user_id=? ORDER BY created_at DESC,id',[userId])).rows};
   bodyKeys(body,[]);
   return transaction(async tx=>{
    const row=await one(tx,'SELECT id,revoked_at FROM app_report_tokens WHERE id=? AND user_id=?',[revoke[1],userId]);
    if(!row)fail(404,'NOT_FOUND');
    if(row.revoked_at===null){
     const stamp=now();await exec(tx,'UPDATE app_report_tokens SET revoked_at=? WHERE id=? AND user_id=?',[stamp,row.id,userId]);
     await audit(tx,userId,'report_token.revoked',stamp);
    }
    return {status:200,data:{ok:true}};
   });
  },
 };
}
