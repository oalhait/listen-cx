import { createThreadController, createConnectionController, threadRequest, watchManagementLink, copyThreadLink } from './thread-client.js';

const message = document.querySelector('#thread-message');
const thread = document.querySelector('#thread');
const createForm = document.querySelector('#thread-create-form');
const storageKey = `thread-request:${thread?.dataset.capability ?? 'create'}`;
const disabledStates = new Map();
const storage = {
  read() {
    try { return JSON.parse(sessionStorage.getItem(storageKey)); } catch { return null; }
  },
  write(value) {
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
    } catch {}
  },
};

function setBusy(busy) {
  if (busy) {
    document.querySelectorAll('main button, main input').forEach(element => {
      disabledStates.set(element, element.disabled);
      element.disabled = true;
    });
  } else {
    disabledStates.forEach((disabled, element) => { element.disabled = disabled; });
    disabledStates.clear();
  }
  document.querySelector('main')?.setAttribute('aria-busy', String(busy));
}

const controller = createThreadController({
  storage,
  update(state) {
    setBusy(state.status === 'loading');
    message.classList.toggle('is-error', state.status === 'error');
    if (state.status === 'loading') message.textContent = 'Saving…';
    if (state.status === 'error') {
      message.textContent = state.error;
      if (['stale_revision', 'closed'].includes(state.code)) document.querySelector('#refresh-thread').hidden = false;
    }
    if (state.status === 'success') {
      if (thread) {
        window.location.reload();
        return;
      }
      createForm.hidden = true;
      const { publicUrl, managementUrl } = state.data;
      for (const [id, url] of [['public-link', publicUrl], ['management-link', managementUrl]]) {
        const link = document.getElementById(id);
        link.href = url;
        link.textContent = url;
      }
      document.querySelector('#open-thread').href = publicUrl;
      document.querySelector('#thread-created').hidden = false;
      message.textContent = 'Share the public link, and save your private management link.';
      document.querySelector('#open-thread').focus();
    }
  },
});

createForm?.addEventListener('submit', event => {
  event.preventDefault();
  void controller.submit('/api/threads', { title: document.querySelector('#thread-title').value.trim() });
});

document.querySelector('#add-song-form')?.addEventListener('submit', event => {
  event.preventDefault();
  void controller.submit(`/api/threads/${thread.dataset.capability}/contributions`, {
    url: document.querySelector('#thread-song-url').value.trim(), expectedRevision: Number(thread.dataset.revision),
  });
});

function manage(intent) {
  void controller.submit(`/t/${thread.dataset.capability}/manage/mutate`, { ...intent, expectedRevision: Number(thread.dataset.revision) });
}

const connections = createConnectionController({
  connect: provider => manage({ kind: 'connect', provider }),
  showAppleConfirmation(show) {
    document.querySelector('#apple-connect-confirmation').hidden = !show;
    const button = document.querySelector('[data-connect="apple"]');
    button.hidden = show;
    (show ? document.querySelector('#confirm-connect-apple') : button).focus();
  },
});
document.querySelectorAll('[data-connect]').forEach(button => {
  button.addEventListener('click', () => connections.request(button.dataset.connect));
});
document.querySelector('#confirm-connect-apple')?.addEventListener('click', () => connections.confirmApple());
document.querySelector('#cancel-connect-apple')?.addEventListener('click', () => connections.cancelApple());

document.querySelectorAll('[data-remove]').forEach(button => {
  button.addEventListener('click', () => manage({ kind: 'remove', id: Number(button.dataset.remove) }));
});
document.querySelectorAll('[data-move]').forEach(button => {
  button.addEventListener('click', () => {
    const ids = [...document.querySelectorAll('[data-contribution-id]')].map(row => Number(row.dataset.contributionId));
    const index = ids.indexOf(Number(button.dataset.id));
    const target = index + (button.dataset.move === 'up' ? -1 : 1);
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    manage({ kind: 'reorder', ids });
  });
});

document.querySelector('#close-thread')?.addEventListener('click', () => {
  document.querySelector('#close-confirmation').hidden = false;
  document.querySelector('#close-thread').hidden = true;
});
document.querySelector('#cancel-close')?.addEventListener('click', () => {
  document.querySelector('#close-confirmation').hidden = true;
  document.querySelector('#close-thread').hidden = false;
});
document.querySelector('#confirm-close')?.addEventListener('click', () => manage({ kind: 'close' }));
for (const id of ['refresh-thread', 'refresh-songs']) document.getElementById(id)?.addEventListener('click', () => window.location.reload());

document.querySelectorAll('[data-copy]').forEach(button => {
  button.addEventListener('click', async () => {
    const link = document.getElementById(button.dataset.copy);
    const copied = await copyThreadLink(link, {
      writeText: text => navigator.clipboard.writeText(text),
      select: element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      },
    });
    const privateLink = button.dataset.copy === 'management-link';
    message.textContent = copied
      ? privateLink ? 'Private management link copied. Keep it safe.' : 'Sharing link copied.'
      : privateLink ? 'Copy the selected management link and keep it private.' : 'Copy the selected link to share it.';
  });
});

if (thread) {
  let secret;
  let activating = false;
  const activate = async () => {
    if (activating) return;
    activating = true;
    setBusy(true);
    try {
      await threadRequest(`/t/${thread.dataset.capability}/manage/activate`, { managementCapability: secret });
      window.location.reload();
    } catch {
      message.textContent = 'Could not open management access. Check your private link or try again.';
      document.querySelector('#retry-management').hidden = false;
    } finally {
      activating = false;
      setBusy(false);
    }
  };
  document.querySelector('#retry-management').addEventListener('click', activate);
  watchManagementLink({
    readHash: () => window.location.hash,
    clearHash: () => history.replaceState(null, '', window.location.pathname),
    onHashChange: changed => window.addEventListener('hashchange', changed),
    activate: value => { secret = value; return activate(); },
  });
}
