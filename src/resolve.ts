import { SpotifyClient, type SpotifyTrack } from "./spotify.js";
import { ItunesClient, type ItunesTrack } from "./itunes.js";
import { parseTrackUrl, spotifyTrackUrl } from "./urls.js";

export interface Resolved {
  isrc: string | null;
  title: string;
  artist: string;
  artworkUrl: string | null;
  spotifyUrl: string | null;
  appleUrl: string | null;
  /** true when both provider URLs resolved with high confidence */
  complete: boolean;
}

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(normalized(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalized(right).split(" ").filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return shared / new Set([...leftTokens, ...rightTokens]).size;
}

function candidateScore(track: SpotifyTrack, candidate: ItunesTrack): number {
  const title = tokenSimilarity(track.title, candidate.title);
  const artist = tokenSimilarity(track.artist, candidate.artist);
  const duration =
    track.durationMs && candidate.durationMs
      ? Math.max(0, 1 - Math.abs(track.durationMs - candidate.durationMs) / 60_000)
      : 0;
  return title * 0.5 + artist * 0.35 + duration * 0.15;
}

export function bestAppleCandidate(
  track: SpotifyTrack,
  candidates: ItunesTrack[],
): ItunesTrack | null {
  return (
    candidates.reduce<{ candidate: ItunesTrack; score: number } | null>((best, candidate) => {
      const score = candidateScore(track, candidate);
      return !best || score > best.score ? { candidate, score } : best;
    }, null)?.candidate ?? null
  );
}

export class Resolver {
  constructor(
    private spotify: SpotifyClient,
    private itunes: ItunesClient,
  ) {}

  async resolve(rawUrl: string): Promise<Resolved | null> {
    const parsed = parseTrackUrl(rawUrl);
    if (!parsed) return null;
    return parsed.provider === "spotify"
      ? this.fromSpotify(parsed.id)
      : this.fromApple(parsed.id, parsed.storefront);
  }

  private async fromSpotify(id: string): Promise<Resolved | null> {
    const track = await this.spotify.getTrack(id);
    if (!track) return null;

    const base: Resolved = {
      isrc: null,
      title: track.title,
      artist: track.artist,
      artworkUrl: track.artworkUrl,
      spotifyUrl: spotifyTrackUrl(track.id),
      appleUrl: null,
      complete: false,
    };

    let candidates: ItunesTrack[];
    try {
      candidates = await this.itunes.searchTracks(track.title, track.artist);
    } catch (error) {
      console.warn(
        JSON.stringify({
          message: "apple match failed",
          provider: "spotify",
          trackId: id,
          error: String(error),
        }),
      );
      return base;
    }
    const apple = bestAppleCandidate(track, candidates);
    if (apple) {
      return { ...base, appleUrl: apple.trackViewUrl };
    }
    return base;
  }

  private async fromApple(id: string, storefront: string): Promise<Resolved | null> {
    const track = await this.itunes.lookupById(id, storefront);
    if (!track) return null;

    return {
      isrc: null,
      title: track.title,
      artist: track.artist,
      artworkUrl: track.artworkUrl,
      spotifyUrl: null,
      appleUrl: track.trackViewUrl,
      complete: false,
    };
  }
}
