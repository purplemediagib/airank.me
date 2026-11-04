// Diagnostic output is a closed vocabulary. Never copy exception messages,
// stacks, URLs, SQL, headers, supplier bodies or arbitrary error codes.
const stages=new Set(['entity_database_connect','entity_migration_read','entity_migration_validate','entity_engine_initialize','entity_queue_seed','entity_queue_claim','entity_tick','collector_locations','collector_languages']);
const codes=new Set(['OPERATION_FAILED','TIMEOUT','ABORTED','NETWORK_ERROR','DATABASE_BUSY','DATABASE_LOCKED','DATABASE_QUERY_FAILED','DATABASE_UNAVAILABLE','DATABASE_AUTHENTICATION_FAILED','DATABASE_TRANSACTION_FAILED','MIGRATION_NOT_READY','HTTP_ERROR','SUPPLIER_ERROR','INVALID_RESPONSE','RESPONSE_TOO_LARGE']);
const errorCodes=new Map([
 ['SQLITE_BUSY','DATABASE_BUSY'],['SQLITE_BUSY_SNAPSHOT','DATABASE_BUSY'],['SQLITE_LOCKED','DATABASE_LOCKED'],['SQLITE_ERROR','DATABASE_QUERY_FAILED'],
 ['SQLITE_AUTH','DATABASE_AUTHENTICATION_FAILED'],['SQLITE_PERM','DATABASE_AUTHENTICATION_FAILED'],['UNAUTHORIZED','DATABASE_AUTHENTICATION_FAILED'],
 ['SERVER_ERROR','DATABASE_UNAVAILABLE'],['CONNECTION_CLOSED','DATABASE_UNAVAILABLE'],['HRANA_CLOSED_ERROR','DATABASE_UNAVAILABLE'],['HRANA_WEBSOCKET_ERROR','DATABASE_UNAVAILABLE'],
 ['TRANSACTION_CLOSED','DATABASE_TRANSACTION_FAILED'],['TRANSACTION_TIMEOUT','DATABASE_TRANSACTION_FAILED'],
 ['ECONNRESET','NETWORK_ERROR'],['ECONNREFUSED','NETWORK_ERROR'],['ENOTFOUND','NETWORK_ERROR'],['EAI_AGAIN','NETWORK_ERROR'],['FETCH_ERROR','NETWORK_ERROR'],
 ['ETIMEDOUT','TIMEOUT'],['UND_ERR_CONNECT_TIMEOUT','TIMEOUT'],['UND_ERR_HEADERS_TIMEOUT','TIMEOUT'],['UND_ERR_BODY_TIMEOUT','TIMEOUT'],
]);
const details=new WeakMap();
const httpStatus=value=>Number.isSafeInteger(value)&&value>=100&&value<=599;
const supplierStatus=value=>Number.isSafeInteger(value)&&value>=10000&&value<=60000;
// The installed libsql client wraps Hrana HttpServerError as error.cause.
// Inspect only these fixed numeric fields, never its private message or body.
const exceptionHttpStatus=error=>[error?.status,error?.statusCode,error?.cause?.status,error?.cause?.statusCode].find(httpStatus);
export function operationDiagnosticFields(value={}){
 const out={};
 if(stages.has(value.failure_stage))out.failure_stage=value.failure_stage;
 if(codes.has(value.diagnostic_code))out.diagnostic_code=value.diagnostic_code;
 if(httpStatus(value.http_status))out.http_status=value.http_status;
 if(supplierStatus(value.upstream_error_code))out.upstream_error_code=String(value.upstream_error_code);
 else if(typeof value.upstream_error_code==='string'&&/^\d{5}$/.test(value.upstream_error_code)&&supplierStatus(Number(value.upstream_error_code)))out.upstream_error_code=value.upstream_error_code;
 return out;
}
function classify(error){
 if(error?.name==='TimeoutError')return 'TIMEOUT';
 if(error?.name==='AbortError')return 'ABORTED';
 return errorCodes.get(error?.code)||errorCodes.get(error?.cause?.code)||'OPERATION_FAILED';
}
export function operationFailure(stage,error,extra={}){
 if(error&&typeof error==='object'&&details.has(error))return error;
 const failure=new Error('Operation failed');
 details.set(failure,operationDiagnosticFields({failure_stage:stage,diagnostic_code:classify(error),http_status:exceptionHttpStatus(error),...extra}));
 return failure;
}
export function operationDiagnostic(error,fallbackStage){
 return error&&typeof error==='object'&&details.has(error)?{...details.get(error)}:
  operationDiagnosticFields({failure_stage:fallbackStage,diagnostic_code:classify(error),http_status:exceptionHttpStatus(error)});
}
export async function atOperationStage(stage,operation){
 try{return await operation();}catch(error){throw operationFailure(stage,error);}
}
