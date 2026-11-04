// Offline-reviewed library only: no CLI, environment access, default fetch, or retries.
import { createHash } from 'node:crypto';

export const TABLES = Object.freeze([
  'project_revisions', 'summary_requests', 'summary_generations',
  'summary_heads', 'summary_payloads', 'summary_evidence',
].map(name => `airank_http_smoke_20261104_ec81557_${name}`));
const fail = code => { throw new Error(code); };
// All diagnostic reasons are locally chosen constants. Never use a server code,
// message, value, URL, or thrown exception text as a report field.
export const FAILURE_REASONS = Object.freeze([
  'aborted', 'transport_failure', 'http_rejected', 'destination_rejected',
  'body_unreadable', 'body_limit', 'body_json_invalid', 'body_duplicate_key', 'envelope_shape',
  'pipeline_slots', 'close_slot', 'close_error', 'close_response',
  'baton_missing', 'baton_open', 'baton_shape', 'execute_slot',
  'execute_response', 'execute_result', 'error_shape', 'error_ambiguous',
  'error_unsupported', 'column_shape', 'column_name', 'column_decltype',
  'affected_row_count_shape', 'insert_rowid_shape', 'row_shape', 'value_shape', 'routing_invalid',
]);
class Rejection extends Error {
  constructor(reason) { super('PROBE_REJECTED'); this.reason = reason; }
}
const reject = reason => { throw new Rejection(reason); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const owns = (value, key) => Object.hasOwn(value, key);
function rejectDuplicateKeys(json) {
  // JSON.parse validates syntax first. Scan its valid input without recursion,
  // decoding only key strings so escaped duplicate keys cannot hide ambiguity.
  const stack = [];
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (char === '"') {
      const start = i++;
      while (json[i] !== '"') { if (json[i] === '\\') i++; i++; }
      const frame = stack.at(-1);
      if (frame?.keys && frame.expectKey) {
        const key = JSON.parse(json.slice(start, i + 1));
        if (frame.keys.has(key)) reject('body_duplicate_key');
        frame.keys.add(key); frame.expectKey = false;
      }
    } else if (char === '{') stack.push({ keys: new Set(), expectKey: true });
    else if (char === '[') stack.push({});
    else if (char === '}' || char === ']') stack.pop();
    else if (char === ',' && stack.at(-1)?.keys) stack.at(-1).expectKey = true;
  }
}
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
  if (!reader) reject('body_unreadable');
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) { await reader.cancel(); reject('body_limit'); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Rejection) throw error;
    reject('body_unreadable');
  } finally { reader.releaseLock(); }
  let json, body;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    body = JSON.parse(json);
  } catch { reject('body_json_invalid'); }
  rejectDuplicateKeys(json);
  return body;
}
function missingTable(error, table) {
  // Deliberately pair the supported code and entire message representation;
  // never search substrings or accept a generic SQLite error as absence.
  // Hrana permits an omitted/null code. Those representations still require
  // one of the same complete, fixed-table messages, not a substring heuristic.
  const noCode = error.code === undefined || error.code === null;
  if ((noCode || error.code === 'SQLITE_ERROR') && error.message === `no such table: ${table}`) return true;
  if ((noCode || error.code === 'SQLITE_UNKNOWN') && error.message === `SQLite error: no such table: ${table}`) return true;
  if (!noCode && error.code !== 'SQL_INPUT_ERROR') return false;
  const prefix = `SQL input error: no such table: ${table} (at offset `;
  if (!error.message.startsWith(prefix) || !error.message.endsWith(')')) return false;
  const offset = error.message.slice(prefix.length, -1);
  // Upstream formats an i32. Only -1 (unknown) or a canonical byte offset
  // within this exact ASCII SELECT is useful evidence for this diagnostic.
  return offset === '-1' || (/^(0|[1-9][0-9]{0,2})$/.test(offset) &&
    Number(offset) < `SELECT 1 FROM ${table} LIMIT 1`.length);
}
function classify(result, table) {
  if (!record(result)) reject('execute_slot');
  if (result.type === 'error') {
    if (owns(result, 'response')) reject('error_ambiguous');
    if (!record(result.error) || (result.error.code !== undefined && result.error.code !== null && typeof result.error.code !== 'string') ||
        typeof result.error.message !== 'string') reject('error_shape');
    if (missingTable(result.error, table)) return 'absent';
    reject('error_unsupported');
  }
  if (result.type !== 'ok' || owns(result, 'error')) reject('execute_slot');
  if (!record(result.response) || result.response.type !== 'execute') reject('execute_response');
  const value = result.response.result;
  if (!record(value)) reject('execute_result');
  if (!Array.isArray(value.cols) || value.cols.length !== 1 || !record(value.cols[0])) reject('column_shape');
  // Null/omitted names are protocol-valid; others must match this fixed SELECT.
  if (value.cols[0].name !== undefined && value.cols[0].name !== null && value.cols[0].name !== '1') reject('column_name');
  if (value.cols[0].decltype !== undefined && value.cols[0].decltype !== null &&
      typeof value.cols[0].decltype !== 'string') reject('column_decltype');
  // SELECT affected_row_count is not semantically defined upstream. Enforce a
  // safe JSON-number subset of upstream u64, not zero or proof of writes.
  if (!Number.isSafeInteger(value.affected_row_count) || value.affected_row_count < 0) reject('affected_row_count_shape');
  // This optional metadata has no SELECT meaning, but a supplied value must
  // retain the signed-int64 decimal wire shape rather than arbitrary data.
  if (value.last_insert_rowid !== undefined && value.last_insert_rowid !== null) {
    const id = value.last_insert_rowid;
    if (typeof id !== 'string' || !/^-?(0|[1-9][0-9]{0,18})$/.test(id) ||
        BigInt(id) < -(2n ** 63n) || BigInt(id) > 2n ** 63n - 1n) reject('insert_rowid_shape');
  }
  if (!Array.isArray(value.rows) || value.rows.length > 1) reject('row_shape');
  if (value.rows.length === 1 && (!Array.isArray(value.rows[0]) || value.rows[0].length !== 1 ||
      !record(value.rows[0][0]) || value.rows[0][0].type !== 'integer' || value.rows[0][0].value !== '1')) reject('value_shape');
  return value.rows.length ? 'present_nonempty' : 'present_empty';
}

function verifyClosedPipeline(body) {
  if (!Array.isArray(body.results) || body.results.length !== 2) reject('pipeline_slots');
  const close = body.results[1];
  if (!record(close)) reject('close_slot');
  if (close.type === 'error') reject('close_error');
  if (close.type !== 'ok' || owns(close, 'error')) reject('close_slot');
  if (!record(close.response) || close.response.type !== 'close') reject('close_response');
  if (!owns(body, 'baton')) reject('baton_missing');
  if (typeof body.baton === 'string') reject('baton_open');
  if (body.baton !== null) reject('baton_shape');
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
      if (request.url !== endpoint || request.redirect !== 'manual') reject('destination_rejected');
      report.requests++;
      const response = await fetchImpl(request);
      signal.throwIfAborted();
      // Refuse redirect evidence even if an injected transport ignored manual.
      if (response.redirected || (response.url && response.url !== endpoint) || response.status !== 200) {
        reject('http_rejected');
      }
      const body = await boundedJSON(response);
      signal.throwIfAborted();
      if (!record(body)) reject('envelope_shape');
      const routing = routingMetadata(body.base_url, original);
      const entry = { table, state: 'unknown', ...routing };
      report.tables.push(entry);
      verifyClosedPipeline(body);
      entry.state = classify(body.results[0], table);
      if (routing.routing === 'invalid') reject('routing_invalid');
    } catch (error) {
      // Never expose errors, bodies, response headers, URLs, or credentials.
      report.status = 'inconclusive';
      report.failure_reason = signal.aborted ? 'aborted' :
        error instanceof Rejection && FAILURE_REASONS.includes(error.reason) ? error.reason : 'transport_failure';
      return report;
    }
  }
  report.status = 'observed';
  return report;
}
