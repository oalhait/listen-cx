import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { once } from 'node:events';
import { get } from 'node:http';
import { createDeveloperToken, createTokenServer } from './token-helper.mjs';

test('signs a fifteen-minute Apple developer token without exposing the key', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const token = createDeveloperToken({ keyID: 'KEY', teamID: 'TEAM', privateKey, now: 1000 });
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'KEY' });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iss: 'TEAM', iat: 1000, exp: 1900 });
  assert.equal(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
});

test('serves only native loopback GET requests and refuses expired tokens', async t => {
  let now = 1000;
  const server = createTokenServer({ token: 'disposable-test-token', expiresAt: 1900, now: () => now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/developer-token`;
  const good = await fetch(url);
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('cache-control'), 'no-store');
  assert.equal(good.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await good.json(), { developerToken: 'disposable-test-token', expiresAt: 1900 });
  for (const headers of [{ Origin: 'https://example.com' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await fetch(url, { headers })).status, 403);
  }
  assert.equal(await new Promise((resolve, reject) => {
    get(url, { headers: { Host: 'evil.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  }), 403);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${url}/other`)).status, 404);
  now = 1900;
  const expired = await fetch(url);
  assert.equal(expired.status, 503);
  assert.equal((await expired.text()).includes('disposable-test-token'), false);
});
