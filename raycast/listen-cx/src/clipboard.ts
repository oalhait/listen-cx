export function clipboardSongUrl(value: string | undefined): string {
  const candidate = value?.trim();
  if (!candidate) {
    return "";
  }

  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);
    const trackIndex = parts.findIndex((part) => part === "track");
    const spotifyId = trackIndex >= 0 ? parts[trackIndex + 1] : undefined;
    const isSpotifyTrack =
      (host === "open.spotify.com" || host === "play.spotify.com") &&
      Boolean(spotifyId && /^[A-Za-z0-9]{22}$/.test(spotifyId));
    const songIndex = parts.findIndex((part) => part === "song");
    const songId = parts[parts.length - 1];
    const isAppleHost =
      host === "music.apple.com" ||
      host === "itunes.apple.com" ||
      host === "geo.music.apple.com";
    const isAppleMusicTrack =
      isAppleHost &&
      (/^\d+$/.test(url.searchParams.get("i") ?? "") ||
        (songIndex >= 0 && /^\d+$/.test(songId ?? "")));

    return isSpotifyTrack || isAppleMusicTrack ? candidate : "";
  } catch {
    return "";
  }
}
