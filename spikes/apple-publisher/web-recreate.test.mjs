import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserveRevision, recordCreation, readPlaylist, createRevision } from './web-recreate.mjs';

const initial = () => ({ runID: 'test', revisions: [] });
test('allows only two ordered revisions and fences uncertain creation', () => {
  let state = reserveRevision(initial(), 1);
  assert.throws(() => reserveRevision(state, 1));
  assert.throws(() => reserveRevision(state, 2));
  state = recordCreation(state, 1, 'p.first');
  state = reserveRevision(state, 2);
  assert.throws(() => recordCreation(state, 2, 'p.first'));
  state = recordCreation(state, 2, 'p.second');
  assert.throws(() => reserveRevision(state, 3));
  assert.throws(() => recordCreation(state, 1, 'p.overwrite'));
});

test('creates a named disposable revision using only documented POST', async () => {
  const calls = [];
  const request = async (...args) => { calls.push(args); return { data: [{ id: 'p.new' }] }; };
  assert.equal(await createRevision(request, 'test', 1, ['A', 'B', 'C']), 'p.new');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/v1/me/library/playlists');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(calls[0][1].body.relationships.tracks.data, ['A', 'B', 'C'].map(id => ({ id, type: 'songs' })));
  assert.match(calls[0][1].body.attributes.name, /DISPOSABLE.*test.*R1/);
});

test('uses actual readback order and keeps unresolved identities explicit', async () => {
  const paths = [];
  const result = await readPlaylist(async path => {
    paths.push(path);
    return path.endsWith('/tracks')
      ? { data: [{ id: 'i.C', attributes: { playParams: { catalogId: 'C' } } }, { id: 'i.unknown' }] }
      : { data: [{ id: 'p.new', attributes: { isPublic: false } }] };
  }, 'p.new', ['A', 'C']);
  assert.deepEqual(result.trackIDs, ['C', null]);
  assert.equal(result.matches, false);
  assert.equal(result.url, null);
  assert.equal(paths.length, 2);
});

test('never reports a truncated or differently ordered playlist as verified', async () => {
  for (const response of [
    { data: [{ attributes: { playParams: { catalogId: 'B' } } }, { attributes: { playParams: { catalogId: 'A' } } }] },
    { data: [{ attributes: { playParams: { catalogId: 'A' } } }], next: '/more' },
  ]) {
    const result = await readPlaylist(async path => path.endsWith('/tracks') ? response : { data: [{ id: 'p.new' }] }, 'p.new', ['A', 'B']);
    assert.equal(result.matches, false);
  }
});

test('verifies exact returned IDs and captures only a provider-returned share URL', async () => {
  const result = await readPlaylist(async path => path.endsWith('/tracks')
    ? { data: ['C', 'A', 'D'].map(id => ({ id: `i.${id}`, attributes: { playParams: { catalogId: id } } })) }
    : { data: [{ id: 'p.new', attributes: { isPublic: true }, relationships: { catalog: { data: [{ id: 'pl.shared', attributes: { url: 'https://music.apple.com/us/playlist/test/pl.shared' } }] } } }] },
  'p.new', ['C', 'A', 'D']);
  assert.equal(result.matches, true);
  assert.equal(result.url, 'https://music.apple.com/us/playlist/test/pl.shared');
  assert.deepEqual(result.catalogIDs, ['pl.shared']);
});
