export type Provider = "spotify" | "apple";

export interface ParsedTrack {
  provider: Provider;
  id: string;
  /** Apple storefront country code, lowercased. Defaults to "us". */
  storefront: string;
}

const SPOTIFY_HOSTS = new Set(["open.spotify.com", "play.spotify.com"]);
const APPLE_HOSTS = new Set(["music.apple.com", "itunes.apple.com", "geo.music.apple.com"]);

export function parseTrackUrl(raw: string): ParsedTrack | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();

  if (SPOTIFY_HOSTS.has(host)) {
    const match = url.pathname.match(/^\/(?:intl-[a-z]{2}\/)?track\/([A-Za-z0-9]{22})\/?$/);
    return match?.[1] ? { provider: "spotify", id: match[1], storefront: "us" } : null;
  }

  if (APPLE_HOSTS.has(host)) {
    const match = url.pathname.match(/^\/(?:([a-z]{2})\/)?(song|album)\/(?:[^/]+\/)?([0-9]+)\/?$/i);
    if (!match) return null;
    const storefront = match[1]?.toLowerCase() ?? "us";
    const id = match[2]?.toLowerCase() === "album" ? url.searchParams.get("i") : match[3];
    return id && /^[0-9]+$/.test(id) ? { provider: "apple", id, storefront } : null;
  }
  return null;
}

export function spotifyTrackUrl(id: string): string {
  return `https://open.spotify.com/track/${id}`;
}

export function appleTrackUrl(albumUrl: string, trackId: string): string {
  const url = new URL(albumUrl);
  url.searchParams.set("i", trackId);
  return url.toString();
}

export function spotifySearchUrl(title: string, artist: string): string {
  return `https://open.spotify.com/search/${encodeURIComponent(`${title} ${artist}`)}`;
}

export function appleSearchUrl(title: string, artist: string): string {
  return `https://music.apple.com/us/search?term=${encodeURIComponent(`${title} ${artist}`)}`;
}
