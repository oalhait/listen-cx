import { spotifyTrackUrl } from "./urls.js";
import { fetchWithRetry } from "./fetch.js";

export interface SpotifyTrack {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  artworkUrl: string | null;
  explicit?: boolean | null;
  playable?: boolean;
}

interface SpotifyOEmbed {
  title?: string;
  thumbnail_url?: string | null;
}

type Fetcher = typeof fetch;

export class SpotifyClient {
  private fetcher: Fetcher;

  constructor(fetcher: Fetcher = fetch) {
    this.fetcher = (input, init) => fetchWithRetry(fetcher, input, init);
  }

  async getTrack(id: string): Promise<SpotifyTrack | null> {
    const trackUrl = spotifyTrackUrl(id);
    const [oembed, embed] = await Promise.all([
      this.fetcher(`https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`),
      this.fetcher(`https://open.spotify.com/embed/track/${id}`),
    ]);
    if (oembed.status === 404) return null;
    if (!oembed.ok) throw new Error(`spotify oembed: ${oembed.status}`);
    const preview = (await oembed.json()) as SpotifyOEmbed;

    if (embed.status === 404) return null;
    if (!embed.ok) throw new Error(`spotify embed: ${embed.status}`);
    const html = await embed.text();
    const marker = '<script id="__NEXT_DATA__" type="application/json">';
    const start = html.indexOf(marker);
    const end = start >= 0 ? html.indexOf("</script>", start + marker.length) : -1;
    if (start < 0 || end < 0) throw new Error("spotify embed metadata missing");

    let entity: any;
    try {
      const data = JSON.parse(html.slice(start + marker.length, end));
      entity = data.props?.pageProps?.state?.data?.entity;
    } catch {
      throw new Error("spotify embed metadata invalid");
    }
    if (entity?.type !== "track" || entity.id !== id) return null;

    const title =
      typeof entity.title === "string" && entity.title.trim()
        ? entity.title
        : typeof preview.title === "string" && preview.title.trim()
          ? preview.title
          : null;
    if (!title) throw new Error("spotify embed title missing");

    const durationMs = entity.duration ?? 0;
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error("spotify embed duration invalid");
    }

    const artist = (entity.artists ?? [])
      .map((item: any) => item.name)
      .filter((name: unknown): name is string => typeof name === "string" && name.length > 0)
      .join(", ");
    if (!artist) throw new Error("spotify embed artist missing");

    const artwork = entity.visualIdentity?.image?.find(
      (image: any) => typeof image.url === "string" && image.maxWidth >= 300,
    )?.url;

    return {
      id,
      title,
      artist,
      durationMs,
      explicit: typeof entity.isExplicit === "boolean" ? entity.isExplicit : null,
      playable: entity.isPlayable === true,
      artworkUrl: artwork ?? preview.thumbnail_url ?? null,
    };
  }
}
