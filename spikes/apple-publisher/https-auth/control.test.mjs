import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('direct control preserves browser opening and verifies authorization before readback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'apple-control-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [source, target] of [['control.mjs', 'control.mjs'], ['message-diagnostic.mjs', 'message-diagnostic.mjs'], ['../web-authorization.mjs', 'web-authorization.mjs']]) await copyFile(new URL(source, import.meta.url), join(directory, target));
  for (const outcome of ['authorized', 'incomplete', 'rejected']) await t.test(outcome, async () => {
    const previous = Object.fromEntries(['window', 'document', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const elements = Object.fromEntries(['#authorize', '#status', '#diagnostics'].map(id => [id, { disabled: true, textContent: '' }]));
    const listeners = {};
    const calls = [];
    const now = Math.floor(Date.now() / 1000);
    let openReads = 0;
    const host = {
      location: { origin: 'https://probe.example', hash: '#invite=private-invitation' },
      navigator: { userActivation: { isActive: true } },
      name: 'private-window-name', isSecureContext: true, opener: null,
      history: { replaceState(_state, _title, path) { assert.equal(path, '/'); host.location.hash = ''; } },
      addEventListener(event, listener) { listeners[event] = listener; },
    };
    host.parent = host;
    Object.defineProperty(host, 'open', { get() { openReads += 1; return () => { calls.push('sdk-popup'); return {}; }; }, set() { throw new Error('Control must not replace window.open'); } });
    const music = {
      isAuthorized: false,
      addEventListener() {},
      async authorize() {
        calls.push('authorize');
        host.open();
        listeners.message({ origin: 'https://idmsa.apple.com', data: JSON.stringify({ jsonrpc: '2.0', method: 'authorize', params: ['private-user-token'] }) });
        if (outcome === 'rejected') throw { reason: 'AUTHORIZATION_ERROR', message: 'private-user-token' };
        music.isAuthorized = outcome === 'authorized';
        return 'private-user-token';
      },
      api: { async music(path) { calls.push(path); return { data: { data: [{ id: 'us' }] } }; } },
    };
    host.MusicKit = { async configure(config) { assert.equal(config.developerToken, 'private-developer-token'); assert.equal(host.location.hash, ''); }, getInstance() { return music; } };
    globalThis.window = host;
    globalThis.document = { querySelector: selector => elements[selector], addEventListener(event, listener) { listeners[event] = listener; }, createElement: () => ({}), head: { append(script) { assert.equal(script.src, 'https://js-cdn.music.apple.com/musickit/v3/musickit.js'); } } };
    globalThis.fetch = async path => {
      calls.push(path);
      return { ok: true, json: async () => ({ developerToken: 'private-developer-token', issuedAt: now, expiresAt: now + 900 }) };
    };
    try {
      await import(`${pathToFileURL(join(directory, 'control.mjs')).href}?outcome=${outcome}`);
      await listeners.musickitloaded();
      assert.equal(elements['#authorize'].disabled, false);
      assert.equal(openReads, 0);
      await elements['#authorize'].onclick();
      assert.equal(openReads, 1);
      assert.deepEqual(calls, ['/session', '/developer-token', 'authorize', 'sdk-popup', ...(outcome === 'authorized' ? ['/v1/me/storefront'] : [])]);
      const diagnostics = JSON.parse(elements['#diagnostics'].textContent);
      assert.equal(diagnostics.mode, 'direct-sdk');
      assert.equal(diagnostics.events.some(event => event.type === 'window-message' && event.payloadType === 'string-json' && event.originCategory === 'other-apple'), true);
      assert.equal(diagnostics.events.some(event => event.type === 'authorization-succeeded'), outcome === 'authorized');
      assert.equal(elements['#diagnostics'].textContent.includes('private-'), false);
    } finally {
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });
});
