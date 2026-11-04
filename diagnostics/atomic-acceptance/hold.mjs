// One run, then process-health hold until operator restores normal analytics.
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {runConfigured} from './acceptance.mjs';
import {CONFIRMATION} from './policy.mjs';
export function parseArguments(args){
 if(args.length!==2||args[0]!==`--confirm=${CONFIRMATION}`||!args[1].startsWith('--expires='))return {};
 return {confirmation:CONFIRMATION,expires:args[1].slice(10)};
}
export async function startHold({confirmation,expires,port=3003,host='0.0.0.0',run=runConfigured,emit=value=>console.log(JSON.stringify(value))}={}){
 let status='starting',stopped=false;const controller=new AbortController();
 const server=http.createServer((req,res)=>{
  const known=req.method==='GET'&&['/healthz','/readyz'].includes(req.url);
  res.writeHead(known?200:404,{'content-type':'application/json','cache-control':'no-store','connection':'close'});
  res.end(JSON.stringify(known?{service:'atomic-synthetic-acceptance-hold',status,projector_running:false,restore_required:true}:{error:'Not found'}));
 });
 server.requestTimeout=3000;server.headersTimeout=3000;server.keepAliveTimeout=1000;server.maxConnections=8;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
 const completed=Promise.resolve().then(()=>run({confirmation,expires,signal:controller.signal,emit})).then(result=>{
  status=result.status;emit({event:'atomic_synthetic_acceptance',...result});return result;
 },()=>{status='failed';const result={status,rerun:false,restore_required:true};emit({event:'atomic_synthetic_acceptance',...result});return result;});
 const stop=async()=>{if(stopped)return;stopped=true;controller.abort();await completed;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
 return {server,completed,stop};
}
async function main(){
 const hold=await startHold(parseArguments(process.argv.slice(2)));
 const stop=()=>{void hold.stop().then(()=>{process.exitCode=0;});};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);await hold.completed;
 // No polling, restart, automatic verification, cleanup or normal worker startup.
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
