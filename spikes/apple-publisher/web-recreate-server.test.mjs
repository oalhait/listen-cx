import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { get } from 'node:http';
import { createWebServer } from './web-recreate-server.mjs';

async function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'apple-web-test-'));
  const options = { journalFile: join(directory, 'journal.json'), developerToken: () => 'test-developer-token', fixtures: [['A', 'B', 'C'], ['C', 'A', 'D']] };
  const start = async () => {
    const server = createWebServer(options);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    const origin = `http://127.0.0.1:${server.address().port}`;
    return { origin, post: (path, body) => fetch(`${origin}${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) };
  };
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { ...await start(), start, file: options.journalFile };
}

test('persists the creation fence across restart and serializes competing tabs', async t => {
  const session = await setup(t);
  const results = await Promise.all([session.post('/reserve', { revision: 1 }), session.post('/reserve', { revision: 1 })]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  const restarted = await session.start();
  assert.equal((await restarted.post('/reserve', { revision: 1 })).status, 409);
  assert.equal((await restarted.post('/reserve', { revision: 2 })).status, 409);
  assert.equal((await restarted.post('/created', { revision: 1, id: 'p.first' })).status, 200);
  assert.equal((await restarted.post('/reserve', { revision: 2 })).status, 200);
  assert.equal((await restarted.post('/created', { revision: 2, id: 'p.second' })).status, 200);
  assert.equal((await restarted.post('/reserve', { revision: 3 })).status, 409);
  assert.equal(readFileSync(session.file, 'utf8').includes('test-developer-token'), false);
});

test('requires same-origin browser access for the token and refuses foreign mutations', async t => {
  const { origin } = await setup(t);
  const valid = await fetch(`${origin}/developer-token`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get('cache-control'), 'no-store');
  assert.equal(valid.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(`${origin}/developer-token`)).status, 404);
  for (const headers of [{ Origin: 'https://example.com' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await fetch(`${origin}/developer-token`, { headers })).status, 403);
  }
  assert.equal(await new Promise((resolve, reject) => {
    get(`${origin}/developer-token`, { headers: { Host: 'evil.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  }), 403);
  assert.equal((await fetch(`${origin}/reserve`, { method: 'POST', body: '{"revision":1}' })).status, 403);
  assert.equal((await fetch(`${origin}/.local/web-recreate-journal.json`)).status, 404);
});

test('retains safe popup failure diagnostics without credentials or a recreation reservation', async t => {
  const { origin, post } = await setup(t);
  assert.equal((await post('/authorization-diagnostics', { type: 'popup-blocked', isAuthorized: false, remainingSeconds: 890, params: { token: 'secret-value' } })).status, 200);
  assert.equal((await post('/authorization-diagnostics', { type: 'operation-error', reason: 'POPUP_BLOCKED', message: 'secret-value' })).status, 200);
  const events = await (await fetch(`${origin}/authorization-diagnostics`)).json();
  assert.equal(events[0].type, 'popup-blocked');
  assert.equal(events[1].reason, 'POPUP_BLOCKED');
  assert.equal(JSON.stringify(events).includes('secret-value'), false);
  assert.deepEqual((await (await fetch(`${origin}/state`)).json()).revisions, []);
});
