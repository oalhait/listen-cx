import type { LinkRow } from "./db.js";
import { appleSearchUrl, spotifySearchUrl } from "./urls.js";

export type HandoffProvider = "spotify" | "apple";

export interface ProviderTarget {
  url: string;
  isExactMatch: boolean;
}

const APPLE_HOSTS = new Set([
  "music.apple.com",
  "geo.music.apple.com",
  "itunes.apple.com",
]);

function appleUniversalLink(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !APPLE_HOSTS.has(url.hostname)) return null;
    if (url.hostname !== "music.apple.com") url.hostname = "music.apple.com";
    return url.toString();
  } catch {
    return null;
  }
}

function spotifyLink(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "open.spotify.com"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function providerTarget(
  row: Pick<LinkRow, "title" | "artist" | "spotify_url" | "apple_url">,
  provider: HandoffProvider,
): ProviderTarget {
  const fallback =
    provider === "spotify"
      ? spotifySearchUrl(row.title, row.artist)
      : appleSearchUrl(row.title, row.artist);
  const candidate = provider === "spotify" ? row.spotify_url : row.apple_url;
  if (!candidate) return { url: fallback, isExactMatch: false };

  const exact = provider === "spotify" ? spotifyLink(candidate) : appleUniversalLink(candidate);
  return exact ? { url: exact, isExactMatch: true } : { url: fallback, isExactMatch: false };
}
