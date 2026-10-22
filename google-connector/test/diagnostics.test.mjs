import test from 'node:test';
import assert from 'node:assert/strict';
import {googleFailure,safeImportError,GENERIC_IMPORT_ERROR} from '../diagnostics.mjs';
test('0.1.1 Google diagnostic protection survives the content report upgrade',()=>{
 const e=googleFailure(403,{error:{status:'PERMISSION_DENIED',message:'PRIVATE-TOKEN',details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'SERVICE_DISABLED',metadata:{secret:'PRIVATE-TOKEN'}}]}});
 assert.match(e.diagnostic,/category=api_disabled/);assert.equal(e.message.includes('PRIVATE-TOKEN'),false);assert.equal(safeImportError(e.diagnostic),e.diagnostic);
 assert.equal(safeImportError('Old error with PRIVATE-TOKEN'),GENERIC_IMPORT_ERROR);
 assert.equal(googleFailure(429,{error:{status:'RESOURCE_EXHAUSTED'}}).retryable,true);
 assert.equal(googleFailure(400,{error:'invalid_grant'}).reconnect,true);
});
