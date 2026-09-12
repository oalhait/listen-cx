export type Desired = { playlistKey: string; revision: number; title: string; trackIds: string[] };
export type Destination = {
  desired: Desired;
  providerPlaylistId: string | null;
  appliedRevision: number | null;
  appliedTrackIds: string[];
  verifiedUrl: string | null;
  marker: string;
  intent: { kind: "create" | "append"; desired: Desired } | null;
  retryNotBefore: number;
};
export type DestinationStore = {
  get(key: string): Promise<Destination | undefined>;
  set(key: string, value: Destination): Promise<void>;
};
type Credentials = { developerToken: string; musicUserToken: string };
type Options = { store: DestinationStore; credentials: () => Promise<Credentials>; fetcher?: typeof fetch; now?: () => number };

export class PublishingError extends Error {
  constructor(public code: string, public status = 409, public retryAfterSeconds?: number) { super(code); }
}

const origin = "https://api.music.apple.com";
const prefix = (before: string[], after: string[]) => before.length <= after.length && before.every((id, index) => id === after[index]);
const equal = (before: string[], after: string[]) => before.length === after.length && prefix(before, after);
const song = (id: string) => ({ id, type: "songs" });

function validateDesired(input: unknown): asserts input is Desired {
  if (!input || typeof input !== "object") throw new PublishingError("invalid_desired", 400);
  const value = input as Desired;
  if (typeof value.playlistKey !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value.playlistKey)
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.title !== "string" || !value.title.trim() || value.title.length > 200
    || !Array.isArray(value.trackIds) || value.trackIds.length > 1000
    || value.trackIds.some(id => typeof id !== "string" || !/^\d{1,30}$/.test(id))) {
    throw new PublishingError("invalid_desired", 400);
  }
}

export class ApplePublisher {
  private busy = new Set<string>();
  private fetcher: typeof fetch;
  private now: () => number;

  constructor(private options: Options) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  async reconcile(input: unknown): Promise<Destination> {
    validateDesired(input);
    const desired: Desired = { playlistKey: input.playlistKey, revision: input.revision, title: input.title, trackIds: [...input.trackIds] };
    if (this.busy.has(desired.playlistKey)) throw new PublishingError("busy");
    this.busy.add(desired.playlistKey);
    try {
      const existing = await this.options.store.get(desired.playlistKey);
      if (existing && desired.revision < existing.desired.revision) throw new PublishingError("stale_revision");
      if (existing && desired.revision === existing.desired.revision && (!equal(existing.desired.trackIds, desired.trackIds) || existing.desired.title !== desired.title)) {
        throw new PublishingError("revision_conflict");
      }
      if (existing && !prefix(existing.desired.trackIds, desired.trackIds)) throw new PublishingError("append_only");
      const row: Destination = existing ? structuredClone(existing) : {
        desired, providerPlaylistId: null, appliedRevision: null, appliedTrackIds: [], verifiedUrl: null,
        marker: `listen.cx Apple Music ${crypto.randomUUID()}`, intent: null, retryNotBefore: 0,
      };
      if (row.intent?.kind === "create" && !row.providerPlaylistId) throw new PublishingError("create_unresolved");
      if (row.retryNotBefore > this.now()) throw new PublishingError("rate_limited", 429, Math.ceil((row.retryNotBefore - this.now()) / 1000));
      row.desired = desired;
      row.verifiedUrl = null;
      await this.save(row);
      try {
        if (!row.providerPlaylistId) {
          const credentials = await this.credentials();
          row.intent = { kind: "create", desired: structuredClone(desired) };
          await this.save(row);
          const created = await this.mutate(row, credentials, "/v1/me/library/playlists", {
            attributes: { name: desired.title, description: row.marker, isPublic: true },
            relationships: { tracks: { data: desired.trackIds.map(song) } },
          });
          const id = created?.data?.[0]?.id;
          if (typeof id !== "string" || !/^p\.[A-Za-z0-9.-]+$/.test(id)) throw new PublishingError("create_unresolved");
          row.providerPlaylistId = id;
          await this.save(row);
        }
        if (row.intent) {
          const readback = await this.read(row);
          if (!equal(readback.trackIds, row.intent.desired.trackIds)) throw new PublishingError(`${row.intent.kind}_unresolved`);
          row.appliedTrackIds = [...row.intent.desired.trackIds];
          row.appliedRevision = row.intent.desired.revision;
          row.intent = null;
          row.verifiedUrl = readback.url;
          await this.save(row);
        }
        const before = await this.read(row);
        if (!equal(before.trackIds, row.appliedTrackIds)) throw new PublishingError("provider_drift");
        if (!prefix(row.appliedTrackIds, desired.trackIds)) throw new PublishingError("append_only");
        const suffix = desired.trackIds.slice(row.appliedTrackIds.length);
        if (suffix.length) {
          const credentials = await this.credentials();
          row.intent = { kind: "append", desired: structuredClone(desired) };
          row.verifiedUrl = null;
          await this.save(row);
          await this.mutate(row, credentials, `/v1/me/library/playlists/${row.providerPlaylistId}/tracks`, { data: suffix.map(song) });
          const after = await this.read(row);
          if (!equal(after.trackIds, desired.trackIds)) throw new PublishingError("append_unresolved");
          row.verifiedUrl = after.url;
        } else {
          row.verifiedUrl = before.url;
        }
        row.appliedRevision = desired.revision;
        row.appliedTrackIds = [...desired.trackIds];
        row.intent = null;
        row.retryNotBefore = 0;
        await this.save(row);
        return structuredClone(row);
      } catch (error) {
        row.verifiedUrl = null;
        if (error instanceof PublishingError && error.status === 429) row.retryNotBefore = this.now() + (error.retryAfterSeconds ?? 60) * 1000;
        await this.save(row);
        throw error;
      }
    } catch (error) {
      if (error instanceof PublishingError) throw error;
      throw new PublishingError("publisher_unavailable", 503);
    } finally { this.busy.delete(desired.playlistKey); }
  }

  private async save(row: Destination) {
    await this.options.store.set(row.desired.playlistKey, structuredClone(row));
  }

  private async credentials(): Promise<Credentials> {
    try {
      const value = await this.options.credentials();
      if (!value.developerToken || !value.musicUserToken) throw new Error();
      return value;
    } catch { throw new PublishingError("credentials_unavailable", 401); }
  }

  private async mutate(row: Destination, credentials: Credentials, path: string, body: unknown) {
    try { return await this.request(path, "POST", body, credentials); }
    catch (error) {
      if (error instanceof PublishingError && error.code === "provider_error" && error.status >= 400 && error.status < 500 && error.status !== 408) {
        row.intent = null;
        await this.save(row);
      }
      throw error;
    }
  }

  private async read(row: Destination): Promise<{ trackIds: string[]; url: string }> {
    const base = `/v1/me/library/playlists/${row.providerPlaylistId}`;
    const response = await this.request(`${base}?include=catalog`);
    const playlist = response?.data?.[0];
    const description = playlist?.attributes?.description;
    if (playlist?.id !== row.providerPlaylistId || playlist?.attributes?.isPublic !== true
      || (typeof description === "string" ? description : description?.standard) !== row.marker) {
      throw new PublishingError("destination_mismatch", 403);
    }
    const candidate = playlist?.attributes?.url ?? playlist?.relationships?.catalog?.data?.[0]?.attributes?.url;
    let publicUrl: URL;
    try { publicUrl = new URL(candidate); } catch { throw new PublishingError("public_url_unverified", 502); }
    if (publicUrl.protocol !== "https:" || publicUrl.hostname !== "music.apple.com" || publicUrl.port
      || publicUrl.username || publicUrl.password || !/^\/[a-z]{2}\/playlist\/(?:[^/]+\/)?pl\.[A-Za-z0-9.-]+\/?$/.test(publicUrl.pathname)) {
      throw new PublishingError("public_url_unverified", 502);
    }
    const trackIds: string[] = [];
    const visited = new Set<string>();
    let next: string | undefined = `${base}/tracks`;
    for (let page = 0; next && page < 25; page++) {
      let target: URL;
      try { target = new URL(next, origin); } catch { throw new PublishingError("invalid_provider_response", 502); }
      if (target.origin !== origin || target.username || target.password || target.pathname !== `${base}/tracks` || visited.has(target.href)) {
        throw new PublishingError("invalid_provider_response", 502);
      }
      visited.add(target.href);
      const result = await this.request(target.pathname + target.search);
      if (!Array.isArray(result?.data)) throw new PublishingError("invalid_provider_response", 502);
      for (const entry of result.data) {
        const id = entry?.attributes?.playParams?.catalogId;
        if (typeof id !== "string" || !/^\d{1,30}$/.test(id)) throw new PublishingError("unresolved_track", 409);
        trackIds.push(id);
      }
      if (trackIds.length > 1000 || (result.next != null && typeof result.next !== "string")) throw new PublishingError("invalid_provider_response", 502);
      next = result.next || undefined;
    }
    if (next) throw new PublishingError("invalid_provider_response", 502);
    return { trackIds, url: publicUrl.href };
  }

  private async request(path: string, method = "GET", body?: unknown, suppliedCredentials?: Credentials): Promise<any> {
    const credentials = suppliedCredentials ?? await this.credentials();
    let response: Response;
    try {
      response = await this.fetcher(`${origin}${path}`, {
        method, headers: { Authorization: `Bearer ${credentials.developerToken}`, "Music-User-Token": credentials.musicUserToken, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new PublishingError(method === "GET" ? "provider_unavailable" : "ambiguous_write", 502); }
    if (!response.ok) {
      const raw = response.headers.get("Retry-After");
      const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : raw ? (Date.parse(raw) - this.now()) / 1000 : NaN;
      await response.body?.cancel();
      if (method !== "GET" && (response.status >= 500 || response.status === 408 || response.status < 400)) throw new PublishingError("ambiguous_write", 502);
      throw new PublishingError("provider_error", response.status >= 400 ? response.status : 502,
        response.status === 429 ? (Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60) : undefined);
    }
    if (method === "POST" && path.endsWith("/tracks")) {
      await response.body?.cancel();
      return undefined;
    }
    try { return await response.json(); }
    catch { throw new PublishingError(method === "GET" ? "invalid_provider_response" : "ambiguous_write", 502); }
  }
}
