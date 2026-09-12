import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReplacementJournal, directFallbackEligible, recordCreation, recordReplacementEvidence, reserveReplacementOperation, saveReplacementJournal, verifyReplacementOperation } from './replacement-proof.mjs';

const fixtures = ['704790294', '6782695839', '617154366'];
const desired = [fixtures[2], fixtures[0]];

async function runControl(mode, { seedStorage, transport = 'success', initiallyAuthorized = false, readbackFailureAfterPut = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), `apple-replacement-${mode}-`));
  for (const file of ['replacement-control.mjs', 'replacement-proof.mjs', 'transport-observer.mjs', 'same-id.mjs']) await copyFile(new URL(file, import.meta.url), join(directory, file));
  await copyFile(new URL('../web-authorization.mjs', import.meta.url), join(directory, 'web-authorization.mjs'));
  const previous = Object.fromEntries(['window', 'document', 'fetch', 'localStorage', 'navigator', 'location', 'setTimeout'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const realSetTimeout = globalThis.setTimeout;
  const elements = Object.fromEntries(['authorize', 'run', 'create', 'replace', 'read', 'status', 'state'].map(id => [id, { disabled: true, textContent: '', onclick: null }]));
  const listeners = {};
  const storage = new Map(seedStorage ?? []);
  const writes = [];
  let providerTracks = [];
  let playlistCounter = 0;
  let librarySequence = 0;
  let authorized = initiallyAuthorized;
  let authorizationCalls = 0;
  let replacementAttempted = false;
  const playlistId = () => mode === 'sdk' ? 'p.sdkfresh' : 'p.directfresh';
  const journal = () => JSON.parse([...storage.entries()].find(([key]) => key.includes(`replacement-${mode}-journal-`))[1]);
  const music = {
    get isAuthorized() { return authorized; },
    addEventListener() {},
    async authorize() { authorizationCalls += 1; authorized = true; return 'private-user-token'; },
    api: { async music(path, _query, { fetchOptions = { method: 'GET' } } = {}) {
      const method = fetchOptions.method ?? 'GET';
      if (path === '/v1/me/storefront') return { data: { data: [{ id: 'us' }] } };
      if (path.startsWith('/v1/catalog/us/songs')) return { data: { data: fixtures.map(id => ({ id, attributes: { playParams: { id } } })) } };
      if (path === '/v1/me/library/playlists' && method === 'POST') {
        assert.equal(journal().operations.at(-1).status, 'submitted');
        const body = JSON.parse(fetchOptions.body);
        providerTracks = body.relationships.tracks.data.map(item => ({ catalogId: item.id, libraryId: `i.${++librarySequence}`, type: 'library-songs' }));
        writes.push({ method, path });
        playlistCounter += 1;
        return { data: { data: [{ id: playlistId() }] } };
      }
      if (path === `/v1/me/library/playlists/${playlistId()}/tracks` && method === 'PUT') {
        if (transport === 'beforeFetch') throw new Error('private SDK wrapper failure');
        const response = await globalThis.fetch(`https://api.music.apple.com${path}`, fetchOptions);
        if (!response.ok) throw Object.assign(new Error('SDK request failed'), { data: response });
        return undefined;
      }
      if (path.startsWith(`/v1/me/library/playlists/${playlistId()}?`)) return { data: { data: [{ id: playlistId(), attributes: { canEdit: true, isPublic: true, hasCatalog: true }, relationships: { catalog: { data: [{ id: `pl.${mode}`, attributes: { url: `https://music.apple.com/us/playlist/test/pl.${mode}` } }] } } }] } };
      if (path.startsWith(`/v1/me/library/playlists/${playlistId()}/tracks?`)) {
        if (replacementAttempted && readbackFailureAfterPut) throw new TypeError('private readback failure');
        return { data: { data: providerTracks.map(track => ({ id: track.libraryId, type: track.type, attributes: { playParams: { catalogId: track.catalogId } } })) } };
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    } },
  };
  const host = {
    location: { pathname: `/replacement-${mode}`, hash: '#invite=private-invitation', origin: 'https://listen-cx-apple-auth-spike-dev.omar-alhait.workers.dev' },
    history: { replaceState(_state, _title, path) { host.location.pathname = path; host.location.hash = ''; } },
    MusicKit: { async configure(config) { assert.equal(config.developerToken, 'private-developer-token'); }, getInstance() { return music; } },
    addEventListener(name, listener) { listeners[name] = listener; },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: host });
  Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: host.location });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: {
    querySelector(selector) { return elements[selector.slice(1)]; },
    addEventListener(name, listener) { listeners[name] = listener; },
    createElement() { return {}; },
    head: { append(script) { assert.equal(script.src, 'https://js-cdn.music.apple.com/musickit/v3/musickit.js'); } },
  } });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async (input, init = {}) => {
    if (input === '/session') return { ok: true };
    if (input === '/developer-token') return { ok: true, json: async () => ({ developerToken: 'private-developer-token', issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 900 }) };
    assert.equal(input, `https://api.music.apple.com/v1/me/library/playlists/${playlistId()}/tracks`);
    assert.equal(init.method, 'PUT');
    assert.equal(journal().operations.at(-1).status, 'submitted');
    replacementAttempted = true;
    if (mode === 'direct') {
      assert.equal(init.headers.Authorization, 'Bearer private-developer-token');
      assert.equal(init.headers['Music-User-Token'], 'private-user-token');
    }
    writes.push({ method: 'PUT', path: new URL(input).pathname });
    if (transport === 'reject') throw new TypeError('private transport failure');
    if (transport === 'http403') return new Response('{"errors":[{"code":"40300","detail":"private detail"}]}', { status: 403 });
    const body = JSON.parse(init.body);
    providerTracks = body.data.map(item => providerTracks.find(track => track.libraryId === item.id));
    return new Response(null, { status: 204 });
  } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: { getItem(key) { return storage.get(key) ?? null; }, setItem(key, value) { storage.set(key, value); } } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { locks: { request(_name, _options, callback) { return callback(); } } } });
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, writable: true, value: callback => realSetTimeout(callback, 0) });
  try {
    await import(`${pathToFileURL(join(directory, 'replacement-control.mjs')).href}?test=${mode}`);
    await listeners.musickitloaded();
    await elements.authorize.onclick();
    await elements.run.onclick();
    assert.deepEqual(providerTracks.map(track => track.catalogId), transport === 'success' ? desired : fixtures);
    assert.deepEqual(writes.map(write => write.method), transport === 'beforeFetch' ? ['POST'] : ['POST', 'PUT']);
    assert.equal(playlistCounter, 1);
    assert.equal(journal().operations[1].status, transport === 'success' ? 'verified' : 'submitted');
    assert.equal(journal().playlist.metadata.canEdit, true);
    assert.equal(JSON.stringify(journal()).includes('private-'), false);
    return { storage: [...storage.entries()], journal: journal(), state: elements.state.textContent, authorizationCalls };
  } finally {
    await rm(directory, { recursive: true, force: true });
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test('creates a fresh SDK destination then observes and verifies one combined replacement', async () => {
  const result = await runControl('sdk');
  assert.deepEqual(result.journal.operations[1].transport, { method: 'PUT', path: '/v1/me/library/playlists/p.sdkfresh/tracks', issued: true, responseExposed: true, httpStatus: 204, appleErrorCode: null });
});

test('runs the direct transport only from an eligible failed SDK journal and uses a separate destination', async () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  let sdk = createReplacementJournal('sdk', 'eligible-sdk');
  storage.setItem('listen-cx-apple-replacement-sdk-active-run', sdk.sessionID);
  sdk = reserveReplacementOperation(sdk, 'create', fixtures);
  sdk = reserveReplacementOperation(sdk, 'create', fixtures, true);
  sdk = recordCreation(sdk, 'p.failedsdk');
  const original = { id: 'p.failedsdk', entries: fixtures.map((catalogId, index) => ({ catalogId, libraryId: `old.${index}`, type: 'library-songs' })), metadata: { canEdit: true } };
  sdk = verifyReplacementOperation(sdk, 'create', original);
  sdk = reserveReplacementOperation(sdk, 'replace', desired);
  sdk = reserveReplacementOperation(sdk, 'replace', desired, true);
  sdk = recordReplacementEvidence(sdk, { method: 'PUT', path: '/v1/me/library/playlists/p.failedsdk/tracks', issued: true, responseExposed: false, httpStatus: null, appleErrorCode: null }, original);
  saveReplacementJournal(storage, sdk);
  const result = await runControl('direct', { seedStorage: [...values.entries()], initiallyAuthorized: true });
  assert.equal(result.journal.playlist.id, 'p.directfresh');
  assert.notEqual(result.journal.playlist.id, sdk.playlist.id);
  assert.equal(result.authorizationCalls, 1);
});

test('persists unchanged readback and enables fallback when SDK transport exposes no response', async () => {
  const result = await runControl('sdk', { transport: 'reject' });
  assert.equal(result.journal.operations[1].status, 'submitted');
  assert.deepEqual(result.journal.operations[1].transport, { method: 'PUT', path: '/v1/me/library/playlists/p.sdkfresh/tracks', issued: true, responseExposed: false, httpStatus: null, appleErrorCode: null });
  assert.deepEqual(result.journal.operations[1].readback.catalogIds, fixtures);
  assert.equal(directFallbackEligible(result.journal), true);
});

test('records that the SDK failed before issuing the PUT and still performs exact readback', async () => {
  const result = await runControl('sdk', { transport: 'beforeFetch' });
  assert.equal(result.journal.operations[1].status, 'submitted');
  assert.deepEqual(result.journal.operations[1].transport, { method: 'PUT', path: '/v1/me/library/playlists/p.sdkfresh/tracks', issued: false, responseExposed: false, httpStatus: null, appleErrorCode: null });
  assert.deepEqual(result.journal.operations[1].readback.catalogIds, fixtures);
  assert.equal(directFallbackEligible(result.journal), true);
});

test('persists HTTP rejection and unchanged readback without enabling fallback', async () => {
  const result = await runControl('sdk', { transport: 'http403' });
  assert.equal(result.journal.operations[1].status, 'submitted');
  assert.deepEqual(result.journal.operations[1].transport, { method: 'PUT', path: '/v1/me/library/playlists/p.sdkfresh/tracks', issued: true, responseExposed: true, httpStatus: 403, appleErrorCode: '40300' });
  assert.deepEqual(result.journal.operations[1].readback.catalogIds, fixtures);
  assert.equal(directFallbackEligible(result.journal), false);
});

test('preserves HTTP transport evidence when the mandatory readback itself fails', async () => {
  const result = await runControl('sdk', { transport: 'http403', readbackFailureAfterPut: true });
  assert.equal(result.journal.operations[1].status, 'submitted');
  assert.deepEqual(result.journal.operations[1].transport, { method: 'PUT', path: '/v1/me/library/playlists/p.sdkfresh/tracks', issued: true, responseExposed: true, httpStatus: 403, appleErrorCode: '40300' });
  assert.equal('readback' in result.journal.operations[1], false);
  assert.equal(directFallbackEligible(result.journal), false);
});
