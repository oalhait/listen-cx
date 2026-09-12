export function newCapability() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function threadRequest(path, body, fetcher = fetch) {
  const response = await fetcher(path, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Listen-Action': 'thread' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || 'Could not save this change. Try again.');
    error.code = result.code;
    throw error;
  }
  return result;
}

export function createThreadController({ fetcher = fetch, update, storage }) {
  let pending = false;
  let previous = storage?.read() ?? null;
  return {
    async submit(path, body) {
      if (pending) return;
      const { expectedRevision, ...intent } = body;
      const signature = JSON.stringify([path, intent]);
      const create = path === '/api/threads';
      if (previous?.signature !== signature) {
        previous = { signature, key: create ? newCapability() : crypto.randomUUID() };
        storage?.write(previous);
      }
      pending = true;
      update({ status: 'loading' });
      try {
        const data = await threadRequest(path, { ...body, [create ? 'creationKey' : 'requestKey']: previous.key }, fetcher);
        previous = null;
        storage?.write(null);
        await update({ status: 'success', data });
      } catch (error) {
        update({ status: 'error', error: error.code ? error.message : 'Could not finish the request. Try again to check whether it was saved.', code: error.code });
      } finally {
        pending = false;
      }
    },
  };
}

export function createConnectionController({ connect, showAppleConfirmation }) {
  let appleRequested = false;
  return {
    request(provider) {
      if (provider === 'spotify') connect(provider);
      if (provider === 'apple') {
        appleRequested = true;
        showAppleConfirmation(true);
      }
    },
    confirmApple() {
      if (!appleRequested) return;
      appleRequested = false;
      showAppleConfirmation(false);
      connect('apple');
    },
    cancelApple() {
      appleRequested = false;
      showAppleConfirmation(false);
    },
  };
}

export function watchManagementLink({ readHash, clearHash, onHashChange, activate }) {
  const changed = () => {
    const secret = new URLSearchParams(readHash().slice(1)).get('manage');
    if (!secret) return;
    clearHash();
    void activate(secret);
  };
  onHashChange(changed);
  changed();
}

export async function copyThreadLink(link, { writeText, select }) {
  try {
    await writeText(link.href);
    return true;
  } catch {
    link.textContent = link.href;
    select(link);
    return false;
  }
}
