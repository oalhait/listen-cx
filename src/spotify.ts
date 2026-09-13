import { spotifyTrackUrl } from "./urls.js";
import { fetchWithRetry } from "./fetch.js";

export interface SpotifyTrack {
  id: string;
  title: string;
  artist: string;
  album?: string | null;
  releaseDate?: string | null;
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

function decodeHtml(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|amp|apos|quot|lt|gt);/gi, (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
    const codePoint = decimal ? Number(decimal) : hexadecimal ? Number.parseInt(hexadecimal, 16) : null;
    if (codePoint !== null) return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    return ({ "&amp;": "&", "&apos;": "'", "&quot;": '"', "&lt;": "<", "&gt;": ">" } as Record<string, string>)[entity.toLowerCase()] ?? entity;
  });
}

function metadataContent(html: string, property: string): string | null {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = Object.fromEntries([...match[0].matchAll(/\b([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(attribute => [attribute[1]!.toLowerCase(), attribute[2] ?? attribute[3] ?? ""]));
    if (attributes.property === property || attributes.name === property) return decodeHtml(attributes.content ?? "");
  }
  return null;
}

function albumFromPage(html: string, artist: string, trackUrl: string): string | null {
  if (metadataContent(html, "og:url") !== trackUrl) return null;
  const parts = metadataContent(html, "og:description")?.split(" · ");
  return parts?.length === 4 && parts[0] === artist && parts[2] === "Song" && /^\d{4}$/.test(parts[3]!) && parts[1]?.trim() ? parts[1].trim() : null;
}

function releaseDateFromPage(html: string, trackUrl: string): string | null {
  if (metadataContent(html, "og:url") !== trackUrl) return null;
  const value = metadataContent(html, "music:release_date");
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

async function boundedText(response: Response, limit = 512_000): Promise<string | null> {
  const contentLength = Number(response.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

export class SpotifyClient {
  private fetcher: Fetcher;
  private publicPageFetcher: Fetcher;

  constructor(fetcher: Fetcher = fetch) {
    this.publicPageFetcher = fetcher;
    this.fetcher = (input, init) => fetchWithRetry(fetcher, input, init);
  }

  async getTrack(id: string): Promise<SpotifyTrack | null> {
    const trackUrl = spotifyTrackUrl(id);
    const publicPageFetcher = this.publicPageFetcher;
    const optionalPage = publicPageFetcher(trackUrl).catch((error: unknown) => {
      const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : null;
      if (status === 429 || (typeof status === "number" && status >= 500)) throw error;
      return null;
    });
    const [oembed, embed, page] = await Promise.all([
      this.fetcher(`https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`),
      this.fetcher(`https://open.spotify.com/embed/track/${id}`),
      optionalPage,
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

    const pageHtml = page?.ok ? await boundedText(page) ?? "" : "";

    const artwork = entity.visualIdentity?.image?.find(
      (image: any) => typeof image.url === "string" && image.maxWidth >= 300,
    )?.url;

    return {
      id,
      title,
      artist,
      album: albumFromPage(pageHtml, artist, trackUrl),
      releaseDate: releaseDateFromPage(pageHtml, trackUrl),
      durationMs,
      explicit: typeof entity.isExplicit === "boolean" ? entity.isExplicit : null,
      playable: entity.isPlayable === true,
      artworkUrl: artwork ?? preview.thumbnail_url ?? null,
    };
  }
}
