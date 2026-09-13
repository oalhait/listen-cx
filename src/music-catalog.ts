import { fetchWithRetry } from "./fetch.js";
import { ItunesClient } from "./itunes.js";
import { SpotifyClient } from "./spotify.js";
import { selectTrackMatch, type CatalogTrack, type MatchResult } from "./track-matching.js";

type Provider = CatalogTrack["provider"];
type ObjectValue = Record<string, unknown>;

export class MusicCatalogError extends Error {
  constructor(message: string, public readonly status: number, public readonly retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "MusicCatalogError";
  }
}

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MusicCatalogError("Invalid catalog payload", 502);
  return value as ObjectValue;
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new MusicCatalogError("Invalid catalog payload string", 502);
  return value;
}

function optionalString(value: unknown): string | null {
  return value === undefined || value === null ? null : string(value);
}

function duration(value: unknown): number | null {
  if (value === undefined || value === null || value === 0) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new MusicCatalogError("Invalid catalog payload duration", 502);
  return value;
}

function explicit(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new MusicCatalogError("Invalid catalog payload explicitness", 502);
  return value;
}

function list(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value)) throw new MusicCatalogError("Invalid catalog payload list", 502);
  return value.slice(0, limit);
}

function storefrontKey(value: string): string {
  if (!/^[a-z]{2}$/i.test(value)) throw new Error("Invalid catalog storefront");
  return value.toLowerCase();
}

function validateId(provider: Provider, id: string): void {
  if (!(provider === "apple" ? /^\d+$/.test(id) : /^[a-zA-Z0-9]{22}$/.test(id))) throw new Error("Invalid catalog track ID");
}

function normalizedIsrc(value: string | null): string | null {
  const normalized = value?.replace(/[\s-]/g, "").toUpperCase();
  return normalized && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(normalized) ? normalized : null;
}

function releaseDate(value: unknown): string | null {
  const parsed = optionalString(value);
  return parsed && /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(parsed) ? parsed : null;
}

function appleAlbumId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const match = url.hostname === "music.apple.com" ? url.pathname.match(/\/album\/[^/]+\/(\d+)\/?$/) : null;
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function parseApple(value: unknown, storefront: string): CatalogTrack {
  const item = object(value);
  const id = string(item.id);
  if (item.type !== "songs" || !/^\d+$/.test(id)) throw new MusicCatalogError("Invalid Apple catalog payload identity", 502);
  const attributes = object(item.attributes);
  const rating = optionalString(attributes.contentRating);
  const playParams = attributes.playParams === undefined ? null : object(attributes.playParams);
  return { provider: "apple", id, storefront, title: string(attributes.name), artist: string(attributes.artistName), album: optionalString(attributes.albumName), albumId: appleAlbumId(attributes.url), durationMs: duration(attributes.durationInMillis), isrc: normalizedIsrc(optionalString(attributes.isrc)), explicit: rating === "explicit" ? true : rating === "clean" ? false : null, playable: playParams?.kind === "song" && typeof playParams.id === "string" };
}

function parseSpotify(value: unknown, storefront: string): CatalogTrack {
  const item = object(value);
  const id = string(item.id);
  if (item.type !== "track" || !/^[a-zA-Z0-9]{22}$/.test(id)) throw new MusicCatalogError("Invalid Spotify catalog payload identity", 502);
  const artists = list(item.artists, 100).map((artist) => string(object(artist).name));
  if (!artists.length) throw new MusicCatalogError("Invalid Spotify catalog payload artists", 502);
  const restrictions = item.restrictions === undefined ? null : object(item.restrictions);
  const externalIds = item.external_ids === undefined ? null : object(item.external_ids);
  const album = item.album === undefined || item.album === null ? null : object(item.album);
  return { provider: "spotify", id, storefront, title: string(item.name), artist: artists.join(", "), album: optionalString(album?.name), releaseDate: releaseDate(album?.release_date), durationMs: duration(item.duration_ms), isrc: normalizedIsrc(optionalString(externalIds?.isrc)), explicit: explicit(item.explicit), playable: item.is_playable === true && item.is_local !== true && (!restrictions || Object.keys(restrictions).length === 0) };
}

function responseError(response: Response): MusicCatalogError {
  const value = response.headers.get("Retry-After");
  const numeric = value === null ? NaN : Number(value);
  const seconds = Number.isFinite(numeric) ? Math.max(0, Math.ceil(numeric)) : value === null ? NaN : Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 1000));
  return new MusicCatalogError(`Catalog request failed: ${response.status}`, response.status, Number.isFinite(seconds) ? seconds : null);
}

export class MusicCatalog {
  private readonly fetcher: typeof fetch;
  private readonly publicFetcher: typeof fetch;

  constructor(private readonly options: { appleDeveloperToken?: string; spotifyAccessToken?: string; fetcher?: typeof fetch }) {
    this.fetcher = options.fetcher ?? fetch;
    this.publicFetcher = async (input, init) => {
      const fetcher = this.fetcher;
      const response = await fetcher(input, init);
      if (!response.ok && response.status !== 404) throw responseError(response);
      return response;
    };
  }

  async get(source: { provider: Provider; id: string; storefront: string }): Promise<CatalogTrack | null> {
    validateId(source.provider, source.id);
    const storefront = storefrontKey(source.storefront);
    if (source.provider === "spotify" && !this.options.spotifyAccessToken) {
      const track = await new SpotifyClient(this.publicFetcher).getTrack(source.id);
      return track ? { provider: "spotify", id: track.id, storefront, title: string(track.title), artist: string(track.artist), album: optionalString(track.album), releaseDate: track.releaseDate ?? null, durationMs: duration(track.durationMs), isrc: null, explicit: track.explicit ?? null, playable: track.playable === true } : null;
    }
    if (source.provider === "apple" && !this.options.appleDeveloperToken) {
      const track = await new ItunesClient(this.publicFetcher).lookupById(source.id, storefront);
      if (!track) return null;
      if (String(track.trackId) !== source.id) throw new MusicCatalogError("Invalid Apple source payload identity", 502);
      return { provider: "apple", id: source.id, storefront, title: string(track.title), artist: string(track.artist), album: null, durationMs: duration(track.durationMs), isrc: null, explicit: null, playable: true };
    }
    const url = source.provider === "apple" ? new URL(`https://api.music.apple.com/v1/catalog/${storefront}/songs/${source.id}`) : new URL(`https://api.spotify.com/v1/tracks/${source.id}?market=${storefront.toUpperCase()}`);
    const data = await this.request(source.provider, url);
    if (data === null) return null;
    if (source.provider === "spotify") return parseSpotify(data, storefront);
    const songs = list(object(data).data, 1);
    if (!songs.length) return null;
    const track = parseApple(songs[0], storefront);
    if (track.id !== source.id) throw new MusicCatalogError("Invalid Apple catalog payload identity", 502);
    return track;
  }

  async findMatch(source: CatalogTrack, destination: Provider, requestedStorefront: string): Promise<MatchResult> {
    validateId(source.provider, source.id);
    const storefront = storefrontKey(requestedStorefront);
    const isrc = normalizedIsrc(source.isrc);
    if (isrc) {
      const result = selectTrackMatch(source, await this.search(source, destination, storefront, isrc), "isrc");
      if (result.status !== "unavailable") return result;
    }
    let result = selectTrackMatch(source, await this.search(source, destination, storefront, null), "metadata");
    if (destination === "apple" && result.status === "ambiguous" && source.isrc === null && source.album && source.releaseDate
      && result.candidates.length > 1 && result.candidates.length <= 5) {
      result = selectTrackMatch(source, await Promise.all(result.candidates.map(candidate => this.withAppleAlbumRelease(candidate, storefront))), "metadata");
    }
    return result;
  }

  private async withAppleAlbumRelease(track: CatalogTrack, storefront: string): Promise<CatalogTrack> {
    if (track.provider !== "apple" || !track.albumId) return track;
    const data = await this.request("apple", new URL(`https://api.music.apple.com/v1/catalog/${storefront}/albums/${track.albumId}`));
    if (data === null) return track;
    try {
      const albums = list(object(data).data, 1);
      if (!albums.length) return track;
      const album = object(albums[0]);
      if (album.type !== "albums" || album.id !== track.albumId) return track;
      const attributes = object(album.attributes);
      if (string(attributes.name) !== track.album) return track;
      return { ...track, releaseDate: releaseDate(attributes.releaseDate) };
    } catch {
      return track;
    }
  }

  private async search(source: CatalogTrack, provider: Provider, storefront: string, isrc: string | null): Promise<CatalogTrack[]> {
    if (provider === "apple") {
      const url = new URL(`https://api.music.apple.com/v1/catalog/${storefront}/${isrc ? "songs" : "search"}`);
      url.searchParams.set("limit", "25");
      if (isrc) url.searchParams.set("filter[isrc]", isrc);
      else {
        url.searchParams.set("types", "songs");
        url.searchParams.set("term", `${source.title} ${source.artist}`);
      }
      const data = await this.request(provider, url);
      if (data === null) return [];
      const root = object(data);
      if (isrc) return list(root.data, 25).map((item) => parseApple(item, storefront));
      const results = object(root.results);
      return results.songs === undefined ? [] : list(object(results.songs).data, 25).map((item) => parseApple(item, storefront));
    }
    const url = new URL("https://api.spotify.com/v1/search");
    const quoted = (value: string) => value.replace(/["\\]/g, " ");
    url.searchParams.set("type", "track");
    url.searchParams.set("limit", "10");
    url.searchParams.set("market", storefront.toUpperCase());
    url.searchParams.set("q", isrc ? `isrc:${isrc}` : `track:"${quoted(source.title)}" artist:"${quoted(source.artist)}"`);
    const data = await this.request(provider, url);
    return data === null ? [] : list(object(object(data).tracks).items, 10).filter((item) => item !== null).map((item) => parseSpotify(item, storefront));
  }

  private async request(provider: Provider, url: URL): Promise<unknown> {
    const token = provider === "apple" ? this.options.appleDeveloperToken : this.options.spotifyAccessToken;
    if (!token) throw new MusicCatalogError(`${provider} catalog credential unavailable`, 503);
    const response = await fetchWithRetry(this.fetcher, url.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    if (response.status === 404) return null;
    if (!response.ok) throw responseError(response);
    try {
      return await response.json();
    } catch {
      throw new MusicCatalogError("Invalid catalog payload JSON", 502);
    }
  }
}
