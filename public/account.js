import { threadRequest } from './thread-client.js';
import { prepareAppleMusic } from './music-connections.js';
import { validCapability, playlistLink, subscriptionMessage } from './subscription.js';

export function accountReturn(search) {
  const capability = new URLSearchParams(search).get('thread');
  return validCapability(capability) ? capability : null;
}

export async function prepareAccountAppleMusic(authorizationBinding, request, MusicKit) {
  if (typeof authorizationBinding !== 'string' || !authorizationBinding) throw new Error('Account preparation expired');
  const music = await prepareAppleMusic('/account', async (path, body) => {
    const response = await request(path, { ...body, authorizationBinding });
    if (response.authorizationBinding !== authorizationBinding) throw new Error('Account preparation changed');
    return response;
  }, MusicKit);
  return { music, authorizationBinding };
}

export function createAccountActions({ returnTo = null, request = threadRequest, navigate, reload, update, getMusic, getAuthorizationBinding = () => null }) {
  let pending = false;
  const run = async action => {
    if (pending) return;
    pending = true;
    update({ status: 'loading' });
    try { await action(); update({ status: 'success' }); }
    catch { update({ status: 'error', message: 'Could not finish. Try again. Your account settings have not been refreshed.' }); }
    finally { pending = false; }
  };
  return {
    signIn(provider) {
      return run(async () => {
        if (!['spotify', 'apple'].includes(provider)) throw new Error('Unsupported provider');
        const { url: destination } = await request(`/account/${provider}/start`, validCapability(returnTo) ? { returnTo } : {});
        const url = new URL(destination);
        const host = provider === 'spotify' ? 'accounts.spotify.com' : 'appleid.apple.com';
        if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password || url.port || url.hash) throw new Error('Invalid destination');
        navigate(url.href);
      });
    },
    authorizeApple() {
      return run(async () => {
        const authorizationBinding = getAuthorizationBinding();
        if (typeof authorizationBinding !== 'string' || !authorizationBinding) throw new Error('Account preparation expired');
        const musicUserToken = await getMusic().authorize();
        if (typeof musicUserToken !== 'string' || !musicUserToken) throw new Error('Missing authorization');
        await request('/account/apple/authorize', { musicUserToken, authorizationBinding });
        reload();
      });
    },
    signOut() {
      return run(async () => {
        await request('/account/sign-out', {});
        try { await getMusic()?.unauthorize(); } catch {}
        reload();
      });
    },
  };
}

export function waitForAccountMusicKit(window, document) {
  if (window.MusicKit) return Promise.resolve(window.MusicKit);
  return new Promise((resolve, reject) => {
    const loaded = () => {
      clearTimeout(timer);
      window.MusicKit ? resolve(window.MusicKit) : reject(new Error('Apple Music unavailable'));
    };
    const timer = setTimeout(() => {
      document.removeEventListener('musickitloaded', loaded);
      reject(new Error('Apple Music unavailable'));
    }, 15000);
    document.addEventListener('musickitloaded', loaded, { once: true });
  });
}

export async function mountAccount(root) {
  const find = selector => root.querySelector(selector);
  const message = find('#account-message');
  const reconnect = find('#account-reconnect');
  const readiness = find('#apple-readiness');
  const returnTo = accountReturn(window.location.search);
  if (returnTo) { find('#account-return').href = `/t/${returnTo}`; find('#account-return').hidden = false; }
  let data;
  let music;
  let authorizationBinding;
  let busy = false;
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'text-button';
  refresh.textContent = 'Refresh account';
  refresh.hidden = true;
  message.after(refresh);
  refresh.addEventListener('click', () => window.location.reload());
  const buttons = () => {
    root.setAttribute('aria-busy', String(busy));
    refresh.disabled = busy;
    root.querySelectorAll('[data-sign-in]').forEach(button => {
      const available = !!data?.available?.[button.dataset.signIn];
      const name = button.dataset.signIn === 'apple' ? 'Apple Music' : 'Spotify';
      button.disabled = busy || !available;
      button.setAttribute('aria-busy', String(busy && available));
      button.textContent = available ? `Continue with ${name} ↗` : `${name} · unavailable`;
    });
    const provider = data?.account?.provider;
    reconnect.disabled = busy || !data?.available?.[provider] || (provider === 'apple' && (!music || !authorizationBinding));
    find('#account-sign-out').disabled = busy;
  };
  const actions = createAccountActions({ returnTo, navigate: url => window.location.assign(url), reload: () => window.location.reload(),
    getMusic: () => music || window.MusicKit?.getInstance(), getAuthorizationBinding: () => authorizationBinding,
    update(state) {
      busy = state.status === 'loading';
      message.textContent = busy ? 'Working…' : state.status === 'error' ? state.message : 'Done.';
      refresh.hidden = state.status !== 'error';
      buttons();
    },
  });
  root.querySelectorAll('[data-sign-in]').forEach(button => button.addEventListener('click', () => { void actions.signIn(button.dataset.signIn); }));
  find('#account-sign-out').addEventListener('click', () => { void actions.signOut(); });
  reconnect.addEventListener('click', () => { void (data?.account?.provider === 'apple' ? actions.authorizeApple() : actions.signIn(data?.account?.provider)); });
  buttons();
  try {
    const response = await fetch('/api/account', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Account unavailable');
    data = await response.json();
    find('#account-sign-in').hidden = !!data.account;
    find('#account-settings').hidden = !data.account;
    if (!data.account) {
      const unavailable = ['spotify', 'apple'].filter(provider => !data.available?.[provider]);
      message.textContent = unavailable.length === 2 ? 'Music sign-in is currently unavailable. Try again later.'
        : unavailable.length ? `${unavailable[0] === 'apple' ? 'Apple Music' : 'Spotify'} sign-in is currently unavailable. Choose the available provider.` : 'Choose your music provider.';
    } else {
      const { provider, label, connected } = data.account;
      const name = provider === 'apple' ? 'Apple Music' : provider === 'spotify' ? 'Spotify' : null;
      find('#account-label').textContent = label;
      find('#account-provider').textContent = name ? `${name} · ${connected ? 'Connected' : 'Permission needed'}` : 'Unsupported music provider';
      message.textContent = !name ? 'This music provider is not supported. Sign out to choose another account.'
        : !data.available?.[provider] ? `${name} connection is currently unavailable. Try again later.`
        : connected ? 'Your music account is connected.' : `Connect ${name} to start subscribing.`;
      reconnect.textContent = provider === 'apple' ? `${connected ? 'Reconnect' : 'Connect'} Apple Music` : 'Reconnect Spotify';
      const list = find('#account-subscriptions');
      list.replaceChildren();
      for (const subscription of data.subscriptions ?? []) {
        if (!validCapability(subscription.capability)) continue;
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = `/t/${subscription.capability}`;
        link.textContent = subscription.title || 'Thread';
        const status = document.createElement('p');
        status.textContent = subscriptionMessage({ account: data.account, subscription });
        item.append(link, status);
        const playlist = playlistLink(subscription);
        if (playlist) { const open = document.createElement('a'); open.href = playlist; open.textContent = 'Open your playlist ↗'; item.append(open); }
        list.append(item);
      }
      if (!list.children.length) { const empty = document.createElement('li'); empty.textContent = 'Open a Thread and subscribe to create your playlist.'; list.append(empty); }
      if (provider === 'apple' && data.available?.apple) {
        readiness.textContent = 'Loading Apple Music permissions… New songs append to your copy; removals and reordering can pause sync.';
        const snapshotBinding = data.authorizationBinding;
        void waitForAccountMusicKit(window, document).then(MusicKit => prepareAccountAppleMusic(snapshotBinding, threadRequest, MusicKit)).then(prepared => {
          music = prepared.music;
          authorizationBinding = prepared.authorizationBinding;
          readiness.textContent = 'Apple Music is ready. New songs append to your copy; removals and reordering can pause sync.';
          buttons();
        }).catch(() => { readiness.textContent = 'Apple Music could not load. Refresh your account to try again.'; refresh.hidden = false; });
      }
    }
    const result = new URLSearchParams(window.location.search).get('sign_in');
    if (result === 'failed') message.textContent = 'Sign-in did not finish. Try connecting again.';
  } catch { message.textContent = 'Could not load your account. Refresh to try again.'; refresh.hidden = false; }
  buttons();
}

if (typeof document !== 'undefined') {
  const root = document.querySelector('#account-page');
  if (root) void mountAccount(root);
}
