export type Desired = { playlistKey: string; revision: number; trackIds: string[]; title?: string };
export type Destination = {
  desired: Desired;
  providerPlaylistId: string | null;
  appliedRevision: number | null;
  publisherId: string | null;
  marker: string;
  createUnresolved: boolean;
  retryNotBefore: number;
};
export type DestinationStore = {
  get(key: string): Promise<Destination | undefined>;
  set(key: string, value: Destination): Promise<void>;
};
export type Observation = {
  playlistKey: string;
  providerPlaylistId: string;
  publisherId: string;
  revision: number;
  appliedRevision: number | null;
  trackUris: string[];
  snapshotId: string;
  observedAt: number;
  matchesDesired: boolean;
};

export class PublishingError extends Error {
  code: string;
  status: number;
  retryAfterSeconds?: number;
  constructor(code: string, status = 409, retryAfterSeconds?: number) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function validateDesired(input: unknown): asserts input is Desired {
  if (!input || typeof input !== "object") throw new PublishingError("invalid_desired", 400);
  const value = input as Desired;
  if (typeof value.playlistKey !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value.playlistKey)
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || (value.title !== undefined && (typeof value.title !== "string" || !value.title.trim() || [...value.title].length > 80 || /\p{Cc}/u.test(value.title)))
    || !Array.isArray(value.trackIds) || value.trackIds.length > 1000
    || value.trackIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9]{22}$/.test(id))) {
    throw new PublishingError("invalid_desired", 400);
  }
}

const playlistName = (desired: Desired) => desired.title ?? "listen.cx Thread";
const equal = (left: string[], right: string[]) => left.length === right.length && left.every((id, index) => id === right[index]);

export class SpotifyPublisher {
  private busy = new Set<string>();
  private fetcher: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private options: {
    accessToken: () => Promise<string>;
    store: DestinationStore;
    fetcher?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  };
  constructor(options: SpotifyPublisher["options"]) {
    this.options = options;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async reconcile(input: unknown): Promise<Destination> {
    validateDesired(input);
    const desired = structuredClone(input);
    if (this.busy.has(desired.playlistKey)) throw new PublishingError("busy");
    this.busy.add(desired.playlistKey);
    try {
      const existing = await this.options.store.get(desired.playlistKey);
      if (existing && desired.revision < existing.desired.revision) throw new PublishingError("stale_revision");
      if (existing && desired.revision === existing.desired.revision && (!equal(desired.trackIds, existing.desired.trackIds) || playlistName(desired) !== playlistName(existing.desired))) {
        throw new PublishingError("revision_conflict");
      }
      if (existing?.appliedRevision === desired.revision) return existing;
      const row: Destination = existing ?? {
        desired, providerPlaylistId: null, appliedRevision: null, publisherId: null,
        marker: `listen.cx Spotify publishing ${crypto.randomUUID()}`,
        createUnresolved: false, retryNotBefore: 0,
      };
      if (row.createUnresolved) throw new PublishingError("create_unresolved");
      if (row.retryNotBefore > this.now()) {
        throw new PublishingError("rate_limited", 429, Math.ceil((row.retryNotBefore - this.now()) / 1000));
      }
      row.desired = desired;
      await this.save(row);
      try {
        const me = await this.request("/me");
        if (typeof me.id !== "string" || !me.id) throw new PublishingError("invalid_provider_response", 502);
        if (row.publisherId && row.publisherId !== me.id) throw new PublishingError("publisher_mismatch", 403);
        row.publisherId = me.id;
        if (!row.providerPlaylistId) {
          row.createUnresolved = true;
          await this.save(row);
          let created;
          try {
            created = await this.request("/me/playlists", "POST", {
              name: playlistName(desired), public: true, collaborative: false, description: row.marker,
            });
          } catch (error) {
            if (error instanceof PublishingError && error.code === "provider_error" && error.status >= 400 && error.status < 500 && error.status !== 408) {
              row.createUnresolved = false;
              await this.save(row);
            }
            throw error;
          }
          if (typeof created.id !== "string" || !/^[A-Za-z0-9]{22}$/.test(created.id)) throw new PublishingError("create_unresolved");
          row.providerPlaylistId = created.id;
          row.createUnresolved = false;
          await this.save(row);
        }
        await this.metadata(row);
        const path = `/playlists/${row.providerPlaylistId}/items`;
        const uris = desired.trackIds.map(id => `spotify:track:${id}`);
        await this.request(path, "PUT", { uris: uris.slice(0, 100) });
        for (let offset = 100; offset < uris.length; offset += 100) {
          await this.request(path, "POST", { uris: uris.slice(offset, offset + 100) });
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt) await this.sleep(attempt * 500);
          const before = await this.metadata(row);
          const actual = await this.readItems(row);
          const after = await this.metadata(row);
          if (before.snapshot_id === after.snapshot_id && equal(actual, uris)) {
            row.appliedRevision = desired.revision;
            await this.save(row);
            return row;
          }
        }
        throw new PublishingError("readback_mismatch", 502);
      } catch (error) {
        if (error instanceof PublishingError && error.status === 429) {
          row.retryNotBefore = this.now() + (error.retryAfterSeconds ?? 60) * 1000;
          await this.save(row);
        }
        throw error;
      }
    } finally {
      this.busy.delete(desired.playlistKey);
    }
  }

  async observe(playlistKey: string): Promise<Observation> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(playlistKey)) throw new PublishingError("invalid_playlist_key", 400);
    if (this.busy.has(playlistKey)) throw new PublishingError("busy");
    this.busy.add(playlistKey);
    try {
      const row = await this.options.store.get(playlistKey);
      if (!row?.providerPlaylistId || !row.publisherId || row.createUnresolved) throw new PublishingError("destination_unavailable");
      if (row.retryNotBefore > this.now()) throw new PublishingError("rate_limited", 429, Math.ceil((row.retryNotBefore - this.now()) / 1000));
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt) await this.sleep(attempt * 500);
          const before = await this.metadata(row);
          const trackUris = await this.readItems(row);
          const after = await this.metadata(row);
          if (before.snapshot_id === after.snapshot_id) return {
            playlistKey, providerPlaylistId: row.providerPlaylistId, publisherId: row.publisherId,
            revision: row.desired.revision, appliedRevision: row.appliedRevision, trackUris,
            snapshotId: after.snapshot_id, observedAt: this.now(),
            matchesDesired: equal(trackUris, row.desired.trackIds.map(id => `spotify:track:${id}`)),
          };
        }
        throw new PublishingError("readback_unstable", 502);
      } catch (error) {
        if (error instanceof PublishingError && error.status === 429) {
          row.retryNotBefore = this.now() + (error.retryAfterSeconds ?? 60) * 1000;
          await this.save(row);
        }
        throw error;
      }
    } finally { this.busy.delete(playlistKey); }
  }

  async probePublisher(): Promise<string> {
    const profile = await this.request("/me");
    if (typeof profile.id !== "string" || !profile.id) throw new PublishingError("invalid_provider_response", 502);
    return profile.id;
  }

  async recoverCreate(playlistKey: string, providerPlaylistId: string): Promise<Destination> {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(playlistKey) || !/^[A-Za-z0-9]{22}$/.test(providerPlaylistId)) throw new PublishingError("invalid_recovery", 400);
    if (this.busy.has(playlistKey)) throw new PublishingError("busy");
    this.busy.add(playlistKey);
    try {
      const row = await this.options.store.get(playlistKey);
      if (!row?.createUnresolved || row.providerPlaylistId) throw new PublishingError("no_unresolved_create");
      const me = await this.request("/me");
      if (me.id !== row.publisherId) throw new PublishingError("publisher_mismatch", 403);
      const candidate = { ...row, providerPlaylistId };
      await this.metadata(candidate);
      await this.readItems(candidate);
      candidate.createUnresolved = false;
      await this.save(candidate);
      return candidate;
    } finally { this.busy.delete(playlistKey); }
  }

  private async save(row: Destination) {
    await this.options.store.set(row.desired.playlistKey, structuredClone(row));
  }

  private async metadata(row: Destination) {
    const result = await this.request(`/playlists/${row.providerPlaylistId}`);
    if (result.owner?.id !== row.publisherId || result.description !== row.marker || result.public !== true) {
      throw new PublishingError("destination_mismatch", 403);
    }
    if (typeof result.snapshot_id !== "string") throw new PublishingError("invalid_provider_response", 502);
    return result;
  }

  private async readItems(row: Destination): Promise<string[]> {
    const uris: string[] = [];
    for (let offset = 0; offset <= 1000; offset += 50) {
      const page = await this.request(`/playlists/${row.providerPlaylistId}/items?limit=50&offset=${offset}`);
      if (!Array.isArray(page.items) || page.items.length > 50 || !Number.isSafeInteger(page.total) || page.total < 0) {
        throw new PublishingError("invalid_provider_response", 502);
      }
      for (const entry of page.items) {
        uris.push(entry?.item?.type === "track" && typeof entry.item.uri === "string" && !entry.is_local ? entry.item.uri : "unavailable");
      }
      if (!page.next) {
        if (uris.length !== page.total) throw new PublishingError("readback_mismatch", 502);
        return uris;
      }
      if (page.items.length !== 50) throw new PublishingError("readback_mismatch", 502);
    }
    throw new PublishingError("readback_mismatch", 502);
  }

  private async request(path: string, method = "GET", body?: unknown): Promise<any> {
    const token = await this.options.accessToken();
    let response: Response;
    try {
      response = await this.fetcher(`https://api.spotify.com/v1${path}`, {
        method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "manual",
      });
    } catch {
      throw new PublishingError(method === "GET" ? "provider_unavailable" : "ambiguous_write", 502);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new PublishingError(method === "GET" ? "provider_unavailable" : "ambiguous_write", 502);
    }
    if (!response.ok) {
      const seconds = Number(response.headers.get("retry-after"));
      await response.body?.cancel();
      if (method !== "GET" && (response.status >= 500 || response.status === 408)) throw new PublishingError("ambiguous_write", 502);
      throw new PublishingError("provider_error", response.status, response.status === 429 ? (Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60) : undefined);
    }
    try { return await response.json(); }
    catch { throw new PublishingError(method === "GET" ? "invalid_provider_response" : "ambiguous_write", 502); }
  }
}
