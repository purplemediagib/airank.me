import test from 'node:test';
import assert from 'node:assert/strict';
import {connectorConfig,googleConnectionsService} from '../src/google-connections/service.mjs';
import {safeImportError} from '../src/google-connections/errors.mjs';

const env={GOOGLE_CONNECTOR_BASE_URL:'https://connector.example',GOOGLE_CONNECTOR_RETURN_URL:'https://app.example/en/settings?tab=connections',GOOGLE_CONNECTOR_API_KEY:'fixture-only-key-abcdefghijklmnopqrstuvwxyz'};
const owned={id:'project-one',owner_id:'alice'};
const makeDB=(project=owned)=>({execute:async({sql,args})=>{
  assert.match(sql,/owner_id=\?/);assert.match(sql,/status='active'/);
  return {rows:project&&args[0]===project.id&&args[1]===project.owner_id?[project]:[]};
}});
const prefix='/v1/projects/project-one/connections/ga4';
function call(extra={}){
  return googleConnectionsService({db:makeDB(),method:'GET',path:prefix,userId:'alice',env,...extra});
}
const json=(data,status=200)=>new Response(JSON.stringify(data),{status});
const reject=(p,status,code)=>assert.rejects(p,e=>e.status===status&&(!code||e.code===code));
test('Google configuration requires server-only key, exact HTTPS origin and return URL',()=>{
  assert.ok(connectorConfig(env));
  for(const bad of [
    {GOOGLE_CONNECTOR_API_KEY:''},{GOOGLE_CONNECTOR_API_KEY:'short'},
    {GOOGLE_CONNECTOR_BASE_URL:'http://connector.example'},
    {GOOGLE_CONNECTOR_BASE_URL:'https://connector.example/path'},
    {GOOGLE_CONNECTOR_BASE_URL:'https://user:secret@connector.example'},
    {GOOGLE_CONNECTOR_RETURN_URL:'http://app.example/settings'},
    {GOOGLE_CONNECTOR_RETURN_URL:'https://app.example/#fragment'},
  ])assert.equal(connectorConfig({...env,...bad}),null);
});
test('Missing configuration is explicit setup-needed and never contacts upstream',async()=>{
  let requests=0;
  const r=await call({env:{},fetcher:async()=>{requests++;}});
  assert.equal(r.data.status,'setup_required');assert.equal(r.data.configured,false);assert.equal(requests,0);
  await reject(call({env:{},method:'POST',path:prefix+'/connect',body:{}}),503,'GOOGLE_CONNECTOR_SETUP_REQUIRED');
});
test('Every operation enforces active project ownership before configuration or upstream calls',async()=>{
  for(const [method,suffix,body]of [['GET',''],['POST','/connect',{}],['GET','/properties'],['PUT','/selection',{property:'properties/123'}],['POST','/sync',{}],['GET','/reports'],['DELETE','',{}]]){
    await reject(call({userId:'bob',method,path:prefix+suffix,body,env:{},fetcher:()=>assert.fail('cross-tenant request')}),404);
  }
});
test('Authorised workspace and user IDs are derived from stored project, never supplied by browser',async()=>{
  const r=await call({method:'POST',path:prefix+'/connect',body:{},fetcher:async(url,o)=>{
    assert.equal(url,'https://connector.example'+prefix+'/connect');
    assert.equal(o.headers['X-AIRank-Workspace-ID'],owned.id);
    assert.equal(o.headers.Authorization,'Bearer '+env.GOOGLE_CONNECTOR_API_KEY);
    assert.equal(o.redirect,'error');
    assert.deepEqual(JSON.parse(o.body),{userId:'alice',returnUrl:env.GOOGLE_CONNECTOR_RETURN_URL});
    return json({url:'https://connector.example/v1/oauth/google/start?ticket='+'a'.repeat(43),expiresIn:120});
  }});
  assert.equal(r.data.expiresIn,120);
  for(const body of [{userId:'bob'},{returnUrl:'https://evil.example'},{workspaceId:'other'}])
    await reject(call({method:'POST',path:prefix+'/connect',body}),422);
});
test('One-use OAuth URL must remain on configured connector and exact start path',async()=>{
  for(const url of ['https://evil.example/v1/oauth/google/start?ticket='+'a'.repeat(43),'https://connector.example/wrong?ticket='+'a'.repeat(43),'https://connector.example/v1/oauth/google/start?ticket=invalid','https://connector.example/v1/oauth/google/start?ticket='+'a'.repeat(43)+'&redirect=https://evil.example']){
    await reject(call({method:'POST',path:prefix+'/connect',body:{},fetcher:async()=>json({url})}),502);
  }
});
test('State envelope strips unknown upstream credentials and redacts sync error details',async()=>{
  const r=await call({fetcher:async()=>json({connected:true,status:'connected',access_token:'never-forward',refresh_token:'never-forward',sync:{status:'failed',lastError:'token=secret',completedDays:2,totalDays:90}})});
  assert.equal(r.data.configured,true);assert.equal(r.data.connected,true);
  assert.doesNotMatch(JSON.stringify(r),/never-forward|token=secret/);
  assert.equal(r.data.sync.completedDays,2);
  assert.equal(r.data.sync.lastError,'GOOGLE_IMPORT_FAILED');
});
test('Status preserves only allowlisted import diagnostics and retains progress',async()=>{
  for(const lastError of [
    'GOOGLE_IMPORT_FAILED category=api_disabled http=403 status=PERMISSION_DENIED reason=SERVICE_DISABLED',
    'GOOGLE_IMPORT_FAILED category=invalid_request http=400 status=INVALID_ARGUMENT',
    'GOOGLE_IMPORT_FAILED category=quota http=429 status=RESOURCE_EXHAUSTED reason=quotaExceeded',
    'GOOGLE_IMPORT_FAILED category=authentication http=400 reason=invalid_grant',
    'GOOGLE_IMPORT_FAILED category=transport',
    null,
  ]){
    const r=await call({fetcher:async()=>json({connected:true,status:'connected',sync:{status:'failed',completedDays:7,totalDays:90,lastError,completedAt:null}})});
    assert.equal(r.data.sync.lastError,lastError);
    assert.equal(r.data.sync.completedDays,7);assert.equal(r.data.sync.totalDays,90);
  }
});
test('Diagnostics reject arbitrary fields, text, unknown codes, suffixes and oversized payloads',()=>{
  for(const value of [
    'Bearer ACCESS refresh_token=REFRESH',
    'GOOGLE_IMPORT_FAILED category=secret',
    'GOOGLE_IMPORT_FAILED category=permission http=403 status=SECRET',
    'GOOGLE_IMPORT_FAILED category=permission http=403 reason=ACCESS_TOKEN_secret',
    'GOOGLE_IMPORT_FAILED category=permission http=403 message=secret',
    'GOOGLE_IMPORT_FAILED category=permission\nBearer secret',
    'GOOGLE_IMPORT_FAILED category=permission http=200',
    'x'.repeat(10000),
    {category:'permission',access_token:'secret'},true,42,
  ])assert.equal(safeImportError(value),'GOOGLE_IMPORT_FAILED');
});
test('Allowlisted import failure categories survive the application boundary',async()=>{
 for(const lastError of ['GOOGLE_RECONNECT_REQUIRED','GOOGLE_API_DISABLED','GOOGLE_SCOPE_REQUIRED','GOOGLE_QUOTA_LIMIT','GOOGLE_ACCESS_DENIED','GOOGLE_REPORT_INVALID','GOOGLE_PROPERTY_NOT_FOUND','GOOGLE_TEMPORARILY_UNAVAILABLE','GOOGLE_IMPORT_FAILED']){
  const r=await call({fetcher:async()=>json({connected:true,status:'connected',sync:{status:'failed',lastError,completedDays:0,totalDays:90}})});
  assert.equal(r.data.sync.lastError,lastError);
 }
});
test('Selection preserves site IDs exactly and rejects extra fields and invalid bodies',async()=>{
  const site='sc-domain:example.fi';
  const r=await call({path:prefix.replace('ga4','gsc')+'/selection',method:'PUT',body:{property:site},fetcher:async(url,o)=>{
    assert.deepEqual(JSON.parse(o.body),{property:site});return json({property:site,sync:'queued'});
  }});
  assert.equal(r.data.sync,'queued');
  for(const body of [{property:''},{property:'a'.repeat(2049)},{property:site,userId:'bob'},null,[]])
    await reject(call({path:prefix+'/selection',method:'PUT',body}),422);
});
test('Cached report query is exact and bounded; Google percentages are never aggregated',async()=>{
  const query=new URLSearchParams({startDate:'2026-10-01',endDate:'2026-10-10',view:'sources',aiOnly:'true',offset:'100',limit:'100'});
  const data={rows:[{sessionSource:'chatgpt.com',engagementRate:0.25}],metadata:[{googleMetadata:[{subjectToThresholding:true}]}],missingDates:['2026-10-10'],availableDates:['2026-10-01'],notes:[],totalRows:1,nextOffset:null};
  const r=await call({path:prefix+'/reports',query,fetcher:async(url,o)=>{
    assert.equal(o.method,'GET');const u=new URL(url);assert.equal(u.searchParams.get('aiOnly'),'true');assert.equal(u.searchParams.get('offset'),'100');
    return json(data);
  }});
  assert.deepEqual(r.data,data);
  for(const override of [{startDate:'2026-02-30'},{startDate:'2025-01-01'},{endDate:'2026-09-01'},{view:'queries'},{limit:'1001'},{offset:'1.5'},{aiOnly:'yes'},{view:'overview',aiOnly:'true'},{url:'https://evil.example'}]){
    const q=new URLSearchParams(query);for(const [k,v]of Object.entries(override))q.set(k,v);
    await reject(call({path:prefix+'/reports',query:q}),422);
  }
});
test('Disconnect is intentional DELETE only and sends no client identifiers upstream',async()=>{
  const r=await call({method:'DELETE',body:{},fetcher:async(url,o)=>{
    assert.equal(o.method,'DELETE');assert.equal(o.body,undefined);
    return json({disconnected:true,importedDataDeleted:true,storedCredentialsDeleted:true,refresh_token:'hidden'});
  }});
  assert.equal(r.data.disconnected,true);assert.equal(r.data.importedDataDeleted,true);assert.equal(r.data.googleGrantRevoked,false);
  assert.equal(r.data.refresh_token,undefined);
  await reject(call({method:'POST',body:{}}),405);
});
test('Upstream authentication/configuration failures are safe setup-required errors',async()=>{
  for(const status of [401,403,503])await reject(call({fetcher:async()=>json({error:'secret internal config'},status)}),503,'GOOGLE_CONNECTOR_SETUP_REQUIRED');
  await reject(call({fetcher:async()=>{throw Error('Bearer secret');}}),502,'GOOGLE_CONNECTOR_UNAVAILABLE');
  await reject(call({fetcher:async()=>new Response('invalid-json')}),502,'GOOGLE_CONNECTOR_UNAVAILABLE');
});
test('Malformed upstream status/properties/reports fail explicitly rather than pretending empty data',async()=>{
  await reject(call({fetcher:async()=>json({})}),502,'GOOGLE_CONNECTOR_INVALID_RESPONSE');
  for(const data of [{},{items:[{id:123}]}])await reject(call({path:prefix+'/properties',fetcher:async()=>json(data)}),502,'GOOGLE_CONNECTOR_INVALID_RESPONSE');
  await reject(call({path:prefix+'/reports',query:new URLSearchParams({startDate:'2026-10-01',endDate:'2026-10-02'}),fetcher:async()=>json({rows:[]})}),502,'GOOGLE_CONNECTOR_INVALID_RESPONSE');
});
