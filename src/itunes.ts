export interface ItunesTrack {
  trackId: number;
  title: string;
  artist: string;
  durationMs: number;
  trackViewUrl: string;
  artworkUrl: string | null;
}

type Fetcher = typeof fetch;

function mapResult(r: any): ItunesTrack {
  return {
    trackId: r.trackId,
    title: r.trackName,
    artist: r.artistName,
    durationMs: r.trackTimeMillis ?? 0,
    trackViewUrl: r.trackViewUrl,
    // 100x100 by default; the 600x600 variant exists at a predictable path.
    artworkUrl: r.artworkUrl100 ? r.artworkUrl100.replace("100x100", "600x600") : null,
  };
}

function durationToMs(value: unknown): number {
  if (typeof value !== "string") return 0;
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!match) return 0;
  return Math.round(
    (Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) *
      1000,
  );
}

function musicSchema(html: string): any | null {
  const match = html.match(/<script id="schema:music" type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1] ?? "");
  } catch {
    return null;
  }
}

export class ItunesClient {
  private fetcher: Fetcher;

  constructor(fetcher: Fetcher = fetch) {
    this.fetcher = (input, init) => fetchWithRetry(fetcher, input, init);
  }

  async lookupById(trackId: string, storefront = "us"): Promise<ItunesTrack | null> {
    const res = await this.fetcher(
      `https://itunes.apple.com/lookup?id=${trackId}&entity=song&country=${storefront}`,
    );
    if (res.ok) {
      const data = (await res.json()) as any;
      const song = (data.results ?? []).find((r: any) => r.wrapperType === "track");
      if (song) return mapResult(song);
    }
    return this.lookupApplePage(trackId, storefront, res.status);
  }

  async searchTracks(title: string, artist: string, storefront = "us"): Promise<ItunesTrack[]> {
    const term = encodeURIComponent(`${title} ${artist}`);
    const res = await this.fetcher(
      `https://itunes.apple.com/search?term=${term}&entity=song&country=${storefront}&limit=10`,
    );
    if (!res.ok) throw new Error(`itunes search: ${res.status}`);
    const data = (await res.json()) as any;
    return (data.results ?? [])
      .filter((result: any) => result.wrapperType === "track")
      .map(mapResult);
  }

  private async lookupApplePage(
    trackId: string,
    storefront: string,
    lookupStatus: number,
  ): Promise<ItunesTrack | null> {
    const res = await this.fetcher(`https://music.apple.com/${storefront}/song/x/${trackId}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`itunes lookup: ${lookupStatus}; apple page: ${res.status}`);

    const schema = musicSchema(await res.text());
    const recording = schema?.audio;
    const title = recording?.name ?? schema?.name;
    const artists = (recording?.byArtist ?? schema?.byArtist ?? [])
      .map((artist: any) => artist?.name)
      .filter((name: unknown): name is string => typeof name === "string" && name.length > 0);
    const trackViewUrl = schema?.url ?? recording?.url;
    if (typeof title !== "string" || !artists.length || typeof trackViewUrl !== "string") {
      throw new Error(`itunes lookup: ${lookupStatus}; apple page metadata missing`);
    }

    return {
      trackId: Number(trackId),
      title,
      artist: artists.join(", "),
      durationMs: durationToMs(recording?.duration ?? schema?.timeRequired),
      trackViewUrl,
      artworkUrl:
        typeof recording?.image === "string"
          ? recording.image
          : typeof schema?.image === "string"
            ? schema.image
            : null,
    };
  }
}
import { fetchWithRetry } from "./fetch.js";
