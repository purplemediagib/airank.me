import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {measurementContext,contextCatalog,contextInstruction} from '../src/common/measurement-context.mjs';
import {migrateContextDrafts} from '../src/common/context-migration.mjs';
import {contextPrompts} from '../src/common/context-prompts.mjs';
import {monitoringService} from '../src/monitoring/service.mjs';
import {fixture} from './research.test.mjs';
import {migrateWebsiteProfiles} from '../src/website-profile/migration.mjs';
import {websiteProfileService} from '../src/website-profile/service.mjs';
import {tickWebsiteProfiles} from '../src/website-profile/worker.mjs';
import {extract} from '../src/analytics/extraction.mjs';
test('global catalog and independent context include Bulgaria, Gibraltar, Nordic and non-Latin languages; exclude Russia',()=>{
 const c=contextCatalog();assert.equal(c.markets.length,248);assert.ok(c.languages.length>170);
 for(const [market,language] of [['FI','sv'],['BG','bg'],['GI','en'],['JP','ja'],['AE','ar'],['NO','nb']])assert.deepEqual(measurementContext({market,language}),{market,language});
 assert.throws(()=>measurementContext({market:'RU'}),/MARKET_EXCLUDED/);
 assert.throws(()=>measurementContext({language:'xx'}),/INVALID/);
 assert.equal(measurementContext({market:'BG',language:'ru'}).language,'ru');
 assert.match(contextInstruction({market:'BG',language:'bg'}),/Bulgarian/);
 assert.ok(!c.markets.some(v=>v.code==='RU'));
});
test('reviewed prompt snapshots retain context; language changes block old prompts and cached draft generation deduplicates',async()=>{
 const f=await fixture();try{
 await migrateContextDrafts(f.db);await migrateContextDrafts(f.db);
 const identity={...f.identity,market:'FI',promptLanguage:'sv'};
 // Fixture exposes its identity separately; read the authoritative row for compatibility.
 const original=JSON.parse(f.sql.prepare('SELECT identity_json FROM app_identity_versions WHERE project_id=?').get('project').identity_json);
 Object.assign(identity,original,{market:'FI',promptLanguage:'sv'});
 f.sql.prepare('UPDATE app_identity_versions SET identity_json=? WHERE project_id=?').run(JSON.stringify(identity),'project');
 let calls=0;const generate=async()=>{calls++;return ['Vilka alternativ passar för små företag?','Vilka tjänster är enkla att använda?','Vilka leverantörer finns i Finland?','Vilka alternativ bör kunder jämföra?','Vilka tjänster har tydliga begränsningar?','Vilka alternativ passar kundens behov?'];};
 const opts={db:f.db,project:{id:'project',version:1,owner_id:'alice'},identity,env:{},generate};
 assert.deepEqual(await contextPrompts(opts),await contextPrompts(opts));assert.equal(calls,1);
 const env={TRACKED_PROMPT_LIMIT:'100',MONITORING_ENABLED:'true',ENABLED_PROVIDERS:'openai'};
 const req=(kind,body)=>monitoringService({db:f.db,method:'POST',path:'/v1/projects/project/'+kind,body,userId:'alice',env,generate});
 const prompt=(await req('prompts',{text:'Vilka alternativ passar företag i Finland?',topic:'',tags:[],kind:'neutral'})).data;
 assert.equal(prompt.language,'sv');
 const run=(await req('monitoring-runs',{kind:'neutral',submissionId:randomUUID()})).data;
 const snapshot=JSON.parse(f.sql.prepare('SELECT snapshot FROM mon_runs WHERE id=?').get(run.id).snapshot);
 assert.equal(snapshot.language,'sv');assert.equal(snapshot.market,'FI');
 f.sql.prepare('UPDATE app_identity_versions SET identity_json=? WHERE project_id=?').run(JSON.stringify({...identity,market:'BG',promptLanguage:'bg'}),'project');
 await assert.rejects(req('monitoring-runs',{kind:'neutral',submissionId:randomUUID()}),/PROMPT_REVIEW_REQUIRED/);
 assert.equal(snapshot.language,'sv');
 }finally{f.sql.close();}
});
test('autofill snapshots selected context, rejects changed idempotent input and blocks Russia before fetching',async()=>{
 const f=await fixture();try{
 await migrateWebsiteProfiles(f.db);const env={WEBSITE_PROFILE_ENABLED:'true'};
 const body={website:'example.fi',market:'FI',promptLanguage:'sv',submissionId:randomUUID()};
 const req=b=>websiteProfileService({db:f.db,method:'POST',path:'/v1/website-profiles',body:b,userId:'alice',env});
 const job=(await req(body)).data;
 await assert.rejects(req({...body,promptLanguage:'bg'}),/VERSION_CONFLICT/);
 await assert.rejects(req({...body,market:'RU',submissionId:randomUUID()}),/MARKET_EXCLUDED/);
 await tickWebsiteProfiles(f.db,{env,validate:async()=>({domain:'example.fi',website:'https://example.fi/'}),scrape:async site=>{assert.equal(site.language,'sv');return{text:'Företagstjänster',source:site.website};},infer:async()=>({draft:{brandName:'EXAMPLE',categoryFi:'Tjänster för företag',aliases:[],ownedDomains:['example.fi']},sources:[]})});
 const got=(await websiteProfileService({db:f.db,method:'GET',path:'/v1/website-profiles/'+job.id,userId:'alice',env})).data;
 assert.equal(got.draft.promptLanguage,'sv');assert.equal(got.market,'FI');
 }finally{f.sql.close();}
});
test('unsupported recommendation languages remain unknown rather than borrowing English keywords',()=>{
 const row=extract({status:'success',answer:'Recommended options:\\n1. Example\\n2. Other',citations:[]},{kind:'neutral',language:'bg',identity:{brandName:'Example',aliases:[],ownedDomains:[]}});
 assert.equal(row.mentioned,true);assert.equal(row.recommendation,'unknown');assert.equal(row.position,null);
});
