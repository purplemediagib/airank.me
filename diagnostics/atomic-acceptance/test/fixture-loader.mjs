// Substitute the destination identity in-memory only, for offline fixture tests.
// No runtime override is shipped or enabled in either image.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const policy=new URL('../policy.mjs',import.meta.url).href;
export async function load(url,context,nextLoad){
 const result=await nextLoad(url,context);
 if(url!==policy)return result;
 const source=String(result.source);
 const original="export const ENDPOINT_SHA256='075c77e08c80dc3bd48cc649cc647669c390e13562404b1e49d93e0ea6b24e72';";
 assert.equal(source.split(original).length,2);
 const digest=createHash('sha256').update('https://atomic-fixture.invalid/v2/pipeline').digest('hex');
 return {...result,source:source.replace(original,`export const ENDPOINT_SHA256='${digest}';`)};
}
