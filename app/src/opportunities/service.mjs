import {one,exec,fail,hash,transaction} from '../monitoring/shared.mjs';
import {analyticsService} from '../analytics/service.mjs';
import {id,checksum} from './migration.mjs';
export const ruleVersion='fi-evidence-actions-v1';
export async function opportunityService({db,method,path,body,userId,now=Date.now}){
 const projectId=path.split('/')[3],itemId=path.split('/')[5];
 const p=await one(db,'SELECT * FROM app_projects WHERE id=? AND owner_id=?',[projectId,userId]);if(!p)fail(404,'NOT_FOUND');
 try{if((await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum!==checksum)fail(503,'APP_NOT_CONFIGURED');}catch{fail(503,'APP_NOT_CONFIGURED');}
 if(method!=='GET'&&p.status!=='active')fail(409,'VERSION_CONFLICT');
 const list=async cx=>(await exec(cx,'SELECT payload FROM app_opportunities WHERE project_id=? ORDER BY id',[projectId])).rows.map(r=>JSON.parse(r.payload));
 if(method==='POST'&&!itemId){
  if(body?.refresh!==true)fail(422,'VALIDATION_FAILED');
  const a=(await analyticsService({db,path:`/v1/projects/${projectId}/analytics`,userId})).data;
  await transaction(db,async tx=>{
   const existing=new Map((await list(tx)).map(o=>[o.id,o]));
   for(const kind of ['visibility_gap','citation_review']){
    const rows=a.evidence.filter(e=>!e.exclusion&&(kind==='visibility_gap'?!e.mentioned:e.citations.length>0&&!e.ownedCitation));
    if(!rows.length)continue;
    const groups=new Map();for(const e of rows){if(!groups.has(e.promptId))groups.set(e.promptId,[]);groups.get(e.promptId).push(e);}
    for(const [promptId,ev] of groups){
     const key=hash([ruleVersion,kind,promptId]).slice(0,32),old=existing.get(key),stamp=now();
     if(old?.status==='completed')continue; // Keep the evidence that supported the completed action.
     const sample=a.evidence.filter(e=>e.promptId===promptId&&!e.exclusion),missing=ev.length;
     const o={id:key,version:(old?.version||0)+1,ruleVersion,kind,
      titleFi:kind==='visibility_gap'?'Tarkista brändin löydettävyys':'Tutki viitattuja lähteitä',
      titleEn:kind==='visibility_gap'?'Review brand discoverability':'Review cited sources',
      rationaleFi:`${missing}/${sample.length} kelvollista vastausta ${kind==='visibility_gap'?'ei mainitse brändiä':'viittaa muihin lähteisiin ilman omaa lähdeviittausta'}. Koko otoksen kattavuus ${a.metrics.eligible}/${a.metrics.expected}. Tämä ei ole sivustoauditointi.`,
      rationaleEn:`${missing}/${sample.length} eligible answers ${kind==='visibility_gap'?'do not mention the brand':'cite other sources without an owned citation'}. Overall coverage ${a.metrics.eligible}/${a.metrics.expected}. This is not a website audit.`,
      actionFi:kind==='visibility_gap'?'Vertaa alkuperäisiä vastauksia ja kysymystä yrityksesi julkisiin palvelukuvauksiin. Tarkista olennaisten tietojen selkeys ennen muutoksia.':'Avaa viitatut sivut ja arvioi niiden merkitys. Selvitä tarvittaessa, miten yrityksesi tiedot voidaan esittää täsmällisesti. Sijoituksen paranemista ei luvata.',
      actionEn:kind==='visibility_gap'?'Compare the original answers and question with your public service descriptions. Review whether relevant information is clear before making changes.':'Open the cited pages and review their relevance. Where appropriate, investigate accurate representation of your business. No ranking improvement is guaranteed.',
      priority:missing>=3&&missing===sample.length?'high':'medium',status:old?.status||'new',notes:old?.notes||'',createdAt:old?.createdAt||stamp,updatedAt:stamp,
      evidenceIds:ev.map(e=>e.id),runIds:[...new Set(ev.map(e=>e.runId))],eligible:sample.length,expected:a.metrics.expected,history:old?.history||[{at:stamp,status:'new',notes:''}]};
     await exec(tx,'INSERT INTO app_opportunities VALUES (?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET version=excluded.version,payload=excluded.payload',[projectId,key,o.version,JSON.stringify(o)]);
    }
   }
  });
 }else if(method==='PATCH'&&itemId){
  await transaction(db,async tx=>{
   const r=await one(tx,'SELECT * FROM app_opportunities WHERE project_id=? AND id=?',[projectId,itemId]);if(!r)fail(404,'NOT_FOUND');
   if(body?.expectedVersion!==Number(r.version))fail(409,'VERSION_CONFLICT');
   if(!['new','in_progress','completed'].includes(body.status)||typeof body.notes!=='string'||body.notes.length>4000)fail(422,'VALIDATION_FAILED');
   const o=JSON.parse(r.payload);Object.assign(o,{version:o.version+1,status:body.status,notes:body.notes,updatedAt:now()});
   o.history.push({at:now(),status:body.status,notes:body.notes});
   await exec(tx,'UPDATE app_opportunities SET version=?,payload=? WHERE project_id=? AND id=?',[o.version,JSON.stringify(o),projectId,itemId]);
  });
  return{status:200,data:(await list(db)).find(o=>o.id===itemId)};
 }else if(method!=='GET')fail(405,'METHOD_NOT_ALLOWED');
 return{status:200,data:await list(db)};
}
