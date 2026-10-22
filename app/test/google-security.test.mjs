import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyGoogleIdToken } from '../src/common/google.mjs';

test('Google validator enforces signed issuer/audience/expiry/nonce/verified identity', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(String(url), 'https://www.googleapis.com/oauth2/v3/certs');
    return Response.json({ keys: [jwk] });
  };
  const claims = { iss: 'https://accounts.google.com', aud: 'client', exp: Math.floor(Date.now() / 1000) + 60,
    sub: 'google-alice', nonce: 'nonce', email_verified: true, email: 'alice@example.test', name: 'Alice' };
  const token = (change = {}) => {
    const input = [ { alg: 'RS256', kid: 'fixture-key' }, { ...claims, ...change } ].map(o => Buffer.from(JSON.stringify(o)).toString('base64url')).join('.');
    return input + '.' + sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  };
  try {
    assert.equal((await verifyGoogleIdToken(token(), { clientId: 'client', nonce: 'nonce' })).googleSub, 'google-alice');
    for (const change of [{ iss: 'https://evil.test' }, { aud: 'other' }, { exp: 1 }, { exp: undefined }, { exp: '9999999999' }, { nonce: 'wrong' }, { email_verified: false }, { sub: '' }])
      await assert.rejects(verifyGoogleIdToken(token(change), { clientId: 'client', nonce: 'nonce' }), /claims validation/);
    const altered = token().split('.'); altered[1] = Buffer.from(JSON.stringify({ ...claims, sub: 'evil' })).toString('base64url');
    await assert.rejects(verifyGoogleIdToken(altered.join('.'), { clientId: 'client', nonce: 'nonce' }), /signature/);
  } finally { globalThis.fetch = original; }
});
