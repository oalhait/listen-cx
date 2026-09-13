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

export async function prepareBrowserAppleMusic(request, MusicKit) {
  const response = await request('/account/apple/prepare', {});
  if (typeof response.authorizationBinding !== 'string' || !response.authorizationBinding) throw new Error('Browser preparation expired');
  const music = await prepareAppleMusic('/account', async () => response, MusicKit);
  return { music, authorizationBinding: response.authorizationBinding };
}

export function prepareSettingsAppleMusic(data, request, MusicKit) {
  return data.account
    ? prepareAccountAppleMusic(data.authorizationBinding, request, MusicKit)
    : prepareBrowserAppleMusic(request, MusicKit);
}

export function createAccountActions({ returnTo = null, request = threadRequest, navigate, reload, update, getMusic, getAuthorizationBinding = () => null }) {
  let pending = false;
  const run = async action => {
    if (pending) return;
    pending = true;
    update({ status: 'loading' });
    try { await action(); update({ status: 'success' }); }
    catch { update({ status: 'error', message: 'Could not finish connecting. Refresh settings and try again. If Apple’s sign-in window did not open, open this page in your regular browser.' }); }
    finally { pending = false; }
  };
  const authorizeApple = () => run(async () => {
    const authorizationBinding = getAuthorizationBinding();
    if (typeof authorizationBinding !== 'string' || !authorizationBinding) throw new Error('Account preparation expired');
    const musicUserToken = await getMusic().authorize();
    if (typeof musicUserToken !== 'string' || !musicUserToken) throw new Error('Missing authorization');
    await request('/account/apple/authorize', { musicUserToken, authorizationBinding });
    reload();
  });
  return {
    signIn(provider) {
      if (provider === 'apple') return authorizeApple();
      return run(async () => {
        if (provider !== 'spotify') throw new Error('Unsupported provider');
        const { url: destination } = await request(`/account/${provider}/start`, validCapability(returnTo) ? { returnTo } : {});
        const url = new URL(destination);
        const host = 'accounts.spotify.com';
        if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password || url.port || url.hash) throw new Error('Invalid destination');
        navigate(url.href);
      });
    },
    authorizeApple,
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
  const readiness = find('#apple-readiness');
  const returnTo = accountReturn(window.location.search);
  if (returnTo) { find('#account-return').href = `/t/${returnTo}`; find('#account-return').hidden = false; }
  let data;
  let music;
  let authorizationBinding;
  let applePreparing = false;
  let appleFailed = false;
  let busy = false;
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'text-button';
  refresh.textContent = 'Refresh account';
  refresh.hidden = true;
  message.after(refresh);
  refresh.addEventListener('click', () => window.location.reload());
  const connections = () => data?.connections ?? (data?.account ? [data.account] : []);
  const buttons = () => {
    root.setAttribute('aria-busy', String(busy));
    refresh.disabled = busy;
    root.querySelectorAll('[data-sign-in]').forEach(button => {
      const connection = connections().find(account => account.provider === button.dataset.signIn);
      const available = !!data?.available?.[button.dataset.signIn];
      const name = button.dataset.signIn === 'apple' ? 'Apple Music' : 'Spotify';
      const apple = button.dataset.signIn === 'apple';
      button.disabled = busy || !available || (apple && (!music || !authorizationBinding));
      button.setAttribute('aria-busy', String((busy || (apple && applePreparing)) && available));
      button.textContent = !available ? `${name} · unavailable` : apple && applePreparing ? 'Getting Apple Music ready…' : apple && appleFailed ? 'Apple Music could not load' : `${connection ? 'Reconnect' : 'Connect'} ${name} ↗`;
    });
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
  buttons();
  try {
    const response = await fetch('/api/account', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Account unavailable');
    data = await response.json();
    find('#account-settings').hidden = !data.account;
    const linked = connections();
    for (const provider of ['apple', 'spotify']) {
      const account = linked.find(account => account.provider === provider);
      const card = find(`[data-account-provider="${provider}"]`);
      card.querySelector('[data-account-label]').textContent = account?.label || '';
      card.querySelector('[data-account-status]').textContent = account ? account.connected ? 'Connected' : 'Permission needed' : 'Not connected';
    }
    const unavailable = ['spotify', 'apple'].filter(provider => !data.available?.[provider]);
    message.textContent = unavailable.length === 2 ? 'Music connections are currently unavailable. Try again later.'
      : data.account ? 'Connect both services to keep a separate playlist in each.' : 'Connect Apple Music, Spotify, or both.';
    if (data.account) {
      const list = find('#account-subscriptions');
      list.replaceChildren();
      for (const subscription of data.subscriptions ?? []) {
        if (!validCapability(subscription.capability)) continue;
        const account = linked.find(account => account.provider === subscription.provider);
        if (!account) continue;
        const name = account.provider === 'apple' ? 'Apple Music' : 'Spotify';
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = `/t/${subscription.capability}`;
        link.textContent = `${subscription.title || 'Thread'} · ${name}`;
        const status = document.createElement('p');
        status.textContent = subscriptionMessage({ account, subscription });
        item.append(link, status);
        const playlist = playlistLink(subscription);
        if (playlist) { const open = document.createElement('a'); open.href = playlist; open.textContent = `Open in ${name} ↗`; item.append(open); }
        list.append(item);
      }
      if (!list.children.length) { const empty = document.createElement('li'); empty.textContent = 'Open a Thread and subscribe to create your playlists.'; list.append(empty); }
    }
    if (data.available?.apple) {
      applePreparing = true;
      const snapshot = { account: data.account, authorizationBinding: data.authorizationBinding };
      readiness.textContent = 'Getting Apple Music ready…';
      void waitForAccountMusicKit(window, document).then(MusicKit => prepareSettingsAppleMusic(snapshot, threadRequest, MusicKit)).then(prepared => {
        music = prepared.music;
        authorizationBinding = prepared.authorizationBinding;
        applePreparing = false;
        readiness.textContent = data.account?.browserOnly
          ? 'Apple Music is ready. Your account is saved in this browser; use it to return to your playlists.'
          : data.account ? 'Apple Music is ready to connect to your account.'
          : 'Apple Music is ready. Connecting saves your account in this browser.';
        buttons();
      }).catch(() => {
        applePreparing = false;
        appleFailed = true;
        readiness.textContent = 'Apple Music could not load. Refresh your account to try again.';
        refresh.hidden = false;
        buttons();
      });
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
