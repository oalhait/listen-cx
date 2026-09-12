const playlistID = /^p\.[A-Za-z0-9.-]+$/;
const sessionIDPattern = /^[A-Za-z0-9_-]{1,64}$/;
const operationOrder = ['create', 'append', 'remove', 'reorder'];
const failureReasons = new Set(['AUTHORIZATION_ERROR', 'AUTHORIZATION_INCOMPLETE', 'ACCESS_DENIED', 'CONFIGURATION_ERROR', 'NETWORK_ERROR', 'PROVIDER_ERROR', 'REQUEST_ERROR', 'SERVER_ERROR', 'SERVICE_UNAVAILABLE', 'STOREFRONT_READBACK_FAILED', 'SUBSCRIPTION_ERROR', 'TOKEN_EXPIRED', 'USER_INTERACTION_REQUIRED', 'UNKNOWN_ERROR']);
const activeRunStorageKey = 'listen-cx-apple-same-id-active-run';

class ReadbackMismatchError extends Error {
  constructor(message = 'Readback does not match the exact desired order') {
    super(message);
    this.name = 'ReadbackMismatchError';
  }
}

function catalogIDs(entries) {
  return entries.map(entry => entry.catalogId);
}

function same(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateIDs(ids, allowEmpty = false) {
  if (!Array.isArray(ids) || (!allowEmpty && ids.length === 0) || ids.length > 50 || ids.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid catalog identity list');
}

export function planMutation(current, desiredCatalogIds) {
  validateIDs(desiredCatalogIds);
  if (current === null) return { kind: 'create', expectedCatalogIds: [], desiredCatalogIds: [...desiredCatalogIds], payload: desiredCatalogIds.map(id => ({ id, type: 'songs' })) };
  if (!Array.isArray(current) || current.some(entry => typeof entry?.catalogId !== 'string')) throw new Error('Current playlist has an unresolved catalog identity');
  const expectedCatalogIds = catalogIDs(current);
  if (same(expectedCatalogIds, desiredCatalogIds)) return { kind: 'noop', expectedCatalogIds, desiredCatalogIds: [...desiredCatalogIds], payload: [] };
  if (desiredCatalogIds.length > expectedCatalogIds.length && expectedCatalogIds.every((id, index) => desiredCatalogIds[index] === id)) {
    return { kind: 'append', expectedCatalogIds, desiredCatalogIds: [...desiredCatalogIds], payload: desiredCatalogIds.slice(expectedCatalogIds.length).map(id => ({ id, type: 'songs' })) };
  }
  const available = new Map();
  for (const entry of current) {
    if (typeof entry.libraryId !== 'string' || !entry.libraryId || typeof entry.type !== 'string' || !entry.type) throw new Error('Replacement requires a verified current library item');
    const matches = available.get(entry.catalogId) ?? [];
    matches.push(entry);
    available.set(entry.catalogId, matches);
  }
  const payload = desiredCatalogIds.map(id => {
    const entry = available.get(id)?.shift();
    if (!entry) throw new Error('Replacement requires a verified current library item for every desired track');
    return { id: entry.libraryId, type: entry.type };
  });
  return { kind: 'replace', expectedCatalogIds, desiredCatalogIds: [...desiredCatalogIds], payload };
}

export async function readFullPlaylist(request, id) {
  if (!playlistID.test(id)) throw new Error('Invalid library playlist ID');
  const base = `/v1/me/library/playlists/${encodeURIComponent(id)}`;
  const playlist = (await request(`${base}?include=catalog&extend=isPublic`)).data?.[0];
  if (playlist?.id !== id) throw new Error('Playlist readback did not return the same playlist');
  const entries = [];
  const visited = new Set();
  let path = `${base}/tracks?limit=100`;
  for (let page = 0; path && page < 10; page += 1) {
    if (!path.startsWith(`${base}/tracks?`) || visited.has(path)) throw new Error('Unexpected pagination path');
    visited.add(path);
    const result = await request(path);
    for (const track of result.data ?? []) {
      const catalogId = track?.attributes?.playParams?.catalogId;
      if (typeof catalogId !== 'string' || !catalogId || typeof track.id !== 'string' || !track.id || typeof track.type !== 'string' || !track.type) throw new Error('Playlist track has no verified catalog identity');
      entries.push({ catalogId, libraryId: track.id, type: track.type });
    }
    path = result.next ?? null;
  }
  if (path) throw new Error('Playlist readback exceeded the page limit');
  const catalog = playlist.relationships?.catalog?.data?.[0];
  const url = catalog?.attributes?.url;
  return {
    id,
    entries,
    metadata: {
      isPublic: typeof playlist.attributes?.isPublic === 'boolean' ? playlist.attributes.isPublic : null,
      hasCatalog: typeof playlist.attributes?.hasCatalog === 'boolean' ? playlist.attributes.hasCatalog : null,
      catalogId: typeof catalog?.id === 'string' ? catalog.id : null,
      url: typeof url === 'string' && url.startsWith('https://music.apple.com/') ? url : null,
    },
  };
}

export async function findPlaylistByName(request, name, expectedCatalogIds) {
  if (typeof name !== 'string' || !name) throw new Error('Invalid playlist name');
  validateIDs(expectedCatalogIds);
  const candidates = new Set();
  const visited = new Set();
  let path = '/v1/me/library/playlists?limit=100';
  for (let page = 0; path && page < 10; page += 1) {
    if (!path.startsWith('/v1/me/library/playlists?') || visited.has(path)) throw new Error('Unexpected pagination path');
    visited.add(path);
    const result = await request(path);
    for (const playlist of result.data ?? []) {
      if (playlist?.attributes?.name === name && playlistID.test(playlist.id ?? '')) candidates.add(playlist.id);
    }
    path = result.next ?? null;
  }
  if (path) throw new Error('Playlist listing exceeded the page limit');
  const matches = [];
  for (const id of candidates) {
    const readback = await readFullPlaylist(request, id);
    if (same(catalogIDs(readback.entries), expectedCatalogIds)) matches.push(id);
  }
  if (matches.length > 1) throw new Error('Multiple playlists match the creation reservation');
  return matches[0] ?? null;
}

export function createJournal(sessionID) {
  if (!sessionIDPattern.test(sessionID)) throw new Error('Invalid session ID');
  return { version: 1, sessionID, playlist: null, operations: [] };
}

function journalStorageKey(sessionID) {
  return `listen-cx-apple-same-id-journal-${sessionID}`;
}

function validateJournal(journal, sessionID) {
  if (journal?.version !== 1 || journal.sessionID !== sessionID || !Array.isArray(journal.operations) || journal.operations.length > operationOrder.length) throw new Error('INVALID_LOCAL_JOURNAL');
  if (journal.playlist !== null && (!playlistID.test(journal.playlist?.id ?? '') || (journal.playlist.metadata !== null && typeof journal.playlist.metadata !== 'object'))) throw new Error('INVALID_LOCAL_JOURNAL');
  for (const [index, operation] of journal.operations.entries()) {
    if (operation?.name !== operationOrder[index] || !['reserved', 'submitted', 'verified'].includes(operation.status) || !['create', 'append', 'replace'].includes(operation.kind)) throw new Error('INVALID_LOCAL_JOURNAL');
    validateIDs(operation.expectedCatalogIds, true);
    validateIDs(operation.desiredCatalogIds);
    if (index < journal.operations.length - 1 && operation.status !== 'verified') throw new Error('INVALID_LOCAL_JOURNAL');
  }
  return journal;
}

export function loadActiveJournal(storage, createSessionID) {
  let sessionID = storage.getItem(activeRunStorageKey);
  if (sessionID === null) {
    sessionID = createSessionID();
    if (!sessionIDPattern.test(sessionID)) throw new Error('Invalid session ID');
    storage.setItem(activeRunStorageKey, sessionID);
  } else if (!sessionIDPattern.test(sessionID)) {
    throw new Error('INVALID_LOCAL_JOURNAL');
  }
  const stored = storage.getItem(journalStorageKey(sessionID));
  return stored === null ? createJournal(sessionID) : validateJournal(JSON.parse(stored), sessionID);
}

export function saveActiveJournal(storage, journal) {
  if (storage.getItem(activeRunStorageKey) !== journal?.sessionID) throw new Error('ACTIVE_RUN_CHANGED');
  validateJournal(journal, journal.sessionID);
  storage.setItem(journalStorageKey(journal.sessionID), JSON.stringify(journal));
}

function currentOperation(journal, name) {
  const operation = journal.operations.find(item => item.name === name);
  if (!operation) throw new Error('Operation is not reserved');
  return operation;
}

function updateOperation(journal, name, update) {
  return { ...journal, operations: journal.operations.map(operation => operation.name === name ? { ...operation, ...update } : operation) };
}

export function reserveOperation(journal, name, plan) {
  if (journal.operations.some(operation => operation.name === name)) throw new Error('Operation is already reserved');
  const expectedName = operationOrder[journal.operations.length];
  if (name !== expectedName || !['create', 'append', 'replace'].includes(plan.kind)) throw new Error('Operation is out of sequence');
  if (journal.operations.some(operation => operation.status !== 'verified')) throw new Error('Previous operation is not verified');
  return {
    ...journal,
    operations: [...journal.operations, {
      name,
      kind: plan.kind,
      expectedCatalogIds: [...plan.expectedCatalogIds],
      desiredCatalogIds: [...plan.desiredCatalogIds],
      status: 'reserved',
      reservedAt: new Date().toISOString(),
    }],
  };
}

export function markSubmitted(journal, name) {
  const operation = currentOperation(journal, name);
  if (operation.status !== 'reserved') throw new Error('Operation cannot be submitted again');
  return updateOperation(journal, name, { status: 'submitted', submittedAt: new Date().toISOString() });
}

export function recordPlaylist(journal, name, id) {
  const operation = currentOperation(journal, name);
  if (name !== 'create' || operation.status !== 'submitted' || journal.playlist || !playlistID.test(id)) throw new Error('Invalid creation receipt');
  return { ...journal, playlist: { id, metadata: null } };
}

export function recordFailure(journal, name, input) {
  const operation = currentOperation(journal, name);
  if (operation.status !== 'submitted') throw new Error('Only a submitted operation can record failure evidence');
  const reason = failureReasons.has(input?.reason) ? input.reason : 'UNKNOWN_ERROR';
  const httpStatus = Number.isInteger(input?.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599 ? input.httpStatus : null;
  return updateOperation(journal, name, { failure: { reason, httpStatus } });
}

export function verifyOperation(journal, name, readback) {
  const operation = currentOperation(journal, name);
  if (operation.status !== 'submitted' || !journal.playlist || readback.id !== journal.playlist.id) throw new Error('Verification requires the same playlist and a submitted operation');
  const actual = catalogIDs(readback.entries);
  if (!same(actual, operation.desiredCatalogIds)) throw new ReadbackMismatchError();
  const next = updateOperation(journal, name, { status: 'verified', verifiedAt: new Date().toISOString(), observedCatalogIds: actual });
  return { ...next, playlist: { id: journal.playlist.id, metadata: readback.metadata ?? journal.playlist.metadata } };
}

export async function verifyWithRetry(journal, name, read, wait, attempts = 6) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 6) throw new Error('Invalid verification attempt count');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const readback = await read(journal.playlist?.id);
    try {
      return { journal: verifyOperation(journal, name, readback), readback };
    } catch (error) {
      if (!(error instanceof ReadbackMismatchError) || attempt === attempts - 1) throw error;
      await wait();
    }
  }
  throw new Error('Verification did not complete');
}

export async function submitOperation(journal, name, plan, request, save, attributes = null) {
  let next;
  const existing = journal.operations.find(operation => operation.name === name);
  if (existing) {
    if (existing.status !== 'reserved' || existing.kind !== plan.kind || !same(existing.expectedCatalogIds, plan.expectedCatalogIds) || !same(existing.desiredCatalogIds, plan.desiredCatalogIds)) throw new Error('Operation is already reserved with different or submitted state');
    next = journal;
  } else {
    next = reserveOperation(journal, name, plan);
    save(next);
  }
  next = markSubmitted(next, name);
  save(next);
  if (plan.kind === 'create') {
    const result = await request('/v1/me/library/playlists', {
      method: 'POST',
      body: { attributes, relationships: { tracks: { data: plan.payload } } },
    });
    const id = result.data?.[0]?.id;
    next = recordPlaylist(next, name, id);
    save(next);
    return next;
  }
  if (!journal.playlist?.id || !playlistID.test(journal.playlist.id)) throw new Error('Existing operation requires a verified playlist ID');
  await request(`/v1/me/library/playlists/${encodeURIComponent(journal.playlist.id)}/tracks`, {
    method: plan.kind === 'append' ? 'POST' : 'PUT',
    body: { data: plan.payload },
  });
  return next;
}
