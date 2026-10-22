// Must match the connector's public diagnostic vocabulary. No raw upstream text.
const categories=new Set(['authentication','permission','api_disabled','quota','invalid_request','report_incompatible','unavailable','transport','invalid_response','unknown']);
const statuses=new Set(['UNAUTHENTICATED','PERMISSION_DENIED','RESOURCE_EXHAUSTED','INVALID_ARGUMENT','FAILED_PRECONDITION','NOT_FOUND','UNAVAILABLE','INTERNAL','DEADLINE_EXCEEDED','UNKNOWN']);
const reasons=new Set(['invalid_grant','SERVICE_DISABLED','API_DISABLED','ACCESS_TOKEN_EXPIRED','ACCESS_TOKEN_SCOPE_INSUFFICIENT','INSUFFICIENT_PERMISSIONS','RATE_LIMIT_EXCEEDED','QUOTA_EXCEEDED','DAILY_LIMIT_EXCEEDED','METRIC_DIMENSION_INCOMPATIBLE','badRequest','forbidden','insufficientPermissions','accessNotConfigured','rateLimitExceeded','userRateLimitExceeded','dailyLimitExceeded','quotaExceeded']);
const GENERIC_IMPORT_ERROR='Google import failed. Retry or reconnect.';
export function safeImportError(value){
  if(value===null||value===undefined||value==='')return null;
  if(typeof value!=='string'||value.length>256)return GENERIC_IMPORT_ERROR;
  const m=value.match(/^GOOGLE_IMPORT_FAILED category=([a-z_]+)(?: http=([45]\d{2}))?(?: status=([A-Z_]+))?(?: reason=([A-Za-z_]+))?$/);
  if(!m||!categories.has(m[1])||(m[3]&&!statuses.has(m[3]))||(m[4]&&!reasons.has(m[4])))return GENERIC_IMPORT_ERROR;
  return `GOOGLE_IMPORT_FAILED category=${m[1]}${m[2]?` http=${m[2]}`:''}${m[3]?` status=${m[3]}`:''}${m[4]?` reason=${m[4]}`:''}`;
}
