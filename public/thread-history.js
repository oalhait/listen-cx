import { threadRequest } from './thread-client.js';
import { validCapability } from './subscription.js';

export function parseManagementLink(value, origin) {
  try {
    const url = new URL(value);
    const match = /^\/t\/([A-Za-z0-9_-]{22})\/?$/.exec(url.pathname);
    const key = new URLSearchParams(url.hash.slice(1)).get('manage');
    if (url.origin !== origin || url.username || url.password || !match || !validCapability(key)) throw new Error();
    return { capability: match[1], managementCapability: key };
  } catch { throw new Error('Paste the full private management link, including the part after #manage=.'); }
}

export function threadHistoryMeta(thread, created = '') {
  const relationship = thread.relationship === 'subscriber' ? 'Subscribed' : 'Owner';
  return `${relationship} · ${thread.songCount} ${thread.songCount === 1 ? 'song' : 'songs'} · ${thread.closedAt ? 'Closed' : 'Open'}${created ? ` · ${created}` : ''}`;
}

export function createHistoryController({ fetcher = fetch, request = threadRequest, update }) {
  let busy = false;
  return async (action, body = {}) => {
    if (busy) return;
    busy = true;
    update({ busy: true });
    try {
      if (action) {
        if (!['import', 'save'].includes(action)) throw new Error('Unknown action');
        await request(`/api/my-threads/${action}`, body);
      }
      const response = await fetcher('/api/my-threads', { credentials: 'same-origin', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('History unavailable');
      update({ busy: false, data: await response.json(), saved: !!action });
    } catch {
      update({ busy: false, error: action === 'import'
        ? 'Could not verify that management link. Check it and try again.'
        : 'Could not load your Threads. Try again.' });
    } finally { busy = false; }
  };
}

export function mountThreadHistory(root) {
  const find = selector => root.querySelector(selector);
  const message = find('#history-message');
  const refresh = find('#history-refresh');
  const input = find('#history-management-link');
  const load = createHistoryController({ update(state) {
    root.setAttribute('aria-busy', String(state.busy));
    root.querySelectorAll('button, input').forEach(element => { element.disabled = state.busy; });
    message.textContent = state.busy ? 'Loading your Threads…' : state.error || (state.saved ? 'Thread history saved.' : '');
    refresh.hidden = !state.error;
    if (!state.data) return;
    input.value = '';
    const list = find('#history-list');
    list.replaceChildren();
    for (const thread of state.data.threads) {
      if (!validCapability(thread.capability)) continue;
      const row = document.createElement('li');
      const link = document.createElement('a');
      link.href = `/t/${thread.capability}`;
      const title = document.createElement('strong');
      title.textContent = thread.title;
      const meta = document.createElement('span');
      const date = new Date(`${thread.createdAt.replace(' ', 'T')}Z`);
      const created = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      meta.textContent = threadHistoryMeta(thread, created);
      link.append(title, meta);
      row.append(link);
      list.append(row);
    }
    find('#history-empty').hidden = !!list.children.length;
    find('#history-storage').textContent = state.data.signedIn
      ? 'Account history is available wherever you sign in. You can also save this browser’s earlier Threads to your account.'
      : 'History is saved in this browser. Sign in to save it across devices. Clearing browser cookies will remove access to this list.';
    find('#history-save').hidden = !state.data.signedIn || !state.data.hasBrowserHistory;
  } });
  find('#history-import').addEventListener('submit', event => {
    event.preventDefault();
    try { void load('import', parseManagementLink(input.value.trim(), window.location.origin)); }
    catch (error) { message.textContent = error.message; }
  });
  find('#history-save').addEventListener('click', () => { void load('save'); });
  refresh.addEventListener('click', () => { void load(); });
  void load();
}

if (typeof document !== 'undefined') {
  const root = document.querySelector('#thread-history');
  if (root) mountThreadHistory(root);
}
