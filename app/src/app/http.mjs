import { getDb } from '../common/db.mjs';
import { createAppService, clientsFromEnv } from './service.mjs';
let handler;
export const isAppPath = path => /^\/v1\/(?:app(?:\/|$)|projects(?:\/|$)|industries(?:\/|$)|website-profiles(?:\/|$)|measurement-context$|me\/preferences$)/.test(path);
export async function appRoute(req, res, url) {
  try {
    handler ||= createAppService({ db: await getDb(), clients: clientsFromEnv() });
    let body;
    if (req.method !== 'GET') {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > (/^\/v1\/projects\/[A-Za-z0-9-]+\/content(?:\/|$)/.test(url.pathname) ? 524288 : 65536)) throw Object.assign(new Error(), { status: 413, code: 'BODY_TOO_LARGE' });
        chunks.push(chunk);
      }
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
      catch { throw Object.assign(new Error(), { status: 400, code: 'INVALID_JSON' }); }
    }
    const r = await handler({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body });
    res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...r.headers });
    res.end(r.data === null ? '' : JSON.stringify(r.data));
  } catch (e) {
    res.writeHead(e.status || 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    // Unexpected failures may occur after a commit: do not label them as a definite
    // pre-submission configuration rejection. Clients must reconcile uncertain writes.
    res.end(JSON.stringify({ error: { code: e.code || 'SERVICE_UNAVAILABLE', fieldErrors: e.fieldErrors } }));
  }
}
