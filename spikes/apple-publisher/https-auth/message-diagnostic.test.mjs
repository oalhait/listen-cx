import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageDiagnostic } from './message-diagnostic.mjs';

const site = 'https://probe.example';
const apple = 'https://authorize.music.apple.com';

test('distinguishes object callbacks from string callbacks without exposing parameters', () => {
  const data = { jsonrpc: '2.0', method: 'authorize', get params() { throw new Error('Must not read credentials'); } };
  assert.deepEqual(messageDiagnostic({ origin: apple, data }, site), { originCategory: 'expected-apple', payloadType: 'object', jsonrpc: true, method: 'authorize', recognizedSdkCallback: true });
  assert.deepEqual(messageDiagnostic({ origin: apple, data: JSON.stringify({ jsonrpc: '2.0', method: 'authorize', params: ['secret-user-token'] }) }, site), { originCategory: 'expected-apple', payloadType: 'string-json', jsonrpc: true, method: 'authorize', recognizedSdkCallback: false });
});

test('classifies alternate message origins without copying arbitrary hosts', () => {
  for (const [origin, category] of [[site, 'same-site'], ['https://idmsa.apple.com', 'other-apple'], ['https://apple.com', 'other-apple'], ['https://authorize.music.apple.com.evil.example', 'other'], ['http://authorize.music.apple.com', 'other'], ['null', 'opaque'], ['secret-value', 'other']]) {
    const result = messageDiagnostic({ origin, data: { jsonrpc: '2.0', method: 'authorize' } }, site);
    assert.equal(result.originCategory, category);
    assert.equal(result.recognizedSdkCallback, false);
    assert.equal(JSON.stringify(result).includes(origin), false);
  }
});

test('bounds string parsing and reports only allowlisted message metadata', () => {
  for (const data of ['secret-user-token', JSON.stringify({ jsonrpc: 'secret-user-token', method: 'secret-user-token', params: ['secret-user-token'] }), null, ['secret-user-token'], 42, 'secret-user-token'.repeat(10000)]) {
    const result = messageDiagnostic({ origin: apple, data }, site);
    assert.equal(JSON.stringify(result).includes('secret-user-token'), false);
    assert.equal(result.recognizedSdkCallback, false);
  }
  assert.equal(messageDiagnostic({ origin: apple, data: 'x'.repeat(65537) }, site).payloadType, 'oversized-string');
});
