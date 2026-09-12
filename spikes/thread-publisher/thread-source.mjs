const MAX_BODY_BYTES = 128 * 1024;
const CAPABILITY = /^[A-Za-z0-9_-]{22}$/;
const CATALOG_ID = { apple: /^\d+$/, spotify: /^[A-Za-z0-9]{22}$/ };

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function validateConfiguration({ capability, publicationKey, provider }) {
  if (typeof capability !== 'string' || !CAPABILITY.test(capability)
    || typeof publicationKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(publicationKey)
    || publicationKey.includes(capability) || !Object.hasOwn(CATALOG_ID, provider)) {
    fail('invalid_source_configuration');
  }
}

export function publicationSnapshot(view, options) {
  validateConfiguration(options);
  if (!view || view.publicCapability !== options.capability
    || !Number.isSafeInteger(view.revision) || view.revision < 0
    || typeof view.title !== 'string' || !view.title.trim() || [...view.title].length > 80
    || /\p{Cc}/u.test(view.title) || !Array.isArray(view.contributions) || view.contributions.length > 50) {
    fail('invalid_thread_snapshot');
  }
  const seen = new Set();
  const entries = view.contributions.map(song => {
    const source = song?.source;
    if (!Number.isSafeInteger(song?.id) || song.id <= 0 || seen.has(song.id)
      || !source || !Object.hasOwn(CATALOG_ID, source.provider)
      || typeof source.id !== 'string' || source.id.length > 128 || !CATALOG_ID[source.provider].test(source.id)
      || typeof source.storefront !== 'string' || !/^[a-z]{2}$/.test(source.storefront)
      || typeof source.verified !== 'boolean') {
      fail('invalid_thread_snapshot');
    }
    seen.add(song.id);
    const identity = !source.verified
      ? { status: 'unresolved', reason: 'legacy_source_not_verified' }
      : source.provider !== options.provider
        ? { status: 'unresolved', reason: 'cross_provider_identity_unresolved' }
        : { status: 'verified', id: source.id, storefront: source.storefront };
    return { contributionId: song.id, identity };
  });
  return { publicationKey: options.publicationKey, revision: view.revision, title: view.title, entries };
}

async function readBoundedJson(response) {
  if (!response.ok) {
    await response.body?.cancel();
    fail('thread_source_unavailable');
  }
  if (Number(response.headers.get('Content-Length')) > MAX_BODY_BYTES) {
    await response.body?.cancel();
    fail('thread_snapshot_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) fail('invalid_thread_snapshot');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        fail('thread_snapshot_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { fail('invalid_thread_snapshot'); }
}

export function createThreadSource({ baseUrl, capability, publicationKey, provider, fetchImpl = fetch }) {
  const options = { capability, publicationKey, provider };
  validateConfiguration(options);
  let origin;
  try { origin = new URL(baseUrl); }
  catch { fail('invalid_source_configuration'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if ((origin.protocol !== 'https:' && !(local && origin.protocol === 'http:'))
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    fail('invalid_source_configuration');
  }
  const url = new URL(`/api/threads/${capability}`, origin);
  return {
    async read() {
      try {
        const response = await fetchImpl(url, {
          method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', cache: 'no-store',
          signal: AbortSignal.timeout(10000),
        });
        return publicationSnapshot(await readBoundedJson(response), options);
      } catch (error) {
        if (['invalid_thread_snapshot', 'thread_snapshot_too_large'].includes(error?.code)) throw error;
        fail('thread_source_unavailable');
      }
    },
  };
}
