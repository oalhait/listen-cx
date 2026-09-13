import { expect, it } from "vitest";
import { SpotifyClient } from "./spotify.js";
import { ItunesClient } from "./itunes.js";
import { MusicCatalog } from "./music-catalog.js";

it.each([
  ["4SN5Kkig8iJ8vdwsOoP7IO", "Cataracts", "Freddie Gibbs, Madlib"],
  ["4uLU6hMCjMI75M1A2tKUQC", "Never Gonna Give You Up", "Rick Astley"],
])("reads live Spotify metadata for %s", async (id, title, artist) => {
  const track = await new SpotifyClient().getTrack(id);
  expect(track).toMatchObject({ id, title, artist });
  expect(track!.durationMs).toBeGreaterThan(0);
  expect(track!.artworkUrl).toMatch(/^https:\/\//);
});

it.each(["us", "gb"])("reads live Apple lookup and search results in %s", async (storefront) => {
  const apple = new ItunesClient();
  const track = await apple.lookupById("1452886612", storefront);
  expect(track).toMatchObject({ trackId: 1452886612, title: "Kingston", artist: "Faye Webster" });
  const results = await apple.searchTracks("Kingston", "Faye Webster", storefront);
  expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Kingston", artist: "Faye Webster" })]));
});

it("reads the live Apple page when the lookup endpoint is unavailable", async () => {
  const apple = new ItunesClient((input, init) => String(input).startsWith("https://itunes.apple.com/lookup")
    ? Promise.resolve(new Response(null, { status: 403 }))
    : fetch(input, init));
  expect(await apple.lookupById("1452886612")).toMatchObject({
    trackId: 1452886612, title: "Kingston", artist: "Faye Webster",
  });
});

it("matches the two Spotify sources that blocked the Apple wedding playlist", async () => {
  const response = await fetch("https://listen.cx/api/apple-music/developer-token");
  expect(response.ok).toBe(true);
  const developerToken = (await response.json() as { developerToken?: string }).developerToken;
  expect(developerToken).toBeTypeOf("string");
  if (!developerToken) throw new Error("Apple developer token missing");
  const catalog = new MusicCatalog({ appleDeveloperToken: developerToken, fetcher: (input, init) => {
    const headers = new Headers(init?.headers);
    if (new URL(String(input)).hostname === "api.music.apple.com") headers.set("Origin", "https://listen.cx");
    return fetch(input, { ...init, headers });
  } });
  for (const [id, expected] of [["7EcE5yCPVZaZut1JqowbcI", "1614548303"], ["2GFExyKXf9383tSRSrEHEt", "1276760758"]] as const) {
    const source = await catalog.get({ provider: "spotify", id, storefront: "us" });
    expect(source).not.toBeNull();
    expect(await catalog.findMatch(source!, "apple", "us")).toMatchObject({ status: "matched", selected: { id: expected } });
  }
});
