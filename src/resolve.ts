import { SpotifyClient } from "./spotify.js";
import { ItunesClient } from "./itunes.js";
import { parseTrackUrl, spotifyTrackUrl } from "./urls.js";

export interface Resolved {
  isrc: null;
  title: string;
  artist: string;
  artworkUrl: string | null;
  spotifyUrl: string | null;
  appleUrl: string | null;
  complete: false;
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

    return {
      isrc: null,
      title: track.title,
      artist: track.artist,
      artworkUrl: track.artworkUrl,
      spotifyUrl: spotifyTrackUrl(track.id),
      appleUrl: null,
      complete: false,
    };
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
