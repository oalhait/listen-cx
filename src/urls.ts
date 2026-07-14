export type Provider = "spotify" | "apple";

export interface ParsedTrack {
  provider: Provider;
  id: string;
  /** Apple storefront country code, lowercased. Defaults to "us". */
  storefront: string;
}

const SPOTIFY_HOSTS = new Set(["open.spotify.com", "play.spotify.com"]);
const APPLE_HOSTS = new Set(["music.apple.com", "itunes.apple.com", "geo.music.apple.com"]);

/**
 * Parse a Spotify or Apple Music track URL into a canonical reference.
 * Returns null for anything that isn't a single track (albums, playlists,
 * artists) — v0 is tracks only.
 */
export function parseTrackUrl(raw: string): ParsedTrack | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();

  if (SPOTIFY_HOSTS.has(host)) {
    // Paths: /track/{id} or /intl-xx/track/{id}
    const parts = url.pathname.split("/").filter(Boolean);
    const i = parts.findIndex((p) => p === "track");
    const id = i >= 0 ? parts[i + 1] : undefined;
    if (!id || !/^[A-Za-z0-9]{22}$/.test(id)) return null;
    return { provider: "spotify", id, storefront: "us" };
  }

  if (APPLE_HOSTS.has(host)) {
    // Song page: /{storefront}/song/{slug}/{id}
    // Album deep link: /{storefront}/album/{slug}/{albumId}?i={trackId}
    const parts = url.pathname.split("/").filter(Boolean);
    const storefront = parts[0] && /^[a-z]{2}$/i.test(parts[0]) ? parts[0].toLowerCase() : "us";
    const iParam = url.searchParams.get("i");
    if (iParam && /^\d+$/.test(iParam)) {
      return { provider: "apple", id: iParam, storefront };
    }
    const songIdx = parts.findIndex((p) => p === "song");
    if (songIdx >= 0) {
      const last = parts[parts.length - 1];
      const id = last && /^\d+$/.test(last) ? last : undefined;
      if (id) return { provider: "apple", id, storefront };
    }
    return null;
  }

  return null;
}

export function spotifyTrackUrl(id: string): string {
  return `https://open.spotify.com/track/${id}`;
}

export function appleTrackUrl(albumUrl: string, trackId: string): string {
  // iTunes lookup returns trackViewUrl already; this helper normalizes
  // by ensuring the ?i= deep link survives.
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
