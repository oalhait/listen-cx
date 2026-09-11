import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createCredentialObserver } from './credential-pairing.mjs';

const url = 'https://api.music.apple.com/v1/me/storefront';
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(options = {}) {
  const reports = [];
  const listeners = new Set();
  const calls = [];
  const result = Promise.resolve(options.response ?? new Response('{"errors":[{"code":"40300","detail":"private-detail"}]}', { status: 403 }));
  const original = function (...args) { calls.push({ receiver: this, args }); return result; };
  const host = { fetch: original, crypto: options.crypto ?? webcrypto, addEventListener(name, listener, capture) { assert.equal(name, 'message'); assert.equal(capture, true); listeners.add(listener); }, removeEventListener(name, listener) { listeners.delete(listener); } };
  const observer = createCredentialObserver(host, 'private-developer', options.report ?? (event => reports.push(event)));
  const callback = (token = 'private-user') => { for (const listener of listeners) listener({ origin: 'https://authorize.music.apple.com', data: { jsonrpc: '2.0', method: 'authorize', params: [token] } }); };
  const request = (developer = 'private-developer', user = 'private-user') => [url, { headers: { Authorization: `Bearer ${developer}`, 'Music-User-Token': user } }];
  return { host, observer, reports, calls, original, result, callback, request, listeners };
}
async function settle(reports, count) { for (let i = 0; i < 100 && reports.length < count; i += 1) await new Promise(resolve => setTimeout(resolve, 5)); }

test('observes an immediate callback and storefront request without changing fetch arguments or promise', async () => {
  const x = setup();
  x.observer.begin();
  x.callback();
  const args = x.request();
  const receiver = {};
  assert.equal(x.host.fetch.apply(receiver, args), x.result);
  assert.equal(x.calls.length, 1);
  assert.equal(x.calls[0].receiver, receiver);
  assert.equal(x.calls[0].args[1], args[1]);
  x.observer.end();
  await settle(x.reports, 2);
  assert.deepEqual(x.reports.find(e => e.type === 'credential-pairing'), { type: 'credential-pairing', freshCallbackObserved: true, developerTokenMatchesConfigured: true, userTokenMatchesCallback: true });
  assert.deepEqual(x.reports.find(e => e.type === 'storefront-response'), { type: 'storefront-response', httpStatus: 403, appleErrorCode: '40300' });
  assert.equal(JSON.stringify(x.reports).includes('private-'), false);
  assert.equal((await x.result).bodyUsed, false);
  x.observer.dispose();
  assert.equal(x.host.fetch, x.original);
  assert.equal(x.listeners.size, 0);
});

test('reports mismatches and clears callback state for each attempt', async () => {
  const x = setup();
  x.observer.begin(); x.callback(); x.host.fetch(...x.request('different-developer', 'different-user'));
  await settle(x.reports, 2);
  assert.deepEqual(x.reports.find(e => e.type === 'credential-pairing'), { type: 'credential-pairing', freshCallbackObserved: true, developerTokenMatchesConfigured: false, userTokenMatchesCallback: false });
  x.observer.begin(); x.host.fetch(...x.request());
  await settle(x.reports, 4);
  assert.deepEqual(x.reports.filter(e => e.type === 'credential-pairing')[1], { type: 'credential-pairing', freshCallbackObserved: false, developerTokenMatchesConfigured: true, userTokenMatchesCallback: false });
  x.observer.dispose();
});

test('ignores untrusted callbacks, other endpoints, non-GET requests and subsequent storefront requests', async () => {
  const x = setup();
  x.host.fetch(...x.request());
  x.observer.begin();
  for (const listener of x.listeners) listener({ origin: 'https://example.com', get data() { throw new Error('Must not inspect'); } });
  x.host.fetch('https://api.music.apple.com/v1/me/library/playlists');
  x.host.fetch(url, { method: 'POST' });
  x.callback(); x.host.fetch(...x.request()); x.host.fetch(...x.request());
  await settle(x.reports, 2); await tick();
  assert.equal(x.reports.length, 2);
  x.observer.dispose();
});

test('observer failures never change transport results or overwrite a later fetch replacement', async () => {
  for (const options of [{ crypto: { subtle: { digest() { return Promise.reject(new Error('private-failure')); } } } }, { report() { throw new Error('private-failure'); } }]) {
    const x = setup(options); x.observer.begin(); x.callback();
    assert.equal(x.host.fetch(...x.request()), x.result);
    await new Promise(resolve => setTimeout(resolve, 30));
    const replacement = () => {};
    x.host.fetch = replacement; x.observer.dispose();
    assert.equal(x.host.fetch, replacement);
  }
});

test('bounds response classification and never exposes unknown error details', async () => {
  for (const body of ['x'.repeat(5000), '{"errors":[{"code":"private-code","detail":"private-detail"}]}']) {
    const x = setup({ response: new Response(body, { status: 403 }) });
    x.observer.begin(); x.callback(); x.host.fetch(...x.request());
    await settle(x.reports, 2);
    assert.deepEqual(x.reports.find(e => e.type === 'storefront-response'), { type: 'storefront-response', httpStatus: 403, appleErrorCode: null });
    assert.equal((await x.result).bodyUsed, false);
    x.observer.dispose();
  }
});

test('observes Request inputs and stops waiting for an unfinished response copy', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }), { status: 403 });
  const x = setup({ response });
  x.observer.begin(); x.callback();
  const request = new Request(...x.request());
  assert.equal(x.host.fetch(request), x.result);
  const started = Date.now();
  while (!x.reports.some(e => e.type === 'storefront-response') && Date.now() - started < 3000) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(x.reports.find(e => e.type === 'storefront-response'), { type: 'storefront-response', httpStatus: 403, appleErrorCode: null });
  assert.equal(response.bodyUsed, false);
  x.observer.dispose();
});
