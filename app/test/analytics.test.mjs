import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { extract,aggregate } from '../src/analytics/extraction.mjs';
import { analyticsService,composition,promptSummaries } from '../src/analytics/service.mjs';
import { resultsService } from '../src/analytics/results.mjs';
import { migrations } from '../src/migrate.mjs';
import { appDDL } from '../src/app/migration.mjs';
import { scanDDL } from '../src/app/scan-migration.mjs';
import { ddl } from '../src/monitoring/migration.mjs';
const identity={brandName:'Example',aliases:['Example Oy'],ownedDomains:['example.fi','example.com']};
const snapshot={identity,identityVersion:1,kind:'neutral',market:'FI',language:'fi',methodology:'tracked-fi-evidence-v1',prompts:[{id:'p',version:1,text:'Mitkä vaihtoehdot?',topic:'Hinta'}],routes:[{provider:'openai',model:'fixture'}]};
const row=(answer='Example',extra={},s=snapshot)=>extract({id:'e',runId:'r',promptId:'p',promptVersion:1,text:'Mitkä vaihtoehdot?',provider:'openai',model:'fixture',status:'success',observedAt:1,answer,citations:[],...extra},s);
test('specified formulas, weighting, unique mentions and separate owned citations',()=>{
 const rows=Array.from({length:132},(_,i)=>row(i<84?'Example Example Oy Example':'Other',{citations:i<36?[{url:'https://sub.example.com/a'},{url:'https://sub.example.com/a'}]:[]}));
 const m=aggregate(rows,132);assert.equal(m.visibility,63.6);assert.equal(m.score,6.4);assert.equal(m.citationRate,27.3);
 assert.equal(aggregate([row(),row(),row(),row(),row('Other'),row('Other')],6).score,6.7);
 assert.equal(aggregate([row('Other')],1).score,0);assert.equal(aggregate([],0).score,null);
 const uneven=[row(),...Array.from({length:9},()=>row('Other',{provider:'claude'}))];
 assert.equal(aggregate(uneven,10).visibility,10);
 assert.equal(row('Exampleton').mentioned,false);assert.equal(row('Ｅｘａｍｐｌｅ').mentioned,true);
 const citation=row('Other',{citations:[{url:'https://example.fi/a'},{url:'javascript:alert(1)'},{url:'https://example.fi.evil.org'}]});
 assert.equal(citation.mentioned,false);assert.equal(citation.ownedCitation,true);assert.equal(citation.citations.length,2);
 assert.equal(row('Other',{citations:[{url:'https://example.fi.evil.org'}]}).ownedCitation,false);
});
test('classification preserves unknown, negative evidence, contradictions and explicit ordered positions',()=>{
 assert.equal(row('Example and Other are alternatives.').recommendation,'unknown');
 assert.equal(row('Suosittelen Example.').recommendation,'recommended');
 assert.equal(row('En suosittele Example.').recommendation,'not_recommended');
 assert.equal(row('I recommend Other; Example is an alternative.').recommendation,'unknown');
 assert.equal(row('I recommend Example if you do not need support.').recommendation,'unknown');
 assert.equal(row('I recommend Example. I do not recommend Example.').recommendation,'unknown');
 assert.equal(row('1. Example\n2. Other').position,null);
 assert.equal(row('Recommendations\n1. Other\n2. Example').position,2);
 assert.equal(row('Recommendations\n1. Other\n1. Example').position,null);
 assert.equal(row('Recommendations, tied\n1. Example\n2. Other').position,null);
 assert.equal(row('Recommendations\n- Example\n- Other').position,null);
 assert.ok(row('Suosittelen Example.').recommendationSpans.includes('Suosittelen Example.'));
 const m=aggregate([row('Suosittelen Example.'),row('Example')],2);
 assert.equal(m.classified,1);assert.equal(m.recommendationRate,100);
});
test('mean list position uses only valid explicit ranks as its denominator',()=>{
 const ranked=row('Recommendations\n1. Rival\n2. Example');
 const first=row('Recommendations\n1. Example\n2. Rival');
 const unranked=row('Example is one of several options.');
 const malformed={...unranked,position:1.5};
 const invalid=row('Recommendations\n1. Rival\n2. Example',{status:'failed'});
 const m=aggregate([ranked,first,unranked,malformed,invalid],5);
 assert.equal(ranked.position,2);
 assert.equal(first.position,1);
 assert.equal(m.positions,2);
 assert.equal(m.meanPosition,1.5);
 assert.equal(m.eligible,4);
 assert.equal(m.expected,5);
 assert.equal(aggregate([unranked],1).positions,0);
 assert.equal(aggregate([unranked],1).meanPosition,null);
});
test('invalid/diagnostic evidence excluded; cohort deduplication and fixed denominator',()=>{
 for(const status of ['failed','no_grounding','unconfigured','disabled','budget_blocked','interrupted_unknown']){
  assert.equal(aggregate([row('Example',{status})],1).score,null);
 }
 assert.equal(aggregate([row('')],1).score,null);
 assert.equal(row('Example',{}, {...snapshot,kind:'diagnostic'}).exclusion,'diagnostic');
 assert.equal(aggregate([row(),row('Example',{status:'failed'})],2).state,'partial');
 assert.equal(aggregate([row()],1).cohortShare,null);
 const cohort={brands:[identity,{brandName:'Other',aliases:['Other Oy']}]};
 const rows=Array.from({length:240},(_,i)=>row(i<84?'Example Example':'Other Other Oy',{}, {...snapshot,cohort}));
 assert.equal(aggregate(rows,240).cohortShare,35);
});
test('composition rejects identity, question, model, route, cohort or methodology changes',()=>{
 const tasks=[{prompt_id:'p',prompt_version:1,text:'Question'}],e=[row()];
 const base=composition(snapshot,tasks,e);
 for(const changed of [{identityVersion:2},{methodology:'v2'},{cohort:{brands:[identity]}},{routes:[{provider:'openai',model:'different'}]}])
  assert.notEqual(composition({...snapshot,...changed},tasks,e),base);
 assert.notEqual(composition(snapshot,[{...tasks[0],prompt_version:2}],e),base);
 assert.notEqual(composition(snapshot,tasks,[row('Example',{model:'different'})]),base);
});
function fixture(){
 const sql=new DatabaseSync(':memory:');
 for(const q of [...migrations,...appDDL,scanDDL,...ddl])sql.exec(q);
 sql.exec("INSERT INTO users (id,google_sub,email,display_name,created_at,updated_at) VALUES ('alice','alice','alice@example.com','Alice',1,1)");
 sql.prepare('INSERT INTO app_projects VALUES (?,?,?,?,?)').run('project','alice','active',1,'2026-01-01T00:00:00Z');
 sql.prepare('INSERT INTO app_identity_versions VALUES (?,?,?,?)').run('project',1,JSON.stringify(identity),'2026-01-01T00:00:00Z');
 const db={execute:async q=>({rows:sql.prepare(q.sql).all(...q.args)})};
 const add=(id,stamp,s=snapshot,answer='Example',provider='openai')=>{
  sql.prepare('INSERT INTO mon_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,'project','alice',id,id,s.kind,'completed',JSON.stringify(s),1,stamp,stamp+1000,null);
  sql.prepare('INSERT INTO mon_tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,id,'p',1,'Question',provider,'{}','done',null,null);
  sql.prepare('INSERT INTO mon_evidence VALUES (?,?,?,?)').run(id,id,JSON.stringify({...row(answer,{provider}),id,runId:id,citations:[]}),stamp);
 };
 return {sql,db,add,get:(query='',userId='alice')=>analyticsService({db,userId,path:'/v1/projects/project/analytics',query:new URLSearchParams(query)})};
}
test('tag and collection surface filters scope evidence, expected answers and options together',async()=>{
 const f=fixture(),stamp=Date.parse('2026-04-05T00:00:00Z');
 f.sql.prepare('INSERT INTO mon_prompts VALUES (?,?,?,?,?,?)').run('p','project',1,'active','hash',1);
 const tagged={...snapshot,prompts:[{...snapshot.prompts[0],tags:['pricing']}],routes:[{provider:'openai',model:'fixture',measurement_surface:'consumer_web'}]};
 f.add('web',stamp,tagged);
 f.add('api',stamp+1000);
 const a=(await f.get('tag=pricing&surface=consumer_web&promptId=p')).data;
 assert.equal(a.metrics.expected,1);assert.equal(a.metrics.eligible,1);assert.equal(a.evidence[0].runId,'web');
 assert.deepEqual(a.availableTags,['pricing']);assert.deepEqual(a.availableSurfaces,['consumer_web','model_api']);
 assert.deepEqual(a.availablePrompts,[{id:'p',text:'Mitkä vaihtoehdot?'}]);
 assert.equal((await f.get('tag=pricing&surface=model_api')).data.metrics.expected,0);
 for(const q of ['tag=missing','surface=missing'])await assert.rejects(f.get(q),e=>e.status===422);
 await assert.rejects(f.get('tag=pricing','bob'),e=>e.status===404);
});
test('multi-tag AND/OR and independent frozen market/language scope periods, denominators and evidence',async()=>{
 const f=fixture(),day=Date.parse('2026-04-05'),tags=encodeURIComponent(JSON.stringify(['pricing','research']));
 try {
  const context=(names,market='FI',language='en')=>({...snapshot,market,language,prompts:[{...snapshot.prompts[0],tags:names}]});
  f.add('both-prior',day-86400000,context(['pricing','research']));
  f.add('one-prior',day-86400000+1,context(['pricing']));
  f.add('both',day,context(['pricing','research']));
  f.add('one',day+1,context(['pricing']));
  f.add('fi',day+2,context(['pricing','research'],'FI','fi'));
  f.add('us',day+3,context(['pricing','research'],'US','en'));
  // The live project is unrelated to the frozen FI/en context.
  f.sql.prepare('UPDATE app_identity_versions SET identity_json=?').run(JSON.stringify({...identity,market:'DE',promptLanguage:'de'}));
  const base=`from=2026-04-05&to=2026-04-05&tags=${tags}&market=FI&language=en`;
  const and=(await f.get(`${base}&tagMode=and`)).data;
  assert.equal(and.metrics.expected,1);assert.deepEqual(and.evidence.map(e=>e.id),['both']);
  assert.equal(and.overview.comparison.metrics.expected,1);
  assert.deepEqual(and.availableMarkets,['FI','US']);assert.deepEqual(and.availableLanguages,['en','fi']);
  assert.equal(and.market,'FI');assert.equal(and.language,'en');
  const or=(await f.get(base)).data;
  assert.equal(or.metrics.expected,2);assert.equal(or.overview.comparison.metrics.expected,2);
  assert.equal(or.overview.sources.eligibleAnswers,2);
  const legacy=(await f.get('tag=pricing&market=FI&language=en')).data;
  assert.equal(legacy.metrics.expected,4);
  const results=await resultsService({db:f.db,path:'/v1/projects/project/results',userId:'alice',query:new URLSearchParams(`${base}&tagMode=and`)});
  assert.equal(results.data.total,1);assert.equal(results.data.items[0].id,'both');
  const either=await resultsService({db:f.db,path:'/v1/projects/project/results',userId:'alice',query:new URLSearchParams(base)});
  assert.equal(either.data.total,2);
 } finally { f.sql.close(); }
});
test('selected tags and modes are bounded and validated, including legacy compatibility',async()=>{
 const f=fixture();
 try {
  f.add('r',Date.parse('2026-04-05'),{...snapshot,prompts:[{...snapshot.prompts[0],tags:['a,b','pricing']}]});
  assert.equal((await f.get(`tags=${encodeURIComponent('["a,b"]')}`)).data.metrics.expected,1);
  assert.equal((await f.get(`tags=${encodeURIComponent('["a,b"]')}&tag=pricing&tagMode=and`)).data.metrics.expected,1);
  for(const value of ['invalid','{}','[""]','[42]',JSON.stringify(['x'.repeat(41)]),JSON.stringify(Array.from({length:13},(_,i)=>String(i)))]){
   await assert.rejects(f.get(`tags=${encodeURIComponent(value)}`),e=>e.status===422);
  }
  for(const q of ['tagMode=AND','market=fi','language=EN','market=US','language=en','tags=%5B%22missing%22%5D'])await assert.rejects(f.get(q),e=>e.status===422);
 }finally { f.sql.close(); }
});
test('results composition group matches analytics before pagination instead of combining historical versions',async()=>{
 const f=fixture(),day=Date.parse('2026-04-05');
 try{
  f.add('old',day,{...snapshot,identityVersion:1});
  f.add('new',day+1,{...snapshot,identityVersion:2});
  const a=(await f.get()).data,oldGroup=a.runs.find(r=>r.id==='old').group;
  const results=query=>resultsService({db:f.db,path:'/v1/projects/project/results',userId:'alice',query:new URLSearchParams(query)});
  const latest=(await results('group=latest&pageSize=1')).data;
  assert.equal(latest.total,1);assert.equal(latest.items[0].id,'new');
  const old=(await results(`group=${oldGroup}`)).data;
  assert.equal(old.total,1);assert.equal(old.items[0].id,'old');
  assert.equal((await results('')).data.total,2);
  await assert.rejects(results('group=unknown'),e=>e.status===422);
 }finally{f.sql.close();}
});
test('results group selects exact tasks in mixed runs and includes unfinished selected tasks',async()=>{
 const f=fixture(),day=Date.parse('2026-04-05');
 try{
  f.add('mixed',day,{...snapshot,routes:[{provider:'openai',model:'fixture',measurement_surface:'model_api'},{provider:'claude',model:'fixture',measurement_surface:'consumer_web'}]});
  f.sql.prepare('INSERT INTO mon_tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('pending-web','mixed','p',1,'Question','claude','{}','queued',null,null);
  const a=(await f.get()).data,webGroup=a.groups.find(g=>g.measurementSurface==='consumer_web').id;
  const results=query=>resultsService({db:f.db,path:'/v1/projects/project/results',userId:'alice',query:new URLSearchParams(query)});
  const selected=(await results(`group=${webGroup}&pageSize=1`)).data;
  assert.equal(selected.total,1);assert.equal(selected.items[0].id,'pending-web');assert.equal(selected.items[0].state,'queued');
  const api=(await results(`group=${a.groups.find(g=>g.measurementSurface==='model_api').id}`)).data;
  assert.equal(api.total,1);assert.equal(api.items[0].id,'mixed');
 }finally{f.sql.close();}
});
test('date-bounded reads avoid loading original answer payloads outside current and comparison windows',async()=>{
 const f=fixture();
 f.add('old',Date.parse('2025-01-01T00:00:00Z'));
 f.add('now',Date.parse('2026-04-05T00:00:00Z'));
 f.sql.prepare("UPDATE mon_evidence SET payload='invalid historical JSON' WHERE id='old'").run();
 const a=(await f.get('from=2026-04-05&to=2026-04-05')).data;
 assert.equal(a.metrics.expected,1);assert.equal(a.evidence[0].id,'now');
 assert.ok(a.overview.sources);
});
test('prompt summaries cover all runs and separate versions and composition, excluding diagnostic runs',()=>{
 const entry=(id,stamp,version=1,model='fixture',kind='neutral')=>{
  const s={...snapshot,kind},task={id,prompt_id:'p',prompt_version:version,text:'Question',provider:'openai'};
  return {id,createdAt:stamp,kind,snapshot:s,tasks:[task],rows:[row('Example',{id,model,promptVersion:version},s)]};
 };
 const entries=Array.from({length:35},(_,i)=>entry(`e${i}`,i));
 entries.push(entry('v2',40,2),entry('new-model',41,1,'new-model'),entry('diagnostic',42,1,'fixture','diagnostic'));
 const summaries=promptSummaries(entries),v1=summaries.find(s=>s.version===1);
 assert.equal(summaries.length,2);assert.equal(v1.groupCount,2);assert.equal(v1.runCount,1);
 assert.equal(v1.metrics.eligible,1);assert.equal(v1.metrics.visibility,100);
 const old=promptSummaries(entries.slice(0,35))[0];assert.equal(old.metrics.eligible,35);assert.equal(old.runCount,35);
 assert.equal(promptSummaries([entry('diag',1,1,'fixture','diagnostic')]).length,0);
});
test('prompt analytics verifies ownership and exact prompt/version scope, with explicit empty and invalid states',async()=>{
 const f=fixture();
 try {
  f.sql.prepare('INSERT INTO mon_prompts VALUES (?,?,?,?,?,?)').run('p','project',1,'active','hash',1);
  f.add('r',Date.parse('2026-01-01'));
  const a=(await f.get('promptId=p&promptVersion=1')).data;
  assert.deepEqual(a.promptScope,{promptId:'p',promptVersion:1});
  assert.equal(a.metrics.eligible,1);assert.equal(a.promptSummaries[0].version,1);
  const empty=(await f.get('promptId=p&promptVersion=2')).data;
  assert.equal(empty.totalRuns,0);assert.equal(empty.metrics.visibility,null);assert.deepEqual(empty.promptSummaries,[]);
  await assert.rejects(f.get('promptId=p','bob'),e=>e.status===404);
  await assert.rejects(f.get('promptId=other'),e=>e.status===404);
  for(const q of ['promptVersion=1','promptId=p&promptVersion=-1','promptId=p&promptVersion=1.5']) await assert.rejects(f.get(q),e=>e.status===422);
 }finally{f.sql.close();}
});
test('owned complete-dataset filtering/history, no invented intervals, incompatible aggregation and changes',async()=>{
 const f=fixture();
 try{
  const day=Date.parse('2026-01-01');
  for(let i=0;i<31;i++)f.add(`r${i}`,day+i*86400000);
  f.add('new',day+32*86400000,{...snapshot,identityVersion:2},'Other');
  f.add('diag',day+33*86400000,{...snapshot,kind:'diagnostic'});
  const a=(await f.get()).data;
  assert.equal(a.totalRuns,33);assert.equal(a.groups.length,2);assert.equal(a.metrics.score,0);
  for(const key of ['totalChats','totalRetrievals','retrievals','winRate','wins'])
   assert.equal(Object.hasOwn(a,key),false,`${key} must not be estimated from prompt runs`);
  for(const key of ['totalChats','totalRetrievals','retrievals','winRate','wins'])
   assert.equal(Object.hasOwn(a.metrics,key),false,`${key} must not be estimated from answer evidence`);
  assert.equal(a.runs.filter(r=>r.createdAt===day+31*86400000).length,0);
  const old=a.groups.find(g=>g.runCount===31);
  const b=(await f.get(`group=${old.id}`)).data;assert.equal(b.metrics.eligible,31);assert.equal(b.evidence.length,31);
  assert.equal((await f.get('from=2026-01-02&to=2026-01-03&provider=openai&topic=Hinta')).data.totalRuns,2);
  assert.equal((await f.get('runId=diag')).data.metrics.score,null);
  await assert.rejects(f.get('','bob'),e=>e.status===404);
  await assert.rejects(f.get('from=2026-02-30'),e=>e.status===422);
  await assert.rejects(f.get('provider=invalid'),e=>e.status===422);
  await assert.rejects(f.get('runId=missing'),e=>e.status===404);
 }finally{f.sql.close();}
});
test('run history exposes only explicit rank means and denominators within provider-filtered compositions',async()=>{
 const f=fixture();
 try{
  const day=Date.parse('2026-01-01');
  const multi={...snapshot,routes:[...snapshot.routes,{provider:'claude',model:'fixture'}]};
  f.add('ranked-openai',day,multi,'Recommendations\n1. Rival\n2. Example','openai');
  f.add('unranked-openai',day+86400000,multi,'Example is one of several options.','openai');
  f.add('ranked-claude',day+2*86400000,multi,'Recommendations\n1. Rival\n2. Example','claude');

  const openai=(await f.get('provider=openai')).data;
  assert.deepEqual(openai.runs.map(r=>r.id),['ranked-openai','unranked-openai']);
  assert.equal(openai.runs[0].metrics.meanPosition,2);
  assert.equal(openai.runs[0].metrics.positions,1);
  assert.equal(openai.runs[1].metrics.meanPosition,null);
  assert.equal(openai.runs[1].metrics.positions,0);

  const claude=(await f.get('provider=claude')).data;
  assert.deepEqual(claude.runs.map(r=>r.id),['ranked-claude']);
  assert.equal(claude.runs[0].metrics.meanPosition,2);
  assert.equal(claude.runs[0].metrics.positions,1);
 }finally{f.sql.close();}
});
test('competitor measurements use frozen cohorts, real citations, comparable runs and ownership', async () => {
 const f=fixture();
 try {
  const day=Date.parse('2026-01-01');
  const cohort={brands:[identity,{brandName:'Other',aliases:[],ownedDomains:['other.fi']}]};
  const s={...snapshot,cohort};
  f.add('first',day,s,'Example');
  f.add('second',day+86400000,s,'Other');
  const evidence=JSON.parse(f.sql.prepare('SELECT payload FROM mon_evidence WHERE id=?').get('second').payload);
  evidence.citations=[{url:'https://other.fi/page'}];
  f.sql.prepare('UPDATE mon_evidence SET payload=? WHERE id=?').run(JSON.stringify(evidence),'second');
  const a=(await f.get()).data;
  assert.equal(a.competitors.length,2);
  const own=a.competitors.find(b=>b.isOwned), other=a.competitors.find(b=>!b.isOwned);
  assert.equal(own.metrics.visibility,50);
  assert.equal(own.change,-100);
  assert.equal(other.metrics.visibility,50);
  assert.equal(other.metrics.citationRate,50);
  assert.equal(other.change,100);
  assert.deepEqual(other.runs.map(r=>r.metrics.visibility),[0,100]);
  assert.equal(other.metrics.eligible,2);
  const filtered=(await f.get('from=2026-01-02')).data;
  assert.equal(filtered.competitors[1].metrics.visibility,100);
  assert.equal(filtered.competitors[1].change,null);
  f.add('changed',day+2*86400000,{...s,identityVersion:2},'Other');
  assert.equal((await f.get()).data.competitors[1].change,null);
  f.add('diagnostic',day+3*86400000,{...s,kind:'diagnostic'},'Other');
  assert.deepEqual((await f.get('runId=diagnostic')).data.competitors,[]);
  await assert.rejects(f.get('','bob'),e=>e.status===404);
 } finally {f.sql.close();}
});
test('legacy runs without frozen cohorts do not receive fabricated competitor scores',async()=>{
 const f=fixture();
 try {
  f.add('legacy',Date.parse('2026-01-01'));
  assert.deepEqual((await f.get()).data.competitors,[]);
 } finally {f.sql.close();}
});
test('per-brand metrics use frozen identities and selected comparable real evidence only',async()=>{
 const f=fixture();
 try {
  assert.deepEqual((await f.get()).data.competitors,[]);
  const other={brandName:'Other',aliases:['Alternative'],ownedDomains:['other.com']};
  const s={...snapshot,language:'en',cohort:{version:1,brands:[identity,other]}};
  const day=Date.parse('2026-01-01');
  f.add('a',day,s,'Example');
  f.add('b',day+86400000,s,'I recommend Alternative.');
  const payload=JSON.parse(f.sql.prepare('SELECT payload FROM mon_evidence WHERE id=?').get('b').payload);
  payload.citations=[{url:'https://other.com/source'}];
  f.sql.prepare('UPDATE mon_evidence SET payload=? WHERE id=?').run(JSON.stringify(payload),'b');
  f.add('empty',day+2*86400000,s,'');
  f.add('diagnostic',day+3*86400000,{...s,kind:'diagnostic'},'Other');
  const a=(await f.get()).data;
  const [own,competitor]=a.competitors;
  assert.equal(own.isOwned,true);assert.equal(competitor.isOwned,false);
  assert.equal(own.change,-100);assert.equal(competitor.change,100);
  assert.equal(competitor.metrics.visibility,50);
  assert.equal(competitor.metrics.citationRate,50);
  assert.equal(competitor.metrics.recommendationRate,100);
  assert.equal(competitor.metrics.classified,1);
  assert.equal(competitor.metrics.eligible,2);assert.equal(competitor.metrics.expected,3);
  assert.equal(competitor.metrics.state,'partial');
  assert.equal(competitor.runCount,3);assert.equal(competitor.eligibleRunCount,2);
  assert.equal(competitor.runs[2].metrics.visibility,null);
  const single=(await f.get('runId=b&provider=openai&topic=Hinta')).data.competitors[1];
  assert.equal(single.change,null);assert.equal(single.metrics.visibility,100);
  const filtered=(await f.get('from=2026-01-01&to=2026-01-01')).data.competitors[1];
  assert.equal(filtered.metrics.visibility,0);assert.equal(filtered.change,null);
  assert.deepEqual((await f.get('runId=diagnostic')).data.competitors,[]);
  await assert.rejects(f.get('runId=b','bob'),e=>e.status===404);
  f.add('swedish',day+4*86400000,{...s,language:'sv'},'I recommend Other.');
  const sv=(await f.get()).data;
  assert.equal(sv.language,'sv');assert.equal(sv.competitors[1].change,null);
  assert.equal(sv.competitors[1].metrics.visibility,100);
  assert.equal(sv.competitors[1].metrics.recommendationRate,null);
  f.add('legacy',day+5*86400000,snapshot);
  assert.deepEqual((await f.get()).data.competitors,[]);
 } finally { f.sql.close(); }
});
