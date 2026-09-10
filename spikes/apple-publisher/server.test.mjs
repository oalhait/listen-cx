import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createRevisionServer } from './server.mjs';

test('serves current desired revision over HTTP without mutation routes or caching', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apple-handoff-'));
  const file = join(dir, 'desired.json');
  const first = { playlistKey: 'spike-test', revision: 1, trackIDs: ['A', 'B', 'C'] };
  await writeFile(file, JSON.stringify(first));
  const server = createRevisionServer(file);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/desired`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), first);
    const next = { ...first, revision: 2, trackIDs: ['C', 'A', 'D'] };
    await writeFile(file, JSON.stringify(next));
    assert.deepEqual(await (await fetch(`${base}/desired`)).json(), next);
    assert.equal((await fetch(`${base}/desired`, { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await fetch(`${base}/anything-else`)).status, 404);
    await writeFile(file, '{broken');
    assert.equal((await fetch(`${base}/desired`)).status, 503);
    await writeFile(file, JSON.stringify({ ...first, revision: 0 }));
    assert.equal((await fetch(`${base}/desired`)).status, 503);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true });
  }
});
