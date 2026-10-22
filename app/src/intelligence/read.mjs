import {one,exec} from '../monitoring/shared.mjs';
import {id,checksum} from './migration.mjs';
import {version,configuration,fanoutAnalytics,discoveryAnalytics,sourceType} from './core.mjs';
export async function readIntelligence(db,projectId,entries,overview,env=process.env){
 const rows=entries.flatMap(e=>e.rows),c=configuration(env);
 const migrationTable=await one(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='app_migrations'");
 const available=!!migrationTable&&(await one(db,'SELECT checksum FROM app_migrations WHERE id=?',[id]))?.checksum===checksum;
 const reviews=available?(await exec(db,'SELECT * FROM intelligence_reviews WHERE project_id=?',[projectId])).rows:[];
 const sourceReviews=new Map(reviews.filter(r=>r.kind==='source').map(r=>[r.key,r]));
 if(overview?.sources)overview.sources.items=overview.sources.items.map(item=>({...item,...sourceType(item.domain,sourceReviews)}));
 const jobs=new Map();
 // Bound DB annotations to selected run IDs; no all-history analysis payload scan.
 if(available)for(let i=0;i<entries.length;i+=100){
  const ids=entries.slice(i,i+100).map(e=>e.id);
  for(const j of (await exec(db,`SELECT * FROM intelligence_jobs WHERE analysis_version=? AND run_id IN (${ids.map(()=>'?').join(',')})`,[c.version,...ids])).rows)jobs.set(j.evidence_id,j);
 }
 return {version:c.version,available,enabled:env.ENTITY_ANALYSIS_ENABLED==='true',model:c.model,eligibleAnswers:rows.filter(e=>!e.exclusion).length,...discoveryAnalytics(rows,jobs,new Map(reviews.filter(r=>r.kind==='brand').map(r=>[r.key,r]))),fanout:fanoutAnalytics(rows),rankingScope:'detected_brands_in_analysed_answers'};
}
