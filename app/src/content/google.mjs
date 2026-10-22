import {fail} from './store.mjs';
export async function googleReport({projectId,service,view,startDate,endDate,env=process.env,fetchFn=fetch,aiOnly=false}){
 let mapping;try{mapping=JSON.parse(env.CONTENT_GOOGLE_WORKSPACES_JSON||'{}');}catch{fail(503,'GOOGLE_MAPPING_INVALID');}
 // 0.21 uses the authorised stored project ID as its connector workspace.
 // Keep an explicit operator override only for older connector installations.
 const workspace=mapping[projectId]||projectId;if(!workspace||!env.GOOGLE_CONNECTOR_BASE_URL||!env.GOOGLE_CONNECTOR_API_KEY)return {state:'not_connected',rows:[],missingDates:[],metadata:[]};
 const origin=new URL(env.GOOGLE_CONNECTOR_BASE_URL);if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)fail(503,'GOOGLE_CONNECTOR_INVALID');
 let offset=0,rows=[],first;for(let i=0;i<100;i++){
  const u=new URL(`/v1/projects/${encodeURIComponent(projectId)}/connections/${service}/reports`,origin);u.search=new URLSearchParams({view,startDate,endDate,limit:'10000',offset:String(offset),aiOnly:String(aiOnly)}).toString();
  const r=await fetchFn(u,{headers:{authorization:'Bearer '+env.GOOGLE_CONNECTOR_API_KEY,'X-AIRank-Workspace-ID':workspace},redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!r.ok){if([404,409,401,403].includes(r.status))return {state:'unavailable',httpStatus:r.status,rows:[],missingDates:[],metadata:[]};fail(502,'GOOGLE_REPORT_FAILED');}
  const d=await r.json();first||=d;rows.push(...d.rows);if(d.nextOffset===null)return {...first,rows,nextOffset:null,state:first.missingDates?.length?'partial':'available'};
  if(!Number.isInteger(d.nextOffset)||d.nextOffset<=offset)fail(502,'GOOGLE_PAGINATION_INVALID');offset=d.nextOffset;
 }return {...first,rows,state:'partial',clientTruncated:true};
}
export function aggregateGsc(rows,index=0){const map=new Map();for(const r of rows){const key=r.keys?.[index];if(!key)continue;const old=map.get(key)||{page:key,clicks:0,impressions:0,weightedPosition:0};old.clicks+=Number(r.clicks||0);old.impressions+=Number(r.impressions||0);old.weightedPosition+=Number(r.position||0)*Number(r.impressions||0);map.set(key,old);}return [...map.values()].map(p=>({...p,ctr:p.impressions?p.clicks/p.impressions:null,position:p.impressions?p.weightedPosition/p.impressions:null}));}
export function searchOpportunities(current,previous,pairs){
 const old=new Map(aggregateGsc(previous.rows).map(r=>[r.page,r]));const out=[];
 for(const p of aggregateGsc(current.rows)){
  const before=old.get(p.page);if(p.impressions>=100&&p.position>=4&&p.position<=20)out.push({kind:'search_quick_win',url:p.page,priority:'medium',rationale:'Page has search demand and an average position between 4 and 20. Review intent and content.',current:p});
  if(p.impressions>=100&&p.position<=10&&p.ctr<0.02)out.push({kind:'low_ctr_review',url:p.page,priority:'medium',rationale:'CTR is below the 2% review threshold; this is a heuristic, not a universal CTR benchmark.',current:p});
  if(current.state==='available'&&previous.state==='available'&&before?.clicks>=20&&p.clicks<before.clicks*0.7)out.push({kind:'content_decay',url:p.page,priority:'high',rationale:'Clicks fell by more than 30% across equal windows. Seasonality and data completeness need review.',current:p,previous:before});
 }
 const groups=new Map();for(const r of pairs.rows){const [query,page]=r.keys||[];if(!query||!page)continue;const m=groups.get(query)||new Map();m.set(page,(m.get(page)||0)+Number(r.impressions||0));groups.set(query,m);}
 for(const [query,pages]of groups){const candidates=[...pages].filter(([,n])=>n>=30);if(candidates.length>1)out.push({kind:'query_overlap',query,pages:candidates.map(([url,impressions])=>({url,impressions})),priority:'medium',rationale:'Multiple pages receive impressions for this query. This is an overlap candidate; check intent before merging or redirecting.'});}
 return out;
}
