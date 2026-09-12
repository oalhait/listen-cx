const playlistID = /^p\.[A-Za-z0-9.-]+$/;
const sessionIDPattern = /^[A-Za-z0-9_-]{1,64}$/;
const modes = new Set(['sdk', 'direct']);
const allowedCodes = new Set(['40000', '40001', '40002', '40003', '40004', '40005', '40006', '40007', '40100', '40101', '40102', '40103', '40300', '40301', '40400', '40401', '40402', '40500', '40900', '42900', '50000', '50300']);

function same(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateIDs(ids, allowEmpty = false) {
  if (!Array.isArray(ids) || (!allowEmpty && ids.length === 0) || ids.length > 50 || ids.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid catalog identity list');
}

function activeKey(mode) {
  return `listen-cx-apple-replacement-${mode}-active-run`;
}

function journalKey(mode, sessionID) {
  return `listen-cx-apple-replacement-${mode}-journal-${sessionID}`;
}

function validateJournal(journal, mode, sessionID) {
  if (journal?.version !== 1 || journal.mode !== mode || journal.sessionID !== sessionID || !Array.isArray(journal.operations) || journal.operations.length > 2) throw new Error('INVALID_REPLACEMENT_JOURNAL');
  if (journal.playlist !== null && (!playlistID.test(journal.playlist?.id ?? '') || !Array.isArray(journal.playlist.entries))) throw new Error('INVALID_REPLACEMENT_JOURNAL');
  for (const [index, operation] of journal.operations.entries()) {
    if (operation?.name !== ['create', 'replace'][index] || !['reserved', 'submitted', 'verified'].includes(operation.status)) throw new Error('INVALID_REPLACEMENT_JOURNAL');
    validateIDs(operation.expectedCatalogIds, true);
    validateIDs(operation.desiredCatalogIds);
    if (index < journal.operations.length - 1 && operation.status !== 'verified') throw new Error('INVALID_REPLACEMENT_JOURNAL');
  }
  return journal;
}

export function createReplacementJournal(mode, sessionID) {
  if (!modes.has(mode) || !sessionIDPattern.test(sessionID)) throw new Error('Invalid replacement journal identity');
  return { version: 1, mode, sessionID, storefront: null, playlist: null, operations: [] };
}

export function loadReplacementJournal(storage, mode, createSessionID) {
  if (!modes.has(mode)) throw new Error('Invalid replacement mode');
  let sessionID = storage.getItem(activeKey(mode));
  if (sessionID === null) {
    sessionID = createSessionID();
    if (!sessionIDPattern.test(sessionID)) throw new Error('Invalid replacement session ID');
    storage.setItem(activeKey(mode), sessionID);
  } else if (!sessionIDPattern.test(sessionID)) throw new Error('INVALID_REPLACEMENT_JOURNAL');
  const stored = storage.getItem(journalKey(mode, sessionID));
  return stored === null ? createReplacementJournal(mode, sessionID) : validateJournal(JSON.parse(stored), mode, sessionID);
}

export function saveReplacementJournal(storage, journal) {
  if (storage.getItem(activeKey(journal?.mode)) !== journal?.sessionID) throw new Error('ACTIVE_REPLACEMENT_RUN_CHANGED');
  validateJournal(journal, journal.mode, journal.sessionID);
  storage.setItem(journalKey(journal.mode, journal.sessionID), JSON.stringify(journal));
}

export function reserveReplacementOperation(journal, name, desiredCatalogIds, submit = false) {
  validateIDs(desiredCatalogIds);
  const index = name === 'create' ? 0 : name === 'replace' ? 1 : -1;
  if (index < 0 || journal.operations.length !== index && !submit) throw new Error('Operation is out of sequence');
  if (submit) {
    const operation = journal.operations[index];
    if (!operation || operation.status !== 'reserved' || !same(operation.desiredCatalogIds, desiredCatalogIds)) throw new Error('Operation cannot be submitted');
    return { ...journal, operations: journal.operations.map((item, itemIndex) => itemIndex === index ? { ...item, status: 'submitted', submittedAt: new Date().toISOString() } : item) };
  }
  if (journal.operations.some(operation => operation.status !== 'verified')) throw new Error('Previous operation is not verified');
  const expectedCatalogIds = name === 'create' ? [] : journal.playlist?.entries?.map(entry => entry.catalogId) ?? [];
  if (name === 'replace' && expectedCatalogIds.length === 0) throw new Error('Replacement requires verified current entries');
  return { ...journal, operations: [...journal.operations, { name, expectedCatalogIds, desiredCatalogIds: [...desiredCatalogIds], status: 'reserved', reservedAt: new Date().toISOString() }] };
}

export function recordCreation(journal, id) {
  const operation = journal.operations[0];
  if (operation?.name !== 'create' || operation.status !== 'submitted' || journal.playlist || !playlistID.test(id)) throw new Error('Invalid creation receipt');
  return { ...journal, playlist: { id, entries: [], metadata: null } };
}

export function verifyReplacementOperation(journal, name, readback) {
  const index = name === 'create' ? 0 : name === 'replace' ? 1 : -1;
  const operation = journal.operations[index];
  if (!operation || operation.status !== 'submitted' || !journal.playlist || readback?.id !== journal.playlist.id) throw new Error('Verification requires the same playlist and a submitted operation');
  const actual = readback.entries?.map(entry => entry.catalogId) ?? [];
  if (!same(actual, operation.desiredCatalogIds)) throw new Error('Readback does not match the exact desired order');
  const entries = readback.entries.map(entry => ({ catalogId: entry.catalogId, libraryId: entry.libraryId, type: entry.type }));
  const operations = journal.operations.map((item, itemIndex) => itemIndex === index ? { ...item, status: 'verified', verifiedAt: new Date().toISOString(), observedCatalogIds: actual } : item);
  return { ...journal, operations, playlist: { id: journal.playlist.id, entries, metadata: readback.metadata ?? journal.playlist.metadata } };
}

function safeTransport(input, playlistId) {
  const expectedPath = `/v1/me/library/playlists/${playlistId}/tracks`;
  return {
    method: input?.method === 'PUT' ? 'PUT' : null,
    path: input?.path === expectedPath ? expectedPath : null,
    issued: input?.issued === true,
    responseExposed: input?.responseExposed === true,
    httpStatus: Number.isInteger(input?.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599 ? input.httpStatus : null,
    appleErrorCode: allowedCodes.has(input?.appleErrorCode) ? input.appleErrorCode : null,
  };
}

export function recordReplacementTransport(journal, input) {
  const operation = journal.operations[1];
  if (!modes.has(journal.mode) || operation?.name !== 'replace' || operation.status !== 'submitted' || !journal.playlist) throw new Error('Invalid replacement transport evidence');
  const next = { ...operation, transport: safeTransport(input, journal.playlist.id) };
  return { ...journal, operations: journal.operations.map((item, index) => index === 1 ? next : item) };
}

export function recordReplacementReadback(journal, readback) {
  const operation = journal.operations[1];
  if (operation?.name !== 'replace' || operation.status !== 'submitted' || !journal.playlist || readback?.id !== journal.playlist.id) throw new Error('Invalid replacement readback evidence');
  const actual = Array.isArray(readback.entries) ? readback.entries.map(entry => entry.catalogId).filter(id => typeof id === 'string') : [];
  const next = { ...operation, readback: { playlistID: journal.playlist.id, catalogIds: actual } };
  return { ...journal, operations: journal.operations.map((item, index) => index === 1 ? next : item) };
}

export function recordReplacementEvidence(journal, input, readback) {
  return recordReplacementReadback(recordReplacementTransport(journal, input), readback);
}

export function directFallbackEligible(journal) {
  try {
    validateJournal(journal, 'sdk', journal.sessionID);
    const operation = journal.operations[1];
    return operation?.name === 'replace' && operation.status === 'submitted' && operation.transport?.responseExposed === false && operation.readback?.playlistID === journal.playlist?.id && same(operation.readback.catalogIds ?? [], operation.expectedCatalogIds);
  } catch { return false; }
}

export function loadSDKJournalForFallback(storage) {
  const sessionID = storage.getItem(activeKey('sdk'));
  if (!sessionIDPattern.test(sessionID ?? '')) return null;
  const stored = storage.getItem(journalKey('sdk', sessionID));
  try { return stored ? validateJournal(JSON.parse(stored), 'sdk', sessionID) : null; }
  catch { return null; }
}
