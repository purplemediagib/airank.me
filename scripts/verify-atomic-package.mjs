// Read-only verification. Never imports or starts application code.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('diagnostics/atomic-acceptance/package-manifest.json',root),'utf8'));
assert.equal(manifest.candidate_commit,'b7e71ccb883de4d5a22809f7b40d283004cbc766');
for(const [file,digest] of Object.entries(manifest.files)){
 assert.match(file,/^(app\/(src|data)\/|diagnostics\/atomic-acceptance\/|scripts\/verify-atomic-package\.mjs$|Dockerfile\.atomic-acceptance$|app\/package(-lock)?\.json$)/);
 assert.ok(!file.includes('..'));
 // Dockerfile is build context metadata, not an image runtime file.
 if(process.argv.includes('--image')&&file==='Dockerfile.atomic-acceptance')continue;
 const location=process.argv.includes('--image')&&/^app\/package/.test(file)?file.slice(4):file;
 assert.equal(createHash('sha256').update(await readFile(new URL(location,root))).digest('hex'),digest,file);
}
console.log(JSON.stringify({status:'verified',candidate_commit:manifest.candidate_commit,files:Object.keys(manifest.files).length,revision:process.env.AIRANK_BUILD_REVISION||null,uid:process.getuid?.()}));
