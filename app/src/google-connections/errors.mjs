import {safeImportError as structuredImportError} from './diagnostics.mjs';

const categories=new Set([
 'GOOGLE_RECONNECT_REQUIRED','GOOGLE_API_DISABLED','GOOGLE_SCOPE_REQUIRED',
 'GOOGLE_QUOTA_LIMIT','GOOGLE_ACCESS_DENIED','GOOGLE_REPORT_INVALID',
 'GOOGLE_PROPERTY_NOT_FOUND','GOOGLE_TEMPORARILY_UNAVAILABLE','GOOGLE_IMPORT_FAILED',
]);
export function safeImportError(value){
 if(value===null||value===undefined||value==='')return null;
 if(categories.has(value))return value;
 const diagnostic=structuredImportError(value);
 return diagnostic==='Google import failed. Retry or reconnect.'?'GOOGLE_IMPORT_FAILED':diagnostic;
}
