import http from 'node:http';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {Store} from './store.mjs';
import {SCOPES,API,AI_RULES_VERSION,dateDaysAgo,daysBetween,reportBody,parseGA} from './reports.mjs';
import {googleFailure,localGoogleFailure,safeImportError,GENERIC_IMPORT_ERROR} from './diagnostics.mjs';

const rand=()=>randomBytes(32).toString('base64url');
const hash=s=>createHash('sha256').update(s).digest('base64url');
const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));
const fail=(ok,message,status=400)=>{if(!ok)throw Object.assign(new Error(message),{status});};
const ident=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const connectionKey=(w,p,s)=>JSON.stringify([w,p,s]);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function createApp(config,fetcher=globalThis.fetch){
  const test=config.TEST_MODE===true;
  const origin=config.PUBLIC_BASE_URL?.replace(/\/$/,'')||'';
  const validURL=u=>{try{const x=new URL(u);return !x.username&&!x.password&&!x.hash&&(x.protocol==='https:'||(test&&x.hostname==='127.0.0.1'));}catch{return false;}};
  if(origin)fail(validURL(origin)&&new URL(origin).origin===origin,'PUBLIC_BASE_URL must be an HTTPS origin');
  const returns=(config.APP_RETURN_URLS||'').split(',').map(x=>x.trim()).filter(Boolean);
  for(const u of returns)fail(validURL(u),'APP_RETURN_URLS must contain exact HTTPS URLs');
  const missing=['PUBLIC_BASE_URL','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','CONNECTOR_API_KEY','TOKEN_ENCRYPTION_KEY','APP_RETURN_URLS'].filter(k=>!config[k]);
  if(config.CONNECTOR_API_KEY)fail(config.CONNECTOR_API_KEY.length>=32,'CONNECTOR_API_KEY must be at least 32 characters');
  const store=config.TOKEN_ENCRYPTION_KEY?new Store(config.DATA_DIR||'/data',config.TOKEN_ENCRYPTION_KEY):null;
  const ready=missing.length===0;
  const backfill=Number(config.BACKFILL_DAYS||90);fail(Number.isInteger(backfill)&&backfill>=1&&backfill<=90,'BACKFILL_DAYS must be 1–90');
  let stopping=false,busy=false;
  const locks=new Map();
  const withLock=(key,fn)=>{const prev=locks.get(key)||Promise.resolve();const next=prev.catch(()=>{}).then(fn);locks.set(key,next);return next.finally(()=>{if(locks.get(key)===next)locks.delete(key);});};
  const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  const redirect=(res,url)=>{res.writeHead(303,{Location:url});res.end();};
  const page=(res,title,text,status=200)=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8'});res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:17px system-ui;color:#182b43;background:#f7fbff;max-width:680px;margin:70px auto;padding:24px}h1{font-size:30px}p{line-height:1.6}</style><h1>${esc(title)}</h1><p>${esc(text)}</p></html>`);};
  async function body(req){let n=0,chunks=[];for await(const chunk of req){n+=chunk.length;fail(n<=32768,'Request too large',413);chunks.push(chunk);}let b;try{b=JSON.parse(Buffer.concat(chunks).toString());}catch{fail(false,'Invalid JSON');}fail(b&&typeof b==='object'&&!Array.isArray(b),'Expected JSON object');return b;}
  async function remote(url,options={}){
    let r;try{r=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw localGoogleFailure('transport');}
    let text;try{text=await r.text();}catch{throw localGoogleFailure('transport');}
    if(text.length>24*1024*1024)throw localGoogleFailure('invalid_response');
    let d;try{d=JSON.parse(text||'{}');}catch{
      if(!r.ok)throw googleFailure(r.status,null);
      throw localGoogleFailure('invalid_response');
    }
    if(!r.ok)throw googleFailure(r.status,d);
    return d;
  }
  const tokenRequest=form=>remote('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...form,client_id:config.GOOGLE_CLIENT_ID,client_secret:config.GOOGLE_CLIENT_SECRET})});
  async function accessToken(key){
    const c=store.get('connection',key);fail(c,'Google connection not found',404);fail(c.status!=='reconnect_required','Reconnect Google to continue',409);
    if(c.expires>Date.now()+60000)return c.access_token;
    try{const t=await tokenRequest({grant_type:'refresh_token',refresh_token:c.refresh_token});fail(t.access_token,'Google returned no access token',502);store.set('connection',key,{...c,...t,refresh_token:t.refresh_token||c.refresh_token,expires:Date.now()+Number(t.expires_in||3600)*1000});return t.access_token;}
    catch(e){if(e.reconnect)store.set('connection',key,{...c,status:'reconnect_required'});throw e;}
  }
  async function google(key,url,data){const token=await accessToken(key);try{return await remote(url,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});}catch(e){if(e.reconnect){const c=store.get('connection',key);if(c)store.set('connection',key,{...c,status:'reconnect_required'});}throw e;}}
  async function gaProperties(key){let next='',out=[];for(let i=0;i<100;i++){const q=new URLSearchParams({pageSize:'200',...(next?{pageToken:next}:{})});const d=await google(key,API.admin+'accountSummaries?'+q);for(const a of d.accountSummaries||[])for(const p of a.propertySummaries||[])out.push({id:p.property,displayName:p.displayName,account:a.account,accountName:a.displayName});next=d.nextPageToken;if(!next)return out;}throw Object.assign(new Error('Property list too large'),{status:502});}
  async function gscSites(key){const d=await google(key,API.gsc+'sites');return(d.siteEntry||[]).filter(s=>s.permissionLevel!=='siteUnverifiedUser').map(s=>({id:s.siteUrl,permissionLevel:s.permissionLevel}));}
  function eraseReports(key){for(const kind of ['ga4-day','gsc-day'])for(const r of store.list(kind))if(r.value.connectionKey===key)store.del(kind,r.id);}
  function newJob(key,days=backfill){const c=store.get('connection',key);fail(c?.property,'Select a property first',409);const zone=c.service==='gsc'?'America/Los_Angeles':(c.timeZone||'UTC');
    const dates=daysBetween(dateDaysAgo(days,zone),dateDaysAgo(1,zone));
    store.set('job',key,{connectionKey:key,generation:c.generation,reportVersion:2,status:'queued',dates,cursor:0,attempts:0,nextAttempt:0,createdAt:new Date().toISOString(),lastError:null});
  }
  async function gaReport(key,property,kind,date){let rows=[],offset=0,meta=[],total=0;for(let pageN=0;pageN<50;pageN++){
    const d=await google(key,API.ga4+property+':runReport',{...reportBody(kind,date),offset:String(offset)});const part=parseGA(d);rows.push(...part);total=Number(d.rowCount||0);meta.push(d.metadata||{});offset+=part.length;
    if(!part.length||offset>=total)return{rows,rowCount:total,metadata:meta,truncated:offset<total};
  }return{rows,rowCount:total,metadata:meta,truncated:true};}
  async function syncDay(key,date){const c=store.get('connection',key);fail(c?.property,'Select a property first',409);
    if(c.service==='ga4'){
      const result={connectionKey:key,date,property:c.property,timeZone:c.timeZone,currency:c.currency,classificationVersion:AI_RULES_VERSION,syncedAt:new Date().toISOString()};
      for(const kind of ['overview','sources','pages','countries','devices'])result[kind]=await gaReport(key,c.property,kind,date);
      store.set('ga4-day',JSON.stringify([key,date]),result);
    }else{
      const url=API.gsc+'sites/'+encodeURIComponent(c.property)+'/searchAnalytics/query';
      const base={startDate:date,endDate:date,type:'web',dataState:'final'};
      const totals=await google(key,url,{...base,dimensions:[],rowLimit:1});
      const result={connectionKey:key,date,property:c.property,timeZone:'America/Los_Angeles',totals:totals.rows?.[0]||null,syncedAt:new Date().toISOString(),limitations:['GSC exposes top rows, not all queries. Query totals may differ from property totals. Google AI features are included in Web search.']};
      for(const kind of ['queries','pages','countries','devices','query_pages']){
        const dim={queries:'query',pages:'page',countries:'country',devices:'device'}[kind];let rows=[],more=true;
        for(let pageN=0;pageN<2;pageN++){const d=await google(key,url,{...base,dimensions:kind==='query_pages'?['query','page']:[dim],rowLimit:25000,startRow:pageN*25000});rows.push(...(d.rows||[]));if((d.rows||[]).length<25000){more=false;break;}}
        result[kind]={rows,possiblyTruncated:more};
      }store.set('gsc-day',JSON.stringify([key,date]),result);
    }
  }
  async function tick(){if(!ready||busy||stopping||config.SYNC_ENABLED==='false')return;busy=true;
    try{
      store.cleanup();
      for(const {id:key,value:c}of store.list('connection')){
        if(!c.property||c.status!=='connected')continue;
        const job=store.get('job',key);
        if(!job||job.generation!==c.generation) newJob(key);
        else if(job.status==='complete'&&Date.now()-Date.parse(job.completedAt)>86400000)newJob(key,Math.min(90,Math.max(7,Math.ceil((Date.now()-Date.parse(job.completedAt))/86400000)+7)));
      }
      const candidates=store.list('job').filter(x=>{const c=store.get('connection',x.id);return c?.status==='connected'&&x.value.generation===c.generation&&['queued','running','retrying'].includes(x.value.status)&&x.value.nextAttempt<=Date.now();}).sort((a,b)=>(a.value.lastStepAt||0)-(b.value.lastStepAt||0));
      const item=candidates[0];if(!item)return;
      await withLock(item.id,async()=>{
        const key=item.id,j=store.get('job',key),c=store.get('connection',key);if(!j||!c||c.status!=='connected'||j.generation!==c.generation)return;
        if(j.cursor>=j.dates.length){store.set('job',key,{...j,status:'complete',completedAt:new Date().toISOString()});return;}
        store.set('job',key,{...j,status:'running'});
        try{await syncDay(key,j.dates[j.cursor]);const end=j.cursor+1>=j.dates.length;store.set('job',key,{...j,cursor:j.cursor+1,status:end?'complete':'queued',attempts:0,lastError:null,lastStepAt:Date.now(),...(end?{completedAt:new Date().toISOString()}:{})});}
        catch(e){const attempts=j.attempts+1;store.set('job',key,{...j,attempts,status:e.retryable&&attempts<=5?'retrying':'failed',nextAttempt:Date.now()+Math.min(3600000,30000*2**attempts),lastStepAt:Date.now(),lastError:safeImportError(e.diagnostic)||GENERIC_IMPORT_ERROR});}
      });
    }finally{busy=false;}
  }
  const timer=!test?setInterval(()=>tick().catch(()=>console.error('Background sync failed; see authenticated job status')),1500):null;timer?.unref();
  function authenticate(req,project){fail(ready,'Connector configuration is incomplete',503);fail(eq(req.headers.authorization,'Bearer '+config.CONNECTOR_API_KEY),'Authentication required',401);const workspace=req.headers['x-airank-workspace-id'];fail(ident(workspace)&&ident(project),'Valid workspace and project IDs required');return workspace;}
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    const u=new URL(req.url,'http://internal'),path=u.pathname;
    try{
      if(path==='/health'&&req.method==='GET')return send(res,200,{status:'ok',service:'airank-google-connector',version:'0.2.0',revision:process.env.AIRANK_BUILD_REVISION||null});
      if(path==='/ready'&&req.method==='GET')return send(res,ready?200:503,{ready});
      if(path==='/'&&req.method==='GET')return page(res,'AI Rank.me Google Connector',ready?'Service is running. Manage your Google connections inside the AI Rank application.':'Service is running. Deployment configuration is not complete yet.');
      if(path==='/v1/oauth/google/start'&&req.method==='GET'){
        fail(ready,'Connector configuration is incomplete',503);const ticket=u.searchParams.get('ticket');fail(ticket&&/^[A-Za-z0-9_-]{43}$/.test(ticket),'Invalid connection link');const record=store.take('ticket',hash(ticket));fail(record,'Connection link expired or already used');
        const state=rand(),cookie=rand(),verifier=rand();store.set('state',hash(state),{...record,cookie:hash(cookie),verifier},600);
        res.setHeader('Set-Cookie',`ar_oauth_${hash(state).slice(0,16)}=${cookie}; Path=/v1/oauth/google; HttpOnly; SameSite=Lax; Max-Age=600${test?'':'; Secure'}`);
        const q=new URLSearchParams({client_id:config.GOOGLE_CLIENT_ID,redirect_uri:origin+'/v1/oauth/google/callback',response_type:'code',scope:'openid email '+SCOPES[record.service],access_type:'offline',prompt:'consent select_account',include_granted_scopes:'false',state,code_challenge:hash(verifier),code_challenge_method:'S256'});
        return redirect(res,'https://accounts.google.com/o/oauth2/v2/auth?'+q);
      }
      if(path==='/v1/oauth/google/callback'&&req.method==='GET'){
        fail(ready,'Connector configuration is incomplete',503);const state=u.searchParams.get('state');fail(state&&/^[A-Za-z0-9_-]{43}$/.test(state),'Invalid OAuth state');
        const sk=hash(state),record=store.get('state',sk);fail(record,'OAuth state expired or already used');
        const cookieName='ar_oauth_'+sk.slice(0,16);const cookie=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
        fail(cookie&&eq(hash(cookie),record.cookie),'OAuth browser session does not match',403);store.take('state',sk);
        res.setHeader('Set-Cookie',`${cookieName}=; Path=/v1/oauth/google; HttpOnly; SameSite=Lax; Max-Age=0${test?'':'; Secure'}`);
        const target=new URL(record.returnUrl);
        if(u.searchParams.has('error')){target.searchParams.set('google_connection','cancelled');target.searchParams.set('service',record.service);return redirect(res,target.href);}
        fail(u.searchParams.get('code'),'Missing Google authorisation code');
        await withLock(record.key,async()=>{
          const t=await tokenRequest({grant_type:'authorization_code',code:u.searchParams.get('code'),code_verifier:record.verifier,redirect_uri:origin+'/v1/oauth/google/callback'});
          fail(t.access_token,'Google returned no access token',502);fail((t.scope||'').split(' ').includes(SCOPES[record.service]),'Required read-only permission was not granted',403);
          const info=await remote('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:'Bearer '+t.access_token}});fail(info.sub&&info.email&&info.email_verified===true,'A verified Google account is required',403);
          const old=store.get('connection',record.key),same=old?.googleSub===info.sub;const refresh=t.refresh_token||(same?old.refresh_token:null);fail(refresh,'Google did not grant offline access; reconnect and approve access',409);
          const generation=rand();
          store.set('connection',record.key,{workspace:record.workspace,project:record.project,service:record.service,email:info.email,googleSub:info.sub,access_token:t.access_token,refresh_token:refresh,scope:t.scope,expires:Date.now()+Number(t.expires_in||3600)*1000,status:'connected',connectedAt:new Date().toISOString(),connectedBy:record.userId,generation,...(same&&old.property?{property:old.property,timeZone:old.timeZone,currency:old.currency}: {})});
          if(!same){eraseReports(record.key);store.del('job',record.key);}else if(old.property)newJob(record.key,7);
        });target.searchParams.set('google_connection','connected');target.searchParams.set('service',record.service);return redirect(res,target.href);
      }
      const match=path.match(/^\/v1\/projects\/([A-Za-z0-9_-]{1,128})\/connections\/(ga4|gsc)(?:\/(connect|properties|selection|sync|reports))?$/);
      if(!match)return send(res,404,{error:'not_found'});
      const [,project,service,action]=match,workspace=authenticate(req,project),key=connectionKey(workspace,project,service);
      if(action==='connect'&&req.method==='POST'){
        const b=await body(req);fail(ident(b.userId),'userId is required');fail(returns.includes(b.returnUrl),'Return URL is not allowlisted');
        const ticket=rand();store.set('ticket',hash(ticket),{workspace,project,service,key,userId:b.userId,returnUrl:b.returnUrl},120);
        return send(res,200,{url:origin+'/v1/oauth/google/start?ticket='+ticket,expiresIn:120});
      }
      return await withLock(key,async()=>{
        let c=store.get('connection',key);
        if(!action&&req.method==='GET'){
          const j=store.get('job',key);return send(res,200,{connected:!!c,status:c?.status||'disconnected',service,email:c?.email||null,property:c?.property||null,timeZone:c?.timeZone||null,currency:c?.currency||null,connectedAt:c?.connectedAt||null,sync:j?{status:j.status,completedDays:j.cursor,totalDays:j.dates.length,lastError:safeImportError(j.lastError),completedAt:j.completedAt||null}:null});
        }
        if(!action&&req.method==='DELETE'){
          store.del('connection',key);store.del('job',key);eraseReports(key);
          for(const kind of ['ticket','state'])for(const r of store.list(kind))if(r.value.key===key)store.del(kind,r.id);
          return send(res,200,{disconnected:true,storedCredentialsDeleted:true,importedDataDeleted:true,googleGrantRevoked:false});
        }
        fail(c,'Google connection not found',404);
        if(action==='properties'&&req.method==='GET')return send(res,200,{items:service==='ga4'?await gaProperties(key):await gscSites(key)});
        if(action==='selection'&&req.method==='PUT'){
          const b=await body(req);fail(typeof b.property==='string'&&b.property.length<=2048,'property required');
          const items=service==='ga4'?await gaProperties(key):await gscSites(key);fail(items.some(x=>x.id===b.property),'Property is not accessible to this Google account',403);
          const details=service==='ga4'?await google(key,API.admin+b.property):{};
          if(c.property!==b.property)eraseReports(key);
          c=store.get('connection',key);store.set('connection',key,{...c,property:b.property,timeZone:details.timeZone||(service==='gsc'?'America/Los_Angeles':'UTC'),currency:details.currencyCode||null,generation:rand()});
          newJob(key);return send(res,200,{property:b.property,sync:'queued'});
        }
        if(action==='sync'&&req.method==='POST'){
          fail(c.status==='connected','Reconnect Google first',409);const j=store.get('job',key);if(j&&['queued','running','retrying'].includes(j.status))return send(res,202,{status:j.status});
          if(j?.status==='failed')store.set('job',key,{...j,status:'queued',attempts:0,nextAttempt:0,lastError:null});else newJob(key,7);return send(res,202,{status:'queued'});
        }
        if(action==='reports'&&req.method==='GET'){
          const start=u.searchParams.get('startDate'),end=u.searchParams.get('endDate'),view=u.searchParams.get('view')||(service==='ga4'?'sources':'totals');
          const validDate=d=>{try{return /^\d{4}-\d{2}-\d{2}$/.test(d)&&new Date(d+'T12:00:00Z').toISOString().slice(0,10)===d;}catch{return false;}};
          fail(validDate(start)&&validDate(end)&&start<=end&&(Date.parse(end)-Date.parse(start))/86400000<366,'Use a valid date range of at most 366 days');
          fail((service==='ga4'?['overview','sources','pages','countries','devices']:['totals','queries','pages','countries','devices','query_pages']).includes(view),'Unknown report view');
          const offset=Number(u.searchParams.get('offset')||0),limit=Number(u.searchParams.get('limit')||1000);fail(Number.isInteger(offset)&&offset>=0&&Number.isInteger(limit)&&limit>=1&&limit<=10000,'Invalid pagination');
          const dates=daysBetween(start,end),days=dates.map(d=>store.get(service+'-day',JSON.stringify([key,d]))).filter(Boolean),rows=[];
          fail(!(service==='ga4'&&view==='overview'&&u.searchParams.get('aiOnly')==='true'),'Use the sources view for identified AI traffic');
          for(const d of days){const slice=view==='totals'?(d.totals?[d.totals]:[]):(d[view]?.rows||[]);for(const row of slice){if(service==='ga4'&&u.searchParams.get('aiOnly')==='true'&&!row.aiAssistant)continue;rows.push({...row,date:d.date});}}
          return send(res,200,{service,property:c.property,view,startDate:start,endDate:end,timeZone:c.timeZone,currency:c.currency||null,classificationVersion:service==='ga4'?AI_RULES_VERSION:undefined,rows:rows.slice(offset,offset+limit),totalRows:rows.length,nextOffset:offset+limit<rows.length?offset+limit:null,availableDates:days.map(d=>d.date),missingDates:dates.filter(d=>!days.some(x=>x.date===d&&(view==='totals'||x[view]!==undefined))),metadata:days.map(d=>({date:d.date,syncedAt:d.syncedAt,...(view==='totals'?{}:{googleMetadata:d[view]?.metadata,truncated:d[view]?.truncated,possiblyTruncated:d[view]?.possiblyTruncated})})),notes:service==='ga4'?['Identified AI traffic only; missing referrers are not recovered.','Key events and revenue depend on property tracking. Rates must not be summed.','Recent data may be revised.']:['Search Console Web includes Google AI features.','Detailed query rows do not represent all searches; use totals for overview.','Only final data is imported; recent days may be empty until Google finalises them.']});
        }
        return send(res,405,{error:'method_not_allowed'});
      });
    }catch(e){if(path.startsWith('/v1/oauth/'))return page(res,'Google connection could not finish',e.status&&e.status<500?e.message:'Please retry the connection from AI Rank.',e.status||500);return send(res,e.status||500,{error:e.status?e.message:'Internal connector error'});}
  });
  server.requestTimeout=35000;server.headersTimeout=10000;
  return{server,store,tick,ready,missing,stop(){stopping=true;if(timer)clearInterval(timer);},close(){stopping=true;if(timer)clearInterval(timer);server.close();store?.close();}};
}
