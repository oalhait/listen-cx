export function reserveRevision(state, revision) {
  if (![1, 2].includes(revision) || state.revisions.length !== revision - 1 || state.revisions.some(item => !item.id)) {
    throw new Error('Revision is already reserved, uncertain, or out of sequence');
  }
  return { ...state, revisions: [...state.revisions, { revision, reservedAt: new Date().toISOString(), id: null }] };
}

export function recordCreation(state, revision, id) {
  const item = state.revisions.find(item => item.revision === revision);
  if (!item || item.id || !/^p\.[A-Za-z0-9.-]+$/.test(id) || state.revisions.some(item => item.id === id)) {
    throw new Error('Invalid or duplicate creation receipt');
  }
  return { ...state, revisions: state.revisions.map(item => item.revision === revision ? { ...item, id } : item) };
}

export async function createRevision(request, runID, revision, trackIDs) {
  const result = await request('/v1/me/library/playlists', {
    method: 'POST',
    body: {
      attributes: { name: `DISPOSABLE listen.cx web ${runID} R${revision}`, description: 'Isolated recreation test. Preserve this playlist for readback.', isPublic: true },
      relationships: { tracks: { data: trackIDs.map(id => ({ id, type: 'songs' })) } },
    },
  });
  const id = result.data?.[0]?.id;
  if (!/^p\.[A-Za-z0-9.-]+$/.test(id ?? '')) throw new Error('Creation response has no library playlist ID; do not retry');
  return id;
}

export async function readPlaylist(request, id, expected) {
  if (!/^p\.[A-Za-z0-9.-]+$/.test(id)) throw new Error('Invalid library playlist ID');
  const base = `/v1/me/library/playlists/${encodeURIComponent(id)}`;
  const playlist = (await request(`${base}?include=catalog`)).data?.[0];
  const tracks = await request(`${base}/tracks`);
  const trackIDs = (tracks.data ?? []).map(track => track.attributes?.playParams?.catalogId ?? null);
  return {
    id: playlist?.id ?? null,
    isPublic: playlist?.attributes?.isPublic ?? null,
    hasCatalog: playlist?.attributes?.hasCatalog ?? null,
    url: playlist?.attributes?.url ?? playlist?.relationships?.catalog?.data?.[0]?.attributes?.url ?? null,
    catalogIDs: (playlist?.relationships?.catalog?.data ?? []).map(item => item.id),
    trackIDs,
    libraryTrackIDs: (tracks.data ?? []).map(track => track.id),
    matches: playlist?.id === id && !tracks.next && JSON.stringify(trackIDs) === JSON.stringify(expected),
    observedAt: new Date().toISOString(),
  };
}
