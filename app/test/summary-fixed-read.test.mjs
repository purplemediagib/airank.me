import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ddl,id,checksum} from '../src/analytics/summary-migration.mjs';
import {formatVersion,canonicalQuery,queryKey,cursorFor,evidenceSelection} from '../src/analytics/summary-contract.mjs';
import {createSummaryDatabase} from '../src/analytics/summary-transport.mjs';
import {summaryService,summaryEvidenceService} from '../src/analytics/summary-service.mjs';
const env={AIRANK_ANALYTICS_SUMMARY_ENABLED:'true',AIRANK_BUILD_REVISION:'fixed-read-test'};
function fixture({teams=true}={}){
 const sql=new DatabaseSync(':memory:');
 sql.exec('CREATE TABLE app_projects(id TEXT PRIMARY KEY,owner_id TEXT,workspace_id TEXT); CREATE TABLE app_migrations(id TEXT,checksum TEXT);');
 sql.prepare('INSERT INTO app_migrations VALUES (?,?)').run(id,checksum);
 sql.exec("INSERT INTO app_projects VALUES ('a','alice','w'),('b','bob','v')");
 if(teams)sql.exec("CREATE TABLE app_workspaces(id TEXT); CREATE TABLE app_workspace_members(workspace_id TEXT,user_id TEXT,role TEXT); CREATE TABLE app_project_guests(project_id TEXT,user_id TEXT,role TEXT); INSERT INTO app_project_guests VALUES ('a','guest','viewer')");
 for(const s of ddl.filter(s=>/^CREATE (TABLE|INDEX) analytics_/.test(s)))sql.exec(s);
 sql.exec("INSERT INTO analytics_project_revisions VALUES ('a',1),('b',1)");
 const now=Date.now(),q=canonicalQuery(new URLSearchParams({from:'2026-11-03',to:'2026-11-03'})),format=formatVersion(env),key=queryKey(q,format);
 sql.prepare('INSERT INTO analytics_summary_requests(project_id,query_key,query_json,format_version,requested_at,last_requested_at) VALUES (?,?,?,?,?,?)').run('a',key,q.toString(),format,now,now);
 for(const gen of ['old','new']){
  sql.prepare('INSERT INTO analytics_summary_generations VALUES (?,?,?,?,?,?,?,?,?,?)').run(gen,'a',key,1,format,now,now+86400000,7,'{"value":42}',now);
  for(let i=0;i<7;i++){
   if(gen==='old')sql.prepare('INSERT INTO analytics_summary_payloads VALUES (?,?,?,?,?,?,?,?,?,?)').run(`h${i}`,JSON.stringify({id:`e${i}`,answer:`Answer ${i}`}),JSON.stringify([i%2?'odd':'even']),JSON.stringify([i%2?'B':'A']),i%2,0,0,0,0,0);
   sql.prepare('INSERT INTO analytics_summary_evidence VALUES (?,?,?,?)').run(gen,i,`e${i}`,`h${i}`);
  }
 }
 sql.prepare('INSERT INTO analytics_summary_heads VALUES (?,?,?)').run('a',key,'new');
 const calls=[];let alter=null,before=null;
 const fetch=async(url,options)=>{
  calls.push({url,options});const body=JSON.parse(options.body),results=[],errors=[];
  const ok=c=>!c||c.type==='ok'?(!c||results[c.step]!==null):c.type==='not'?!ok(c.cond):c.type==='and'?c.conds.every(ok):false;
  if(before)before(calls.length,body);
  for(const step of body.requests[0].batch.steps){
   if(!ok(step.condition)){results.push(null);errors.push(null);continue;}
   try{
    const st=sql.prepare(step.stmt.sql),args=step.stmt.args.map(v=>v.type==='null'?null:v.type==='integer'?BigInt(v.value):v.value),cols=st.columns().map(c=>({name:c.name}));
    let rows=[],affected=0;
    if(cols.length){const all=st.all(...args);if(step.stmt.want_rows)rows=all.map(row=>cols.map(c=>row[c.name]===null?{type:'null'}:typeof row[c.name]==='number'?{type:'integer',value:String(row[c.name])}:{type:'text',value:row[c.name]}));}else affected=Number(st.run(...args).changes);
    results.push({cols,rows,affected_row_count:affected});errors.push(null);
   }catch(e){results.push(null);errors.push({message:e.message});}
  }
  let payload={baton:null,base_url:'https://untrusted.invalid',results:[{type:'ok',response:{type:'batch',result:{step_results:results,step_errors:errors}}},{type:'ok',response:{type:'close'}}]};
  if(alter)payload=alter(payload,calls.length);
  return new Response(JSON.stringify(payload),{status:200});
 };
 const db=createSummaryDatabase({url:'https://database.invalid',authToken:'synthetic-not-a-secret',fetch});
 const evidence=(options={},userId='alice',item='',project='a')=>summaryEvidenceService({db,path:`/v1/projects/${project}/analytics/evidence${item?`/${item}`:''}`,query:new URLSearchParams({generation:'old',...options}),userId,env,now:()=>0});
 const summary=()=>summaryService({db,path:'/v1/projects/a/analytics/summary',query:q,userId:'alice',env,now:()=>0});
 return {sql,db,calls,evidence,summary,setAlter:f=>{alter=f;},setBefore:f=>{before=f;},close:()=>sql.close()};
}
const code=(p,c)=>assert.rejects(p,e=>e.code===c);
test('fixed evidence pages/detail use one snapshot and preserve pinned old generation, filter ranks and cursors',async()=>{
 const f=fixture();try{
  const first=await f.evidence({pageSize:'2',q:'even',evidenceBrand:'A'});assert.deepEqual(first.data.items.map(x=>x.id),['e0','e2']);assert.equal(first.data.total,4);
  assert.equal(f.calls.length,2,'schema discovery plus one complete snapshot');
  for(const call of f.calls){const body=JSON.parse(call.options.body);assert.equal(call.url,'https://database.invalid/v2/pipeline');assert.equal(call.options.redirect,'error');assert.equal(body.baton,null);assert.equal(body.requests.at(-1).type,'close');}
  const next=await f.evidence({pageSize:'2',q:'even',evidenceBrand:'A',cursor:first.data.nextCursor});assert.deepEqual(next.data.items.map(x=>x.id),['e4','e6']);assert.equal(next.data.offset,2);assert.equal(next.data.previousCursor,null);
  const detail=await f.evidence({pageSize:'2',q:'even',evidenceBrand:'A'},'alice','e4');assert.equal(detail.data.index,2);assert.equal(detail.data.prevId,'e2');assert.equal(detail.data.nextId,'e6');assert.equal(detail.data.pageCursor,first.data.nextCursor);
  const third=await f.evidence({pageSize:'2',cursor:cursorFor(evidenceSelection(new URLSearchParams({generation:'old'})).key,3)});assert.equal(third.data.offset,4);assert.ok(third.data.previousCursor);
 }finally{f.close();}
});
test('fixed snapshot authorizes legacy owners and live team access, rejects revocation and cross-project generation',async()=>{
 for(const teams of [false,true]){const f=fixture({teams});try{
  assert.equal((await f.evidence()).status,200);await code(f.evidence({},'bob'),'NOT_FOUND');await code(f.evidence({},'bob','','b'),'NOT_FOUND');
  if(teams){assert.equal((await f.evidence({},'guest')).status,200);f.sql.exec('DELETE FROM app_project_guests');await code(f.evidence({},'guest'),'NOT_FOUND');}
 }finally{f.close();}}
});
test('fixed snapshots revalidate discovered schema and migration, use DB expiry independent of host clock',async()=>{
 const f=fixture();try{
  f.setBefore(n=>{if(n===2)f.sql.exec('DROP TABLE app_project_guests');});await code(f.evidence(),'ANALYTICS_NOT_CONFIGURED');
  f.setBefore(null);f.sql.exec('CREATE TABLE app_project_guests(project_id TEXT,user_id TEXT,role TEXT)');
  f.sql.exec("UPDATE analytics_summary_generations SET expires_at=1");await code(f.evidence(),'ANALYTICS_GENERATION_EXPIRED');
  f.sql.exec("UPDATE app_migrations SET checksum='bad'");await code(f.evidence(),'ANALYTICS_NOT_CONFIGURED');
 }finally{f.close();}
});
test('malformed close/snapshot provider responses fail closed without continuation or interactive fallback',async()=>{
 const f=fixture();try{
  f.setAlter((p,n)=>{if(n===2)p.baton='unsafe';return p;});await code(f.evidence(),'ANALYTICS_READ_UNAVAILABLE');assert.equal(f.calls.length,2);
 }finally{f.close();}
});
test('unknown publication serves valid pinned head explicitly stale, expired head returns paused error',async()=>{
 const f=fixture();try{
  f.sql.exec("UPDATE analytics_summary_requests SET last_error='ANALYTICS_PUBLICATION_UNKNOWN:intent'");
  const warm=await f.summary();assert.equal(warm.status,200);assert.equal(warm.data.readModel.isStale,true);assert.equal(warm.data.readModel.refreshState,'paused');
  f.sql.exec('UPDATE analytics_summary_generations SET expires_at=1');await code(f.summary(),'ANALYTICS_PUBLICATION_UNKNOWN');
 }finally{f.close();}
});
test('fixed list and detail navigation agree for every flag, search, brand and page boundary',async()=>{
 const f=fixture();try{
  for(const options of [{},{filter:'mentioned'},{filter:'recommended'},{filter:'cited'},{filter:'ordered'},{filter:'first'},{filter:'excluded'},{q:'odd'},{evidenceBrand:'B'},{filter:'mentioned',q:'odd',evidenceBrand:'B'}]){
   const expected=options.filter&&options.filter!=='mentioned'?[]:options.filter==='mentioned'||options.q==='odd'||options.evidenceBrand==='B'?['e1','e3','e5']:Array.from({length:7},(_,i)=>`e${i}`);
   let cursor,seen=[];
   do{const page=(await f.evidence({...options,pageSize:'2',...(cursor?{cursor}:{})})).data;assert.equal(page.offset,seen.length);assert.equal(page.total,expected.length);for(const item of page.items){const detail=(await f.evidence({...options,pageSize:'2'},'alice',item.id)).data;const index=expected.indexOf(item.id);assert.equal(detail.index,index);assert.equal(detail.prevId,expected[index-1]||null);assert.equal(detail.nextId,expected[index+1]||null);assert.equal(detail.pageCursor,cursor||null);}seen.push(...page.items.map(i=>i.id));cursor=page.nextCursor;}while(cursor);
   assert.deepEqual(seen,expected);
  }
 }finally{f.close();}
});
test('fixed cold/warm summaries demand stored projection only and use current revision staleness',async()=>{
 const f=fixture();try{
  const warm=await f.summary();assert.equal(warm.status,200);assert.equal(warm.data.value,42);assert.equal(warm.data.readModel.isStale,false);
  f.sql.exec("UPDATE analytics_project_revisions SET revision=2 WHERE project_id='a'");assert.equal((await f.summary()).data.readModel.isStale,true);
  f.sql.exec('DELETE FROM analytics_summary_heads');const cold=await f.summary();assert.equal(cold.status,202);assert.equal(cold.data.state,'preparing');
  assert.ok(f.calls.every(c=>!c.options.body.includes('mon_evidence')));
 }finally{f.close();}
});
test('revocation between discovery and BEGIN denies before selecting saved payloads',async()=>{
 const f=fixture();try{
  f.setBefore(n=>{if(n===2)f.sql.exec('DELETE FROM app_project_guests');});await code(f.evidence({},'guest'),'NOT_FOUND');
  // The local Hrana evaluator enforces conditional steps: an authorization
  // assertion aborts the snapshot and all subsequent SELECTs are skipped.
  assert.equal(f.calls.length,2);
 }finally{f.close();}
});
function replaceCell(payload,column,value){
 const result=payload.results[0].response.result.step_results.find(r=>r?.cols.some(c=>c.name===column)&&r.rows.length);
 assert.ok(result,`test response contains ${column}`);const index=result.cols.findIndex(c=>c.name===column);result.rows[0][index]=value;
 return payload;
}
test('fixed decoded integer domains reject fractional, textual, negative and oversized metadata',async()=>{
 for(const [column,value] of [
  ['source_revision',{type:'float',value:1.5}],['current_revision',{type:'text',value:'1'}],
  ['generated_at',{type:'float',value:1.5}],['expires_at',{type:'text',value:'9999999999999'}],
  ['evidence_count',{type:'integer',value:'50001'}],['published_at',{type:'integer',value:'-1'}],
  ['n',{type:'text',value:'7'}],['offset',{type:'float',value:0.5}],['position',{type:'text',value:'0'}]
 ]){const f=fixture();try{f.setAlter((p,n)=>n===2?replaceCell(p,column,value):p);await code(f.evidence(),'ANALYTICS_READ_UNAVAILABLE');}finally{f.close();}}
});
test('fixed detail ranks, positions, nullable cursors and neighbor IDs reject malformed decoded values',async()=>{
 for(const [column,value] of [
  ['idx',{type:'integer',value:'7'}],['idx',{type:'text',value:'2'}],['position',{type:'integer',value:'-1'}],
  ['before_page',{type:'float',value:1.5}],['prev_id',{type:'integer',value:'1'}],['next_id',{type:'text',value:''}],
  ['payload',{type:'text',value:'{"id":"wrong"}'}]
 ]){const f=fixture();try{f.setAlter((p,n)=>n===2?replaceCell(p,column,value):p);await code(f.evidence({pageSize:'2'},'alice','e2'),'ANALYTICS_READ_UNAVAILABLE');}finally{f.close();}}
});
test('fixed returned generation scope and summary metadata cannot drift from requested scope',async()=>{
 for(const [column,value,summary] of [['project_id','b',false],['id','new',false],['query_key','different-query',true],['evidence_count','7',true]]){
  const f=fixture();try{f.setAlter((p,n)=>n===2?replaceCell(p,column,{type:'text',value}):p);await code(summary?f.summary():f.evidence(),'ANALYTICS_READ_UNAVAILABLE');}finally{f.close();}
 }
});
test('fixed authorization preserves current nonempty role semantics but denies empty roles',async()=>{
 const f=fixture();try{
  f.sql.exec("UPDATE app_project_guests SET role='legacy-role'");assert.equal((await f.evidence({},'guest')).status,200);
  f.sql.exec("UPDATE app_project_guests SET role=''");await code(f.evidence({},'guest'),'NOT_FOUND');
 }finally{f.close();}
});
test('bounded discovery and snapshot responses report projection limit without retries',async()=>{
 for(const stop of [1,2]){const f=fixture();try{
  const original=f.db.summaryAtomic;let calls=0;
  f.db.summaryAtomic=async plan=>++calls===stop?{outcome:'unknown',reason:'response_limit'}:original(plan);
  await code(f.evidence(),'ANALYTICS_PROJECTION_LIMIT');assert.equal(f.calls.length,stop-1);assert.equal(calls,stop);
 }finally{f.close();}}
});
