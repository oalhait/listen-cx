import { threadRequest } from './thread-client.js';

export function validCapability(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
}

export function playlistLink(subscription) {
  if (!subscription?.verifiedPlaylistId || !subscription.verifiedPlaylistUrl) return null;
  try {
    const url = new URL(subscription.verifiedPlaylistUrl);
    const id = subscription.verifiedPlaylistId;
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    const valid = subscription.provider === 'spotify'
      ? url.hostname === 'open.spotify.com' && /^[A-Za-z0-9]{22}$/.test(id) && url.pathname === `/playlist/${id}`
      : subscription.provider === 'apple' && url.hostname === 'music.apple.com' && /^p\.[A-Za-z0-9.-]+$/.test(id) && /^\/[a-z]{2}\/playlist\/(?:[^/]+\/)?pl\.[A-Za-z0-9.-]+\/?$/.test(url.pathname);
    return valid ? url.href : null;
  } catch { return null; }
}

export function subscriptionMessage(data) {
  if (!data?.account) return 'Sign in to keep your own playlist updated.';
  const provider = data.account.provider === 'spotify' ? 'Spotify' : data.account.provider === 'apple' ? 'Apple Music' : null;
  if (!provider) return 'This music provider is not supported.';
  if (!data.account.connected) return `Connect ${provider} in account settings to subscribe.`;
  const subscription = data.subscription;
  if (!subscription?.connected) return `Subscribe to keep your own ${provider} playlist updated.`;
  const code = subscription.blockedReason || subscription.failureCode;
  if (code === 'matching_pending') return `Finding matching songs on ${provider}…`;
  if (code === 'identities_incomplete') return `A song needs a confirmed ${provider} match before this playlist can sync.`;
  if (code === 'append_only' || code === 'apple_append_only') return 'Your Apple Music copy is paused because songs were removed or reordered. New songs can only be appended.';
  if (code === 'provider_drift') return `Your ${provider} playlist changed outside this Thread. Sync is paused to protect those changes.`;
  if (subscription.status === 'synced' && subscription.appliedRevision === subscription.requestedRevision && playlistLink(subscription)) return `Your ${provider} playlist is up to date.`;
  if (subscription.status === 'blocked') return `Your ${provider} playlist needs attention. Check account settings, then retry.`;
  if (subscription.status === 'failed') return `Your ${provider} playlist could not sync. You can retry.`;
  return `Your ${provider} playlist is waiting to sync.`;
}

export function providerSubscriptions(data) {
  const connections = data?.connections ?? (data?.account ? [data] : []);
  return [['apple', 'Apple Music'], ['spotify', 'Spotify']].map(([provider, name]) => {
    const connection = connections.find(connection => connection.account?.provider === provider);
    return { provider, name, account: connection?.account ?? null, subscription: connection?.subscription ?? null };
  });
}

export function createSubscriptionController({ capability, fetcher = fetch, request = threadRequest, update,
  isVisible = () => true, schedule = callback => setTimeout(callback, 5000), cancel = clearTimeout }) {
  const path = `/api/threads/${encodeURIComponent(capability)}/subscription`;
  let pending = false;
  let stopped = false;
  let timer;
  let data = null;
  let stale = false;
  const queue = () => {
    cancel(timer);
    if (!stopped && isVisible()) timer = schedule(() => { void run(); });
  };
  const run = async (action, provider) => {
    if (stopped || pending || !validCapability(capability) || (!action && !isVisible())) return;
    pending = true;
    cancel(timer);
    update({ data, busy: true, stale });
    try {
      if (action) {
        if (!['subscribe', 'retry', 'unsubscribe'].includes(action) || !['apple', 'spotify'].includes(provider)) throw new Error('Invalid action');
        await request(path, { action, provider });
      }
      const response = await fetcher(path, { credentials: 'same-origin', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Status unavailable');
      data = await response.json();
      stale = false;
      update({ data, busy: false, stale: false });
    } catch {
      stale = true;
      update({ data, busy: false, stale: true });
    } finally {
      pending = false;
      queue();
    }
  };
  return {
    refresh: () => run(),
    act: (action, provider) => run(action, provider),
    visibilityChanged() { cancel(timer); if (isVisible()) void run(); },
    stop() { stopped = true; cancel(timer); },
  };
}

export function mountSubscription(root) {
  const capability = root.dataset.capability;
  if (!validCapability(capability)) return;
  const status = root.querySelector('[data-subscriptions-status]');
  const settings = root.querySelector('[data-subscription-settings]');
  settings.href = `/settings?thread=${encodeURIComponent(capability)}`;
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'text-button';
  refresh.textContent = 'Refresh status';
  refresh.hidden = true;
  root.append(refresh);
  const note = document.createElement('p');
  note.className = 'thread-note';
  note.textContent = 'Apple Music appends new songs. Removing or reordering songs can pause your Apple Music copy; this Thread stays editable.';
  note.hidden = true;
  root.append(note);
  const controller = createSubscriptionController({
    capability,
    isVisible: () => !document.hidden,
    update({ data, busy, stale }) {
      root.setAttribute('aria-busy', String(busy));
      status.textContent = stale ? 'Status could not be refreshed. The playlist details below may be out of date.'
        : !data ? 'Loading your playlist status…' : !data.account ? 'Connect your music services to subscribe.' : '';
      refresh.hidden = !stale;
      refresh.disabled = busy;
      note.hidden = !providerSubscriptions(data).some(connection => connection.provider === 'apple' && connection.account);
      for (const connection of providerSubscriptions(data)) {
        const { provider, name, account, subscription } = connection;
        const card = root.querySelector(`[data-subscription-provider="${provider}"]`);
        card.querySelector('[data-subscription-status]').textContent = !data ? 'Loading…'
          : account ? subscriptionMessage(connection) : `Connect ${name} in account settings to subscribe.`;
        const connect = card.querySelector('[data-subscription-connect]');
        connect.href = settings.href;
        connect.hidden = !data || !!account?.connected;
        const playlist = card.querySelector('[data-subscription-playlist]');
        const link = playlistLink(subscription);
        playlist.hidden = !link;
        if (link) { playlist.href = link; playlist.textContent = `Open in ${name} ↗`; }
        else playlist.removeAttribute('href');
        card.querySelectorAll('[data-subscription-action]').forEach(button => {
          const action = button.dataset.subscriptionAction;
          button.hidden = action === 'subscribe' ? !account?.connected || subscription?.connected
            : action === 'unsubscribe' ? !subscription?.connected
            : !account?.connected || !subscription?.connected || !['failed', 'blocked'].includes(subscription.status);
          button.disabled = busy;
        });
      }
    },
  });
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-subscription-action]');
    if (button && root.contains(button)) void controller.act(button.dataset.subscriptionAction, button.closest('[data-subscription-provider]')?.dataset.subscriptionProvider);
  });
  refresh.addEventListener('click', () => { void controller.refresh(); });
  document.addEventListener('visibilitychange', controller.visibilityChanged);
  window.addEventListener('pageshow', controller.visibilityChanged);
  void controller.refresh();
  return controller;
}

if (typeof document !== 'undefined') {
  const root = document.querySelector('#personal-subscription');
  if (root) mountSubscription(root);
}
