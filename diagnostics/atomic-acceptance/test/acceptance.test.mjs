import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './sqlite-http-fixture.mjs';
import {loadCandidate,createContext,runSuite,initialize,seed,evidence,runConfigured} from '../acceptance.mjs';
import {CONFIRMATION,PREFIX} from '../policy.mjs';
const endpoint='https://atomic-fixture.invalid/v2/pipeline';
async function setup(){
 const candidate=await loadCandidate({verify:false});const f=fixture({clockSQL:candidate.CLOCK_SQL});
 const ctx=await createContext({candidate,endpoint,authorization:'Bearer offline-fixture-only',fetchImpl:f.fetch,expires:new Date(Date.now()+90000).toISOString()});
 return {f,ctx,candidate};
}
test('real imported publisher end-to-end with bounded SQLite HTTP fixture',async t=>{
 const {f,ctx}=await setup();t.after(()=>f.close());const result=await runSuite(ctx);assert.equal(result.status,'passed');assert.equal(result.retries,0);
 assert.ok(f.records.every(b=>b.baton===null&&b.requests.length===2&&b.requests[1].type==='close'));
 assert.ok(f.records.every(b=>!(b.requests[0].batch?.steps||[]).some(s=>/^DELETE\b/.test(s.stmt.sql))));
 console.log(JSON.stringify({event:'offline_acceptance_result',...result}));
});
test('invalid, missing, expired invocation never reads environment',async()=>{
 const env=new Proxy({},{get(){throw Error('CREDENTIAL_READ_FORBIDDEN');}});
 for(const options of [{},{confirmation:CONFIRMATION},{confirmation:CONFIRMATION,expires:'2020-01-01T00:00:00.000Z'},{confirmation:'wrong',expires:new Date(Date.now()+60000).toISOString()}])assert.equal((await runConfigured({...options,env})).status,'not_run');
});
test('existing exact namespace refuses setup and does not adopt it',async t=>{
 const {f,ctx}=await setup();t.after(()=>f.close());await initialize(ctx);const count=f.calls;
 await assert.rejects(initialize(ctx),/NAMESPACE_NOT_CONFIRMED_ABSENT/);assert.equal(f.calls-count,6);
 assert.equal(f.query(`SELECT COUNT(*) n FROM ${PREFIX}summary_requests`)[0].n,0);
});
test('lost setup response permits no later write or read retry',async t=>{
 const {f,ctx}=await setup();t.after(()=>f.close());let calls=0;const original=f.fetch;
 // Mark the seventh (single CREATE batch) response as lost after server execution.
 ctx.wrapped;f.setHook(({stmt})=>{if(stmt.sql.startsWith('CREATE TABLE'))f.loseNextResponse();});
 await assert.rejects(initialize(ctx));assert.equal(ctx.state.unknown,true);const before=ctx.state.requests;
 await assert.rejects(seed(ctx,'forbidden'));assert.equal(ctx.state.requests,before);assert.equal(before,7);
 assert.equal(f.query(`SELECT COUNT(*) n FROM ${PREFIX}summary_requests`)[0].n,0);
});
test('compact lost commit acknowledgment preserves intent and prevents retries',async t=>{
 const {f,ctx,candidate:c}=await setup();t.after(()=>f.close());await initialize(ctx);const job=await seed(ctx,'lost-compact');
 f.setHook(({stmt})=>{if(stmt.sql.includes('SET published_at='))f.loseNextResponse();});
 await assert.rejects(c.publishSummary(ctx.db,job,{synthetic:true},evidence(2,'lost')),e=>e.code==='ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN');
 const before=ctx.state.requests;await assert.rejects(c.publishSummary(ctx.db,job,{synthetic:true},evidence(2,'lost')));assert.equal(ctx.state.requests,before);
 // The actual COMMIT succeeded locally: never infer rollback from the lost response.
 assert.equal(f.query(`SELECT COUNT(*) n FROM ${PREFIX}summary_heads`)[0].n,1);
});
test('lost durable intent acknowledgement stops before generation writes',async t=>{
 const {f,ctx,candidate:c}=await setup();t.after(()=>f.close());await initialize(ctx);const job=await seed(ctx,'lost-intent');
 f.setHook(({stmt})=>{if(stmt.sql.startsWith('UPDATE')&&stmt.sql.includes('SET last_error=?'))f.loseNextResponse();});
 const before=ctx.state.requests;await assert.rejects(c.publishSummary(ctx.db,job,{synthetic:true},evidence(2,'lost')),e=>e.code==='ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN');
 assert.equal(ctx.state.requests-before,1);assert.equal(f.query(`SELECT COUNT(*) n FROM ${PREFIX}summary_generations`)[0].n,0);
 assert.match(f.query(`SELECT last_error FROM ${PREFIX}summary_requests`)[0].last_error,/^ANALYTICS_PUBLICATION_UNKNOWN:/);
});
test('lost first stage acknowledgement retains rows and starts no next stage',async t=>{
 const {f,ctx,candidate:c}=await setup();t.after(()=>f.close());await initialize(ctx);const job=await seed(ctx,'lost-stage');
 f.setHook(({stmt})=>{if(stmt.sql.startsWith(`INSERT INTO ${PREFIX}summary_evidence`))f.loseNextResponse();});
 const before=ctx.state.requests;await assert.rejects(c.publishSummary(ctx.db,job,{synthetic:true},evidence(101,'lost-stage')),e=>e.code==='ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN');
 assert.equal(ctx.state.requests-before,3);assert.equal(f.query(`SELECT COUNT(*) n FROM ${PREFIX}summary_evidence`)[0].n,50);assert.equal(f.query(`SELECT COUNT(*) n FROM ${PREFIX}summary_heads`)[0].n,0);
});
test('database clock crossing final fence rolls back compact head and evidence',async t=>{
 const {f,ctx,candidate:c}=await setup();t.after(()=>f.close());await initialize(ctx);const job=await seed(ctx,'late-expiry');
 f.setHook(({stmt})=>{if(stmt.sql.includes('SET lease_token=NULL,lease_until=NULL,attempts=0'))f.now=job.lease_until+1;});
 const result=await c.publishSummary(ctx.db,job,{synthetic:true},evidence(2,'late'));
 assert.deepEqual(result,{published:false,reason:'fenced'});assert.equal(f.query(`SELECT COUNT(*) n FROM ${PREFIX}summary_heads`)[0].n,0);assert.equal(f.query(`SELECT COUNT(*) n FROM ${PREFIX}summary_evidence`)[0].n,0);
});
test('stale follower absence cannot cause existing writer namespace adoption',async t=>{
 const {f,ctx,candidate:c}=await setup();t.after(()=>f.close());
 f.query(`CREATE TABLE ${PREFIX}summary_heads(sentinel TEXT)`);f.query(`INSERT INTO ${PREFIX}summary_heads VALUES ('retained')`);
 const original=f.fetch;const stale=async req=>{
  const b=JSON.parse(await req.clone().text());
  if(b.requests[0].type==='execute'){
   const table=b.requests[0].stmt.sql.match(/FROM (\w+)/)[1];
   return new Response(JSON.stringify({baton:null,results:[{type:'error',error:{code:'SQLITE_ERROR',message:`no such table: ${table}`}},{type:'ok',response:{type:'close'}}]}));
  }
  return original(req);
 };
 const raced=await createContext({candidate:c,endpoint,authorization:'Bearer local',fetchImpl:stale,expires:new Date(Date.now()+60000).toISOString()});
 await assert.rejects(initialize(raced));assert.equal(raced.state.unknown,false);
 assert.deepEqual(f.query(`SELECT * FROM ${PREFIX}summary_heads`).map(r=>({...r})),[{sentinel:'retained'}]);
 assert.throws(()=>f.query(`SELECT * FROM ${PREFIX}project_revisions`));
 assert.equal(raced.state.requests,7);
});
test('known failed later stage retains acknowledged first chunk without publication or deletion',async t=>{
 const {f,ctx,candidate:c}=await setup();t.after(()=>f.close());await initialize(ctx);const job=await seed(ctx,'failed-later-stage');let inserts=0;
 f.setHook(({stmt})=>{if(stmt.sql.startsWith(`INSERT INTO ${PREFIX}summary_evidence`)&&++inserts===2)throw Error('SYNTHETIC_STAGE_FAILURE');});
 const result=await c.publishSummary(ctx.db,job,{synthetic:true},evidence(101,'failed-later-stage'));assert.deepEqual(result,{published:false,reason:'fenced'});
 assert.equal(f.query(`SELECT COUNT(*) n FROM ${PREFIX}summary_evidence`)[0].n,50);assert.equal(f.query(`SELECT COUNT(*) n FROM ${PREFIX}summary_heads`)[0].n,0);assert.equal(f.query(`SELECT COUNT(*) n FROM ${PREFIX}summary_generations WHERE published_at IS NULL`)[0].n,1);
 assert.equal(f.query(`SELECT last_error FROM ${PREFIX}summary_requests`)[0].last_error,null);
});
test('malformed committed acknowledgement is unknown and no dependent request runs',async t=>{
 const {f,ctx,candidate:c}=await setup();t.after(()=>f.close());await initialize(ctx);const job=await seed(ctx,'malformed');
 let dispatches=0;const malformed=async req=>{dispatches++;await f.fetch(req);return new Response('{"baton":null,"results":[]}');};
 const alternate=await createContext({candidate:c,endpoint,authorization:'Bearer local',fetchImpl:malformed,expires:new Date(Date.now()+60000).toISOString()});
 await assert.rejects(c.publishSummary(alternate.db,job,{synthetic:true},evidence(2,'malformed')),e=>e.code==='ANALYTICS_PUBLICATION_OUTCOME_UNKNOWN');assert.equal(dispatches,1);assert.equal(alternate.state.unknown,true);
 await assert.rejects(seed(alternate,'forbidden'));assert.equal(dispatches,1);
});
test('configured candidate hash gate verifies complete transitive source closure',async()=>{
 const candidate=await loadCandidate();assert.equal(typeof candidate.publishSummary,'function');
});
test('fresh runtime and candidate imports never read credentials or call fetch',async()=>{
 const {execFileSync}=await import('node:child_process');
 const source=`process.env=new Proxy(process.env,{get(target,key){if(typeof key==='string'&&/BUNNY_DATABASE|AUTH_TOKEN|SECRET|PASSWORD/.test(key))throw Error('FORBIDDEN_CREDENTIAL_READ');return Reflect.get(target,key);}});globalThis.fetch=()=>{throw Error('FORBIDDEN_NETWORK');};const m=await import(${JSON.stringify(new URL('../acceptance.mjs',import.meta.url).href)});await m.loadCandidate();await import(${JSON.stringify(new URL('../hold.mjs',import.meta.url).href)});`;
 execFileSync(process.execPath,['--input-type=module','-e',source],{stdio:'pipe'});
});
