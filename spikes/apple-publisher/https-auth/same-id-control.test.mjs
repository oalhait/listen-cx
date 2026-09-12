import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('runs the four separately initiated mutations on one ID with submitted state persisted first', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'apple-same-id-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of ['same-id-control.mjs', 'same-id.mjs']) await copyFile(new URL(file, import.meta.url), join(directory, file));
  await copyFile(new URL('../web-authorization.mjs', import.meta.url), join(directory, 'web-authorization.mjs'));
  const previous = Object.fromEntries(['window', 'document', 'fetch', 'localStorage', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const elements = Object.fromEntries(['authorize', 'create', 'append', 'remove', 'reorder', 'reconcile', 'read', 'status', 'state'].map(id => [id, { disabled: true, textContent: '', onclick: null }]));
  const listeners = {};
  const storage = new Map();
  const writes = [];
  let providerTracks = [];
  let authorized = false;
  let librarySequence = 0;
  const fixtures = ['704790294', '6782695839', '617154366', '202272624'];
  const journalEntry = () => [...storage.entries()].find(([key]) => key.startsWith('listen-cx-apple-same-id-journal-'));
  const journal = () => JSON.parse(journalEntry()[1]);
  const music = {
    get isAuthorized() { return authorized; },
    addEventListener() {},
    async authorize() { authorized = true; },
    api: { async music(path, _query, { fetchOptions }) {
      const method = fetchOptions.method;
      if (path === '/v1/me/storefront') return { data: { data: [{ id: 'us' }] } };
      if (path.startsWith('/v1/catalog/us/songs')) return { data: { data: fixtures.map(id => ({ id, attributes: { playParams: { id } } })) } };
      if (path === '/v1/me/library/playlists' && method === 'POST') {
        assert.equal(journal().operations.at(-1).status, 'submitted');
        const body = JSON.parse(fetchOptions.body);
        providerTracks = body.relationships.tracks.data.map(item => ({ catalogId: item.id, libraryId: `i.${++librarySequence}`, type: 'library-songs' }));
        writes.push({ method, path, body });
        return { data: { data: [{ id: 'p.same' }] } };
      }
      if (path === '/v1/me/library/playlists/p.same/tracks' && ['POST', 'PUT'].includes(method)) {
        assert.equal(journal().operations.at(-1).status, 'submitted');
        const body = JSON.parse(fetchOptions.body);
        if (method === 'POST') providerTracks.push(...body.data.map(item => ({ catalogId: item.id, libraryId: `i.${++librarySequence}`, type: 'library-songs' })));
        else providerTracks = body.data.map(item => providerTracks.find(track => track.libraryId === item.id));
        writes.push({ method, path, body });
        return undefined;
      }
      if (path.startsWith('/v1/me/library/playlists/p.same?')) return { data: { data: [{ id: 'p.same', attributes: { isPublic: false, hasCatalog: false } }] } };
      if (path.startsWith('/v1/me/library/playlists/p.same/tracks?')) return { data: { data: providerTracks.map(track => ({ id: track.libraryId, type: track.type, attributes: { playParams: { catalogId: track.catalogId } } })) } };
      throw new Error(`Unexpected request ${method} ${path}`);
    } },
  };
  const host = {
    location: { hash: '#invite=private-invitation' },
    history: { replaceState(_state, _title, path) { assert.equal(path, '/same-id'); host.location.hash = ''; } },
    MusicKit: { async configure(config) { assert.equal(config.developerToken, 'private-developer-token'); }, getInstance() { return music; } },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: host });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: {
    querySelector(selector) { return elements[selector.slice(1)]; },
    addEventListener(name, listener) { listeners[name] = listener; },
    createElement() { return {}; },
    head: { append(script) { assert.equal(script.src, 'https://js-cdn.music.apple.com/musickit/v3/musickit.js'); } },
  } });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async path => path === '/session' ? { ok: true } : { ok: true, json: async () => ({ developerToken: 'private-developer-token', issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 900 }) } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: { getItem(key) { return storage.get(key) ?? null; }, setItem(key, value) { storage.set(key, value); } } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { locks: { request(_name, _options, callback) { return callback(); } } } });
  try {
    await import(`${pathToFileURL(join(directory, 'same-id-control.mjs')).href}?test=1`);
    await listeners.musickitloaded();
    await elements.authorize.onclick();
    const initial = structuredClone(journal());
    providerTracks = fixtures.slice(0, 3).map(id => ({ catalogId: id, libraryId: `i.${++librarySequence}`, type: 'library-songs' }));
    storage.set(journalEntry()[0], JSON.stringify({ ...initial, playlist: { id: 'p.same', metadata: null }, operations: [{ name: 'create', kind: 'create', expectedCatalogIds: [], desiredCatalogIds: fixtures.slice(0, 3), status: 'verified' }] }));
    await elements.create.onclick();
    assert.equal(writes.length, 0);
    storage.set(journalEntry()[0], JSON.stringify(initial));
    providerTracks = [];
    for (const name of ['create', 'append', 'remove', 'reorder']) await elements[name].onclick();
    assert.deepEqual(providerTracks.map(track => track.catalogId), ['202272624', '617154366', '704790294']);
    assert.deepEqual(writes.map(write => write.method), ['POST', 'POST', 'PUT', 'PUT']);
    assert.equal(new Set(writes.slice(1).map(write => write.path)).size, 1);
    assert.equal(writes.some(write => write.method === 'DELETE'), false);
    assert.deepEqual(journal().operations.map(operation => operation.status), ['verified', 'verified', 'verified', 'verified']);
    assert.equal(elements.state.textContent.includes('private-'), false);
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
