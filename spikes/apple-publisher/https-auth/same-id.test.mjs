import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJournal,
  findPlaylistByName,
  markSubmitted,
  planMutation,
  readFullPlaylist,
  recordPlaylist,
  recordFailure,
  reserveOperation,
  submitOperation,
  verifyOperation,
} from './same-id.mjs';

const tracks = (...ids) => ids.map(id => ({ id: `i.${id}`, type: 'library-songs', attributes: { playParams: { catalogId: id } } }));

test('reads every tracks page and preserves provider order and metadata', async () => {
  const calls = [];
  const result = await readFullPlaylist(async path => {
    calls.push(path);
    if (path.includes('?include=')) return { data: [{ id: 'p.same', attributes: { isPublic: true, hasCatalog: true }, relationships: { catalog: { data: [{ id: 'pl.shared', attributes: { url: 'https://music.apple.com/us/playlist/test/pl.shared' } }] } } }] };
    if (path.includes('offset=2')) return { data: tracks('C', 'D') };
    return { data: tracks('A', 'B'), next: '/v1/me/library/playlists/p.same/tracks?offset=2' };
  }, 'p.same');
  assert.deepEqual(result.entries.map(entry => entry.catalogId), ['A', 'B', 'C', 'D']);
  assert.deepEqual(result.entries.map(entry => entry.libraryId), ['i.A', 'i.B', 'i.C', 'i.D']);
  assert.equal(result.metadata.isPublic, true);
  assert.equal(result.metadata.catalogId, 'pl.shared');
  assert.equal(result.metadata.url, 'https://music.apple.com/us/playlist/test/pl.shared');
  assert.equal(calls.length, 3);
});

test('rejects truncated, foreign and unresolved readback', async () => {
  await assert.rejects(() => readFullPlaylist(async path => path.includes('?include=')
    ? { data: [{ id: 'p.same' }] }
    : { data: tracks('A'), next: '/v1/me/library/playlists/p.other/tracks?offset=1' }, 'p.same'), /Unexpected pagination path/);
  await assert.rejects(() => readFullPlaylist(async path => path.includes('?include=')
    ? { data: [{ id: 'p.same' }] }
    : { data: [{ id: 'i.unknown', type: 'library-songs' }] }, 'p.same'), /catalog identity/);
});

test('plans create, append, same-ID replacement and noop without guessing identities', () => {
  assert.deepEqual(planMutation(null, ['A', 'B', 'C']), { kind: 'create', expectedCatalogIds: [], desiredCatalogIds: ['A', 'B', 'C'], payload: ['A', 'B', 'C'].map(id => ({ id, type: 'songs' })) });
  const current = tracks('A', 'B', 'C', 'D').map(item => ({ catalogId: item.attributes.playParams.catalogId, libraryId: item.id, type: item.type }));
  assert.deepEqual(planMutation(current.slice(0, 3), ['A', 'B', 'C', 'D']), { kind: 'append', expectedCatalogIds: ['A', 'B', 'C'], desiredCatalogIds: ['A', 'B', 'C', 'D'], payload: [{ id: 'D', type: 'songs' }] });
  assert.deepEqual(planMutation(current, ['A', 'C', 'D']), { kind: 'replace', expectedCatalogIds: ['A', 'B', 'C', 'D'], desiredCatalogIds: ['A', 'C', 'D'], payload: [{ id: 'i.A', type: 'library-songs' }, { id: 'i.C', type: 'library-songs' }, { id: 'i.D', type: 'library-songs' }] });
  assert.deepEqual(planMutation([current[0], current[2], current[3]], ['D', 'C', 'A']).payload, [{ id: 'i.D', type: 'library-songs' }, { id: 'i.C', type: 'library-songs' }, { id: 'i.A', type: 'library-songs' }]);
  assert.equal(planMutation(current, ['A', 'B', 'C', 'D']).kind, 'noop');
  assert.throws(() => planMutation(current, ['A', 'missing']), /verified current library item/);
});

test('persists a write fence before submission and verifies only exact same-ID readback', () => {
  let journal = createJournal('session-1');
  const plan = planMutation(null, ['A', 'B', 'C']);
  journal = reserveOperation(journal, 'create', plan);
  assert.equal(journal.operations[0].status, 'reserved');
  assert.throws(() => reserveOperation(journal, 'create', plan), /already reserved/);
  journal = markSubmitted(journal, 'create');
  assert.equal(journal.operations[0].status, 'submitted');
  assert.throws(() => reserveOperation(journal, 'append', planMutation([], ['D'])), /not verified/);
  journal = recordPlaylist(journal, 'create', 'p.same');
  assert.throws(() => verifyOperation(journal, 'create', { id: 'p.other', entries: tracks('A', 'B', 'C') }), /same playlist/);
  assert.throws(() => verifyOperation(journal, 'create', { id: 'p.same', entries: tracks('C', 'B', 'A').map(item => ({ catalogId: item.attributes.playParams.catalogId })) }), /exact desired order/);
  journal = verifyOperation(journal, 'create', { id: 'p.same', entries: tracks('A', 'B', 'C').map(item => ({ catalogId: item.attributes.playParams.catalogId })), metadata: { isPublic: false } });
  assert.equal(journal.operations[0].status, 'verified');
  assert.equal(journal.playlist.id, 'p.same');
  assert.equal(JSON.stringify(journal).includes('token'), false);
});

test('requires sequential named transitions and fences submitted append retries', () => {
  let journal = createJournal('session-2');
  journal = reserveOperation(journal, 'create', planMutation(null, ['A']));
  journal = markSubmitted(journal, 'create');
  journal = recordPlaylist(journal, 'create', 'p.same');
  journal = verifyOperation(journal, 'create', { id: 'p.same', entries: [{ catalogId: 'A' }] });
  const append = planMutation([{ catalogId: 'A', libraryId: 'i.A', type: 'library-songs' }], ['A', 'D']);
  journal = reserveOperation(journal, 'append', append);
  journal = markSubmitted(journal, 'append');
  assert.throws(() => reserveOperation(journal, 'append', append), /already reserved/);
  assert.throws(() => verifyOperation(journal, 'append', { id: 'p.same', entries: [{ catalogId: 'A' }] }), /exact desired order/);
  journal = verifyOperation(journal, 'append', { id: 'p.same', entries: [{ catalogId: 'A' }, { catalogId: 'D' }] });
  assert.equal(journal.operations.at(-1).status, 'verified');
});

test('persists reservation and submission before every provider write', async () => {
  const saved = [];
  const calls = [];
  const create = planMutation(null, ['A', 'B', 'C']);
  let journal = await submitOperation(createJournal('session-3'), 'create', create, async (...args) => {
    calls.push(args);
    assert.equal(saved.at(-1).operations.at(-1).status, 'submitted');
    return { data: [{ id: 'p.same' }] };
  }, state => saved.push(structuredClone(state)), { name: 'DISPOSABLE test', description: 'bounded test', isPublic: true });
  assert.deepEqual(saved.map(state => state.operations[0].status), ['reserved', 'submitted', 'submitted']);
  assert.equal(journal.playlist.id, 'p.same');
  assert.equal(calls[0][0], '/v1/me/library/playlists');
  assert.equal(calls[0][1].method, 'POST');
  journal = verifyOperation(journal, 'create', { id: 'p.same', entries: ['A', 'B', 'C'].map(catalogId => ({ catalogId })) });
  const append = planMutation(tracks('A', 'B', 'C').map(item => ({ catalogId: item.attributes.playParams.catalogId, libraryId: item.id, type: item.type })), ['A', 'B', 'C', 'D']);
  saved.length = 0;
  await submitOperation(journal, 'append', append, async (...args) => {
    calls.push(args);
    assert.equal(saved.at(-1).operations.at(-1).status, 'submitted');
  }, state => saved.push(structuredClone(state)));
  assert.equal(calls[1][0], '/v1/me/library/playlists/p.same/tracks');
  assert.equal(calls[1][1].method, 'POST');
  assert.deepEqual(calls[1][1].body, { data: [{ id: 'D', type: 'songs' }] });
});

test('resumes an exact durable reservation without creating a second write fence', async () => {
  const plan = planMutation(null, ['A']);
  const reserved = reserveOperation(createJournal('session-resume'), 'create', plan);
  const saved = [];
  let calls = 0;
  const result = await submitOperation(reserved, 'create', plan, async () => {
    calls += 1;
    return { data: [{ id: 'p.same' }] };
  }, state => saved.push(structuredClone(state)), { name: 'DISPOSABLE test' });
  assert.equal(calls, 1);
  assert.deepEqual(saved.map(state => state.operations[0].status), ['submitted', 'submitted']);
  assert.equal(result.playlist.id, 'p.same');
  await assert.rejects(() => submitOperation(reserved, 'create', planMutation(null, ['B']), async () => { calls += 1; }, () => {}), /different or submitted state/);
  assert.equal(calls, 1);
});

test('leaves failed writes submitted and never calls the provider if durable save fails', async () => {
  const plan = planMutation(null, ['A']);
  const saved = [];
  await assert.rejects(() => submitOperation(createJournal('session-4'), 'create', plan, async () => { throw new Error('network uncertain'); }, state => saved.push(structuredClone(state)), { name: 'test' }), /network uncertain/);
  assert.equal(saved.at(-1).operations[0].status, 'submitted');
  let called = false;
  await assert.rejects(() => submitOperation(createJournal('session-5'), 'create', plan, async () => { called = true; }, () => { throw new Error('storage failed'); }, { name: 'test' }), /storage failed/);
  assert.equal(called, false);
});

test('recovers a uniquely named uncertain creation through paginated read-only listing', async () => {
  const paths = [];
  const found = await findPlaylistByName(async path => {
    paths.push(path);
    return path.includes('offset=2') ? { data: [{ id: 'p.same', attributes: { name: 'DISPOSABLE proof' } }] } : { data: [{ id: 'p.other', attributes: { name: 'Other' } }], next: '/v1/me/library/playlists?offset=2' };
  }, 'DISPOSABLE proof');
  assert.equal(found, 'p.same');
  assert.equal(paths.length, 2);
  await assert.rejects(() => findPlaylistByName(async () => ({ data: [{ id: 'p.one', attributes: { name: 'same' } }, { id: 'p.two', attributes: { name: 'same' } }] }), 'same'), /Multiple playlists/);
});

test('records only bounded provider failure evidence while preserving the retry fence', () => {
  let journal = reserveOperation(createJournal('session-6'), 'create', planMutation(null, ['A']));
  journal = markSubmitted(journal, 'create');
  journal = recordFailure(journal, 'create', { reason: 'PROVIDER_ERROR', httpStatus: 405, message: 'private response', token: 'private token' });
  assert.deepEqual(journal.operations[0].failure, { reason: 'PROVIDER_ERROR', httpStatus: 405 });
  assert.equal(journal.operations[0].status, 'submitted');
  assert.equal(JSON.stringify(journal).includes('private'), false);
});
