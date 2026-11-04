// Dedicated temporary testing entrypoint. Never imports or starts a worker.
// External operator must restore the normal image/command after reading status.
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {CONFIRMATION,runConfiguredSmoke} from './publication-http-smoke.mjs';

export async function startSmokeHold({confirmation,port=3003,host='0.0.0.0',run=runConfiguredSmoke,emit=value=>console.log(JSON.stringify(value))}={}){
 const controller=new AbortController();let smokeStatus='starting',result=null,stopping=false;
 const server=http.createServer((req,res)=>{
  const known=req.method==='GET'&&['/healthz','/readyz'].includes(req.url);
  res.writeHead(known?200:404,{'content-type':'application/json','cache-control':'no-store','connection':'close'});
  res.end(JSON.stringify(known?{ok:true,service:'synthetic-publication-smoke-hold',smoke_status:smokeStatus,projector_running:false,restore_required:true}: {error:'Not found'}));
 });
 server.requestTimeout=3000;server.headersTimeout=3000;server.keepAliveTimeout=1000;server.maxConnections=8;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
 emit({event:'synthetic_publication_smoke_hold',status:'listening',port,projector_running:false,restore_required:true});
 smokeStatus='running';
 const completed=run({confirmation,signal:controller.signal,emit}).then(value=>{result=value;smokeStatus=value.status;return value;},()=>{result={status:'failed',code:'SMOKE_WRAPPER_FAILED'};smokeStatus='failed';emit({event:'synthetic_publication_smoke',...result});return result;});
 const stop=async()=>{if(stopping)return;stopping=true;controller.abort();await completed;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
 return {server,completed,stop,status:()=>({smokeStatus,result})};
}
async function main(){
 const args=process.argv.slice(2);
 // Invalid/missing confirmation holds safely with not_run, rather than causing
 // an Always restart loop. It never reads database credentials in that state.
 const confirmation=args.length===1&&args[0]===`--confirm=${CONFIRMATION}`?CONFIRMATION:undefined;
 const hold=await startSmokeHold({confirmation});
 const stop=()=>{void hold.stop().then(()=>{process.exitCode=0;});};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 await hold.completed;
 // Listening server intentionally keeps this inert process alive. No timers,
 // retries, DB polling, cleanup, analytics workers or provider calls follow.
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
