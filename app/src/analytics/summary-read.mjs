// Saved-model reads use a fresh fixed-endpoint snapshot. Discovery describes
// optional legacy schema only; authorization is evaluated again inside BEGIN.
import {fail} from '../monitoring/shared.mjs';
import {id,checksum} from './summary-migration.mjs';
import {atomicPlan,statement,assertion,CLOCK_SQL} from './summary-plans.mjs';
import {resultRows} from './summary-transport.mjs';
const schemaSQL="SELECT name FROM sqlite_master WHERE type='table' AND name IN ('app_migrations','app_workspaces','app_workspace_members','app_project_guests') ORDER BY name";
export async function savedSnapshot(db,projectId,userId,env,reads){
 if(env.AIRANK_ANALYTICS_SUMMARY_ENABLED!=='true')fail(404,'NOT_FOUND');
 let names;
 try{names=(await db.execute(schemaSQL)).rows.map(r=>r.name);}catch(e){if(e.code==='ANALYTICS_PROJECTION_LIMIT')throw e;fail(503,'ANALYTICS_READ_UNAVAILABLE');}
 if(names.some(n=>!['app_migrations','app_workspaces','app_workspace_members','app_project_guests'].includes(n))||new Set(names).size!==names.length)fail(503,'ANALYTICS_READ_UNAVAILABLE');
 if(!names.includes('app_migrations'))fail(503,'ANALYTICS_NOT_CONFIGURED');
 const teams=names.includes('app_workspaces');
 const auth=teams?`EXISTS(SELECT 1 FROM app_projects p WHERE p.id=? AND (p.owner_id=? OR EXISTS(SELECT 1 FROM app_workspace_members m WHERE m.workspace_id=p.workspace_id AND m.user_id=? AND m.role IS NOT NULL AND m.role<>'') OR EXISTS(SELECT 1 FROM app_project_guests g WHERE g.project_id=p.id AND g.user_id=? AND g.role IS NOT NULL AND g.role<>'')))`:`EXISTS(SELECT 1 FROM app_projects WHERE id=? AND owner_id=?)`;
 const plan=atomicPlan([
  assertion('schema',`(SELECT json_group_array(name) FROM (${schemaSQL}))=?`,[JSON.stringify(names)]),
  assertion('authorized',auth,teams?[projectId,userId,userId,userId]:[projectId,userId]),
  assertion('configured','EXISTS(SELECT 1 FROM app_migrations WHERE id=? AND checksum=?)',[id,checksum]),
  statement('clock',`SELECT ${CLOCK_SQL} stamp`,[],true),...reads
 ],{readOnly:true,phase:'read'});
 const result=await db.summaryAtomic(plan);
 if(result.outcome!=='committed'){
  if(result.reason==='response_limit')fail(422,'ANALYTICS_PROJECTION_LIMIT');
  if(result.outcome==='rolled_back'&&result.reason==='generation_expired')fail(409,'ANALYTICS_GENERATION_EXPIRED');
  if(result.outcome==='rolled_back'&&['authorized','generation_missing'].includes(result.reason))fail(404,'NOT_FOUND');
  if(result.outcome==='rolled_back'&&['schema','configured'].includes(result.reason))fail(503,'ANALYTICS_NOT_CONFIGURED');
  fail(503,'ANALYTICS_READ_UNAVAILABLE');
 }
 const rows=label=>{try{return resultRows(plan,result,label);}catch{fail(503,'ANALYTICS_READ_UNAVAILABLE');}},clock=rows('clock'),stamp=clock[0]?.stamp;
 if(clock.length!==1)fail(503,'ANALYTICS_READ_UNAVAILABLE');
 if(!Number.isSafeInteger(stamp)||stamp<=0)fail(503,'ANALYTICS_READ_UNAVAILABLE');
 return {rows,stamp};
}
export const select=(label,sql,args=[])=>statement(label,sql,args,true);
