import { expect, it, vi } from 'vitest';
import { createSubscriptionController, mountSubscription, playlistLink, subscriptionMessage, providerSubscriptions } from './subscription.js';

const subscription = { provider: 'spotify', connected: true, status: 'synced', requestedRevision: 2, appliedRevision: 2,
  verifiedPlaylistId: 'a'.repeat(22), verifiedPlaylistUrl: `https://open.spotify.com/playlist/${'a'.repeat(22)}` };
const data = { account: { provider: 'spotify', connected: true }, subscription };

it('shows synced only after matching revision and valid verified destination', () => {
  expect(subscriptionMessage(data)).toBe('Your Spotify playlist is up to date.');
  expect(subscriptionMessage({ ...data, subscription: { ...subscription, appliedRevision: 1 } })).not.toContain('up to date');
  expect(subscriptionMessage({ ...data, subscription: { ...subscription, verifiedPlaylistId: null } })).not.toContain('up to date');
  expect(subscriptionMessage({ ...data, subscription: { ...subscription, connected: false } })).toBe('Subscribe to keep your own Spotify playlist updated.');
  expect(subscriptionMessage({ account: null, subscription: null })).toContain('Sign in');
  expect(subscriptionMessage({ account: { provider: 'other' } })).toContain('not supported');
});

it('describes Apple subscriptions as a shared playlist in the listener library', () => {
  const apple = { account: { provider: 'apple', connected: true }, subscription: {
    ...subscription, provider: 'apple', verifiedPlaylistId: 'p.listener', verifiedPlaylistUrl: 'https://music.apple.com/us/playlist/listen/pl.u-abc',
  } };
  expect(subscriptionMessage({ ...apple, subscription: { ...apple.subscription, connected: false } })).toBe('Subscribe to add the shared Apple Music playlist to your library.');
  expect(subscriptionMessage(apple)).toBe('The shared Apple Music playlist is in your library and up to date.');
});

it('explains identity and shared playlist failures without restricting the Thread', () => {
  expect(subscriptionMessage({ ...data, subscription: { ...subscription, blockedReason: 'identities_incomplete' } })).toBe('Some songs could not be matched on Spotify. Your songs are saved in this Thread.');
  expect(subscriptionMessage({ ...data, subscription: { ...subscription, failureCode: 'provider_drift' } })).toContain('changed outside this Thread');
  expect(subscriptionMessage({ account: { provider: 'apple', connected: true }, subscription: { ...subscription, blockedReason: 'append_only' } })).toContain('shared Apple Music playlist is paused');
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
  await controller.act('subscribe', 'spotify');
  expect(request).toHaveBeenCalledWith(`/api/threads/${'a'.repeat(22)}/subscription`, { action: 'subscribe', provider: 'spotify' });
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


it('keeps both providers and their independent subscriptions visible', () => {
  const apple = { account: { provider: 'apple', connected: true }, subscription: { provider: 'apple', connected: false } };
  const spotify = { account: data.account, subscription };
  expect(providerSubscriptions({ ...data, connections: [spotify, apple] })).toEqual([
    { provider: 'apple', name: 'Apple Music', ...apple },
    { provider: 'spotify', name: 'Spotify', ...spotify },
  ]);
  expect(providerSubscriptions({ ...data, connections: [spotify] })[0]).toEqual({ provider: 'apple', name: 'Apple Music', account: null, subscription: null });
  expect(providerSubscriptions({ account: null, connections: [] }).every(connection => connection.account === null)).toBe(true);
});

it('targets each subscription action at the selected provider and refreshes the combined state', async () => {
  const both = { ...data, connections: [{ account: data.account, subscription }, { account: { provider: 'apple', connected: true }, subscription: null }] };
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => both });
  const request = vi.fn().mockResolvedValue({});
  const update = vi.fn();
  const schedule = vi.fn();
  const controller = createSubscriptionController({ capability: 'a'.repeat(22), fetcher, request, update, schedule, cancel: vi.fn() });
  for (const [action, provider] of [['subscribe', 'apple'], ['unsubscribe', 'spotify'], ['retry', 'apple']]) {
    await controller.act(action, provider);
    expect(request).toHaveBeenLastCalledWith(`/api/threads/${'a'.repeat(22)}/subscription`, { action, provider });
    expect(update).toHaveBeenLastCalledWith({ data: both, busy: false, stale: false });
  }
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(schedule).toHaveBeenCalledTimes(3);
  await controller.act('subscribe', 'unsupported');
  await controller.act('subscribe');
  expect(request).toHaveBeenCalledTimes(3);
});


it('renders independent playlist actions and leaves Apple subscribed when Spotify is unsubscribed', async () => {
  const element = () => ({ dataset: {}, children: [], selectors: {}, events: {}, textContent: '',
    setAttribute: vi.fn(), removeAttribute: vi.fn(), contains: () => true,
    append(...children) { this.children.push(...children); },
    addEventListener(name, handler) { this.events[name] = handler; },
    querySelector(selector) { return this.selectors[selector]; },
  });
  const root = element();
  root.dataset.capability = 'a'.repeat(22);
  root.selectors['[data-subscriptions-status]'] = element();
  root.selectors['[data-subscription-settings]'] = element();
  const cards = {};
  for (const provider of ['apple', 'spotify']) {
    const card = element();
    card.dataset.subscriptionProvider = provider;
    for (const selector of ['[data-subscription-status]', '[data-subscription-connect]', '[data-subscription-playlist]']) card.selectors[selector] = element();
    card.actions = ['subscribe', 'retry', 'unsubscribe'].map(action => {
      const button = element();
      button.dataset.subscriptionAction = action;
      button.closest = () => card;
      return button;
    });
    card.querySelectorAll = () => card.actions;
    root.selectors[`[data-subscription-provider="${provider}"]`] = card;
    cards[provider] = card;
  }
  const appleSubscription = { ...subscription, provider: 'apple', verifiedPlaylistId: 'p.abc', verifiedPlaylistUrl: 'https://music.apple.com/us/playlist/road-trip/pl.u-abc' };
  let both = { ...data, connections: [{ account: { provider: 'apple', connected: true }, subscription: appleSubscription }, { account: data.account, subscription }] };
  const fetcher = vi.fn(async (path, options) => {
    if (options.method === 'POST') {
      expect(JSON.parse(options.body)).toEqual({ action: 'unsubscribe', provider: 'spotify' });
      both = { ...both, connections: [both.connections[0], { account: data.account, subscription: { ...subscription, connected: false } }] };
    }
    return { ok: true, json: async () => both };
  });
  vi.stubGlobal('document', { hidden: false, createElement: element, addEventListener: vi.fn() });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  vi.stubGlobal('fetch', fetcher);
  let controller;
  try {
    controller = mountSubscription(root);
    await vi.waitFor(() => expect(cards.apple.selectors['[data-subscription-status]'].textContent).toContain('up to date'));
    for (const provider of ['apple', 'spotify']) {
      expect(cards[provider].actions[0].hidden).toBe(true);
      expect(cards[provider].actions[2].hidden).toBe(false);
      expect(cards[provider].selectors['[data-subscription-playlist]'].hidden).toBe(false);
    }
    root.events.click({ target: { closest: () => cards.spotify.actions[2] } });
    await vi.waitFor(() => expect(cards.spotify.actions[0].hidden).toBe(false));
    expect(cards.spotify.actions[2].hidden).toBe(true);
    expect(cards.apple.actions[0].hidden).toBe(true);
    expect(cards.apple.actions[2].hidden).toBe(false);
    expect(cards.apple.selectors['[data-subscription-playlist]'].href).toBe(appleSubscription.verifiedPlaylistUrl);
  } finally { controller?.stop(); vi.unstubAllGlobals(); }
});

it('describes bounded matching work as progress rather than a failed playlist', () => {
  expect(subscriptionMessage({ account: { provider: 'spotify', connected: true }, subscription: { connected: true, status: 'failed', failureCode: 'matching_pending' } }))
    .toBe('Finding matching songs on Spotify…');
});
