import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { D1AccountStore } from './account-db.js';
import { D1ProfileStore } from './profile-db.js';
const accounts = new D1AccountStore(env.DB);
const profiles = new D1ProfileStore(env.DB);
it('seeds once and preserves user edits across provider reconnects', async () => {
  const account = await accounts.upsert('spotify', crypto.randomUUID(), 'private-id');
  expect(await profiles.get(account.id)).toEqual({ displayName: 'Listener', avatarUrl: null });
  await profiles.seed(account.id, { displayName: 'Provider name', avatarUrl: null });
  await profiles.update(account.id, { displayName: 'My name', avatarUrl: null });
  await profiles.seed(account.id, { displayName: 'Reconnect name', avatarUrl: 'https://example.com/photo' });
  expect(await profiles.get(account.id)).toEqual({ displayName: 'My name', avatarUrl: null });
});
it('shares one profile across linked providers and preserves the anchor customization', async () => {
  const apple = await accounts.upsert('apple', crypto.randomUUID(), 'Apple Music');
  const spotify = await accounts.upsert('spotify', crypto.randomUUID(), 'Spotify');
  await profiles.seed(spotify.id, { displayName: 'Spotify name', avatarUrl: null });
  await accounts.createSession(apple.id, 'link-profile', Date.now() + 60000);
  expect(await accounts.linkAccounts(apple.id, spotify.id, 'link-profile')).toBe(true);
  expect(await profiles.get(apple.id)).toEqual({ displayName: 'Spotify name', avatarUrl: null });
  await profiles.update(apple.id, { displayName: 'Together', avatarUrl: null });
  expect(await profiles.get(spotify.id)).toEqual({ displayName: 'Together', avatarUrl: null });
  const second = await accounts.upsert('apple', crypto.randomUUID(), 'Apple');
  const other = await accounts.upsert('spotify', crypto.randomUUID(), 'Spotify');
  await profiles.update(second.id, { displayName: 'Keep me', avatarUrl: null });
  await profiles.update(other.id, { displayName: 'Other name', avatarUrl: null });
  await accounts.createSession(second.id, 'other-link-profile', Date.now() + 60000);
  await accounts.linkAccounts(second.id, other.id, 'other-link-profile');
  expect((await profiles.get(other.id)).displayName).toBe('Keep me');
});
it('does not update another account and throttles automatic profile imports', async () => {
  const a = await accounts.upsert('apple', crypto.randomUUID(), 'Apple');
  const b = await accounts.upsert('spotify', crypto.randomUUID(), 'Spotify');
  await profiles.update(a.id, { displayName: 'Only A', avatarUrl: null });
  expect((await profiles.get(b.id)).displayName).toBe('Listener');
  expect(await profiles.claimSeed(b.id)).toBe(true);
  expect(await profiles.claimSeed(b.id)).toBe(false);
  expect(await profiles.claimSeed(a.id)).toBe(false);
});

it('saves uploaded photos atomically, replaces its own stored photo, and removes it', async () => {
  const account = await accounts.upsert('apple', crypto.randomUUID(), 'Apple Music');
  const other = await accounts.upsert('spotify', crypto.randomUUID(), 'Other');
  const bytes = new Uint8Array([1, 2, 3]);
  const first = await profiles.updatePhoto(account.id, 'Photo owner', bytes, 'https://listen.test');
  const id = first.avatarUrl!.split('/').at(-1)!;
  expect(first.displayName).toBe('Photo owner');
  expect(await profiles.photo(id)).toEqual(bytes);
  const second = await profiles.updatePhoto(account.id, 'New name', new Uint8Array([4]), 'https://listen.test');
  expect(second.avatarUrl).not.toBe(first.avatarUrl);
  expect(await profiles.photo(id)).toBeNull();
  expect((await profiles.get(other.id)).avatarUrl).toBeNull();
  await profiles.update(account.id, { displayName: 'No photo', avatarUrl: null });
  expect(await profiles.photo(second.avatarUrl!.split('/').at(-1)!)).toBeNull();
});
