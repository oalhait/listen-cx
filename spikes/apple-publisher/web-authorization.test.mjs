import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizationError, appleCallback, authorizeSubscriber, tokenLifetime, authorizationDiagnostic } from './web-authorization.mjs';

test('reports only allowlisted error fields and never copies credentials or arbitrary messages', () => {
  const secret = 'private-token-value';
  assert.deepEqual(authorizationError({ reason: 'AUTHORIZATION_ERROR', message: secret, data: { status: 403, token: secret } }), { reason: 'AUTHORIZATION_ERROR', httpStatus: 403 });
  assert.equal(JSON.stringify(authorizationError({ reason: secret, code: secret, message: secret })).includes(secret), false);
});

test('observes Apple callback methods without reading authorization parameters', () => {
  const data = { jsonrpc: '2.0', method: 'authorize', get params() { throw new Error('Must not read tokens'); } };
  assert.deepEqual(appleCallback({ origin: 'https://authorize.music.apple.com', data }), { method: 'authorize' });
  assert.equal(appleCallback({ origin: 'https://evil.example', data }), null);
  assert.equal(appleCallback({ origin: 'https://authorize.music.apple.com', data: { method: 'secret-token' } }), null);
});

test('does not claim success when the SDK resolves without authorization', async () => {
  await assert.rejects(authorizeSubscriber({ authorize: async () => undefined, isAuthorized: false }), /AUTHORIZATION_INCOMPLETE/);
});

test('does not return the subscriber token after successful authorization', async () => {
  assert.equal(await authorizeSubscriber({ authorize: async () => 'secret-user-token', isAuthorized: true }), undefined);
});

test('reports a blocked popup instead of waiting forever on the SDK promise', { timeout: 100 }, async () => {
  const originalOpen = () => null;
  const popupHost = { open: originalOpen };
  const events = [];
  await assert.rejects(authorizeSubscriber({ authorize() { popupHost.open('https://authorize.music.apple.com'); return new Promise(() => {}); }, isAuthorized: false }, popupHost, event => events.push(event)), /POPUP_BLOCKED/);
  assert.equal(popupHost.open, originalOpen);
  assert.deepEqual(events, [{ type: 'popup-blocked' }]);
});

test('preserves popup arguments and restores the browser method before awaiting consent', async () => {
  const args = [];
  const popupHost = { open(...values) { args.push(values); return {}; } };
  const originalOpen = popupHost.open;
  const music = { isAuthorized: false, authorize() { popupHost.open('https://authorize.music.apple.com', 'apple-music-service-view', 'width=650'); return Promise.resolve().then(() => { assert.equal(popupHost.open, originalOpen); music.isAuthorized = true; }); } };
  await authorizeSubscriber(music, popupHost);
  assert.deepEqual(args, [['https://authorize.music.apple.com', 'apple-music-service-view', 'width=650']]);
});

test('exposes lifetime only and refuses an expired developer token before opening consent', () => {
  assert.deepEqual(tokenLifetime({ issuedAt: 1000, expiresAt: 1900 }, 1500), { ageSeconds: 500, remainingSeconds: 400, ready: true });
  assert.equal(tokenLifetime({ issuedAt: 1000, expiresAt: 1900 }, 1901).ready, false);
});

test('persists only bounded diagnostic fields even when a caller submits secrets', () => {
  const result = authorizationDiagnostic({ type: 'operation-error', reason: 'AUTHORIZATION_ERROR', httpStatus: 403, isAuthorized: false, remainingSeconds: 700, message: 'secret-value', token: 'secret-value', at: 'secret-value' });
  assert.deepEqual(result, { type: 'operation-error', reason: 'AUTHORIZATION_ERROR', httpStatus: 403, isAuthorized: false, remainingSeconds: 700 });
  assert.deepEqual(authorizationDiagnostic({ type: 'secret-value', reason: 'secret-value', method: 'secret-value', remainingSeconds: 'secret-value' }), { type: 'unknown' });
});
