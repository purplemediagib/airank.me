import test from 'node:test';
import assert from 'node:assert/strict';
import {apiObservation} from '../src/common/observations.mjs';
import {fixture} from './research.test.mjs';
import {draftFixture} from './suggestion-fixture.mjs';
import {monitoringService} from '../src/monitoring/service.mjs';
import {workspaceSuggestions,validateDraft} from '../src/common/workspace-suggestions.mjs';
import {researchService,frozenCohort} from '../src/research/service.mjs';
import {migrateSuggestions} from '../src/monitoring/suggestions-migration.mjs';
import {migrateImmediate} from '../src/monitoring/immediate-migration.mjs';
import {tickImmediate} from '../src/monitoring/immediate.mjs';
import {migrateDailyScheduling} from '../src/scheduling/daily-migration.mjs';
import {scheduleService,tickProjects} from '../src/scheduling/projects.mjs';
import {promptReadiness} from '../src/monitoring/prompt-policy.mjs';
import {extract,aggregate} from '../src/analytics/extraction.mjs';
import {sourceType} from '../src/intelligence/core.mjs';

const env={TRACKED_PROMPT_LIMIT:'30',MONITORING_ENABLED:'true',PROJECT_SCHEDULER_ENABLED:'true',ENABLED_PROVIDERS:'openai',OPENAI_API_KEY:'offline-fixture'};
test('FI and independent Swedish-context AI drafts retain a 4/2 mix, editable topics, acceptance metadata and cache identity',async()=>{
 for(const language of ['fi','sv']){
  const f=await fixture();try{
   const identity={...f.identity,market:'FI',promptLanguage:language};
   f.sql.prepare('UPDATE app_identity_versions SET identity_json=? WHERE project_id=?').run(JSON.stringify(identity),'project');
   let calls=0;
   const generate=async i=>{calls++;return draftFixture(i);};
   const api=(method,suffix,body)=>monitoringService({db:f.db,method,path:`/v1/projects/project/${suffix}`,body,userId:'alice',env,generate});
   let suggestions=(await api('POST','suggestions',{})).data;
   assert.equal(calls,1);assert.equal(suggestions.filter(s=>s.kind==='neutral').length,4);
   assert.equal(suggestions.filter(s=>s.kind==='diagnostic').length,2);
   assert.ok(suggestions.every(s=>s.topic&&s.market==='FI'&&s.language===language&&s.identityVersion===1));
   const draft=suggestions.find(s=>s.kind==='diagnostic');
   await assert.rejects(api('PATCH',`suggestions/${draft.id}`,{kind:'neutral'}),e=>e.code==='PROMPT_KIND_MISMATCH');
   await api('PATCH',`suggestions/${draft.id}`,{topic:'Edited topic',tags:['reviewed'],text:'Mitä Example tarjoaa käyttäjille?'});
   suggestions=(await api('POST','suggestions',{})).data;
   assert.equal(calls,1);assert.equal(suggestions.length,6); // Edits never recreate the original draft.
   assert.equal(suggestions.find(s=>s.id===draft.id).topic,'Edited topic');
   const accepted=(await api('POST',`suggestions/${draft.id}`,{action:'accept',topic:'Accepted topic'})).data;
   const prompt=(await api('GET',`prompts/${accepted.promptId}`)).data.prompt;
   assert.equal(prompt.kind,'diagnostic');assert.equal(prompt.topic,'Accepted topic');assert.deepEqual(prompt.tags,['reviewed']);
   assert.equal(prompt.language,language);
   await assert.rejects(api('PATCH',`suggestions/${draft.id}`,{topic:'Too late'}),e=>e.status===409);
   const reread=(await api('GET','suggestions')).data.find(s=>s.id===draft.id);
   assert.equal(reread.topic,'Accepted topic');assert.equal(reread.kind,'diagnostic');assert.equal(reread.promptId,prompt.id);
   await migrateSuggestions(f.db);
   assert.equal(await promptReadiness(f.db,'project',identity),'ready');
  }finally{f.sql.close();}
 }
});

test('malformed AI mix fails closed without relabeling, retries, prompts or guessed metadata',async()=>{
 const f=await fixture();try{
  let calls=0;
  const options={db:f.db,project:{id:'project',owner_id:'alice',version:1},identity:f.identity,env,
   generate:async i=>{calls++;return (await draftFixture(i)).map(s=>({...s,kind:'neutral'}));}};
  await assert.rejects(workspaceSuggestions(options),e=>e.code==='AI_UNAVAILABLE');
  await assert.rejects(workspaceSuggestions(options),e=>e.code==='AI_UNAVAILABLE');
  assert.equal(calls,1);assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_prompts').get().n,0);
  assert.throws(()=>validateDraft({text:'Mitä Examplen palvelu tarjoaa?',kind:'neutral',topic:'',tags:[]},f.identity),/PROMPT_KIND_MISMATCH/);
  assert.equal(validateDraft({text:'Mitä Examplen palvelu tarjoaa?',kind:'diagnostic',topic:'',tags:[]},f.identity).kind,'diagnostic');
  assert.throws(()=>validateDraft({text:'Mitkä palvelut sopivat?',kind:'other',topic:'',tags:[]},f.identity),/VALIDATION_FAILED/);
 }finally{f.sql.close();}
});

test('configured FI generation uses bounded structured AI output once; truncation is never retried or persisted as drafts',async()=>{
 for(const finishReason of ['stop','length']){
  const f=await fixture(),oldFetch=globalThis.fetch;let calls=0;
  try{
   globalThis.fetch=async(url,options)=>{
    calls++;assert.equal(url,'https://api.openai.com/v1/chat/completions');
    const request=JSON.parse(options.body);
    assert.equal(request.response_format.json_schema.strict,true);
    assert.equal(request.max_tokens,2200);assert.equal(request.model,'offline-model');
    assert.match(request.messages[0].content,/FOUR neutral/);
    assert.match(request.messages[0].content,/TWO diagnostic/);
    assert.match(request.messages[0].content,/Finnish/);
    const response={choices:[{finish_reason:finishReason,message:{content:JSON.stringify({items:await draftFixture(f.identity)})}}]};
    return {ok:true,status:200,headers:new Headers(),text:async()=>JSON.stringify(response)};
   };
   const options={db:f.db,project:{id:'project',owner_id:'alice',version:1},identity:f.identity,env:{OPENAI_API_KEY:'offline-test-key',CONTEXT_PROMPT_MODEL:'offline-model'}};
   if(finishReason==='stop'){
    assert.equal((await workspaceSuggestions(options)).length,6);
    await workspaceSuggestions(options);assert.equal(calls,1);
   }else{
    await assert.rejects(workspaceSuggestions(options),/AI_UNAVAILABLE/);
    await assert.rejects(workspaceSuggestions(options),/AI_UNAVAILABLE/);assert.equal(calls,1);
    assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_suggestions').get().n,0);
   }
  }finally{globalThis.fetch=oldFetch;f.sql.close();}
 }
});

test('context competitor proposed domains never become ownership facts before explicit cohort review',async()=>{
 const f=await fixture();try{
  let calls=0;
  const api=(method,body,userId='alice')=>researchService({db:f.db,method,path:'/v1/projects/project/research',body,userId,env,
   generate:async()=>{calls++;return [{name:'Proposed Rival',proposedDomains:['rival.example']},{name:'No Domain Rival',proposedDomains:[]}];}});
  await api('GET');assert.equal(calls,0);
  const generated=(await api('POST',{action:'suggest'})).data;
  const candidate=generated.candidates.find(c=>c.name==='Proposed Rival');
  assert.deepEqual(candidate.proposedDomains,['rival.example']);assert.equal(candidate.reviewRequired,true);
  assert.equal(candidate.source,'project_context_ai');assert.deepEqual(candidate.evidenceIds,[]);
  assert.equal(generated.competitors.length,0);assert.equal(await frozenCohort(f.db,'project',f.identity),null);
  await api('POST',{action:'suggest'});assert.equal(calls,1);
  await assert.rejects(api('POST',{action:'accept',id:candidate.id,expectedVersion:0,name:candidate.name,aliases:[]}),e=>e.status===422);
  const accepted=(await api('POST',{action:'accept',id:candidate.id,expectedVersion:0,name:candidate.name,aliases:[],domains:[]})).data;
  assert.deepEqual(accepted.competitors[0].domains,[]);
  const frozen=await frozenCohort(f.db,'project',f.identity);
  assert.deepEqual(frozen.brands[1].ownedDomains,[]);
  const updated=(await api('POST',{action:'update',id:accepted.competitors[0].id,expectedVersion:1,name:candidate.name,aliases:[],domains:['reviewed.example']})).data;
  assert.deepEqual(updated.competitors[0].domains,['reviewed.example']);
  assert.deepEqual(frozen.brands[1].ownedDomains,[]); // no historical ownership rewrite
  await assert.rejects(api('POST',{action:'suggest'},'bob'),e=>e.status===404);
 }finally{f.sql.close();}
});

test('suggestion migration is additive to 0.20 tables, repeatable and detects drift without enrolling work',async()=>{
 const f=await fixture();try{
  await migrateSuggestions(f.db);await migrateSuggestions(f.db);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM app_competitor_drafts').get().n,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_suggestion_metadata').get().n,0);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM mon_runs').get().n,1); // existing run retained
  f.sql.prepare("UPDATE app_migrations SET checksum='drift' WHERE id='app-018-intelligent-suggestions'").run();
  await assert.rejects(migrateSuggestions(f.db),/checksum mismatch/);
 }finally{f.sql.close();}
});

test('daily and immediate workers schedule diagnostics separately, preserve diagnostic originals and neutral analytics',async()=>{
 for(const mode of ['daily','immediate']){
  const f=await fixture();try{
   await migrateImmediate(f.db);await migrateDailyScheduling(f.db);
   let clock=Date.parse('2026-10-20T12:00:00Z');const now=()=>clock;
   const api=(method,suffix,body)=>monitoringService({db:f.db,method,path:`/v1/projects/project/${suffix}`,body,userId:'alice',env,now});
   const neutral=(await api('POST','prompts',{text:'Mitkä palvelut sopivat pienyrityksille?',kind:'neutral',topic:'Sopivuus',tags:[]})).data;
   let diagnostic=(await api('POST','prompts',{text:'Miten Example sopii pienyrityksille?',kind:'diagnostic',topic:'Brändi',tags:[]})).data;
   diagnostic=(await api('PATCH',`prompts/${diagnostic.id}`,{...diagnostic,status:'archived',expectedVersion:1})).data;
   diagnostic=(await api('PATCH',`prompts/${diagnostic.id}`,{...diagnostic,status:'active',expectedVersion:2})).data;
   assert.equal(await promptReadiness(f.db,'project',f.identity),'ready');
   if(mode==='daily'){
    const schedule=(await scheduleService({db:f.db,method:'GET',path:'/v1/projects/project/schedule',userId:'alice',env,now})).data;
    clock=schedule.nextAt;await tickProjects(f.db,{env,now});await tickProjects(f.db,{env,now});
   }else{await tickImmediate(f.db,{env,now});await tickImmediate(f.db,{env,now});}
   const runs=f.sql.prepare("SELECT * FROM mon_runs WHERE id<>'run' ORDER BY kind").all();
   assert.equal(runs.length,2);assert.deepEqual(runs.map(r=>r.kind),['diagnostic','neutral']);
   const comparable=[];
   for(const r of runs){
    const snapshot=JSON.parse(r.snapshot);
    assert.equal(snapshot.prompts.length,1);assert.equal(snapshot.prompts[0].kind,r.kind);
    const prompt=r.kind==='neutral'?neutral:diagnostic;
    const task=f.sql.prepare('SELECT id FROM mon_tasks WHERE run_id=?').get(r.id);
    const original={id:task.id,runId:r.id,promptId:prompt.id,promptVersion:prompt.version,provider:'openai',status:'success',answer:'Example offers services.',citations:[],observedAt:clock,observation:apiObservation({complete:true})};
    f.sql.prepare('INSERT INTO mon_evidence VALUES (?,?,?,?)').run(task.id,r.id,JSON.stringify(original),clock);
    const row=extract(original,snapshot);comparable.push(row);
    if(r.kind==='diagnostic'){
     assert.equal(row.exclusion,'diagnostic');
     const detail=(await api('GET',`prompts/${diagnostic.id}`)).data;
     assert.equal(detail.measurements[0].answer,original.answer);
     const runDetail=(await api('GET',`monitoring-runs/${r.id}`)).data;
     assert.equal(runDetail.evidence[0].answer,original.answer);
    }
   }
   assert.equal(aggregate(comparable,2).eligible,1);
   assert.equal(aggregate(comparable.filter(e=>e.exclusion==='diagnostic'),1).eligible,0);
   if(mode==='daily')assert.equal(f.sql.prepare('SELECT state FROM app_schedule_slots').get().state,'submitted');
  }finally{f.sql.close();}
 }
});

test('source classification uses detectable publisher evidence, never ownership/TLD guesses, and manual overrides win',()=>{
 for(const [domain,type] of [['docs.microsoft.com','corporate'],['community.hubspot.com','ugc'],['sub.stackexchange.com','ugc'],['tekniikka.yle.fi','editorial'],['data.gov','institutional'],['department.example.ac.uk','institutional'],['service.gouv.fr','institutional']]){
  const result=sourceType(domain);assert.equal(result.sourceType,type);assert.notEqual(result.sourceTypeProvenance,'unclassified');
 }
 for(const domain of ['unknown-company.com','news-site.example','charity.org','notgov.example','gov.uk.attacker.example','bbc.com.attacker.example','random.edu.example']){
  assert.equal(sourceType(domain).sourceType,'unknown');
 }
 const manual=new Map([['data.gov',{value:'corporate',updated_at:123}]]);
 assert.deepEqual(sourceType('data.gov',manual),{sourceType:'corporate',sourceTypeProvenance:'workspace_review',sourceTypeReviewedAt:123});
 assert.equal(sourceType('brand-new.example',new Map([['brand-new.example',{value:'unknown',updated_at:2}]])).sourceTypeProvenance,'workspace_review');
});
