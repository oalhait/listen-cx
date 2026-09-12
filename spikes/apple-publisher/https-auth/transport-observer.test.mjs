import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransportObserver } from './transport-observer.mjs';

const target = 'https://api.music.apple.com/v1/me/library/playlists/p.fresh/tracks';

function setup(response = new Response(null, { status: 204 })) {
  const calls = [];
  const result = Promise.resolve(response);
  const original = function (...args) { calls.push({ receiver: this, args }); return result; };
  const host = { fetch: original };
  const observer = createTransportObserver(host);
  return { host, observer, calls, result, original };
}

test('observes one exact PUT without changing its receiver, arguments, or returned promise', async () => {
  const x = setup();
  x.observer.begin({ method: 'PUT', path: '/v1/me/library/playlists/p.fresh/tracks' });
  const init = { method: 'PUT', headers: { Authorization: 'Bearer private', 'Music-User-Token': 'private' }, body: '{"private":"body"}' };
  const receiver = {};
  assert.equal(x.host.fetch.call(receiver, target, init), x.result);
  assert.equal(x.calls[0].receiver, receiver);
  assert.equal(x.calls[0].args[1], init);
  assert.deepEqual(await x.observer.finish(), { method: 'PUT', path: '/v1/me/library/playlists/p.fresh/tracks', issued: true, responseExposed: true, httpStatus: 204, appleErrorCode: null });
  assert.equal(JSON.stringify(await x.observer.finish()).includes('private'), false);
  x.observer.dispose();
  assert.equal(x.host.fetch, x.original);
});

test('ignores other requests and reports a rejected exact transport without leaking the error', async () => {
  const secret = new Error('private transport detail');
  const original = function () { return Promise.reject(secret); };
  const host = { fetch: original };
  const observer = createTransportObserver(host);
  observer.begin({ method: 'PUT', path: '/v1/me/library/playlists/p.fresh/tracks' });
  void host.fetch('https://api.music.apple.com/v1/me/storefront').catch(() => {});
  void host.fetch(target, { method: 'PUT' }).catch(() => {});
  assert.deepEqual(await observer.finish(), { method: 'PUT', path: '/v1/me/library/playlists/p.fresh/tracks', issued: true, responseExposed: false, httpStatus: null, appleErrorCode: null });
  observer.dispose();
});

test('captures only allowlisted Apple error codes from a bounded response copy', async () => {
  for (const [body, expected] of [
    ['{"errors":[{"code":"40007","detail":"private"}]}', '40007'],
    ['{"errors":[{"code":"private-code","detail":"private"}]}', null],
    ['x'.repeat(5000), null],
  ]) {
    const x = setup(new Response(body, { status: 400 }));
    x.observer.begin({ method: 'PUT', path: '/v1/me/library/playlists/p.fresh/tracks' });
    x.host.fetch(new Request(target, { method: 'PUT' }));
    assert.deepEqual(await x.observer.finish(), { method: 'PUT', path: '/v1/me/library/playlists/p.fresh/tracks', issued: true, responseExposed: true, httpStatus: 400, appleErrorCode: expected });
    assert.equal((await x.result).bodyUsed, false);
    x.observer.dispose();
  }
});

test('preserves synchronous fetch failures and cannot overwrite a later fetch replacement', () => {
  const failure = new Error('private failure');
  const original = () => { throw failure; };
  const host = { fetch: original };
  const observer = createTransportObserver(host);
  observer.begin({ method: 'PUT', path: '/v1/me/library/playlists/p.fresh/tracks' });
  assert.throws(() => host.fetch(target, { method: 'PUT' }), failure);
  const replacement = () => {};
  host.fetch = replacement;
  observer.dispose();
  assert.equal(host.fetch, replacement);
});

test('does not let a late response contaminate a later observation', async () => {
  let resolveFirst;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  let call = 0;
  const host = { fetch() { call += 1; return call === 1 ? first : Promise.resolve(new Response(null, { status: 204 })); } };
  const observer = createTransportObserver(host);
  observer.begin({ method: 'PUT', path: '/v1/me/library/playlists/p.first/tracks' });
  host.fetch('https://api.music.apple.com/v1/me/library/playlists/p.first/tracks', { method: 'PUT' });
  assert.deepEqual(await observer.finish(1), { method: 'PUT', path: '/v1/me/library/playlists/p.first/tracks', issued: true, responseExposed: false, httpStatus: null, appleErrorCode: null });
  observer.begin({ method: 'PUT', path: '/v1/me/library/playlists/p.second/tracks' });
  host.fetch('https://api.music.apple.com/v1/me/library/playlists/p.second/tracks', { method: 'PUT' });
  resolveFirst(new Response('{"errors":[{"code":"40300"}]}', { status: 403 }));
  assert.deepEqual(await observer.finish(), { method: 'PUT', path: '/v1/me/library/playlists/p.second/tracks', issued: true, responseExposed: true, httpStatus: 204, appleErrorCode: null });
  observer.dispose();
});
