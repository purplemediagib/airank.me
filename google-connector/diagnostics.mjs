// Public, versioned diagnostic vocabulary. Never retain upstream message/metadata.
const categories=new Set(['authentication','permission','api_disabled','quota','invalid_request','report_incompatible','unavailable','transport','invalid_response','unknown']);
const statuses=new Set(['UNAUTHENTICATED','PERMISSION_DENIED','RESOURCE_EXHAUSTED','INVALID_ARGUMENT','FAILED_PRECONDITION','NOT_FOUND','UNAVAILABLE','INTERNAL','DEADLINE_EXCEEDED','UNKNOWN']);
const reasons=new Set(['invalid_grant','SERVICE_DISABLED','API_DISABLED','ACCESS_TOKEN_EXPIRED','ACCESS_TOKEN_SCOPE_INSUFFICIENT','INSUFFICIENT_PERMISSIONS','RATE_LIMIT_EXCEEDED','QUOTA_EXCEEDED','DAILY_LIMIT_EXCEEDED','METRIC_DIMENSION_INCOMPATIBLE','badRequest','forbidden','insufficientPermissions','accessNotConfigured','rateLimitExceeded','userRateLimitExceeded','dailyLimitExceeded','quotaExceeded']);
export const GENERIC_IMPORT_ERROR='Google import failed. Retry or reconnect.';
const format=d=>`GOOGLE_IMPORT_FAILED category=${d.category}${d.http?` http=${d.http}`:''}${d.status?` status=${d.status}`:''}${d.reason?` reason=${d.reason}`:''}`;

/** Accept only a complete canonical allowlisted string, including for old stored jobs. */
export function safeImportError(value){
  if(value===null||value===undefined||value==='')return null;
  if(typeof value!=='string'||value.length>256)return GENERIC_IMPORT_ERROR;
  const m=value.match(/^GOOGLE_IMPORT_FAILED category=([a-z_]+)(?: http=([45]\d{2}))?(?: status=([A-Z_]+))?(?: reason=([A-Za-z_]+))?$/);
  if(!m||!categories.has(m[1])||(m[3]&&!statuses.has(m[3]))||(m[4]&&!reasons.has(m[4])))return GENERIC_IMPORT_ERROR;
  return format({category:m[1],http:m[2],status:m[3],reason:m[4]});
}

export function googleFailure(http,data){
  const upstream=data?.error;
  const status=statuses.has(upstream?.status)?upstream.status:undefined;
  // Only Google's documented ErrorInfo and legacy errors[].reason slots are read.
  const candidates=[
    ...(Array.isArray(upstream?.details)?upstream.details.filter(x=>x?.['@type']==='type.googleapis.com/google.rpc.ErrorInfo').map(x=>x.reason):[]),
    ...(Array.isArray(upstream?.errors)?upstream.errors.map(x=>x?.reason):[]),
    ...(typeof upstream==='string'?[upstream]:[]),
  ];
  const reason=candidates.find(x=>reasons.has(x));
  let category='unknown';
  if(reason==='invalid_grant'||http===401||status==='UNAUTHENTICATED')category='authentication';
  else if(['SERVICE_DISABLED','API_DISABLED','accessNotConfigured'].includes(reason))category='api_disabled';
  else if(http===429||status==='RESOURCE_EXHAUSTED'||['RATE_LIMIT_EXCEEDED','QUOTA_EXCEEDED','DAILY_LIMIT_EXCEEDED','rateLimitExceeded','userRateLimitExceeded','dailyLimitExceeded','quotaExceeded'].includes(reason))category='quota';
  else if(reason==='METRIC_DIMENSION_INCOMPATIBLE')category='report_incompatible';
  else if(http===403||status==='PERMISSION_DENIED')category='permission';
  else if(http>=500||['UNAVAILABLE','INTERNAL','DEADLINE_EXCEEDED'].includes(status))category='unavailable';
  else if(http===400||status==='INVALID_ARGUMENT'||status==='FAILED_PRECONDITION')category='invalid_request';
  const diagnostic=format({category,http:Number.isInteger(http)&&http>=400&&http<=599?http:undefined,status,reason});
  return Object.assign(new Error(diagnostic),{diagnostic,status:category==='authentication'?409:502,reconnect:category==='authentication',retryable:http===429||http>=500});
}

export function localGoogleFailure(category){
  const diagnostic=format({category:categories.has(category)?category:'unknown'});
  return Object.assign(new Error(diagnostic),{diagnostic,status:502,retryable:true});
}
