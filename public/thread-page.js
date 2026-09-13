import {
  createThreadController,
  createConnectionController,
  newCapability,
  threadRequest,
  watchManagementLink,
  copyThreadLink,
} from './thread-client.js';

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{22}$/;

function requestKey() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : newCapability();
}

export function publicThreadUrl(origin, capability) {
  if (!CAPABILITY_PATTERN.test(capability)) throw new Error('Invalid Jam capability');
  return new URL(`/t/${encodeURIComponent(capability)}`, new URL(origin).origin).href;
}

export async function shareThread({ title, url, navigatorObject }) {
  if (typeof navigatorObject?.share === 'function') {
    try {
      await navigatorObject.share({ title, text: `Join “${title}” on listen.cx`, url });
      return 'shared';
    } catch (error) {
      if (error?.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    await navigatorObject?.clipboard?.writeText(url);
    if (!navigatorObject?.clipboard) throw new Error('Clipboard unavailable');
    return 'copied';
  } catch {
    return 'manual';
  }
}

export function voteButtonLabel(title, direction, count, selected = false) {
  const noun = `${direction}vote${count === 1 ? '' : 's'}`;
  return selected
    ? `Remove your ${direction}vote from ${title}, ${count} ${noun}`
    : `${direction === 'up' ? 'Upvote' : 'Downvote'} ${title}, ${count} ${noun}`;
}

export function isJoinedViewer(viewer) {
  return viewer?.joined === true;
}

export function createCollaborationPoller({
  refresh,
  onState = () => {},
  isVisible = () => true,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = timer => clearTimeout(timer),
  visibleDelay = 3000,
  hiddenDelay = 30000,
}) {
  let timer;
  let running = false;
  let stopped = false;
  let failures = 0;

  const clear = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };
  const delay = () => {
    if (!isVisible()) return hiddenDelay;
    return failures === 0
      ? visibleDelay
      : Math.min(hiddenDelay, visibleDelay * (2 ** Math.min(failures, 3)));
  };
  const queue = () => {
    clear();
    if (!stopped) timer = schedule(() => { void run(); }, delay());
  };
  const run = async () => {
    if (stopped || running) return;
    running = true;
    clear();
    onState('refreshing');
    try {
      await refresh();
      failures = 0;
      onState('live');
    } catch (error) {
      failures += 1;
      onState('stale', error);
    } finally {
      running = false;
      queue();
    }
  };

  return {
    start: () => run(),
    refresh: () => run(),
    visibilityChanged() {
      clear();
      if (isVisible()) void run();
      else queue();
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 2048
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function contributorPresentation(song) {
  return {
    displayName: String(song?.addedBy?.displayName || 'Guest'),
    avatarUrl: safeHttpsUrl(song?.addedBy?.avatarUrl),
  };
}

export function reconcileContributorBylines(contributions, rowFor, update) {
  for (const contribution of Array.isArray(contributions) ? contributions : []) {
    if (!Number.isSafeInteger(contribution?.id)) continue;
    const row = rowFor(String(contribution.id));
    if (row) update(row, contributorPresentation(contribution));
  }
}

function messageDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const normalized = typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function setFormBusy(container, busy) {
  if (!container) return;
  container.setAttribute('aria-busy', String(busy));
  container.querySelectorAll('button, input, textarea').forEach(element => {
    if (busy) {
      element.dataset.disabledBeforeBusy = String(element.disabled);
      element.disabled = true;
    } else {
      element.disabled = element.dataset.disabledBeforeBusy === 'true';
      delete element.dataset.disabledBeforeBusy;
    }
  });
}

function selectLink(root, element) {
  const range = root.createRange();
  range.selectNodeContents(element);
  const selection = root.defaultView.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function responseSignal(root) {
  return typeof root.defaultView.AbortSignal?.timeout === 'function'
    ? root.defaultView.AbortSignal.timeout(10000)
    : undefined;
}

async function getJson(root, path) {
  const response = await root.defaultView.fetch(path, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal: responseSignal(root),
  });
  if (!response.ok) throw new Error(`Live update failed (${response.status})`);
  return response.json();
}

export function mountThreadPage(root = document) {
  const message = root.querySelector('#thread-message');
  const thread = root.querySelector('#thread');
  const createForm = root.querySelector('#thread-create-form');
  if (!message) return null;

  const storageKey = `thread-request:${thread?.dataset.capability ?? 'create'}`;
  const storage = {
    read() {
      try { return JSON.parse(root.defaultView.sessionStorage.getItem(storageKey)); }
      catch { return null; }
    },
    write(value) {
      try {
        if (value) root.defaultView.sessionStorage.setItem(storageKey, JSON.stringify(value));
        else root.defaultView.sessionStorage.removeItem(storageKey);
      } catch {}
    },
  };

  let coreScope = null;
  let coreIntent = null;
  let corePending = false;
  let poller = null;
  let queueRevision = Number(thread?.dataset.revision ?? -1);
  let collaboration = null;
  const pendingVotes = new Set();
  const voteAttempts = new Map();
  const deleteAttempts = new Map();
  let chatAttempt = null;

  const managed = () => thread?.dataset.managed === 'true';
  const open = () => thread?.dataset.open === 'true';
  const participating = () => isJoinedViewer(collaboration?.viewer);

  function restoreCoreScope() {
    setFormBusy(coreScope, false);
    coreScope = null;
    corePending = false;
  }

  const controller = createThreadController({
    storage,
    update(state) {
      if (state.status === 'loading') {
        corePending = true;
        setFormBusy(coreScope, true);
        message.classList.remove('is-error');
        message.textContent = 'Saving…';
        return;
      }

      restoreCoreScope();
      message.classList.toggle('is-error', state.status === 'error');
      if (state.status === 'error') {
        message.textContent = state.error;
        if (['stale_revision', 'closed'].includes(state.code)) root.querySelector('#refresh-thread')?.removeAttribute('hidden');
        return;
      }
      if (state.status !== 'success') return;

      if (thread) {
        if (state.data?.thread) applyThreadSnapshot(state.data.thread);
        if (coreIntent === 'add') {
          const input = root.querySelector('#thread-song-url');
          if (input) input.value = '';
          message.textContent = 'Song added to the Jam.';
        } else {
          message.textContent = 'Jam updated.';
        }
        coreIntent = null;
        void poller?.refresh();
        return;
      }

      createForm.hidden = true;
      const { publicUrl, managementUrl } = state.data;
      for (const [id, url] of [['public-link', publicUrl], ['management-link', managementUrl]]) {
        const link = root.getElementById(id);
        link.href = url;
        link.textContent = url;
      }
      root.querySelector('#open-thread').href = publicUrl;
      root.querySelector('#thread-created').hidden = false;
      message.textContent = 'Share the public link, and save your private management link.';
      root.querySelector('#open-thread').focus();
    },
  });

  function submitCore(path, body, scope, intent) {
    if (corePending) {
      message.textContent = 'Finish the current Jam change before starting another.';
      return;
    }
    coreScope = scope;
    coreIntent = intent;
    void controller.submit(path, body);
  }

  createForm?.addEventListener('submit', event => {
    event.preventDefault();
    submitCore('/api/threads', { title: root.querySelector('#thread-title').value.trim() }, createForm, 'create');
  });

  function manage(intent, scope) {
    submitCore(`/t/${thread.dataset.capability}/manage/mutate`, {
      ...intent,
      expectedRevision: Number(thread.dataset.revision),
    }, scope, intent.kind);
  }

  function focusKey() {
    const active = root.activeElement;
    const row = active?.closest?.('[data-contribution-id]');
    if (!row) return null;
    const kind = active.dataset.vote ? `vote:${active.dataset.vote}`
      : active.dataset.move ? `move:${active.dataset.move}`
        : active.hasAttribute('data-remove') ? 'remove' : null;
    return kind ? { id: row.dataset.contributionId, kind } : null;
  }

  function restoreFocus(key) {
    if (!key) return;
    const row = [...root.querySelectorAll('[data-contribution-id]')]
      .find(candidate => candidate.dataset.contributionId === key.id);
    if (!row) return;
    const [kind, value] = key.kind.split(':');
    const control = kind === 'vote' ? row.querySelector(`[data-vote="${value}"]`)
      : kind === 'move' ? row.querySelector(`[data-move="${value}"]`)
        : row.querySelector('[data-remove]');
    control?.focus({ preventScroll: true });
  }

  function avatar(url, name, className) {
    const safe = safeHttpsUrl(url);
    if (safe) {
      const image = root.createElement('img');
      image.className = className;
      image.src = safe;
      image.alt = '';
      image.width = className === 'contributor-avatar' ? 20 : 28;
      image.height = image.width;
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      return image;
    }
    if (className === 'contributor-avatar') return null;
    const placeholder = root.createElement('span');
    placeholder.className = 'chat-avatar-placeholder';
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.textContent = [...String(name || '?')][0] || '?';
    return placeholder;
  }

  function voteGroup(song) {
    const group = root.createElement('div');
    group.className = 'song-votes';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', `Vote on ${song.title}`);
    for (const direction of ['up', 'down']) {
      if (direction === 'down') {
        const score = root.createElement('span');
        score.className = 'vote-score';
        score.dataset.voteScore = '';
        score.setAttribute('aria-label', 'Score 0');
        score.textContent = '0';
        group.append(score);
      }
      const button = root.createElement('button');
      button.className = 'vote-button';
      button.type = 'button';
      button.dataset.vote = direction;
      button.dataset.id = String(song.id);
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-label', voteButtonLabel(song.title, direction, 0));
      button.disabled = true;
      const arrow = root.createElement('span');
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = direction === 'up' ? '↑' : '↓';
      const count = root.createElement('span');
      count.dataset.voteCount = direction;
      count.textContent = '0';
      button.append(arrow, count);
      group.append(button);
    }
    return group;
  }

  function updateContributorByline(row, presentation) {
    let contributor = row.querySelector('.song-contributor');
    if (!contributor) {
      contributor = root.createElement('span');
      contributor.className = 'song-contributor';
      row.querySelector('.track-meta')?.append(contributor);
    }
    const signature = JSON.stringify(presentation);
    if (contributor.dataset.signature === signature) return;
    contributor.dataset.signature = signature;
    const contributorAvatar = avatar(presentation.avatarUrl, presentation.displayName, 'contributor-avatar');
    const contributorText = root.createElement('span');
    contributorText.textContent = `Added by ${presentation.displayName}`;
    contributor.replaceChildren(...(contributorAvatar ? [contributorAvatar, contributorText] : [contributorText]));
  }

  function refreshContributorBylines(songs) {
    const rows = new Map([...root.querySelectorAll('[data-contribution-id]')]
      .map(row => [row.dataset.contributionId, row]));
    reconcileContributorBylines(songs, id => rows.get(id), updateContributorByline);
  }

  function songRow(song, index, count) {
    const row = root.createElement('li');
    row.className = 'thread-song';
    row.dataset.contributionId = String(song.id);
    const art = safeHttpsUrl(song.artworkUrl);
    if (art) {
      const image = root.createElement('img');
      image.src = art;
      image.alt = '';
      image.width = 52;
      image.height = 52;
      image.loading = 'lazy';
      row.append(image);
    }
    const metadata = root.createElement('div');
    metadata.className = 'track-meta';
    const link = root.createElement('a');
    link.href = `/${encodeURIComponent(String(song.linkSlug ?? ''))}`;
    const title = root.createElement('strong');
    title.textContent = String(song.title ?? 'Unknown song');
    link.append(title);
    const artist = root.createElement('span');
    artist.textContent = String(song.artist ?? 'Unknown artist');
    const contributor = root.createElement('span');
    contributor.className = 'song-contributor';
    metadata.append(link, artist, contributor);
    row.append(metadata, voteGroup({ ...song, title: title.textContent }));
    updateContributorByline(row, contributorPresentation(song));

    if (managed() && open() && thread.dataset.reorderable === 'true') {
      const actions = root.createElement('div');
      actions.className = 'song-actions';
      for (const direction of ['up', 'down']) {
        const button = root.createElement('button');
        button.type = 'button';
        button.dataset.move = direction;
        button.dataset.id = String(song.id);
        button.setAttribute('aria-label', `Move ${title.textContent} ${direction}`);
        button.textContent = direction === 'up' ? '↑' : '↓';
        button.disabled = direction === 'up' ? index === 0 : index === count - 1;
        actions.append(button);
      }
      const remove = root.createElement('button');
      remove.type = 'button';
      remove.dataset.remove = String(song.id);
      remove.setAttribute('aria-label', `Remove ${title.textContent}`);
      remove.textContent = 'Remove';
      actions.append(remove);
      row.append(actions);
    }
    return row;
  }

  function applyThreadSnapshot(snapshot) {
    if (!thread || !snapshot || snapshot.publicCapability !== thread.dataset.capability) return;
    const revision = Number(snapshot.revision);
    if (!Number.isSafeInteger(revision) || revision < queueRevision) return;
    const isOpen = snapshot.closedAt == null;
    const appleConnected = Array.isArray(snapshot.publications)
      && snapshot.publications.some(publication => publication?.provider === 'apple' && publication.connected);
    thread.dataset.open = String(isOpen);
    thread.dataset.reorderable = String(isOpen && !appleConnected);
    thread.dataset.revision = String(revision);
    root.querySelector('#thread-description').textContent = isOpen
      ? 'A shared collection of songs, votes, and conversation.'
      : 'This Thread is closed. The Jam is read-only, but its songs and conversation are still here.';
    root.querySelector('#add-song-form')?.toggleAttribute('hidden', !isOpen);
    root.querySelector('#thread-management')?.toggleAttribute('hidden', !isOpen);

    const songs = Array.isArray(snapshot.contributions) ? snapshot.contributions : [];
    if (revision !== queueRevision) {
      const key = focusKey();
      const list = root.querySelector('#thread-song-list');
      list.replaceChildren(...songs.map((song, index) => songRow(song, index, songs.length)));
      root.querySelector('#song-count').textContent = `${songs.length} ${songs.length === 1 ? 'song' : 'songs'}`;
      root.querySelector('#thread-empty').hidden = songs.length !== 0;
      queueRevision = revision;
      updateVotes();
      restoreFocus(key);
    }
    refreshContributorBylines(songs);
    updateParticipation();
  }

  function updateVotes() {
    if (!thread) return;
    const votes = new Map((Array.isArray(collaboration?.votes) ? collaboration.votes : [])
      .filter(vote => Number.isSafeInteger(vote?.contributionId))
      .map(vote => [String(vote.contributionId), vote]));
    for (const row of root.querySelectorAll('[data-contribution-id]')) {
      const id = row.dataset.contributionId;
      const vote = votes.get(id) ?? {};
      const title = row.querySelector('.track-meta strong')?.textContent || 'this song';
      const canVote = open() && participating() && !pendingVotes.has(id);
      for (const direction of ['up', 'down']) {
        const button = row.querySelector(`[data-vote="${direction}"]`);
        if (!button) continue;
        const count = Number.isSafeInteger(vote[`${direction}votes`]) ? vote[`${direction}votes`] : 0;
        const selected = vote.myVote === direction;
        button.disabled = !canVote;
        button.setAttribute('aria-pressed', String(selected));
        button.setAttribute('aria-label', voteButtonLabel(title, direction, count, selected));
        button.title = !open() ? 'Voting is closed.' : !participating() ? 'Join the Jam to vote.' : '';
        button.querySelector(`[data-vote-count="${direction}"]`).textContent = String(count);
      }
      const score = row.querySelector('[data-vote-score]');
      const value = Number.isSafeInteger(vote.score) ? vote.score : 0;
      if (score) {
        score.textContent = String(value);
        score.setAttribute('aria-label', `Score ${value}`);
      }
    }
  }

  function updateParticipation() {
    if (!thread || !collaboration) return;
    const canParticipate = open() && participating();
    const join = root.querySelector('#jam-join-form');
    const viewer = root.querySelector('#jam-viewer');
    const composer = root.querySelector('#chat-form');
    const readOnly = root.querySelector('#chat-readonly');
    if (join) join.hidden = !open() || participating();
    const joinInput = root.querySelector('#jam-display-name');
    if (
      joinInput
      && !joinInput.value
      && root.activeElement !== joinInput
      && typeof collaboration.viewer.displayName === 'string'
    ) {
      joinInput.value = collaboration.viewer.displayName;
    }
    if (viewer) {
      viewer.hidden = !canParticipate;
      const name = root.querySelector('#jam-viewer-name');
      if (name) name.textContent = collaboration.viewer.displayName || (collaboration.viewer.signedIn ? 'your account' : 'Guest');
    }
    if (composer) composer.hidden = !canParticipate;
    if (readOnly) {
      readOnly.hidden = canParticipate || !open();
      readOnly.textContent = 'Join the Jam to vote and send messages.';
    }
    updateVotes();
  }

  function renderMessageRow(item, row) {
    const authorName = String(item.author?.displayName || 'Guest');
    const signature = JSON.stringify([
      authorName,
      item.author?.avatarUrl ?? null,
      item.text ?? '',
      item.createdAt ?? '',
      Boolean(item.deleted),
      managed(),
    ]);
    if (row.dataset.signature === signature) return;
    row.dataset.signature = signature;
    row.className = `chat-message${item.deleted ? ' is-deleted' : ''}`;
    row.replaceChildren();
    row.append(avatar(item.author?.avatarUrl, authorName, 'chat-avatar'));

    const heading = root.createElement('div');
    heading.className = 'chat-message-heading';
    const name = root.createElement('strong');
    name.textContent = authorName;
    const time = root.createElement('time');
    time.dateTime = String(item.createdAt || '');
    const date = messageDate(item.createdAt);
    time.textContent = date ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    if (date) time.title = date.toLocaleString();
    heading.append(name, time);

    const body = root.createElement('div');
    body.className = 'chat-message-body';
    const text = root.createElement('p');
    text.textContent = item.deleted ? 'Message removed by a Jam manager.' : String(item.text ?? '');
    body.append(text);
    if (managed() && !item.deleted) {
      const remove = root.createElement('button');
      remove.type = 'button';
      remove.className = 'chat-delete';
      remove.dataset.deleteMessage = String(item.id);
      remove.setAttribute('aria-label', `Remove message from ${authorName}`);
      remove.textContent = 'Remove message';
      body.append(remove);
    }
    row.append(heading, body);
  }

  function renderMessages(messages) {
    const list = root.querySelector('#chat-message-list');
    if (!list) return;
    const nearBottom = list.parentElement.scrollHeight - list.parentElement.scrollTop - list.parentElement.clientHeight < 56;
    const existing = new Map([...list.children].map(row => [row.dataset.messageId, row]));
    const kept = new Set();
    for (const item of Array.isArray(messages) ? messages : []) {
      if (!Number.isSafeInteger(item?.id) || item.id < 1) continue;
      const id = String(item.id);
      let row = existing.get(id);
      if (!row) {
        row = root.createElement('li');
        row.dataset.messageId = id;
      }
      renderMessageRow(item, row);
      list.append(row);
      kept.add(id);
    }
    for (const [id, row] of existing) if (!kept.has(id)) row.remove();
    root.querySelector('#chat-empty').hidden = list.children.length !== 0;
    if (nearBottom) list.parentElement.scrollTop = list.parentElement.scrollHeight;
    if (list.parentElement.getAttribute('aria-live') === 'off') {
      root.defaultView.requestAnimationFrame(() => list.parentElement.setAttribute('aria-live', 'polite'));
    }
  }

  function applyCollaborationSnapshot(data) {
    if (!thread || !data || typeof data !== 'object' || !data.viewer) return;
    collaboration = data;
    const count = Number.isSafeInteger(data.participantCount) && data.participantCount >= 0 ? data.participantCount : 0;
    root.querySelector('#participant-count').textContent = `${count} ${count === 1 ? 'participant' : 'participants'}`;
    const limit = Number.isSafeInteger(data.limits?.messageLength) && data.limits.messageLength > 0
      ? Math.min(data.limits.messageLength, 2000)
      : 500;
    const chatInput = root.querySelector('#chat-message');
    if (chatInput) chatInput.maxLength = limit;
    updateChatCounter();
    renderMessages(data.messages);
    updateParticipation();
  }

  function updateChatCounter() {
    const input = root.querySelector('#chat-message');
    const counter = root.querySelector('#chat-counter');
    if (input && counter) counter.textContent = `${input.value.length} / ${input.maxLength}`;
  }

  async function refreshLive() {
    const capability = encodeURIComponent(thread.dataset.capability);
    const [snapshot, social] = await Promise.all([
      getJson(root, `/api/threads/${capability}`),
      getJson(root, `/api/threads/${capability}/collaboration`),
    ]);
    applyThreadSnapshot(snapshot);
    applyCollaborationSnapshot(social);
  }

  async function joinJam() {
    const form = root.querySelector('#jam-join-form');
    const input = root.querySelector('#jam-display-name');
    const status = root.querySelector('#join-status');
    const displayName = input.value.trim();
    if (!displayName) {
      input.setAttribute('aria-invalid', 'true');
      status.textContent = 'Enter a display name to join.';
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    setFormBusy(form, true);
    status.textContent = 'Joining…';
    try {
      const data = await threadRequest(`/api/threads/${thread.dataset.capability}/collaboration/join`, { displayName });
      if (data?.collaboration) applyCollaborationSnapshot(data.collaboration);
      else if (data?.viewer) applyCollaborationSnapshot(data);
      else await poller.refresh();
      status.textContent = '';
    } catch (error) {
      status.textContent = error.code ? error.message : 'Could not join the Jam. Try again.';
      input.setAttribute('aria-invalid', 'true');
      input.focus();
    } finally {
      setFormBusy(form, false);
    }
  }

  async function castVote(button) {
    const id = Number(button.dataset.id);
    if (!Number.isSafeInteger(id) || !participating() || !open() || pendingVotes.has(String(id))) return;
    const current = (collaboration.votes ?? []).find(vote => vote.contributionId === id)?.myVote ?? null;
    const desired = current === button.dataset.vote ? 'clear' : button.dataset.vote;
    const previous = voteAttempts.get(id);
    const attempt = previous?.vote === desired ? previous : { vote: desired, key: requestKey() };
    voteAttempts.set(id, attempt);
    pendingVotes.add(String(id));
    updateVotes();
    const status = root.querySelector('#chat-status');
    status.textContent = 'Saving your vote…';
    try {
      const data = await threadRequest(`/api/threads/${thread.dataset.capability}/votes`, {
        contributionId: id,
        vote: desired,
        requestKey: attempt.key,
      });
      voteAttempts.delete(id);
      if (data?.collaboration) applyCollaborationSnapshot(data.collaboration);
      else if (data?.viewer) applyCollaborationSnapshot(data);
      else await poller.refresh();
      status.textContent = 'Vote saved.';
    } catch (error) {
      status.textContent = error.code ? error.message : 'Could not save your vote. Try again.';
    } finally {
      pendingVotes.delete(String(id));
      updateVotes();
    }
  }

  async function sendMessage() {
    const form = root.querySelector('#chat-form');
    const input = root.querySelector('#chat-message');
    const status = root.querySelector('#chat-status');
    const text = input.value.trim();
    if (!text) {
      input.setAttribute('aria-invalid', 'true');
      status.textContent = 'Write a message before sending.';
      input.focus();
      return;
    }
    if (text.length > input.maxLength) {
      input.setAttribute('aria-invalid', 'true');
      status.textContent = `Keep your message under ${input.maxLength} characters.`;
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    if (!chatAttempt || chatAttempt.text !== text) chatAttempt = { text, key: requestKey() };
    setFormBusy(form, true);
    status.textContent = 'Sending…';
    try {
      const data = await threadRequest(`/api/threads/${thread.dataset.capability}/messages`, {
        text,
        requestKey: chatAttempt.key,
      });
      chatAttempt = null;
      input.value = '';
      updateChatCounter();
      if (data?.collaboration) applyCollaborationSnapshot(data.collaboration);
      else if (data?.viewer) applyCollaborationSnapshot(data);
      else await poller.refresh();
      status.textContent = 'Message sent.';
      input.focus({ preventScroll: true });
    } catch (error) {
      status.textContent = error.code ? error.message : 'Could not send your message. Your draft is still here.';
      input.focus({ preventScroll: true });
    } finally {
      setFormBusy(form, false);
    }
  }

  async function deleteMessage(button) {
    const id = Number(button.dataset.deleteMessage);
    if (!managed() || !Number.isSafeInteger(id) || deleteAttempts.has(id)) return;
    const attempt = { key: requestKey() };
    deleteAttempts.set(id, attempt);
    const row = button.closest('[data-message-id]');
    setFormBusy(row, true);
    const status = root.querySelector('#chat-status');
    status.textContent = 'Removing message…';
    try {
      const data = await threadRequest(`/t/${thread.dataset.capability}/manage/messages`, {
        messageId: id,
        requestKey: attempt.key,
      });
      deleteAttempts.delete(id);
      if (data?.collaboration) applyCollaborationSnapshot(data.collaboration);
      else if (data?.viewer) applyCollaborationSnapshot(data);
      else await poller.refresh();
      status.textContent = 'Message removed.';
    } catch (error) {
      status.textContent = error.code ? error.message : 'Could not remove that message. Try again.';
    } finally {
      setFormBusy(row, false);
    }
  }

  if (thread) {
    const addForm = root.querySelector('#add-song-form');
    addForm?.addEventListener('submit', event => {
      event.preventDefault();
      submitCore(`/api/threads/${thread.dataset.capability}/contributions`, {
        url: root.querySelector('#thread-song-url').value.trim(),
        expectedRevision: Number(thread.dataset.revision),
      }, addForm, 'add');
    });

    root.querySelector('#jam-join-form')?.addEventListener('submit', event => {
      event.preventDefault();
      void joinJam();
    });
    root.querySelector('#jam-display-name')?.addEventListener('input', event => {
      event.currentTarget.removeAttribute('aria-invalid');
      root.querySelector('#join-status').textContent = '';
    });
    root.querySelector('#chat-form')?.addEventListener('submit', event => {
      event.preventDefault();
      void sendMessage();
    });
    root.querySelector('#chat-message')?.addEventListener('input', event => {
      if (chatAttempt?.text !== event.currentTarget.value.trim()) chatAttempt = null;
      event.currentTarget.removeAttribute('aria-invalid');
      updateChatCounter();
    });

    thread.addEventListener('click', event => {
      const button = event.target.closest?.('button');
      if (!button || !thread.contains(button)) return;
      if (button.dataset.vote) { void castVote(button); return; }
      if (button.dataset.deleteMessage) { void deleteMessage(button); return; }
      if (button.hasAttribute('data-remove')) {
        manage({ kind: 'remove', id: Number(button.dataset.remove) }, button.closest('.thread-song'));
        return;
      }
      if (button.dataset.move) {
        const ids = [...root.querySelectorAll('[data-contribution-id]')].map(row => Number(row.dataset.contributionId));
        const index = ids.indexOf(Number(button.dataset.id));
        const target = index + (button.dataset.move === 'up' ? -1 : 1);
        if (target < 0 || target >= ids.length) return;
        [ids[index], ids[target]] = [ids[target], ids[index]];
        manage({ kind: 'reorder', ids }, button.closest('.thread-song'));
      }
    });

    root.querySelector('#close-thread')?.addEventListener('click', () => {
      root.querySelector('#close-confirmation').hidden = false;
      root.querySelector('#close-thread').hidden = true;
      root.querySelector('#confirm-close').focus();
    });
    root.querySelector('#cancel-close')?.addEventListener('click', () => {
      root.querySelector('#close-confirmation').hidden = true;
      root.querySelector('#close-thread').hidden = false;
      root.querySelector('#close-thread').focus();
    });
    root.querySelector('#confirm-close')?.addEventListener('click', event => manage({ kind: 'close' }, event.currentTarget.closest('.thread-management')));

    root.querySelectorAll('[data-retry-sync]').forEach(button => {
      button.addEventListener('click', () => {
        submitCore(`/t/${thread.dataset.capability}/manage/retry`, {
          provider: button.dataset.retrySync,
          expectedRevision: Number(thread.dataset.revision),
        }, button.closest('.sync-providers'), 'sync');
      });
    });

    const connections = createConnectionController({
      connect: provider => manage({ kind: 'connect', provider }, root.querySelector('.thread-sync')),
      showAppleConfirmation(show) {
        const confirmation = root.querySelector('#apple-connect-confirmation');
        const button = root.querySelector('[data-connect="apple"]');
        if (!confirmation || !button) return;
        confirmation.hidden = !show;
        button.hidden = show;
        (show ? root.querySelector('#confirm-connect-apple') : button).focus();
      },
    });
    root.querySelectorAll('[data-connect]').forEach(button => button.addEventListener('click', () => connections.request(button.dataset.connect)));
    root.querySelector('#confirm-connect-apple')?.addEventListener('click', () => connections.confirmApple());
    root.querySelector('#cancel-connect-apple')?.addEventListener('click', () => connections.cancelApple());

    const liveStatus = root.querySelector('#collaboration-status');
    const retryLive = root.querySelector('#retry-collaboration');
    let liveState = '';
    poller = createCollaborationPoller({
      refresh: refreshLive,
      isVisible: () => !root.hidden,
      onState(state) {
        if (state === 'refreshing' || state === liveState) return;
        liveState = state;
        liveStatus.dataset.state = state;
        if (state === 'live') {
          liveStatus.textContent = 'Live updates on.';
          retryLive.hidden = true;
        } else {
          liveStatus.textContent = 'Live updates paused. Retrying…';
          retryLive.hidden = false;
        }
      },
    });
    retryLive.addEventListener('click', () => { void poller.refresh(); });
    root.querySelector('#refresh-songs')?.addEventListener('click', () => { void poller.refresh(); });
    root.querySelector('#refresh-thread')?.addEventListener('click', () => { void poller.refresh(); });
    root.addEventListener('visibilitychange', () => poller.visibilityChanged());
    root.defaultView.addEventListener('online', () => poller.visibilityChanged());
    root.defaultView.addEventListener('pagehide', () => poller.stop(), { once: true });
    void poller.start();

    const invite = root.querySelector('#invite-friends');
    const publicLink = root.querySelector('#public-link');
    const shareUrl = publicThreadUrl(root.defaultView.location.origin, thread.dataset.capability);
    publicLink.href = shareUrl;
    invite?.addEventListener('click', async () => {
      invite.disabled = true;
      const result = await shareThread({ title: thread.dataset.title || 'A Jam', url: shareUrl, navigatorObject: root.defaultView.navigator });
      invite.disabled = false;
      const shareMessage = root.querySelector('#share-message');
      if (result === 'shared') shareMessage.textContent = 'Invitation ready to send.';
      if (result === 'copied') shareMessage.textContent = 'Jam link copied.';
      if (result === 'cancelled') shareMessage.textContent = '';
      if (result === 'manual') {
        publicLink.textContent = shareUrl;
        selectLink(root, publicLink);
        publicLink.focus();
        shareMessage.textContent = 'Copy the selected Jam link.';
      }
    });

    let secret;
    let activating = false;
    const activate = async () => {
      if (activating) return;
      activating = true;
      setFormBusy(thread, true);
      try {
        await threadRequest(`/t/${thread.dataset.capability}/manage/activate`, { managementCapability: secret });
        root.defaultView.location.reload();
      } catch {
        message.textContent = 'Could not open management access. Check your private link or try again.';
        root.querySelector('#retry-management').hidden = false;
      } finally {
        activating = false;
        setFormBusy(thread, false);
      }
    };
    root.querySelector('#retry-management').addEventListener('click', activate);
    watchManagementLink({
      readHash: () => root.defaultView.location.hash,
      clearHash: () => root.defaultView.history.replaceState(null, '', root.defaultView.location.pathname),
      onHashChange: changed => root.defaultView.addEventListener('hashchange', changed),
      activate: value => { secret = value; return activate(); },
    });
  }

  root.querySelectorAll('[data-copy]').forEach(button => {
    button.addEventListener('click', async () => {
      const link = root.getElementById(button.dataset.copy);
      const copied = await copyThreadLink(link, {
        writeText: text => root.defaultView.navigator.clipboard.writeText(text),
        select: element => selectLink(root, element),
      });
      const privateLink = button.dataset.copy === 'management-link';
      const status = thread && !privateLink ? root.querySelector('#share-message') : message;
      status.textContent = copied
        ? privateLink ? 'Private management link copied. Keep it safe.' : 'Jam link copied.'
        : privateLink ? 'Copy the selected management link and keep it private.' : 'Copy the selected Jam link.';
    });
  });

  return poller;
}

if (typeof document !== 'undefined') mountThreadPage(document);
