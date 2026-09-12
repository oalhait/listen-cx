import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createThreadSource, publicationSnapshot } from './thread-source.mjs';

const capability = 'T'.repeat(22);
const options = { capability, publicationKey: 'disposable-thread-publisher-01', provider: 'apple' };
const song = (id, catalogId, provider = 'apple', verified = true) => ({
  id, title: 'Song', artist: 'Artist', linkSlug: 'shortid', artworkUrl: null,
  source: { provider, id: catalogId, storefront: 'us', verified },
});
const view = (contributions = [song(1, '123'), song(2, '456')], revision = 2) => ({
  publicCapability: capability, title: 'Road trip', revision, closedAt: null,
  contributions, publications: [],
});
const identity = id => ({ status: 'verified', id, storefront: 'us' });
const respond = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('preserves contribution order and repeated catalog songs without exporting the Thread capability', () => {
  const result = publicationSnapshot(view([song(8, '123'), song(2, '456'), song(9, '123')], 7), options);
  assert.deepEqual(result, {
    publicationKey: options.publicationKey, revision: 7, title: 'Road trip',
    entries: [
      { contributionId: 8, identity: identity('123') },
      { contributionId: 2, identity: identity('456') },
      { contributionId: 9, identity: identity('123') },
    ],
  });
  assert.equal(JSON.stringify(result).includes(capability), false);
});

test('keeps cross-provider and unverified identities unresolved', () => {
  const result = publicationSnapshot(view([
    song(1, '123'), song(2, '4SN5Kkig8iJ8vdwsOoP7IO', 'spotify'), song(3, '789', 'apple', false),
  ]), options);
  assert.deepEqual(result.entries.map(entry => entry.identity), [
    identity('123'),
    { status: 'unresolved', reason: 'cross_provider_identity_unresolved' },
    { status: 'unresolved', reason: 'legacy_source_not_verified' },
  ]);
  const spotify = publicationSnapshot(view([song(1, '4SN5Kkig8iJ8vdwsOoP7IO', 'spotify')]), { ...options, provider: 'spotify' });
  assert.deepEqual(spotify.entries[0].identity, identity('4SN5Kkig8iJ8vdwsOoP7IO'));
});

test('emits empty and closed Thread snapshots with their current revision', () => {
  assert.deepEqual(publicationSnapshot(view([], 0), options).entries, []);
  const closed = { ...view([], 4), closedAt: '2026-09-12 20:00:00' };
  assert.equal(publicationSnapshot(closed, options).revision, 4);
});

test('rejects malformed identities, duplicate contribution IDs, and responses for another Thread', () => {
  const malformed = [
    null,
    { ...view(), publicCapability: 'differentCAPABILITY1234' },
    { ...view(), revision: -1 },
    { ...view(), revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...view(), title: 'x'.repeat(81) },
    view([song(1, '123'), song(1, '456')]),
    view([song(0, '123')]),
    view([song(1, '../other')]),
    view([song(1, '123', 'unknown')]),
    view([{ ...song(1, '123'), source: { provider: 'apple', id: '123', storefront: 'us' } }]),
    view(Array.from({ length: 51 }, (_, index) => song(index + 1, '123'))),
  ];
  for (const value of malformed) {
    assert.throws(() => publicationSnapshot(value, options), { code: 'invalid_thread_snapshot' });
  }
});

test('requires an independent publication key and a fixed HTTPS or loopback source origin', () => {
  for (const publicationKey of [capability, `prefix-${capability}`, '', 'with spaces']) {
    assert.throws(() => publicationSnapshot(view(), { ...options, publicationKey }), { code: 'invalid_source_configuration' });
  }
  for (const baseUrl of ['http://example.com', 'https://name:password@example.com', 'https://example.com/path', 'https://example.com/?token=secret', 'https://example.com/#fragment']) {
    assert.throws(() => createThreadSource({ ...options, baseUrl }), { code: 'invalid_source_configuration' });
  }
});

test('reads the configured Thread over HTTP and follows fresh additions, removal and ordering', async t => {
  let current = view();
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(current));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const source = createThreadSource({ ...options, baseUrl: `http://127.0.0.1:${server.address().port}` });
  assert.deepEqual((await source.read()).entries.map(entry => entry.identity.id), ['123', '456']);
  current = view([song(1, '123'), song(2, '456'), song(3, '789')], 3);
  assert.equal((await source.read()).revision, 3);
  current = view([song(3, '789'), song(1, '123')], 5);
  assert.deepEqual((await source.read()).entries.map(entry => entry.identity.id), ['789', '123']);
  assert.deepEqual(requests, Array.from({ length: 3 }, () => ({ method: 'GET', path: `/api/threads/${capability}`, authorization: undefined })));
});

test('refuses redirects, errors, oversized responses and invalid JSON without leaking the capability', async () => {
  for (const response of [
    new Response('', { status: 302, headers: { Location: 'https://elsewhere.example/' } }),
    new Response('private details', { status: 500 }),
    new Response('{invalid'),
    new Response('x'.repeat(131073)),
    new Response('{}', { headers: { 'Content-Length': '131073' } }),
  ]) {
    const source = createThreadSource({ ...options, baseUrl: 'https://threads.example', fetchImpl: async () => response });
    await assert.rejects(source.read(), error => {
      assert.equal(error.message.includes(capability), false);
      assert.equal(error.message.includes('private details'), false);
      return true;
    });
  }
  let seen;
  const source = createThreadSource({ ...options, baseUrl: 'https://threads.example', fetchImpl: async (url, init) => { seen = { url, init }; return respond(view()); } });
  await source.read();
  assert.equal(seen.init.redirect, 'error');
  assert.equal(seen.init.cache, 'no-store');
  assert.equal(seen.init.signal instanceof AbortSignal, true);
});

test('redacts transport errors that contain the configured private capability', async () => {
  const source = createThreadSource({ ...options, baseUrl: 'https://threads.example', fetchImpl: async () => { throw new Error(`Failed /api/threads/${capability}`); } });
  await assert.rejects(source.read(), error => error.code === 'thread_source_unavailable' && !error.message.includes(capability));
});
