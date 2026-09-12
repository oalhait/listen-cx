import { authorizationError, tokenLifetime } from './web-authorization.mjs';
import { createJournal, findPlaylistByName, planMutation, readFullPlaylist, recordFailure, recordPlaylist, submitOperation, verifyOperation } from './same-id.mjs';

const fixtures = { A: '704790294', B: '6782695839', C: '617154366', D: '202272624' };
const steps = [
  { name: 'create', kind: 'create', desired: [fixtures.A, fixtures.B, fixtures.C] },
  { name: 'append', kind: 'append', desired: [fixtures.A, fixtures.B, fixtures.C, fixtures.D] },
  { name: 'remove', kind: 'replace', desired: [fixtures.A, fixtures.C, fixtures.D] },
  { name: 'reorder', kind: 'replace', desired: [fixtures.D, fixtures.C, fixtures.A] },
];
const status = document.querySelector('#status');
const stateView = document.querySelector('#state');
const buttons = Object.fromEntries(['authorize', 'create', 'append', 'remove', 'reorder', 'reconcile', 'read'].map(id => [id, document.querySelector(`#${id}`)]));
let music;
let tokenTimes;
let journal;
let lastReadback = null;

function journalStorageKey(sessionID) {
  return `listen-cx-apple-same-id-${sessionID}`;
}

function playlistName() {
  return `DISPOSABLE listen.cx same-ID ${journal.sessionID}`;
}

function persist(next) {
  localStorage.setItem(journalStorageKey(next.sessionID), JSON.stringify(next));
  journal = next;
  render();
}

function loadJournal(sessionID) {
  const stored = localStorage.getItem(journalStorageKey(sessionID));
  if (!stored) return createJournal(sessionID);
  const parsed = JSON.parse(stored);
  if (parsed?.version !== 1 || parsed.sessionID !== sessionID || !Array.isArray(parsed.operations) || parsed.operations.length > steps.length) throw new Error('INVALID_LOCAL_JOURNAL');
  for (const [index, operation] of parsed.operations.entries()) {
    if (operation?.name !== steps[index].name || !['reserved', 'submitted', 'verified'].includes(operation.status)) throw new Error('INVALID_LOCAL_JOURNAL');
  }
  return parsed;
}

function render() {
  if (!journal) return;
  const ready = music?.isAuthorized === true;
  const operation = journal.operations.at(-1);
  const pending = operation && operation.status !== 'verified';
  const next = pending ? operation.name : steps[journal.operations.length]?.name;
  buttons.authorize.disabled = !music || ready;
  for (const step of steps) buttons[step.name].disabled = !ready || step.name !== next || operation?.status === 'submitted';
  buttons.reconcile.disabled = !ready || !pending || operation.status !== 'submitted';
  buttons.read.disabled = !ready || !journal.playlist?.id;
  stateView.textContent = JSON.stringify({ mode: 'same-id-proof', isAuthorized: ready, storefront: journal.storefront ?? null, playlist: journal.playlist, operations: journal.operations, lastReadback }, null, 2);
}

async function request(path, options = {}) {
  const result = await music.api.music(path, {}, { fetchOptions: { method: options.method ?? 'GET', ...(options.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) } : {}) } });
  return result.data;
}

async function preflight() {
  const storefront = (await request('/v1/me/storefront')).data?.[0]?.id;
  if (!/^[a-z]{2}$/.test(storefront ?? '')) throw new Error('STOREFRONT_UNAVAILABLE');
  const ids = Object.values(fixtures);
  const result = await request(`/v1/catalog/${storefront}/songs?ids=${ids.join(',')}`);
  if (ids.some(id => !result.data?.some(song => song.id === id && song.attributes?.playParams))) throw new Error('FIXTURE_UNAVAILABLE');
  if (journal.storefront && journal.storefront !== storefront) throw new Error('STOREFRONT_CHANGED');
  if (!journal.storefront) persist({ ...journal, storefront });
}

async function verify(name, attempts = 6) {
  let failure;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      lastReadback = await readFullPlaylist(request, journal.playlist.id);
      const next = verifyOperation(journal, name, lastReadback);
      persist(next);
      return lastReadback;
    } catch (error) {
      failure = error;
      if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  throw failure;
}

async function runStep(step) {
  await preflight();
  const current = journal.playlist ? await readFullPlaylist(request, journal.playlist.id) : null;
  const plan = planMutation(current?.entries ?? null, step.desired);
  if (plan.kind !== step.kind) throw new Error('PROVIDER_STATE_DOES_NOT_MATCH_STEP');
  try {
    journal = await submitOperation(journal, step.name, plan, request, persist, step.kind === 'create' ? {
      name: playlistName(),
      description: 'Isolated listen.cx same-ID mutation proof. Preserve for verified readback.',
      isPublic: true,
    } : null);
  } catch (error) {
    if (journal.operations.find(operation => operation.name === step.name)?.status === 'submitted') persist(recordFailure(journal, step.name, authorizationError(error)));
    throw error;
  }
  await verify(step.name);
  status.textContent = `${step.name} verified on the same Apple playlist ID.`;
}

async function reconcile() {
  const operation = journal.operations.at(-1);
  if (!operation || operation.status !== 'submitted') throw new Error('NO_UNCERTAIN_WRITE');
  if (!journal.playlist && operation.name === 'create') {
    const id = await findPlaylistByName(request, playlistName());
    if (!id) throw new Error('CREATE_STILL_UNRESOLVED');
    persist(recordPlaylist(journal, 'create', id));
  }
  await verify(operation.name, 1);
  status.textContent = `${operation.name} reconciled by exact readback.`;
}

async function exclusive(callback) {
  if (!navigator.locks) throw new Error('DURABLE_BROWSER_LOCK_UNAVAILABLE');
  return navigator.locks.request('listen-cx-apple-same-id-proof', { mode: 'exclusive' }, callback);
}

function action(button, callback) {
  button.onclick = async () => {
    Object.values(buttons).forEach(item => { item.disabled = true; });
    try { await exclusive(callback); }
    catch (error) {
      const safe = authorizationError(error);
      status.textContent = safe.reason === 'UNKNOWN_ERROR' ? 'The operation did not complete. Use read and reconcile before any retry.' : safe.reason;
    }
    finally { render(); }
  };
}

action(buttons.authorize, async () => {
  if (!tokenLifetime(tokenTimes).ready) throw new Error('DEVELOPER_TOKEN_EXPIRED');
  await music.authorize();
  if (!music.isAuthorized) throw new Error('AUTHORIZATION_INCOMPLETE');
  await preflight();
  status.textContent = 'Apple Music authorized. No playlist write has run.';
});
for (const step of steps) action(buttons[step.name], () => runStep(step));
action(buttons.reconcile, reconcile);
action(buttons.read, async () => {
  lastReadback = await readFullPlaylist(request, journal.playlist.id);
  status.textContent = 'Current Apple playlist read successfully.';
  render();
});

async function initialize() {
  const invite = new URLSearchParams(window.location.hash.slice(1)).get('invite');
  window.history.replaceState(null, '', '/same-id');
  if (invite) {
    const session = await fetch('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite }) });
    if (!session.ok) throw new Error('INVITATION_UNAVAILABLE');
  }
  const response = await fetch('/developer-token');
  if (!response.ok) throw new Error(response.status === 410 ? 'SESSION_EXPIRED' : 'INVITATION_REQUIRED');
  const { developerToken, issuedAt, expiresAt } = await response.json();
  tokenTimes = { issuedAt, expiresAt };
  journal = loadJournal(`s${issuedAt}`);
  document.addEventListener('musickitloaded', async () => {
    try {
      await window.MusicKit.configure({ developerToken, app: { name: 'listen.cx disposable same-ID proof', build: '1' } });
      music = window.MusicKit.getInstance();
      music.addEventListener('authorizationStatusDidChange', render);
      status.textContent = music.isAuthorized ? 'Apple Music is authorized. Review the next operation before running it.' : 'Ready to authorize Apple Music.';
      render();
    } catch { status.textContent = 'MusicKit initialization failed.'; }
  });
  const script = document.createElement('script');
  script.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
  document.head.append(script);
  render();
}

try { await initialize(); } catch { status.textContent = 'The protected same-ID proof could not initialize.'; }
