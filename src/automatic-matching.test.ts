import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { nanoid } from 'nanoid';
import { D1ThreadStore } from './thread-db.js';
import { D1PublicationStore } from './publication-db.js';
import { authorizeManagementCapability } from './thread-security.js';
import { resolveAutomaticMatches } from './automatic-matching.js';

const selected = { provider: 'spotify' as const, id: 'a'.repeat(22), storefront: 'us', title: 'Song', artist: 'Artist', album: null, durationMs: 180000, isrc: 'USABC2600001', explicit: false, playable: true };
const result = { status: 'matched' as const, method: 'isrc' as const, selected, candidates: [selected], reason: 'same_recording' };
async function setup() {
  const threads = new D1ThreadStore(env.DB);
  const key = nanoid(22);
  const view = await threads.create('Matches', key);
  const auth = (await authorizeManagementCapability(threads, view.publicCapability, key))!;
  await threads.manage(auth, { kind: 'connect', provider: 'spotify', expectedRevision: 0, requestKey: 'connect' });
  await threads.add(view.publicCapability, { expectedRevision: 1, requestKey: 'song', source: { provider: 'apple', id: '123', storefront: 'us' }, track: { title: 'Song', artist: 'Artist', isrc: null, artworkUrl: null, complete: false, spotifyUrl: null, appleUrl: 'https://music.apple.com/us/song/123' } });
  const target = (await new D1PublicationStore(env.DB).due(view.publicCapability))[0]!;
  return { threads, auth, target, view: (await threads.get(view.publicCapability))! };
}
function catalog() { return { get: vi.fn(async () => ({ ...selected, provider: 'apple' as const, id: '123' })), findMatch: vi.fn(async () => result) }; }

it('saves automatic evidence separately and reuses the same selection on retries', async () => {
  const { threads, target, view } = await setup();
  const client = catalog();
  const desired = await resolveAutomaticMatches(env.DB, view, target, client, 'us');
  expect(desired.identitiesComplete).toBe(true);
  expect(desired.entries[0]!.identity).toMatchObject({ status: 'matched', id: selected.id, method: 'isrc' });
  expect((await threads.get(view.publicCapability))!.contributions[0]!.counterpart).toBeUndefined();
  await resolveAutomaticMatches(env.DB, view, target, client, 'us');
  expect(client.findMatch).toHaveBeenCalledTimes(1);
  expect((await threads.get(view.publicCapability))!.contributions[0]!.matches).toMatchObject([{ status: 'matched', provider: 'spotify' }]);
});

it('keeps an ambiguous song unresolved and records suggestions without publishing a guess', async () => {
  const { target, view } = await setup();
  const client = { get: catalog().get, findMatch: vi.fn(async () => ({ ...result, status: 'ambiguous' as const, selected: null, reason: 'multiple_recordings' })) };
  const desired = await resolveAutomaticMatches(env.DB, view, target, client, 'us');
  expect(desired.identitiesComplete).toBe(false);
  expect(desired.entries).toHaveLength(1);
});

it('gives a manual correction precedence over a saved automatic match', async () => {
  const { threads, auth, target, view } = await setup();
  const client = catalog();
  await resolveAutomaticMatches(env.DB, view, target, client, 'us');
  await threads.manage(auth, { kind: 'identify', expectedRevision: 2, requestKey: 'correct', id: view.contributions[0]!.id, identity: { provider: 'spotify', id: 'b'.repeat(22), storefront: 'us' } });
  const current = (await threads.get(view.publicCapability))!;
  expect((await resolveAutomaticMatches(env.DB, current, target, client, 'us')).entries[0]!.identity).toMatchObject({ status: 'verified', id: 'b'.repeat(22) });
  expect(client.findMatch).toHaveBeenCalledTimes(1);
});

it('does not turn provider failures into unavailable matches', async () => {
  const { target, view } = await setup();
  const error = { status: 429, retryAfterSeconds: 120 };
  await expect(resolveAutomaticMatches(env.DB, view, target, { ...catalog(), findMatch: async () => { throw error; } }, 'us')).rejects.toEqual(error);
});

it('continues beyond a batch of unresolved songs without searching the same failures forever', async () => {
  const { threads, target, view } = await setup();
  for (let index = 0; index < 5; index++) {
    await threads.add(view.publicCapability, { expectedRevision: 2 + index, requestKey: `song-${index}`, source: { provider: 'apple', id: String(200 + index), storefront: 'us' }, track: { title: 'Song', artist: 'Artist', isrc: null, artworkUrl: null, complete: false, spotifyUrl: null, appleUrl: `https://music.apple.com/us/song/${200 + index}` } });
  }
  const current = (await threads.get(view.publicCapability))!;
  const client = { get: catalog().get, findMatch: vi.fn(async () => ({ ...result, status: 'ambiguous' as const, selected: null })) };
  await expect(resolveAutomaticMatches(env.DB, current, target, client, 'us')).rejects.toMatchObject({ code: 'matching_pending' });
  expect(client.findMatch).toHaveBeenCalledTimes(5);
  expect((await resolveAutomaticMatches(env.DB, current, target, client, 'us')).identitiesComplete).toBe(false);
  expect(client.findMatch).toHaveBeenCalledTimes(6);
});

it('rechecks uncertain candidates after a requested retry while retaining accepted selections', async () => {
  const { target, view, auth } = await setup();
  const client = { get: catalog().get, findMatch: vi.fn(async () => ({ ...result, status: 'ambiguous' as const, selected: null })) };
  await resolveAutomaticMatches(env.DB, view, target, client, 'us');
  await resolveAutomaticMatches(env.DB, view, target, client, 'us');
  expect(client.findMatch).toHaveBeenCalledTimes(1);
  await new D1PublicationStore(env.DB).retry(auth, 'spotify');
  await resolveAutomaticMatches(env.DB, view, target, client, 'us');
  expect(client.findMatch).toHaveBeenCalledTimes(2);
});

it('keeps subscriber retry caches scoped to the requested account', async () => {
  const { D1AccountStore } = await import('./account-db.js');
  const { target, view } = await setup();
  const accounts = new D1AccountStore(env.DB);
  const firstId = crypto.randomUUID();
  const secondId = crypto.randomUUID();
  for (const accountId of [firstId, secondId]) {
    await env.DB.prepare("INSERT INTO accounts(id,provider,provider_subject,label) VALUES (?,'spotify',?,'Listener')").bind(accountId, accountId).run();
  }
  const first = await accounts.subscribe(firstId, view.publicCapability);
  const second = await accounts.subscribe(secondId, view.publicCapability);
  const client = { get: catalog().get, findMatch: vi.fn(async () => ({ ...result, status: 'ambiguous' as const, selected: null })) };
  for (const subscription of [first, second]) await resolveAutomaticMatches(env.DB, view, { ...target, publisherKey: subscription.publisherKey }, client, 'us');
  await accounts.retry(firstId, view.publicCapability);
  for (const subscription of [first, second]) await resolveAutomaticMatches(env.DB, view, { ...target, publisherKey: subscription.publisherKey }, client, 'us');
  expect(client.findMatch).toHaveBeenCalledTimes(3);
});

it('does not attempt to match unverified legacy sources', async () => {
  const { target, view } = await setup();
  view.contributions[0]!.source.verified = false;
  const client = catalog();
  expect((await resolveAutomaticMatches(env.DB, view, target, client, 'us')).identitiesComplete).toBe(false);
  expect(client.get).not.toHaveBeenCalled();
});

it('pins selections independently for each publisher destination', async () => {
  const { target, view } = await setup();
  const first = catalog();
  const second = { get: catalog().get, findMatch: vi.fn(async () => ({ ...result, selected: { ...selected, id: 'b'.repeat(22), storefront: 'gb' } })) };
  await resolveAutomaticMatches(env.DB, view, target, first, 'us');
  const another = { ...target, publisherKey: crypto.randomUUID() };
  expect((await resolveAutomaticMatches(env.DB, view, another, second, 'gb')).entries[0]!.identity).toMatchObject({ id: 'b'.repeat(22) });
  expect((await resolveAutomaticMatches(env.DB, view, target, first, 'gb')).entries[0]!.identity).toMatchObject({ id: selected.id });
  expect(first.findMatch).toHaveBeenCalledTimes(1);
});
