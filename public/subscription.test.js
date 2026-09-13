import { expect, it, vi } from 'vitest';
import { createSubscriptionController, playlistLink, subscriptionMessage } from './subscription.js';

const subscription = { provider: 'spotify', connected: true, status: 'synced', requestedRevision: 2, appliedRevision: 2,
  verifiedPlaylistId: 'a'.repeat(22), verifiedPlaylistUrl: `https://open.spotify.com/playlist/${'a'.repeat(22)}` };
const data = { account: { provider: 'spotify', connected: true }, subscription };

it('shows synced only after matching revision and valid verified destination', () => {
  expect(subscriptionMessage(data)).toContain('up to date');
  expect(subscriptionMessage({ ...data, subscription: { ...subscription, appliedRevision: 1 } })).not.toContain('up to date');
  expect(subscriptionMessage({ ...data, subscription: { ...subscription, verifiedPlaylistId: null } })).not.toContain('up to date');
  expect(subscriptionMessage({ account: null, subscription: null })).toContain('Sign in');
  expect(subscriptionMessage({ account: { provider: 'other' } })).toContain('not supported');
});

it('explains identity and Apple copy failures without restricting the Thread', () => {
  expect(subscriptionMessage({ ...data, subscription: { ...subscription, blockedReason: 'identities_incomplete' } })).toBe('A song needs a confirmed Spotify match before this playlist can sync.');
  expect(subscriptionMessage({ ...data, subscription: { ...subscription, failureCode: 'provider_drift' } })).toContain('changed outside this Thread');
  expect(subscriptionMessage({ account: { provider: 'apple', connected: true }, subscription: { ...subscription, blockedReason: 'append_only' } })).toContain('copy is paused');
});

it('accepts only provider playlist URLs and the exact Spotify destination', () => {
  expect(playlistLink(subscription)).toBe(subscription.verifiedPlaylistUrl);
  for (const url of ['javascript:alert(1)', 'https://open.spotify.com.evil.test', `https://user:pass@open.spotify.com/playlist/${'a'.repeat(22)}`, `https://open.spotify.com/playlist/${'b'.repeat(22)}`]) expect(playlistLink({ ...subscription, verifiedPlaylistUrl: url })).toBeNull();
  expect(playlistLink({ provider: 'apple', verifiedPlaylistId: 'p.abc', verifiedPlaylistUrl: 'https://music.apple.com/us/playlist/name/pl.u-abc' })).toBeTruthy();
});

it('keeps one request in flight and refreshes after a personal action', async () => {
  let finish;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ok: true, json: async () => data });
  const request = vi.fn().mockResolvedValue({});
  const update = vi.fn();
  const controller = createSubscriptionController({ capability: 'a'.repeat(22), fetcher, request, update, schedule: vi.fn(), cancel: vi.fn() });
  const pending = controller.refresh();
  await controller.refresh();
  expect(fetcher).toHaveBeenCalledTimes(1);
  finish({ ok: true, json: async () => data });
  await pending;
  await controller.act('subscribe');
  expect(request).toHaveBeenCalledWith(`/api/threads/${'a'.repeat(22)}/subscription`, { action: 'subscribe' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(update).toHaveBeenLastCalledWith({ data, busy: false, stale: false });
});

it('preserves the last known state as stale after failures until refresh succeeds', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => data }).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ ok: true, json: async () => data });
  const update = vi.fn();
  const controller = createSubscriptionController({ capability: 'a'.repeat(22), fetcher, update, schedule: vi.fn(), cancel: vi.fn() });
  await controller.refresh();
  await controller.refresh();
  expect(update).toHaveBeenLastCalledWith({ data, busy: false, stale: true });
  await controller.refresh();
  expect(update.mock.calls.at(-2)[0]).toEqual({ data, busy: true, stale: true });
  expect(update).toHaveBeenLastCalledWith({ data, busy: false, stale: false });
});

it('pauses polling while hidden and refreshes when visible', async () => {
  let visible = false;
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => data });
  const schedule = vi.fn();
  const controller = createSubscriptionController({ capability: 'a'.repeat(22), fetcher, update: vi.fn(), isVisible: () => visible, schedule, cancel: vi.fn() });
  await controller.refresh();
  expect(fetcher).not.toHaveBeenCalled();
  visible = true;
  controller.visibilityChanged();
  await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
  expect(fetcher).toHaveBeenCalledTimes(1);
  controller.stop();
  await controller.refresh();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
