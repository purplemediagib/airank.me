import {one,fail} from '../monitoring/shared.mjs';
import {safeImportError} from './errors.mjs';

const routes={status:'GET',connect:'POST',properties:'GET',selection:'PUT',sync:'POST',reports:'GET',disconnect:'DELETE'};
const date=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
export function connectorConfig(env){
  try{
    const base=new URL(env.GOOGLE_CONNECTOR_BASE_URL),back=new URL(env.GOOGLE_CONNECTOR_RETURN_URL);
    if(base.protocol!=='https:'||base.origin!==base.href.replace(/\/$/,'')||base.username||base.password||back.protocol!=='https:'||back.username||back.password||back.hash||!env.GOOGLE_CONNECTOR_API_KEY||env.GOOGLE_CONNECTOR_API_KEY.length<32)return null;
    return {base:base.origin,returnUrl:back.href,key:env.GOOGLE_CONNECTOR_API_KEY};
  }catch{return null;}
}

/** Existing workspaces are owner-managed projects, not a second client-supplied tenant namespace. */
export async function googleConnectionsService({db,method,path,query=new URLSearchParams(),body,userId,env=process.env,fetcher=globalThis.fetch}){
  const match=path.match(/^\/v1\/projects\/([A-Za-z0-9-]{1,80})\/connections\/(ga4|gsc)(?:\/(connect|properties|selection|sync|reports))?$/);
  if(!match)fail(404,'NOT_FOUND');
  const [,projectId,service,suffix]=match;
  const project=await one(db,"SELECT id,owner_id FROM app_projects WHERE id=? AND owner_id=? AND status='active'",[projectId,userId]);
  if(!project)fail(404,'NOT_FOUND');
  const action=suffix||(method==='DELETE'?'disconnect':'status');
  if(routes[action]!==method)fail(405,'METHOD_NOT_ALLOWED');
  let payload;
  if(action==='connect'||action==='sync'||action==='disconnect'){
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)fail(422,'VALIDATION_FAILED');
  }
  if(action==='selection'){
    if(!body||Object.keys(body).length!==1||typeof body.property!=='string'||!body.property.trim()||body.property.length>2048)fail(422,'VALIDATION_FAILED');
    payload={property:body.property};
  }
  const params=new URLSearchParams();
  if(action==='reports'){
    const start=query.get('startDate'),end=query.get('endDate');
    const views=service==='ga4'?['overview','sources','pages','countries','devices']:['totals','queries','pages','countries','devices'];
    const view=query.get('view')||(service==='ga4'?'sources':'totals'),offset=Number(query.get('offset')||0),limit=Number(query.get('limit')||100);
    if([...query.keys()].some(k=>!['startDate','endDate','view','offset','limit','aiOnly'].includes(k))||!date(start)||!date(end)||start>end||(Date.parse(end)-Date.parse(start))/86400000>=366||!views.includes(view)||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)fail(422,'VALIDATION_FAILED');
    if(query.has('aiOnly')&&(!['true','false'].includes(query.get('aiOnly'))||service!=='ga4'||view==='overview'))fail(422,'VALIDATION_FAILED');
    for(const [k,v] of Object.entries({startDate:start,endDate:end,view,offset,limit}))params.set(k,String(v));
    if(query.has('aiOnly'))params.set('aiOnly',query.get('aiOnly'));
  }else if([...query.keys()].length)fail(422,'VALIDATION_FAILED');
  const config=connectorConfig(env);
  if(!config){
    if(action==='status')return {status:200,data:{configured:false,connected:false,status:'setup_required',service,email:null,property:null,timeZone:null,currency:null,connectedAt:null,sync:null}};
    fail(503,'GOOGLE_CONNECTOR_SETUP_REQUIRED');
  }
  if(action==='connect')payload={userId:project.owner_id,returnUrl:config.returnUrl};
  const url=`${config.base}/v1/projects/${encodeURIComponent(project.id)}/connections/${service}${suffix?'/'+suffix:''}${params.size?'?'+params:''}`;
  let response,data;
  try{
    response=await fetcher(url,{method,redirect:'error',signal:AbortSignal.timeout(35000),headers:{Authorization:`Bearer ${config.key}`,'X-AIRank-Workspace-ID':project.id,'Content-Type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})});
    // Never forward raw upstream errors, request headers, OAuth credentials or tokens.
    if(!response.ok){
      await response.body?.cancel();
      if([401,403,503].includes(response.status))fail(503,'GOOGLE_CONNECTOR_SETUP_REQUIRED');
      fail(response.status===404?404:response.status===409?409:502,response.status===409?'GOOGLE_RECONNECT_OR_SELECTION_REQUIRED':'GOOGLE_CONNECTOR_UNAVAILABLE');
    }
    const text=await response.text();
    if(text.length>8*1024*1024)fail(502,'GOOGLE_CONNECTOR_INVALID_RESPONSE');
    data=JSON.parse(text);
  }catch(e){if(e.code)throw e;fail(502,'GOOGLE_CONNECTOR_UNAVAILABLE');}
  if(!data||typeof data!=='object'||Array.isArray(data))fail(502,'GOOGLE_CONNECTOR_INVALID_RESPONSE');
  if(action==='status'&&(typeof data.connected!=='boolean'||!['connected','disconnected','reconnect_required'].includes(data.status)))fail(502,'GOOGLE_CONNECTOR_INVALID_RESPONSE');
  if(action==='properties'&&(!Array.isArray(data.items)||data.items.some(x=>!x||typeof x.id!=='string'||!x.id||x.id.length>2048)))fail(502,'GOOGLE_CONNECTOR_INVALID_RESPONSE');
  if(action==='reports'&&(!['rows','metadata','missingDates','availableDates','notes'].every(k=>Array.isArray(data[k]))||!Number.isSafeInteger(data.totalRows)||data.totalRows<0||!(data.nextOffset===null||(Number.isSafeInteger(data.nextOffset)&&data.nextOffset>=0))))fail(502,'GOOGLE_CONNECTOR_INVALID_RESPONSE');
  if(action==='connect'){
    let target;try{target=new URL(data.url);}catch{fail(502,'GOOGLE_CONNECTOR_INVALID_RESPONSE');}
    if(target.origin!==config.base||target.pathname!=='/v1/oauth/google/start'||target.username||target.password||target.hash||![...target.searchParams.keys()].every(k=>k==='ticket')||!/^[A-Za-z0-9_-]{43}$/.test(target.searchParams.get('ticket')||''))fail(502,'GOOGLE_CONNECTOR_INVALID_RESPONSE');
    return {status:200,data:{url:target.href,expiresIn:data.expiresIn}};
  }
  if(action==='status')return {status:200,data:{configured:true,connected:data.connected===true,status:data.status,service,email:data.email??null,property:data.property??null,timeZone:data.timeZone??null,currency:data.currency??null,connectedAt:data.connectedAt??null,sync:data.sync?{status:data.sync.status,completedDays:data.sync.completedDays,totalDays:data.sync.totalDays,lastError:safeImportError(data.sync.lastError),completedAt:data.sync.completedAt??null}:null}};
  if(action==='properties')return {status:200,data:{items:data.items.map(x=>({id:x.id,displayName:x.displayName,accountName:x.accountName,permissionLevel:x.permissionLevel}))}};
  if(action==='selection')return {status:200,data:{property:data.property,sync:data.sync}};
  if(action==='sync')return {status:202,data:{status:data.status}};
  if(action==='disconnect')return {status:200,data:{disconnected:data.disconnected===true,importedDataDeleted:data.importedDataDeleted===true,storedCredentialsDeleted:data.storedCredentialsDeleted===true,googleGrantRevoked:false}};
  return {status:200,data};
}
