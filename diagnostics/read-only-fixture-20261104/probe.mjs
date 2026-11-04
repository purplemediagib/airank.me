// Offline-reviewed library only: no CLI, environment access, default fetch, or retries.
import { createHash } from 'node:crypto';

export const TABLES = Object.freeze([
  'project_revisions', 'summary_requests', 'summary_generations',
  'summary_heads', 'summary_payloads', 'summary_evidence',
].map(name => `airank_http_smoke_20261104_ec81557_${name}`));
const fail = code => { throw new Error(code); };
export function normalizeEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) fail('CONFIG_REJECTED');
  let url;
  try { url = new URL(value); } catch { fail('CONFIG_REJECTED'); }
  if (!['https:', 'libsql:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') fail('CONFIG_REJECTED');
  return new URL(`https://${url.host}/`);
}
export function routingMetadata(value, original) {
  if (value === null || value === undefined) return { routing: 'absent' };
  if (typeof value !== 'string' || value.length > 2048) return { routing: 'invalid' };
  let route;
  try { route = new URL(value); } catch { return { routing: 'invalid' }; }
  if (route.protocol !== 'https:' || route.username || route.password || route.search || route.hash) {
    return { routing: 'invalid' };
  }
  return {
    routing: route.origin === original.origin ? 'same_origin' : 'changed_origin',
    origin_sha256: createHash('sha256').update(route.origin).digest('hex'),
  };
}
async function boundedJSON(response) {
  const reader = response.body?.getReader();
  if (!reader) fail('RESPONSE_REJECTED');
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) { await reader.cancel(); fail('RESPONSE_LIMIT'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('RESPONSE_REJECTED'); }
}
function classify(result, table) {
  if (result?.type === 'error') {
    if (result.error?.code === 'SQLITE_ERROR' &&
        result.error?.message === `no such table: ${table}`) return 'absent';
    return 'unknown';
  }
  const value = result?.response?.result;
  if (result?.type !== 'ok' || result.response?.type !== 'execute' ||
      !Array.isArray(value?.cols) || value.cols.length !== 1 || value.cols[0]?.name !== '1' ||
      !Array.isArray(value?.rows) || value.rows.length > 1 || value.affected_row_count !== 0) {
    fail('RESPONSE_REJECTED');
  }
  if (value.rows.length === 1 && (!Array.isArray(value.rows[0]) || value.rows[0].length !== 1 ||
      value.rows[0][0]?.type !== 'integer' || value.rows[0][0]?.value !== '1')) {
    fail('RESPONSE_REJECTED');
  }
  return value.rows.length ? 'present_nonempty' : 'present_empty';
}

// verifiedDatabaseURL must come from the separately verified, exact authorized
// database's control-plane metadata, not from the SQL server's base_url response.
// An authorized operator supplies the existing credential without exposing it.
export async function probe({ configuredURL, verifiedDatabaseURL, authorization, fetchImpl, signal: externalSignal }) {
  const original = normalizeEndpoint(configuredURL);
  if (normalizeEndpoint(verifiedDatabaseURL).href !== original.href) fail('DATABASE_IDENTITY_MISMATCH');
  if (typeof fetchImpl !== 'function' || typeof authorization !== 'string' ||
      !/^Bearer [^\r\n]+$/.test(authorization)) fail('CONFIG_REJECTED');
  const endpoint = new URL('v2/pipeline', original).href;
  const report = { status: 'incomplete', tables: [], requests: 0, retries: 0, writes: 0 };
  const overall = AbortSignal.timeout(45000);
  for (const table of TABLES) {
    const signal = AbortSignal.any([overall, AbortSignal.timeout(6000), ...(externalSignal ? [externalSignal] : [])]);
    try {
      signal.throwIfAborted();
      // Each request uses a fresh stream, closes it in the same pipeline, and
      // never retains a baton or adopts a server-selected destination.
      const request = new Request(endpoint, {
        method: 'POST', redirect: 'manual', signal,
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ baton: null, requests: [
          { type: 'execute', stmt: { sql: `SELECT 1 FROM ${table} LIMIT 1`, args: [], named_args: [], want_rows: true } },
          { type: 'close' },
        ] }),
      });
      if (request.url !== endpoint || request.redirect !== 'manual') fail('DESTINATION_REJECTED');
      report.requests++;
      const response = await fetchImpl(request);
      // Refuse redirect evidence even if an injected transport ignored manual.
      if (response.redirected || (response.url && response.url !== endpoint) || response.status !== 200) {
        fail('HTTP_REJECTED');
      }
      const body = await boundedJSON(response);
      const routing = routingMetadata(body.base_url, original);
      const entry = { table, state: 'unknown', ...routing };
      report.tables.push(entry);
      if (!Array.isArray(body.results) || body.results.length !== 2 ||
          body.results[1]?.type !== 'ok' || body.results[1]?.response?.type !== 'close' ||
          (body.baton !== undefined && body.baton !== null)) fail('RESPONSE_REJECTED');
      entry.state = classify(body.results[0], table);
      if (entry.state === 'unknown' || routing.routing === 'invalid') fail('PROBE_INCONCLUSIVE');
    } catch {
      // Never expose errors, bodies, response headers, URLs, or credentials.
      report.status = 'inconclusive';
      return report;
    }
  }
  report.status = 'observed';
  return report;
}
