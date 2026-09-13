import { threadRequest } from './thread-client.js';

export async function prepareAppleMusic(base, request, MusicKit) {
  const { developerToken } = await request(`${base}/apple/token`, {});
  if (typeof developerToken !== 'string' || !developerToken) throw new Error('Apple Music is unavailable.');
  await MusicKit.configure({ developerToken, app: { name: 'listen.cx', build: '1' } });
  return MusicKit.getInstance();
}

export function createMusicConnectionActions({ capability, revision, request = threadRequest, navigate, update, getMusic }) {
  const threadPath = `/t/${encodeURIComponent(capability)}`;
  const base = `${threadPath}/manage/apps`;
  const requestKeys = new Map();
  let pending = false;
  const run = async action => {
    if (pending) return;
    pending = true;
    update({ status: 'loading' });
    try {
      await action();
      update({ status: 'success' });
    } catch (error) {
      const refresh = error?.code === 'stale_revision';
      update({ status: 'error', refresh, message: refresh
        ? 'This Thread changed. Refresh connections before starting sync.'
        : 'Could not finish connecting. Try again, or return to your Thread to check its status.' });
    } finally {
      pending = false;
    }
  };
  return {
    authorizeSpotify() {
      return run(async () => {
        const result = await request(`${base}/spotify/start`, {});
        const url = new URL(result.url);
        if (url.protocol !== 'https:' || url.hostname !== 'accounts.spotify.com' || url.username || url.password) throw new Error('Invalid authorization destination.');
        navigate(url.href);
      });
    },
    authorizeApple() {
      return run(async () => {
        const musicUserToken = await getMusic().authorize();
        if (typeof musicUserToken !== 'string' || !musicUserToken) throw new Error('Apple Music authorization did not finish.');
        await request(`${base}/apple/authorize`, { musicUserToken });
        navigate(base);
      });
    },
    startSync(provider, confirmed = false) {
      if (provider !== 'spotify' && provider !== 'apple') return;
      if (provider === 'apple' && !confirmed) return;
      return run(async () => {
        if (!requestKeys.has(provider)) requestKeys.set(provider, crypto.randomUUID());
        await request(`${threadPath}/manage/mutate`, {
          kind: 'connect', provider, expectedRevision: revision, requestKey: requestKeys.get(provider),
        });
        requestKeys.delete(provider);
        navigate(threadPath);
      });
    },
  };
}

function waitForMusicKit() {
  if (window.MusicKit) return Promise.resolve(window.MusicKit);
  return new Promise((resolve, reject) => {
    const loaded = () => {
      clearTimeout(timeout);
      resolve(window.MusicKit);
    };
    const timeout = setTimeout(() => {
      document.removeEventListener('musickitloaded', loaded);
      reject(new Error('Apple Music did not load.'));
    }, 15000);
    document.addEventListener('musickitloaded', loaded, { once: true });
  });
}

function mountConnections(root) {
  const message = document.querySelector('#connection-message');
  const refresh = document.querySelector('#refresh-connections');
  const appleButton = root.querySelector('[data-authorize="apple"]');
  const appleReadiness = document.querySelector('#apple-readiness');
  const confirmation = document.querySelector('#apple-lock-confirmation');
  const appleStart = root.querySelector('[data-start-sync="apple"]');
  let music;
  let busy = false;
  const updateButtons = () => {
    root.querySelectorAll('button').forEach(button => { button.disabled = busy || (button === appleButton && !music); });
  };
  const actions = createMusicConnectionActions({
    capability: root.dataset.capability,
    revision: Number(root.dataset.revision),
    navigate: path => window.location.assign(path),
    getMusic: () => music,
    update(state) {
      busy = state.status === 'loading';
      root.setAttribute('aria-busy', String(busy));
      updateButtons();
      message.textContent = busy ? 'Connecting…' : state.status === 'error' ? state.message : '';
      refresh.hidden = !state.refresh;
    },
  });
  root.querySelector('[data-authorize="spotify"]')?.addEventListener('click', () => { void actions.authorizeSpotify(); });
  appleButton?.addEventListener('click', () => { void actions.authorizeApple(); });
  root.querySelector('[data-start-sync="spotify"]')?.addEventListener('click', () => { void actions.startSync('spotify'); });
  appleStart?.addEventListener('click', () => {
    confirmation.hidden = false;
    appleStart.hidden = true;
    document.querySelector('#confirm-apple-sync').focus();
  });
  document.querySelector('#cancel-apple-sync')?.addEventListener('click', () => {
    confirmation.hidden = true;
    appleStart.hidden = false;
    appleStart.focus();
  });
  document.querySelector('#confirm-apple-sync')?.addEventListener('click', () => { void actions.startSync('apple', true); });
  refresh.addEventListener('click', () => window.location.reload());
  const spotifyResult = new URLSearchParams(window.location.search).get('spotify');
  if (spotifyResult) {
    message.textContent = spotifyResult === 'authorized'
      ? 'Spotify authorized. You can now start syncing.'
      : 'Spotify authorization did not finish. Try authorizing again.';
    history.replaceState(null, '', window.location.pathname);
  }
  if (appleButton) {
    void waitForMusicKit().then(MusicKit => prepareAppleMusic(window.location.pathname, threadRequest, MusicKit)).then(instance => {
      music = instance;
      appleReadiness.textContent = '';
      updateButtons();
    }).catch(() => {
      appleReadiness.textContent = 'Apple Music could not load. Refresh this page to try again.';
      refresh.hidden = false;
    });
  }
}

if (typeof document !== 'undefined') {
  const root = document.querySelector('#music-connections');
  if (root) mountConnections(root);
}
