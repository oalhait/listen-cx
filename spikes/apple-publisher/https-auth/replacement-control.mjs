import { authorizationError, tokenLifetime } from './web-authorization.mjs';
import { planMutation, readFullPlaylist } from './same-id.mjs';
import { classifyAppleResponse, createTransportObserver } from './transport-observer.mjs';
import { directFallbackEligible, loadReplacementJournal, loadSDKJournalForFallback, recordCreation, recordReplacementReadback, recordReplacementTransport, reserveReplacementOperation, saveReplacementJournal, verifyReplacementOperation } from './replacement-proof.mjs';

const initial = ['704790294', '6782695839', '617154366'];
const desired = ['617154366', '704790294'];
const mode = window.location.pathname === '/replacement-direct' ? 'direct' : 'sdk';
const status = document.querySelector('#status');
const stateView = document.querySelector('#state');
const buttons = Object.fromEntries(['authorize', 'run', 'create', 'replace', 'read'].map(id => [id, document.querySelector(`#${id}`)]));
let music;
let tokenTimes;
let developerToken;
let directUserToken = null;
let journal;
let lastReadback = null;
let observer;

function playlistName() {
  return `DISPOSABLE listen.cx replacement ${mode} ${journal.sessionID}`;
}

function same(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function persist(next) {
  saveReplacementJournal(localStorage, next);
  journal = next;
  render();
}

function render() {
  if (!journal) return;
  const authorized = music?.isAuthorized === true && (mode === 'sdk' || typeof directUserToken === 'string');
  const create = journal.operations[0];
  const replace = journal.operations[1];
  buttons.authorize.disabled = !music || authorized;
  buttons.run.disabled = !authorized || Boolean(create && create.status !== 'verified') || Boolean(replace);
  buttons.create.disabled = !authorized || Boolean(create);
  buttons.replace.disabled = !authorized || create?.status !== 'verified' || Boolean(replace);
  buttons.read.disabled = !authorized || !journal.playlist?.id;
  stateView.textContent = JSON.stringify({ mode: `${mode}-replacement-proof`, isAuthorized: music?.isAuthorized === true, storefront: journal.storefront, playlist: journal.playlist, operations: journal.operations, lastReadback }, null, 2);
}

async function request(path, options = {}) {
  const result = await music.api.music(path, {}, { fetchOptions: { method: options.method ?? 'GET', ...(options.body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) } : {}) } });
  return result?.data ?? null;
}

async function preflight() {
  const storefront = (await request('/v1/me/storefront')).data?.[0]?.id;
  if (!/^[a-z]{2}$/.test(storefront ?? '')) throw new Error('STOREFRONT_UNAVAILABLE');
  const result = await request(`/v1/catalog/${storefront}/songs?ids=${initial.join(',')}`);
  if (initial.some(id => !result.data?.some(song => song.id === id && song.attributes?.playParams))) throw new Error('FIXTURE_UNAVAILABLE');
  if (journal.storefront && journal.storefront !== storefront) throw new Error('STOREFRONT_CHANGED');
  if (!journal.storefront) persist({ ...journal, storefront });
}

async function readUntil(expected, attempts = 6) {
  let readback;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    readback = await readFullPlaylist(request, journal.playlist.id);
    if (same(readback.entries.map(entry => entry.catalogId), expected)) return readback;
    if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return readback;
}

async function createPlaylist() {
  await preflight();
  journal = reserveReplacementOperation(journal, 'create', initial);
  persist(journal);
  journal = reserveReplacementOperation(journal, 'create', initial, true);
  persist(journal);
  const result = await request('/v1/me/library/playlists', {
    method: 'POST',
    body: {
      attributes: { name: playlistName(), description: 'Isolated listen.cx fresh replacement proof. Preserve for verified readback.', isPublic: true },
      relationships: { tracks: { data: initial.map(id => ({ id, type: 'songs' })) } },
    },
  });
  journal = recordCreation(journal, result.data?.[0]?.id);
  persist(journal);
  lastReadback = await readUntil(initial);
  journal = verifyReplacementOperation(journal, 'create', lastReadback);
  persist(journal);
  status.textContent = `Fresh ${mode} destination created and exact A–B–C order verified.`;
}

async function replaceWithSDK(path, body) {
  observer.begin({ method: 'PUT', path });
  let error = null;
  try { await request(path, { method: 'PUT', body }); }
  catch (caught) { error = caught; }
  const transport = await observer.finish();
  return { transport, error };
}

async function replaceDirect(path, body) {
  let response;
  try {
    response = await fetch(`https://api.music.apple.com${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${developerToken}`, 'Music-User-Token': directUserToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const classified = await classifyAppleResponse(response);
    return {
      transport: { method: 'PUT', path, issued: true, responseExposed: true, ...classified },
      error: response.ok ? null : Object.assign(new Error('DIRECT_REPLACEMENT_REJECTED'), { status: response.status }),
    };
  } catch (error) {
    return { transport: { method: 'PUT', path, issued: true, responseExposed: false, httpStatus: null, appleErrorCode: null }, error };
  }
}

async function replacePlaylist() {
  await preflight();
  const current = await readFullPlaylist(request, journal.playlist.id);
  if (!same(current.entries.map(entry => entry.catalogId), initial) || current.metadata.canEdit !== true) throw new Error('INITIAL_DESTINATION_NOT_EDITABLE');
  const plan = planMutation(current.entries, desired);
  if (plan.kind !== 'replace') throw new Error('REPLACEMENT_PLAN_UNAVAILABLE');
  journal = reserveReplacementOperation(journal, 'replace', desired);
  persist(journal);
  journal = reserveReplacementOperation(journal, 'replace', desired, true);
  persist(journal);
  const path = `/v1/me/library/playlists/${encodeURIComponent(journal.playlist.id)}/tracks`;
  const body = { data: plan.payload };
  const result = mode === 'sdk' ? await replaceWithSDK(path, body) : await replaceDirect(path, body);
  journal = recordReplacementTransport(journal, result.transport);
  persist(journal);
  lastReadback = await readUntil(desired);
  journal = recordReplacementReadback(journal, lastReadback);
  persist(journal);
  if (same(lastReadback.entries.map(entry => entry.catalogId), desired)) {
    journal = verifyReplacementOperation(journal, 'replace', lastReadback);
    persist(journal);
    status.textContent = `${mode === 'sdk' ? 'SDK' : 'Direct'} replacement verified C–A on the same playlist ID.`;
    return;
  }
  if (result.error) throw result.error;
  throw new Error('REPLACEMENT_NOT_OBSERVED');
}

async function exclusive(callback) {
  if (!navigator.locks) throw new Error('DURABLE_BROWSER_LOCK_UNAVAILABLE');
  return navigator.locks.request(`listen-cx-apple-replacement-${mode}`, { mode: 'exclusive' }, async () => {
    journal = loadReplacementJournal(localStorage, mode, () => `${mode}-${crypto.randomUUID()}`);
    render();
    return callback();
  });
}

function action(button, callback) {
  button.onclick = async () => {
    Object.values(buttons).forEach(item => { item.disabled = true; });
    try { await exclusive(callback); }
    catch (error) {
      const safe = authorizationError(error);
      status.textContent = safe.reason === 'UNKNOWN_ERROR' ? 'The operation is uncertain. Inspect safe state and exact readback before any next action.' : safe.reason;
    }
    finally { render(); }
  };
}

action(buttons.authorize, async () => {
  if (!tokenLifetime(tokenTimes).ready) throw new Error('TOKEN_EXPIRED');
  const authorization = await music.authorize();
  if (!music.isAuthorized) throw new Error('AUTHORIZATION_INCOMPLETE');
  if (mode === 'direct') {
    if (typeof authorization !== 'string' || authorization.length === 0) throw new Error('AUTHORIZATION_INCOMPLETE');
    directUserToken = authorization;
  }
  await preflight();
  status.textContent = 'Apple Music authorized. No playlist write has run.';
});
action(buttons.run, async () => {
  if (!journal.operations[0]) await createPlaylist();
  if (journal.operations[0]?.status === 'verified' && !journal.operations[1]) await replacePlaylist();
});
action(buttons.create, createPlaylist);
action(buttons.replace, replacePlaylist);
action(buttons.read, async () => {
  lastReadback = await readFullPlaylist(request, journal.playlist.id);
  status.textContent = 'Current disposable playlist read successfully.';
  render();
});

async function initialize() {
  if (mode === 'direct' && !directFallbackEligible(loadSDKJournalForFallback(localStorage))) throw new Error('DIRECT_FALLBACK_NOT_ELIGIBLE');
  const invite = new URLSearchParams(window.location.hash.slice(1)).get('invite');
  window.history.replaceState(null, '', `/replacement-${mode}`);
  if (invite) {
    const session = await fetch('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite }) });
    if (!session.ok) throw new Error('INVITATION_UNAVAILABLE');
  }
  const response = await fetch('/developer-token');
  if (!response.ok) throw new Error(response.status === 410 ? 'SESSION_EXPIRED' : 'INVITATION_REQUIRED');
  const token = await response.json();
  developerToken = token.developerToken;
  tokenTimes = { issuedAt: token.issuedAt, expiresAt: token.expiresAt };
  journal = loadReplacementJournal(localStorage, mode, () => `${mode}-${crypto.randomUUID()}`);
  if (mode === 'sdk') observer = createTransportObserver(globalThis);
  document.addEventListener('musickitloaded', async () => {
    try {
      await window.MusicKit.configure({ developerToken, app: { name: `listen.cx disposable ${mode} replacement proof`, build: '1' } });
      music = window.MusicKit.getInstance();
      music.addEventListener('authorizationStatusDidChange', render);
      status.textContent = 'Ready to authorize Apple Music.';
      render();
    } catch { status.textContent = 'MusicKit initialization failed.'; }
  });
  const script = document.createElement('script');
  script.src = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
  document.head.append(script);
  window.addEventListener('pagehide', () => observer?.dispose(), { once: true });
  render();
}

try { await initialize(); }
catch { status.textContent = mode === 'direct' ? 'Direct fallback is unavailable until the SDK proof records an eligible transport failure.' : 'The protected replacement proof could not initialize.'; }
