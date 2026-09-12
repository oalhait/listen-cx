import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReplacementJournal,
  directFallbackEligible,
  loadReplacementJournal,
  recordCreation,
  recordReplacementEvidence,
  reserveReplacementOperation,
  saveReplacementJournal,
  verifyReplacementOperation,
} from './replacement-proof.mjs';

const initial = ['A', 'B', 'C'];
const desired = ['C', 'A'];
const readback = (ids, metadata = null) => ({ id: 'p.fresh', entries: ids.map((catalogId, index) => ({ catalogId, libraryId: `i.${index}`, type: 'library-songs' })), metadata });

test('uses separate durable journals for SDK and direct disposable destinations', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const sdk = loadReplacementJournal(storage, 'sdk', () => 'sdk-run');
  const direct = loadReplacementJournal(storage, 'direct', () => 'direct-run');
  saveReplacementJournal(storage, sdk);
  saveReplacementJournal(storage, direct);
  assert.equal(loadReplacementJournal(storage, 'sdk', () => 'wrong').sessionID, 'sdk-run');
  assert.equal(loadReplacementJournal(storage, 'direct', () => 'wrong').sessionID, 'direct-run');
  assert.notEqual(sdk.sessionID, direct.sessionID);
});

test('fences creation and replacement before submission and verifies exact same-ID order', () => {
  let journal = createReplacementJournal('sdk', 'run-one');
  journal = reserveReplacementOperation(journal, 'create', initial);
  assert.equal(journal.operations[0].status, 'reserved');
  journal = reserveReplacementOperation(journal, 'create', initial, true);
  assert.equal(journal.operations[0].status, 'submitted');
  journal = recordCreation(journal, 'p.fresh');
  journal = verifyReplacementOperation(journal, 'create', readback(initial, { canEdit: true, isPublic: true, hasCatalog: true }));
  assert.equal(journal.playlist.metadata.canEdit, true);
  journal = reserveReplacementOperation(journal, 'replace', desired);
  journal = reserveReplacementOperation(journal, 'replace', desired, true);
  assert.throws(() => verifyReplacementOperation(journal, 'replace', readback(['A', 'C'])), /exact desired order/);
  journal = verifyReplacementOperation(journal, 'replace', readback(desired));
  assert.equal(journal.operations[1].status, 'verified');
});

test('allows direct fallback only after SDK exposes no response and readback stays unchanged', () => {
  let journal = createReplacementJournal('sdk', 'run-two');
  journal = reserveReplacementOperation(journal, 'create', initial);
  journal = reserveReplacementOperation(journal, 'create', initial, true);
  journal = recordCreation(journal, 'p.fresh');
  journal = verifyReplacementOperation(journal, 'create', readback(initial));
  journal = reserveReplacementOperation(journal, 'replace', desired);
  journal = reserveReplacementOperation(journal, 'replace', desired, true);
  journal = recordReplacementEvidence(journal, { method: 'PUT', path: '/v1/me/library/playlists/p.fresh/tracks', issued: true, responseExposed: false, httpStatus: null, appleErrorCode: null }, readback(initial));
  assert.equal(directFallbackEligible(journal), true);
  assert.equal(directFallbackEligible(recordReplacementEvidence(journal, { method: 'PUT', path: '/v1/me/library/playlists/p.fresh/tracks', issued: true, responseExposed: true, httpStatus: 403, appleErrorCode: '40300' }, readback(initial))), false);
  assert.equal(directFallbackEligible(recordReplacementEvidence(journal, { method: 'PUT', path: '/v1/me/library/playlists/p.fresh/tracks', issued: false, responseExposed: false, httpStatus: null, appleErrorCode: null }, readback(['C', 'A']))), false);
});

test('records only bounded transport evidence and readback identities', () => {
  let journal = createReplacementJournal('sdk', 'run-three');
  journal = reserveReplacementOperation(journal, 'create', initial);
  journal = reserveReplacementOperation(journal, 'create', initial, true);
  journal = recordCreation(journal, 'p.fresh');
  journal = verifyReplacementOperation(journal, 'create', readback(initial));
  journal = reserveReplacementOperation(journal, 'replace', desired);
  journal = reserveReplacementOperation(journal, 'replace', desired, true);
  journal = recordReplacementEvidence(journal, { method: 'PUT', path: '/v1/me/library/playlists/p.fresh/tracks', issued: true, responseExposed: true, httpStatus: 400, appleErrorCode: 'private', token: 'private-token' }, readback(initial));
  assert.deepEqual(journal.operations[1].transport, { method: 'PUT', path: '/v1/me/library/playlists/p.fresh/tracks', issued: true, responseExposed: true, httpStatus: 400, appleErrorCode: null });
  assert.equal(JSON.stringify(journal).includes('private'), false);
});
