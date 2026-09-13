import { createPhotoSelection } from './profile-photo.js';
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

function safeProfilePhoto(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function createProfileActions({ request = threadRequest, update, profileBinding }) {
  let pending = false;
  return {
    async save(details) {
      if (pending) return;
      if (typeof profileBinding !== 'string' || !profileBinding) {
        update({ status: 'error', message: 'Refresh your account before saving your profile.' });
        return;
      }
      const displayName = typeof details.displayName === 'string' ? details.displayName.trim() : '';
      const avatarUrl = typeof details.avatarUrl === 'string' ? details.avatarUrl.trim() || null : null;
      if (!displayName || displayName.length > 80) {
        update({ status: 'error', message: 'Enter a display name between 1 and 80 characters.' });
        return;
      }
      if (avatarUrl && !safeProfilePhoto(avatarUrl)) {
        update({ status: 'error', message: 'Use a photo URL that starts with https://, without a username or password (up to 2,048 characters).' });
        return;
      }
      pending = true;
      update({ status: 'loading', message: 'Saving…' });
      try {
        const photo = typeof details.avatarImageBase64 === 'string' ? { avatarImageBase64: details.avatarImageBase64 } : { avatarUrl };
        const { profile } = await request('/api/account/profile', { displayName, ...photo, profileBinding });
        if (!profile || typeof profile.displayName !== 'string') throw new Error('Profile unavailable');
        update({ status: 'success', profile, message: 'Profile saved.' });
      } catch {
        update({ status: 'error', message: 'Could not save your profile. Try again. If you signed out, refresh your account first.' });
      } finally { pending = false; }
    },
  };
}

export function mountAccountProfile(form, data, request = threadRequest) {
  if (!form) return;
  form.hidden = !data.account;
  if (form.hidden) return;
  const name = form.querySelector('#profile-name');
  const photo = form.querySelector('#profile-photo');
  const preview = form.querySelector('#profile-preview');
  const message = form.querySelector('#profile-message');
  const button = form.querySelector('button[type="submit"]');
  const remove = form.querySelector('#profile-remove-photo');
  let saving = false;
  let preparing = false;
  let previewUrl = null;
  const controls = () => {
    const busy = saving || preparing;
    form.setAttribute('aria-busy', String(busy));
    name.disabled = saving;
    photo.disabled = saving;
    remove.disabled = busy || !previewUrl;
    button.disabled = busy;
    button.textContent = saving ? 'Saving…' : 'Save profile';
  };
  const selection = createPhotoSelection({ update(state) {
    preparing = state.status === 'loading';
    previewUrl = state.previewUrl;
    preview.hidden = !previewUrl;
    if (previewUrl) preview.src = previewUrl;
    else preview.removeAttribute('src');
    message.textContent = state.message;
    message.dataset.status = state.status;
    controls();
  } });
  const showProfile = profile => {
    name.value = profile?.displayName || 'Listener';
    photo.value = '';
    selection.reset(safeProfilePhoto(profile?.avatarUrl));
  };
  showProfile(data.profile);
  preview.addEventListener('error', () => { preview.hidden = true; });
  photo.addEventListener('change', () => {
    const file = photo.files?.[0];
    photo.value = '';
    void selection.select(file);
  });
  remove.addEventListener('click', () => {
    if (saving || preparing) return;
    photo.value = '';
    selection.remove();
  });
  const actions = createProfileActions({ request, profileBinding: data.profileBinding, update(state) {
    saving = state.status === 'loading';
    if (state.status === 'success') showProfile(state.profile);
    controls();
    message.textContent = state.message;
    message.dataset.status = state.status;
  } });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (preparing) return;
    void actions.save({ displayName: name.value, ...selection.details() });
  });
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
    mountAccountProfile(find('#account-profile'), data);
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
