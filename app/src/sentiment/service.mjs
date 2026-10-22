import {one,exec,fail,transaction} from '../monitoring/shared.mjs';
import {config} from './core.mjs';
import {enqueue} from './engine.mjs';
import {id,checksum} from './migration.mjs';
export async function backfillService({db,path,body,userId,env=process.env,now=Date.now}){
 const projectId=path.split('/')[3];
 const owned=async tx=>{if(!await one(tx,"SELECT id FROM app_projects WHERE id=? AND owner_id=? AND status='active'",[projectId,userId]))fail(404,'NOT_FOUND');};
 await owned(db);
 if(env.SENTIMENT_ENABLED!=='true')fail(503,'SENTIMENT_NOT_ENABLED');
 if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)fail(503,'SENTIMENT_NOT_CONFIGURED');
 if(typeof body?.runId!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(body.runId))fail(422,'VALIDATION_FAILED');
 return transaction(db,async tx=>{
  await owned(tx);
  if(!await one(tx,'SELECT id FROM mon_runs WHERE id=? AND project_id=? AND owner_id=?',[body.runId,projectId,userId]))fail(404,'NOT_FOUND');
  const rows=(await exec(tx,'SELECT e.payload,r.snapshot FROM mon_evidence e JOIN mon_runs r ON r.id=e.run_id WHERE r.id=? AND r.project_id=? AND r.owner_id=? ORDER BY e.id',[body.runId,projectId,userId])).rows;
  const c=config(env),queued=await enqueue(tx,rows,c,now());
  return {status:202,data:{runId:body.runId,queued,analysisVersion:c.version,message:'Saved answers queued within the separate sentiment budget. Existing jobs are not repeated.'}};
 });
}
