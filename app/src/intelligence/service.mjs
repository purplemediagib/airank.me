import {randomUUID} from 'node:crypto';
import {one,exec,transaction,fail} from '../monitoring/shared.mjs';
import {id,checksum} from './migration.mjs';
import {configuration,domainKey,keyFor} from './core.mjs';
import {enqueue} from './engine.mjs';
export async function intelligenceService({db,path,body,userId,env=process.env,now=Date.now}){
 const projectId=path.split('/')[3],c=configuration(env);
 const owned=async tx=>{if(!await one(tx,"SELECT id FROM app_projects WHERE id=? AND owner_id=? AND status='active'",[projectId,userId]))fail(404,'NOT_FOUND');};
 await owned(db);
 if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)fail(503,'INTELLIGENCE_NOT_CONFIGURED');
 if(!body||!['analyse','source_review','brand_review'].includes(body.action))fail(422,'VALIDATION_FAILED');
 return transaction(db,async tx=>{
  await owned(tx);
  if(body.action==='analyse'){
   if(env.ENTITY_ANALYSIS_ENABLED!=='true')fail(503,'ENTITY_ANALYSIS_NOT_ENABLED');
   const ids=body.evidenceIds;
   if(!Array.isArray(ids)||!ids.length||ids.length>50||new Set(ids).size!==ids.length||ids.some(x=>typeof x!=='string'||!/^[\w-]{1,100}$/.test(x)))fail(422,'VALIDATION_FAILED');
   const rows=(await exec(tx,`SELECT e.payload,e.run_id,r.snapshot FROM mon_evidence e JOIN mon_runs r ON r.id=e.run_id WHERE r.project_id=? AND r.owner_id=? AND e.id IN (${ids.map(()=>'?').join(',')})`,[projectId,userId,...ids])).rows;
   if(rows.length!==ids.length)fail(404,'NOT_FOUND');
   return {status:200,data:{queued:await enqueue(tx,rows,c,now()),updated:false,version:c.version}};
  }
  const kind=body.action==='source_review'?'source':'brand';
  const key=kind==='source'?domainKey(body.domain):typeof body.key==='string'?keyFor(body.key):null;
  const value=kind==='source'?body.sourceType:body.review;
  if(typeof key!=='string'||!key||key.length>180||!((kind==='source'?['corporate','ugc','editorial','institutional','unknown',null]:['confirmed','rejected',null]).includes(value)))fail(422,'VALIDATION_FAILED');
  if(value===null)await exec(tx,'DELETE FROM intelligence_reviews WHERE project_id=? AND kind=? AND key=?',[projectId,kind,key]);
  else await exec(tx,'INSERT INTO intelligence_reviews VALUES (?,?,?,?,?) ON CONFLICT(project_id,kind,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',[projectId,kind,key,value,now()]);
  await exec(tx,'INSERT INTO intelligence_review_audit VALUES (?,?,?,?,?,?)',[randomUUID(),projectId,kind,key,value,now()]);
  return {status:200,data:{queued:0,updated:true,version:c.version}};
 });
}
