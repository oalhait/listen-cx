import { describe, expect, it, vi } from "vitest";
import { Resolver } from "./resolve.js";
import { SpotifyClient } from "./spotify.js";
import { ItunesClient } from "./itunes.js";

function setup() {
  const spotify = new SpotifyClient();
  const apple = new ItunesClient();
  const getTrack = vi.spyOn(spotify, "getTrack").mockResolvedValue({ id: "4SN5Kkig8iJ8vdwsOoP7IO", title: "Cataracts", artist: "Freddie Gibbs, Madlib", durationMs: 219823, artworkUrl: null });
  const lookup = vi.spyOn(apple, "lookupById").mockResolvedValue({ trackId: 1452886612, title: "Kingston", artist: "Faye Webster", durationMs: 202000, artworkUrl: null, trackViewUrl: "https://music.apple.com/gb/song/kingston/1452886612" });
  const search = vi.spyOn(apple, "searchTracks");
  return { resolver: new Resolver(spotify, apple), getTrack, lookup, search };
}

describe("source metadata resolution", () => {
  it("resolves Spotify without guessing an Apple match", async () => {
    const { resolver, search } = setup();
    expect(await resolver.resolve("https://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO")).toMatchObject({ title: "Cataracts", appleUrl: null, complete: false, isrc: null });
    expect(search).not.toHaveBeenCalled();
  });
  it("preserves the Apple storefront and leaves Spotify unresolved", async () => {
    const { resolver, lookup, getTrack } = setup();
    expect(await resolver.resolve("https://music.apple.com/gb/song/kingston/1452886612")).toMatchObject({ title: "Kingston", spotifyUrl: null, complete: false });
    expect(lookup).toHaveBeenCalledWith("1452886612", "gb");
    expect(getTrack).not.toHaveBeenCalled();
  });
  it("returns null for invalid URLs and missing tracks", async () => {
    const { resolver, getTrack, lookup } = setup();
    expect(await resolver.resolve("junk")).toBeNull();
    expect(getTrack).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    getTrack.mockResolvedValueOnce(null);
    expect(await resolver.resolve("https://open.spotify.com/track/4SN5Kkig8iJ8vdwsOoP7IO")).toBeNull();
  });
});
