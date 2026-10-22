import { createHash } from 'node:crypto';
export async function storeRawJson(scanId,provider,promptId,payload){
 const zone=process.env.BUNNY_STORAGE_ZONE;const key=process.env.BUNNY_STORAGE_ACCESS_KEY;
 if(!zone||!key)return null;
 const region=process.env.BUNNY_STORAGE_ENDPOINT||'https://storage.bunnycdn.com';
 if(!/^https:\/\/(?:[a-z0-9-]+\.)?storage\.bunnycdn\.com$/i.test(region))throw new Error('Untrusted storage endpoint');
 const objectKey=`ai-rank/raw/${scanId}/${provider}/${promptId}.json`;
 const body=JSON.stringify(payload);
 const r=await fetch(`${region}/${encodeURIComponent(zone)}/${objectKey}`,{method:'PUT',headers:{AccessKey:key,'content-type':'application/json'},body,signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw new Error('Bunny Storage upload failed: HTTP '+r.status);
 return objectKey;
}
