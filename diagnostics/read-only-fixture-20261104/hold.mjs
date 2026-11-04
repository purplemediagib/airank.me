// A separate read-only diagnostic image. No application modules or packages.
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {probe, normalizeEndpoint} from './probe.mjs';
export const CONFIRMATION = 'READ_SIX_SYNTHETIC_TABLES_20261104';
export const VERIFIED_DATABASE_URL = 'libsql://01M4MYDTP7SQP65A096QD7DBJ2-airank-db.lite.bunnydb.net/';
const nativeFetch = globalThis.fetch;

export function approvedWindow(confirmation, expires, now = Date.now()) {
  if (confirmation !== CONFIRMATION || typeof expires !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(expires)) return false;
  const end = Date.parse(expires);
  return Number.isFinite(end) && new Date(end).toISOString() === expires && end > now && end - now <= 120000;
}
export async function runConfiguredProbe({confirmation, expires, signal, env = process.env, now = Date.now()} = {}) {
  // Default/malformed/expired invocation neither reads credentials nor calls HTTP.
  if (!approvedWindow(confirmation, expires, now)) return {status:'not_run', requests:0, writes:0, retries:0};
  try {
    if (normalizeEndpoint(env.BUNNY_DATABASE_URL).href !== normalizeEndpoint(VERIFIED_DATABASE_URL).href)
      return {status:'configuration_rejected', requests:0, writes:0, retries:0};
    if (!approvedWindow(confirmation, expires)) return {status:'not_run', requests:0, writes:0, retries:0};
    const token = env.BUNNY_DATABASE_AUTH_TOKEN;
    if (typeof token !== 'string' || token.length < 1 || /[\r\n]/.test(token))
      return {status:'configuration_rejected', requests:0, writes:0, retries:0};
    const deadline = AbortSignal.timeout(Math.max(1, Date.parse(expires) - Date.now()));
    const combined = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
    return await probe({configuredURL:env.BUNNY_DATABASE_URL, verifiedDatabaseURL:VERIFIED_DATABASE_URL,
      authorization:`Bearer ${token}`, signal:combined, fetchImpl:request => {
        if (!approvedWindow(confirmation, expires)) throw new Error('WINDOW_CLOSED');
        request.signal.throwIfAborted();
        return nativeFetch(request);
      }});
  } catch { return {status:'inconclusive', requests:null, writes:0, retries:0}; }
}
export async function startProbeHold({confirmation,expires,port=3003,host='0.0.0.0',run=runConfiguredProbe,
  emit=value=>console.log(JSON.stringify(value))}={}) {
  const controller = new AbortController();
  let status='starting', stopped=false;
  const server=http.createServer((req,res)=>{
    const known=req.method==='GET' && ['/healthz','/readyz'].includes(req.url);
    res.writeHead(known?200:404,{'content-type':'application/json','cache-control':'no-store','connection':'close'});
    res.end(JSON.stringify(known?{service:'read-only-fixture-probe-hold',status,projector_running:false,restore_required:true}:{error:'Not found'}));
  });
  server.requestTimeout=3000;server.headersTimeout=3000;server.keepAliveTimeout=1000;server.maxConnections=8;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  emit({event:'read_only_fixture_probe_hold',status:'listening',projector_running:false,restore_required:true});
  const completed=Promise.resolve().then(()=>run({confirmation,expires,signal:controller.signal})).then(result=>{
    status=result.status;emit({event:'read_only_fixture_probe',...result});return result;
  },()=>{status='inconclusive';const result={status,requests:null,writes:0,retries:0};emit({event:'read_only_fixture_probe',...result});return result;});
  const stop=async()=>{if(stopped)return;stopped=true;controller.abort();await completed;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
  return {server,completed,stop};
}
async function main() {
  const args=process.argv.slice(2);
  const confirmation=args.length===2 && args[0]===`--confirm=${CONFIRMATION}` ? CONFIRMATION : undefined;
  const expires=args.length===2 && args[1].startsWith('--expires=') ? args[1].slice(10) : undefined;
  const hold=await startProbeHold({confirmation,expires});
  const stop=()=>{void hold.stop().then(()=>{process.exitCode=0;});};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  await hold.completed;
  // Stay alive without SQL/polling/retries. Operator restores the original image.
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
