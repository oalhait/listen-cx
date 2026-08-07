interface ParsedSongUrl {
  identity: string;
}

function parseSongUrl(candidate: string): ParsedSongUrl | null {
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);
    const trackIndex = parts.findIndex((part) => part === "track");
    const spotifyId = trackIndex >= 0 ? parts[trackIndex + 1] : undefined;
    if (
      (host === "open.spotify.com" || host === "play.spotify.com") &&
      spotifyId &&
      /^[A-Za-z0-9]{22}$/.test(spotifyId)
    ) {
      return { identity: `spotify:${spotifyId}` };
    }

    const songIndex = parts.findIndex((part) => part === "song");
    const isAppleHost =
      host === "music.apple.com" ||
      host === "itunes.apple.com" ||
      host === "geo.music.apple.com";
    if (!isAppleHost) return null;

    const queryTrackId = url.searchParams.get("i");
    const pathTrackId = parts[parts.length - 1];
    const trackId = /^\d+$/.test(queryTrackId ?? "")
      ? queryTrackId
      : songIndex >= 0 && /^\d+$/.test(pathTrackId ?? "")
        ? pathTrackId
        : null;
    if (!trackId) return null;

    const storefront = /^[a-z]{2}$/i.test(parts[0] ?? "")
      ? parts[0].toLowerCase()
      : "us";
    return { identity: `apple:${storefront}:${trackId}` };
  } catch {
    return null;
  }
}

export function songIdentity(value: string): string | null {
  return parseSongUrl(value.trim())?.identity ?? null;
}

export function clipboardSongUrl(value: string | undefined): string {
  const candidate = value?.trim();
  if (!candidate) return "";

  return parseSongUrl(candidate) ? candidate : "";
}
