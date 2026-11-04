import test from 'node:test';
import assert from 'node:assert/strict';
import { probe, TABLES, routingMetadata } from './probe.mjs';
const base = 'https://authorized.example.invalid/';
const options = { configuredURL: base, verifiedDatabaseURL: base, authorization: 'Bearer MOCK_SECRET_NOT_REAL' };
function response(state = 'present_empty', base_url = null, table = TABLES[0]) {
  return Response.json({ baton: null, base_url, results: [state === 'absent'
    ? { type: 'error', error: { code: 'SQLITE_ERROR', message: `no such table: ${table}` } }
    : { type: 'ok', response: { type: 'execute', result: { cols: [{ name: '1', decltype: null }], affected_row_count: 0, rows: state === 'present_empty' ? [] : [[{ type: 'integer', value: '1' }]] } } },
    { type: 'ok', response: { type: 'close' } },
  ] });
}
for (const route of [null, base, 'https://attacker.example.invalid/secret-path', 'https://authorized.example.invalid:444/']) {
  test(`six fixed requests; route ${route === null ? 'absent' : new URL(route).host} is never followed`, async () => {
    let calls = 0;
    const result = await probe({ ...options, fetchImpl: async request => {
      assert.equal(request.url, `${base}v2/pipeline`);
      assert.equal(request.redirect, 'manual');
      const body = await request.json();
      assert.equal(body.baton, null);
      assert.equal(body.requests.length, 2);
      assert.deepEqual(body.requests[1], { type: 'close' });
      assert.equal(body.requests[0].stmt.sql, `SELECT 1 FROM ${TABLES[calls]} LIMIT 1`);
      calls++;
      return response('present_empty', route);
    } });
    assert.equal(calls, 6); assert.equal(result.status, 'observed');
    assert.ok(!JSON.stringify(result).includes('secret-path'));
    assert.ok(!JSON.stringify(result).includes('MOCK_SECRET'));
  });
}
test('exact six absence responses and no retry', async () => {
  let i = 0;
  const result = await probe({ ...options, fetchImpl: async () => response('absent', null, TABLES[i++]) });
  assert.equal(result.status, 'observed');
  assert.ok(result.tables.every(row => row.state === 'absent'));
});
test('nonempty result is bounded existence, not a count', async () => {
  const result = await probe({ ...options, fetchImpl: async () => response('present_nonempty') });
  assert.ok(result.tables.every(row => row.state === 'present_nonempty'));
});
for (const route of ['https://user:SECRET@evil.invalid/', 'https://evil.invalid/?token=SECRET', 'http://evil.invalid/', '//evil.invalid/', 'data:text/plain,SECRET']) {
  test('invalid or credential-bearing routing metadata is redacted and never followed: ' + route.split(':')[0], async () => {
    let calls = 0;
    const result = await probe({ ...options, fetchImpl: async () => { calls++; return response('present_empty', route); } });
    assert.equal(calls, 1); assert.equal(result.status, 'inconclusive');
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  });
}
test('mismatched control-plane identity makes zero requests', async () => {
  await assert.rejects(probe({ ...options, verifiedDatabaseURL: 'https://other.invalid/', fetchImpl: () => assert.fail() }), /IDENTITY_MISMATCH/);
});
for (const status of [301, 302, 307, 308, 401, 500]) {
  test(`HTTP ${status} stops after one request`, async () => {
    let calls = 0;
    const result = await probe({ ...options, fetchImpl: async () => { calls++; return new Response('', { status, headers: { location: 'https://evil.invalid/' } }); } });
    assert.equal(calls, 1); assert.equal(result.status, 'inconclusive');
  });
}
test('oversize response stops without exposing body', async () => {
  const result = await probe({ ...options, fetchImpl: async () => new Response('SECRET'.repeat(12000)) });
  assert.equal(result.requests, 1); assert.equal(result.status, 'inconclusive');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('unknown errors are not treated as absent or exposed', async () => {
  const result = await probe({ ...options, fetchImpl: async () => { throw new Error('SECRET'); } });
  assert.equal(result.requests, 1); assert.equal(result.status, 'inconclusive');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
});
test('route digest strips paths and is not endpoint authorization', () => {
  assert.deepEqual(routingMetadata(`${base}a`, new URL(base)), routingMetadata(`${base}b`, new URL(base)));
});
for (const mutate of [
  body => { body.baton = 'SECRET'; },
  body => { body.results[0].response.result.rows = [{ 0: { type: 'integer', value: '1' }, length: 1 }]; },
  body => { body.results[0].response.result.cols = [{name:'SECRET'}]; },
  body => { delete body.results[0].response.result.cols; },
  body => { body.results[1] = { type: 'error', error: { message: 'SECRET' } }; },
  body => { body.results[0].response.result.rows = [[{ type: 'text', value: 'SECRET' }]]; },
  body => { body.results[0] = { type: 'error', error: { code: 'SQLITE_BUSY', message: 'SECRET' } }; },
]) {
  test('malformed, open-stream, or unknown error response fails closed', async () => {
    let calls = 0;
    const result = await probe({ ...options, fetchImpl: async () => {
      calls++;
      const body = await response().json(); mutate(body); return Response.json(body);
    } });
    assert.equal(calls, 1); assert.equal(result.status, 'inconclusive');
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  });
}
test('redirected fetch result fails even if transport disregarded manual', async () => {
  const res = response(); Object.defineProperty(res, 'redirected', { value: true });
  const result = await probe({ ...options, fetchImpl: async () => res });
  assert.equal(result.requests, 1); assert.equal(result.status, 'inconclusive');
});

test('caller abort stops before any request', async () => {
 const signal = AbortSignal.abort();
 const result = await probe({...options, signal, fetchImpl: () => assert.fail()});
 assert.equal(result.status, 'inconclusive'); assert.equal(result.requests, 0);
});
