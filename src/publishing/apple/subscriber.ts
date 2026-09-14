import { PublishingError } from "./publisher.js";

type Credentials = { developerToken: string; musicUserToken: string };
type Input = { playlistUrl: string; previousPlaylistUrl: string | null };
type Options = { credentials: Credentials; storefront: string; fetcher?: typeof fetch };
const maxResponseBytes = 64 * 1024;

function catalogPlaylistId(value: string): string {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/[a-z]{2}\/playlist\/(?:[^/]+\/)?(pl\.[A-Za-z0-9.-]+)\/?$/);
    if (url.protocol !== "https:" || url.hostname !== "music.apple.com" || url.port || url.username || url.password || url.hash || !match) throw new Error();
    return match[1]!;
  } catch { throw new PublishingError("invalid_publication_readback", 502); }
}

export class AppleLibrarySubscriber {
  private fetcher: typeof fetch;

  constructor(private options: Options) {
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  }

  async reconcile(input: Input): Promise<{ playlistId: string; playlistUrl: string }> {
    const catalogId = catalogPlaylistId(input.playlistUrl);
    let libraryId: string | null = null;
    if (input.previousPlaylistUrl === input.playlistUrl) libraryId = await this.libraryId(catalogId);
    if (!libraryId) {
      const query = new URLSearchParams({ "ids[playlists]": catalogId });
      await this.request(`/v1/me/library?${query}`, "POST");
      libraryId = await this.libraryId(catalogId);
    }
    if (!libraryId) throw new PublishingError("readback_mismatch", 502);
    return { playlistId: libraryId, playlistUrl: input.playlistUrl };
  }

  private async libraryId(catalogId: string): Promise<string | null> {
    const response = await this.request(`/v1/catalog/${encodeURIComponent(this.options.storefront)}/playlists/${catalogId}/library`);
    if (!Array.isArray(response?.data) || response.data.length > 1) throw new PublishingError("invalid_provider_response", 502);
    if (response.data.length === 0) return null;
    const item = response.data[0];
    if (item?.type !== "library-playlists" || typeof item.id !== "string" || !/^p\.[A-Za-z0-9.-]+$/.test(item.id)) {
      throw new PublishingError("invalid_provider_response", 502);
    }
    return item.id;
  }

  private async request(path: string, method = "GET"): Promise<any> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.music.apple.com${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.options.credentials.developerToken}`,
          "Music-User-Token": this.options.credentials.musicUserToken,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch { throw new PublishingError(method === "GET" ? "provider_unavailable" : "ambiguous_write", 502); }
    if (!response.ok) {
      const raw = response.headers.get("Retry-After");
      const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : raw ? (Date.parse(raw) - Date.now()) / 1000 : NaN;
      await response.body?.cancel();
      if (method !== "GET" && (response.status >= 500 || response.status === 408 || response.status < 400)) throw new PublishingError("ambiguous_write", 502);
      throw new PublishingError("provider_error", response.status >= 400 ? response.status : 502,
        response.status === 429 ? (Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60) : undefined);
    }
    if (method !== "GET") {
      await response.body?.cancel();
      return undefined;
    }
    try {
      const length = Number(response.headers.get("Content-Length"));
      if (Number.isFinite(length) && length > maxResponseBytes) throw new Error();
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxResponseBytes) throw new Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch { throw new PublishingError("invalid_provider_response", 502); }
  }
}
